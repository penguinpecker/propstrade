// Funded accounts on GMTrade: fills, round trips and order statuses from GMTrade's indexer, and valuation with the
// GMTrade model. Fills are a real SOL/USD[USDC-USDC] round trip (owner 9g5koy…, 6 fills, captured from GMTrade's
// subsquid on 2026-09-23); the valuation runs on the real mainnet market snapshot the gmsol-wasm tests use.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import BN from 'bn.js';
import { eq } from 'drizzle-orm';
import { ORDER_DISCRIMINATOR, PROPS_VAULT_PROGRAM_ID, decodeGmPosition, ownerPda, ownerUsdcAddress } from '@props/sdk';
import type { OrderRemoval, TradeEvent } from '@props/gmtrade';
import { model, type ModelInput } from '@props/gmsol-wasm';
import { accountEvents, accounts, closedTrades, evaluations, fundedAccounts, gmOrders, venueFills } from '../../../db/schema.ts';
import { createFundedProvider, money } from '../funded.ts';
import type { ProgramReader } from '../program.ts';
import type { Notice } from '../projector.ts';
import type { ChainReader } from '../reader.ts';
import { createVenue, eventIndexOf, fillRow, readFundedState, roundTrip, valueFunded, type GmIndexer, type Valuation } from '../venue.ts';
import { encodeAccount, freshDb, offlineClient, silentLog } from './support.ts';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MARKET = '6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc';
const USD = 10n ** 20n;
type Trip = (TradeEvent & { signature: string })[];
const trip: Trip = JSON.parse(readFileSync(new URL('fixtures/sol-round-trip.json', import.meta.url), 'utf8'),
  (_k, v) => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
const sol = { marketToken: SOL_MARKET, symbol: 'SOL', indexToken: 'So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH', decimals: 9 };
const reader: ChainReader = { evaluation: async () => { throw new Error('unused'); }, market: async () => sol };
const key = () => Keypair.generate().publicKey.toBase58();

let t: Awaited<ReturnType<typeof freshDb>>;
before(async () => {
  t = await freshDb('chain_venue');
});
after(async () => {
  await t.sql.end();
});

/** A funded account row set as the indexer writes it at activation. */
async function fundedAccount(trader = key()) {
  const [evaluation, funded, owner] = [key(), key(), key()];
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
  return { funded, owner, trader, evaluation };
}

function venueWith(gm: GmIndexer, notices: Notice[] = []) {
  return createVenue({ db: t.db, rpc: {} as never, client: offlineClient(), reader, gm, log: silentLog, notify: async (n) => void notices.push(n) });
}

test('a GMTrade round trip nets exactly what the owner\'s USDC did', () => {
  assert.equal(eventIndexOf('000449474290-DnUCQ-000059-000003-000006'), 30_006);
  assert.throws(() => eventIndexOf('garbage'), /unexpected GMTrade event id/);
  const fills = trip.map((e) => ({ ...fillRow(e, 'F', sol, e.signature), fundedAccount: 'F' }));
  assert.deepEqual(fills.map((f) => [f.isIncrease, f.sizeUsd, f.sizeAfterUsd]), [
    [true, '42000', '42000'], [true, '10000', '52000'], [true, '9030', '61030'], [false, '28529.588013', '32500.411987'],
    [true, '15000', '47500.411987'], [false, '47500.411987', '0'],
  ]);
  assert.equal(fills[0]!.realizedPnl, null);
  const trade = roundTrip('F', fills.map((f) => ({ ...f, ts: f.ts })));

  // Independent check: the owner's USDC flows at each fill's collateral price (in: collateral posted incl. fees; out: outputs).
  let cash = 0n;
  for (const e of trip) {
    const px = e.isCollateralLong ? e.prices.long.min : e.prices.short.min;
    cash += e.isIncrease
      ? -(e.after.collateralAmount - e.before.collateralAmount + e.fees.order + e.fees.borrowing + e.fees.funding) * px
      : (e.outputAmount + e.secondaryOutputAmount) * px;
  }
  const net = Number(trade.netPnl);
  assert.ok(Math.abs(net - Number(cash) / 1e20) < 0.02, `net ${net} vs cash ${Number(cash) / 1e20}`);
  assert.ok(net < -391 && net > -392);
  assert.equal(trade.sizeUsd, '61030');
  assert.deepEqual(trade.signatures, [...new Set(trip.map((e) => e.signature))]);
  const incPrices = trip.filter((e) => e.isIncrease).map((e) => Number(e.executionPrice) / 1e11);
  assert.ok(Number(trade.entryPrice) > Math.min(...incPrices) && Number(trade.entryPrice) < Math.max(...incPrices));
});

test('fills sync: resumes where GMTrade\'s indexer stops, writes the round trip once', async () => {
  const { funded, owner, trader } = await fundedAccount();
  const signatures = new Map(trip.map((e) => [e.id, e.signature]));
  signatures.delete(trip[3]!.id); // the indexer has not linked the 4th fill to its transaction yet
  const asked: (string | undefined)[] = [];
  const gm: GmIndexer = {
    async trades(user, afterId) {
      assert.equal(user, owner);
      asked.push(afterId);
      // Older fills an hour+ ago, the closing fill just now: only news is notified.
      return trip.filter((e) => !afterId || e.id > afterId)
        .map((e) => ({ ...e, user: owner, ts: e.id === trip[5]!.id ? Date.now() : Date.now() - 86_400_000 + trip.indexOf(e) }));
    },
    async signatures(ids) {
      return new Map(ids.flatMap((id) => (signatures.has(id) ? [[id, signatures.get(id)!]] : [])));
    },
    async removals() {
      return [];
    },
  };
  const notices: Notice[] = [];
  const venue = venueWith(gm, notices);
  assert.equal(await venue.syncFills(funded, owner, trader), 3);
  assert.equal((await t.db.select().from(closedTrades).where(eq(closedTrades.accountId, funded))).length, 0);

  signatures.set(trip[3]!.id, trip[3]!.signature);
  assert.equal(await venue.syncFills(funded, owner, trader), 3);
  assert.equal(await venue.syncFills(funded, owner, trader), 0);
  assert.deepEqual(asked, [undefined, trip[2]!.id, trip[5]!.id]);

  const fills = await t.db.select().from(venueFills).where(eq(venueFills.fundedAccount, funded)).orderBy(venueFills.venueId);
  assert.deepEqual(fills.map((f) => f.venueId), trip.map((e) => e.id));
  const [closed, ...more] = await t.db.select().from(closedTrades).where(eq(closedTrades.accountId, funded));
  assert.equal(more.length, 0);
  assert.deepEqual([closed!.symbol, closed!.side, closed!.venue, closed!.sizeUsd], ['SOL', trip[0]!.isLong ? 'Long' : 'Short', 'gmtrade', '61030.000000']);
  assert.equal(Number(closed!.netPnl), Number(roundTrip(funded, fills).netPnl));
  const activity = await t.db.select().from(accountEvents).where(eq(accountEvents.accountId, funded));
  assert.equal(activity.length, 6);
  assert.ok(activity.every((a) => a.type === 'fill' && a.signature && !a.simulated));
  assert.deepEqual(notices.map((n) => [n.wallet, n.kind, n.title]), [[trader, 'fill', `${trip[5]!.isLong ? 'Long' : 'Short'} SOL closed`]]);
});

test('order sync: the order account, then GMTrade\'s removal record, decide executed or canceled; unknown until known', async () => {
  const { funded } = await fundedAccount();
  const [filled, rejected, pending, stuck, unindexed] = [key(), key(), key(), key(), key()];
  const order = (address: string) => ({
    address, fundedAccount: funded, marketToken: SOL_MARKET, symbol: 'SOL', side: 'Long' as const, kind: 'Market' as const, isIncrease: true,
    sizeUsd: '100', collateralUsd: '10', acceptablePrice: '200', status: 'awaiting_execution' as const, createSignature: 'create', createdAt: new Date(),
  });
  await t.db.insert(gmOrders).values([filled, rejected, pending, stuck, unindexed].map(order));
  // GMTrade Order accounts: state byte 9 = 0 pending, 1 completed (still open: its escrow ATA was missing).
  const orderAccount = (state: number) => {
    const data = Buffer.alloc(2_200);
    Buffer.from(ORDER_DISCRIMINATOR).copy(data);
    data[9] = state;
    return { data, owner: new PublicKey('Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo'), lamports: 1, executable: false, rentEpoch: 0 };
  };
  const onchain = new Map([[pending, orderAccount(0)], [stuck, orderAccount(1)]]);
  const rpc = { getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({ context: { slot: 1 }, value: keys.map((k) => onchain.get(k.toBase58()) ?? null) }) };
  const removals: OrderRemoval[] = [
    { id: '1', order: filled, kind: 'MarketIncrease', state: 'Completed', reason: 'executed', ts: Date.now(), slot: 1 },
    { id: '2', order: rejected, kind: 'MarketIncrease', state: 'Cancelled', reason: 'executed', ts: Date.now(), slot: 1 },
  ];
  const venue = createVenue({
    db: t.db, rpc: rpc as never, client: offlineClient(), reader, log: silentLog, notify: async () => {},
    gm: { trades: async () => [], signatures: async () => new Map(), removals: async (orders) => removals.filter((r) => orders.includes(r.order)) },
  });
  await venue.syncOrders(funded);
  const by = Object.fromEntries((await t.db.select().from(gmOrders).where(eq(gmOrders.fundedAccount, funded))).map((o) => [o.address, o]));
  assert.equal(by[filled]!.status, 'executed');
  assert.deepEqual([by[rejected]!.status, by[rejected]!.statusDetail], ['canceled', 'GMTrade could not execute this order (executed)']);
  assert.deepEqual([by[pending]!.status, by[pending]!.closedAt], ['awaiting_execution', null]);
  assert.equal(by[stuck]!.status, 'executed');
  assert.equal(by[unindexed]!.status, 'unknown');
  assert.ok(by[unindexed]!.closedAt);

  removals.push({ id: '3', order: unindexed, kind: 'MarketIncrease', state: 'Completed', reason: 'executed', ts: Date.now(), slot: 2 });
  await venue.syncOrders(funded);
  const [resolved] = await t.db.select().from(gmOrders).where(eq(gmOrders.address, unindexed));
  assert.equal(resolved!.status, 'executed', 'a later removal record resolves an unknown order');
});

/** The SOL[USDC-USDC] mainnet snapshot with its clocks a day ahead, so accrual is a no-op and results are exact. */
function solMarket(): ModelInput {
  const f = JSON.parse(readFileSync(new URL('../../../../../packages/gmsol-wasm/test/fixtures/sol-usdc-usdc.json', import.meta.url), 'utf8'));
  const p = (k: string) => ({ min: BigInt(f.prices[k].min), max: BigInt(f.prices[k].max) });
  const market = Buffer.from(f.market, 'base64');
  for (const at of [4024, 4032, 4040]) market.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 86_400), at);
  return { market: market.toString('base64'), virtualInventories: f.virtualInventories, prices: { index: p('index'), long: p('long'), short: p('short') } };
}

