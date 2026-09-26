// Props.trade's fee on funded orders, server side (docs/design/order-fee.md §9): the per-order ledger the indexer keeps
// from the program's events, what executed orders owe, the settlement plan the keeper sends, the fee each fill carries,
// the rate every stage reads, and the funded valuation's view of them. The numbers are the design's own example:
// $0.50 + 2 bps, a $10,000 long with a close-all take profit and stop loss on a 10K account (exposure cap $10,000).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { eq } from 'drizzle-orm';
import { CLOSE_ALL, PROPS_VAULT_PROGRAM_ID, gmOrderPda, orderFee, orderNonce } from '@props/sdk';
import type { TradeEvent } from '@props/gmtrade';
import { accountEvents, accounts, evaluations, fundedAccounts, gmOrders, orderFeeSettlements, orderFees, vaultLedger, venueFills } from '../../../db/schema.ts';
import { toJson, type VaultEvent } from '../events.ts';
import { asOnchain, chargedSince, confirmSettlement, dueInLedger, feeLedger, feesOwed, fillFee, inStep, owedOf, planSettlement, recordSettlement, unknownSince, UNKNOWN_WAIVE_MS, type FeeRow } from '../fees.ts';
import { createFundedProvider, money } from '../funded.ts';
import { createProgramReader, type ProgramReader } from '../program.ts';
import { project } from '../projector.ts';
import type { ChainReader } from '../reader.ts';
import { createVenue, roundTrip, type GmIndexer, type Valuation, type Venue } from '../venue.ts';
import { freshDb, offlineClient, silentLog } from './support.ts';

const USD = 10n ** 20n;
const RATE = { feeUsdc: 500_000n, feeBps: 2 };
const CAP = 10_000n * USD;
const NOW = Date.parse('2026-09-26T12:00:00Z');
const key = () => Keypair.generate().publicKey.toBase58();
const sol = { marketToken: '6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc', symbol: 'SOL', indexToken: 'So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH', decimals: 9 };
const reader: ChainReader = { evaluation: async () => { throw new Error('unused'); }, market: async () => sol };

let t: Awaited<ReturnType<typeof freshDb>>;
before(async () => {
  t = await freshDb('chain_fees');
});
after(async () => {
  await t.sql.end();
});

const row = (o: Partial<FeeRow> & Pick<FeeRow, 'order'>): FeeRow => ({
  isIncrease: false, state: 'due', assessed: 2_500_000n, rate: RATE, charged: 0n, waived: 0n, dueAt: new Date(NOW - 60_000), status: 'executed',
  executed: null, ...o,
});

test('what each order owes and what a settlement charges and waives: executed orders the rate on what they executed, the rest nothing', () => {
  // The design's example: the open is charged $2.50; a $4,000 partial close $1.30; the take profit closing the other
  // $6,000 $1.70 of its $2.50 (the rest waived); the same open cancelled by the exchange $0.
  assert.equal(orderFee(RATE, 10_000n * USD), 2_500_000n);
  assert.equal(orderFee(RATE, CLOSE_ALL, CAP), 2_500_000n, 'a close-all TP/SL is assessed on the exposure cap');
  const rows = [
    row({ order: 'open', isIncrease: true, dueAt: new Date(NOW - 50_000) }),
    row({ order: 'partial', assessed: 1_300_000n, executed: 4_000n * USD, dueAt: new Date(NOW - 40_000) }),
    row({ order: 'tp', executed: 6_000n * USD, dueAt: new Date(NOW - 30_000) }),
    row({ order: 'slippage', isIncrease: true, status: 'canceled', dueAt: new Date(NOW - 20_000) }),
    row({ order: 'sl', state: 'released', status: 'canceled' }),
  ];
  assert.deepEqual(rows.map(owedOf), [2_500_000n, 1_300_000n, 1_700_000n, null, null]);
  const plan = planSettlement(rows, { balance: 100_000_000n, now: NOW });
  assert.deepEqual(plan, {
    charge: 5_500_000n, waive: 3_300_000n,
    allocations: [
      { order: 'open', charge: 2_500_000n, waive: 0n }, { order: 'partial', charge: 1_300_000n, waive: 0n },
      { order: 'tp', charge: 1_700_000n, waive: 800_000n }, { order: 'slippage', charge: 0n, waive: 2_500_000n },
    ],
  });
  assert.equal(plan.charge + plan.waive, dueInLedger(rows), 'everything due is settled at once when every outcome is known');
  assert.equal(feesOwed(rows), 5_500_000n, 'what the valuation subtracts: executed orders only');

  // The charges stop at the account's USDC: the rest of what executed orders owe stays due; what they do not owe is
  // waived anyway. Closing, everything left is waived.
  const short = planSettlement(rows, { balance: 3_000_000n, now: NOW });
  assert.deepEqual(short.allocations.map((a) => [a.order, a.charge, a.waive]), [
    ['open', 2_500_000n, 0n], ['partial', 500_000n, 0n], ['tp', 0n, 800_000n], ['slippage', 0n, 2_500_000n],
  ]);
  const closing = planSettlement(rows, { balance: 3_000_000n, now: NOW, closing: true });
  assert.deepEqual([closing.charge, closing.waive, closing.charge + closing.waive], [3_000_000n, 5_800_000n, dueInLedger(rows)]);
});

