// Props order fees when the server's view lags the chain (docs/design/order-fee.md §9), on the program itself: the
// props_vault binary under test and the GMTrade binary in LiteSVM, the real indexer, venue loop and keeper, on a real
// Postgres, at $0.50 + 2 bps (the harness of fees.e2e.test.ts).
//
// Covered: a settlement the server did not send (the risk-key fallback) that its indexer has not applied yet, plus a
// new fee due of the same amount, is not charged again; a closing fill the exchange's indexer reports long after the
// account went flat is still fetched while its fee is due, so the fee is charged, not waived a day later; a settlement
// the keeper sent is failed only once its blockhash can no longer land (not after a fixed time).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import type { OrderRemoval, TradeEvent } from '@props/gmtrade';
import { CLOSE_ALL, POSITION_LAYOUT, PROPS_VAULT_PROGRAM_ID, PropsVaultClient, feeVaultPda, fromMicro, gmOrderEscrow, gmPositionPda, orderFee } from '@props/sdk';
import { closedTrades, orderFeeSettlements, orderFees } from '../../../db/schema.ts';
import { createIndexer } from '../../chain/indexer.ts';
import { createProgramReader } from '../../chain/program.ts';
import { createReader, type ChainReader } from '../../chain/reader.ts';
import { createVenue, type GmIndexer } from '../../chain/venue.ts';
import { freshDb, sealer, silentLog } from '../../chain/test/support.ts';
import type { Alerts } from '../alerts.ts';
import { createKeeper } from '../keeper.ts';
import { liteSvmRpc } from './litesvm-rpc.ts';

const litesvm = (createRequire(import.meta.url)('litesvm/package.json') as { version: string }).version;
const skip = litesvm.startsWith('0.') ? `litesvm ${litesvm} is installed, not the pinned 1.4 (npm ci installs it)` : false;

const USD = 10n ** 20n;
const RATE = { feeUsdc: 500_000n, feeBps: 2 };
const CAP = 10_000n * USD;
const SOL_PRICE = 150n * 10n ** 11n;
const HIGH = 10n ** 30n;
const realNow = Date.now.bind(Date);
let offset = 0;
let fillSeq = 0; // fill ids (and their signatures) are unique across the tests' accounts

let t: Awaited<ReturnType<typeof freshDb>>;
before(async () => {
  if (skip) return;
  t = await freshDb('keeper_fees_lag');
  Date.now = () => realNow() + offset;
});
after(async () => {
  Date.now = realNow;
  await t?.sql.end();
});