test('funded valuation: equity = size − allowance + value, with the GMTrade model at live prices', async () => {
  const { funded, trader } = await fundedAccount();
  const m = solMarket();
  const open = model.simulateIncrease({ market: m, isLong: true, collateralToken: USDC, collateralAmount: 500_000_000n, sizeDeltaUsd: 10_000n * USD });
  const up = { ...m, prices: { ...m.prices, index: { min: (m.prices.index.min * 101n) / 100n, max: (m.prices.index.max * 101n) / 100n } } };
  const status = model.positionStatus(up, open.position.account);
  const position = decodeGmPosition(Buffer.from(open.position.account, 'base64'));
  const v: Valuation = {
    funded, at: Date.now(), status: 'active', ownerUsdc: 0n, pendingCollateral: 0n, pendingOrders: 0, flat: false, freshness: 'live',
    positions: [{ address: key(), market: sol, isLong: true, position, status, mark: up.prices.index.min }],
  };

  const principal = 500_000_000n;
  const cash = money(v, principal);
  const collateral = position.collateralAmount * 10n ** 14n;
  assert.equal(cash.value, status.netValue);
  assert.equal(cash.unrealized, status.netValue - collateral);
  assert.equal(cash.realized, collateral - principal * 10n ** 14n, 'realized so far = the open fee taken from the collateral');
  assert.ok(cash.realized < 0n && cash.realized > -5n * USD);
  assert.ok(status.pendingPnl > 90n * USD && status.pendingPnl < 110n * USD, 'a 1% move on $10k');

  const provider = createFundedProvider({ db: t.db, venue: venueWith({ trades: async () => [], signatures: async () => new Map(), removals: async () => [] }), program: {} as ProgramReader });
  const [row] = await t.db.select().from(accounts).innerJoin(fundedAccounts, eq(fundedAccounts.address, accounts.id)).where(eq(accounts.id, funded));
  const s = await provider.summaryOf(row!.accounts, row!.funded_accounts, v);
  const usd = (x: bigint) => Number(x) / 1e20;
  assert.equal(Number(s.equity), Number((9_500 + usd(status.netValue)).toFixed(6)));
  assert.equal(Number(s.allowanceRemaining), Number(usd(status.netValue).toFixed(6)));
  assert.deepEqual([s.stage, s.status, s.openNotional, s.availableMargin, s.eligiblePayout, s.freshness, s.rules.floorUsd, s.rules.lossAllowanceUsd],
    ['funded', 'active', '10000', '0', '0', 'live', '9500', '500']);
  assert.equal(s.evidence.funded, funded);
  assert.equal((await provider.list(trader)).length, 1);

  const [p] = await provider.positionsOf(v, funded);
  assert.deepEqual([p!.symbol, p!.side, p!.sizeUsd, p!.venue], ['SOL', 'Long', '10000', 'gmtrade']);
  assert.ok(Math.abs(Number(p!.entryPrice) - Number(open.executionPrice) / 1e11) < 1e-6, `entry ${p!.entryPrice}`);
  assert.ok(Math.abs(p!.leverage - 10_000 / usd(status.netValue)) < 0.001, `leverage ${p!.leverage} = size / net value`);
  assert.ok(Number(p!.liquidationPrice) < Number(p!.entryPrice));
  assert.equal(Number(p!.unrealizedPnl), Number(usd(status.pendingPnl).toFixed(6)));
});

