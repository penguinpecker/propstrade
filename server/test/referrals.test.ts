// Referral program (src/routes/referrals.ts): codes, the binding rules, rewards per funded fill, the summary and the
// operator routes. Rewards are written by the venue loop in the fill's transaction; its own test drives that path with a
// real fill list (src/modules/chain/test/venue.test.ts), these call the same function directly.
import { randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReferralSummary } from '@props/shared';
import {
  accounts, adminAuditLog, evaluations, fundedAccounts, kycRequests, referralPayouts, referralRewards, simFills, users, venueFills,
} from '../src/db/schema.js';
import { accrueReferralReward, assignReferralCode, backfillReferralCodes } from '../src/routes/referrals.js';
import { LOCK_KEYS } from '../src/lib/leader.js';
import { USDC_MINT } from '../src/lib/solana.js';
import { APP_ORIGIN, fixtureRpc, makeApp, signIn as signInFrom } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
/** The chain's confirmed transactions, by signature (getTransaction's shape, the parts the payout check reads). */
const chain = new Map<string, unknown>();
beforeAll(async () => { t = await makeApp({ rpc: fixtureRpc(new Map(), chain) }); });
afterAll(async () => { await t.close(); });

let client = 0;
/** Each sign-in from its own address: this file signs in more users than one client may in a minute. */
const signIn = (app: typeof t.app, keypair?: Keypair) => signInFrom(app, keypair, `10.0.${Math.floor(++client / 250)}.${client % 250}`);

const key = () => Keypair.generate().publicKey.toBase58();
const signature = () => bs58.encode(Keypair.generate().secretKey);
/** A confirmed transaction moving USDC into each [wallet, amount in USD]; its signature. */
function sent(...transfers: [wallet: string, amountUsd: string][]) {
  const sig = signature();
  const balance = (i: number, owner: string, amount: string) => ({ accountIndex: i + 1, mint: USDC_MINT.toBase58(), owner, uiTokenAmount: { amount } });
  chain.set(sig, { meta: {
    err: null,
    preTokenBalances: transfers.map(([owner], i) => balance(i, owner, '7000000')),
    postTokenBalances: transfers.map(([owner, usd], i) => balance(i, owner, String(7_000_000 + Math.round(Number(usd) * 1e6)))),
  } });
  return sig;
}
/** `wallet` passed identity review. */
const verified = (wallet: string) => t.db.insert(kycRequests).values({ wallet, country: 'DE', status: 'approved', identityHash: randomBytes(32).toString('hex') });
const as = (cookie: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie } }),
  post: (url: string, payload?: object) => t.app.inject({ method: 'POST', url, payload, headers: { cookie, origin: APP_ORIGIN } }),
});
const admin = (method: 'GET' | 'POST', url: string, payload?: object, token = t.config.ADMIN_API_TOKEN) =>
  t.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
const summary = async (cookie: string) => (await as(cookie).get('/v1/me/referrals')).json() as ReferralSummary;
const codeOf = async (wallet: string) => (await t.db.select({ code: users.referralCode }).from(users).where(eq(users.wallet, wallet)))[0]?.code;
/** A signed-in user who used `code` at sign-up. */
async function referredBy(code: string) {
  const user = await signIn(t.app);
  expect((await as(user.cookie).post('/v1/me/referrer', { code })).statusCode).toBe(200);
  return user;
}

let seq = 0;
/** An evaluation `trader` bought, as the indexer records it. */
async function evaluation(trader: string, status: 'active' | 'funded' = 'active') {
  const address = key();
  await t.db.insert(evaluations).values({
    address, trader, evalIndex: seq++, tierId: 1, sizeUsd: '10000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000,
    traderShareBps: 8000, termsHash: 'ab'.repeat(32), feePaid: '79', status, purchaseSignature: 'purchase', createdAt: new Date(), updatedSlot: 1,
  });
  return address;
}
/** A funded account of `trader` with fills [size, exchange fee] in USD, as the venue loop indexes them. */
async function fundedWith(trader: string, fills: [sizeUsd: string, feeUsd: string][]) {
  const address = key();
  await t.db.insert(fundedAccounts).values({
    address, evaluation: await evaluation(trader, 'funded'), trader, ownerPda: key(), principal: '500', traderShareBps: 8000, status: 'active',
    activationSignature: 'activation', createdAt: new Date(), updatedSlot: 2,
  });
  const rows = fills.map(([sizeUsd, feeUsd]) => ({
    signature: key(), eventIndex: 0, venueId: `${String(++seq).padStart(12, '0')}-${key().slice(0, 8)}-000001-000001-000000`, slot: seq,
    fundedAccount: address, position: key(), order: key(), symbol: 'SOL', side: 'Long' as const, isIncrease: true, sizeUsd, sizeAfterUsd: sizeUsd,
    price: '150', feeUsd, priceImpactUsd: '0', fundingUsd: '0', borrowUsd: '0', realizedPnl: null, ts: new Date(),
  }));
  if (rows.length) await t.db.insert(venueFills).values(rows);
  return rows;
}
const accrue = async (fills: { venueId: string; symbol: string; feeUsd: string }[], trader: string, bps = 1000) => {
  for (const f of fills) await t.db.transaction((tx) => accrueReferralReward(tx, f, trader, bps));
};

