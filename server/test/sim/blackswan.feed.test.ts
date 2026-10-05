// Black-swan scenarios: a price feed that repeats a second, goes backwards (~5% of GMTrade's HTTP polls do), stalls
// for minutes and resumes with a jump. What the engine must do: never fill on a quote older than the request, never
// liquidate twice, execute exactly one protective order when a wide report crosses both. See engine.test.ts for the harness.
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fill, PriceTick, SimOrderRequest, SimOrderResponse } from '@props/shared';
import { PriceBook, decodePosition } from '@props/gmtrade';
import { model, type ModelInput } from '@props/gmsol-wasm';
import { fromUnitPrice, toUnitPrice } from '@props/sdk';
import { notifications, simFills, simOrders, simPositions } from '../../src/db/schema.js';
import { withPosition } from '../../src/modules/sim/model.js';
import type { EvaluationResult } from '../../src/modules/types.js';
import { startSim, type Sim } from './harness.js';

let t: Sim;
const resolved: EvaluationResult[] = [];
beforeAll(async () => { t = await startSim('blackswan_feed', { onResolved: (r) => resolved.push(r) }); });
afterAll(async () => { await t.stop(); });

type User = Awaited<ReturnType<Sim['user']>>;
const practiceOf = (u: User) => `practice:${u.wallet}`;
const path = (id: string) => `/v1/sim/${encodeURIComponent(id)}`;
const clientId = () => `c-${randomUUID()}`;
const later = () => Date.now() + 2_500;
const DECIMALS: Record<string, number> = { SOL: 9, BTC: 8, XAU: 8, EUR: 9, NVDA: 8 };

