// Black-swan scenarios on costs: borrowing and funding accrued through a crash and through a leader outage, at the
// recorded SOL rates. GMTrade's model accrues from the Market account's clocks to the wall clock (clockAgeSeconds in
// the harness) and from the position's own last change (stampPosition), exactly as engine.test.ts 'fees over time'.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Fill, PriceTick, SimOrderRequest, SimOrderResponse } from '@props/shared';
import { decodePosition } from '@props/gmtrade';
import { model, type ModelInput } from '@props/gmsol-wasm';
import { fromUnitPrice, toUnitPrice } from '@props/sdk';
import { simPositions } from '../../src/db/schema.js';
import { stampPosition, withPosition } from '../../src/modules/sim/model.js';
import { startSim, type Sim } from './harness.js';

let t: Sim;
beforeAll(async () => { t = await startSim('blackswan_fees'); });
afterAll(async () => { await t.stop(); });
afterEach(() => { t.md.clockAgeSeconds = 0; });

type User = Awaited<ReturnType<Sim['user']>>;
const practiceOf = (u: User) => `practice:${u.wallet}`;
const path = (id: string) => `/v1/sim/${encodeURIComponent(id)}`;
const clientId = () => `c-${randomUUID()}`;
const later = () => Date.now() + 2_500;
const DAY = 24;

