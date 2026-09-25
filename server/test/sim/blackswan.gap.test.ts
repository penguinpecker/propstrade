// Black-swan scenarios against the practice/evaluation engine: one tick that gaps through stop losses and liquidation
// levels, closes placed into a gap, and evaluation results decided by a gap. Each test states the behaviour the engine
// must have (the cross-market pre-emption of a stop loss, a defect at 3c53c9d, was fixed on 2026-09-25). Same fixtures
// and harness as engine.test.ts.
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fill, PriceTick, SimOrderRequest, SimOrderResponse } from '@props/shared';
import { decodePosition, formatFixed } from '@props/gmtrade';
import { model, type ModelInput } from '@props/gmsol-wasm';
import { fromUnitPrice, toUnitPrice } from '@props/sdk';
import { notifications, simFills, simPositions } from '../../src/db/schema.js';
import { withPosition } from '../../src/modules/sim/model.js';
import type { EvaluationResult } from '../../src/modules/types.js';
import { startSim, type Sim } from './harness.js';

let t: Sim;
const resolved: EvaluationResult[] = [];
beforeAll(async () => { t = await startSim('blackswan_gap', { onResolved: (r) => resolved.push(r) }); });
afterAll(async () => { await t.stop(); });

type User = Awaited<ReturnType<Sim['user']>>;
const USD = 10n ** 20n;
const usdText = (v: bigint) => formatFixed(v, 20, 6);
const microText = (v: bigint) => formatFixed(v, 6, 6);
const practiceOf = (u: User) => `practice:${u.wallet}`;
const path = (id: string) => `/v1/sim/${encodeURIComponent(id)}`;
const clientId = () => `c-${randomUUID()}`;
const later = () => Date.now() + 2_500;
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
const base = (symbol: string, session: PriceTick['session'] = 'open') => t.tick({ ...t.md.scaled(symbol, 1), session });
/** A tick at one unit price (min = max). */
const at = (symbol: string, price: bigint, ts = later()): PriceTick => {
  const p = fromUnitPrice(price, DECIMALS[symbol]!);
  return { symbol, min: p, max: p, mid: p, ts, session: 'open' };
};
/** A tick whose quote spans min..max (a wick inside one report). */
const wick = (symbol: string, min: bigint, max: bigint, ts = later()): PriceTick => ({
  symbol, min: fromUnitPrice(min, DECIMALS[symbol]!), max: fromUnitPrice(max, DECIMALS[symbol]!), mid: fromUnitPrice((min + max) / 2n, DECIMALS[symbol]!), ts, session: 'open',
});
const mid = (symbol = 'SOL') => toUnitPrice(t.md.price(symbol)!.mid, DECIMALS[symbol]!);
const pct = (unit: bigint, permille: bigint) => (unit * permille) / 1000n;
const priceAt = (symbol: string, permille: bigint) => fromUnitPrice(pct(mid(symbol), permille), DECIMALS[symbol]!);
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
const notices = (u: User, title: string) => t.db.select().from(notifications).where(and(eq(notifications.wallet, u.wallet), eq(notifications.title, title)));
const sum = (list: Fill[], key: 'realizedPnl' | 'feeUsd') => list.reduce((s, f) => s + Number(f[key] ?? '0'), 0);

/**
 * The widest price band under the liquidation price where GMTrade's check says liquidatable and a user decrease still
 * pays its costs (the band between "a keeper may liquidate" and "only a liquidation can close it"). Scanned in 1 bp
 * steps down to 5% under the liquidation price.
 */
async function solventLiquidatable(account: string, liq: bigint, symbol = 'SOL'): Promise<{ gap?: bigint; widthBps: number }> {
  let gap: bigint | undefined;
  let widthBps = 0;
  for (let bps = 1; bps <= 500; bps++) {
    const p = (liq * BigInt(10_000 - bps)) / 10_000n;
    const market = await input(symbol, { min: p, max: p }, account);
    if (!model.positionStatus(market, account).liquidatable) continue;
    try {
      model.simulateDecrease({ market, position: account, sizeDeltaUsd: decodePosition(account).state.size_in_usd });
    } catch {
      break;
    }
    gap ??= p;
    widthBps = bps;
  }
  return { gap, widthBps };
}

