import { Connection, Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import { eq, sql } from 'drizzle-orm';
import { PropsVaultClient } from '@props/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuditLog, chainJobs, kycRequests, notifications } from '../src/db/schema.js';
import { TOKEN_PROGRAM_ID, USDC_MINT, associatedTokenAddress } from '../src/lib/solana.js';
import { APP_ORIGIN, fixtureRpc, makeApp, signIn } from './helpers.js';

const accounts = new Map<string, AccountInfo<Buffer>>();
const rpc = fixtureRpc(accounts);
let t: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { t = await makeApp({ rpc }); });
afterAll(async () => { await t.close(); });

const info = (owner: PublicKey, lamports: number, data = Buffer.alloc(0)): AccountInfo<Buffer> =>
  ({ owner, lamports, data, executable: false, rentEpoch: 0 });

function usdcAccount(owner: PublicKey, amount: bigint): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  USDC_MINT.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  return info(TOKEN_PROGRAM_ID, 2_039_280, data);
}

const vaultCoder = new PropsVaultClient(new Connection('http://127.0.0.1:1')).program.coder.accounts;
/** A TraderProfile account image as props_vault writes it. */
const traderProfile = async (wallet: PublicKey, identityHash: Uint8Array) => Buffer.from(
  await vaultCoder.encode('traderProfile', { wallet, identityHash: [...identityHash], verifiedAt: new BN(0), activeFunded: 0, evaluationCount: 1, bump: 255 }));
const profileOf = (wallet: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('trader'), wallet.toBuffer()], new PublicKey(t.config.PROGRAM_ID!))[0];

const admin = (method: 'GET' | 'POST', url: string, payload?: object, token = t.config.ADMIN_API_TOKEN) =>
  t.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
const as = (cookie: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie } }),
  post: (url: string, payload?: object) => t.app.inject({ method: 'POST', url, payload, headers: { cookie, origin: APP_ORIGIN } }),
});

describe('GET /v1/health', () => {
  it('reports database and module status', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'ok', modules: { marketdata: 'absent' } });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.json()).not.toHaveProperty('keeper');
  });

  it('includes the keeper status when the keeper module runs', async () => {
    const venueUpgrade = { slot: 7, detectedAt: 1_000, restrictedAt: null, acknowledgedAt: null };
    const k = await makeApp({ services: { keeper: { status: () => ({ leader: true, lastTickAt: 2_000, venueUpgrade }) } } });
    try {
      const res = await k.app.inject({ method: 'GET', url: '/v1/health' });
      expect(res.json()).toMatchObject({ status: 'ok', keeper: { leader: true, lastTickAt: 2_000, venueUpgrade } });
    } finally {
      await k.close();
    }
  });
});

describe('GET /v1/me', () => {
  it('returns SOL and USDC balances and the trader profile from one RPC read', async () => {
    const user = await signIn(t.app);
    const owner = new PublicKey(user.wallet);
    const profile = profileOf(owner);
    accounts.set(user.wallet, info(new PublicKey('11111111111111111111111111111111'), 1_500_000_000));
    accounts.set(associatedTokenAddress(owner, USDC_MINT).toBase58(), usdcAccount(owner, 12_345_678n));
    accounts.set(profile.toBase58(), info(new PublicKey(t.config.PROGRAM_ID!), 1_000_000, await traderProfile(owner, new Uint8Array(32))));
    const calls = rpc.calls;
    const res = await as(user.cookie).get('/v1/me');
    expect(res.json()).toEqual({ wallet: user.wallet, kyc: 'none', solBalance: '1.5', usdcBalance: '12.345678', profile: profile.toBase58() });
    expect(rpc.calls - calls).toBe(1);
  });

  it('reports zero for a wallet that has no accounts yet', async () => {
    const user = await signIn(t.app);
    expect((await as(user.cookie).get('/v1/me')).json()).toEqual({ wallet: user.wallet, kyc: 'none', solBalance: '0', usdcBalance: '0' });
  });

  it('reports balances as unavailable (null) when the RPC fails, never a made-up number', async () => {
    const failing = await makeApp({ rpc: { getMultipleAccountsInfo: async () => { throw new Error('429 Too Many Requests'); } } });
    try {
      const user = await signIn(failing.app);
      const res = await failing.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: user.cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ solBalance: null, usdcBalance: null });
    } finally {
      await failing.close();
    }
  });
});

