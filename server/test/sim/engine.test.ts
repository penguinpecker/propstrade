// Practice + evaluation engine through its HTTP routes and SimService, on a real Postgres, priced by GMTrade's model on
// live GMTrade state and ticks recorded in fixtures/gmtrade-live.json (see harness.ts).
import { createHash, randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fill, Order, PriceTick, SimOrderRequest, SimOrderResponse } from '@props/shared';
import { USDC_MINT, decodeMarket, decodePosition, formatFixed } from '@props/gmtrade';
import { model, type ModelInput } from '@props/gmsol-wasm';
import { fromUnitPrice, toUnitPrice } from '@props/sdk';
import { accounts, equitySnapshots, notifications, simFills, simOrders, simPositions, simResults } from '../../src/db/schema.js';
import { tradesRoot } from '@props/shared/merkle';
import { stampPosition, triggered, withPosition } from '../../src/modules/sim/model.js';
import type { EvaluationResult } from '../../src/modules/types.js';
import { startSim, type Sim } from './harness.js';

let t: Sim;
const resolved: EvaluationResult[] = [];
beforeAll(async () => { t = await startSim('engine', { onResolved: (r) => resolved.push(r) }); });
afterAll(async () => { await t.stop(); });

type User = Awaited<ReturnType<Sim['user']>>;
const USD = 10n ** 20n;
const usdText = (v: bigint) => formatFixed(v, 20, 6);
const microText = (v: bigint) => formatFixed(v, 6, 6);
const practiceOf = (u: User) => `practice:${u.wallet}`;
const path = (id: string) => `/v1/sim/${encodeURIComponent(id)}`;
const clientId = () => `c-${randomUUID()}`;
const later = () => Date.now() + 2_500; // a tick newer than any seen, past the evaluation keeper delay for orders placed until now
const DECIMALS: Record<string, number> = { SOL: 9, BTC: 8, XAU: 8, EUR: 9, NVDA: 8 };

async function place(u: User, id: string, body: Partial<SimOrderRequest> = {}) {
  return u.post(`${path(id)}/orders`, {
    clientId: clientId(), symbol: 'SOL', side: 'Long', kind: 'Market', sizeUsd: '10000', collateralUsd: '500', slippageBps: 50, ...body,
  });
}
async function placed(u: User, id: string, body: Partial<SimOrderRequest> = {}) {
  const res = await place(u, id, body);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SimOrderResponse;
}
/** Resets the latest price of `symbol` to its last recorded tick (fresh), as a new quote before placing orders. */
const base = (symbol: string, session: PriceTick['session'] = 'open') => t.tick({ ...t.md.scaled(symbol, 1), session });
const at = (symbol: string, price: bigint, ts = later()): PriceTick => {
  const p = fromUnitPrice(price, DECIMALS[symbol]!);
  return { symbol, min: p, max: p, mid: p, ts, session: 'open' };
};
/** A quote whose min and max sit 0.01% either side of `price`: only a rule reading the right side of it fires. */
const straddle = (symbol: string, price: bigint): PriceTick => {
  const [min, max] = [fromUnitPrice((price * 9_999n) / 10_000n, DECIMALS[symbol]!), fromUnitPrice((price * 10_001n) / 10_000n, DECIMALS[symbol]!)];
  return { symbol, min, max, mid: fromUnitPrice(price, DECIMALS[symbol]!), ts: later(), session: 'open' };
};
const units = (tick: Pick<PriceTick, 'min' | 'max'>, symbol: string) =>
  ({ min: toUnitPrice(tick.min, DECIMALS[symbol]!), max: toUnitPrice(tick.max, DECIMALS[symbol]!) });
/** Model input as GMTrade would see the market; with `position`, the market that position is part of. */
async function input(symbol: string, index: { min: bigint; max: bigint }, position?: string): Promise<ModelInput> {
  const state = await t.md.marketState(t.md.market(symbol)!.marketToken);
  const raw = state.raw as { market: string; virtualInventories: Record<string, string> };
  const market = position ? withPosition(raw.market, position) : raw.market;
  return { market, virtualInventories: raw.virtualInventories, prices: { ...state.prices, index } };
}
const orders = async (u: User, id: string) => (await t.sim.orders(u.wallet, id))!;
const positions = async (u: User, id: string) => (await t.sim.positions(u.wallet, id))!;
const summary = async (u: User, id: string) => (await t.sim.detail(u.wallet, id))!;
const fills = async (u: User, id: string) => (await u.get(`${path(id)}/fills`)).json() as Fill[];
const modelAccount = async (positionId: string) =>
  ((await t.db.select().from(simPositions).where(eq(simPositions.id, positionId)))[0]!.modelState as { account: string }).account;

async function evaluation(u: User) {
  const id = Keypair.generate().publicKey.toBase58();
  const terms = { tierId: 2, sizeUsd: '25000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8_000, termsHash: 'ab'.repeat(32) };
  await t.sim.createEvaluation({ evaluation: id, wallet: u.wallet, terms, purchasedAt: Date.now(), signature: '4'.repeat(87) });
  return id;
}

/** The documented trades-root encoding (@props/shared/merkle), implemented independently: what any verifier would run. */
function recomputeRoot(list: Fill[]): string {
  const h = (b: Buffer | string) => createHash('sha256').update(b).digest();
  let level = [...list].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)).map((f) => h([
    f.id, f.symbol, f.side, f.isIncrease ? 'increase' : 'decrease', f.sizeUsd, f.price, f.feeUsd, f.priceImpactUsd, f.fundingUsd,
    f.borrowUsd, f.realizedPnl ?? '', String(f.ts),
  ].join('|')));
  if (!level.length) return '0'.repeat(64);
  while (level.length > 1) level = level.flatMap((x, i) => (i % 2 ? [] : [level[i + 1] ? h(Buffer.concat([x, level[i + 1]!])) : x]));
  return level[0]!.toString('hex');
}