async function placed(u: User, id: string, body: Partial<SimOrderRequest> = {}) {
  const res = await u.post(`${path(id)}/orders`, {
    clientId: clientId(), symbol: 'SOL', side: 'Long', kind: 'Market', sizeUsd: '10000', collateralUsd: '1000', slippageBps: 50, ...body,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SimOrderResponse;
}
const base = (symbol: string, session: PriceTick['session'] = 'open') => t.tick({ ...t.md.scaled(symbol, 1), session });
const at = (symbol: string, price: bigint, ts = later()): PriceTick => {
  const p = fromUnitPrice(price, DECIMALS[symbol]!);
  return { symbol, min: p, max: p, mid: p, ts, session: 'open' };
};
const wick = (symbol: string, min: bigint, max: bigint, ts = later()): PriceTick => ({
  symbol, min: fromUnitPrice(min, DECIMALS[symbol]!), max: fromUnitPrice(max, DECIMALS[symbol]!), mid: fromUnitPrice((min + max) / 2n, DECIMALS[symbol]!), ts, session: 'open',
});
const mid = (symbol = 'SOL') => toUnitPrice(t.md.price(symbol)!.mid, DECIMALS[symbol]!);
const pct = (unit: bigint, permille: bigint) => (unit * permille) / 1000n;
const priceAt = (symbol: string, permille: bigint) => fromUnitPrice(pct(mid(symbol), permille), DECIMALS[symbol]!);
const orders = async (u: User, id: string) => (await t.sim.orders(u.wallet, id))!;
const positions = async (u: User, id: string) => (await t.sim.positions(u.wallet, id))!;
const summary = async (u: User, id: string) => (await t.sim.detail(u.wallet, id))!;
const fills = async (u: User, id: string) => (await u.get(`${path(id)}/fills`)).json() as Fill[];
const notices = (u: User, title: string) => t.db.select().from(notifications).where(and(eq(notifications.wallet, u.wallet), eq(notifications.title, title)));
const modelAccount = async (positionId: string) =>
  ((await t.db.select().from(simPositions).where(eq(simPositions.id, positionId)))[0]!.modelState as { account: string }).account;
/** SOL as GMTrade's model sees it at `index`, with `position` in the pool. */
async function input(index: { min: bigint; max: bigint }, position: string): Promise<ModelInput> {
  const state = await t.md.marketState(t.md.market('SOL')!.marketToken);
  const raw = state.raw as { market: string; virtualInventories: Record<string, string> };
  return { market: withPosition(raw.market, position), virtualInventories: raw.virtualInventories, prices: { ...state.prices, index } };
}

async function evaluation(u: User) {
  const id = Keypair.generate().publicKey.toBase58();
  const terms = { tierId: 2, sizeUsd: '25000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8_000, termsHash: 'ab'.repeat(32) };
  await t.sim.createEvaluation({ evaluation: id, wallet: u.wallet, terms, purchasedAt: Date.now(), signature: '4'.repeat(87) });
  return id;
}

describe('scenario 2: reports that repeat a second or go backwards', () => {
  it('an armed stop loss ignores an older report and a same-second report through it, and fills on the next second\'s', async () => {
    const u = await t.user();
    const id = await t.practice(u);
    await base('SOL');
    const stop = priceAt('SOL', 970n);
    await placed(u, id, { stopLoss: stop });
    const armedAt = later();
    await t.tick(t.md.scaled('SOL', 1, armedAt)); // fills the open; the stop is armed from this report (executable from ts + 1 ms)
    const [open] = await positions(u, id);
    expect(open!.stopLoss).toMatchObject({ price: stop });
    const account = await modelAccount(open!.id);
    const through = pct(mid(), 950n);
    await t.tick(at('SOL', through, armedAt - 5_000)); // an older report, 5% down: the feed went backwards
    expect((await orders(u, id)).find((o) => o.kind === 'StopLoss')!.status).toBe('awaiting_price');
    await t.tick(at('SOL', through, armedAt)); // the same second again, another price
    expect((await orders(u, id)).find((o) => o.kind === 'StopLoss')!.status).toBe('awaiting_price');
    expect(await positions(u, id)).toHaveLength(1);
    const expected = model.simulateDecrease({ market: await input({ min: through, max: through }, account), position: account, sizeDeltaUsd: decodePosition(account).state.size_in_usd });
    await t.tick(at('SOL', through, armedAt + 1_000));
    expect((await orders(u, id)).find((o) => o.kind === 'StopLoss')!.status).toBe('executed');
    expect(await positions(u, id)).toEqual([]);
    expect((await fills(u, id))[1]!.price).toBe(fromUnitPrice(expected.executionPrice, 9)); // that report's price, with the close's own price impact
  });

  it('an order placed between two same-second reports fills on the next second\'s report at its price', async () => {
    const u = await t.user();
    const id = await t.practice(u);
    const seenAt = later();
    await t.tick(t.md.scaled('SOL', 1, seenAt));
    const { order } = await placed(u, id);
    await t.tick(at('SOL', pct(mid(), 1002n), seenAt)); // the same second, a different price: not newer than the quote seen
    expect((await orders(u, id)).find((o) => o.id === order.id)!.status).toBe('awaiting_execution');
    await t.tick(at('SOL', pct(mid(), 998n), seenAt + 1_000));
    expect((await orders(u, id)).find((o) => o.id === order.id)!.status).toBe('executed');
    expect(toUnitPrice((await fills(u, id))[0]!.price, 9)).toBeGreaterThan(pct(mid(), 997n));
    expect(toUnitPrice((await fills(u, id))[0]!.price, 9)).toBeLessThan(pct(mid(), 1001n));
  });

  it('the engine itself would liquidate on a backwards report under 20 s old: it relies on the feed\'s monotonic filter, which drops such a report', async () => {
    // The harness delivers whatever is pushed; production marketdata reads prices through KeeperFeed's PriceBook.
    const u = await t.user();
    const id = await t.practice(u);
    await base('SOL');
    const lastAt = later();
    await placed(u, id, { sizeUsd: '25000', collateralUsd: '1250' });
    await t.tick(t.md.scaled('SOL', 1, lastAt));
    const older = at('SOL', pct(mid(), 880n), lastAt - 5_000); // −12%, stamped 5 s before the last accepted report
    await t.tick(older);
    await t.rules();
    expect(await positions(u, id)).toEqual([]); // liquidated on the older report: the engine has no monotonic guard of its own
    expect((await summary(u, id)).status).toBe('breached');

    const book = new PriceBook();
    const price = (p: PriceTick) => ({ min: p.min, max: p.max, ts: Math.floor(p.ts / 1000), isOpen: true });
    expect(book.accept('SOL', price(t.md.scaled('SOL', 1, lastAt)))).toBe(true);
    expect(book.accept('SOL', price(older)), 'the feed drops it before the engine sees it').toBe(false);
    expect(book.accept('SOL', price(at('SOL', pct(mid(), 990n), lastAt))), 'a same-second report with another price passes').toBe(true);
  });

  it('never liquidates twice: two concurrent rules passes and the report\'s own fill step write one liquidation and one notice', async () => {
    const u = await t.user();
    const id = await t.practice(u);
    await base('SOL');
    await placed(u, id, { sizeUsd: '25000', collateralUsd: '1250', stopLoss: priceAt('SOL', 970n) });
    await t.tick(t.md.scaled('SOL', 1, later()));
    const gap = at('SOL', pct(mid(), 900n));
    t.md.push(gap); // the fill step (stop refused, liquidation) is queued …
    await Promise.all([t.sim.engine.rulesPass(), t.sim.engine.rulesPass()]); // … while two passes see the same insolvent mark
    await t.sim.engine.settled();
    await t.tick({ ...gap, ts: gap.ts + 1_000 });
    await t.rules();
    const rows = await t.db.select().from(simFills).where(eq(simFills.accountId, id));
    expect(rows.filter((f) => !f.isIncrease)).toHaveLength(1);
    expect(await notices(u, 'Practice account reached its loss limit')).toHaveLength(1);
    expect((await t.sim.activity(u.wallet, id))!.filter((a) => a.type === 'liquidation')).toHaveLength(1);
    expect(await summary(u, id)).toMatchObject({ status: 'breached', equity: '23750' });
  });
});

describe('scenario 3: a feed stale for minutes, then a jump', () => {
  it('a market order older than 30 minutes is dropped by the rules pass during the stall; on the resume report the rest execute within their slippage or are cancelled', async () => {
    const u = await t.user();
    const [a, b, c] = [await evaluation(u), await evaluation(u), await evaluation(u)];
    await base('SOL');
    const { order: wide } = await placed(u, a, { slippageBps: 500 });
    const { order: tight } = await placed(u, b, { slippageBps: 50 });
    const { order: old } = await placed(u, c, { slippageBps: 500 });
    await t.db.update(simOrders).set({ createdAt: new Date(Date.now() - 31 * 60_000) }).where(eq(simOrders.id, old.id)); // the feed has been silent 31 min for it
    await t.rules(); // the pass runs every second whether or not reports arrive
    expect((await orders(u, c)).find((o) => o.id === old.id)).toMatchObject({ status: 'canceled', statusDetail: 'Expired: the exchange drops market orders not executed within 30 minutes' });
    expect((await summary(u, c)).availableMargin).toBe('1250');

    await t.tick(at('SOL', pct(mid(), 1020n), Date.now() + 3 * 60_000)); // the feed resumes 2% higher
    expect((await orders(u, a)).find((o) => o.id === wide.id)!.status).toBe('executed');
    const cancelled = (await orders(u, b)).find((o) => o.id === tight.id)!;
    expect(cancelled.status).toBe('canceled');
    expect(cancelled.statusDetail).toMatch(/^Price moved past your slippage limit/);
    expect((await summary(u, b)).availableMargin).toBe('1250');
    expect(await fills(u, c)).toEqual([]);
  });

  it('a wide report that spans both protective triggers fills exactly one of them: the one on the side of the quote GMTrade reads', async () => {
    const u = await t.user();
    const id = await t.practice(u);
    await base('SOL');
    const [tp, sl] = [priceAt('SOL', 1050n), priceAt('SOL', 970n)];
    await placed(u, id, { takeProfit: tp, stopLoss: sl });
    await t.tick(t.md.scaled('SOL', 1, later()));
    await t.tick(wick('SOL', pct(mid(), 960n), pct(mid(), 1060n))); // min under the stop, max over the take profit
    const all = await orders(u, id);
    expect(all.find((o) => o.kind === 'StopLoss')!.status).toBe('executed'); // a long is valued and closed at the min
    expect(all.find((o) => o.kind === 'TakeProfit')).toMatchObject({ status: 'canceled', statusDetail: 'Position closed' });
    const list = await fills(u, id);
    expect(list).toHaveLength(2);
    expect(Number(list[1]!.realizedPnl)).toBeLessThan(-390); // −4% on 10,000 and the fees

    const v = await t.user();
    const vid = await t.practice(v);
    await base('SOL');
    await placed(v, vid, { side: 'Short', takeProfit: priceAt('SOL', 950n), stopLoss: priceAt('SOL', 1030n) });
    await t.tick(t.md.scaled('SOL', 1, later()));
    await t.tick(wick('SOL', pct(mid(), 940n), pct(mid(), 1040n)));
    const short = await orders(v, vid);
    expect(short.find((o) => o.kind === 'StopLoss')!.status).toBe('executed'); // a short is valued and closed at the max
    expect(short.find((o) => o.kind === 'TakeProfit')!.status).toBe('canceled');
  });

  it('after a stall the account\'s rules decide on the first fresh report, never on the stale one', async () => {
    const u = await t.user();
    const ev = await evaluation(u);
    await base('SOL');
    await placed(u, ev, { sizeUsd: '25000', collateralUsd: '1250' });
    await t.tick(t.md.scaled('SOL', 1, later()));
    await t.tick(at('SOL', pct(mid(), 900n), Date.now() - 4 * 60_000)); // a −10% quote, but four minutes old
    await t.rules();
    expect(await summary(u, ev)).toMatchObject({ status: 'active', freshness: 'stale' });
    expect(await positions(u, ev)).toHaveLength(1);
    expect(resolved.filter((r) => r.evaluation === ev)).toHaveLength(0);
    await t.tick(at('SOL', pct(mid(), 900n), Date.now()));
    await t.rules();
    expect(await summary(u, ev)).toMatchObject({ status: 'failed', equity: '23750', positions: [] });
    expect(resolved.filter((r) => r.evaluation === ev)).toHaveLength(1);
  });
});