test('an order whose outcome is not known yet waits, is alerted after 10 minutes and waived after 24 hours; charged or waived rows are settled once', () => {
  const unknown = row({ order: 'unknown', status: 'unknown', dueAt: new Date(NOW - 11 * 60_000) });
  const noFills = row({ order: 'no-fills', status: 'executed', executed: null, dueAt: new Date(NOW - 5_000) });
  assert.deepEqual(planSettlement([unknown, noFills], { balance: 10n ** 9n, now: NOW }).allocations, [], 'nothing charged on a guess');
  assert.deepEqual(unknownSince([unknown, noFills]), unknown.dueAt);
  const later = NOW - 11 * 60_000 + UNKNOWN_WAIVE_MS;
  assert.deepEqual(planSettlement([unknown], { balance: 10n ** 9n, now: later }).allocations, [{ order: 'unknown', charge: 0n, waive: 2_500_000n }]);
  // An increase executed before its sync is owed although nothing is due yet; once charged it owes nothing more.
  const unsynced = row({ order: 'unsynced', isIncrease: true, state: 'assessed', dueAt: null });
  assert.equal(feesOwed([unsynced]), 2_500_000n);
  assert.equal(feesOwed([{ ...unsynced, state: 'due', charged: 2_500_000n }]), 0n);
  const settled = row({ order: 'settled', executed: 6_000n * USD, charged: 1_700_000n, waived: 800_000n });
  assert.deepEqual([planSettlement([settled], { balance: 10n ** 9n, now: NOW }).allocations, dueInLedger([settled])], [[], 0n]);
});

/** A funded account's rows, as the indexer writes them at activation. */
async function fundedAccount() {
  const [trader, evaluation, funded, owner] = [key(), key(), key(), key()];
  await t.db.insert(evaluations).values({
    address: evaluation, trader, evalIndex: 0, tierId: 1, sizeUsd: '10000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000,
    traderShareBps: 8000, termsHash: 'ab'.repeat(32), feePaid: '79', status: 'funded', purchaseSignature: 'purchase', createdAt: new Date(), updatedSlot: 1,
  });
  await t.db.insert(fundedAccounts).values({
    address: funded, evaluation, trader, ownerPda: owner, principal: '500', traderShareBps: 8000, status: 'active', activationSignature: 'activation',
    createdAt: new Date(), updatedSlot: 2,
  });
  await t.db.insert(accounts).values({
    id: funded, wallet: trader, stage: 'funded', status: 'active', label: 'Funded 10K', tierId: 1, evaluation, funded, sizeUsd: '10000',
    lossAllowanceUsd: '500', maxExposureBps: 10_000, traderShareBps: 8000, termsHash: 'ab'.repeat(32), termsVersion: 1, activatedAt: new Date(),
  });
  return { trader, funded, owner };
}

let slot = 1_000;
/** Projects one event as the indexer does (its own transaction, the event's JSON form). */
async function apply(name: string, data: Record<string, unknown>, signature = key(), eventIndex = 0) {
  const ev = { name, data: toJson(data) } as VaultEvent;
  await t.db.transaction((tx) => project(tx, ev, eventIndex, { signature, slot: slot++, fee: 5_000n }, { reader }));
  return signature;
}
const ts = (s: number) => new BN(Math.floor(NOW / 1000) + s);
const fee = (micro: bigint, rate = RATE) => ({ fee: new BN(micro.toString()), orderFeeUsdc: new BN(rate.feeUsdc.toString()), orderFeeBps: rate.feeBps });