describe('fills', () => {
  it('fills a practice market order on the first tick published after it, at the price GMTrade\'s model gives', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    const seen = t.md.price('SOL')!; // the latest tick when the order is placed
    const { order, account } = await placed(u, id);
    expect(order).toMatchObject({ status: 'awaiting_execution', kind: 'Market', isIncrease: true, sizeUsd: '10000', collateralUsd: '500' });
    expect(account.availableMargin).toBe('750'); // 1,250 allowance minus the 500 reserved by the pending order

    const [early, first] = t.md.recorded('SOL').slice(20, 22) as [PriceTick, PriceTick];
    await t.tick({ ...early, ts: seen.ts }); // a quote no newer than the one seen at the request
    expect((await orders(u, id))[0]!.status).toBe('awaiting_execution');

    const expected = model.simulateIncrease({
      market: await input('SOL', units(first, 'SOL')), isLong: true, collateralToken: USDC_MINT,
      collateralAmount: 500_000_000n, sizeDeltaUsd: 10_000n * USD,
    });
    await t.tick({ ...first, ts: seen.ts + 1 }); // the first tick published after it, whatever the wall clock says
    expect((await orders(u, id))[0]).toMatchObject({ status: 'executed' });
    const [fill] = await fills(u, id);
    expect(fill).toMatchObject({
      symbol: 'SOL', side: 'Long', isIncrease: true, sizeUsd: '10000', price: fromUnitPrice(expected.executionPrice, 9),
      feeUsd: usdText(expected.fees.orderFeeValue), priceImpactUsd: usdText(expected.priceImpactValue),
      realizedPnl: microText(expected.position.collateralAmount - 500_000_000n), venue: 'simulated',
    });
    // A long buys at the oracle max: the same fill at max/max, a different one at min/min.
    const priced = async (p: bigint) => model.simulateIncrease({
      market: await input('SOL', { min: p, max: p }), isLong: true, collateralToken: USDC_MINT, collateralAmount: 500_000_000n, sizeDeltaUsd: 10_000n * USD,
    }).executionPrice;
    expect(await priced(units(first, 'SOL').max)).toBe(expected.executionPrice);
    expect(await priced(units(first, 'SOL').min)).not.toBe(expected.executionPrice);

    const [position] = await positions(u, id);
    expect(position).toMatchObject({
      symbol: 'SOL', side: 'Long', sizeUsd: '10000', collateralUsd: microText(expected.position.collateralAmount), venue: 'simulated',
      takeProfit: null, stopLoss: null, closing: false,
    });
    // The row's P&L is net: net value minus collateral, the pending costs split out (borrowing, funding, the close fee).
    const image = expected.position.account;
    const status = model.positionStatus(await input('SOL', units(first, 'SOL'), image), image);
    const state = await t.md.marketState(t.md.market('SOL')!.marketToken);
    expect(position).toMatchObject({
      unrealizedPnl: microText((status.netValue - status.collateralValue) / state.prices.short.min),
      pendingFeesUsd: usdText(status.pendingBorrowingFeeValue + status.pendingFundingFeeValue + status.closeOrderFeeValue),
      pendingBorrowUsd: usdText(status.pendingBorrowingFeeValue), pendingFundingUsd: usdText(status.pendingFundingFeeValue), closeFeeUsd: usdText(status.closeOrderFeeValue),
    });
    expect(Number(position!.closeFeeUsd)).toBeGreaterThan(0.9);
    expect(Number(position!.unrealizedPnl)).toBeLessThan(0); // the close fee alone puts a fresh position under water
    const after = await summary(u, id);
    expect(after.realizedPnl).toBe(fill!.realizedPnl);
    expect(after.availableMargin).toBe('750'); // realized fees come out of the allowance, the rest is posted collateral
    expect(after.openNotional).toBe('10000');

    const wallet = t.events.filter((e) => e.wallet === u.wallet).map((e) => e.event.type);
    expect(wallet).toEqual(expect.arrayContaining(['orders', 'positions', 'account']));
    expect(t.events.some((e) => e.wallet === undefined && e.event.type !== 'heartbeat')).toBe(false);
    const notices = await t.db.select().from(notifications).where(and(eq(notifications.wallet, u.wallet), eq(notifications.kind, 'fill')));
    expect(notices).toHaveLength(1);
    // Links name the account; prices show at the market's display precision; P&L carries its sign ahead of the $.
    const decimals = t.md.market('SOL')!.priceDecimals;
    const shown = Number(fill!.price).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    expect(notices[0]).toMatchObject({
      href: `/account/practice?id=${encodeURIComponent(id)}`,
      body: `Practice account: $10,000.00 at ${shown}, P&L −$${Math.abs(Number(fill!.realizedPnl)).toFixed(2)} (simulated)`,
    });
    expect((await t.db.select().from(equitySnapshots).where(eq(equitySnapshots.accountId, id))).length).toBeGreaterThanOrEqual(2);
  });

  it('fills an evaluation market order only on a tick at least the keeper delay after it was placed', async () => {
    const u = await t.user();
    const ev = await evaluation(u);
    await base('SOL');
    const { order } = await placed(u, ev);
    await t.tick(t.md.scaled('SOL', 1, order.createdAt + 1_999)); // newer than the tick seen, but inside the delay
    expect((await orders(u, ev))[0]!.status).toBe('awaiting_execution');
    await t.tick(t.md.scaled('SOL', 1, order.createdAt + 2_000));
    expect((await orders(u, ev))[0]!.status).toBe('executed');
  });

  it('closes a practice position on the first tick published after the close, an evaluation one after the keeper delay', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    const ev = await evaluation(u);
    const close = (account: string, position: string) =>
      u.post(`${path(account)}/positions/${position}/close`, { clientId: clientId(), percent: 100, slippageBps: 50 });
    await base('SOL');
    await placed(u, id);
    await t.tick(t.md.scaled('SOL', 1, later()));
    const seen = t.md.price('SOL')!;
    const [practice] = await positions(u, id);
    expect((await close(id, practice!.id)).statusCode).toBe(200);
    expect((await positions(u, id))[0]).toMatchObject({ id: practice!.id, closing: true }); // on its way out, still valued
    await t.tick({ ...seen, ts: seen.ts }); // the quote the close was requested on: no newer price yet
    expect((await positions(u, id)).map((p) => p.closing)).toEqual([true]);
    await t.tick({ ...seen, ts: seen.ts + 1 }); // the first price published after the request
    expect(await positions(u, id)).toEqual([]);
    expect((await t.sim.history(u.wallet, id))!.map((x) => x.symbol)).toEqual(['SOL']);

    await placed(u, ev);
    await t.tick(t.md.scaled('SOL', 1, later()));
    await t.tick(t.md.scaled('SOL', 1, Date.now())); // the latest quote is current again
    const [evaluated] = await positions(u, ev);
    const { order } = (await close(ev, evaluated!.id)).json() as SimOrderResponse;
    expect((await positions(u, ev))[0]).toMatchObject({ id: evaluated!.id, closing: true });
    await t.tick(t.md.scaled('SOL', 1, order.createdAt + 1_999)); // newer than the quote seen, but inside the keeper delay
    expect((await positions(u, ev)).map((p) => p.closing)).toEqual([true]);
    await t.tick(t.md.scaled('SOL', 1, order.createdAt + 2_000));
    expect(await positions(u, ev)).toEqual([]);
  });

  it('never fills a limit set through the price on a tick older than the request, nor on the tick it was placed on', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    const seen = t.md.price('SOL')!;
    const mid = toUnitPrice(seen.mid, 9);
    // A long limit above the market: GMTrade's rule (max ≤ trigger) holds on every one of these ticks.
    const { order } = await placed(u, id, { kind: 'Limit', triggerPrice: fromUnitPrice((mid * 102n) / 100n, 9) });
    expect(order.status).toBe('awaiting_price');
    await t.tick({ ...seen, ts: seen.ts - 1_000 }); // an older quote re-published
    expect((await orders(u, id))[0]!.status).toBe('awaiting_price');
    await t.tick({ ...seen, ts: seen.ts }); // the quote the order was placed on
    expect((await orders(u, id))[0]!.status).toBe('awaiting_price');
    await t.tick({ ...seen, ts: seen.ts + 1 });
    expect((await orders(u, id))[0]!.status).toBe('executed');
    expect((await positions(u, id)).map((p) => p.side)).toEqual(['Long']);
  });

  it('cancels a market order whose execution price is worse than its acceptable price', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    const { order } = await placed(u, id, { slippageBps: 10 });
    await t.tick(t.md.scaled('SOL', 1.01, order.createdAt + 2_000));
    const [cancelled] = await orders(u, id);
    expect(cancelled!.status).toBe('canceled');
    expect(cancelled!.statusDetail).toMatch(/slippage limit: it would fill at [\d.]+, worse than your acceptable price [\d.]+/);
    expect(await positions(u, id)).toEqual([]);
    expect((await summary(u, id)).availableMargin).toBe('1250');
  });

  it('triggers limit orders with GMTrade\'s rule on both sides', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    const mid = toUnitPrice(t.md.price('SOL')!.mid, 9);
    const long = await placed(u, id, { kind: 'Limit', triggerPrice: fromUnitPrice((mid * 99n) / 100n, 9) });
    const short = await placed(u, id, { kind: 'Limit', side: 'Short', triggerPrice: fromUnitPrice((mid * 101n) / 100n, 9) });
    expect([long.order.status, short.order.status]).toEqual(['awaiting_price', 'awaiting_price']);
    expect(long.order.acceptablePrice).toBe(fromUnitPrice(((mid * 99n) / 100n * 10_050n + 9_999n) / 10_000n, 9));

    await t.tick(t.md.scaled('SOL', 0.995, later()), t.md.scaled('SOL', 1.005, later()));
    await t.tick(straddle('SOL', (mid * 99n) / 100n), straddle('SOL', (mid * 101n) / 100n)); // max above / min below
    expect((await orders(u, id)).map((o) => o.status)).toEqual(['awaiting_price', 'awaiting_price']);
    await t.tick(t.md.scaled('SOL', 0.989, later())); // long limit: max ≤ trigger
    expect((await positions(u, id)).map((p) => p.side)).toEqual(['Long']);
    await t.tick(t.md.scaled('SOL', 1.011, later())); // short limit: min ≥ trigger
    expect((await positions(u, id)).map((p) => p.side).sort()).toEqual(['Long', 'Short']);
    const filled = await fills(u, id);
    expect(toUnitPrice(filled[0]!.price, 9)).toBeLessThanOrEqual(toUnitPrice(long.order.acceptablePrice!, 9));
    expect(toUnitPrice(filled[1]!.price, 9)).toBeGreaterThanOrEqual(toUnitPrice(short.order.acceptablePrice!, 9));
  });

  it('arms take-profit and stop-loss when their order fills and closes positions with them on both sides', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    const mid = toUnitPrice(t.md.price('SOL')!.mid, 9);
    const price = (pct: bigint) => fromUnitPrice((mid * pct) / 100n, 9);
    await placed(u, id, { kind: 'Limit', triggerPrice: price(99n), takeProfit: price(102n), stopLoss: price(98n) });
    const protective = (await orders(u, id)).filter((o) => !o.isIncrease);
    expect(protective.map((o) => [o.kind, o.status, o.acceptablePrice])).toEqual(
      expect.arrayContaining([['TakeProfit', 'awaiting_price', null], ['StopLoss', 'awaiting_price', null]]));
    await t.tick(t.md.scaled('SOL', 1.03, later())); // past the take profit, but it is not armed before its order fills
    expect((await orders(u, id)).map((o) => o.status)).toEqual(['awaiting_price', 'awaiting_price', 'awaiting_price']);
    await t.tick(t.md.scaled('SOL', 0.989, later()));
    const [long] = await positions(u, id);
    expect(long!.takeProfit).toMatchObject({ price: price(102n), status: 'awaiting_price' });
    expect(long!.stopLoss).toMatchObject({ price: price(98n), status: 'awaiting_price' });

    await t.tick(t.md.scaled('SOL', 1.015, later()), straddle('SOL', (mid * 102n) / 100n)); // min still below the take profit
    expect(await positions(u, id)).toHaveLength(1);
    await t.tick(t.md.scaled('SOL', 1.021, later())); // long take profit: min ≥ trigger
    expect(await positions(u, id)).toEqual([]);
    const stop = (await orders(u, id)).find((o) => o.kind === 'StopLoss')!;
    expect([stop.status, stop.statusDetail]).toEqual(['canceled', 'Position closed']);
    const [trade] = (await t.sim.history(u.wallet, id))!;
    expect(trade).toMatchObject({ symbol: 'SOL', side: 'Long', sizeUsd: '10000', venue: 'simulated' });
    expect(Number(trade!.netPnl)).toBeGreaterThan(0);

    // A short protected afterwards through PUT: its stop loss triggers when max ≥ trigger.
    await base('SOL');
    await placed(u, id, { side: 'Short' });
    await t.tick(t.md.scaled('SOL', 1, later()));
    const [short] = await positions(u, id);
    const res = await u.put(`${path(id)}/positions/${short!.id}/protection`, { takeProfit: price(98n), stopLoss: price(102n) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: short!.id, takeProfit: { price: price(98n) }, stopLoss: { price: price(102n) } });
    const bad = await u.put(`${path(id)}/positions/${short!.id}/protection`, { takeProfit: price(102n), stopLoss: null });
    expect([bad.statusCode, bad.json().error.message]).toEqual([422, 'Take profit must be below the current price']);
    await t.tick(t.md.scaled('SOL', 1.019, later()));
    expect(await positions(u, id)).toHaveLength(1);
    await t.tick(straddle('SOL', (mid * 102n) / 100n)); // short stop loss: max ≥ trigger, though min is below it
    expect(await positions(u, id)).toEqual([]);
    const history = (await t.sim.history(u.wallet, id))!;
    expect(history).toHaveLength(2);
    expect(await t.sim.history(u.wallet, id, 1)).toEqual([history[0]]); // a capped read keeps the newest
    expect(Number(history[0]!.netPnl)).toBeLessThan(0);

    const perf = (await t.sim.performance(u.wallet, id, 'All'))!;
    expect(perf).toMatchObject({ trades: 2, winRatePct: 50 });
    expect(perf.netPnl).toBe((await summary(u, id)).realizedPnl);
    expect(perf.series.at(-1)!.equity).toBe((await summary(u, id)).equity);
  });
});

