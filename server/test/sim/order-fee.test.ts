// Props.trade's fee per order on practice and evaluation accounts (docs/design/order-fee.md §9), simulated as the program
// charges it on funded accounts: assessed at placement (an increase on its size, a close / take profit / stop loss on the
// account's exposure cap), held against new exposure while an increase is pending, and charged at the fill: at most the
// assessment, the rate of that assessment on the size executed. Liquidations are free; the session guard's closes are
// charged like the trader's own. The rate here is the chain module's (the program's), which the harness lets a test move.
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClosedTrade, Fill, Order, Performance, PriceTick, SimOrderRequest, SimOrderResponse } from '@props/shared';
import { CLOSE_ALL, orderFee } from '@props/sdk';
import { referralRewards, simFills } from '../../src/db/schema.js';
import type { OrderFeeRateInfo } from '../../src/lib/order-fee.js';
import { nextSessionClose } from '../../src/modules/keeper/sessions.js';
import { startSim, type Sim } from './harness.js';

const RATE_A: OrderFeeRateInfo = { feeUsdc: 500_000n, feeBps: 2, source: 'program' }; // $0.50 + 2 bps
const RATE_B: OrderFeeRateInfo = { feeUsdc: 1_000_000n, feeBps: 5, source: 'program' }; // $1 + 5 bps
let rate = RATE_A;
let t: Sim;
beforeAll(async () => { t = await startSim('order_fee', { orderFeeRate: async () => rate }); });
afterAll(async () => { await t.stop(); });

type User = Awaited<ReturnType<Sim['user']>>;
const USD = 10n ** 20n;
const practiceOf = (u: User) => `practice:${u.wallet}`;
const path = (id: string) => `/v1/sim/${encodeURIComponent(id)}`;
const clientId = () => `c-${randomUUID()}`;
const later = () => Date.now() + 2_500;
/** A fee in USDC as the API writes it. */
const usdc = (micro: bigint) => (Number(micro) / 1e6).toString();
const fee = (r: OrderFeeRateInfo, sizeUsd: number, capUsd?: number) =>
  usdc(orderFee(r, sizeUsd === Infinity ? CLOSE_ALL : BigInt(sizeUsd) * USD, capUsd === undefined ? undefined : BigInt(capUsd) * USD));

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
const base = (symbol = 'SOL') => t.tick({ ...t.md.scaled(symbol, 1), session: 'open' });
const at = (factor: number, symbol = 'SOL'): PriceTick => ({ ...t.md.scaled(symbol, factor, later()), session: 'open' });
const orders = async (u: User, id: string) => (await t.sim.orders(u.wallet, id))!;
const positions = async (u: User, id: string) => (await t.sim.positions(u.wallet, id))!;
const summary = async (u: User, id: string) => (await t.sim.detail(u.wallet, id))!;
const fills = async (u: User, id: string) => (await u.get(`${path(id)}/fills`)).json() as Fill[];
const micro = (v: string) => BigInt(Math.round(Number(v) * 1e6));
const price = (factor: number) => (Number(t.md.price('SOL')!.mid) * factor).toFixed(4);