describe('referral codes', () => {
  it('a first sign-in gives the first 8 characters of the wallet, upper-cased; later sign-ins keep it', async () => {
    const user = await signIn(t.app);
    const code = user.wallet.slice(0, 8).toUpperCase();
    expect(await codeOf(user.wallet)).toBe(code);
    expect((await summary(user.cookie)).code).toBe(code);
    await signIn(t.app, user.keypair);
    expect(await codeOf(user.wallet)).toBe(code);
    expect(await t.db.transaction((tx) => assignReferralCode(tx, user.wallet))).toBeNull();
  });

  it('a code another wallet holds in any case is extended a character at a time; the first come keeps the short one', async () => {
    const tail = () => key().slice(0, 30);
    // Inserted newest first: the backfill goes by first sign-in, not by row order.
    const [first, second, third] = [`RefCoDe1${tail()}`, `rEFcOdE1x${tail()}`, `REFCODE1Xy${tail()}`];
    await t.db.insert(users).values([
      { wallet: third, createdAt: new Date('2026-09-03') }, { wallet: second, createdAt: new Date('2026-09-02') }, { wallet: first, createdAt: new Date('2026-09-01') },
    ]);
    expect(await backfillReferralCodes(t.db, 2)).toBe(3);
    expect([await codeOf(first), await codeOf(second), await codeOf(third)]).toEqual(['REFCODE1', 'REFCODE1X', 'REFCODE1XY']);
    // Idempotent: nothing left to give, nothing changes.
    expect(await backfillReferralCodes(t.db)).toBe(0);
    expect([await codeOf(first), await codeOf(second), await codeOf(third)]).toEqual(['REFCODE1', 'REFCODE1X', 'REFCODE1XY']);
    // The database refuses a second holder of a code, and a code not in upper case.
    await expect(t.db.update(users).set({ referralCode: 'REFCODE1' }).where(eq(users.wallet, (await signIn(t.app)).wallet))).rejects.toThrow();
    await expect(t.db.insert(users).values({ wallet: key(), referralCode: 'lowercase1' })).rejects.toThrow();
  });

  it('a sign-in of a user from before the program, while the boot backfill holds the codes lock, waits instead of deadlocking', async () => {
    const keypair = Keypair.generate();
    const wallet = keypair.publicKey.toBase58();
    await t.db.insert(users).values({ wallet, createdAt: new Date('2026-08-01') }); // no code yet
    // The backfill's order: the codes lock, then user rows. Held while the sign-in reaches the codes lock.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const backfill = t.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEYS.referralCodes}::int)`);
      await held;
      return assignReferralCode(tx, wallet);
    });
    const signingIn = signIn(t.app, keypair);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    expect(await backfill).toBe(wallet.slice(0, 8).toUpperCase());
    expect((await signingIn).wallet).toBe(wallet);
    expect(await codeOf(wallet)).toBe(wallet.slice(0, 8).toUpperCase());
  });

  it('the program\'s reward rate is public', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/referrals' });
    expect([res.statusCode, res.json()]).toEqual([200, { rewardBps: 1000 }]);
  });

  it('the public check matches a code in any case, with spaces around it, and says no to anything else', async () => {
    const { wallet } = await signIn(t.app);
    const code = wallet.slice(0, 8).toUpperCase();
    const check = (c: string) => t.app.inject({ method: 'GET', url: `/v1/referrals/${encodeURIComponent(c)}` });
    const res = await check(code.toLowerCase());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true });
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await check(` ${code} `)).json()).toEqual({ valid: true });
    expect((await check('ZZ9ZZ9ZZ')).json()).toEqual({ valid: false });
    expect((await check(code.slice(0, 7))).json()).toEqual({ valid: false });
    expect((await check(`${code.slice(0, 7)}!`)).json()).toEqual({ valid: false });
  });
});