describe('fees over time', () => {
  it('charges the borrowing and funding GMTrade accrues while a position is open, realized when it closes', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    const rates = model.marketStatus(await input('SOL', units(t.md.price('SOL')!, 'SOL')));
    const long = rates.borrowingRatePerSecondForLong >= rates.borrowingRatePerSecondForShort;
    const rate = long ? rates.borrowingRatePerSecondForLong : rates.borrowingRatePerSecondForShort;
    expect(rate).toBeGreaterThan(0n);
    await placed(u, id, { side: long ? 'Long' : 'Short' });
    await t.tick(t.md.scaled('SOL', 1, later()));
    const [open] = await positions(u, id);
    expect([open!.pendingBorrowUsd, open!.pendingFundingUsd]).toEqual(['0', '0']); // pendingFeesUsd also carries the close fee
    // The position opened an hour ago (as GMTrade stamps it) on a market that has not changed onchain since before then.
    const account = await modelAccount(open!.id);
    await t.db.update(simPositions).set({ modelState: { account: stampPosition(account, true, new Date(Date.now() - 3_600_000)) } })
      .where(eq(simPositions.id, open!.id));
    t.md.clockAgeSeconds = 7_200;
    try {
      const hour = (Number(rate) / 1e20) * 3_600 * 10_000;
      const [position] = await positions(u, id);
      expect(Number(position!.pendingBorrowUsd)).toBeGreaterThan(hour * 0.98);
      expect(Number(position!.pendingFeesUsd)).toBeCloseTo(Number(position!.pendingBorrowUsd) + Number(position!.pendingFundingUsd) + Number(position!.closeFeeUsd), 5);
      await u.post(`${path(id)}/positions/${position!.id}/close`, { clientId: clientId(), percent: 50, slippageBps: 50 });
      await t.tick(t.md.scaled('SOL', 1, later()));
      const [, half] = await fills(u, id);
      expect(Number(half!.borrowUsd)).toBeGreaterThan(hour * 0.98); // a decrease settles the whole position's fees
      expect(Number(half!.borrowUsd)).toBeLessThan(hour * 1.02);
      const [rest] = await positions(u, id);
      expect(Number(rest!.pendingBorrowUsd)).toBeLessThan(hour * 0.01); // and they accrue again from it
      await u.post(`${path(id)}/positions/${rest!.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 50 });
      await t.tick(t.md.scaled('SOL', 1, later()));
      const [trade] = (await t.sim.history(u.wallet, id))!;
      expect(Number(trade!.feesUsd)).toBeGreaterThan(Number(half!.borrowUsd) + Number(half!.fundingUsd));
      // The round trip's breakdown is the sum over its fills, and feesUsd keeps meaning order fees + funding + borrowing.
      const all = await fills(u, id);
      const total = (key: 'feeUsd' | 'fundingUsd' | 'borrowUsd' | 'priceImpactUsd') => all.reduce((sum, f) => sum + Number(f[key]), 0);
      expect(all).toHaveLength(3);
      expect(Number(trade!.orderFeesUsd)).toBeCloseTo(total('feeUsd'), 5);
      expect(Number(trade!.fundingUsd)).toBeCloseTo(total('fundingUsd'), 5);
      expect(Number(trade!.borrowUsd)).toBeCloseTo(total('borrowUsd'), 5);
      expect(Number(trade!.priceImpactUsd)).toBeCloseTo(total('priceImpactUsd'), 5);
      expect(Number(trade!.borrowUsd)).toBeGreaterThan(hour * 0.98);
      expect(Number(trade!.feesUsd)).toBeCloseTo(Number(trade!.orderFeesUsd) + Number(trade!.fundingUsd) + Number(trade!.borrowUsd), 5);
    } finally {
      t.md.clockAgeSeconds = 0;
    }
  });
});

describe('liquidation', () => {
  it('liquidates exactly where GMTrade\'s model does, and never loses more than the collateral', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    await placed(u, id);
    await t.tick(t.md.scaled('SOL', 1, later()));
    const [position] = await positions(u, id);
    const account = await modelAccount(position!.id);
    const liq = toUnitPrice(position!.liquidationPrice!, 9);
    const above = (liq * 1_001n) / 1_000n;
    const below = (liq * 999n) / 1_000n;
    expect(model.positionStatus(await input('SOL', { min: above, max: above }, account), account).liquidatable).toBe(false);
    expect(model.positionStatus(await input('SOL', { min: below, max: below }, account), account).liquidatable).toBe(true);

    await t.tick(at('SOL', above));
    await t.rules();
    expect(await positions(u, id)).toHaveLength(1);

    const expected = model.simulateDecrease({
      market: await input('SOL', { min: below, max: below }, account), position: account, sizeDeltaUsd: decodePosition(account).state.size_in_usd, liquidation: true,
    });
    await t.tick(at('SOL', below));
    await t.rules();
    expect(await positions(u, id)).toEqual([]);
    const [open, liquidation] = await fills(u, id);
    const collateral = BigInt(Math.round(Number(position!.collateralUsd) * 1e6));
    expect(liquidation).toMatchObject({ isIncrease: false, price: fromUnitPrice(expected.executionPrice, 9), realizedPnl: microText(expected.outputAmount - collateral) });
    const liquidationFills = await t.db.select().from(simFills).where(eq(simFills.accountId, id));
    expect(liquidationFills.find((f) => !f.isIncrease)!.orderId).toBeNull();
    expect(Number(open!.realizedPnl) + Number(liquidation!.realizedPnl)).toBeGreaterThanOrEqual(-500);
    expect((await t.sim.activity(u.wallet, id))!.some((a) => a.type === 'liquidation')).toBe(true);
  });

  it('values a simulated position against the pool as if it were in it, as a funded position is', async () => {
    // NVDA's real overnight long open interest is $561: an $8,000 simulated long cannot come out of that pool.
    const state = await t.md.marketState(t.md.market('NVDA')!.marketToken);
    const index = state.prices.index;
    const raw = (state.raw as { market: string }).market;
    const open = model.simulateIncrease({
      market: await input('NVDA', index), isLong: true, collateralToken: USDC_MINT, collateralAmount: 1_000_000_000n, sizeDeltaUsd: 8_000n * USD,
    }).position;
    const bare = await input('NVDA', index);
    expect(() => model.positionStatus(bare, open.account)).toThrow(/next delta long usd value/);
    type Pools = Record<string, { pool: { long_token_amount: bigint } }>;
    const pools = (m: string) => decodeMarket(m).state.pools as unknown as Pools;
    const [before, after] = [pools(raw), pools(withPosition(raw, open.account))];
    const added = (pool: string) => after[pool]!.pool.long_token_amount - before[pool]!.pool.long_token_amount;
    expect(added('open_interest_for_long')).toBe(open.sizeInUsd);
    expect(added('open_interest_in_tokens_for_long')).toBe(open.sizeInTokens);
    expect(added('collateral_sum_for_long')).toBe(open.collateralAmount);
    expect(after.open_interest_for_short).toEqual(before.open_interest_for_short);
    const close = model.simulateDecrease({ market: await input('NVDA', index, open.account), position: open.account, sizeDeltaUsd: open.sizeInUsd });
    expect(close.position).toBeNull();
    expect(close.outputAmount).toBeGreaterThan(990_000_000n);
  });

  it('applies GMTrade\'s closed-market liquidation factor, read from the real closed NVDA Market account', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    t.md.closed.set('NVDA', false); // the same market while open
    await base('NVDA');
    await placed(u, id, { symbol: 'NVDA', sizeUsd: '8000', collateralUsd: '1000' }); // 8x: NVDA's limit
    await t.tick({ ...t.md.scaled('NVDA', 1, later()), session: 'open' });
    const [position] = await positions(u, id);
    const account = await modelAccount(position!.id);

    const drop = { ...t.md.scaled('NVDA', 0.96, later()), session: 'closed' as const };
    expect(model.positionStatus(await input('NVDA', units(drop, 'NVDA'), account), account).liquidatable).toBe(false); // 1% factor while open
    t.md.closed.set('NVDA', true); // back to the recorded state: Closed flag set, EnableMarketClosedParams on
    expect(model.positionStatus(await input('NVDA', units(drop, 'NVDA'), account), account).liquidatable).toBe(true); // 10% while closed

    await t.tick(drop);
    await t.rules();
    expect(await positions(u, id)).toEqual([]);
    expect((await t.sim.history(u.wallet, id))!).toHaveLength(1);
  });
});

describe('sessions and limits', () => {
  it('refuses opens, closes and protection while the market is closed and executes nothing until it reopens', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    const closed = await place(u, id, { symbol: 'NVDA', sizeUsd: '1000', collateralUsd: '200' });
    expect([closed.statusCode, closed.json().error.code]).toEqual([409, 'market_closed']);

    t.md.closed.set('NVDA', false);
    await base('NVDA');
    await placed(u, id, { symbol: 'NVDA', sizeUsd: '1000', collateralUsd: '200' });
    await t.tick({ ...t.md.scaled('NVDA', 1, later()), session: 'open' });
    const [position] = await positions(u, id);
    const { order: pending } = await placed(u, id, { symbol: 'NVDA', sizeUsd: '1000', collateralUsd: '200' });

    t.md.closed.set('NVDA', true);
    await t.tick({ ...t.md.scaled('NVDA', 1, later()), session: 'closed' });
    expect((await orders(u, id)).find((o) => o.id === pending.id)!.status).toBe('awaiting_execution');
    const close = await u.post(`${path(id)}/positions/${position!.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 50 });
    expect([close.statusCode, close.json().error.code]).toEqual([409, 'market_closed']);
    const protect = await u.put(`${path(id)}/positions/${position!.id}/protection`, { takeProfit: null, stopLoss: '1' });
    expect(protect.statusCode).toBe(409);

    t.md.closed.set('NVDA', false);
    await t.tick({ ...t.md.scaled('NVDA', 1, later()), session: 'open' });
    expect((await orders(u, id)).find((o) => o.id === pending.id)!.status).toBe('executed');
    expect((await positions(u, id))[0]!.sizeUsd).toBe('2000');
    const res = await u.post(`${path(id)}/positions/${position!.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 50 });
    expect(res.statusCode).toBe(200);
    await t.tick({ ...t.md.scaled('NVDA', 1, later()), session: 'open' });
    expect(await positions(u, id)).toEqual([]);
    t.md.closed.set('NVDA', true);
    await base('NVDA', 'closed');
  });

  it('takes no orders and decides nothing on a price the feed stopped updating', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    await placed(u, id, { sizeUsd: '25000', collateralUsd: '1250' });
    await t.tick(t.md.scaled('SOL', 1, later()));
    await t.tick(t.md.scaled('SOL', 0.9, Date.now() - 30_000)); // a 10% drop, but 30 s old: the feed went quiet
    await t.rules();
    expect(await summary(u, id)).toMatchObject({ status: 'active', freshness: 'stale' });
    expect(await positions(u, id)).toHaveLength(1);
    expect((await place(u, id, { sizeUsd: '100', collateralUsd: '10' })).json().error.code).toBe('price_unavailable');
    await t.tick(t.md.scaled('SOL', 0.9, later()));
    await t.rules();
    expect(await summary(u, id)).toMatchObject({ status: 'breached', freshness: 'live', positions: [] });
  });

  it('enforces per-market leverage, available margin, total exposure and GMTrade\'s own limits', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    const reject = async (body: Partial<SimOrderRequest>) => (await place(u, id, body)).json().error as { code: string; message: string };
    expect(await reject({ sizeUsd: '26000', collateralUsd: '1000' })).toEqual({ code: 'order_rejected', message: 'Leverage 26.00x is above the 25x limit for SOL' });
    expect(await reject({ sizeUsd: '10000', collateralUsd: '1300' })).toEqual({ code: 'order_rejected', message: 'Margin $1,300.00 is more than the $1,250.00 available' });
    const far = fromUnitPrice(toUnitPrice(t.md.price('SOL')!.mid, 9) / 2n, 9);
    await placed(u, id, { kind: 'Limit', triggerPrice: far, sizeUsd: '24000', collateralUsd: '1000' });
    expect((await summary(u, id)).availableMargin).toBe('250');
    expect(await reject({ sizeUsd: '2000', collateralUsd: '100' })).toEqual({ code: 'order_rejected', message: 'Total exposure would be $26,000.00, above the $25,000.00 limit' });
    expect((await reject({ sizeUsd: '0.5', collateralUsd: '0.5' })).code).toBe('rejected_by_venue'); // below GMTrade's $1 minimum

    const invalid = [
      { kind: 'Limit' as const }, { triggerPrice: '100' }, { kind: 'Limit' as const, triggerPrice: '100.123456789012' }, { sizeUsd: '1.1234567' },
      { slippageBps: 501 }, { clientId: 'has:colon' },
    ];
    for (const body of invalid) expect((await place(u, id, body)).statusCode, JSON.stringify(body)).toBe(400);
  });

  it('lets practice trade any USDC-only market and evaluations only allowlisted ones', async () => {
    const u = await t.user();
    const ev = await evaluation(u);
    await base('BTC');
    const btc = t.md.market('BTC')!;
    t.md.setRow('BTC', { tradable: false, unavailableReason: 'Not available for funded trading' });
    try {
      expect((await place(u, ev, { symbol: 'BTC' })).json().error).toEqual({ code: 'market_unavailable', message: 'BTC is not available in evaluations: they trade only the markets funded accounts can' });
      expect((await place(u, practiceOf(u), { symbol: 'BTC' })).statusCode).toBe(200);
      t.md.setRow('BTC', { pools: btc.pools.map((p) => ({ ...p, pure: false })) });
      expect((await place(u, practiceOf(u), { symbol: 'BTC' })).json().error.code).toBe('market_unavailable');
    } finally {
      t.md.setRow('BTC', btc);
    }
  });
});

describe('account rules', () => {
  it('fails an evaluation whose equity reaches the floor and resolves it once', async () => {
    const u = await t.user();
    const ev = await evaluation(u);
    await t.sim.createEvaluation({ evaluation: ev, wallet: u.wallet, terms: { tierId: 9, sizeUsd: '1', profitTargetBps: 1, maxDrawdownBps: 1, maxExposureBps: 1, traderShareBps: 1, termsHash: '' }, purchasedAt: 0, signature: 'x' });
    expect((await summary(u, ev)).rules).toMatchObject({ sizeUsd: '25000', lossAllowanceUsd: '1250', floorUsd: '23750', profitTargetUsd: '2000' });
    await base('SOL');
    await base('BTC');
    await placed(u, ev, { sizeUsd: '12500', collateralUsd: '625' });
    await placed(u, ev, { symbol: 'BTC', sizeUsd: '12500', collateralUsd: '625' });
    await t.tick(t.md.scaled('SOL', 1, later()), t.md.scaled('BTC', 1, later()));
    expect(await positions(u, ev)).toHaveLength(2);

    await t.tick(t.md.scaled('SOL', 0.9, later()), t.md.scaled('BTC', 0.9, later())); // a 10% gap on both
    await t.rules();
    await t.rules();
    const account = await summary(u, ev);
    expect(account).toMatchObject({ status: 'failed', equity: '23750', realizedPnl: '-1250', positions: [] });
    expect(account.resolvedAt).not.toBeNull();
    const mine = resolved.filter((r) => r.evaluation === ev);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ wallet: u.wallet, passed: false, finalEquityUsd: '23750', tradesRoot: recomputeRoot(await fills(u, ev)) });
    expect((await place(u, ev)).json().error.code).toBe('account_inactive');
    const failed = await t.db.select().from(notifications).where(and(eq(notifications.wallet, u.wallet), eq(notifications.title, 'Evaluation failed')));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ href: `/account/evaluation?id=${ev}`, body: `${account.label} ${account.shortId}: Equity $23,750.00 reached the $23,750.00 floor` });
  });

  it('marks an evaluation checking at the target with open positions, passes it when flat, and resolves it once', async () => {
    const u = await t.user();
    const ev = await evaluation(u);
    await base('SOL');
    await placed(u, ev, { sizeUsd: '25000', collateralUsd: '1250' });
    await t.tick(t.md.scaled('SOL', 1, later()));
    await t.tick(t.md.scaled('SOL', 1.1, later()));
    await t.rules();
    const checking = await summary(u, ev);
    expect(checking.status).toBe('checking');
    expect(checking.targetProgressPct).toBeGreaterThan(100);

    const [position] = checking.positions;
    const close = await u.post(`${path(ev)}/positions/${position!.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 50 });
    expect(close.statusCode, close.body).toBe(200);
    await t.tick(t.md.scaled('SOL', 1.1, later()));
    await t.rules();
    await t.rules();
    const passed = await summary(u, ev);
    expect(passed).toMatchObject({ status: 'passed', positions: [] });
    expect(Number(passed.realizedPnl)).toBeGreaterThanOrEqual(2000);
    const mine = resolved.filter((r) => r.evaluation === ev);
    expect(mine).toHaveLength(1);
    const list = await fills(u, ev);
    expect(list).toHaveLength(2);
    expect(mine[0]).toMatchObject({ passed: true, finalEquityUsd: passed.equity, tradesRoot: recomputeRoot(list), resolvedAt: passed.resolvedAt });
    const [notice] = await t.db.select().from(notifications).where(and(eq(notifications.wallet, u.wallet), eq(notifications.title, 'Evaluation passed')));
    expect(notice).toMatchObject({ href: `/result?id=${ev}` });
    expect(await tradesRoot([...list].reverse())).toBe(mine[0]!.tradesRoot);

    // The fill list is the owner's until the result is onchain, then anyone's: the trades root it commits to is public.
    const stranger = await t.user();
    const anonymous = () => t.app.inject({ method: 'GET', url: `${path(ev)}/fills` });
    expect((await stranger.get(`${path(ev)}/fills`)).statusCode).toBe(404);
    expect((await anonymous()).statusCode).toBe(404);
    expect((await t.sim.detail(u.wallet, ev))!.evidence.resultSignature, 'decided, not recorded yet').toBeUndefined();

    const published = t.events.length;
    await t.sim.markRecorded(ev, '5'.repeat(87));
    await t.sim.markRecorded(ev, '6'.repeat(87)); // already recorded: keeps the first
    expect((await t.sim.detail(u.wallet, ev))!.evidence).toMatchObject({ evaluation: ev, resultSignature: '5'.repeat(87) });
    const update = t.events.slice(published).find((e) => e.event.type === 'account' && e.event.account.id === ev);
    expect(update, 'the owner\'s stream hears of the record').toMatchObject({ wallet: u.wallet, event: { account: { evidence: { resultSignature: '5'.repeat(87) } } } });
    expect((await stranger.get(`${path(ev)}/fills`)).json()).toEqual(list);
    expect(await tradesRoot((await anonymous()).json() as Fill[])).toBe(mine[0]!.tradesRoot);
    expect((await t.app.inject({ method: 'GET', url: `${path(practiceOf(u))}/fills` })).statusCode, 'practice stays private').toBe(404);
    const [row] = await t.db.select().from(simResults).where(eq(simResults.evaluation, ev));
    expect(row!.recordedSignature).toBe('5'.repeat(87));
    expect((await t.sim.activity(u.wallet, ev))!.filter((a) => a.title === 'Result recorded onchain')).toHaveLength(1);
    expect((await place(u, ev)).json().error.code).toBe('account_inactive');
  });

  it('warns near the limit, breaches a practice account at the floor, and resets it into a fresh one', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    await placed(u, id, { sizeUsd: '25000', collateralUsd: '1250' });
    await t.tick(t.md.scaled('SOL', 1, later()));
    await t.tick(t.md.scaled('SOL', 0.962, later()));
    await t.rules();
    expect((await summary(u, id)).status).toBe('near_limit');
    expect(await t.db.select().from(notifications).where(and(eq(notifications.wallet, u.wallet), eq(notifications.title, 'Close to the loss limit')))).toHaveLength(1);

    await t.tick(t.md.scaled('SOL', 0.9, later()));
    await t.rules();
    expect(await summary(u, id)).toMatchObject({ status: 'breached', equity: '23750' });
    expect((await place(u, id)).json().error.code).toBe('account_inactive');

    const reset = await u.post('/v1/practice/reset');
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json()).toMatchObject({ id, status: 'active', equity: '25000', realizedPnl: '0', availableMargin: '1250', resolvedAt: null });
    expect(await t.sim.history(u.wallet, id)).toEqual([]);
    expect(await fills(u, id)).toEqual([]);
    const archived = await t.db.select().from(accounts).where(like(accounts.id, `${id}:%`));
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ status: 'breached', realizedPnl: '-1250.000000', wallet: u.wallet });
    expect(await t.db.select().from(simFills).where(eq(simFills.accountId, archived[0]!.id))).toHaveLength(2);
    expect((await t.sim.list(u.wallet))!.map((a) => a.id)).toEqual([id]);
    await base('SOL');
    expect((await place(u, id)).statusCode).toBe(200);
  });
});

