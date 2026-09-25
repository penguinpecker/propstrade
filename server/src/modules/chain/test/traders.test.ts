// The public trader lookup (GET /v1/traders/:address) through the real app on a real Postgres: sim accounts from a
// stand-in sim service, the funded account and its payouts from the chain module's own tables and a stand-in RPC.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import type { AccountDetail, ClosedTrade, Position, TraderLookup } from '@props/shared';
import { PROPS_VAULT_PROGRAM_ID, USDC_MINT, ownerUsdcAddress } from '@props/sdk';
import { buildApp } from '../../../app.ts';
import { loadConfig } from '../../../config.ts';
import { accounts, closedTrades, evaluations, fundedAccounts, kycRequests, payouts, users } from '../../../db/schema.ts';
import { TOKEN_PROGRAM_ID } from '../../../lib/solana.ts';
import { createStreamHub } from '../../../stream.ts';
import { APP_ORIGIN, signIn } from '../../../../test/helpers.ts';
import type { ModuleContext, SimService } from '../../types.ts';
import { createChain } from '../index.ts';
import { TEST_SESSION_SECRET, encodeAccount, freshDb, offlineClient, simStub } from './support.ts';

const client = offlineClient();
const key = () => Keypair.generate().publicKey;
const alice = Keypair.generate();
const trader = alice.publicKey.toBase58();
const chainAccounts = new Map<string, AccountInfo<Buffer>>();
const info = (owner: PublicKey, data: Buffer, lamports = 1_000_000): AccountInfo<Buffer> => ({ owner, data, lamports, executable: false, rentEpoch: 0 });
const rpc = {
  commitment: 'confirmed', rpcEndpoint: 'http://stand-in',
  async getAccountInfo(k: PublicKey) { return chainAccounts.get(k.toBase58()) ?? null; },
  async getMultipleAccountsInfo(keys: PublicKey[]) { return keys.map((k) => chainAccounts.get(k.toBase58()) ?? null); },
  async getMultipleAccountsInfoAndContext(keys: PublicKey[]) { return { context: { slot: 42 }, value: keys.map((k) => chainAccounts.get(k.toBase58()) ?? null) }; },
  async getProgramAccounts() { return []; },
  async getTransaction() { return null; },
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
const fundedData = (evaluation: PublicKey) => encodeAccount(client, 'fundedAccount', {
  trader: alice.publicKey, evaluation,
  terms: { sizeUsd: new BN(10_000_000_000), profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000, termsHash: Array(32).fill(1), tierVersion: 1 },
  principal: new BN(500_000_000), status: { active: {} }, slots: Array(8).fill(free), orders: Array(8).fill(freeOrder),
  orderSeq: new BN(0), payoutsPaid: new BN(0), payoutSeq: 1, createdAt: new BN(0), lastSyncAt: new BN(0), bump: 255, ownerBump: 255,
});

const ids = { evaluation: key().toBase58(), funded: key().toBase58(), owner: key().toBase58(), paid: key().toBase58(), requested: key().toBase58() };
const practice = `practice:${trader}`;
const position: Position = {
  id: 'p1', symbol: 'SOL', side: 'Long', sizeUsd: '1000', sizeTokens: '8.4', collateralUsd: '100', leverage: 10, entryPrice: '118.5', markPrice: '119',
  liquidationPrice: '108', unrealizedPnl: '3.2', pendingFeesUsd: '1.3', pendingBorrowUsd: '0.2', pendingFundingUsd: '0.1', closeFeeUsd: '1', closing: false,
  takeProfit: null, stopLoss: null, openedAt: 1, venue: 'simulated',
};
const trade = (id: string, closedAt: number, venue: ClosedTrade['venue']): ClosedTrade => ({
  id, symbol: 'SOL', side: 'Long', openedAt: closedAt - 1_000, closedAt, sizeUsd: '1000', entryPrice: '118', exitPrice: '119',
  feesUsd: '2.5', orderFeesUsd: '2', fundingUsd: '0.3', borrowUsd: '0.2', priceImpactUsd: '-0.05', netPnl: '5.9', venue, signatures: [],
});
const detail = (id: string, stage: AccountDetail['stage'], equity: string, positions: Position[]): AccountDetail => ({
  id, stage, status: 'active', label: stage, shortId: 'PT-x', equity, realizedPnl: '0', unrealizedPnl: '0', allowanceRemaining: '0', availableMargin: '0',
  openNotional: '0', targetProgressPct: null, eligiblePayout: null, createdAt: 1_700_000_000_000, activatedAt: null, resolvedAt: null, evidence: {}, freshness: 'live',
  rules: { sizeUsd: stage === 'practice' ? '25000' : '10000', lossAllowanceUsd: '1250', floorUsd: '23750', profitTargetUsd: null, maxExposureUsd: '25000', traderShareBps: 8000, drawdownType: 'static', includesOpenPnl: true, dailyLossLimit: null, timeLimit: null, termsHash: null, version: null },
  positions, orders: [],
} as AccountDetail);
const simDetails: Record<string, AccountDetail> = {
  [practice]: detail(practice, 'practice', '25003.2', [position]),
  [ids.evaluation]: detail(ids.evaluation, 'evaluation', '10100', []),
};
const simTrades: Record<string, ClosedTrade[]> = { [practice]: [trade('t-old', 1_700_000_100_000, 'simulated')], [ids.evaluation]: [trade('t-new', 1_700_000_300_000, 'simulated')] };
// The stand-in sim answers the trader's own accounts by id, as the engine's reader does (undefined for anyone else).
const limits: (number | undefined)[] = []; // the cap each history read was asked for
const sim: SimService = {
  ...simStub().sim,
  async detail(wallet, id) { return wallet === trader ? simDetails[id] : undefined; },
  async history(wallet, id, limit) { limits.push(limit); return wallet === trader && simDetails[id] ? simTrades[id] : undefined; },
};

let t: Awaited<ReturnType<typeof freshDb>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let chain: Awaited<ReturnType<typeof createChain>>;
before(async () => {
  t = await freshDb('chain_traders');
  const config = loadConfig({
    DATABASE_URL: t.url, APP_ORIGIN, SESSION_SECRET: TEST_SESSION_SECRET, ADMIN_API_TOKEN: randomBytes(32).toString('hex'), RPC_URL: 'http://127.0.0.1:1',
    PROGRAM_ID: PROPS_VAULT_PROGRAM_ID.toBase58(), SOLANA_CLUSTER: 'mainnet-beta', TRUST_PROXY_HOPS: '0',
  });
  const hub = createStreamHub();
  app = await buildApp({ config, db: t.db, sql: t.sql, hub, modules: new Map(), rpc: rpc as never, logger: false });
  const stopped = new AbortController();
  stopped.abort(); // routes only: no leader loops
  const ctx: ModuleContext = {
    app, log: app.log, env: {}, publish: hub.publish, services: { sim }, signal: stopped.signal, config, db: t.db, sql: t.sql, rpc: rpc as never, notify: async () => {},
  };
  chain = await createChain(ctx);
  await app.ready();

  await signIn(app, alice); // a users row, which the identity request below needs
  await t.db.insert(kycRequests).values({ wallet: trader, country: 'DE', region: 'DE-BY', status: 'approved', identityHash: 'ab'.repeat(32), reason: 'ok', reviewedAt: new Date() });
  await t.db.insert(evaluations).values({
    address: ids.evaluation, trader, evalIndex: 0, tierId: 1, sizeUsd: '10000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000,
    traderShareBps: 8000, termsHash: 'ab'.repeat(32), feePaid: '79', status: 'funded', purchaseSignature: 'purchaseSig', createdAt: new Date(), updatedSlot: 1,
  });
  await t.db.insert(fundedAccounts).values({
    address: ids.funded, evaluation: ids.evaluation, trader, ownerPda: ids.owner, principal: '500', traderShareBps: 8000, status: 'active',
    activationSignature: 'activationSig', createdAt: new Date(), updatedSlot: 2,
  });
  const base = { wallet: trader, sizeUsd: '10000', lossAllowanceUsd: '500', maxExposureBps: 10_000, traderShareBps: 8000 };
  await t.db.insert(accounts).values([
    { ...base, id: practice, stage: 'practice', status: 'active', label: 'Practice account', sizeUsd: '25000', lossAllowanceUsd: '1250', traderShareBps: 0, createdAt: new Date(1) },
    { ...base, id: `${practice}:123`, stage: 'practice', status: 'breached', label: 'Practice account', resolvedAt: new Date(), createdAt: new Date(2) }, // archived
    { ...base, id: ids.evaluation, stage: 'evaluation', status: 'passed', label: 'Evaluation 10K', evaluation: ids.evaluation, createdAt: new Date(3) },
    { ...base, id: ids.funded, stage: 'funded', status: 'active', label: 'Funded 10K', evaluation: ids.evaluation, funded: ids.funded, activatedAt: new Date(), createdAt: new Date(4) },
  ]);
  const payout = (address: string, seq: number, status: 'requested' | 'paid') => ({
    address, fundedAccount: ids.funded, seq, status, balanceAtRequest: '600', profit: '100', traderAmount: '80', vaultAmount: '20', destination: trader,
    requestSignature: `request${seq}`, requestedAt: new Date(1_700_000_000_000 + seq), reviewNote: 'held: opposite position elsewhere',
    ...(status === 'paid' ? { paySignature: 'paySig', resolvedAt: new Date(1_700_000_010_000) } : {}),
  });
  await t.db.insert(payouts).values([payout(ids.paid, 0, 'paid'), payout(ids.requested, 1, 'requested')]);
  await t.db.insert(closedTrades).values({
    id: '11111111-1111-4111-8111-111111111111', accountId: ids.funded, symbol: 'SOL', side: 'Short', venue: 'gmtrade', openedAt: new Date(1_700_000_190_000),
    closedAt: new Date(1_700_000_200_000), sizeUsd: '2000', entryPrice: '120', exitPrice: '119', feesUsd: '3.6', orderFeesUsd: '2.4', fundingUsd: '0.7',
    borrowUsd: '0.5', priceImpactUsd: '0.1', netPnl: '13.1', signatures: ['sig1'],
  });
  chainAccounts.set(ids.funded, info(PROPS_VAULT_PROGRAM_ID, fundedData(new PublicKey(ids.evaluation))));
  chainAccounts.set(ownerUsdcAddress(new PublicKey(ids.funded)).toBase58(), usdcAccount(new PublicKey(ids.owner), 520_000_000n));
});
after(async () => {
  await app.close();
  await t.sql.end();
});

const lookup = async (address: string) => {
  const res = await app.inject({ method: 'GET', url: `/v1/traders/${encodeURIComponent(address)}` });
  return { status: res.statusCode, body: res.json() as TraderLookup & { error?: { code: string } }, headers: res.headers };
};
/** Every key anywhere in a JSON value. */
const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
};