describe('binding a referrer', () => {
  it('a new user binds a code typed in any case, once; the summary names the referrer by its code, never its wallet', async () => {
    const referrer = await signIn(t.app);
    const user = await signIn(t.app);
    const before = await summary(user.cookie);
    const [row] = await t.db.select().from(users).where(eq(users.wallet, user.wallet));
    expect(before).toMatchObject({ referredBy: null, canSetReferrer: true, setReferrerUntil: row!.createdAt.getTime() + 7 * 86_400_000, rewardBps: 1000 });

    const res = await as(user.cookie).post('/v1/me/referrer', { code: `  ${referrer.wallet.slice(0, 8).toLowerCase()} ` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ referredBy: referrer.wallet.slice(0, 8).toUpperCase(), canSetReferrer: false, setReferrerUntil: null });
    expect(res.body).not.toContain(referrer.wallet);
    const [bound] = await t.db.select().from(users).where(eq(users.wallet, user.wallet));
    expect(bound!.referredBy).toBe(referrer.wallet);
    expect(bound!.referredAt).toBeInstanceOf(Date);

    const other = await signIn(t.app);
    const again = await as(user.cookie).post('/v1/me/referrer', { code: other.wallet.slice(0, 8) });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_referred');
    expect((await t.db.select().from(users).where(eq(users.wallet, user.wallet)))[0]!.referredBy).toBe(referrer.wallet);
  });

  it('refuses a code nobody holds (404) and the user\'s own code (422)', async () => {
    const user = await signIn(t.app);
    const unknown = await as(user.cookie).post('/v1/me/referrer', { code: 'ZZ9ZZ9ZZ' });
    expect([unknown.statusCode, unknown.json().error.code]).toEqual([404, 'unknown_referral_code']);
    const malformed = await as(user.cookie).post('/v1/me/referrer', { code: 'no such code!' });
    expect([malformed.statusCode, malformed.json().error.code]).toEqual([404, 'unknown_referral_code']);
    const own = await as(user.cookie).post('/v1/me/referrer', { code: user.wallet.slice(0, 8).toLowerCase() });
    expect([own.statusCode, own.json().error.code]).toEqual([422, 'own_referral_code']);
    expect((await as(user.cookie).post('/v1/me/referrer', {})).statusCode).toBe(400);
    expect((await summary(user.cookie)).canSetReferrer).toBe(true);
  });

  it('refuses 7 days after the first sign-in (403)', async () => {
    const referrer = await signIn(t.app);
    const user = await signIn(t.app);
    await t.db.update(users).set({ createdAt: sql`now() - interval '7 days 1 minute'` }).where(eq(users.wallet, user.wallet));
    const res = await as(user.cookie).post('/v1/me/referrer', { code: referrer.wallet.slice(0, 8) });
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'referral_window_closed']);
    expect(res.json().error.message).toMatch(/7 days/);
    expect(await summary(user.cookie)).toMatchObject({ canSetReferrer: false, setReferrerUntil: null, referredBy: null });
  });

  it('refuses once the user has bought an evaluation (403)', async () => {
    const referrer = await signIn(t.app);
    const user = await signIn(t.app);
    await evaluation(user.wallet);
    const res = await as(user.cookie).post('/v1/me/referrer', { code: referrer.wallet.slice(0, 8) });
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'referral_window_closed']);
    expect(res.json().error.message).toMatch(/evaluation/);
    expect((await summary(user.cookie)).canSetReferrer).toBe(false);
    expect((await t.db.select().from(users).where(eq(users.wallet, user.wallet)))[0]!.referredBy).toBeNull();
  });

  it('of two binds at once, one wins and the other is told it already has a referrer', async () => {
    const [a, b, user] = [await signIn(t.app), await signIn(t.app), await signIn(t.app)];
    const results = await Promise.all([a, b].map((r) => as(user.cookie).post('/v1/me/referrer', { code: r.wallet.slice(0, 8) })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it('needs a session', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/v1/me/referrals' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/v1/me/referrer', payload: { code: 'ABCDEFGH' }, headers: { origin: APP_ORIGIN } })).statusCode).toBe(401);
  });
});