async function evaluation(u: User) {
  const id = Keypair.generate().publicKey.toBase58();
  const terms = { tierId: 2, sizeUsd: '25000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8_000, termsHash: 'ab'.repeat(32) };
  await t.sim.createEvaluation({ evaluation: id, wallet: u.wallet, terms, purchasedAt: Date.now(), signature: '4'.repeat(87) });
  return id;
}

/** Opens a SOL long and returns the position with its Position account image (for model derivations). */
async function opened(u: User, id: string, body: Partial<SimOrderRequest>) {
  await base('SOL');
  await placed(u, id, body);
  await t.tick(t.md.scaled('SOL', 1, later()));
  const [position] = await positions(u, id);
  return { position: position!, account: await modelAccount(position!.id) };
}

describe('scenario 1: a gap through the stop loss and through the liquidation level in one tick', () => {
  it('refuses the stop as insolvent, liquidates at the gap price with the liquidation fee, loses exactly the collateral, fails the account once', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    const stop = priceAt('SOL', 970n);
    const { position, account } = await opened(u, id, { sizeUsd: '25000', collateralUsd: '1250', stopLoss: stop }); // 20x, the whole allowance
    expect(position.stopLoss).toMatchObject({ price: stop, status: 'awaiting_price' });
    const liq = toUnitPrice(position.liquidationPrice!, 9);
    expect(liq).toBeLessThan(toUnitPrice(stop, 9)); // the stop sits above the liquidation level: an ordinary setup

    const gap = pct(mid(), 900n); // −10% in one report: through the stop, through the liquidation level, past insolvency
    const expected = model.simulateDecrease({
      market: await input('SOL', { min: gap, max: gap }, account), position: account, sizeDeltaUsd: decodePosition(account).state.size_in_usd, liquidation: true,
    });
    expect(expected.outputAmount).toBe(0n); // nothing comes back: the loss exceeds the collateral, GMTrade takes it all
    expect(expected.fees.liquidationFeeValue).toBeGreaterThan(0n);
    const atGap = await input('SOL', { min: gap, max: gap }, account);
    // The stop loss is a user decrease: GMTrade cannot close an insolvent position with it (is_insolvent_close_allowed = false).
    expect(() => model.simulateDecrease({ market: atGap, position: account, sizeDeltaUsd: decodePosition(account).state.size_in_usd })).toThrow();

    await t.tick(at('SOL', gap));
    const all = await orders(u, id);
    const sl = all.find((o) => o.kind === 'StopLoss')!;
    expect(sl.status).toBe('canceled');
    expect(sl.statusDetail).toMatch(/^The exchange would not execute this order/);
    const list = await fills(u, id);
    expect(list).toHaveLength(2);
    const [open, liquidation] = list;
    expect(liquidation).toMatchObject({
      isIncrease: false, sizeUsd: '25000', price: fromUnitPrice(expected.executionPrice, 9),
      feeUsd: usdText(expected.fees.orderFeeValue + expected.fees.liquidationFeeValue!),
    });
    expect(toUnitPrice(liquidation!.price, 9)).toBeLessThan(toUnitPrice(stop, 9)); // the gap price, not the stop price
    const rows = await t.db.select().from(simFills).where(eq(simFills.accountId, id));
    expect(rows.find((f) => !f.isIncrease)!.orderId).toBeNull(); // a liquidation, not the stop's fill
    expect(sum(list, 'realizedPnl')).toBeCloseTo(-1250, 6); // exactly the collateral: no debt
    expect(Number(open!.realizedPnl) + Number(liquidation!.realizedPnl)).toBeGreaterThanOrEqual(-1250);
    expect(await summary(u, id)).toMatchObject({ status: 'breached', equity: '23750', realizedPnl: '-1250', positions: [] });
    expect(await notices(u, 'Practice account reached its loss limit')).toHaveLength(1);

    await t.rules();
    await t.tick(at('SOL', pct(mid(), 850n)));
    await t.rules();
    expect(await fills(u, id)).toHaveLength(2);
    expect(await notices(u, 'Practice account reached its loss limit')).toHaveLength(1);
    expect((await t.sim.activity(u.wallet, id))!.filter((a) => a.type === 'liquidation')).toHaveLength(1);
  });

  it('shows equity no lower than the floor while an insolvent position waits for its liquidation (no debt, ever)', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await opened(u, id, { sizeUsd: '25000', collateralUsd: '1250' }); // no stop: the tick path has nothing to do
    await t.tick(at('SOL', pct(mid(), 800n))); // −20%: the position is worth nothing, it is not liquidated until the rules pass
    const during = await summary(u, id);
    console.log('equity shown before the liquidation runs', during.equity, 'allowance remaining', during.allowanceRemaining, 'unrealized', during.unrealizedPnl);
    expect(Number(during.equity)).toBeGreaterThanOrEqual(23_750);
    await t.rules();
    expect(await summary(u, id)).toMatchObject({ status: 'breached', equity: '23750' });
  });

  it('a gap through the stop loss but short of the liquidation level fills the stop at the gap price, not at the stop price', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    const stop = priceAt('SOL', 970n);
    const { position, account } = await opened(u, id, { sizeUsd: '10000', collateralUsd: '1000', stopLoss: stop }); // 10x
    const gap = pct(mid(), 940n); // −6%: through the stop, above the liquidation level (~−9% at 10x)
    expect(toUnitPrice(position.liquidationPrice!, 9)).toBeLessThan(gap);
    const expected = model.simulateDecrease({ market: await input('SOL', { min: gap, max: gap }, account), position: account, sizeDeltaUsd: 10_000n * USD });
    await t.tick(at('SOL', gap));
    const list = await fills(u, id);
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ isIncrease: false, price: fromUnitPrice(expected.executionPrice, 9), feeUsd: usdText(expected.fees.orderFeeValue) });
    expect(toUnitPrice(list[1]!.price, 9)).toBeLessThan(toUnitPrice(stop, 9));
    const sl = (await orders(u, id)).find((o) => o.kind === 'StopLoss')!;
    expect(sl.status).toBe('executed');
    expect((await t.db.select().from(simFills).where(eq(simFills.accountId, id))).find((f) => !f.isIncrease)!.orderId).toBe(sl.id);
    expect(expected.fees.liquidationFeeValue).toBeNull();
    expect(await positions(u, id)).toEqual([]);
    expect((await summary(u, id)).status).toBe('active');
  });

  it('a gap between the liquidation level and insolvency: the stop loss still closes, without the liquidation fee', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    const stop = priceAt('SOL', 970n);
    const { position, account } = await opened(u, id, { sizeUsd: '10000', collateralUsd: '1000', stopLoss: stop });
    const window = await solventLiquidatable(account, toUnitPrice(position.liquidationPrice!, 9));
    console.log(`SOL 10x: liquidation price ${position.liquidationPrice}, window below it where a user close still pays: ${window.widthBps} bps`);
    expect(window.gap, 'a solvent, liquidatable price exists under the liquidation price').toBeDefined();
    const gap = window.gap!;
    const asStop = model.simulateDecrease({ market: await input('SOL', { min: gap, max: gap }, account), position: account, sizeDeltaUsd: 10_000n * USD });
    expect(asStop.outputAmount).toBeGreaterThan(0n);
    await t.tick(at('SOL', gap));
    const list = await fills(u, id);
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ price: fromUnitPrice(asStop.executionPrice, 9), feeUsd: usdText(asStop.fees.orderFeeValue), realizedPnl: microText(asStop.outputAmount - BigInt(Math.round(Number(position.collateralUsd) * 1e6))) });
    expect((await orders(u, id)).find((o) => o.kind === 'StopLoss')!.status).toBe('executed');
    expect((await t.sim.activity(u.wallet, id))!.some((a) => a.type === 'liquidation')).toBe(false);
  });
});