test('the indexer keeps each order\'s fee: assessed with its rate, re-assessed on update, released or due as it leaves the book, settled once', async () => {
  const { trader, funded } = await fundedAccount();
  const pk = (k: string) => new PublicKey(k);
  const [open, tp, sl, cancelled] = [key(), key(), key(), key()];
  const order = (address: string, orderType: object, size: bigint) => ({
    funded: pk(funded), order: pk(address), marketToken: pk(sol.marketToken), isLong: true, orderType, sizeDeltaUsd: new BN(size.toString()),
    collateral: new BN(500_000_000), triggerPrice: new BN(0), acceptablePrice: new BN(10).pow(new BN(13)), by: pk(trader), ts: ts(0),
  });
  await apply('orderRequested', { ...order(open, { market: {} }, 10_000n * USD), ...fee(2_500_000n) });
  for (const [address, orderType] of [[tp, { takeProfit: {} }], [sl, { stopLoss: {} }]] as const) {
    await apply('protectionSet', {
      funded: pk(funded), order: pk(address), marketToken: pk(sol.marketToken), isLong: true, orderType, sizeDeltaUsd: new BN(CLOSE_ALL.toString()),
      triggerPrice: new BN(10).pow(new BN(13)), ts: ts(1), ...fee(2_500_000n),
    });
  }
  await apply('orderRequested', { ...order(cancelled, { limit: {} }, 1_000n * USD), ...fee(700_000n) });
  const rows = async () => Object.fromEntries((await t.db.select().from(orderFees).where(eq(orderFees.fundedAccount, funded))).map((r) => [r.order, r]));
  let now = await rows();
  assert.deepEqual([now[open]!.assessedUsd, now[open]!.rateUsd, now[open]!.rateBps, now[open]!.isIncrease, now[open]!.state], ['2.500000', '0.500000', 2, true, 'assessed']);
  assert.deepEqual([now[tp]!.isIncrease, now[tp]!.assessedUsd], [false, '2.500000']);
  const [placed] = await t.db.select().from(accountEvents).where(eq(accountEvents.accountId, funded));
  assert.match(placed!.detail, /Props fee 2\.5 USDC, charged only if it executes\./);

  // The rate rises to $1 + 2 bps before the trader moves the stop loss: the update re-assesses it at the new rate.
  await apply('orderUpdated', { funded: pk(funded), order: pk(sl), sizeDeltaUsd: null, triggerPrice: new BN(1), acceptablePrice: null, ts: ts(2), ...fee(3_000_000n, { feeUsdc: 1_000_000n, feeBps: 2 }) });
  now = await rows();
  assert.deepEqual([now[sl]!.assessedUsd, now[sl]!.rateUsd, now[sl]!.state], ['3.000000', '1.000000', 'assessed']);

  // The trader cancels the limit order: released. The open leaves the book (sync: due); the take profit executed and
  // was left open (close_completed_order: due); the stop loss the exchange cancelled and left open: released.
  await apply('orderCancelled', { funded: pk(funded), order: pk(cancelled), by: pk(trader), ts: ts(3) });
  await apply('synced', { funded: pk(funded), slots: [], ordersDropped: [pk(open)], ts: ts(4) });
  await apply('completedOrderClosed', { funded: pk(funded), order: pk(tp), ts: ts(5), cancelled: false });
  await apply('completedOrderClosed', { funded: pk(funded), order: pk(sl), ts: ts(6), cancelled: true });
  now = await rows();
  assert.deepEqual([open, tp, sl, cancelled].map((o) => now[o]!.state), ['due', 'due', 'released', 'released']);
  assert.deepEqual(now[open]!.dueAt?.getTime(), (Math.floor(NOW / 1000) + 4) * 1000);
  const ledger = await feeLedger(t.db, funded);
  assert.equal(dueInLedger(ledger.rows), 5_000_000n, 'the account\'s order_fees_due: the open\'s and the take profit\'s assessments');

  // The keeper settles: the open executed (its fee in full), the take profit closed $6,000 ($1.70; its fill carries it).
  await t.db.update(gmOrders).set({ status: 'executed' }).where(eq(gmOrders.fundedAccount, funded));
  await t.db.insert(venueFills).values({
    signature: 'tpFill', eventIndex: 0, venueId: `000000000001-${funded.slice(0, 5)}-000001-000000-000001`, slot: 1, fundedAccount: funded, position: 'p', order: tp,
    symbol: 'SOL', side: 'Long', isIncrease: false, sizeUsd: '6000', sizeAfterUsd: '0', price: '150', feeUsd: '0.6', priceImpactUsd: '0', fundingUsd: '0',
    borrowUsd: '0', realizedPnl: '10', platformFeeUsd: '1.7', ts: new Date(),
  });
  const plan = planSettlement((await feeLedger(t.db, funded)).rows, { balance: 400_000_000n, now: Date.now() });
  assert.deepEqual([plan.charge, plan.waive], [4_200_000n, 800_000n]);
  const signature = key();
  await recordSettlement(t.db, { signature, funded, plan, expectedDue: 5_000_000n, expectedSettlements: 0n, sentBy: 'keeper', lastValidBlockHeight: 100 });
  const sent = await feeLedger(t.db, funded);
  assert.equal(sent.pending?.signature, signature, 'sent, awaiting its event');
  // Until its event is indexed, the valuation counts it only once the account's settlement count shows it landed (its
  // USDC has left the account then): owed 4.2 before, nothing after.
  assert.deepEqual([feesOwed(asOnchain(sent, 0n)), feesOwed(asOnchain(sent, 1n))], [4_200_000n, 0n]);
  const settled = { funded: pk(funded), charged: new BN(4_200_000), waived: new BN(800_000), orderFeesDue: new BN(0), orderFeesPaid: new BN(4_200_000), by: pk(key()), ts: ts(9) };
  await apply('orderFeesSettled', settled, signature);
  now = await rows();
  assert.deepEqual([now[open]!.chargedUsd, now[open]!.waivedUsd, now[tp]!.chargedUsd, now[tp]!.waivedUsd], ['2.500000', '0.000000', '1.700000', '0.800000']);
  const after = await feeLedger(t.db, funded);
  assert.deepEqual([dueInLedger(after.rows), after.pending], [0n, undefined]);
  const [record] = await t.db.select().from(orderFeeSettlements).where(eq(orderFeeSettlements.signature, signature));
  assert.deepEqual([record!.status, record!.settledAt?.getTime()], ['confirmed', (Math.floor(NOW / 1000) + 9) * 1000]);
  // What the payout review subtracts: the fees charged since the last paid payout's request (the program's clock).
  assert.deepEqual(await Promise.all([null, new Date(NOW), new Date(NOW + 60_000)].map((since) => chargedSince(t.db, funded, since))), [4_200_000n, 4_200_000n, 0n]);
  const ledgerRows = await t.db.select().from(vaultLedger).where(eq(vaultLedger.signature, signature));
  assert.deepEqual(ledgerRows.map((l) => [l.event, l.direction, l.amountUsd, l.account]), [['Order fees', 'in', '4.200000', funded]]);
  const activity = await t.db.select().from(accountEvents).where(eq(accountEvents.accountId, funded));
  assert.ok(activity.some((a) => a.type === 'charge' && a.detail === '4.2 USDC of order fees charged to the fee vault, 0.8 USDC waived; 0 USDC still due.'));

  // A settlement this server did not send (the risk-key fallback script) is spread over the due rows, oldest first,
  // its charge first to what executed orders owe.
  const late = key();
  await apply('orderRequested', { ...order(late, { market: {} }, 5_000n * USD), ...fee(1_500_000n) });
  await apply('synced', { funded: pk(funded), slots: [], ordersDropped: [pk(late)], ts: ts(10) });
  await t.db.update(gmOrders).set({ status: 'executed' }).where(eq(gmOrders.address, late));
  const external = await apply('orderFeesSettled', { ...settled, charged: new BN(1_000_000), waived: new BN(0), orderFeesDue: new BN(500_000), ts: ts(11) });
  now = await rows();
  assert.deepEqual([now[late]!.chargedUsd, now[late]!.waivedUsd], ['1.000000', '0.000000']);
  assert.equal(dueInLedger((await feeLedger(t.db, funded)).rows), 500_000n, 'in step with the chain again');
  const [outside] = await t.db.select().from(orderFeeSettlements).where(eq(orderFeeSettlements.signature, external));
  assert.deepEqual([outside!.status, outside!.sentBy, outside!.chargeUsd], ['confirmed', settled.by.toBase58(), '1.000000']);
});

