// Referral program (src/routes/referrals.ts): codes, the binding rules, rewards per Props fee charged on a funded order,
// the summary and the operator routes. Rewards are written when the indexer applies a settlement's OrderFeesSettled
// (src/modules/chain/projector.ts): these tests record settlements as the keeper sends them and project their events
// as the indexer does, or run the indexer itself over one.
import { randomBytes } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseFixed } from '@props/gmtrade';
import { PROPS_VAULT_PROGRAM_ID } from '@props/sdk';
import type { ReferralSummary } from '@props/shared';
import {
  accounts, adminAuditLog, evaluations, fundedAccounts, gmOrders, kycRequests, orderFees, orderFeeSettlements, referralPayouts, referralRewards,
  simFills, users, venueFills,
} from '../src/db/schema.js';
import { recordSettlement } from '../src/modules/chain/fees.js';
import { createIndexer } from '../src/modules/chain/indexer.js';
import { project, type ProjectDeps } from '../src/modules/chain/projector.js';
import { offlineClient, programTx, silentLog } from '../src/modules/chain/test/support.js';
import { accrueReferralRewards, assignReferralCode, backfillReferralCodes } from '../src/routes/referrals.js';
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
/** A funded account of `trader`, as the indexer records it at activation. */
async function fundedAccount(trader: string) {
  const [address, from] = [key(), await evaluation(trader, 'funded')];
  await t.db.insert(fundedAccounts).values({
    address, evaluation: from, trader, ownerPda: key(), principal: '500', traderShareBps: 8000, status: 'active',
    activationSignature: 'activation', createdAt: new Date(), updatedSlot: 2,
  });
  await t.db.insert(accounts).values({
    id: address, wallet: trader, stage: 'funded', status: 'active', label: 'Funded 10K', evaluation: from, funded: address, sizeUsd: '10000',
    lossAllowanceUsd: '500', maxExposureBps: 10_000, traderShareBps: 8000,
  });
  return address;
}
/** Fills of a funded account, [size] in USD each, as the venue loop indexes them: the referees' funded volume. */
async function filled(funded: string, sizes: string[]) {
  await t.db.insert(venueFills).values(sizes.map((sizeUsd) => ({
    signature: key(), eventIndex: 0, venueId: `${String(++seq).padStart(12, '0')}-${key().slice(0, 8)}-000001-000001-000000`, slot: seq,
    fundedAccount: funded, position: key(), order: key(), symbol: 'SOL', side: 'Long' as const, isIncrease: true, sizeUsd, sizeAfterUsd: sizeUsd,
    price: '150', feeUsd: '1', priceImpactUsd: '0', fundingUsd: '0', borrowUsd: '0', realizedPnl: null, ts: new Date(),
  })));
}
/** Executed orders of a funded account whose Props fees are due, [symbol, assessed USD] each, as the indexer leaves them. */
async function dueOrders(funded: string, fees: [symbol: string, assessedUsd: string][]) {
  const orders = fees.map(() => key());
  await t.db.insert(gmOrders).values(fees.map(([symbol], i) => ({
    address: orders[i]!, fundedAccount: funded, marketToken: key(), symbol, side: 'Long' as const, kind: 'Market' as const, isIncrease: true,
    sizeUsd: '1000', status: 'executed' as const, createSignature: 'create', createdAt: new Date(),
  })));
  await t.db.insert(orderFees).values(fees.map(([, assessedUsd], i) => ({
    order: orders[i]!, fundedAccount: funded, isIncrease: true, assessedUsd, rateUsd: '2', rateBps: 10, state: 'due' as const,
    dueAt: new Date(Date.now() - 60_000 + i), updatedSlot: 3,
  })));
  return orders;
}
const micro = (usd: string) => parseFixed(usd, 6);
const noReader = {} as ProjectDeps['reader']; // a settlement's projection reads nothing onchain
/**
 * The account's OrderFeesSettled projected as the indexer does, in its own transaction, at REFERRAL_REWARD_BPS `bps`
 * (`eventIndex`: its place among its transaction's events).
 */