describe('requests', () => {
  it('is idempotent per client id', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    const body = { clientId: clientId(), sizeUsd: '1000', collateralUsd: '100' };
    const [a, b] = [await placed(u, id, body), await placed(u, id, body)];
    expect(b.order.id).toBe(a.order.id);
    expect(await t.db.select().from(simOrders).where(eq(simOrders.clientId, body.clientId))).toHaveLength(1);
    await t.tick(t.md.scaled('SOL', 1, later()));

    const [position] = await positions(u, id);
    const close = { clientId: clientId(), percent: 50, slippageBps: 50 };
    const first = await u.post(`${path(id)}/positions/${position!.id}/close`, close);
    const again = await u.post(`${path(id)}/positions/${position!.id}/close`, close);
    expect((again.json() as SimOrderResponse).order.id).toBe((first.json() as SimOrderResponse).order.id);
    expect(first.json().order).toMatchObject({ sizeUsd: '500', kind: 'Market', isIncrease: false });
    await t.tick(t.md.scaled('SOL', 1, later()));
    expect((await positions(u, id))[0]!.sizeUsd).toBe('500');
  });

  it('cancels pending orders and the protection placed with them', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    const mid = toUnitPrice(t.md.price('SOL')!.mid, 9);
    const { order } = await placed(u, id, { kind: 'Limit', triggerPrice: fromUnitPrice(mid / 2n, 9), takeProfit: fromUnitPrice(mid, 9) });
    const res = await u.delete(`${path(id)}/orders/${order.id}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as SimOrderResponse).order).toMatchObject({ status: 'canceled', statusDetail: 'Cancelled by you' });
    expect((res.json() as SimOrderResponse).account.availableMargin).toBe('1250');
    const all = await orders(u, id);
    expect(all.map((o: Order) => o.status)).toEqual(['canceled', 'canceled']);
    expect((await u.delete(`${path(id)}/orders/${order.id}`)).statusCode).toBe(200); // already final: unchanged
  });

  it('keeps every wallet to its own accounts', async () => {
    const [a, b] = [await t.user(), await t.user()];
    const ev = await evaluation(a);
    await base('SOL');
    const { order } = await placed(a, practiceOf(a));
    await t.tick(t.md.scaled('SOL', 1, later()));
    const [position] = await positions(a, practiceOf(a));
    const { order: pending } = await placed(a, practiceOf(a), { kind: 'Limit', side: 'Short', triggerPrice: fromUnitPrice(toUnitPrice(t.md.price('SOL')!.mid, 9) * 2n, 9) });

    for (const id of [practiceOf(a), ev]) {
      expect((await place(b, id)).statusCode).toBe(404);
      expect((await b.get(`${path(id)}/fills`)).statusCode).toBe(404);
      expect(await t.sim.detail(b.wallet, id)).toBeUndefined();
      expect(await t.sim.history(b.wallet, id)).toBeUndefined();
    }
    expect((await b.delete(`${path(practiceOf(a))}/orders/${pending.id}`)).statusCode).toBe(404);
    expect((await b.delete(`${path(practiceOf(b))}/orders/${pending.id}`)).statusCode).toBe(404);
    expect((await b.post(`${path(practiceOf(b))}/positions/${position!.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 50 })).statusCode).toBe(404);
    expect((await b.put(`${path(practiceOf(a))}/positions/${position!.id}/protection`, { takeProfit: null, stopLoss: null })).statusCode).toBe(404);
    expect((await t.sim.list(b.wallet)).map((x) => x.id)).toEqual([practiceOf(b)]);
    expect((await t.sim.list(a.wallet)).map((x) => x.id).sort()).toEqual([ev, practiceOf(a)].sort());
    expect((await orders(a, practiceOf(a))).find((o) => o.id === order.id)!.status).toBe('executed');
    expect((await t.app.inject({ method: 'POST', url: '/v1/practice/reset' })).statusCode).toBe(401);
  });
});