test('a trader by wallet: accounts at every stage, open positions, the last 50 trades newest first, payouts; public, cached briefly', async () => {
  const { status, body, headers } = await lookup(trader);
  assert.equal(status, 200);
  assert.equal(headers['cache-control'], 'public, s-maxage=5');
  assert.equal(body.address, trader);
  assert.deepEqual(body.accounts.map((a) => [a.id, a.stage, a.status, a.sizeUsd, a.equityUsd]), [
    [practice, 'practice', 'active', '25000', '25003.2'], [ids.evaluation, 'evaluation', 'active', '10000', '10100'], [ids.funded, 'funded', 'active', '10000', '10020'],
  ], 'the live practice account, the evaluation and the funded account (520 USDC flat: 10,000 − 500 + 520); the archived practice account is not listed');
  assert.ok(body.accounts.every((a) => typeof a.createdAt === 'number'));
  assert.deepEqual(body.positions, [position]);
  assert.deepEqual(body.trades.map((x) => [x.id, x.venue, x.orderFeesUsd, x.fundingUsd, x.borrowUsd, x.priceImpactUsd]), [
    ['t-new', 'simulated', '2', '0.3', '0.2', '-0.05'], ['11111111-1111-4111-8111-111111111111', 'gmtrade', '2.4', '0.7', '0.5', '0.1'], ['t-old', 'simulated', '2', '0.3', '0.2', '-0.05'],
  ]);
  assert.deepEqual(body.payouts.map((p) => [p.id, p.status, p.amountUsd, p.paidAt, p.signature]), [
    [ids.requested, 'requested', '80', null, null], [ids.paid, 'paid', '80', 1_700_000_010_000, 'paySig'],
  ]);
  // Nothing identifying travels: no residence, identity hash, review note or the like anywhere in the answer.
  const keys = [...keysOf(body)];
  assert.deepEqual(keys.filter((k) => /kyc|identity|country|region|review|reason|destination|wallet/i.test(k)), [], keys.join(' '));
});