test('each fill carries its order\'s fee: the rate of its latest assessment on what executed, never above the assessment; none for an order the account did not place', async () => {
  const { funded } = await fundedAccount();
  const [open, tp, legacy, stranger] = [key(), key(), key(), key()];
  const order = (address: string, isIncrease: boolean) => ({
    address, fundedAccount: funded, marketToken: sol.marketToken, symbol: 'SOL', side: 'Long' as const, kind: isIncrease ? 'Market' as const : 'TakeProfit' as const,
    isIncrease, sizeUsd: '10000', status: 'awaiting_execution' as const, createSignature: 's', createdAt: new Date(),
  });
  await t.db.insert(gmOrders).values([order(open, true), order(tp, false), order(legacy, true)]);
  await t.db.insert(orderFees).values([
    { order: open, fundedAccount: funded, isIncrease: true, assessedUsd: '2.5', rateUsd: '0.5', rateBps: 2, state: 'assessed', updatedSlot: 1 },
    { order: tp, fundedAccount: funded, isIncrease: false, assessedUsd: '2.5', rateUsd: '0.5', rateBps: 2, state: 'assessed', updatedSlot: 1 },
  ]);
  assert.equal(await fillFee(t.db, open, 10_000n * USD), 2_500_000n);
  assert.equal(await fillFee(t.db, tp, 4_000n * USD), 1_300_000n);
  // A second fill of the same order carries only what its total adds: min(2.5, 0.5 + 2 bps of $10,000) − 1.3.
  await t.db.insert(venueFills).values({
    signature: 'f1', eventIndex: 0, venueId: `000000000002-${funded.slice(0, 5)}-000001-000000-000001`, slot: 1, fundedAccount: funded, position: 'p', order: tp,
    symbol: 'SOL', side: 'Long', isIncrease: false, sizeUsd: '4000', sizeAfterUsd: '6000', price: '150', feeUsd: '0.4', priceImpactUsd: '0', fundingUsd: '0',
    borrowUsd: '0', realizedPnl: '1', platformFeeUsd: '1.3', ts: new Date(),
  });
  assert.equal(await fillFee(t.db, tp, 6_000n * USD), 1_200_000n);
  assert.equal(await fillFee(t.db, legacy, 10_000n * USD), 0n, 'placed before the fee existed');
  assert.equal(await fillFee(t.db, stranger, 10_000n * USD), null, 'not seen by the indexer (not yet, or never: deleveraging)');

  // A round trip nets the Props fees like every other cost.
  const fills = [
    { isIncrease: true, sizeUsd: '10000', sizeAfterUsd: '10000', feeUsd: '1', fundingUsd: '0', borrowUsd: '0', realizedPnl: null, platformFeeUsd: '2.5' },
    { isIncrease: false, sizeUsd: '10000', sizeAfterUsd: '0', feeUsd: '1', fundingUsd: '0.1', borrowUsd: '0.2', realizedPnl: '50', platformFeeUsd: '2.5' },
  ].map((f, i) => ({
    ...f, signature: `s${i}`, eventIndex: 0, venueId: `v${i}`, slot: i, fundedAccount: funded, position: 'p', order: null, symbol: 'SOL', side: 'Long' as const,
    price: '150', priceImpactUsd: '0', ts: new Date(NOW + i),
  }));
  const trip = roundTrip(funded, fills);
  assert.deepEqual([trip.platformFeeUsd, trip.feesUsd, trip.netPnl], ['5', '7.3', '44'], '50 − the open\'s 1 − 5 of Props fees');
});

