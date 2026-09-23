// The chain module's HTTP surface through the real app (auth, admin token, error handling) on a real Postgres. Chain
// reads go to a stand-in RPC serving props_vault accounts encoded with the program's own coder.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import { eq } from 'drizzle-orm';
import type { AccountDetail, AccountSummary, AppConfig, PayoutEligibility, Payout, Performance, VaultStats, VerifyResult } from '@props/shared';
import {
  PROPS_VAULT_PROGRAM_ID, USDC_MINT, capitalVaultAddress, configPda, feeVaultPda, ownerUsdcAddress, solTreasuryPda,
} from '@props/sdk';
import { buildApp } from '../../../app.ts';
import { loadConfig } from '../../../config.ts';
import { adminAuditLog, accounts, chainJobs, evaluations, fundedAccounts, payouts, programEvents } from '../../../db/schema.ts';
import { TOKEN_PROGRAM_ID } from '../../../lib/solana.ts';
import { createStreamHub } from '../../../stream.ts';
import { APP_ORIGIN, signIn } from '../../../../test/helpers.ts';
import type { ModuleContext } from '../../types.ts';
import { createChain } from '../index.ts';
import { TEST_SESSION_SECRET, encodeAccount, freshDb, offlineClient, sealer, simStub } from './support.ts';

const client = offlineClient();
const key = () => Keypair.generate().publicKey;
const alice = Keypair.generate();
const bob = Keypair.generate();
const chainAccounts = new Map<string, AccountInfo<Buffer>>();
const info = (owner: PublicKey, data: Buffer, lamports = 1_000_000): AccountInfo<Buffer> => ({ owner, data, lamports, executable: false, rentEpoch: 0 });

/** A Solana node holding `chainAccounts`: enough of the Connection API for the chain module's reads. */
const rpc = {
  commitment: 'confirmed',
  rpcEndpoint: 'http://stand-in',
  async getAccountInfo(k: PublicKey) {
    return chainAccounts.get(k.toBase58()) ?? null;
  },
  async getMultipleAccountsInfo(keys: PublicKey[]) {
    return keys.map((k) => chainAccounts.get(k.toBase58()) ?? null);
  },
  async getMultipleAccountsInfoAndContext(keys: PublicKey[]) {
    return { context: { slot: 42 }, value: keys.map((k) => chainAccounts.get(k.toBase58()) ?? null) };
  },
  async getProgramAccounts() {
    return [];
  },
  async getTransaction() {
    return null;
  },
};

function usdcAccount(owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(165);
  USDC_MINT.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  return info(TOKEN_PROGRAM_ID, data, 2_039_280);
}

const free = { marketToken: PublicKey.default, gmPosition: PublicKey.default, isLong: false, collateral: new BN(0), sizeUsd: new BN(0), pendingUsd: new BN(0), lastSync: new BN(0) };
const freeOrder = { order: PublicKey.default, slot: 0, orderType: { market: {} }, sizeUsd: new BN(0), collateral: new BN(0), placedByRisk: false };

function fundedAccountData(trader: PublicKey, evaluation: PublicKey, status: string) {
  return encodeAccount(client, 'fundedAccount', {
    trader, evaluation,
    terms: { sizeUsd: new BN(10_000_000_000), profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000, termsHash: Array(32).fill(1), tierVersion: 1 },
    principal: new BN(500_000_000), status: { [status]: {} }, slots: Array(8).fill(free), orders: Array(8).fill(freeOrder),
    orderSeq: new BN(0), payoutsPaid: new BN(0), payoutSeq: 1, createdAt: new BN(0), lastSyncAt: new BN(0), bump: 255, ownerBump: 255,
  });
}

