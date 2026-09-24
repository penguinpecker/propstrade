// The keeper against a real solana-test-validator (mainnet GMTrade binary + cloned accounts, props_vault deployed;
// ports 28899/28900) and a real Postgres, with the chain module indexing everything it does. GMTrade keepers do not
// run locally, so the position the session guard closes is placed at genesis as a GMTrade fill would leave it, and
// the keeper's close order stays pending. Market data is stubbed to call SOL a US stock 12 minutes before an NYSE close.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, type Connection } from '@solana/web3.js';
import { and, count, eq } from 'drizzle-orm';
import postgres from 'postgres';
import type { FastifyBaseLogger } from 'fastify';
import type { Market, Notification } from '@props/shared';
import {
  GMTRADE_PROGRAM_ID, GMTRADE_STORE, PropsVaultClient, USDC_MINT, enumName, evaluationPda, fundedPda, ownerPda, ownerUsdcAddress,
  solTreasuryPda, toUnitPrice,
} from '@props/sdk';
import { model, type ModelInput } from '@props/gmsol-wasm';
import { buildApp } from '../../../app.ts';
import { loadConfig } from '../../../config.ts';
import { chainJobs, fundedAccounts, gmOrders, gmtradeDeploys, payouts, programEvents, venueFills } from '../../../db/schema.ts';
import { LOCK_KEYS } from '../../../lib/leader.ts';
import { createConnection } from '../../../lib/solana.ts';
import { createStreamHub } from '../../../stream.ts';
import { APP_ORIGIN } from '../../../../test/helpers.ts';
import { CONFIG_PARAMS, LEVERAGE, MARKETS, TIERS, USD, bn, hash32, marketParams, tierParams, usdc } from '../../../../../tests/program/src/env.ts';
import { sendTx, startValidator, type Validator } from '../../../../../tests/program/src/validator.ts';
import type { MarketDataService, ModuleContext } from '../../types.ts';
import { createChain } from '../../chain/index.ts';
import type { GmIndexer } from '../../chain/venue.ts';
import { freshDb, simStub, until } from '../../chain/test/support.ts';
import { createKeeperModule } from '../index.ts';
import { registerKeeperRoutes } from '../routes.ts';
import { nextSessionClose } from '../sessions.ts';

const hasValidator = (() => {
  try {
    execFileSync('solana-test-validator', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const skip = hasValidator ? false : 'solana-test-validator is not on PATH';

const SOL_INDEX_MINT = new PublicKey('So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH');
const admin = Keypair.generate();
const risk = Keypair.generate();
const kyc = Keypair.generate();
const alice = Keypair.generate();
const bob = Keypair.generate();
const noVenueFills: GmIndexer = { trades: async () => [], signatures: async () => new Map(), removals: async () => [] };
const fundedA = fundedPda(evaluationPda(alice.publicKey, 0));
const fundedB = fundedPda(evaluationPda(bob.publicKey, 0));
const LOCK = LOCK_KEYS.keeper;

/** The SOL[USDC-USDC] mainnet snapshot with its clocks a day ahead, so accrual is a no-op and valuations are exact. */
function solMarket(): ModelInput {
  const f = JSON.parse(readFileSync(new URL('../../../../../packages/gmsol-wasm/test/fixtures/sol-usdc-usdc.json', import.meta.url), 'utf8'));
  const p = (k: string) => ({ min: BigInt(f.prices[k].min), max: BigInt(f.prices[k].max) });
  const market = Buffer.from(f.market, 'base64');
  for (const at of [4024, 4032, 4040]) market.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 86_400), at);
  return { market: market.toString('base64'), virtualInventories: f.virtualInventories, prices: { index: p('index'), long: p('long'), short: p('short') } };
}
const sol = solMarket();

/** Alice's long SOL Position as a GMTrade fill would leave it: $1,000 on $10 collateral (100x), at its PDA. */
function alicePosition() {
  const owner = ownerPda(fundedA);
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('position'), GMTRADE_STORE.toBuffer(), owner.toBuffer(), MARKETS.SOL.token.toBuffer(), USDC_MINT.toBuffer(), Uint8Array.of(1)], GMTRADE_PROGRAM_ID,
  );
  const open = model.simulateIncrease({ market: sol, isLong: true, collateralToken: USDC_MINT.toBase58(), collateralAmount: 10_000_000n, sizeDeltaUsd: 1_000n * USD });
  const data = Buffer.from(open.position.account, 'base64');
  data[9] = bump;
  owner.toBuffer().copy(data, 56);
  return { address, data, size: open.position.sizeInUsd };
}
const seeded = alicePosition();