test('the rate every stage reads: the server\'s settings until the program is initialized, the Config\'s after, kept through a failed read', async () => {
  const client = offlineClient();
  let config: 'none' | 'set' | 'down' = 'none';
  let reads = 0;
  const onchain = { orderFeeUsdc: new BN(500_000), orderFeeBps: 2 };
  client.fetchConfig = (async () => {
    reads++;
    if (config === 'down') throw new Error('fetch failed');
    return config === 'set' ? onchain : null;
  }) as never;
  const serverRate = { feeUsdc: 250_000n, feeBps: 1, source: 'server' as const };
  const reader = createProgramReader({ db: t.db, rpc: {} as never, client, programId: PROPS_VAULT_PROGRAM_ID, cluster: 'localnet', serverRate });
  assert.deepEqual(await reader.orderFeeRate(), serverRate);
  assert.deepEqual(await reader.orderFeeRate(), serverRate);
  assert.equal(reads, 1, 'not initialized is cached like a Config (no RPC read per quote)');
  config = 'set';
  reader.changed([{ name: 'configChanged', data: { change: 'orderFee' } } as unknown as VaultEvent]);
  await reader.orderFeeRate(); // the last rate at once while the new read runs
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await reader.orderFeeRate(), { feeUsdc: 500_000n, feeBps: 2, source: 'program' });
  config = 'down';
  reader.changed([{ name: 'configChanged', data: { change: 'orderFee' } } as unknown as VaultEvent]);
  await reader.orderFeeRate();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await reader.orderFeeRate(), { feeUsdc: 500_000n, feeBps: 2, source: 'program' }, 'an RPC failure keeps the program\'s rate');
});

