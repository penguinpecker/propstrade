// Black-swan scenarios on session-restricted markets: the 10% closed-market liquidation factor GMTrade applies to
// stocks the moment the Market account is flagged Closed, a weekend gap at the reopen, the flag lagging the price
// report, and the closed-session leverage guard funded accounts get before the close. NVDA's Market account in the
// fixture is the real closed one (EnableMarketClosedParams on). The session guard's parity test was a confirmed defect at
// 3c53c9d (evaluations had no guard), fixed on 2026-09-25.
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Fill, PriceTick, SimOrderRequest, SimOrderResponse } from '@props/shared';
import { decodePosition } from '@props/gmtrade';
import { model, type ModelInput } from '@props/gmsol-wasm';
import { fromUnitPrice, toUnitPrice } from '@props/sdk';
import { simFills, simPositions } from '../../src/db/schema.js';
import { GUARD_LEAD_MS, leverageAbove } from '../../src/modules/keeper/rules.js';
import { nextSessionClose } from '../../src/modules/keeper/sessions.js';
import { withPosition } from '../../src/modules/sim/model.js';
import { startSim, type Sim } from './harness.js';

let t: Sim;
beforeAll(async () => { t = await startSim('blackswan_closed'); });
afterAll(async () => { await t.stop(); });
afterEach(async () => {
  t.md.closed.set('NVDA', true); // back to the recorded state
  await t.tick({ ...t.md.scaled('NVDA', 1), session: 'closed' });
});

type User = Awaited<ReturnType<Sim['user']>>;
const practiceOf = (u: User) => `practice:${u.wallet}`;
const path = (id: string) => `/v1/sim/${encodeURIComponent(id)}`;
const clientId = () => `c-${randomUUID()}`;
const later = () => Date.now() + 2_500;
const DEC = 8; // NVDA index token decimals