describe('scenario 3: what wins when a stop loss and a liquidation trigger on the same tick', () => {
  /**
   * Two keeper reports of the same second, one per market. When the OTHER market's report lands first and the account
   * has an executable order there, that order's fill step runs the rules with the latest SOL price. At 3c53c9d it
   * liquidated the SOL position before the SOL report's own fill step reached the stop loss, so the trader paid the
   * liquidation fee or not depending on which token's report the keeper sent first; the rules now run a liquidatable
   * position's own report (its executable orders) before liquidating it.
   */
  async function raced(first: 'BTC' | 'SOL') {
    const u = await t.user();
    const id = practiceOf(u);
    await base('BTC');
    await base('SOL');
    const stop = priceAt('SOL', 970n);
    const { position, account } = await opened(u, id, { sizeUsd: '10000', collateralUsd: '1000', stopLoss: stop });
    await placed(u, id, { symbol: 'BTC', sizeUsd: '100', collateralUsd: '10' }); // executable on the next BTC tick
    const gap = (await solventLiquidatable(account, toUnitPrice(position.liquidationPrice!, 9))).gap!; // liquidatable, solvent: a stop can still close
    const ticks = { BTC: t.md.scaled('BTC', 1, later()), SOL: at('SOL', gap) };
    const order: ('BTC' | 'SOL')[] = first === 'BTC' ? ['BTC', 'SOL'] : ['SOL', 'BTC'];
    for (const s of order) t.md.push(ticks[s]);
    await t.sim.engine.settled();
    const sl = (await orders(u, id)).find((o) => o.kind === 'StopLoss')!;
    const exit = (await t.db.select().from(simFills).where(eq(simFills.accountId, id))).find((f) => f.symbol === 'SOL' && !f.isIncrease)!;
    console.log(`${first} report first: stop loss ${sl.status} (${sl.statusDetail ?? ''}); SOL exit fill ${exit.orderId ? 'by the stop' : 'by liquidation'} fee ${exit.feeUsd}`);
    return { sl, exit };
  }

  it('the stop loss fills when its market\'s report is processed first', async () => {
    const { sl, exit } = await raced('SOL');
    expect(sl.status).toBe('executed');
    expect(exit.orderId).toBe(sl.id);
  });

  it('the stop loss also fills when another market\'s report of the same second is processed first (its own report runs its orders before a liquidation, whichever step gets there first)', async () => {
    const { sl, exit } = await raced('BTC');
    expect(sl.status).toBe('executed');
    expect(exit.orderId).toBe(sl.id);
  });

  it('in a correlated crash each position\'s stop loss fills on its own report, whichever market\'s report is processed first', async () => {
    const outcome = async (first: 'BTC' | 'SOL') => {
      const u = await t.user();
      const id = practiceOf(u);
      await base('BTC');
      await base('SOL');
      await placed(u, id, { symbol: 'SOL', sizeUsd: '5000', collateralUsd: '500', stopLoss: priceAt('SOL', 970n) }); // 10x each
      await placed(u, id, { symbol: 'BTC', sizeUsd: '5000', collateralUsd: '500', stopLoss: priceAt('BTC', 970n) });
      await t.tick(t.md.scaled('SOL', 1, later()), t.md.scaled('BTC', 1, later()));
      const gaps: Record<string, bigint> = {};
      for (const p of await positions(u, id)) { // each report lands where its position is liquidatable but a stop can still close it
        gaps[p.symbol] = (await solventLiquidatable(await modelAccount(p.id), toUnitPrice(p.liquidationPrice!, DECIMALS[p.symbol]!), p.symbol)).gap!;
      }
      const ts = later();
      for (const s of first === 'BTC' ? ['BTC', 'SOL'] : ['SOL', 'BTC']) t.md.push(at(s, gaps[s]!, ts)); // one keeper report per token, same second
      await t.sim.engine.settled();
      const exits = (await t.db.select().from(simFills).where(eq(simFills.accountId, id))).filter((f) => !f.isIncrease);
      const result = Object.fromEntries(['SOL', 'BTC'].map((s) => [s, exits.find((f) => f.symbol === s)!.orderId ? 'stop' : 'liquidation']));
      console.log(`${first} report first:`, result);
      return result;
    };
    const runs = { btcFirst: await outcome('BTC'), solFirst: await outcome('SOL') };
    expect(runs).toEqual({ btcFirst: { SOL: 'stop', BTC: 'stop' }, solFirst: { SOL: 'stop', BTC: 'stop' } });
  });

  it('with a pending close and armed protection, the tick executes them in placement order and liquidates only what is left', async () => {
    // A close placed at the quote before a long stall, a take profit and a stop loss on the position; the feed resumes
    // with a −30% report: the stop (placed first) is refused as insolvent, the close is outside its slippage, and the
    // position is liquidated in the same step. One exit fill, one loss of exactly the collateral.
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    const { position } = await opened(u, id, { sizeUsd: '25000', collateralUsd: '1250', takeProfit: priceAt('SOL', 1050n), stopLoss: priceAt('SOL', 970n) });
    const close = await u.post(`${path(id)}/positions/${position.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 50 });
    expect(close.statusCode, close.body).toBe(200);
    await t.tick(at('SOL', pct(mid(), 700n), Date.now() + 5 * 60_000)); // the first report after minutes of silence
    const all = await orders(u, id);
    expect(all.find((o) => o.kind === 'StopLoss')!.statusDetail).toMatch(/^The exchange would not execute this order/);
    expect(all.find((o) => o.kind === 'Market' && !o.isIncrease)!.statusDetail).toMatch(/^The exchange would not execute this order/); // insolvent before its slippage is even checked
    expect(all.find((o) => o.kind === 'TakeProfit')).toMatchObject({ status: 'canceled', statusDetail: 'Position closed' });
    const list = await fills(u, id);
    expect(list).toHaveLength(2);
    expect(sum(list, 'realizedPnl')).toBeCloseTo(-1250, 6);
    expect(await summary(u, id)).toMatchObject({ status: 'breached', equity: '23750' });
  });

  it('with a pending close and a take profit, a +30% report fills the take profit (older) and tells the close the position is gone', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    const { position } = await opened(u, id, { sizeUsd: '10000', collateralUsd: '1000', takeProfit: priceAt('SOL', 1050n) });
    await u.post(`${path(id)}/positions/${position.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 50 });
    await t.tick(at('SOL', pct(mid(), 1300n), Date.now() + 5 * 60_000));
    const all = await orders(u, id);
    expect(all.find((o) => o.kind === 'TakeProfit')!.status).toBe('executed');
    expect(all.find((o) => o.kind === 'Market' && !o.isIncrease)).toMatchObject({ status: 'canceled', statusDetail: 'Position closed' }); // cancelled by the fill that closed it
    const list = await fills(u, id);
    expect(list).toHaveLength(2);
    expect(Number(list[1]!.realizedPnl)).toBeGreaterThan(2_900); // +30% on 10,000 less fees, at the gap price
  });
});