describe('rewards', () => {
  it('a referred trader\'s funded fill earns the referrer the rate of its exchange fee, rounded down, once per fill', async () => {
    const referrer = await signIn(t.app);
    const trader = await referredBy(referrer.wallet.slice(0, 8));
    const fills = await fundedWith(trader.wallet, [['10000', '1.234567'], ['500', '0.000009']]);
    await accrue(fills, trader.wallet);
    await accrue(fills, trader.wallet); // the venue loop never repeats a fill; if it did, nothing changes
    const rows = await t.db.select().from(referralRewards).where(eq(referralRewards.referee, trader.wallet)).orderBy(referralRewards.id);
    expect(rows.map((r) => [r.referrer, r.venueFillId, r.symbol, r.feeUsd, r.rateBps, r.rewardUsd])).toEqual([
      [referrer.wallet, fills[0]!.venueId, 'SOL', '1.234567', 1000, '0.123456'],
      [referrer.wallet, fills[1]!.venueId, 'SOL', '0.000009', 1000, '0.000000'],
    ]);
  });

  it('a trader no one referred, a fill without a fee and a zero rate earn nothing', async () => {
    const loner = await signIn(t.app);
    await accrue(await fundedWith(loner.wallet, [['10000', '5']]), loner.wallet);
    const referrer = await signIn(t.app);
    const trader = await referredBy(referrer.wallet.slice(0, 8));
    await accrue(await fundedWith(trader.wallet, [['10000', '0']]), trader.wallet);
    await accrue(await fundedWith(trader.wallet, [['10000', '5']]), trader.wallet, 0);
    const rows = await t.db.select().from(referralRewards)
      .where(sql`${referralRewards.referee} in (${loner.wallet}, ${trader.wallet})`);
    expect(rows).toEqual([]);
  });
});

describe('summary', () => {
  it('counts referees, those with an evaluation and those funded, the funded volume, what was earned, paid and is owed, and the latest 50 rewards', async () => {
    const referrer = await signIn(t.app);
    const code = referrer.wallet.slice(0, 8);
    const [idle, evaluating, trading] = [await referredBy(code), await referredBy(code), await referredBy(code)];
    // A simulated evaluation earns nothing, whatever its fills paid.
    const simulated = await evaluation(evaluating.wallet);
    await t.db.insert(accounts).values({
      id: simulated, wallet: evaluating.wallet, stage: 'evaluation', status: 'active', label: 'Evaluation 10K', evaluation: simulated, sizeUsd: '10000',
      lossAllowanceUsd: '500', maxExposureBps: 10_000, traderShareBps: 8000,
    });
    await t.db.insert(simFills).values({
      accountId: simulated, symbol: 'SOL', side: 'Long', isIncrease: true, sizeUsd: '50000', price: '150', feeUsd: '25', priceImpactUsd: '0',
      fundingUsd: '0', borrowUsd: '0', tickTs: new Date(),
    });
    const fills = await fundedWith(trading.wallet, Array.from({ length: 51 }, (_, i) => [String(100 + i), '0.05'] as [string, string]));
    await accrue(fills, trading.wallet);
    await fundedWith((await signIn(t.app)).wallet, [['99999', '50']]); // someone else's trader
    await verified(referrer.wallet);
    const paid = await admin('POST', '/v1/admin/referrals/payouts', { referrer: referrer.wallet, amountUsd: '0.1', signature: sent([referrer.wallet, '0.1']) });
    expect(paid.statusCode).toBe(200);

    const s = await summary(referrer.cookie);
    expect(s).toMatchObject({
      code: code.toUpperCase(), referredBy: null, rewardBps: 1000, referees: 3, refereesWithEvaluation: 2, refereesFunded: 1,
      fundedVolumeUsd: String(51 * 100 + (50 * 51) / 2), earnedUsd: '0.255', paidUsd: '0.1', pendingUsd: '0.155',
    });
    expect(s.recent).toHaveLength(50);
    // The referee's wallet is masked: enough to tell referees apart, not to follow one onchain.
    expect(s.recent[0]).toEqual({ at: expect.any(Number), referee: `${trading.wallet.slice(0, 4)}…${trading.wallet.slice(-4)}`, symbol: 'SOL', feeUsd: '0.05', rewardUsd: '0.005' });
    expect(JSON.stringify(s)).not.toContain(trading.wallet);
    expect(s.recent.map((r) => r.at)).toEqual([...s.recent.map((r) => r.at)].sort((a, b) => b - a));
    expect(JSON.stringify(s)).not.toContain(idle.wallet); // a referee without rewards appears only in the counts
    // The referee sees who referred it by code only.
    expect(await summary(trading.cookie)).toMatchObject({ referredBy: code.toUpperCase(), referees: 0, earnedUsd: '0', pendingUsd: '0', recent: [] });
  });
});