/** Market data as the keeper sees it: SOL is a US stock whose session is open, priced by the snapshot above. */
let solFreshness: Market['freshness'] = 'live';
/** The keeper runs on a clock shifted to 12 minutes before an NYSE close; its inputs are timed on that clock. */
let clockOffset = 0;
const keeperNow = () => Date.now() + clockOffset;
const marketdata = {
  market: (symbol: string) => (symbol === 'SOL' ? { symbol, category: 'Stocks', session: 'open', freshness: solFreshness, updatedAt: keeperNow() - 25_000 } as Market : undefined),
  marketState: async (marketToken: string) => ({
    symbol: 'SOL', marketToken, indexToken: SOL_INDEX_MINT.toBase58(), pure: true, isClosed: false,
    raw: { market: sol.market, virtualInventories: sol.virtualInventories }, prices: sol.prices, fetchedAt: Date.now(),
  }),
} as unknown as MarketDataService;

let validator: Validator;
let connection: Connection;
let vault: PropsVaultClient;
let t: Awaited<ReturnType<typeof freshDb>>;

before(async () => {
  if (skip) return;
  t = await freshDb('keeper_e2e');
  validator = await startValidator({
    rpcPort: 28899, faucetPort: 29900, gossipPort: 28001, dynamicPortRange: '28002-28040', upgradeAuthority: admin.publicKey,
    usdc: [[admin.publicKey, usdc('2000')], [alice.publicKey, usdc('300')], [bob.publicKey, usdc('500')]],
    mints: [[SOL_INDEX_MINT, 9]],
    accounts: [{ address: seeded.address, owner: GMTRADE_PROGRAM_ID, data: seeded.data, lamports: 5_623_680 }],
  });
  connection = validator.connection;
  vault = new PropsVaultClient(connection);
  for (const k of [admin, risk, kyc, alice, bob]) await connection.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL);
  await connection.requestAirdrop(solTreasuryPda(), 5 * LAMPORTS_PER_SOL);
  await new Promise((r) => setTimeout(r, 1500));
  await send([await vault.initialize({ admin: admin.publicKey, params: CONFIG_PARAMS })], [admin]);
  await send([
    await vault.setAuthorities({ admin: admin.publicKey, riskAuthorities: [risk.publicKey], kycAuthority: kyc.publicKey }),
    await vault.upsertTier({ admin: admin.publicKey, id: TIERS.t10k.id, params: tierParams(TIERS.t10k) }),
    await vault.upsertMarket({ admin: admin.publicKey, marketToken: MARKETS.SOL.token, params: { ...marketParams('SOL', LEVERAGE.crypto), sessionRestricted: true } }),
    await vault.depositCapital({ admin: admin.publicKey, amount: usdc('1000') }),
    await vault.setPauses({ admin: admin.publicKey, paused: { newEvaluations: false, trading: false, payouts: false } }),
  ], [admin]);
});

after(async () => {
  validator?.stop();
  await t?.sql.end();
});

const send = (ixs: Parameters<typeof sendTx>[1], signers: Keypair[]) => sendTx(connection, ixs, signers);
const fresh = async (address: PublicKey) => ({ address, account: (await vault.fetchFunded(address))! });

/** A trader with an active 10K funded account (500 USDC principal). */
async function funded(trader: Keypair, person: string) {
  const evaluation = evaluationPda(trader.publicKey, 0);
  await send([await vault.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t10k.id, index: 0, feeUsdc: usdc(TIERS.t10k.fee), tierVersion: 1 })], [trader]);
  await send([await vault.setIdentity({ kycAuthority: kyc.publicKey, wallet: trader.publicKey, identityHash: hash32(person) })], [kyc]);
  await send([await vault.recordEvaluationResult({ riskAuthority: risk.publicKey, evaluation, passed: true, finalEquity: usdc('10900'), tradesRoot: hash32('fills') })], [risk]);
  await send([await vault.activateFunded({ trader: trader.publicKey, evaluation })], [trader]);
}
const donate = (from: Keypair, to: PublicKey, amount: string) =>
  send([createTransferCheckedInstruction(getAssociatedTokenAddressSync(USDC_MINT, from.publicKey), USDC_MINT, ownerUsdcAddress(to), from.publicKey, usdc(amount), 6)], [from]);