test('funded valuation and margin: executed orders\' fees come off the value, the fees the program holds off the available margin', async () => {
  const { funded } = await fundedAccount();
  const provider = createFundedProvider({ db: t.db, venue: {} as Venue, program: {} as ProgramReader });
  const [r] = await t.db.select().from(accounts).innerJoin(fundedAccounts, eq(fundedAccounts.address, accounts.id)).where(eq(accounts.id, funded));
  // 480 USDC in the account, 20 in a pending increase; 2.5 owed by an executed open not synced yet; the program holds
  // 1.3 due plus the pending increase's 2.1.
  const v: Valuation = {
    funded, at: Date.now(), status: 'active', ownerUsdc: 480_000_000n, pendingCollateral: 20_000_000n, positions: [], pendingOrders: 1, flat: false,
    freshness: 'live', fees: { owed: 2_500_000n, due: 1_300_000n, paid: 4_200_000n, held: 3_400_000n },
  };
  assert.equal(money(v, 500_000_000n).value, (500_000_000n - 2_500_000n) * 10n ** 14n);
  const s = await provider.summaryOf(r!.accounts, r!.funded_accounts, v);
  assert.deepEqual([s.equity, s.realizedPnl, s.availableMargin, s.platformFees], ['9997.5', '-2.5', '476.6', { dueUsd: '1.3', paidUsd: '4.2', heldUsd: '3.4' }]);
});

const pk = (k: string) => new PublicKey(k);
const placed = (funded: string, trader: string, order: string, size: bigint, micro: bigint) => ({
  funded: pk(funded), order: pk(order), marketToken: pk(sol.marketToken), isLong: true, orderType: { market: {} }, sizeDeltaUsd: new BN(size.toString()),
  collateral: new BN(100_000_000), triggerPrice: new BN(0), acceptablePrice: new BN(10).pow(new BN(13)), by: pk(trader), ts: ts(0), ...fee(micro),
});
const settledEvent = (funded: string, charged: bigint, paid: bigint) => ({
  funded: pk(funded), charged: new BN(charged.toString()), waived: new BN(0), orderFeesDue: new BN(0), orderFeesPaid: new BN(paid.toString()), by: pk(key()), ts: ts(2),
});
/** A fill as the exchange's indexer reports it. */
const tradeOf = (o: { id: number; owner: string; order: string; isIncrease: boolean; at: number; before: bigint; after: bigint }): TradeEvent => ({
  id: `${String(700_000_000 + o.id).padStart(12, '0')}-FEES-000001-000000-000001`, ts: o.at, slot: o.id, marketToken: sol.marketToken, user: o.owner, position: key(), order: o.order,
  isLong: true, isCollateralLong: false, isIncrease: o.isIncrease, isLiquidation: false, executionPrice: 150n * 10n ** 11n, priceImpactValue: 0n,
  before: { sizeInUsd: o.before, sizeInTokens: 0n, collateralAmount: 0n }, after: { sizeInUsd: o.after, sizeInTokens: 0n, collateralAmount: 0n },
  pnl: 0n, fees: { order: 0n, liquidation: 0n, borrowing: 0n, funding: 0n },
  prices: { index: { min: 1n, max: 1n }, long: { min: 10n ** 14n, max: 10n ** 14n }, short: { min: 10n ** 14n, max: 10n ** 14n } }, outputAmount: 0n, secondaryOutputAmount: 0n,
});
const venueOf = (trades: () => TradeEvent[]) => createVenue({
  db: t.db, rpc: {} as never, client: offlineClient(), reader, log: silentLog, notify: async () => {},
  gm: { trades: async (_o, afterId) => trades().filter((e) => !afterId || e.id > afterId), signatures: async (ids) => new Map(ids.map((i) => [i, `sig-${i}`])), removals: async () => [] } satisfies GmIndexer,
});