describe('KYC', () => {
  it('start creates one pending request, idempotently', async () => {
    const user = await signIn(t.app);
    expect((await as(user.cookie).post('/v1/kyc/start', { country: 'DE' })).json()).toEqual({ kyc: 'pending' });
    expect((await as(user.cookie).post('/v1/kyc/start', { country: 'DE' })).statusCode).toBe(200);
    const rows = await t.db.select().from(kycRequests).where(eq(kycRequests.wallet, user.wallet));
    expect(rows).toHaveLength(1);
    expect((await as(user.cookie).get('/v1/me')).json().kyc).toBe('pending');
  });

  it('refuses blocked countries and bad input', async () => {
    const user = await signIn(t.app);
    const us = await as(user.cookie).post('/v1/kyc/start', { country: 'US' });
    expect(us.statusCode).toBe(403);
    expect(us.json().error.code).toBe('region_blocked');
    expect((await as(user.cookie).post('/v1/kyc/start', { country: 'germany' })).statusCode).toBe(400);
    // Ukraine is sanctioned only in part: its residents name their region, and the sanctioned ones are refused.
    expect((await as(user.cookie).post('/v1/kyc/start', { country: 'UA' })).statusCode).toBe(400);
    expect((await as(user.cookie).post('/v1/kyc/start', { country: 'DE', region: 'UA-30' })).statusCode).toBe(400);
    for (const region of ['UA-43', 'UA-40', 'UA-14', 'UA-09']) {
      const refused = await as(user.cookie).post('/v1/kyc/start', { country: 'UA', region });
      expect([refused.statusCode, refused.json().error.code]).toEqual([403, 'region_blocked']);
    }
    expect(await t.db.select().from(kycRequests).where(eq(kycRequests.wallet, user.wallet))).toHaveLength(0);
    expect((await as(user.cookie).post('/v1/kyc/start', { country: 'UA', region: 'UA-30' })).statusCode).toBe(200);
    const [kyiv] = await t.db.select().from(kycRequests).where(eq(kycRequests.wallet, user.wallet));
    expect(kyiv).toMatchObject({ country: 'UA', region: 'UA-30' });
  });

  it('approval records the residence the reviewer confirmed, and refuses a blocked one', async () => {
    const user = await signIn(t.app);
    await as(user.cookie).post('/v1/kyc/start', { country: 'UA', region: 'UA-46' });
    const [request] = await t.db.select().from(kycRequests).where(eq(kycRequests.wallet, user.wallet));
    const identityHash = '12'.repeat(32);
    expect((await admin('POST', `/v1/admin/kyc/${request!.id}/approve`, { identityHash })).statusCode, 'no residence').toBe(400);
    expect((await admin('POST', `/v1/admin/kyc/${request!.id}/approve`, { identityHash, country: 'UA' })).statusCode, 'no region').toBe(400);
    // The documents show a Donetsk address: approval is refused, nothing is queued.
    const blocked = await admin('POST', `/v1/admin/kyc/${request!.id}/approve`, { identityHash, country: 'UA', region: 'UA-14' });
    expect([blocked.statusCode, blocked.json().error.code]).toEqual([403, 'region_blocked']);
    expect(await t.db.select().from(chainJobs).where(sql`${chainJobs.payload}->>'wallet' = ${user.wallet}`)).toHaveLength(0);
    expect((await admin('POST', `/v1/admin/kyc/${request!.id}/approve`, { identityHash, country: 'UA', region: 'UA-46' })).statusCode).toBe(200);
    const [approved] = await t.db.select().from(kycRequests).where(eq(kycRequests.id, request!.id));
    expect(approved).toMatchObject({ status: 'approved', country: 'UA', region: 'UA-46' });
  });

  it('approval queues a set_identity job; verified only once the job is confirmed onchain', async () => {
    const user = await signIn(t.app);
    await as(user.cookie).post('/v1/kyc/start', { country: 'FR' });
    const [request] = await t.db.select().from(kycRequests).where(eq(kycRequests.wallet, user.wallet));
    const identityHash = 'ab'.repeat(32);

    const listed = await admin('GET', '/v1/admin/kyc?status=pending');
    expect(listed.json().some((r: { id: string }) => r.id === request!.id)).toBe(true);

    const approved = await admin('POST', `/v1/admin/kyc/${request!.id}/approve`, { identityHash, country: 'FR' });
    expect(approved.statusCode).toBe(200);
    const [job] = await t.db.select().from(chainJobs).where(eq(chainJobs.id, approved.json().job));
    expect(job).toMatchObject({ kind: 'set_identity', status: 'queued', payload: { wallet: user.wallet, identityHash } });
    const [audit] = await t.db.select().from(adminAuditLog).where(eq(adminAuditLog.target, user.wallet));
    expect(audit).toMatchObject({ action: 'kyc.approve', details: { requestId: request!.id } });

    expect((await as(user.cookie).get('/v1/me')).json().kyc).toBe('pending');
    await t.db.update(chainJobs).set({ status: 'confirmed' }).where(eq(chainJobs.id, job!.id));
    expect((await as(user.cookie).get('/v1/me')).json().kyc).toBe('verified');

    expect((await admin('POST', `/v1/admin/kyc/${request!.id}/approve`, { identityHash, country: 'FR' })).json().error.code).toBe('not_pending');
    expect((await as(user.cookie).post('/v1/kyc/start', { country: 'FR' })).statusCode).toBe(409);
  });

  it('is verified once the identity is set onchain, also before the job executor has confirmed its job', async () => {
    const user = await signIn(t.app);
    await as(user.cookie).post('/v1/kyc/start', { country: 'IT' });
    const [request] = await t.db.select().from(kycRequests).where(eq(kycRequests.wallet, user.wallet));
    const identityHash = 'ef'.repeat(32);
    await admin('POST', `/v1/admin/kyc/${request!.id}/approve`, { identityHash, country: 'IT' });
    const owner = new PublicKey(user.wallet);
    accounts.set(profileOf(owner).toBase58(), info(new PublicKey(t.config.PROGRAM_ID!), 1_000_000, await traderProfile(owner, new Uint8Array(32))));
    expect((await as(user.cookie).get('/v1/me')).json().kyc).toBe('pending');
    accounts.set(profileOf(owner).toBase58(), info(new PublicKey(t.config.PROGRAM_ID!), 1_000_000, await traderProfile(owner, Buffer.from(identityHash, 'hex'))));
    expect((await as(user.cookie).get('/v1/me')).json().kyc).toBe('verified');
  });

  it('one identity can back only one wallet', async () => {
    const identityHash = 'cd'.repeat(32);
    const ids: string[] = [];
    for (const user of [await signIn(t.app), await signIn(t.app)]) {
      await as(user.cookie).post('/v1/kyc/start', { country: 'GB' });
      const [r] = await t.db.select().from(kycRequests).where(eq(kycRequests.wallet, user.wallet));
      ids.push(r!.id);
    }
    expect((await admin('POST', `/v1/admin/kyc/${ids[0]}/approve`, { identityHash, country: 'GB' })).statusCode).toBe(200);
    const second = await admin('POST', `/v1/admin/kyc/${ids[1]}/approve`, { identityHash, country: 'GB' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('identity_in_use');
    const [still] = await t.db.select().from(kycRequests).where(eq(kycRequests.id, ids[1]!));
    expect(still!.status).toBe('pending');
  });

  it('rejection is recorded, audited and shown to the wallet; a new request can follow', async () => {
    const user = await signIn(t.app);
    await as(user.cookie).post('/v1/kyc/start', { country: 'ES' });
    const [request] = await t.db.select().from(kycRequests).where(eq(kycRequests.wallet, user.wallet));
    const res = await admin('POST', `/v1/admin/kyc/${request!.id}/reject`, { reason: 'Document unreadable' });
    expect(res.json()).toEqual({ id: request!.id, status: 'rejected' });
    expect((await as(user.cookie).get('/v1/me')).json().kyc).toBe('rejected');
    const [audit] = await t.db.select().from(adminAuditLog).where(eq(adminAuditLog.target, user.wallet));
    expect(audit!.action).toBe('kyc.reject');
    expect((await as(user.cookie).post('/v1/kyc/start', { country: 'ES' })).json()).toEqual({ kyc: 'pending' });
  });
});

describe('admin auth', () => {
  it('requires the exact bearer token', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/v1/admin/kyc' })).statusCode).toBe(401);
    expect((await admin('GET', '/v1/admin/kyc', undefined, 'wrong')).statusCode).toBe(401);
    expect((await admin('GET', '/v1/admin/kyc', undefined, `${t.config.ADMIN_API_TOKEN}x`)).statusCode).toBe(401);
    const cookieOnly = await signIn(t.app);
    expect((await as(cookieOnly.cookie).get('/v1/admin/kyc')).statusCode).toBe(401);
    expect((await admin('GET', '/v1/admin/kyc')).statusCode).toBe(200);
  });
});

describe('notifications', () => {
  it('lists only the wallet’s own, newest first, and marks them read', async () => {
    const alice = await signIn(t.app);
    const bob = await signIn(t.app);
    const [first] = await t.db.insert(notifications).values(
      { wallet: alice.wallet, kind: 'fill', title: 'Order executed', body: 'Long BTC 1,000 USD', href: '/trade/practice', createdAt: new Date(Date.now() - 1000) },
    ).returning();
    await t.db.insert(notifications).values([
      { wallet: alice.wallet, kind: 'risk', title: 'Near limit', body: 'Allowance 10% left', href: '/accounts' },
      { wallet: bob.wallet, kind: 'payout', title: 'Payout paid', body: '100 USDC', href: '/payouts' },
    ]);
    const list = (await as(alice.cookie).get('/v1/notifications')).json();
    expect(list.map((n: { title: string }) => n.title)).toEqual(['Near limit', 'Order executed']);
    expect(list.every((n: { read: boolean }) => !n.read)).toBe(true);

    expect((await as(alice.cookie).post('/v1/notifications/read', { ids: [first!.id] })).json()).toEqual({ updated: 1 });
    expect((await as(bob.cookie).post('/v1/notifications/read', { ids: [first!.id] })).json()).toEqual({ updated: 0 });
    expect((await as(alice.cookie).post('/v1/notifications/read', {})).json()).toEqual({ updated: 1 });
    expect((await as(alice.cookie).get('/v1/notifications')).json().every((n: { read: boolean }) => n.read)).toBe(true);
    expect((await as(bob.cookie).get('/v1/notifications')).json()[0].read).toBe(false);
  });
});

describe('hardening', () => {
  it('allows CORS with credentials for the app origin only', async () => {
    const ok = await t.app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin: APP_ORIGIN, 'access-control-request-method': 'GET' } });
    expect(ok.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await t.app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets security headers and answers unknown routes and oversized bodies in the ApiError format', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    const big = await t.app.inject({ method: 'POST', url: '/v1/auth/nonce', payload: { wallet: 'x'.repeat(70_000) } });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBeTypeOf('string');
  });

  it('rate-limits sign-in attempts per client', async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push((await t.app.inject({ method: 'POST', url: '/v1/auth/nonce', payload: { wallet }, remoteAddress: '203.0.113.9' })).statusCode);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    const limited = await t.app.inject({ method: 'POST', url: '/v1/auth/nonce', payload: { wallet }, remoteAddress: '203.0.113.9' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
  });
});