async function placed(u: User, id: string, body: Partial<SimOrderRequest> = {}) {
  const res = await u.post(`${path(id)}/orders`, {
    clientId: clientId(), symbol: 'NVDA', side: 'Long', kind: 'Market', sizeUsd: '8000', collateralUsd: '1000', slippageBps: 50, ...body,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SimOrderResponse;
}
/** An NVDA report at `permille` of the recorded closing price. */
const nvda = (permille: bigint, session: PriceTick['session'], ts = later()): PriceTick => ({ ...t.md.scaled('NVDA', Number(permille) / 1000, ts), session });
const mid = () => toUnitPrice(t.md.price('NVDA')!.mid, DEC);
const priceAt = (permille: bigint) => fromUnitPrice((mid() * permille) / 1000n, DEC);
async function input(index: { min: bigint; max: bigint }, position?: string): Promise<ModelInput> {
  const state = await t.md.marketState(t.md.market('NVDA')!.marketToken);
  const raw = state.raw as { market: string; virtualInventories: Record<string, string> };
  return { market: position ? withPosition(raw.market, position) : raw.market, virtualInventories: raw.virtualInventories, prices: { ...state.prices, index } };
}
const units = (p: PriceTick) => ({ min: toUnitPrice(p.min, DEC), max: toUnitPrice(p.max, DEC) });
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

/** Opens the market and an 8x NVDA long (the stock leverage cap), filled at the recorded price. */
async function openedAtCap(u: User, id: string, body: Partial<SimOrderRequest> = {}) {
  t.md.closed.set('NVDA', false);
  await t.tick(nvda(1000n, 'open'));
  await placed(u, id, body);
  await t.tick(nvda(1000n, 'open'));
  const [position] = await positions(u, id);
  return { position: position!, account: await modelAccount(position!.id) };
}

describe('scenario 4: the closed-market liquidation factor', () => {
  it('an 8x stock long 3% down is safe while open (1% factor) and is liquidated at the close on the frozen price (10% factor), report age notwithstanding', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    const { position, account } = await openedAtCap(u, id);
    expect(position.leverage).toBeCloseTo(8, 1);
    await t.tick(nvda(970n, 'open'));
    await t.rules();
    expect(await positions(u, id)).toHaveLength(1); // −3% at 8x: 12.5% collateral less the loss is still far above 1%
    const closing = nvda(970n, 'closed', Date.now() - 30_000); // 20:00 New York: the last report stands, 30 s old, and the account is flagged Closed
    expect(model.positionStatus(await input(units(closing), account), account).liquidatable).toBe(false); // the open factor
    t.md.closed.set('NVDA', true);
    expect(model.positionStatus(await input(units(closing), account), account).liquidatable).toBe(true); // the closed factor: 12.5% − 3% − fees < 10%
    const expected = model.simulateDecrease({
      market: await input(units(closing), account), position: account, sizeDeltaUsd: decodePosition(account).state.size_in_usd, liquidation: true,
    });
    await t.tick(closing);
    await t.rules();
    expect(await positions(u, id)).toEqual([]);
    const [open, liquidation] = await fills(u, id);
    expect(liquidation).toMatchObject({ isIncrease: false, price: fromUnitPrice(expected.executionPrice, DEC) });
    expect(Number(liquidation!.feeUsd)).toBeGreaterThan(Number(open!.feeUsd) * 1.5); // close fee plus the liquidation fee
    expect(Number(open!.realizedPnl) + Number(liquidation!.realizedPnl)).toBeGreaterThanOrEqual(-1000);
    expect(Number(liquidation!.realizedPnl)).toBeLessThan(-240); // the 3% loss, the fees, and what the liquidation keeps
    expect((await t.sim.activity(u.wallet, id))!.some((a) => a.type === 'liquidation')).toBe(true);
    console.log(`NVDA 8x long, −3% into the close: liquidated at ${liquidation!.price}, fill P&L ${liquidation!.realizedPnl}, fee ${liquidation!.feeUsd}`);
  });

  it('at the cap with the price flat, the close does not liquidate (12.5% > 10%); the buffer is about 2.5% of size less fees', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    const { account } = await openedAtCap(u, id);
    t.md.closed.set('NVDA', true);
    await t.tick(nvda(1000n, 'closed'));
    await t.rules();
    expect(await positions(u, id)).toHaveLength(1);
    let edge = 0n;
    for (let permille = 999n; permille >= 960n; permille--) {
      const p = (mid() * permille) / 1000n;
      if (model.positionStatus(await input({ min: p, max: p }, account), account).liquidatable) { edge = permille; break; }
    }
    console.log(`NVDA 8x long while closed: liquidatable from a ${(1000n - edge)}‰ drop on`);
    expect(edge).toBeGreaterThanOrEqual(970n);
    expect(edge).toBeLessThanOrEqual(978n);
  });

  it('nothing executes while closed; a weekend gap at the reopen refuses the stop as insolvent and liquidates for exactly the collateral', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    const stop = priceAt(950n);
    const { position } = await openedAtCap(u, id, { stopLoss: stop });
    expect(position.stopLoss).toMatchObject({ price: stop });
    t.md.closed.set('NVDA', true);
    await t.tick(nvda(1000n, 'closed', Date.now() - 60_000));
    await t.rules();
    expect(await positions(u, id)).toHaveLength(1);
    const close = await u.post(`${path(id)}/positions/${position.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 500 });
    expect([close.statusCode, close.json().error.code]).toEqual([409, 'market_closed']);

    t.md.closed.set('NVDA', false);
    await t.tick(nvda(850n, 'open')); // Monday 09:30 New York: −15%
    const sl = (await orders(u, id)).find((o) => o.kind === 'StopLoss')!;
    expect(sl.status).toBe('canceled');
    expect(sl.statusDetail).toMatch(/^The exchange would not execute this order/);
    expect(await positions(u, id)).toEqual([]);
    const list = await fills(u, id);
    expect(list).toHaveLength(2);
    expect((await t.db.select().from(simFills).where(eq(simFills.accountId, id))).find((f) => !f.isIncrease)!.orderId).toBeNull();
    expect(list.reduce((s, f) => s + Number(f.realizedPnl), 0)).toBeCloseTo(-1000, 6);
    expect(await summary(u, id)).toMatchObject({ status: 'near_limit', equity: '24000' });
  });

  it('a gap reported while the market is still flagged closed liquidates on the frozen session (10% factor); the stop loss never gets a turn', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    const { position } = await openedAtCap(u, id, { stopLoss: priceAt(970n) });
    t.md.closed.set('NVDA', true);
    await t.tick(nvda(960n, 'closed')); // −4%: through the stop, under the closed factor's line
    await t.rules();
    expect(await positions(u, id)).toEqual([]);
    const sl = (await orders(u, id)).find((o) => o.kind === 'StopLoss')!;
    expect(sl).toMatchObject({ status: 'canceled', statusDetail: 'Position closed' });
    const exit = (await t.db.select().from(simFills).where(eq(simFills.accountId, id))).find((f) => !f.isIncrease)!;
    expect(exit.orderId).toBeNull();
    expect(exit.positionId).toBe(position.id);
  });

  it('when the report says open but the Market account still carries the Closed flag, nothing executes and the closed factor still applies', async () => {
    const u = await t.user();
    const id = practiceOf(u);
    const { position } = await openedAtCap(u, id, { stopLoss: priceAt(980n) });
    t.md.closed.set('NVDA', true);
    await t.tick(nvda(970n, 'open')); // the price feed reopened, the account flag lags
    expect((await orders(u, id)).find((o) => o.kind === 'StopLoss')!.status).toBe('awaiting_price'); // refused while flagged closed, as GMTrade refuses decreases
    const open = await u.post(`${path(id)}/positions/${position.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 50 });
    expect([open.statusCode, open.json().error.code]).toEqual([409, 'market_closed']);
    await t.rules();
    expect(await positions(u, id)).toEqual([]); // liquidated at 10% although the report says open
    expect((await t.db.select().from(simFills).where(eq(simFills.accountId, id))).find((f) => !f.isIncrease)!.orderId).toBeNull();
  });
});