test('the ledger is in step only when it accounts for every settlement and charge the chain shows, not just the fees due', async () => {
  const { trader, funded } = await fundedAccount();
  const [tp, sl] = [key(), key()];
  for (const o of [tp, sl]) await apply('orderRequested', placed(funded, trader, o, 10_000n * USD, 2_500_000n));
  await apply('synced', { funded: pk(funded), slots: [], ordersDropped: [pk(tp)], ts: ts(1) });
  await t.db.update(gmOrders).set({ status: 'executed' }).where(eq(gmOrders.address, tp));
  // An operator settles the take profit by hand (charged 2.5: one settlement, paid 2.5) and the stop loss's equal fee
  // becomes due before the indexer applies that settlement: the fees due alone look in step (2.5 = 2.5).
  const stale = await feeLedger(t.db, funded);
  const chain = { due: 2_500_000n, paid: 2_500_000n, settlements: 1n };
  assert.equal(dueInLedger(stale.rows), chain.due);
  assert.equal(inStep(stale, chain), false, 'the landed settlement is not in the ledger yet: nothing is planned from it');
  await apply('orderFeesSettled', settledEvent(funded, 2_500_000n, 2_500_000n));
  await apply('synced', { funded: pk(funded), slots: [], ordersDropped: [pk(sl)], ts: ts(3) });
  assert.equal(inStep(await feeLedger(t.db, funded), chain), true);
});

test('two accounts settled in one transaction (an operators\' batch): each settlement reaches its own ledger', async () => {
  const [a, b] = [await fundedAccount(), await fundedAccount()];
  for (const f of [a, b]) {
    const order = key();
    await apply('orderRequested', placed(f.funded, f.trader, order, 10_000n * USD, 2_500_000n));
    await apply('synced', { funded: pk(f.funded), slots: [], ordersDropped: [pk(order)], ts: ts(1) });
    await t.db.update(gmOrders).set({ status: 'executed' }).where(eq(gmOrders.address, order));
  }
  const signature = key();
  await apply('orderFeesSettled', settledEvent(a.funded, 2_500_000n, 2_500_000n), signature, 0);
  await apply('orderFeesSettled', settledEvent(b.funded, 2_500_000n, 2_500_000n), signature, 1);
  for (const f of [a, b]) {
    const ledger = await feeLedger(t.db, f.funded);
    assert.deepEqual([dueInLedger(ledger.rows), feesOwed(ledger.rows), ledger.settled], [0n, 0n, { count: 1n, charged: 2_500_000n }]);
  }
});