/** One funded account at the fee rate, with the server around it and GMTrade's keepers and indexer scripted. */
async function harness() {
  const { Env, MARKETS, usdc } = await import('../../../../../tests/program/src/env.ts');
  const env = new Env();
  const rpc = liteSvmRpc(env);
  await env.setUpVault();
  env.ok(await env.vault.setOrderFee({ admin: env.admin.publicKey, feeUsdc: RATE.feeUsdc, feeBps: RATE.feeBps }), [env.admin]);
  const alice = await env.activeFunded();
  const sol = { marketToken: MARKETS.SOL.token.toBase58(), symbol: 'SOL', indexToken: 'So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH', decimals: 9 };
  const client = new PropsVaultClient(rpc as never);
  const reader: ChainReader = { evaluation: createReader(client, rpc as never).evaluation, market: async () => sol };
  const program = createProgramReader({ db: t.db, rpc: rpc as never, client, programId: PROPS_VAULT_PROGRAM_ID, cluster: 'localnet', serverRate: { feeUsdc: 0n, feeBps: 0, source: 'server' } });
  const indexer = createIndexer({ db: t.db, rpc: rpc as never, client, programId: PROPS_VAULT_PROGRAM_ID, log: silentLog, reader, notify: async () => {}, onApplied: (e) => program.changed(e) });
  const fills = new Map<string, TradeEvent[]>();
  const removals: OrderRemoval[] = [];
  const gm: GmIndexer = {
    trades: async (owner, afterId) => (fills.get(owner) ?? []).filter((e) => !afterId || e.id > afterId),
    signatures: async (ids) => new Map(ids.map((id) => [id, `fill-${id}`])),
    removals: async (orders) => removals.filter((r) => orders.includes(r.order)),
  };
  const venue = createVenue({ db: t.db, rpc: rpc as never, client, reader, gm, log: silentLog, notify: async () => {} });
  const raised: string[] = [];
  let tickEnded = () => {};
  const alerts: Alerts = { send: (key, level) => void raised.push(`${level} ${key}`), heartbeat: () => tickEnded() };
  const keeper = createKeeper({ db: t.db, rpc: rpc as never, client, reader, risk: env.risk, sealer, log: silentLog, notify: async () => {}, alerts });
  const tick = async () => {
    const stop = new AbortController();
    tickEnded = () => stop.abort();
    await keeper.run(stop.signal, async () => true, 10);
  };
  /** The indexer, the venue loop as production runs it after its first pass (fills only while recent or fees due), the indexer. */
  const serve = async () => {
    await indexer.catchUp();
    await venue.tick(alice.funded.toBase58(), alice.owner.toBase58(), alice.trader.publicKey.toBase58(), false);
    await indexer.catchUp();
  };
  const round = async () => {
    await tick();
    await serve();
  };
  const onchain = () => env.account('fundedAccount', alice.funded);
  const fees = () => ({ due: fromMicro(BigInt(onchain().orderFeesDue.toString())), paid: fromMicro(BigInt(onchain().orderFeesPaid.toString())), settlements: Number(onchain().orderFeeSettlements.toString()) });
  const position = gmPositionPda(alice.owner, MARKETS.SOL.token, true);
  const fill = (p: { order: PublicKey; before: bigint; after: bigint; collateral: bigint; pnl?: bigint }) => {
    const owner = alice.owner.toBase58();
    const price = { min: SOL_PRICE, max: SOL_PRICE };
    const usdcPrice = { min: 10n ** 14n, max: 10n ** 14n };
    fills.set(owner, [...(fills.get(owner) ?? []), {
      id: `${String(900_000_000 + ++fillSeq).padStart(12, '0')}-FEEZZ-000001-000000-000001`, ts: Date.now(), slot: 1, marketToken: sol.marketToken, user: owner,
      position: position.toBase58(), order: p.order.toBase58(), isLong: true, isCollateralLong: false, isIncrease: p.after > p.before, isLiquidation: false,
      executionPrice: SOL_PRICE, priceImpactValue: 0n,
      before: { sizeInUsd: p.before, sizeInTokens: 0n, collateralAmount: 0n }, after: { sizeInUsd: p.after, sizeInTokens: p.after / SOL_PRICE, collateralAmount: p.collateral },
      pnl: p.pnl ?? 0n, fees: { order: 0n, liquidation: 0n, borrowing: 0n, funding: 0n }, prices: { index: price, long: usdcPrice, short: usdcPrice },
      outputAmount: 0n, secondaryOutputAmount: 0n,
    }]);
  };
  const filled = (sizeUsd: bigint, collateral: bigint) => {
    env.setPosition(position, sizeUsd, collateral);
    const a = env.svm.getAccount(position)!;
    const data = Buffer.from(a.data);
    const tokens = sizeUsd / SOL_PRICE;
    data.writeBigUInt64LE(tokens & ((1n << 64n) - 1n), POSITION_LAYOUT.sizeInTokens);
    data.writeBigUInt64LE(tokens >> 64n, POSITION_LAYOUT.sizeInTokens + 8);
    env.svm.setAccount(position, { ...a, data });
  };
  const removed = (order: PublicKey, state: 'Completed' | 'Cancelled') =>
    removals.push({ id: String(removals.length), order: order.toBase58(), kind: 'MarketIncrease', state, reason: state === 'Completed' ? 'executed' : 'price', ts: Date.now(), slot: 1 });
  const open = async (size: bigint, collateral: string) => {
    const o = await env.vault.openPosition({
      trader: alice.trader.publicKey, funded: env.funded(alice.funded), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'market',
      collateral: usdc(collateral), sizeDeltaUsd: size, acceptablePrice: HIGH, maxFee: orderFee(RATE, size),
    });
    env.ok(o.instruction, [alice.trader]);
    return o.order;
  };
  const protect = async (orderType: 'takeProfit' | 'stopLoss', trigger: bigint) => {
    const p = await env.vault.setProtection({
      trader: alice.trader.publicKey, funded: env.funded(alice.funded), marketToken: MARKETS.SOL.token, isLong: true, orderType, triggerPrice: trigger,
      sizeDeltaUsd: CLOSE_ALL, maxFee: orderFee(RATE, CLOSE_ALL, CAP),
    });
    env.ok(p.instruction, [alice.trader]);
    return p.order;
  };
  /** A $10,000 long with a close-all take profit and stop loss (each assessed $2.50 on the cap); the open executes and is charged. */
  const tradeWithProtection = async () => {
    await serve();
    const o = await open(10_000n * USD, '400');
    const tp = await protect('takeProfit', 160n * 10n ** 11n);
    const sl = await protect('stopLoss', 140n * 10n ** 11n);
    await serve();
    env.executeOrder(o, gmOrderEscrow(o));
    filled(10_000n * USD, usdc('400'));
    removed(o, 'Completed');
    fill({ order: o, before: 0n, after: 10_000n * USD, collateral: usdc('400') });
    for (let i = 0; i < 4 && fees().paid !== '2.5'; i++) await round();
    assert.deepEqual(fees(), { due: '0', paid: '2.5', settlements: 1 });
    return { tp, sl };
  };
  return { env, rpc, usdc, alice, t, tick, serve, round, fees, fill, filled, removed, open, raised, tradeWithProtection };
}