function configData(paused = false) {
  return encodeAccount(client, 'config', {
    admin: key(), pendingAdmin: null, riskAuthorities: [key()], kycAuthority: key(), usdcMint: USDC_MINT, gmtradeProgram: key(), gmtradeStore: key(),
    capitalVault: capitalVaultAddress(), traderShareBps: 8000, minPayout: new BN(50_000_000), ownerSolTarget: new BN(1), ownerSolMin: new BN(1), maxDailyPrincipal: new BN(1), principalWindowStart: new BN(0), principalInWindow: new BN(0),
    paused: { newEvaluations: false, trading: false, payouts: paused }, feesCollected: new BN(79_000_000), allocatedPrincipal: new BN(500_000_000),
    payoutsPaid: new BN(0), profitToVault: new BN(0), evaluationsSold: new BN(1), fundedActivated: new BN(1), fundedActive: 1,
    bump: 255, vaultBump: 255, feeVaultBump: 255, solTreasuryBump: 255,
  });
}

let t: Awaited<ReturnType<typeof freshDb>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken: string;
const ids = { evaluation: key().toBase58(), funded: key().toBase58(), owner: key().toBase58(), payout: key().toBase58(), otherPayout: key().toBase58() };
const practice = `practice:${alice.publicKey.toBase58()}`;
const practiceDetail = {
  id: practice, stage: 'practice', status: 'active', label: 'Practice', shortId: 'PT-prac…', equity: '25000', positions: [], orders: [],
} as unknown as AccountDetail;

before(async () => {
  t = await freshDb('chain_routes');
  adminToken = randomBytes(32).toString('hex');
  const config = loadConfig({
    DATABASE_URL: t.url, APP_ORIGIN, SESSION_SECRET: TEST_SESSION_SECRET, ADMIN_API_TOKEN: adminToken, RPC_URL: 'http://127.0.0.1:1',
    PROGRAM_ID: PROPS_VAULT_PROGRAM_ID.toBase58(), SOLANA_CLUSTER: 'mainnet-beta', TRUST_PROXY_HOPS: '0',
  });
  const hub = createStreamHub();
  app = await buildApp({ config, db: t.db, sql: t.sql, hub, modules: new Map(), rpc: rpc as never, logger: false });
  const stopped = new AbortController();
  stopped.abort(); // routes only: no leader loops in this suite
  const ctx: ModuleContext = {
    app, log: app.log, env: {}, publish: hub.publish, services: { sim: simStub([practiceDetail]).sim }, signal: stopped.signal,
    config, db: t.db, sql: t.sql, rpc: rpc as never, notify: async () => {},
  };
  await createChain(ctx);
  await app.ready();

  const trader = alice.publicKey.toBase58();
  await t.db.insert(evaluations).values({
    address: ids.evaluation, trader, evalIndex: 0, tierId: 1, sizeUsd: '10000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000,
    traderShareBps: 8000, termsHash: 'ab'.repeat(32), feePaid: '79', status: 'funded', finalEquity: '10800', tradesRoot: 'cd'.repeat(32),
    purchaseSignature: 'purchaseSig', resultSignature: 'resultSig', createdAt: new Date(), resolvedAt: new Date(), updatedSlot: 1,
  });
  await t.db.insert(fundedAccounts).values({
    address: ids.funded, evaluation: ids.evaluation, trader, ownerPda: ids.owner, principal: '500', traderShareBps: 8000, status: 'active',
    activationSignature: 'activationSig', createdAt: new Date(), updatedSlot: 2,
  });
  await t.db.insert(accounts).values({
    id: ids.funded, wallet: trader, stage: 'funded', status: 'active', label: 'Funded 10K', tierId: 1, evaluation: ids.evaluation, funded: ids.funded,
    sizeUsd: '10000', lossAllowanceUsd: '500', maxExposureBps: 10_000, traderShareBps: 8000, termsHash: 'ab'.repeat(32), termsVersion: 1, activatedAt: new Date(),
  });
  const payout = (address: string, fundedAccount: string, seq: number, status: 'requested' | 'paid') => ({
    address, fundedAccount, seq, status, balanceAtRequest: '600', profit: '100', traderAmount: '80', vaultAmount: '20', destination: trader,
    requestSignature: `request${seq}`, requestedAt: new Date(),
  });
  await t.db.insert(payouts).values([payout(ids.payout, ids.funded, 0, 'requested'), payout(ids.otherPayout, ids.funded, 1, 'paid')]);
  await t.db.insert(programEvents).values({ signature: 'activationSig', eventIndex: 0, slot: 2, name: 'fundedActivated', data: { funded: ids.funded } });

  const funded = new PublicKey(ids.funded);
  chainAccounts.set(ids.funded, info(PROPS_VAULT_PROGRAM_ID, fundedAccountData(alice.publicKey, new PublicKey(ids.evaluation), 'active')));
  chainAccounts.set(ownerUsdcAddress(funded).toBase58(), usdcAccount(new PublicKey(ids.owner), 520_000_000n));
});