test('lamports sent to a closed GMTrade address do not make it a GMTrade account: no position, the order is gone', async () => {
  const client = offlineClient();
  const [funded, position, order] = [Keypair.generate().publicKey, key(), key()];
  const zero = new BN(0);
  const free = { marketToken: PublicKey.default, gmPosition: PublicKey.default, isLong: false, collateral: zero, sizeUsd: zero, pendingUsd: zero, lastSync: zero };
  const freeOrder = { order: PublicKey.default, slot: 0, orderType: { market: {} }, sizeUsd: zero, collateral: zero, placedByRisk: false };
  const data = encodeAccount(client, 'fundedAccount', {
    trader: Keypair.generate().publicKey, evaluation: Keypair.generate().publicKey,
    terms: { sizeUsd: new BN(10_000_000_000), profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000, termsHash: Array(32).fill(1), tierVersion: 1 },
    principal: new BN(500_000_000), status: { active: {} },
    slots: [{ ...free, marketToken: new PublicKey(SOL_MARKET), gmPosition: new PublicKey(position), isLong: true, pendingUsd: new BN(100).mul(new BN(10).pow(new BN(20))) }, ...Array(7).fill(free)],
    orders: [{ ...freeOrder, order: new PublicKey(order), sizeUsd: new BN(100).mul(new BN(10).pow(new BN(20))), collateral: new BN(20_000_000) }, ...Array(7).fill(freeOrder)],
    orderSeq: new BN(1), payoutsPaid: zero, payoutSeq: 0, createdAt: zero, lastSyncAt: zero, bump: 255, ownerBump: 255,
  });
  const usdc = Buffer.alloc(165);
  usdc.writeBigUInt64LE(480_000_000n, 64);
  const system = (lamports: number) => ({ data: Buffer.alloc(0), owner: SystemProgram.programId, lamports, executable: false, rentEpoch: 0 });
  const accounts = new Map([
    [funded.toBase58(), { data, owner: PROPS_VAULT_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 }],
    [ownerUsdcAddress(funded).toBase58(), { data: usdc, owner: new PublicKey(USDC), lamports: 1, executable: false, rentEpoch: 0 }],
    [ownerPda(funded).toBase58(), system(250_000_000)], [position, system(1)], [order, system(1)],
  ]);
  const rpc = { getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({ context: { slot: 9 }, value: keys.map((k) => accounts.get(k.toBase58()) ?? null) }) };
  const d = { rpc: rpc as never, client, reader, log: silentLog };
  const state = (await readFundedState(d, funded.toBase58()))!;
  assert.deepEqual([state.positions, state.orders.map((o) => o.state), state.ownerUsdc, state.ownerLamports], [[], ['missing'], 480_000_000n, 250_000_000n]);
  const v = await valueFunded(d, funded.toBase58(), state);
  assert.deepEqual([v.positions, v.pendingCollateral, v.pendingOrders, v.freshness], [[], 0n, 0, 'live'], 'a vanished order escrows nothing');
});