async function placed(u: User, id: string, body: Partial<SimOrderRequest> = {}) {
  const res = await u.post(`${path(id)}/orders`, {
    clientId: clientId(), symbol: 'SOL', side: 'Long', kind: 'Market', sizeUsd: '25000', collateralUsd: '1250', slippageBps: 50, ...body,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SimOrderResponse;
}
const base = (symbol: string, session: PriceTick['session'] = 'open') => t.tick({ ...t.md.scaled(symbol, 1), session });
const positions = async (u: User, id: string) => (await t.sim.positions(u.wallet, id))!;
const summary = async (u: User, id: string) => (await t.sim.detail(u.wallet, id))!;
const fills = async (u: User, id: string) => (await u.get(`${path(id)}/fills`)).json() as Fill[];
async function input(index: { min: bigint; max: bigint }, position?: string): Promise<ModelInput> {
  const state = await t.md.marketState(t.md.market('SOL')!.marketToken);
  const raw = state.raw as { market: string; virtualInventories: Record<string, string> };
  return { market: position ? withPosition(raw.market, position) : raw.market, virtualInventories: raw.virtualInventories, prices: { ...state.prices, index } };
}
const units = (p: PriceTick) => ({ min: toUnitPrice(p.min, 9), max: toUnitPrice(p.max, 9) });
const modelAccount = async (positionId: string) =>
  ((await t.db.select().from(simPositions).where(eq(simPositions.id, positionId)))[0]!.modelState as { account: string }).account;
const total = (list: Fill[]) => list.reduce((s, f) => s + Number(f.realizedPnl), 0);

/** The side that pays borrowing on SOL in the recorded state. */
async function payingSide(): Promise<'Long' | 'Short'> {
  const rates = model.marketStatus(await input(units(t.md.price('SOL')!)));
  return rates.borrowingRatePerSecondForLong >= rates.borrowingRatePerSecondForShort ? 'Long' : 'Short';
}

/** Re-stamps the open position as changed `hours` ago and ages the market clocks past that. */
async function aged(positionId: string, hours: number) {
  const account = await modelAccount(positionId);
  await t.db.update(simPositions).set({ modelState: { account: stampPosition(account, true, new Date(Date.now() - hours * 3_600_000)) } })
    .where(eq(simPositions.id, positionId));
  t.md.clockAgeSeconds = (hours + 1) * 3_600;
}

/** A 20x SOL position on the whole practice allowance, on the side that pays. */
async function levered(u: User) {
  const id = await t.practice(u);
  await base('SOL');
  await placed(u, id, { side: await payingSide() });
  await t.tick(t.md.scaled('SOL', 1, later()));
  const [open] = await positions(u, id);
  return { id, open: open! };
}

describe('scenario 5: fee accrual through a crash', () => {
  it('an hour costs a 20x position well under 1 bp; fees alone take weeks to make it liquidatable, that liquidation returns the remainder above the floor, and only a longer leader outage ends it, exactly at the floor', async () => {
    const u = await t.user();
    const { id, open } = await levered(u);
    await aged(open.id, 1);
    const [hour] = await positions(u, id);
    const perHour = Number(hour!.pendingBorrowUsd) + Number(hour!.pendingFundingUsd);
    console.log(`SOL ${open.side} 25,000 for one hour: borrowing ${hour!.pendingBorrowUsd}, funding ${hour!.pendingFundingUsd}`);
    expect(perHour).toBeGreaterThan(0);
    expect(perHour).toBeLessThan(2.5); // < 1 bp of size: an hour of chaos cannot move the account by fees

    let days = 0;
    for (days = 1; days <= 60; days++) {
      await aged(open.id, days * DAY);
      const account = await modelAccount(open.id);
      if (model.positionStatus(await input(units(t.md.price('SOL')!), account), account).liquidatable) break;
    }
    expect(days).toBeGreaterThanOrEqual(7);
    expect(days).toBeLessThanOrEqual(60);
    const [marked] = await positions(u, id);
    console.log(`liquidatable by fees alone after ${days} days flat: borrowing ${marked!.pendingBorrowUsd}, funding ${marked!.pendingFundingUsd}`);
    expect((await summary(u, id)).status).toBe('active'); // no rule has run yet

    await t.tick(t.md.scaled('SOL', 1, later())); // the price has not moved
    await t.rules();
    expect(await positions(u, id)).toEqual([]);
    const [, exit] = await fills(u, id);
    expect(Number(exit!.borrowUsd) + Number(exit!.fundingUsd)).toBeGreaterThan(1_000); // the fees the liquidation settles
    expect(total(await fills(u, id))).toBeGreaterThan(-1_250); // the liquidation returned what was left
    const after = await summary(u, id);
    expect(after.status).toBe('near_limit');
    expect(Number(after.equity)).toBeGreaterThan(23_750);
    expect((await t.sim.activity(u.wallet, id))!.some((a) => a.type === 'liquidation')).toBe(true);

    // No rules pass for twice that long (a leader outage): the fees ate the whole collateral; still no debt.
    const v = await t.user();
    const late = await levered(v);
    await aged(late.open.id, days * 2 * DAY);
    await t.tick(t.md.scaled('SOL', 1, later()));
    await t.rules();
    expect(await fills(v, late.id)).toHaveLength(2);
    expect(total(await fills(v, late.id))).toBeCloseTo(-1_250, 6);
    expect(await summary(v, late.id)).toMatchObject({ status: 'breached', equity: '23750' });
  });

  it('a gap liquidation settles the accrued borrowing and funding with the close and liquidation fees, and still loses exactly the collateral', async () => {
    const u = await t.user();
    const { id, open } = await levered(u);
    await aged(open.id, 12);
    const account = await modelAccount(open.id);
    const isLong = open.side === 'Long';
    const gap = t.md.scaled('SOL', isLong ? 0.9 : 1.1, later()); // 10% against the position in one report
    const expected = model.simulateDecrease({
      market: await input(units(gap), account), position: account, sizeDeltaUsd: decodePosition(account).state.size_in_usd, liquidation: true,
    });
    expect(expected.outputAmount).toBe(0n);
    await t.tick(gap);
    await t.rules();
    const [, exit] = await fills(u, id);
    expect(exit).toMatchObject({ isIncrease: false, sizeUsd: '25000', price: fromUnitPrice(expected.executionPrice, 9) });
    expect(Number(exit!.borrowUsd)).toBeCloseTo(Number(expected.fees.borrowingFeeAmount) / 1e6, 5);
    expect(Number(exit!.fundingUsd)).toBeCloseTo(Number(expected.fees.fundingFeeAmount) / 1e6, 5);
    expect(Number(exit!.borrowUsd)).toBeGreaterThan(0);
    expect(Number(exit!.feeUsd)).toBeCloseTo(Number(expected.fees.orderFeeValue + expected.fees.liquidationFeeValue!) / 1e20, 6);
    expect(total(await fills(u, id))).toBeCloseTo(-1_250, 6);
    expect(await summary(u, id)).toMatchObject({ status: 'breached', equity: '23750' });
  });

  it('funding received is never credited: after six hours the receiving side shows no funding and its close realizes only costs', async () => {
    const [u, v] = [await t.user(), await t.user()];
    await base('SOL');
    const [a, b] = await Promise.all([t.practice(u), t.practice(v)]);
    await placed(u, a, { side: 'Long', sizeUsd: '10000', collateralUsd: '500' });
    await placed(v, b, { side: 'Short', sizeUsd: '10000', collateralUsd: '500' });
    await t.tick(t.md.scaled('SOL', 1, later()));
    const [long, short] = [(await positions(u, a))[0]!, (await positions(v, b))[0]!];
    await aged(long.id, 6);
    await aged(short.id, 6);
    const pending = { Long: Number((await positions(u, a))[0]!.pendingFundingUsd), Short: Number((await positions(v, b))[0]!.pendingFundingUsd) };
    console.log('pending funding after 6 h on 10,000:', pending);
    const [receiver, id, pos] = pending.Long === 0 ? [u, a, long] : [v, b, short];
    expect(Math.min(pending.Long, pending.Short)).toBe(0); // one side pays …
    expect(Math.max(pending.Long, pending.Short)).toBeGreaterThan(0);
    const close = await receiver.post(`${path(id)}/positions/${pos.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 50 });
    expect(close.statusCode, close.body).toBe(200);
    await t.tick(t.md.scaled('SOL', 1, later()));
    const [, exit] = await fills(receiver, id);
    expect(Number(exit!.fundingUsd)).toBe(0); // … and the other is credited nothing
    expect(Number(exit!.realizedPnl)).toBeLessThan(0);
  });
});