describe('practice: the program\'s fee rule, simulated', () => {
  it('assesses an open on its size and its take profit and stop loss on the exposure cap, holds the open\'s fee while it is pending, and charges each fill what it executed', async () => {
    rate = RATE_A;
    const u = await t.user();
    const id = practiceOf(u);
    await base();
    const { order, account } = await placed(u, id, { takeProfit: price(1.05), stopLoss: price(0.95) });
    expect(order.platformFeeUsd).toBe(fee(RATE_A, 10_000)); // 0.5 + 2 bps of $10,000 = 2.5
    expect(order.platformFeeUsd).toBe('2.5');
    // The open's collateral and its fee are both kept out of the margin (the program holds a pending increase's fee).
    expect([account.availableMargin, account.platformFees]).toEqual(['747.5', { dueUsd: '0', paidUsd: '0', heldUsd: '2.5' }]);
    const protection = (await orders(u, id)).filter((o) => o.kind !== 'Market');
    // A close-all take profit or stop loss is assessed on the $25,000 practice exposure cap: the most it can cost.
    expect(protection.map((o) => [o.kind, o.platformFeeUsd]).sort()).toEqual([['StopLoss', '5.5'], ['TakeProfit', '5.5']]);

    await t.tick(at(1));
    const [open] = await fills(u, id);
    const [position] = await positions(u, id);
    expect(open!.platformFeeUsd).toBe('2.5');
    // The fill's realized P&L is the collateral the exchange's fee left, less the Props fee.
    expect(micro(open!.realizedPnl!)).toBe(micro(position!.collateralUsd) - 500_000_000n - 2_500_000n);
    expect(position!.platformFeeUsd).toBe('2.5'); // closing $10,000 at the current rate
    const after = await summary(u, id);
    expect([after.platformFees, after.realizedPnl]).toEqual([{ dueUsd: '0', paidUsd: '2.5', heldUsd: '0' }, open!.realizedPnl]);

    // A 40% close is assessed on its $4,000 and charged that.
    const close = await u.post(`${path(id)}/positions/${position!.id}/close`, { clientId: clientId(), percent: 40, slippageBps: 50 });
    expect(close.statusCode, close.body).toBe(200);
    expect((close.json() as SimOrderResponse).order.platformFeeUsd).toBe('1.3');
    await t.tick(at(1));
    // The take profit closes the other $6,000: charged the rate on that, not its $5.50 assessment.
    await t.tick(at(1.06));
    await t.tick(at(1.06));
    expect(await positions(u, id)).toEqual([]);
    const all = await fills(u, id);
    expect(all.map((f) => [f.isIncrease, f.sizeUsd, f.platformFeeUsd])).toEqual([[true, '10000', '2.5'], [false, '4000', '1.3'], [false, '6000', '1.7']]);
    const [trip] = (await t.sim.history(u.wallet, id))! as ClosedTrade[];
    expect(trip!.platformFeeUsd).toBe('5.5');
    expect(micro(trip!.feesUsd)).toBe(micro(trip!.orderFeesUsd) + micro(trip!.platformFeeUsd) + micro(trip!.fundingUsd) + micro(trip!.borrowUsd));
    expect(micro(trip!.netPnl), 'net of every fee: the sum of the fills').toBe(all.reduce((s, f) => s + micro(f.realizedPnl ?? '0'), 0n));
    const perf = (await t.sim.performance(u.wallet, id, 'All'))! as Performance;
    expect(perf.platformFeesUsd).toBe('5.5');
    expect((await summary(u, id)).platformFees).toEqual({ dueUsd: '0', paidUsd: '5.5', heldUsd: '0' });
    expect((await t.sim.activity(u.wallet, id))!.some((a) => a.type === 'fill' && a.detail.includes('after a $1.70 Props fee'))).toBe(true);
  });

  it('an order the rate changed under is charged at the rate it was assessed at; a new order at the new rate', async () => {
    rate = RATE_A;
    const u = await t.user();
    const id = practiceOf(u);
    await base();
    const limit = (await placed(u, id, { kind: 'Limit', triggerPrice: price(0.99) })).order;
    expect(limit.platformFeeUsd).toBe('2.5');
    rate = RATE_B;
    await t.tick(at(0.98));
    const [filled] = await fills(u, id);
    expect(filled!.platformFeeUsd).toBe('2.5');
    await base();
    const next = (await placed(u, id, { sizeUsd: '5000', collateralUsd: '250' })).order;
    expect(next.platformFeeUsd).toBe(fee(RATE_B, 5_000)); // $1 + 5 bps of $5,000 = 3.5
    expect(next.platformFeeUsd).toBe('3.5');
    rate = RATE_A;
  });

  it('an order that adds exposure must leave its own fee and the pending increases\' in the margin, as the program requires', async () => {
    rate = RATE_A;
    const u = await t.user();
    const id = practiceOf(u);
    await base();
    const all = await place(u, id, { sizeUsd: '10000', collateralUsd: '1250' });
    expect([all.statusCode, all.json().error]).toEqual([422, { code: 'order_rejected', message: 'Margin $1,250.00 and the $2.50 Props fee are more than the $1,250.00 available' }]);
    const allIn = await placed(u, id, { sizeUsd: '10000', collateralUsd: '1247.5' });
    expect([allIn.account.availableMargin, allIn.account.platformFees.heldUsd]).toEqual(['0', '2.5']);
    const second = await place(u, id, { sizeUsd: '20', collateralUsd: '2' });
    expect(second.json().error.message).toBe('Margin $2.00 and the $0.50 Props fee are more than the $0.00 available');
  });

  it('is simulated: a referred trader\'s Props fee earns its referrer nothing', async () => {
    rate = RATE_A;
    const referrer = await t.user();
    const u = await t.user();
    expect((await u.post('/v1/me/referrer', { code: referrer.wallet.slice(0, 8) })).statusCode).toBe(200);
    const id = practiceOf(u);
    await base();
    await placed(u, id);
    await t.tick(at(1));
    expect((await fills(u, id)).map((f) => f.platformFeeUsd)).toEqual(['2.5']);
    expect(await t.db.select().from(referralRewards).where(eq(referralRewards.referee, u.wallet))).toEqual([]);
  });

  it('a liquidation pays no Props fee', async () => {
    rate = RATE_A;
    const u = await t.user();
    const id = practiceOf(u);
    await base();
    await placed(u, id, { sizeUsd: '20000', collateralUsd: '1000' }); // 20x
    await t.tick(at(1));
    await t.tick(at(0.9));
    await t.rules();
    expect(await positions(u, id)).toEqual([]);
    const [open, liquidation] = await fills(u, id);
    expect([open!.platformFeeUsd, liquidation!.platformFeeUsd]).toEqual(['4.5', '0']); // 0.5 + 2 bps of $20,000; free
    const rows = await t.db.select().from(simFills).where(eq(simFills.accountId, id));
    expect(rows.find((f) => !f.isIncrease)!.orderId, 'no order of the account: GMTrade\'s liquidation').toBeNull();
    expect((await summary(u, id)).platformFees.paidUsd).toBe('4.5');
  });

  it('at the owner\'s rate ($2 + 10 bps) the same orders cost exactly their Props fees more than at 0: $3.00 a $1,000 fill, a close-all assessed on the $25,000 cap and charged on the $1,000 it closed', async () => {
    const OWNER: OrderFeeRateInfo = { feeUsdc: 2_000_000n, feeBps: 10, source: 'program' };
    const ZERO: OrderFeeRateInfo = { feeUsdc: 0n, feeBps: 0, source: 'program' };
    expect([fee(OWNER, 1_000), fee(OWNER, 2_000, 25_000), fee(OWNER, Infinity, 25_000)]).toEqual(['3', '4', '27']);
    // Two practice accounts trade the same orders at the same prices, a (referred) at the owner's rate, b at 0.
    const referrer = await t.user();
    const [a, b] = [await t.user(), await t.user()];
    expect((await a.post('/v1/me/referrer', { code: referrer.wallet.slice(0, 8) })).statusCode).toBe(200);
    const [idA, idB] = [practiceOf(a), practiceOf(b)];
    const open = async (u: User, id: string, r: OrderFeeRateInfo) => { rate = r; return placed(u, id, { sizeUsd: '1000', collateralUsd: '100' }); };
    const close = async (u: User, id: string, percent: number, r: OrderFeeRateInfo) => {
      rate = r;
      const [p] = await positions(u, id);
      const res = await u.post(`${path(id)}/positions/${p!.id}/close`, { clientId: clientId(), percent, slippageBps: 50 });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as SimOrderResponse;
    };
    await base();
    // $1,000 opened: a's is assessed $3.00 and held beside its $100 margin until the fill.
    const [openA, openB] = [await open(a, idA, OWNER), await open(b, idB, ZERO)];
    expect([openA.order.platformFeeUsd, openB.order.platformFeeUsd, openA.account.platformFees.heldUsd]).toEqual(['3', '0', '3']);
    expect(micro(openB.account.availableMargin) - micro(openA.account.availableMargin)).toBe(3_000_000n);
    await t.tick(at(1));
    // $1,000 more, a $1,000 close, then a close of the rest (assessed its maximum: the rate on the $25,000 cap).
    await open(a, idA, OWNER);
    await open(b, idB, ZERO);
    await t.tick(at(1));
    expect((await close(a, idA, 50, OWNER)).order.platformFeeUsd).toBe('3');
    await close(b, idB, 50, ZERO);
    await t.tick(at(1));
    expect((await close(a, idA, 100, OWNER)).order.platformFeeUsd).toBe('27');
    await close(b, idB, 100, ZERO);
    await t.tick(at(1));
    expect([await positions(a, idA), await positions(b, idB)]).toEqual([[], []]);
    const [fillsA, fillsB] = [await fills(a, idA), await fills(b, idB)];
    expect(fillsA.map((f) => [f.isIncrease, f.sizeUsd, f.platformFeeUsd])).toEqual([[true, '1000', '3'], [true, '1000', '3'], [false, '1000', '3'], [false, '1000', '3']]);
    expect(fillsB.map((f) => f.platformFeeUsd)).toEqual(['0', '0', '0', '0']);
    // The exchange's side is identical, so each fill's realized P&L differs by exactly its Props fee, the account by $12.
    expect(fillsA.map((f) => [f.price, f.feeUsd])).toEqual(fillsB.map((f) => [f.price, f.feeUsd]));
    expect(fillsA.map((f, i) => micro(f.realizedPnl ?? '0') - micro(fillsB[i]!.realizedPnl ?? '0'))).toEqual(Array(4).fill(-3_000_000n));
    const [sa, sb] = [await summary(a, idA), await summary(b, idB)];
    for (const k of ['equity', 'realizedPnl', 'allowanceRemaining', 'availableMargin'] as const) expect(micro(sa[k]) - micro(sb[k]), k).toBe(-12_000_000n);
    expect([sa.platformFees, sb.platformFees]).toEqual([{ dueUsd: '0', paidUsd: '12', heldUsd: '0' }, { dueUsd: '0', paidUsd: '0', heldUsd: '0' }]);
    expect(await t.db.select().from(referralRewards).where(eq(referralRewards.referee, a.wallet))).toEqual([]); // simulated: nothing earned
    rate = RATE_A;
  });
});