after(async () => {
  await app.close();
  await t.sql.end();
});

const as = (cookie: string) => ({
  get: <T>(url: string) => app.inject({ method: 'GET', url, headers: { cookie } }).then((r) => ({ status: r.statusCode, body: r.json() as T })),
});
const admin = (method: 'GET' | 'POST', url: string, payload?: object, token = adminToken) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } }).then((r) => ({ status: r.statusCode, body: r.json() }));

test('accounts: sim and funded accounts merge, dispatch by id, and never leak another wallet\'s account', async () => {
  const a = as((await signIn(app, alice)).cookie);
  const b = as((await signIn(app, bob)).cookie);
  const list = await a.get<AccountSummary[]>('/v1/accounts');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((x) => x.id), [practice, ids.funded]);
  const funded = list.body[1]!;
  // 520 USDC on the owner PDA, flat: equity 10,000 − 500 + 520, realized 20, the trader's 80% of it payable.
  assert.deepEqual(
    [funded.equity, funded.realizedPnl, funded.unrealizedPnl, funded.allowanceRemaining, funded.availableMargin, funded.eligiblePayout, funded.freshness],
    ['10020', '20', '0', '520', '520', '16', 'live'],
  );
  assert.deepEqual(funded.evidence, { evaluation: ids.evaluation, funded: ids.funded, owner: ids.owner, purchaseSignature: 'purchaseSig', activationSignature: 'activationSig' });

  const detail = await a.get<AccountDetail>(`/v1/accounts/${ids.funded}`);
  assert.deepEqual([detail.status, detail.body.positions, detail.body.orders], [200, [], []]);
  assert.equal((await a.get<AccountDetail>(`/v1/accounts/${practice}`)).body.label, 'Practice');
  for (const url of [`/v1/accounts/${ids.funded}`, `/v1/accounts/${ids.funded}/orders`, `/v1/accounts/${practice}`, `/v1/accounts/${ids.funded}/payout-eligibility`]) {
    assert.equal((await b.get(url)).status, 404, url);
  }
  assert.equal((await a.get('/v1/accounts/nope')).status, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/accounts' })).statusCode, 401);

  const perf = await a.get<Performance>(`/v1/accounts/${ids.funded}/performance?period=1W`);
  assert.deepEqual([perf.status, perf.body.period, perf.body.trades, perf.body.winRatePct, perf.body.series.at(-1)!.equity], [200, '1W', 0, null, '10020']);
  assert.equal((await a.get(`/v1/accounts/${ids.funded}/performance?period=5Y`)).status, 400);
  assert.deepEqual((await a.get(`/v1/accounts/${ids.funded}/activity`)).body, []);
  assert.deepEqual((await a.get(`/v1/accounts/${ids.funded}/history`)).body, []);
});