test('an evaluation or funded account address resolves to its trader; a signed-in wallet without accounts is empty; unknown → 404, malformed → 400', async () => {
  for (const address of [ids.funded, ids.evaluation]) {
    const { status, body } = await lookup(address);
    assert.deepEqual([status, body.address, body.accounts.length, body.payouts.length], [200, trader, 3, 2], address);
  }
  const bob = Keypair.generate();
  await signIn(app, bob);
  const empty = await lookup(bob.publicKey.toBase58());
  assert.deepEqual([empty.status, empty.body], [200, { address: bob.publicKey.toBase58(), accounts: [], positions: [], trades: [], payouts: [] }]);
  const unknown = await lookup(key().toBase58());
  assert.deepEqual([unknown.status, unknown.body.error?.code], [404, 'unknown_trader']);
  for (const bad of ['not-an-address', 'PT-1234', '0'.repeat(50)]) {
    const r = await lookup(bad);
    assert.deepEqual([r.status, r.body.error?.code], [400, 'bad_request'], bad);
  }
});

test('each account contributes only its newest 50 trades: the lookup asks every provider for that many, and the funded read honours it', async () => {
  limits.length = 0;
  await lookup(trader);
  assert.deepEqual(limits, [50, 50], 'the practice and evaluation reads were capped');
  const older = (id: string, closedAt: number) => ({
    id, accountId: ids.funded, symbol: 'SOL', side: 'Long' as const, venue: 'gmtrade' as const, openedAt: new Date(closedAt - 10_000), closedAt: new Date(closedAt),
    sizeUsd: '100', entryPrice: '100', exitPrice: '101', feesUsd: '0.2', orderFeesUsd: '0.2', fundingUsd: '0', borrowUsd: '0', priceImpactUsd: '0', netPnl: '0.8', signatures: [],
  });
  await t.db.insert(closedTrades).values([older('22222222-2222-4222-8222-222222222222', 1_700_000_150_000), older('33333333-3333-4333-8333-333333333333', 1_700_000_100_000)]);
  assert.deepEqual((await chain.funded.history(trader, ids.funded, 2))!.map((x) => x.id), ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'], 'the two newest');
  assert.equal((await chain.funded.history(trader, ids.funded))!.length, 3, "uncapped for the owner's own pages");
});

test('the lookup is rate-limited per client like the other public routes', async () => {
  let limited = 0;
  for (let i = 0; i < 61 && !limited; i++) if ((await lookup('not-an-address')).status === 429) limited = i;
  assert.ok(limited > 0 && limited <= 60, `limited after ${limited} requests`);
  const r = await lookup(trader);
  assert.deepEqual([r.status, r.body.error?.code], [429, 'rate_limited']);
});