describe('operator routes', () => {
  it('list every referrer with its code, referees, earned, paid and owed, most owed first', async () => {
    const [small, large] = [await signIn(t.app), await signIn(t.app)];
    const a = await referredBy(small.wallet.slice(0, 8));
    await accrue(await fundedWith(a.wallet, [['1000', '1']]), a.wallet);
    const [b, c] = [await referredBy(large.wallet.slice(0, 8)), await referredBy(large.wallet.slice(0, 8))];
    await accrue(await fundedWith(b.wallet, [['1000', '40']]), b.wallet);
    await accrue(await fundedWith(c.wallet, [['1000', '10']]), c.wallet);
    await verified(large.wallet);
    expect((await admin('POST', '/v1/admin/referrals/payouts', { referrer: large.wallet, amountUsd: '1', signature: sent([large.wallet, '1']) })).statusCode).toBe(200);

    const res = await admin('GET', '/v1/admin/referrals?limit=500');
    expect(res.statusCode).toBe(200);
    const rows = (res.json() as { referrer: string }[]).filter((r) => [small.wallet, large.wallet].includes(r.referrer));
    expect(rows).toEqual([
      { referrer: large.wallet, code: large.wallet.slice(0, 8).toUpperCase(), referees: 2, earnedUsd: '5', paidUsd: '1', pendingUsd: '4' },
      { referrer: small.wallet, code: small.wallet.slice(0, 8).toUpperCase(), referees: 1, earnedUsd: '0.1', paidUsd: '0', pendingUsd: '0.1' },
    ]);
    expect((await admin('GET', '/v1/admin/referrals', undefined, 'x'.repeat(64))).statusCode).toBe(401);
  });

  it('record a payout up to what is owed, in the audit log; refuse more, a bad amount or signature, an unknown referrer and a repeat', async () => {
    const referrer = await signIn(t.app);
    const trader = await referredBy(referrer.wallet.slice(0, 8));
    await accrue(await fundedWith(trader.wallet, [['10000', '20']]), trader.wallet); // earns 2
    await verified(referrer.wallet);
    const pay = (body: { amountUsd?: string; [field: string]: unknown }) =>
      admin('POST', '/v1/admin/referrals/payouts', { referrer: referrer.wallet, amountUsd: '1.5', signature: sent([referrer.wallet, body.amountUsd ?? '1.5']), ...body });

    for (const bad of [{ amountUsd: '0' }, { amountUsd: '-1' }, { amountUsd: '1.1234567' }, { amountUsd: 'one' }, { signature: 'abc' }, { signature: key() }, { referrer: 'nope' }]) {
      const res = await pay(bad);
      expect([res.statusCode, res.json().error.code], JSON.stringify(bad)).toEqual([400, 'bad_request']);
    }
    expect((await pay({ referrer: key() })).statusCode).toBe(404);
    const over = await pay({ amountUsd: '2.000001' });
    expect([over.statusCode, over.json().error.code]).toEqual([409, 'exceeds_pending']);

    const sig = sent([referrer.wallet, '1.5']);
    const res = await pay({ signature: sig, note: 'September' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ referrer: referrer.wallet, amountUsd: '1.5', signature: sig, note: 'September', earnedUsd: '2', paidUsd: '1.5', pendingUsd: '0.5' });
    const [log] = await t.db.select().from(adminAuditLog).where(and(eq(adminAuditLog.action, 'referral.payout'), eq(adminAuditLog.target, referrer.wallet)));
    expect(log!.details).toEqual({ payout: res.json().id, amountUsd: '1.5', signature: sig, note: 'September' });

    const repeat = await pay({ signature: sig, amountUsd: '0.5' });
    expect([repeat.statusCode, repeat.json().error.code]).toEqual([409, 'payout_recorded']);
    expect((await pay({ amountUsd: '0.6' })).statusCode).toBe(409);
    expect((await t.db.select().from(referralPayouts).where(eq(referralPayouts.referrer, referrer.wallet))).length).toBe(1);
    expect((await summary(referrer.cookie))).toMatchObject({ earnedUsd: '2', paidUsd: '1.5', pendingUsd: '0.5' });
    expect((await admin('POST', '/v1/admin/referrals/payouts', { referrer: referrer.wallet, amountUsd: '0.1', signature: sent([referrer.wallet, '0.1']) }, 'x'.repeat(64))).statusCode).toBe(401);
  });

  it('record a payout only to a referrer who passed identity review, so never to a funded referee\'s own second wallet', async () => {
    const alt = await signIn(t.app);
    const trader = await referredBy(alt.wallet.slice(0, 8));
    await verified(trader.wallet); // the person, verified once for the funded account
    await accrue(await fundedWith(trader.wallet, [['10000', '20']]), trader.wallet);
    const pay = () => admin('POST', '/v1/admin/referrals/payouts', { referrer: alt.wallet, amountUsd: '1', signature: sent([alt.wallet, '1']) });
    const refused = await pay();
    expect([refused.statusCode, refused.json().error.code]).toEqual([409, 'referrer_unverified']);
    // Pending review or rejected is not enough; the same person cannot be approved on a second wallet.
    await t.db.insert(kycRequests).values({ wallet: alt.wallet, country: 'DE', status: 'rejected' });
    expect((await pay()).statusCode).toBe(409);
    const [person] = await t.db.select({ identityHash: kycRequests.identityHash }).from(kycRequests).where(eq(kycRequests.wallet, trader.wallet));
    await expect(t.db.insert(kycRequests).values({ wallet: alt.wallet, country: 'DE', status: 'approved', identityHash: person!.identityHash }))
      .rejects.toThrow();
    await verified(alt.wallet); // a different person
    expect((await pay()).statusCode).toBe(200);
  });

  it('record a payout only for a confirmed transfer of at least the amount into the referrer\'s own USDC', async () => {
    const [a, b] = [await signIn(t.app), await signIn(t.app)];
    for (const referrer of [a, b]) {
      await verified(referrer.wallet);
      const trader = await referredBy(referrer.wallet.slice(0, 8));
      await accrue(await fundedWith(trader.wallet, [['10000', '20']]), trader.wallet); // earns 2
    }
    const pay = (referrer: string, amountUsd: string, sig: string) => admin('POST', '/v1/admin/referrals/payouts', { referrer, amountUsd, signature: sig });
    const code = async (res: Awaited<ReturnType<typeof pay>>) => [res.statusCode, res.json().error?.code];

    expect(await code(await pay(a.wallet, '1', signature()))).toEqual([422, 'payout_not_found']); // never sent
    expect(await code(await pay(a.wallet, '1', bs58.encode(new Uint8Array(64))))).toEqual([422, 'payout_not_found']);
    const failed = signature();
    chain.set(failed, { meta: { err: { InstructionError: [0, 'Custom'] }, preTokenBalances: [], postTokenBalances: [] } });
    expect(await code(await pay(a.wallet, '1', failed))).toEqual([422, 'payout_not_found']);
    expect(await code(await pay(a.wallet, '1', sent([a.wallet, '0.999999'])))).toEqual([422, 'payout_not_sent']);
    // A transfer to A, pasted for B, does not mark B paid.
    const toA = sent([a.wallet, '1']);
    expect(await code(await pay(b.wallet, '1', toA))).toEqual([422, 'payout_not_sent']);
    expect((await pay(a.wallet, '1', toA)).statusCode).toBe(200);
    // One transaction paying both is recorded once for each.
    const batch = sent([a.wallet, '0.5'], [b.wallet, '1']);
    expect((await pay(a.wallet, '0.5', batch)).statusCode).toBe(200);
    expect((await pay(b.wallet, '1', batch)).statusCode).toBe(200);
    expect(await code(await pay(b.wallet, '0.5', batch))).toEqual([409, 'payout_recorded']);
    expect([(await summary(a.cookie)).pendingUsd, (await summary(b.cookie)).pendingUsd]).toEqual(['0.5', '1']);
  });
});