describe('scenario 4: the session guard funded accounts have', () => {
  it('closes an evaluation stock position above the closed-session leverage cap in the last 15 minutes before the close, as the keeper does for funded accounts', async () => {
    const u = await t.user();
    const ev = await evaluation(u);
    const close = nextSessionClose('nyse', Date.now())!;
    vi.useFakeTimers({ toFake: ['Date'], now: close - 20 * 60_000, shouldAdvanceTime: true }); // 20 minutes before the NYSE close
    try {
      const { account } = await openedAtCap(u, ev); // 8x: NVDA's max leverage, which is also its closed-session cap
      await t.tick(nvda(990n, 'open'));
      await t.rules();
      expect(await positions(u, ev), 'before the guard\'s window it is held').toHaveLength(1);
      vi.setSystemTime(close - 10 * 60_000); // 10 minutes before the close
      await t.tick(nvda(990n, 'open'));
      const status = model.positionStatus(await input(units(t.md.price('NVDA')!), account), account);
      const { size_in_usd: size, collateral_amount: collateral } = decodePosition(account).state;
      expect(Date.now()).toBeGreaterThanOrEqual(close - GUARD_LEAD_MS);
      expect(leverageAbove({ size, collateral, netValue: status.netValue }, t.md.market('NVDA')!.closedMaxLeverage! * 10_000)).toBe(true); // keeper/rules.ts: a funded account's position is closed now
      expect(status.liquidatable).toBe(false);
      await t.rules();
      expect(await positions(u, ev), 'the position is not held into the close').toEqual([]);
      const exit = (await t.db.select().from(simFills).where(eq(simFills.accountId, ev))).find((f) => !f.isIncrease)!;
      expect(exit.orderId, 'a close at the report (a CLOSE_ALL market decrease, as the keeper places), not a liquidation').not.toBeNull();
      expect((await t.sim.activity(u.wallet, ev))!.some((a) => a.type === 'risk' && a.title === 'Long NVDA closed before the market closes')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