test('config, vault and payout eligibility read the program state, and say so when it is not there', async () => {
  const a = as((await signIn(app, alice)).cookie);
  assert.equal((await a.get('/v1/config')).status, 503);
  assert.equal((await a.get('/v1/vault')).status, 503);
  assert.equal((await a.get(`/v1/accounts/${ids.funded}/payout-eligibility`)).status, 503);

  chainAccounts.set(configPda().toBase58(), info(PROPS_VAULT_PROGRAM_ID, configData()));
  chainAccounts.set(capitalVaultAddress().toBase58(), usdcAccount(key(), 400_000_000n));
  chainAccounts.set(feeVaultPda().toBase58(), usdcAccount(key(), 79_000_000n));
  chainAccounts.set(solTreasuryPda().toBase58(), info(new PublicKey('11111111111111111111111111111111'), Buffer.alloc(0), 2_500_000_000));
  const config = await a.get<AppConfig>('/v1/config');
  assert.deepEqual([config.status, config.body.cluster, config.body.traderShareBps, config.body.minPayoutUsdc, config.body.tiers], [200, 'mainnet-beta', 8000, '50', []]);

  const vault = await a.get<VaultStats>('/v1/vault');
  assert.deepEqual(
    [vault.body.capitalUsdc, vault.body.allocatedPrincipal, vault.body.unallocated, vault.body.feeVaultUsdc, vault.body.pendingPayouts, vault.body.solTreasurySol, vault.body.fundedAccounts],
    ['900', '500', '400', '79', '80', '2.5', 1],
  );

  const e = await a.get<PayoutEligibility>(`/v1/accounts/${ids.funded}/payout-eligibility`);
  assert.deepEqual(
    [e.body.eligible, e.body.flat, e.body.realizedProfit, e.body.traderShare, e.body.vaultShare, e.body.minPayout, e.body.reasons],
    [false, true, '20', '16', '4', '50', ['Your share must be at least 50 USDC']],
  );
  chainAccounts.set(ownerUsdcAddress(new PublicKey(ids.funded)).toBase58(), usdcAccount(new PublicKey(ids.owner), 600_000_000n));
  const rich = await a.get<PayoutEligibility>(`/v1/accounts/${ids.funded}/payout-eligibility`);
  assert.deepEqual([rich.body.eligible, rich.body.traderShare, rich.body.reasons], [true, '80', []]);
});

test('payouts: a wallet sees only its own', async () => {
  const a = as((await signIn(app, alice)).cookie);
  const b = as((await signIn(app, bob)).cookie);
  const mine = await a.get<Payout[]>('/v1/payouts');
  assert.deepEqual(mine.body.map((p) => [p.id, p.status, p.traderAmount, p.accountLabel]).sort(), [
    [ids.otherPayout, 'paid', '80', 'Funded 10K'], [ids.payout, 'requested', '80', 'Funded 10K'],
  ].sort());
  assert.equal((await a.get<Payout>(`/v1/payouts/${ids.payout}`)).body.requestSignature, 'request0');
  assert.deepEqual((await b.get('/v1/payouts')).body, []);
  assert.equal((await b.get(`/v1/payouts/${ids.payout}`)).status, 404);
});