test('a settlement the server did not send and has not indexed yet, and a new fee due of the same amount: nothing is charged twice', { skip, timeout: 300_000 }, async () => {
  const h = await harness();
  const { env, usdc, alice } = h;
  const { tp, sl } = await h.tradeWithProtection();
  // The take profit closes the $10,000; anyone's sync makes its $2.50 due and the ledger indexes it.
  env.executeOrder(tp, gmOrderEscrow(tp));
  h.filled(0n, 0n);
  env.setUsdcBalance(alice.ownerUsdc, env.usdcBalance(alice.ownerUsdc) + usdc('500'));
  h.removed(tp, 'Completed');
  h.fill({ order: tp, before: 10_000n * USD, after: 0n, collateral: 0n, pnl: 100n * USD });
  env.ok(await env.vault.sync({ funded: env.funded(alice.funded) }), [env.wallet()]);
  await h.serve();
  // The keeper is down; an operator settles the take profit with the risk key (as settle-order-fees.ts does). The server
  // restarts and its keeper ticks before its indexer caught up; meanwhile the exchange cancelled the stop loss.
  env.ok(await env.vault.settleOrderFees({ riskAuthority: env.risk.publicKey, funded: alice.funded, charge: 2_500_000n, waive: 0n, expectedDue: 2_500_000n, expectedSettlements: 1n }), [env.risk]);
  env.executeOrder(sl, gmOrderEscrow(sl));
  h.removed(sl, 'Cancelled');
  const vault = env.usdcBalance(feeVaultPda());
  await h.tick(); // its sync makes the stop loss's $2.50 due: the fees due alone would match the stale ledger
  assert.deepEqual(h.fees(), { due: '2.5', paid: '5', settlements: 2 }, 'nothing settled from a ledger that misses a settlement');
  assert.equal(env.usdcBalance(feeVaultPda()), vault);
  // Once indexed, the stop loss is waived; the take profit stays charged once.
  for (let i = 0; i < 4 && h.fees().due !== '0'; i++) await h.round();
  assert.deepEqual(h.fees(), { due: '0', paid: '5', settlements: 3 });
  const rows = Object.fromEntries((await h.t.db.select().from(orderFees).where(eq(orderFees.fundedAccount, alice.funded.toBase58()))).map((r) => [r.order, r]));
  assert.deepEqual([tp, sl].map((o) => [rows[o.toBase58()]!.chargedUsd, rows[o.toBase58()]!.waivedUsd]), [['2.500000', '0.000000'], ['0.000000', '2.500000']]);
  // And the account keeps settling: a new $1,000 open is charged its $0.70.
  const next = await h.open(1_000n * USD, '100');
  await h.serve();
  env.executeOrder(next, gmOrderEscrow(next));
  h.filled(1_000n * USD, usdc('100'));
  h.removed(next, 'Completed');
  h.fill({ order: next, before: 0n, after: 1_000n * USD, collateral: usdc('100') });
  for (let i = 0; i < 4 && h.fees().paid !== '5.7'; i++) await h.round();
  assert.deepEqual(h.fees(), { due: '0', paid: '5.7', settlements: 4 });
  assert.deepEqual(h.raised.filter((r) => /fee-ledger|failed:.*:settle/.test(r)), []);
});