test('one account settled twice in one transaction (a hand-built batch): both settlements reach its ledger, which stays in step; neither applies twice', async () => {
  const { trader, funded } = await fundedAccount();
  const order = key();
  await apply('orderRequested', placed(funded, trader, order, 10_000n * USD, 2_500_000n));
  await apply('synced', { funded: pk(funded), slots: [], ordersDropped: [pk(order)], ts: ts(1) });
  await t.db.update(gmOrders).set({ status: 'executed' }).where(eq(gmOrders.address, order));
  // [settle(charge 1, expected due 2.5, count 0), settle(charge 1, waive 0.5, expected due 1.5, count 1)]: events 0 and 1 of
  // one transaction.
  const signature = key();
  await apply('orderFeesSettled', { ...settledEvent(funded, 1_000_000n, 1_000_000n), orderFeesDue: new BN(1_500_000) }, signature, 0);
  await apply('orderFeesSettled', { ...settledEvent(funded, 1_000_000n, 2_000_000n), waived: new BN(500_000) }, signature, 1);
  const chain = { due: 0n, paid: 2_000_000n, settlements: 2n };
  const check = async () => {
    const ledger = await feeLedger(t.db, funded);
    const [row] = await t.db.select().from(orderFees).where(eq(orderFees.order, order));
    assert.deepEqual([dueInLedger(ledger.rows), ledger.settled, inStep(ledger, chain), row!.chargedUsd, row!.waivedUsd], [0n, { count: 2n, charged: 2_000_000n }, true, '2.000000', '0.500000']);
    assert.equal(await chargedSince(t.db, funded, null), 2_000_000n, 'the payout review counts both charges');
  };
  await check();
  // The second event applied again (a bug past program_events) applies nothing.
  const again = await t.db.transaction((tx) => confirmSettlement(tx, { signature, funded, charged: 1_000_000n, waived: 500_000n, by: key(), at: new Date(), eventIndex: 1 }));
  assert.deepEqual(again, []);
  await check();
});

test('a decrease is charged the rate of its latest assessment on what it executed, even when its fill was indexed before that assessment', async () => {
  const { trader, funded } = await fundedAccount();
  const tp = key();
  // A close-all take profit on a $4,000 position, assessed 10.50 at 0.50 + 10 bps on the $10,000 cap; the rate falls to
  // 0.50 + 2 bps and a trigger edit re-assesses it at 2.50; it fires, and its fill is indexed before that update.
  await apply('protectionSet', {
    funded: pk(funded), order: pk(tp), marketToken: pk(sol.marketToken), isLong: true, orderType: { takeProfit: {} }, sizeDeltaUsd: new BN(CLOSE_ALL.toString()),
    triggerPrice: new BN(10).pow(new BN(13)), ts: ts(0), ...fee(10_500_000n, { feeUsdc: 500_000n, feeBps: 10 }),
  });
  const owner = key();
  const venue = venueOf(() => [tradeOf({ id: 1, owner, order: tp, isIncrease: false, at: Date.now(), before: 4_000n * USD, after: 0n })]);
  assert.equal(await venue.syncFills(funded, owner, trader), 1);
  await apply('orderUpdated', { funded: pk(funded), order: pk(tp), sizeDeltaUsd: null, triggerPrice: new BN(1), acceptablePrice: null, ts: ts(1), ...fee(2_500_000n) });
  await apply('completedOrderClosed', { funded: pk(funded), order: pk(tp), ts: ts(2), cancelled: false });
  const plan = planSettlement((await feeLedger(t.db, funded)).rows, { balance: 10n ** 9n, now: Date.now() });
  assert.deepEqual([plan.charge, plan.waive], [1_300_000n, 1_200_000n], 'min(2.50, 0.50 + 2 bps of $4,000)');
});

test('a fill of an order the account could not have placed (deleveraging) carries no fee and holds back nothing; one of its own recent orders waits', async () => {
  const { trader, funded } = await fundedAccount();
  const owner = Keypair.generate().publicKey;
  const own = gmOrderPda(owner, orderNonce(5n)).toBase58(); // its 6th order, placed after the read below
  const trades = [
    tradeOf({ id: 11, owner: owner.toBase58(), order: key(), isIncrease: false, at: Date.now() - 60_000, before: 5_000n * USD, after: 0n }),
    tradeOf({ id: 12, owner: owner.toBase58(), order: own, isIncrease: true, at: Date.now(), before: 0n, after: 1_000n * USD }),
  ];
  const venue = venueOf(() => trades);
  assert.equal(await venue.syncFills(funded, owner.toBase58(), trader, 5n), 1, 'the deleveraging fill at once (fee 0); its own order\'s fill waits for the order');
  const [adl] = await t.db.select().from(venueFills).where(eq(venueFills.fundedAccount, funded));
  assert.equal(adl!.platformFeeUsd, '0.000000');
  await apply('orderRequested', placed(funded, trader, own, 1_000n * USD, 700_000n));
  assert.equal(await venue.syncFills(funded, owner.toBase58(), trader, 6n), 1);
  const [mine] = await t.db.select().from(venueFills).where(eq(venueFills.order, own));
  assert.equal(mine!.platformFeeUsd, '0.700000');
});