test('admin payout review: one decision per payout, audited; a failed one can be replaced', async () => {
  assert.equal((await admin('GET', '/v1/admin/payouts', undefined, 'wrong')).status, 401);
  await t.db.update(payouts).set({ status: 'reviewing', reviewNote: 'Opposite SOL position in another funded account' }).where(eq(payouts.address, ids.payout));
  const held = await admin('GET', '/v1/admin/payouts');
  assert.deepEqual(held.body.map((p: { id: string; status: string; reviewNote: string }) => [p.id, p.status, p.reviewNote]),
    [[ids.payout, 'reviewing', 'Opposite SOL position in another funded account']], 'the keeper\'s review note is shown to operators');

  const approve = await admin('POST', `/v1/admin/payouts/${ids.payout}/approve`);
  assert.equal(approve.status, 200);
  const [job] = await t.db.select().from(chainJobs).where(eq(chainJobs.subject, ids.payout));
  assert.deepEqual([job!.kind, job!.status, job!.payload], ['approve_payout', 'queued', { payout: ids.payout }]);
  assert.equal((await admin('POST', `/v1/admin/payouts/${ids.payout}/reject`, { reasonCode: 2 })).status, 409, 'a decision is in flight');
  assert.equal((await admin('POST', `/v1/admin/payouts/${ids.payout}/reject`, { reasonCode: 99 })).status, 400);

  await t.db.update(chainJobs).set({ status: 'failed', lastError: 'simulation failed: NotFlat' }).where(eq(chainJobs.id, job!.id));
  const listed = await admin('GET', '/v1/admin/payouts');
  assert.deepEqual(listed.body[0].decision, { kind: 'approve_payout', status: 'failed', attempts: 0, lastError: 'simulation failed: NotFlat', signature: null });
  assert.equal((await admin('POST', `/v1/admin/payouts/${ids.payout}/reject`, { reasonCode: 2 })).status, 200);
  const [replaced] = await t.db.select().from(chainJobs).where(eq(chainJobs.subject, ids.payout));
  assert.deepEqual([replaced!.id, replaced!.kind, replaced!.status, replaced!.payload], [job!.id, 'reject_payout', 'queued', { payout: ids.payout, reasonCode: 2 }]);

  assert.equal((await admin('POST', `/v1/admin/payouts/${ids.otherPayout}/approve`)).status, 409, 'already paid');
  assert.equal((await admin('POST', `/v1/admin/payouts/${key().toBase58()}/approve`)).status, 404);

  // A job that failed for good (e.g. through an RPC outage) goes back in the queue as new, once, by an operator.
  assert.equal((await admin('POST', `/v1/admin/jobs/${job!.id}/retry`)).status, 409, 'only a failed job is retried');
  await t.db.update(chainJobs).set({ status: 'failed', attempts: 10, lastError: 'fetch failed', signature: 'failedSig' }).where(eq(chainJobs.id, job!.id));
  assert.deepEqual((await admin('POST', `/v1/admin/jobs/${job!.id}/retry`)).body, { id: job!.id, status: 'queued' });
  const [retried] = await t.db.select().from(chainJobs).where(eq(chainJobs.id, job!.id));
  assert.deepEqual([retried!.kind, retried!.status, retried!.attempts, retried!.lastError, retried!.signature], ['reject_payout', 'queued', 0, null, null]);
  assert.equal((await admin('POST', '/v1/admin/jobs/not-a-uuid/retry')).status, 400);
  assert.equal((await admin('POST', `/v1/admin/jobs/${job!.id}/retry`, undefined, 'wrong')).status, 401);
  const audit = await t.db.select().from(adminAuditLog);
  assert.deepEqual(audit.map((x) => x.action), ['payout.approve', 'payout.reject', 'job.retry']);
});

test('admin: lifting a restriction queues restrict(false) once, again only after the last one finished', async () => {
  const lift = () => admin('POST', `/v1/admin/funded/${ids.funded}/lift-restriction`);
  assert.equal((await lift()).status, 409, 'the account is not restricted');
  assert.equal((await admin('POST', `/v1/admin/funded/${key().toBase58()}/lift-restriction`)).status, 404);
  assert.equal((await admin('POST', `/v1/admin/funded/${ids.funded}/lift-restriction`, undefined, 'wrong')).status, 401);
  await t.db.update(fundedAccounts).set({ status: 'restricted' }).where(eq(fundedAccounts.address, ids.funded));
  const queued = await lift();
  assert.equal(queued.status, 200);
  const [job] = await t.db.select().from(chainJobs).where(eq(chainJobs.subject, `lift:${ids.funded}`));
  assert.deepEqual([job!.id, job!.kind, job!.status, job!.payload], [queued.body.job, 'lift_restriction', 'queued', { funded: ids.funded }]);
  assert.equal((await lift()).status, 409, 'already in progress');
  await t.db.update(chainJobs).set({ status: 'confirmed', signature: 'liftSig' }).where(eq(chainJobs.id, job!.id));
  assert.equal((await lift()).status, 200, 'restricted again later: lifted again');
  const [again] = await t.db.select().from(chainJobs).where(eq(chainJobs.subject, `lift:${ids.funded}`));
  assert.deepEqual([again!.id, again!.status, again!.signature], [job!.id, 'queued', null]);
  assert.deepEqual((await t.db.select().from(adminAuditLog).where(eq(adminAuditLog.target, ids.funded))).map((a) => a.action), ['funded.lift_restriction', 'funded.lift_restriction']);
  await t.db.update(fundedAccounts).set({ status: 'active' }).where(eq(fundedAccounts.address, ids.funded));
  await t.db.delete(chainJobs).where(eq(chainJobs.id, job!.id));
});