test('keeper against solana-test-validator: top-up, session-guard close with a cancel, sync, payout review, upgrade restrict until acknowledged, lift, leader-lost guard', { skip, timeout: 300_000 }, async () => {
  // ---- Alice: long SOL with all 8 order slots in use (a pending open + 7 TP/SL); Bob: a payout request on 100 USDC
  await funded(alice, 'person-a');
  const open = await vault.openPosition({
    trader: alice.publicKey, funded: await fresh(fundedA), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'market',
    collateral: usdc('20'), sizeDeltaUsd: 100n * USD, acceptablePrice: 10n ** 30n,
  });
  await send([open.instruction], [alice]);
  for (let i = 0; i < 7; i++) {
    const p = await vault.setProtection({
      trader: alice.publicKey, funded: await fresh(fundedA), marketToken: MARKETS.SOL.token, isLong: true,
      orderType: i % 2 ? 'stopLoss' : 'takeProfit', triggerPrice: toUnitPrice(i % 2 ? '50' : '500', 9), sizeDeltaUsd: 10n * USD,
    });
    await send([p.instruction], [alice]);
  }
  await funded(bob, 'person-b');
  await donate(bob, fundedB, '100');
  await send([await vault.requestPayout({ trader: bob.publicKey, funded: fundedB, payoutSeq: 0 })], [bob]);
  // Owner floats below the new minimum, so the keeper must top both up (Bob's once his payout is paid: the program tops
  // up active accounts only).
  await send([await vault.setParams({ admin: admin.publicKey, params: { ...CONFIG_PARAMS, ownerSolTarget: bn(0.5 * LAMPORTS_PER_SOL), ownerSolMin: bn(0.3 * LAMPORTS_PER_SOL) } })], [admin]);

  // ---- the server: core app + chain module (indexer, jobs) + keeper, with throwaway keys
  const adminToken = randomBytes(32).toString('hex');
  const config = loadConfig({
    DATABASE_URL: t.url, APP_ORIGIN, SESSION_SECRET: randomBytes(32).toString('hex'), ADMIN_API_TOKEN: adminToken,
    RPC_URL: validator.rpcUrl, RPC_WS_URL: validator.wsUrl, SOLANA_CLUSTER: 'localnet', TRUST_PROXY_HOPS: '0',
  });
  const rpc = createConnection(config);
  const hub = createStreamHub();
  const app = await buildApp({ config, db: t.db, sql: t.sql, hub, modules: new Map(), rpc, logger: false });
  const notices: ({ wallet: string } & Pick<Notification, 'title' | 'body' | 'kind'>)[] = [];
  const logged: string[] = [];
  const log = { info: () => {}, warn: (_o: unknown, m?: string) => void logged.push(m ?? String(_o)), error: (_o: unknown, m?: string) => void logged.push(m ?? String(_o)) };
  const shutdown = new AbortController();
  const ctx: ModuleContext = {
    app, log: app.log, publish: hub.publish, services: { sim: simStub().sim, marketdata }, signal: shutdown.signal, config, db: t.db, sql: t.sql, rpc,
    env: { RISK_AUTHORITY_KEYPAIR: JSON.stringify([...risk.secretKey]), KYC_AUTHORITY_KEYPAIR: JSON.stringify([...kyc.secretKey]) },
    notify: async (wallet, n) => void notices.push({ wallet, ...n }),
  };
  const chain = await createChain(ctx, { gm: noVenueFills, intervals: { indexer: 60_000, venue: 1_000, jobs: 500 } });
  registerKeeperRoutes(app, { db: t.db, adminToken });
  const adminPost = (url: string) => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${adminToken}` } }).then((r) => ({ status: r.statusCode, body: r.json() }));
  // The keeper's clock: 12 minutes before an NYSE close at least an hour from now (also ages Bob's requests past the review grace).
  clockOffset = nextSessionClose('nyse', Date.now() + 3_600_000)! - 12 * 60_000 - Date.now();
  const startKeeper = () => {
    const stop = new AbortController();
    const k = createKeeperModule({ ...ctx, log: log as unknown as FastifyBaseLogger, signal: stop.signal, env: { RISK_AUTHORITY_KEYPAIR: ctx.env.RISK_AUTHORITY_KEYPAIR } },
      { intervals: { tick: 1_000, leader: 60_000 }, now: keeperNow });
    return { ...k, stop: async () => { stop.abort(); await k.leader; } };
  };
  let keeper: ReturnType<typeof startKeeper> | undefined;
  const other = postgres(t.url, { max: 1, onnotice: () => {} }); // a competing session for the leader lock
  try {
    await until(async () => (await t.db.select({ n: count() }).from(gmOrders))[0]!.n === 8 && (await t.db.select().from(payouts)).length === 1, 30_000, 'setup indexed');

    // What GMTrade's indexer reports for Bob: a SOL round trip that realized exactly the 100 USDC he asks to be paid.
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    const fill = { fundedAccount: fundedB.toBase58(), position: 'BobSolPosition', order: 'BobOrder', symbol: 'SOL', side: 'Long' as const, slot: 1, price: '150', priceImpactUsd: '0', fundingUsd: '0', borrowUsd: '0' };
    await t.db.insert(venueFills).values([
      { ...fill, signature: 'bobOpen', eventIndex: 0, venueId: '000000000001-a-000001-000000-000001', isIncrease: true, sizeUsd: '1000', sizeAfterUsd: '1000', feeUsd: '0.6', realizedPnl: null, ts: ago(30) },
      { ...fill, signature: 'bobClose', eventIndex: 0, venueId: '000000000002-a-000001-000000-000001', isIncrease: false, sizeUsd: '1000', sizeAfterUsd: '0', feeUsd: '0.6', realizedPnl: '100.6', ts: ago(20) },
    ]);

    const first = startKeeper();
    keeper = first;

    // ---- top-ups, the session guard (cancel one TP/SL to free a slot, then close), and the sync crank
    const lamports = async (k: PublicKey) => (await connection.getAccountInfo(k))?.lamports ?? 0;
    await until(async () => (await lamports(ownerPda(fundedA))) >= 0.3 * LAMPORTS_PER_SOL && (await lamports(ownerPda(fundedB))) >= 0.3 * LAMPORTS_PER_SOL, 30_000, 'owner top-ups');
    const riskCloses = (a: Awaited<ReturnType<typeof fresh>>['account']) => a.orders.filter((o) => !o.order.equals(PublicKey.default) && o.placedByRisk && enumName(o.orderType) === 'close');
    let alice1 = await until(async () => {
      const a = (await fresh(fundedA)).account;
      return riskCloses(a).length === 1 && BigInt(a.slots[0]!.sizeUsd.toString()) === seeded.size && a;
    }, 30_000, 'risk close placed and the position synced');
    assert.equal(alice1.orders.filter((o) => !o.order.equals(PublicKey.default)).length, 8, 'one TP/SL cancelled to make room');
    const cancelled = await until(async () => (await t.db.select().from(gmOrders).where(eq(gmOrders.status, 'canceled')))[0], 20_000, 'cancel indexed');
    assert.deepEqual([cancelled.kind, cancelled.statusDetail], ['TakeProfit', 'Cancelled by the risk service']);
    const riskOrder = await until(async () => (await t.db.select().from(gmOrders)
      .where(and(eq(gmOrders.fundedAccount, fundedA.toBase58()), eq(gmOrders.statusDetail, 'Closes the whole position'))))[0], 20_000, 'risk close indexed');
    assert.deepEqual([riskOrder.isIncrease, riskOrder.status], [false, 'awaiting_execution']);
    assert.ok(notices.some((n) => n.wallet === alice.publicKey.toBase58() && n.kind === 'risk' && n.title === 'Long SOL closed before the market closes'));
    assert.ok(notices.some((n) => n.wallet === alice.publicKey.toBase58() && n.title === 'Pending order cancelled' && n.body.includes('take-profit on Long SOL')),
      'the trader is told which of their orders made room for the close');
    const synced = (await t.db.select().from(programEvents).where(eq(programEvents.name, 'synced'))).length;
    assert.ok(synced >= 1);

    // ---- Bob: fills explain the profit → approved → the chain job pays it
    const paid = await until(async () => (await t.db.select().from(payouts).where(eq(payouts.status, 'paid')))[0], 30_000, 'Bob paid');
    assert.equal((await t.db.select().from(chainJobs).where(eq(chainJobs.subject, paid.address)))[0]!.kind, 'approve_payout');

    // Nothing more to do: a few ticks later there is still exactly one risk close and no new sync.
    await new Promise((r) => setTimeout(r, 3_000));
    alice1 = (await fresh(fundedA)).account;
    assert.equal(riskCloses(alice1).length, 1);
    assert.equal((await t.db.select().from(programEvents).where(eq(programEvents.name, 'synced'))).length, synced);

    // ---- Bob again: 100 USDC more with no trading since the last payout → held for manual review, not approved
    await donate(bob, fundedB, '100');
    await send([await vault.requestPayout({ trader: bob.publicKey, funded: fundedB, payoutSeq: 1 })], [bob]);
    const held = await until(async () => (await t.db.select().from(payouts).where(eq(payouts.status, 'reviewing')))[0], 30_000, 'second request held');
    assert.match(held.reviewNote!, /^Requested profit 100 USDC is more than the 0 USDC realized in GMTrade fills since the last payout/);
    assert.equal((await t.db.select().from(chainJobs).where(eq(chainJobs.subject, held.address))).length, 0);
    assert.ok(logged.some((m) => m.startsWith(`Payout ${held.address} (80 USDC to the trader) held for manual review`)));

    // ---- operator alerts: stale prices under an open funded position, order churn, a chain job that failed for good
    solFreshness = 'stale';
    await t.db.insert(chainJobs).values({ kind: 'reject_payout', subject: 'AnotherPayout', payload: {}, mac: '0'.repeat(64), status: 'failed', lastError: 'simulation failed: InvalidPayoutStatus' });
    await t.db.insert(gmOrders).values(Array.from({ length: 50 }, (_, i) => ({
      address: `Churn${i}`, fundedAccount: fundedB.toBase58(), marketToken: MARKETS.SOL.token.toBase58(), symbol: 'SOL', side: 'Long' as const,
      kind: 'Market' as const, isIncrease: true, sizeUsd: '10', status: 'executed' as const, createSignature: 'churn', createdAt: new Date(keeperNow()), closedAt: new Date(),
    })));
    await until(async () => [
      'SOL prices are 25 s old with 1 funded position(s) open: the keeper cannot value them',
      `Funded account ${fundedB.toBase58()} created 50 GMTrade orders in the last hour`,
      'Chain job reject_payout for AnotherPayout failed for good: simulation failed: InvalidPayoutStatus. Once the cause is fixed: POST /v1/admin/jobs/',
    ].every((m) => logged.some((l) => l.startsWith(m))), 20_000, 'operator alerts');
    solFreshness = 'live';

    // ---- leader lost: the lock's session dies and another holds the lock; the keeper must send nothing
    const [baseline] = await t.db.select().from(gmtradeDeploys);
    assert.ok(baseline && baseline.detectedAt === null && baseline.acknowledgedAt, 'without GMTRADE_DEPLOY_SLOT, first sight of GMTrade is accepted ...');
    assert.ok(logged.includes(`GMTrade deploy slot ${baseline.slot} was accepted as the reviewed release on first sight: set GMTRADE_DEPLOY_SLOT to the reviewed deploy to pin it`), '... and said so');
    await other`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and classid = 0 and objid = ${LOCK} and granted
      and database = (select oid from pg_database where datname = current_database())`;
    await other`select pg_advisory_lock(${LOCK}::int)`;
    // As if GMTrade had been redeployed since the baseline: the next tick wants to restrict Alice.
    await t.db.update(gmtradeDeploys).set({ slot: baseline.slot - 1 });
    await until(async () => logged.includes('keeper: leadership lost before a send; nothing was sent, stepping down') && !first.service.status().leader, 20_000, 'send refused');
    await new Promise((r) => setTimeout(r, 2_000));
    assert.equal(enumName((await vault.fetchFunded(fundedA))!.status), 'active', 'no restrict was sent');
    assert.equal((await t.db.select().from(programEvents).where(eq(programEvents.name, 'accountRestricted'))).length, 0);
    await first.stop();
    await other`select pg_advisory_unlock(${LOCK}::int)`;

    // ---- a new leader restricts every active funded account after the upgrade (Bob's is awaiting payout review)
    const second = startKeeper();
    keeper = second;
    await until(async () => enumName((await vault.fetchFunded(fundedA))!.status) === 'restricted', 30_000, 'Alice restricted');
    assert.equal(enumName((await vault.fetchFunded(fundedB))!.status), 'payoutPending');
    const upgrade = await until(async () => {
      const [row] = await t.db.select().from(gmtradeDeploys).where(eq(gmtradeDeploys.slot, baseline.slot));
      return row?.handledAt && row;
    }, 20_000, 'upgrade handled');
    assert.ok(upgrade.detectedAt);
    const status = second.service.status();
    assert.deepEqual([status.leader, status.gmtradeUpgrade?.slot, status.gmtradeUpgrade?.detectedAt, status.gmtradeUpgrade?.acknowledgedAt],
      [true, baseline.slot, upgrade.detectedAt!.getTime(), null]);
    assert.ok(status.gmtradeUpgrade!.restrictedAt! >= upgrade.detectedAt!.getTime(), 'health shows when the restriction pass finished');
    await until(async () => (await t.db.select().from(fundedAccounts).where(eq(fundedAccounts.status, 'restricted'))).length === 1, 20_000, 'restriction indexed');

    // Lifting Alice's restriction before the upgrade is acknowledged does not stick: the keeper restricts her again.
    assert.equal((await adminPost(`/v1/admin/funded/${fundedA.toBase58()}/lift-restriction`)).status, 200);
    await until(async () => (await t.db.select().from(programEvents).where(eq(programEvents.name, 'accountRestricted'))).length === 3, 30_000, 'lifted, then restricted again');
    assert.equal(enumName((await vault.fetchFunded(fundedA))!.status), 'restricted');

    // ---- an operator acknowledges the new GMTrade deploy, then lifts the restriction: Alice trades again and stays active
    assert.equal((await adminPost(`/v1/admin/gmtrade-deploys/${baseline.slot + 1_000}/acknowledge`)).status, 404);
    const ack = await adminPost(`/v1/admin/gmtrade-deploys/${baseline.slot}/acknowledge`);
    assert.equal(ack.status, 200);
    assert.equal((await adminPost(`/v1/admin/gmtrade-deploys/${baseline.slot}/acknowledge`)).status, 409);
    await until(async () => second.service.status().gmtradeUpgrade?.acknowledgedAt === ack.body.acknowledgedAt, 20_000, 'acknowledgement seen by the keeper');
    await until(async () => (await t.db.select().from(fundedAccounts).where(eq(fundedAccounts.address, fundedA.toBase58())))[0]!.status === 'restricted', 20_000, 'restriction indexed again');
    assert.equal((await adminPost(`/v1/admin/funded/${fundedA.toBase58()}/lift-restriction`)).status, 200);
    await until(async () => enumName((await vault.fetchFunded(fundedA))!.status) === 'active', 30_000, 'Alice active again');
    const lift = await until(async () => (await t.db.select().from(chainJobs).where(eq(chainJobs.subject, `lift:${fundedA.toBase58()}`)))[0]?.status === 'confirmed'
      && (await t.db.select().from(chainJobs).where(eq(chainJobs.subject, `lift:${fundedA.toBase58()}`)))[0], 30_000, 'lift job confirmed');
    const lifted = await until(async () => (await t.db.select().from(programEvents).where(eq(programEvents.name, 'accountRestricted'))).find((e) => e.signature === lift.signature), 20_000, 'lift indexed');
    assert.equal((lifted.data as { restricted: boolean }).restricted, false);
    await new Promise((r) => setTimeout(r, 3_000));
    assert.equal(enumName((await vault.fetchFunded(fundedA))!.status), 'active', 'the keeper leaves an acknowledged upgrade alone');
  } finally {
    await keeper?.stop();
    await other.end();
    shutdown.abort();
    await chain.leader;
    await app.close();
    // web3.js closes an idle websocket 500 ms after the last unsubscribe; stopping the validator earlier keeps it reconnecting.
    await new Promise((r) => setTimeout(r, 1_500));
  }
});