test('an account is read at one slot: USDC GMTrade refunds as it closes an order is never missed between two reads', async () => {
  const client = offlineClient();
  const funded = Keypair.generate().publicKey;
  const zero = new BN(0);
  const free = { marketToken: PublicKey.default, gmPosition: PublicKey.default, isLong: false, collateral: zero, sizeUsd: zero, pendingUsd: zero, lastSync: zero };
  const freeOrder = { order: PublicKey.default, slot: 0, orderType: { market: {} }, sizeUsd: zero, collateral: zero, placedByRisk: false };
  const tenK = new BN(10_000).mul(new BN(10).pow(new BN(20)));
  const fundedData = (orders: PublicKey[]) => encodeAccount(client, 'fundedAccount', {
    trader: PublicKey.default, evaluation: PublicKey.default,
    terms: { sizeUsd: new BN(10_000_000_000), profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000, termsHash: Array(32).fill(1), tierVersion: 1 },
    principal: new BN(500_000_000), status: { active: {} },
    slots: [{ ...free, marketToken: new PublicKey(SOL_MARKET), gmPosition: Keypair.generate().publicKey, isLong: true, pendingUsd: tenK }, ...Array(7).fill(free)],
    orders: [...orders.map((order) => ({ ...freeOrder, order, sizeUsd: tenK, collateral: new BN(500_000_000) })), ...Array(8 - orders.length).fill(freeOrder)],
    orderSeq: new BN(1), payoutsPaid: zero, payoutSeq: 0, createdAt: zero, lastSyncAt: zero, bump: 255, ownerBump: 255,
  });
  const info = (data: Buffer, owner: PublicKey) => ({ data, owner, lamports: 1, executable: false, rentEpoch: 0 });
  const usdc = (amount: bigint) => {
    const data = Buffer.alloc(165);
    data.writeBigUInt64LE(amount, 64);
    return info(data, new PublicKey(USDC));
  };
  const gmOrder = () => {
    const data = Buffer.alloc(2_200);
    Buffer.from(ORDER_DISCRIMINATOR).copy(data);
    return info(data, new PublicKey('Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo'));
  };
  const [order, next] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const chain = new Map([
    [funded.toBase58(), info(fundedData([order]), PROPS_VAULT_PROGRAM_ID)], [ownerUsdcAddress(funded).toBase58(), usdc(0n)],
    [ownerPda(funded).toBase58(), info(Buffer.alloc(0), SystemProgram.programId)], [order.toBase58(), gmOrder()],
  ]);
  let slot = 10;
  const calls: { keys: number; minContextSlot?: number }[] = [];
  let afterCall: (() => void) | undefined;
  const rpc = {
    async getMultipleAccountsInfoAndContext(keys: PublicKey[], config?: { minContextSlot?: number }) {
      calls.push({ keys: keys.length, minContextSlot: config?.minContextSlot });
      const value = keys.map((k) => chain.get(k.toBase58()) ?? null);
      const context = { slot: slot++ };
      afterCall?.();
      afterCall = undefined;
      return { context, value };
    },
  };
  const d = { rpc: rpc as never, client, reader, log: silentLog };

  // The whole $500 allowance sits in a pending increase; GMTrade cancels it and refunds right after the first read.
  afterCall = () => {
    chain.delete(order.toBase58());
    chain.set(ownerUsdcAddress(funded).toBase58(), usdc(500_000_000n));
  };
  const refunded = (await readFundedState(d, funded.toBase58()))!;
  assert.deepEqual([refunded.ownerUsdc, refunded.orders.map((o) => o.state), refunded.slot], [500_000_000n, ['missing'], 11]);
  const v = await valueFunded(d, funded.toBase58(), refunded);
  assert.equal(v.ownerUsdc + v.pendingCollateral, 500_000_000n, 'the allowance is all there: no breach');
  assert.deepEqual(calls, [{ keys: 3, minContextSlot: undefined }, { keys: 5, minContextSlot: 10 }], 'the second read is no older than the first');

  // The account tracks another order between the reads: read again, so that order is not left out.
  calls.length = 0;
  chain.set(next.toBase58(), gmOrder());
  afterCall = () => chain.set(funded.toBase58(), info(fundedData([next]), PROPS_VAULT_PROGRAM_ID));
  const moved = (await readFundedState(d, funded.toBase58()))!;
  assert.deepEqual(moved.orders.map((o) => [o.tracked.order.toBase58(), o.state]), [[next.toBase58(), 'pending']]);
  assert.deepEqual(calls.map((c) => c.minContextSlot), [undefined, 12, 13]);
});