const indexed = (funded: string, sig: string, charged: bigint, waived: bigint, bps = 1000, eventIndex = 0) => t.db.transaction((tx) => project(tx, {
  name: 'orderFeesSettled',
  data: { funded, charged: String(charged), waived: String(waived), orderFeesDue: '0', orderFeesPaid: String(charged), by: key(), ts: String(Math.floor(Date.now() / 1000)) },
}, eventIndex, { signature: sig, slot: ++seq, fee: 5_000n }, { reader: noReader, referralRewardBps: bps }));
/**
 * The keeper's settlement of a funded account, [order, charge, waive] in USD per order: recorded with its signature as it
 * is sent (against the settlements the account has had), then confirmed by its indexed event, unless it never lands.
 */
async function settle(funded: string, shares: [order: string, chargeUsd: string, waiveUsd?: string][], o: { bps?: number; lands?: boolean } = {}) {
  const allocations = shares.map(([order, charge, waive = '0']) => ({ order, charge: micro(charge), waive: micro(waive) }));
  const plan = { charge: allocations.reduce((s, a) => s + a.charge, 0n), waive: allocations.reduce((s, a) => s + a.waive, 0n), allocations };
  const [landed] = await t.db.select({ n: count() }).from(orderFeeSettlements)
    .where(and(eq(orderFeeSettlements.fundedAccount, funded), eq(orderFeeSettlements.status, 'confirmed')));
  const sig = signature();
  await recordSettlement(t.db, {
    signature: sig, funded, plan, expectedDue: plan.charge + plan.waive, expectedSettlements: BigInt(landed!.n), sentBy: 'keeper', lastValidBlockHeight: 1,
  });
  if (o.lands !== false) await indexed(funded, sig, plan.charge, plan.waive, o.bps);
  return sig;
}
/** A funded account of `trader` whose executed orders one settlement charged these Props fees (USD); its address. */
async function charged(trader: string, fees: string[]) {
  const funded = await fundedAccount(trader);
  const orders = await dueOrders(funded, fees.map((fee) => ['SOL', fee]));
  await settle(funded, orders.map((order, i) => [order, fees[i]!]));
  return funded;
}
const rewardsOf = (referee: string) => t.db.select().from(referralRewards).where(eq(referralRewards.referee, referee)).orderBy(referralRewards.id);

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
  it('each funded order a settlement charges earns the referrer the rate of the Props fee charged, rounded down, once the chain confirms it', async () => {
    const referrer = await signIn(t.app);
    const trader = await referredBy(referrer.wallet.slice(0, 8));
    const funded = await fundedAccount(trader.wallet);
    const [sol, btc] = await dueOrders(funded, [['SOL', '12.2'], ['BTC', '2.000009']]);
    // The keeper's first attempt never lands (its blockhash expires); the retry, against the same count, does.
    await settle(funded, [[sol!, '12.2'], [btc!, '2.000009']], { lands: false });
    expect(await rewardsOf(trader.wallet)).toEqual([]);
    const sig = await settle(funded, [[sol!, '12.2'], [btc!, '2.000009']]);
    const rows = await rewardsOf(trader.wallet);
    expect(rows.map((r) => [r.referrer, r.order, r.fundedAccount, r.settlementSignature, r.symbol, r.feeUsd, r.rateBps, r.rewardUsd])).toEqual([
      [referrer.wallet, sol, funded, sig, 'SOL', '12.200000', 1000, '1.220000'],
      [referrer.wallet, btc, funded, sig, 'BTC', '2.000009', 1000, '0.200000'],
    ]);
    // The same shares accrued again (a settlement applied twice) add nothing: one reward per order and settlement.
    await t.db.transaction((tx) => accrueReferralRewards(tx, { signature: sig, eventIndex: 0, funded, shares: [{ order: sol!, charge: 12_200_000n }] }, 1000));
    expect(await rewardsOf(trader.wallet)).toHaveLength(2);
  });

  it('an order charged in parts earns on each part its settlement charged', async () => {
    const referrer = await signIn(t.app);
    const trader = await referredBy(referrer.wallet.slice(0, 8));
    const funded = await fundedAccount(trader.wallet);
    const [order] = await dueOrders(funded, [['SOL', '10.5']]);
    // The account's USDC covered 4 USDC of the fee; the rest stayed due until a later settlement charged it.
    const [first, second] = [await settle(funded, [[order!, '4']]), await settle(funded, [[order!, '6.5']])];
    expect((await rewardsOf(trader.wallet)).map((r) => [r.settlementSignature, r.feeUsd, r.rewardUsd])).toEqual([[first, '4.000000', '0.400000'], [second, '6.500000', '0.650000']]);
  });

  it('waived fees earn nothing: the waived part of a charge, or a fee only waived', async () => {
    const referrer = await signIn(t.app);
    const trader = await referredBy(referrer.wallet.slice(0, 8));
    const funded = await fundedAccount(trader.wallet);
    // A take profit charged 1.7 of its 2.5 assessment (the rest waived) and a stop loss the exchange cancelled (waived).
    const [tp, sl] = await dueOrders(funded, [['SOL', '2.5'], ['SOL', '2.5']]);
    await settle(funded, [[tp!, '1.7', '0.8'], [sl!, '0', '2.5']]);
    expect((await rewardsOf(trader.wallet)).map((r) => [r.order, r.feeUsd, r.rewardUsd])).toEqual([[tp, '1.700000', '0.170000']]);
    await settle(funded, [[(await dueOrders(funded, [['ETH', '3']]))[0]!, '0', '3']]);
    expect(await rewardsOf(trader.wallet)).toHaveLength(1);
  });

  it('a trader no one referred and a zero rate earn nothing', async () => {
    const loner = await signIn(t.app);
    await charged(loner.wallet, ['5']);
    const referrer = await signIn(t.app);
    const trader = await referredBy(referrer.wallet.slice(0, 8));
    const funded = await fundedAccount(trader.wallet);
    const [order] = await dueOrders(funded, [['SOL', '5']]);
    await settle(funded, [[order!, '5']], { bps: 0 });
    expect(await t.db.select().from(referralRewards).where(sql`${referralRewards.referee} in (${loner.wallet}, ${trader.wallet})`)).toEqual([]);
  });

  it('a settlement this server did not send (the risk-key fallback script) earns on the charges it is spread over', async () => {
    const referrer = await signIn(t.app);
    const trader = await referredBy(referrer.wallet.slice(0, 8));
    const funded = await fundedAccount(trader.wallet);
    const [older, newer] = await dueOrders(funded, [['SOL', '2.5'], ['ETH', '1.5']]);
    // 3 charged and 1 waived over the due orders oldest first: the older one's 2.5, then 0.5 of the newer one.
    await indexed(funded, signature(), 3_000_000n, 1_000_000n);
    expect((await rewardsOf(trader.wallet)).map((r) => [r.order, r.feeUsd, r.rewardUsd])).toEqual([[older, '2.500000', '0.250000'], [newer, '0.500000', '0.050000']]);
  });

  it('a charge settled once the account breached earns nothing: its USDC all returns to the capital vault, so the charge only moved Props\' own capital', async () => {
    const referrer = await signIn(t.app);
    const trader = await referredBy(referrer.wallet.slice(0, 8));
    const funded = await fundedAccount(trader.wallet);
    // The trader's close executed; the account then breached, and the keeper settled the close's fee afterwards.
    const [close] = await dueOrders(funded, [['SOL', '2.5']]);
    await t.db.transaction((tx) => project(tx, { name: 'accountBreached', data: { funded, ts: String(Math.floor(Date.now() / 1000)) } }, 0,
      { signature: signature(), slot: ++seq, fee: 5_000n }, { reader: noReader, referralRewardBps: 1000 }));
    await settle(funded, [[close!, '2.5']]);
    expect(await rewardsOf(trader.wallet)).toEqual([]);
    const [fee] = await t.db.select().from(orderFees).where(eq(orderFees.order, close!));
    expect(fee!.chargedUsd).toBe('2.500000'); // charged and in the ledger all the same: only the reward is withheld
  });

  it('a charge in the transaction that closes the account earns nothing, whatever its status was: its USDC returns to Props with it', async () => {
    const referrer = await signIn(t.app);
    const trader = await referredBy(referrer.wallet.slice(0, 8));
    const funded = await fundedAccount(trader.wallet);
    const [order] = await dueOrders(funded, [['SOL', '2.5']]);
    // The operators' close job on an active account: [settle_order_fees, close_funded] in one transaction.
    const [sig, now] = [signature(), Math.floor(Date.now() / 1000)];
    await recordSettlement(t.db, {
      signature: sig, funded, plan: { charge: 2_500_000n, waive: 0n, allocations: [{ order: order!, charge: 2_500_000n, waive: 0n }] },
      expectedDue: 2_500_000n, expectedSettlements: 0n, sentBy: 'close_funded job', lastValidBlockHeight: 1,
    });
    const tx = programTx(offlineClient(), [
      ['orderFeesSettled', {
        funded: new PublicKey(funded), charged: new BN(2_500_000), waived: new BN(0), orderFeesDue: new BN(0), orderFeesPaid: new BN(2_500_000),
        by: Keypair.generate().publicKey, ts: new BN(now),
      }],
      ['accountClosed', { funded: new PublicKey(funded), principal: new BN(500_000_000), usdcReturned: new BN(497_500_000), lamportsReturned: new BN(0), ts: new BN(now) }],
    ]);
    const rpc = {
      getSignaturesForAddress: async () => [{ signature: sig, slot: ++seq, err: null, memo: null, blockTime: now }],
      getTransaction: async () => ({ slot: seq, blockTime: now, transaction: tx.transaction, meta: { ...tx.meta, err: null, fee: 5_000 } }),
      onLogs: () => 0, removeOnLogsListener: async () => {},
    };
    await createIndexer({
      db: t.db, rpc: rpc as never, client: offlineClient(), programId: PROPS_VAULT_PROGRAM_ID, log: silentLog, reader: noReader,
      notify: async () => {}, onApplied() {}, referralRewardBps: 1000,
    }).catchUp();
    expect(await rewardsOf(trader.wallet)).toEqual([]);
    const [settlement] = await t.db.select().from(orderFeeSettlements).where(eq(orderFeeSettlements.signature, sig));
    const [fee] = await t.db.select().from(orderFees).where(eq(orderFees.order, order!));
    expect([settlement!.status, fee!.chargedUsd]).toEqual(['confirmed', '2.500000']);
  });

  it('an account settled twice in one hand-built transaction earns on both charges, and on neither twice', async () => {
    const referrer = await signIn(t.app);
    const trader = await referredBy(referrer.wallet.slice(0, 8));
    const funded = await fundedAccount(trader.wallet);
    await dueOrders(funded, [['SOL', '3']]);
    const sig = signature();
    await indexed(funded, sig, 1_000_000n, 0n, 1000, 0);
    await indexed(funded, sig, 2_000_000n, 0n, 1000, 1);
    // Projected again past program_events (a bug): refused whole (its vault ledger entry exists), so nothing is earned twice.
    await expect(indexed(funded, sig, 2_000_000n, 0n, 1000, 1)).rejects.toThrow();
    expect((await rewardsOf(trader.wallet)).map((r) => [r.feeUsd, r.rewardUsd])).toEqual([['1.000000', '0.100000'], ['2.000000', '0.200000']]);
  });

  it('the indexer reading a settlement\'s transaction again (a duplicate delivery, a restart) adds no second reward', async () => {
    const referrer = await signIn(t.app);
    const trader = await referredBy(referrer.wallet.slice(0, 8));
    const funded = await fundedAccount(trader.wallet);
    const [order] = await dueOrders(funded, [['ETH', '2.5']]);
    const [sig, now] = [signature(), Math.floor(Date.now() / 1000)];
    const tx = programTx(offlineClient(), [['orderFeesSettled', {
      funded: new PublicKey(funded), charged: new BN(2_500_000), waived: new BN(0), orderFeesDue: new BN(0), orderFeesPaid: new BN(2_500_000),
      by: Keypair.generate().publicKey, ts: new BN(now),
    }]]);
    // A node that lists the settlement's transaction on every read.
    const rpc = {
      getSignaturesForAddress: async () => [{ signature: sig, slot: ++seq, err: null, memo: null, blockTime: now }],
      getTransaction: async () => ({ slot: seq, blockTime: now, transaction: tx.transaction, meta: { ...tx.meta, err: null, fee: 5_000 } }),
      onLogs: () => 0, removeOnLogsListener: async () => {},
    };
    const indexer = () => createIndexer({
      db: t.db, rpc: rpc as never, client: offlineClient(), programId: PROPS_VAULT_PROGRAM_ID, log: silentLog, reader: noReader,
      notify: async () => {}, onApplied() {}, referralRewardBps: 1000,
    });
    expect(await indexer().catchUp()).toBe(1);
    expect(await indexer().catchUp()).toBe(1); // read again after a restart: its events are stored already, nothing is applied twice
    expect((await rewardsOf(trader.wallet)).map((r) => [r.order, r.settlementSignature, r.feeUsd, r.rewardUsd])).toEqual([[order, sig, '2.500000', '0.250000']]);
  });
});