describe('evaluation: the session guard\'s close', () => {
  it('is charged like the trader\'s own close (the program assesses a risk close of an account that is not breached)', async () => {
    rate = RATE_A;
    const u = await t.user();
    const ev = Keypair.generate().publicKey.toBase58();
    const terms = { tierId: 2, sizeUsd: '25000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8_000, termsHash: 'ab'.repeat(32) };
    await t.sim.createEvaluation({ evaluation: ev, wallet: u.wallet, terms, purchasedAt: Date.now(), signature: '4'.repeat(87) });
    const close = nextSessionClose('nyse', Date.now())!;
    vi.useFakeTimers({ toFake: ['Date'], now: close - 20 * 60_000, shouldAdvanceTime: true }); // before the guard's 15 minutes
    try {
      t.md.closed.set('NVDA', false);
      await base('NVDA');
      const open = await placed(u, ev, { symbol: 'NVDA', sizeUsd: '8000', collateralUsd: '1000' }); // 8x, the closed-session cap
      expect(open.order.platformFeeUsd).toBe('2.1');
      await t.tick(at(1, 'NVDA'));
      expect(await positions(u, ev)).toHaveLength(1);
      vi.setSystemTime(close - 10 * 60_000); // inside them
      await t.tick(at(0.99, 'NVDA'));
      await t.rules();
      expect(await positions(u, ev)).toEqual([]);
      const exit = (await t.db.select().from(simFills).where(eq(simFills.accountId, ev))).find((f) => !f.isIncrease)!;
      expect(exit.orderId, 'a close order, not a liquidation').not.toBeNull();
      expect(exit.platformFeeUsd).toBe('2.100000'); // assessed $5.50 on the $25,000 cap, charged 0.5 + 2 bps of the $8,000 it closed
      const guardOrder = (await orders(u, ev)).find((o: Order) => o.id === exit.orderId)!;
      expect(guardOrder.platformFeeUsd).toBe('5.5');
    } finally {
      vi.useRealTimers();
      t.md.closed.set('NVDA', true);
      await t.tick({ ...t.md.scaled('NVDA', 1), session: 'closed' });
    }
  });
});