test('a closing fill the exchange reports minutes after the account went flat is still fetched while its fee is due: charged, not waived', { skip, timeout: 300_000 }, async () => {
  const h = await harness();
  const { env, usdc, alice } = h;
  const { tp, sl } = await h.tradeWithProtection();
  env.executeOrder(tp, gmOrderEscrow(tp));
  env.executeOrder(sl, gmOrderEscrow(sl));
  h.filled(0n, 0n);
  env.setUsdcBalance(alice.ownerUsdc, env.usdcBalance(alice.ownerUsdc) + usdc('500'));
  h.removed(sl, 'Cancelled');
  for (let i = 0; i < 3; i++) await h.round(); // synced: both fees due, the account flat; the stop loss waived
  assert.deepEqual(h.fees(), { due: '2.5', paid: '2.5', settlements: 2 });
  offset += 4 * 60_000; // the exchange's indexer reports the take profit 4 minutes later
  h.removed(tp, 'Completed');
  h.fill({ order: tp, before: 10_000n * USD, after: 0n, collateral: 0n, pnl: 100n * USD });
  for (let i = 0; i < 4 && h.fees().due !== '0'; i++) await h.round();
  assert.deepEqual(h.fees(), { due: '0', paid: '5', settlements: 3 }, 'the take profit charged the rate on the $10,000 it closed');
  assert.equal((await h.t.db.select().from(closedTrades).where(eq(closedTrades.accountId, alice.funded.toBase58()))).length, 1, 'the round trip recorded');
  const payout = env.send([await env.vault.requestPayout({ trader: alice.trader.publicKey, funded: alice.funded, payoutSeq: 0 })], [alice.trader]);
  assert.ok(!payout.error, payout.error);
});

test('a sent settlement awaiting its outcome is failed only once the confirmed block height has passed its last valid height', { skip, timeout: 300_000 }, async () => {
  const h = await harness();
  const { env, usdc, alice } = h;
  const { tp } = await h.tradeWithProtection();
  env.executeOrder(tp, gmOrderEscrow(tp));
  h.filled(0n, 0n);
  env.setUsdcBalance(alice.ownerUsdc, env.usdcBalance(alice.ownerUsdc) + usdc('500'));
  h.removed(tp, 'Completed');
  h.fill({ order: tp, before: 10_000n * USD, after: 0n, collateral: 0n, pnl: 100n * USD });
  env.ok(await env.vault.sync({ funded: env.funded(alice.funded) }), [env.wallet()]);
  await h.serve();
  // A settlement recorded as sent long ago that the chain has not seen (the node here is at block height 1).
  const funded = alice.funded.toBase58();
  const signature = `pending-${funded.slice(0, 8)}`;
  await h.t.db.insert(orderFeeSettlements).values({
    signature, fundedAccount: funded, chargeUsd: '2.5', waiveUsd: '0', expectedDueUsd: '2.5', expectedSettlements: 1, allocations: [], status: 'sent', sentBy: 'keeper',
    createdAt: new Date(Date.now() - 3_600_000), lastValidBlockHeight: 150,
  });
  const status = async () => (await h.t.db.select().from(orderFeeSettlements).where(eq(orderFeeSettlements.signature, signature)))[0]!.status;
  // Fee bookkeeping that fails (here the block height read) skips the settlement, not the account's other checks.
  const height = h.rpc.getBlockHeight;
  h.rpc.getBlockHeight = async () => { throw new Error('fetch failed'); };
  await h.tick();
  h.rpc.getBlockHeight = height;
  assert.deepEqual([h.raised.includes(`warning fee-view:${funded}`), h.raised.some((r) => r.endsWith(`read:${funded}`))], [true, false]);
  await h.tick();
  assert.equal(await status(), 'sent', 'it can still land: waited for, however old');
  assert.deepEqual(h.fees(), { due: '2.5', paid: '2.5', settlements: 1 }, 'nothing re-planned meanwhile');
  await h.t.db.update(orderFeeSettlements).set({ lastValidBlockHeight: 0 }).where(eq(orderFeeSettlements.signature, signature));
  await h.tick();
  assert.equal(await status(), 'failed', 'past its last valid height and not found: it never landed');
  for (let i = 0; i < 4 && h.fees().due !== '0'; i++) await h.round();
  assert.deepEqual(h.fees(), { due: '0', paid: '5', settlements: 2 });
});