describe('scenario 6: closes placed between two ticks 30% apart', () => {
  it('a practice close is cancelled by its slippage limit (0.5% and the 5% maximum alike) and the position is liquidated instead', async () => {
    for (const slippageBps of [50, 500]) {
      const u = await t.user();
      const id = practiceOf(u);
      const { position } = await opened(u, id, { sizeUsd: '25000', collateralUsd: '1250' });
      const close = await u.post(`${path(id)}/positions/${position.id}/close`, { clientId: clientId(), percent: 100, slippageBps });
      expect(close.statusCode, close.body).toBe(200);
      expect((await positions(u, id))[0]!.closing).toBe(true);
      await t.tick(at('SOL', pct(mid(), 700n)));
      const order = (await orders(u, id)).find((o) => o.kind === 'Market' && !o.isIncrease)!;
      expect(order.status, `slippage ${slippageBps} bps`).toBe('canceled');
      console.log(`close with ${slippageBps} bps slippage into a −30% gap at 20x: ${order.statusDetail}`);
      expect(order.statusDetail).toMatch(/^(The exchange would not execute this order|Price moved past your slippage limit)/);
      const list = await fills(u, id);
      expect(list).toHaveLength(2);
      expect(list[1]!.feeUsd).not.toBe(list[0]!.feeUsd); // the liquidation fee is on top of the close fee
      expect(sum(list, 'realizedPnl')).toBeCloseTo(-1250, 6);
      expect((await summary(u, id)).status).toBe('breached');
    }
  });

  it('at low leverage the cancelled close leaves the position open through the gap; only a stop loss (no acceptable price) exits at the gap price', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    await base('SOL');
    const { position } = await opened(u, id, { sizeUsd: '2500', collateralUsd: '1250' }); // 2x: −30% is a loss, not a liquidation
    await u.post(`${path(id)}/positions/${position.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 500 });
    await t.tick(at('SOL', pct(mid(), 700n)));
    const close = (await orders(u, id)).find((o) => o.kind === 'Market' && !o.isIncrease)!;
    expect(close.status).toBe('canceled');
    expect(close.statusDetail).toMatch(/^Price moved past your slippage limit/);
    const [still] = await positions(u, id);
    expect(still).toMatchObject({ id: position.id, closing: false });
    expect(Number(still!.unrealizedPnl)).toBeLessThan(-740);
    // A new close at the new quote fills on the next tick; a stop loss would have filled on the gap tick itself.
    const again = await u.post(`${path(id)}/positions/${position.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 50 });
    expect(again.statusCode, again.body).toBe(200);
    await t.tick(at('SOL', pct(mid(), 700n), later()));
    expect(await positions(u, id)).toEqual([]);

    const v = await t.user();
    const vid = practiceOf(v);
    await base('SOL');
    const entry = mid();
    const { position: guarded } = await opened(v, vid, { sizeUsd: '2500', collateralUsd: '1250' });
    expect((await v.put(`${path(vid)}/positions/${guarded.id}/protection`, { takeProfit: null, stopLoss: priceAt('SOL', 990n) })).statusCode).toBe(200);
    await t.tick(at('SOL', pct(entry, 700n)));
    expect(await positions(v, vid)).toEqual([]);
    const [, exit] = await fills(v, vid);
    expect(toUnitPrice(exit!.price, 9)).toBeLessThan(pct(entry, 705n)); // filled at the gap, ~30% under the stop
  });

  it('an evaluation close waits the keeper delay, then meets the same slippage cancel and liquidation', async () => {
    const u = await t.user();
    const ev = await evaluation(u);
    const { position } = await opened(u, ev, { sizeUsd: '25000', collateralUsd: '1250' });
    await t.tick(t.md.scaled('SOL', 1, Date.now()));
    const { order } = (await u.post(`${path(ev)}/positions/${position.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 50 })).json() as SimOrderResponse;
    await t.tick(at('SOL', pct(mid(), 700n), order.createdAt + 1_999)); // inside the delay: nothing executes
    expect((await orders(u, ev)).find((o) => o.id === order.id)!.status).toBe('awaiting_execution');
    expect(await positions(u, ev)).toHaveLength(1);
    await t.tick(at('SOL', pct(mid(), 700n), order.createdAt + 2_000));
    expect((await orders(u, ev)).find((o) => o.id === order.id)).toMatchObject({ status: 'canceled' });
    expect(await summary(u, ev)).toMatchObject({ status: 'failed', equity: '23750', positions: [] });
    expect(resolved.filter((r) => r.evaluation === ev)).toHaveLength(1);
  });
});

describe('scenario 8: evaluation results decided by a gap', () => {
  it('a wick through the take profit that reverses inside the report neither fills the take profit nor marks the target: a long reads the min', async () => {
    const u = await t.user();
    const ev = await evaluation(u);
    await base('SOL');
    const tp = priceAt('SOL', 1090n); // target: 8% of 25,000 = 2,000 net
    await opened(u, ev, { sizeUsd: '25000', collateralUsd: '1250', takeProfit: tp });
    await t.tick(wick('SOL', pct(mid(), 1070n), pct(mid(), 1120n))); // max through the take profit, min short of it
    await t.rules();
    expect((await orders(u, ev)).find((o) => o.kind === 'TakeProfit')!.status).toBe('awaiting_price');
    const between = await summary(u, ev);
    expect(between.status).toBe('active'); // valued at the min: 1,750 gross, under the target
    expect(between.targetProgressPct).toBeLessThan(100);

    await t.tick(at('SOL', pct(mid(), 1095n)));
    await t.rules();
    const passed = await summary(u, ev);
    expect(passed).toMatchObject({ status: 'passed', positions: [] });
    expect(Number(passed.realizedPnl)).toBeGreaterThanOrEqual(2_000);
    const mine = resolved.filter((r) => r.evaluation === ev);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ passed: true, finalEquityUsd: passed.equity });
    await t.rules();
    expect(resolved.filter((r) => r.evaluation === ev)).toHaveLength(1);
  });

  it('a gap that liquidates one position while the other passes the target: checking, then passed on the close, never failed', async () => {
    const u = await t.user();
    const ev = await evaluation(u);
    await base('SOL');
    await base('BTC');
    await placed(u, ev, { sizeUsd: '12500', collateralUsd: '625' });
    await placed(u, ev, { symbol: 'BTC', side: 'Short', sizeUsd: '12500', collateralUsd: '625' });
    await t.tick(t.md.scaled('SOL', 1, later()), t.md.scaled('BTC', 1, later()));
    expect(await positions(u, ev)).toHaveLength(2);
    await t.tick(at('SOL', pct(mid('SOL'), 900n)), at('BTC', pct(mid('BTC'), 750n))); // SOL long wiped, BTC short +25%
    await t.rules();
    const checking = await summary(u, ev);
    expect(checking.status).toBe('checking');
    expect(checking.positions.map((p) => p.symbol)).toEqual(['BTC']);
    expect(Number(checking.realizedPnl)).toBeGreaterThan(-628); // the SOL collateral and two open fees
    expect(Number(checking.realizedPnl)).toBeLessThan(-625);
    expect(resolved.filter((r) => r.evaluation === ev)).toHaveLength(0);
    expect(await notices(u, 'Evaluation failed')).toHaveLength(0);

    const [btc] = checking.positions;
    expect((await u.post(`${path(ev)}/positions/${btc!.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 50 })).statusCode).toBe(200);
    await t.tick(at('BTC', pct(mid('BTC'), 750n), later()));
    await t.rules();
    const passed = await summary(u, ev);
    expect(passed).toMatchObject({ status: 'passed', positions: [] });
    expect(Number(passed.realizedPnl)).toBeGreaterThanOrEqual(2_000);
    const mine = resolved.filter((r) => r.evaluation === ev);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ passed: true, finalEquityUsd: passed.equity });
    expect(await fills(u, ev)).toHaveLength(4);
  });
});