describe('summary', () => {
  it('counts referees, those with an evaluation and those funded, the funded volume, what was earned, paid and is owed, and the latest 50 rewards', async () => {
    const referrer = await signIn(t.app);
    const code = referrer.wallet.slice(0, 8);
    const [idle, evaluating, trading] = [await referredBy(code), await referredBy(code), await referredBy(code)];
    // A simulated evaluation earns nothing, whatever its fills paid (the exchange's fee and the simulated Props fee).
    const simulated = await evaluation(evaluating.wallet);
    await t.db.insert(accounts).values({
      id: simulated, wallet: evaluating.wallet, stage: 'evaluation', status: 'active', label: 'Evaluation 10K', evaluation: simulated, sizeUsd: '10000',
      lossAllowanceUsd: '500', maxExposureBps: 10_000, traderShareBps: 8000,
    });
    await t.db.insert(simFills).values({
      accountId: simulated, symbol: 'SOL', side: 'Long', isIncrease: true, sizeUsd: '50000', price: '150', feeUsd: '25', priceImpactUsd: '0',
      fundingUsd: '0', borrowUsd: '0', platformFeeUsd: '52', tickTs: new Date(),
    });
    const funded = await charged(trading.wallet, Array.from({ length: 51 }, () => '2.05')); // $2 + 0.1 % of $50, 51 times
    await filled(funded, Array.from({ length: 51 }, (_, i) => String(100 + i)));
    await filled(await fundedAccount((await signIn(t.app)).wallet), ['99999']); // someone else's trader
    await verified(referrer.wallet);
    const paid = await admin('POST', '/v1/admin/referrals/payouts', { referrer: referrer.wallet, amountUsd: '0.1', signature: sent([referrer.wallet, '0.1']) });
    expect(paid.statusCode).toBe(200);

    const s = await summary(referrer.cookie);
    expect(s).toMatchObject({
      code: code.toUpperCase(), referredBy: null, rewardBps: 1000, referees: 3, refereesWithEvaluation: 2, refereesFunded: 1,
      fundedVolumeUsd: String(51 * 100 + (50 * 51) / 2), earnedUsd: '10.455', paidUsd: '0.1', pendingUsd: '10.355',
    });
    expect(s.recent).toHaveLength(50);
    // The referee's wallet is masked: enough to tell referees apart, not to follow one onchain.
    expect(s.recent[0]).toEqual({ at: expect.any(Number), referee: `${trading.wallet.slice(0, 4)}…${trading.wallet.slice(-4)}`, symbol: 'SOL', feeUsd: '2.05', rewardUsd: '0.205' });
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
    await charged(a.wallet, ['3']); // $2 + 0.1 % of $1,000
    const [b, c] = [await referredBy(large.wallet.slice(0, 8)), await referredBy(large.wallet.slice(0, 8))];
    await charged(b.wallet, ['12', '12']); // $2 + 0.1 % of $10,000, twice
    await charged(c.wallet, ['12']);
    await verified(large.wallet);
    expect((await admin('POST', '/v1/admin/referrals/payouts', { referrer: large.wallet, amountUsd: '1', signature: sent([large.wallet, '1']) })).statusCode).toBe(200);

    const res = await admin('GET', '/v1/admin/referrals?limit=500');
    expect(res.statusCode).toBe(200);
    const rows = (res.json() as { referrer: string }[]).filter((r) => [small.wallet, large.wallet].includes(r.referrer));
    expect(rows).toEqual([
      { referrer: large.wallet, code: large.wallet.slice(0, 8).toUpperCase(), referees: 2, earnedUsd: '3.6', paidUsd: '1', pendingUsd: '2.6' },
      { referrer: small.wallet, code: small.wallet.slice(0, 8).toUpperCase(), referees: 1, earnedUsd: '0.3', paidUsd: '0', pendingUsd: '0.3' },
    ]);
    expect((await admin('GET', '/v1/admin/referrals', undefined, 'x'.repeat(64))).statusCode).toBe(401);
  });

  it('record a payout up to what is owed, in the audit log; refuse more, a bad amount or signature, an unknown referrer and a repeat', async () => {
    const referrer = await signIn(t.app);
    const trader = await referredBy(referrer.wallet.slice(0, 8));
    await charged(trader.wallet, ['20']); // earns 2
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
    await charged(trader.wallet, ['20']);
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
      await charged(trader.wallet, ['20']); // earns 2
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