describe('trigger rule', () => {
  it('reads the side of the quote GMTrade reads for each order kind', () => {
    const quote = { min: 99n, max: 101n }; // straddles the trigger
    const kinds = [['Limit', true], ['Limit', false], ['TakeProfit', true], ['TakeProfit', false], ['StopLoss', true], ['StopLoss', false]] as const;
    expect(kinds.map(([kind, isLong]) => triggered(kind, isLong, 100n, quote))).toEqual([false, false, false, false, true, true]);
    expect(kinds.map(([kind, isLong]) => triggered(kind, isLong, 101n, quote))).toEqual([true, false, false, true, true, true]);
  });
});

describe('trades root', () => {
  const fill = (id: string, ts: number, extra: Partial<Fill> = {}): Fill => ({
    id, symbol: 'SOL', side: 'Long', isIncrease: true, sizeUsd: '10000', price: '118.53831', feeUsd: '1', priceImpactUsd: '-0.012345',
    fundingUsd: '0', borrowUsd: '0', realizedPnl: '-1.000123', ts, venue: 'simulated', ...extra,
  });

  it('is the documented SHA-256 Merkle root, independent of input order', async () => {
    const list = [fill('b', 2), fill('a', 2, { isIncrease: false, realizedPnl: null }), fill('c', 1), fill('d', 3), fill('e', 3)];
    const leaf = createHash('sha256').update('c|SOL|Long|increase|10000|118.53831|1|-0.012345|0|0|-1.000123|1').digest('hex');
    expect(await tradesRoot([fill('c', 1)])).toBe(leaf);
    expect(await tradesRoot(list)).toBe(recomputeRoot(list));
    expect(await tradesRoot([...list].reverse())).toBe(await tradesRoot(list));
    expect(await tradesRoot(list.slice(0, 4))).not.toBe(await tradesRoot(list));
    expect(await tradesRoot([])).toBe('0'.repeat(64));
  });
});