test('admin: closing a funded account queues one sealed close_funded, refused while a payout is pending', async () => {
  const close = () => admin('POST', `/v1/admin/funded/${ids.funded}/close`);
  assert.equal((await admin('POST', `/v1/admin/funded/${key().toBase58()}/close`)).status, 404);
  await t.db.update(fundedAccounts).set({ status: 'payout_pending' }).where(eq(fundedAccounts.address, ids.funded));
  assert.equal((await close()).status, 409, 'a payout request is pending');
  await t.db.update(fundedAccounts).set({ status: 'active' }).where(eq(fundedAccounts.address, ids.funded));
  const queued = await close();
  assert.equal(queued.status, 200);
  const [job] = await t.db.select().from(chainJobs).where(eq(chainJobs.subject, `close:${ids.funded}`));
  assert.deepEqual([job!.id, job!.kind, job!.status, job!.payload], [queued.body.job, 'close_funded', 'queued', { funded: ids.funded }]);
  assert.equal(sealer.verifyJob(job!), true, 'sealed with the server secret');
  assert.equal((await close()).status, 409, 'already in progress');
  assert.deepEqual((await t.db.select().from(adminAuditLog).where(eq(adminAuditLog.target, ids.funded))).map((a) => a.action).filter((a) => a === 'funded.close'), ['funded.close']);
  await t.db.delete(chainJobs).where(eq(chainJobs.id, job!.id));
});

test('verify: evaluation, funded account, payout, transaction and wallet records with what each proves', async () => {
  const get = (q: string) => app.inject({ method: 'GET', url: `/v1/verify?q=${encodeURIComponent(q)}` }).then((r) => r.json() as VerifyResult);
  const evaluation = await get(ids.evaluation);
  assert.equal(evaluation.kind, 'evaluation');
  assert.deepEqual(evaluation.items.map((i) => i.title), ['Evaluation purchased', 'Evaluation account', 'Evaluation passed', 'Activated as a funded account']);
  assert.equal(evaluation.items[0]!.explorerUrl, 'https://solscan.io/tx/purchaseSig');
  assert.match(evaluation.items[2]!.establishes, /simulated off-chain.*does not show that the simulated fills were fair/);

  const funded = await get(ids.funded);
  assert.equal(funded.kind, 'funded');
  assert.ok(funded.items.some((i) => i.title === 'Trading address' && i.address === ids.owner && i.explorerUrl === `https://solscan.io/account/${ids.owner}`));
  assert.ok(funded.items.some((i) => i.title === 'Payout paid' || i.title === 'Payout requested'));

  const payout = await get(ids.payout);
  assert.deepEqual([payout.kind, payout.items.map((i) => i.state)], ['payout', ['confirmed', 'pending', 'confirmed']]);
  assert.deepEqual((await get('activationSig')).kind, 'unsupported', 'not a 64-byte signature');
  const sig = Buffer.alloc(64, 7);
  const bs58 = (await import('bs58')).default;
  await t.db.insert(programEvents).values({ signature: bs58.encode(sig), eventIndex: 0, slot: 9, name: 'capitalDeposited', data: { amount: '1' } });
  const tx = await get(bs58.encode(sig));
  assert.deepEqual([tx.kind, tx.items[0]!.title], ['transaction', 'Capital deposited']);
  assert.equal((await get(alice.publicKey.toBase58())).kind, 'wallet');
  assert.equal((await get(key().toBase58())).kind, 'not_found');
  assert.equal((await get('PT-1234')).kind, 'unsupported');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/verify' })).statusCode, 400);
});
