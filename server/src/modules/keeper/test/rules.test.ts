// Keeper decisions on fixtures: the session calendar (DST, holidays, early closes), what each funded-account state
// makes the keeper send next, payout reconciliation and linked positions, and the GMTrade upgrade watch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { TradeEvent } from '@props/gmtrade';
import { fillRow, roundTrip } from '../../chain/venue.ts';
import {
  GUARD_LEAD_MS, MAX_ORDERS, REVIEW_GRACE_MS, exposuresOf, linkedPositions, planStep, programDeploySlot, realizedOf, reviewPayout,
  syncDiffers, upgradeState, type AccountView, type FillRow, type OrderView, type PlanContext, type SlotView,
} from '../rules.ts';
import { covers, newYorkTime, nextSessionClose } from '../sessions.ts';

const utc = (iso: string) => Date.parse(`${iso}Z`);
const USD = 10n ** 20n;
const MIN = 60_000;

test('session calendar: NYSE closes at 16:00 New York across DST, 13:00 on early-close days, never on holidays', () => {
  assert.equal(nextSessionClose('nyse', utc('2026-09-23T16:00')), utc('2026-09-23T20:00'), 'daylight time: 16:00 EDT = 20:00 UTC');
  assert.equal(nextSessionClose('nyse', utc('2026-12-01T15:00')), utc('2026-12-01T21:00'), 'standard time: 16:00 EST = 21:00 UTC');
  // Friday after the close → Monday; DST starts Sunday 2026-03-08, so the Monday close is an hour earlier in UTC.
  assert.equal(nextSessionClose('nyse', utc('2026-03-06T21:00')), utc('2026-03-09T20:00'));
  assert.equal(nextSessionClose('nyse', utc('2026-03-06T20:59')), utc('2026-03-06T21:00'));
  // Thanksgiving closed, the day after closes at 13:00 EST.
  assert.equal(nextSessionClose('nyse', utc('2026-11-25T22:00')), utc('2026-11-27T18:00'));
  assert.equal(nextSessionClose('nyse', utc('2026-12-24T12:00')), utc('2026-12-24T18:00'), 'Christmas Eve early close');
  assert.equal(nextSessionClose('nyse', utc('2026-12-24T18:00')), utc('2026-12-28T21:00'), 'Christmas Day and the weekend skipped');
  assert.equal(nextSessionClose('nyse', utc('2026-07-02T21:00')), utc('2026-07-06T20:00'), 'Independence Day observed on Friday 07-03');
  assert.equal(nextSessionClose('nyse', utc('2027-03-25T21:00')), utc('2027-03-29T20:00'), 'Good Friday 2027');
  assert.equal(nextSessionClose('nyse', utc('2027-11-26T12:00')), utc('2027-11-26T18:00'), '2027 early close');
  assert.equal(nextSessionClose('nyse', utc('2027-12-23T22:00')), utc('2027-12-27T21:00'), 'Christmas observed on Friday 2027-12-24');
  assert.equal(nextSessionClose('nyse', utc('2027-12-31T22:00')), null, '2028 is not in the calendar');
  assert.equal(covers(utc('2027-12-31T12:00')), true);
  assert.equal(covers(utc('2028-01-03T15:00')), false);
});

test('session calendar: forex closes Friday 17:00 New York', () => {
  assert.equal(nextSessionClose('fx', utc('2026-10-28T12:00')), utc('2026-10-30T21:00'), '17:00 EDT');
  assert.equal(nextSessionClose('fx', utc('2026-10-30T21:00')), utc('2026-11-06T22:00'), 'at the close → next week, 17:00 EST after DST ends');
  assert.equal(nextSessionClose('fx', utc('2026-11-01T12:00')), utc('2026-11-06T22:00'), 'during the weekend');
  assert.equal(newYorkTime(2026, 11, 1, 1, 30), utc('2026-11-01T05:30'), 'the first 01:30 on the fall-back night (EDT)');
});

// ---------- planning ----------

const SOL = 'SolMarketToken';
const NVDA = 'NvdaMarketToken';
const EUR = 'EurMarketToken';
const slot = (index: number, marketToken: string, over: Partial<SlotView> = {}): SlotView => ({
  index, marketToken, isLong: true, gmPosition: `position-${index}`, sizeUsd: 1_000n * USD, collateral: 100_000_000n, pendingUsd: 0n, ...over,
});
const order = (o: Partial<OrderView> & Pick<OrderView, 'order'>): OrderView => ({
  slot: 0, type: 'takeProfit', sizeUsd: 10n * USD, placedByRisk: false, state: 'pending', createdAt: 1_000, ...o,
});

/** No Props fee due, none to settle. */
const NO_FEES: AccountView['fees'] = { due: 0n, settlements: 0n, plan: null, closing: null };

/** Long SOL $1,000 on $100 collateral, synced, worth its collateral; the account has $400 USDC left. */
function account(over: Partial<AccountView> = {}): AccountView {
  return {
    funded: 'Funded1', status: 'active', slots: [slot(0, SOL)], orders: [],
    positions: new Map([['position-0', { size: 1_000n * USD, collateral: 100_000_000n, netValue: 100n * USD }]]),
    value: 500n * USD, ownerLamports: 200_000_000n, fees: NO_FEES,
    markets: new Map([
      [SOL, { symbol: 'SOL', open: true, schedule: null, closedMaxLeverageBps: 0 }],
      [NVDA, { symbol: 'NVDA', open: true, schedule: 'nyse', closedMaxLeverageBps: 80_000 }],
      [EUR, { symbol: 'EUR', open: true, schedule: 'fx', closedMaxLeverageBps: 80_000 }],
    ]),
    ...over,
  };
}
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({ now: utc('2026-09-23T15:00'), ownerSolMin: 100_000_000n, tradingPaused: false, upgradePending: false, ...over });

test('a healthy, synced account needs nothing', () => {
  assert.equal(planStep(account(), ctx()), null);
});

test('breach: equity at the floor marks the account breached in a transaction of its own; a breached account\'s positions are then closed, those worth nothing left to GMTrade\'s liquidation, freeing an order slot when all 8 are used', () => {
  // Equity is at the floor only when every position is worth nothing: the mark goes alone (it needs no owner SOL, and a
  // close GMTrade refuses cannot hold it up).
  const atFloor = (over: Partial<AccountView> = {}) => account({ value: 0n, positions: new Map([['position-0', { size: 1_000n * USD, collateral: 100_000_000n, netValue: 0n }]]), ...over });
  assert.deepEqual(planStep(atFloor(), ctx()), { kind: 'breach', actions: [{ type: 'markBreached' }], detail: 'equity is at or below the account floor' });
  assert.equal(planStep(account({ value: 1n }), ctx()), null, 'one unit above the floor is not a breach');
  assert.equal(planStep(account({ value: null }), ctx()), null, 'no risk decision on stale or unvalued prices');
  // Restricted (e.g. after a GMTrade upgrade) is no shelter: the breach still ends the account.
  assert.deepEqual(planStep(atFloor({ status: 'restricted' }), ctx())?.actions, [{ type: 'markBreached' }]);
  assert.equal(planStep(atFloor({ status: 'payoutPending' }), ctx()), null, 'the program marks only active or restricted accounts');

  // Breached: a position worth nothing gets no forced close (GMTrade refuses a user decrease of an insolvent position
  // and cancels it at an execution fee); one worth something, or not valued, does.
  assert.equal(planStep(atFloor({ status: 'breached' }), ctx()), null);
  assert.deepEqual(planStep(account({ status: 'breached' }), ctx())?.actions, [{ type: 'close', slot: 0 }], 'liquidation leftovers or a recovery put V above zero');
  const unvalued = account({ status: 'breached', value: null, positions: new Map([['position-0', { size: 1_000n * USD, collateral: 100_000_000n, netValue: null }]]) });
  assert.deepEqual(planStep(unvalued, ctx())?.actions, [{ type: 'close', slot: 0 }]);

  // Two positions, one in a closed market: that one cannot be closed now.
  const two = account({
    status: 'breached', slots: [slot(0, SOL), slot(1, NVDA)],
    positions: new Map([['position-0', { size: USD, collateral: 1n, netValue: USD / 10n }], ['position-1', { size: USD, collateral: 1n, netValue: USD / 10n }]]),
  });
  two.markets.set(NVDA, { ...two.markets.get(NVDA)!, open: false });
  assert.deepEqual(planStep(two, ctx())?.actions, [{ type: 'close', slot: 0 }]);

  // All 8 tracked: a finished order is recovered first, then the trader's TP/SL before an increase.
  const full = account({
    status: 'breached',
    orders: [
      order({ order: 'inc', type: 'limit' }), order({ order: 'done', state: 'completed' }),
      ...Array.from({ length: MAX_ORDERS - 2 }, (_, i) => order({ order: `sl${i}`, type: 'stopLoss' })),
    ],
  });
  const withTwo = account({ ...full, slots: [slot(0, SOL), slot(1, SOL, { isLong: false, gmPosition: 'position-1' })],
    positions: new Map([['position-0', { size: USD, collateral: 1n, netValue: USD / 10n }], ['position-1', { size: USD, collateral: 1n, netValue: USD / 10n }]]) });
  assert.deepEqual(planStep(withTwo, ctx())?.actions, [
    { type: 'closeCompleted', order: 'done' }, { type: 'cancel', order: 'sl0' }, { type: 'close', slot: 0 }, { type: 'close', slot: 1 },
  ]);

  // Already breached with a risk close pending: nothing more to send for the breach.
  const closing = account({ status: 'breached', orders: [order({ order: 'rc', type: 'close', placedByRisk: true })] });
  assert.equal(planStep(closing, ctx())?.kind ?? null, null);
  // A risk close that GMTrade could not execute is finished: recover it and close again.
  const retry = account({ status: 'breached', orders: [order({ order: 'rc', type: 'close', placedByRisk: true, state: 'cancelled' })] });
  assert.deepEqual(planStep(retry, ctx())?.actions, [{ type: 'close', slot: 0 }]);
});

test('closure: a breached account is closed once flat, never before, and without a top-up first', () => {
  const flat = account({ status: 'breached', slots: [], positions: new Map(), value: 5n * USD, ownerLamports: 1n });
  assert.deepEqual(planStep(flat, ctx()), { kind: 'closure', actions: [{ type: 'closeFunded' }], detail: 'the breached account is flat' });
  // An order GMTrade finished but left open: recovered and synced first.
  const leftover = account({ ...flat, ownerLamports: 200_000_000n, orders: [order({ order: 'done', type: 'close', placedByRisk: true, state: 'completed' })] });
  assert.equal(planStep(leftover, ctx())?.kind, 'cleanup');
  // A position in a closed market waits for the session; the account stays open until then.
  const shut = account({ status: 'breached' });
  shut.markets.set(SOL, { ...shut.markets.get(SOL)!, open: false });
  assert.equal(planStep(shut, ctx()), null);
  assert.equal(planStep(account({ slots: [], positions: new Map() }), ctx()), null, 'a flat healthy account stays open');
});

test('Props fees: what is due is settled alone and before any breach decision; at closure in the same transaction as close_funded, never short of what is due', () => {
  const plan = { charge: 2_500_000n, waive: 800_000n, allocations: [{ order: 'open', charge: 2_500_000n, waive: 0n }, { order: 'tp', charge: 0n, waive: 800_000n }] };
  const fees = { due: 3_300_000n, settlements: 4n, plan, closing: plan };
  const settle = { type: 'settleFees', plan, expectedDue: 3_300_000n, expectedSettlements: 4n };
  // At the floor with fees due: the settlement goes first, alone (the next read decides the breach on the chain after it).
  const atFloor = account({ value: 0n, fees, positions: new Map([['position-0', { size: 1_000n * USD, collateral: 100_000_000n, netValue: 0n }]]) });
  assert.deepEqual(planStep(atFloor, ctx()), { kind: 'settle', actions: [settle], detail: '2.5 USDC of Props fees to charge, 0.8 USDC to waive' });
  assert.equal(planStep(atFloor, ctx({ skip: new Set(['settle']) }))?.kind, 'breach', 'a settlement that failed this tick holds nothing up');
  assert.equal(planStep(account({ fees: { ...fees, plan: { charge: 0n, waive: 0n, allocations: [] } } }), ctx()), null, 'nothing known to settle: nothing sent');

  // A flat breached account with fees due: settled and closed in one transaction (close_funded refuses fees due).
  const flat = account({ status: 'breached', slots: [], positions: new Map(), value: 5n * USD, fees: { ...fees, plan: null } });
  assert.deepEqual(planStep(flat, ctx()), {
    kind: 'closure', actions: [settle, { type: 'closeFunded' }], detail: 'the breached account is flat; its Props fees due are settled with its closure',
  });
  // A closing plan that does not settle all of it (the fee ledger has not caught up with the chain) waits.
  assert.equal(planStep(account({ ...flat, fees: { ...fees, plan: null, closing: { ...plan, waive: 0n } } }), ctx()), null);
  assert.equal(planStep(account({ ...flat, fees: { ...fees, plan: null, closing: null } }), ctx()), null);
});

test('payout review with Props fees: a request waits while any are due; the fees charged since the last payout count against the realized P&L', () => {
  const facts = { profit: 95_000_000n, feesDue: 0n, feesCharged: 5_000_000n, requestedAt: T0 + 40 * MIN, flat: true, verified: true, fills: tripA, links: [], now: T0 + 41 * MIN };
  assert.deepEqual(reviewPayout(facts), { decision: 'approve' }, '100 realized in fills less 5 of Props fees charged');
  assert.deepEqual(reviewPayout({ ...facts, feesDue: 1n }), { decision: 'wait', reason: 'order fees are still being settled' });
  const donated = reviewPayout({ ...facts, profit: 100_000_000n, now: facts.requestedAt + REVIEW_GRACE_MS });
  assert.deepEqual(donated, { decision: 'hold', reasons: ['Requested profit 100 USDC is more than the 95 USDC realized in GMTrade fills since the last payout (after 5 USDC of Props fees); USDC sent to the account is not profit'] });
});

test('session guard: over-levered stock and FX positions are closed from 15 minutes before the session ends, only while open', () => {
  const nvda = (over: Partial<AccountView> = {}) => account({
    slots: [slot(0, NVDA, { collateral: 50_000_000n })], positions: new Map([['position-0', { size: 1_000n * USD, collateral: 50_000_000n, netValue: 50n * USD }]]), ...over,
  }); // 20x
  const close = utc('2026-09-23T20:00');
  const at = (ms: number) => planStep(nvda(), ctx({ now: ms }));
  assert.equal(at(close - GUARD_LEAD_MS - 1), null);
  assert.deepEqual(at(close - GUARD_LEAD_MS)?.actions, [{ type: 'close', slot: 0 }]);
  assert.equal(at(close - GUARD_LEAD_MS)?.kind, 'session');
  assert.ok(close - GUARD_LEAD_MS <= close - 10 * MIN, 'orders go out at least 10 minutes before the close');
  assert.deepEqual(at(close - 1)?.actions, [{ type: 'close', slot: 0 }]);
  assert.deepEqual(planStep(nvda(), ctx({ now: utc('2026-11-27T17:50') }))?.actions, [{ type: 'close', slot: 0 }], 'early close at 13:00 EST');
  assert.equal(planStep(nvda(), ctx({ now: utc('2026-11-26T20:50') })), null, 'Thanksgiving: no session to end');

  const shut = nvda();
  shut.markets.set(NVDA, { ...shut.markets.get(NVDA)!, open: false });
  assert.equal(planStep(shut, ctx({ now: close - MIN })), null, 'never tries to close a closed market');
  const safe = nvda({ slots: [slot(0, NVDA, { sizeUsd: 400n * USD, collateral: 50_000_000n })], positions: new Map([['position-0', { size: 400n * USD, collateral: 50_000_000n, netValue: 50n * USD }]]) });
  assert.equal(planStep(safe, ctx({ now: close - MIN })), null, '8x is allowed through the close');
  const losing = nvda({ positions: new Map([['position-0', { size: 400n * USD, collateral: 50_000_000n, netValue: 45n * USD }]]) });
  assert.deepEqual(planStep(losing, ctx({ now: close - MIN }))?.actions, [{ type: 'close', slot: 0 }], 'leverage is size / net value, so losses raise it');
  const unvalued = nvda({ positions: new Map([['position-0', { size: 1_000n * USD, collateral: 50_000_000n, netValue: null }]]) });
  assert.equal(planStep(unvalued, ctx({ now: close - MIN }))?.kind, 'session', 'without a model value, leverage is size / collateral');
  const pending = nvda({ orders: [order({ order: 'rc', type: 'close', placedByRisk: true })] });
  assert.equal(planStep(pending, ctx({ now: close - MIN })), null, 'one risk close at a time');

  const eur = account({ slots: [slot(0, EUR, { collateral: 50_000_000n })], positions: new Map([['position-0', { size: 1_000n * USD, collateral: 50_000_000n, netValue: 50n * USD }]]) });
  assert.equal(planStep(eur, ctx({ now: utc('2026-10-30T20:44') })), null);
  assert.deepEqual(planStep(eur, ctx({ now: utc('2026-10-30T20:45') }))?.actions, [{ type: 'close', slot: 0 }], 'Friday 16:45 EDT');
  assert.equal(planStep(eur, ctx({ now: utc('2026-09-23T20:50') })), null, 'no forex close on a Wednesday');
  assert.equal(planStep(account(), ctx({ now: close - MIN })), null, 'crypto has no session');
});

test('owner top-up comes first, and a failed step does not block the next one', () => {
  const low = account({ ownerLamports: 99_999_999n, value: 0n });
  assert.deepEqual(planStep(low, ctx())?.actions, [{ type: 'topUp' }]);
  assert.equal(planStep(low, ctx({ skip: new Set(['topUp']) }))?.kind, 'breach');
  assert.equal(planStep(account({ status: 'closed', ownerLamports: 0n }), ctx()), null);
  // The program refuses any other top-up (round-3 audit fix): the account keeps the float it has.
  for (const status of ['restricted', 'payoutPending', 'breached'] as const) {
    assert.equal(planStep(account({ status, ownerLamports: 99_999_999n }), ctx())?.kind ?? null, status === 'breached' ? 'breach' : null, status);
  }
  assert.equal(planStep(low, ctx({ tradingPaused: true }))?.kind, 'breach', 'no top-up while trading is paused');
  assert.equal(planStep(account({ ownerLamports: 99_999_999n }), ctx({ upgradePending: true }))?.kind, 'upgrade', 'restricted first, not refilled');
});

test('upgrade watch: active accounts are restricted while an upgrade is being handled', () => {
  assert.deepEqual(planStep(account(), ctx({ upgradePending: true })), { kind: 'upgrade', actions: [{ type: 'restrict' }], detail: 'GMTrade was upgraded' });
  assert.equal(planStep(account({ status: 'restricted' }), ctx({ upgradePending: true })), null);
  assert.equal(planStep(account({ status: 'payoutPending' }), ctx({ upgradePending: true })), null, 'the program only restricts active accounts');
});

test('cleanup: finished orders are closed and synced; TP/SL without a position are cancelled unless an open is on its way', () => {
  const flat = { positions: new Map(), slots: [slot(0, SOL, { sizeUsd: 0n, collateral: 0n })] };
  assert.deepEqual(planStep(account({ orders: [order({ order: 'done', type: 'market', state: 'completed' })] }), ctx())?.actions,
    [{ type: 'closeCompleted', order: 'done' }, { type: 'sync' }]);
  assert.deepEqual(planStep(account({ ...flat, orders: [order({ order: 'sl' })] }), ctx())?.actions, [{ type: 'cancel', order: 'sl' }, { type: 'sync' }]);
  // Opened together with its position (same instant) or after the open was placed: kept for the coming position.
  const opening = [order({ order: 'open', type: 'market', sizeUsd: USD, createdAt: 1_000 })];
  const pendingSlot = { ...flat, slots: [slot(0, SOL, { sizeUsd: 0n, collateral: 0n, pendingUsd: USD })] };
  assert.equal(planStep(account({ ...pendingSlot, orders: [...opening, order({ order: 'sl', createdAt: 1_000 })] }), ctx()), null);
  // Left over from the previous position, placed before the new open: it would hit the new position.
  assert.deepEqual(planStep(account({ ...pendingSlot, orders: [...opening, order({ order: 'sl', createdAt: 900 })] }), ctx())?.actions,
    [{ type: 'cancel', order: 'sl' }, { type: 'sync' }]);
  assert.equal(planStep(account({ ...flat, orders: [order({ order: 'sl', createdAt: undefined })] }), ctx()), null, 'not indexed yet: wait');
  assert.equal(planStep(account({ orders: [order({ order: 'sl' })] }), ctx()), null, 'the position is still open');
});

test('sync runs exactly when GMTrade state differs from the last sync', () => {
  assert.equal(syncDiffers(account()), false);
  assert.equal(syncDiffers(account({ slots: [slot(0, SOL, { sizeUsd: 999n * USD })] })), true, 'position size changed');
  assert.equal(syncDiffers(account({ slots: [slot(0, SOL, { collateral: 1n })] })), true, 'collateral changed');
  assert.equal(syncDiffers(account({ orders: [order({ order: 'gone', state: 'missing' })] })), true, 'an order account is gone');
  const increase = order({ order: 'inc', type: 'market', sizeUsd: 5n * USD });
  assert.equal(syncDiffers(account({ orders: [increase] })), true, 'pending increase not in the slot yet');
  assert.equal(syncDiffers(account({ orders: [increase], slots: [slot(0, SOL, { pendingUsd: 5n * USD })] })), false);
  assert.equal(syncDiffers(account({ orders: [{ ...increase, state: 'completed' }], slots: [slot(0, SOL, { pendingUsd: 5n * USD })] })), true, 'the increase finished');
  assert.equal(syncDiffers(account({ positions: new Map(), slots: [slot(0, SOL, { sizeUsd: 0n, collateral: 0n })] })), true, 'an idle slot to free');
  assert.deepEqual(planStep(account({ slots: [slot(0, SOL, { sizeUsd: 0n })] }), ctx())?.actions, [{ type: 'sync' }]);
});

// ---------- payout review ----------

const fill = (f: Partial<FillRow> & Pick<FillRow, 'venueId' | 'ts'>): FillRow => ({
  account: 'A', position: 'posA', symbol: 'SOL', side: 'Long', isIncrease: true, sizeUsd: '1000', sizeAfterUsd: '1000',
  feeUsd: '0', fundingUsd: '0', borrowUsd: '0', realizedPnl: null, ...f,
});
const T0 = utc('2026-09-23T12:00');
const tripA = [
  fill({ venueId: '001', ts: new Date(T0), feeUsd: '0.5' }),
  fill({ venueId: '002', ts: new Date(T0 + 30 * MIN), isIncrease: false, sizeAfterUsd: '0', realizedPnl: '100.5', feeUsd: '0.6' }),
];

test('realized P&L of the fills is the closed-trade net, on a real GMTrade round trip', () => {
  const trip: (TradeEvent & { signature: string })[] = JSON.parse(readFileSync(new URL('../../chain/test/fixtures/sol-round-trip.json', import.meta.url), 'utf8'),
    (_k, v) => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
  const sol = { marketToken: 'm', symbol: 'SOL', indexToken: 'i', decimals: 9 };
  const rows = trip.map((e) => ({ ...fillRow(e, 'F', sol, e.signature), fundedAccount: 'F', platformFeeUsd: '0' }));
  assert.equal(realizedOf(rows.map((r) => ({ ...r, account: 'F' }))), BigInt(Math.round(Number(roundTrip('F', rows).netPnl) * 1e6)));
  assert.equal(realizedOf(tripA), 100_000_000n, '100.5 realized after the close fee, less the 0.5 open fee');
});

test('payout review: approve only a flat, verified account whose profit its GMTrade fills explain, with no linked positions', () => {
  const facts = { profit: 100_000_000n, feesDue: 0n, feesCharged: 0n, requestedAt: T0 + 40 * MIN, flat: true, verified: true, fills: tripA, links: [], now: T0 + 41 * MIN };
  assert.deepEqual(reviewPayout(facts), { decision: 'approve' });
  assert.deepEqual(reviewPayout({ ...facts, profit: 100_020_000n }), { decision: 'approve' }, 'within a cent per fill');

  // 50 USDC sent to the account is not trading profit.
  const donated = { ...facts, profit: 150_000_000n };
  assert.equal(reviewPayout(donated).decision, 'wait', 'the last fills may not be indexed yet');
  const held = reviewPayout({ ...donated, now: donated.requestedAt + REVIEW_GRACE_MS });
  assert.deepEqual(held, { decision: 'hold', reasons: ['Requested profit 150 USDC is more than the 100 USDC realized in GMTrade fills since the last payout; USDC sent to the account is not profit'] });
  assert.equal(reviewPayout({ ...facts, fills: [] }).decision, 'wait');

  assert.deepEqual(reviewPayout({ ...facts, flat: false, verified: false }), {
    decision: 'hold', reasons: ['The account still had GMTrade positions or orders at review', 'The trader\'s identity is not verified onchain'],
  });
});

test('linked positions: exposure added in the same market within 5 minutes of each other, both positions open after both', () => {
  const ours = exposuresOf(tripA);
  assert.deepEqual(ours, [{ account: 'A', symbol: 'SOL', side: 'Long', at: T0, closedAt: T0 + 30 * MIN }]);
  const other = (side: 'Long' | 'Short', openAt: number, closeAt: number | null, symbol = 'SOL') => exposuresOf([
    fill({ account: 'B', position: 'posB', side, symbol, venueId: '003', ts: new Date(openAt) }),
    ...(closeAt === null ? [] : [fill({ account: 'B', position: 'posB', side, symbol, venueId: '004', ts: new Date(closeAt), isIncrease: false, sizeAfterUsd: '0' })]),
  ]);
  const now = T0 + 60 * MIN;
  const hedge = linkedPositions(ours, other('Short', T0 + 4 * MIN, T0 + 50 * MIN), now);
  assert.equal(hedge.length, 1);
  assert.equal(linkedPositions(ours, other('Long', T0 - 3 * MIN, null), now).length, 1, 'a matching position still open elsewhere');
  assert.equal(linkedPositions(ours, other('Short', T0 + 6 * MIN, T0 + 50 * MIN), now).length, 0, 'added too far apart');
  assert.equal(linkedPositions(ours, other('Short', T0 + 4 * MIN, T0 + 50 * MIN, 'BTC'), now).length, 0, 'another market');
  assert.equal(linkedPositions(ours, other('Short', T0 - 4 * MIN, T0 - MIN), now).length, 0, 'flat again before ours was opened');
  assert.equal(linkedPositions(ours, exposuresOf(tripA), now).length, 0, 'never linked to itself');
  const review = reviewPayout({ profit: 100_000_000n, feesDue: 0n, feesCharged: 0n, requestedAt: T0, flat: true, verified: true, fills: tripA, links: hedge, now });
  assert.deepEqual(review, { decision: 'hold', reasons: ['Opposite Short SOL exposure added in funded account B within 5 minutes of this account\'s Long SOL (2026-09-23 12:00 UTC)'] });
  // A partial close keeps the position open; a closing fill alone adds no exposure.
  const partial = exposuresOf([...tripA.slice(0, 1), fill({ venueId: '0015', ts: new Date(T0 + MIN), isIncrease: false, sizeUsd: '500', sizeAfterUsd: '500' })]);
  assert.deepEqual(partial, [{ account: 'A', symbol: 'SOL', side: 'Long', at: T0, closedAt: null }]);
  assert.deepEqual(exposuresOf(tripA.slice(1)), []);
  // A top-up of a position opened long before (a stub kept open) adds exposure just as an open does.
  const topUp = exposuresOf([fill({ account: 'B', position: 'posB', side: 'Short', venueId: '0031', ts: new Date(T0 + 2 * MIN), sizeUsd: '999', sizeAfterUsd: '1000' })]);
  assert.deepEqual(topUp, [{ account: 'B', symbol: 'SOL', side: 'Short', at: T0 + 2 * MIN, closedAt: null }]);
  assert.equal(linkedPositions(ours, topUp, now).length, 1);
});

// ---------- GMTrade upgrade watch ----------

test('upgrade watch: the program data deploy slot, and first → upgraded → unreviewed → current (acknowledged)', () => {
  const data = Buffer.alloc(45);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(372_018_441n, 4);
  assert.equal(programDeploySlot(data), 372_018_441);
  assert.equal(programDeploySlot(data.subarray(0, 12)), 372_018_441, 'a 12-byte data slice is enough');
  data.writeUInt32LE(2, 0);
  assert.throws(() => programDeploySlot(data), /not an upgradeable program data account/);

  assert.equal(upgradeState(undefined, 10), 'first');
  assert.equal(upgradeState({ slot: 10, acknowledgedAt: new Date() }, 10), 'current');
  assert.equal(upgradeState({ slot: 10, acknowledgedAt: new Date() }, 11), 'upgraded');
  assert.equal(upgradeState({ slot: 11, acknowledgedAt: null }, 11), 'unreviewed', 'until an operator acknowledges it, however long');
  assert.equal(upgradeState({ slot: 11, acknowledgedAt: new Date() }, 10), 'current', 'a lagging RPC node\'s older deploy is not an upgrade');
  assert.equal(upgradeState({ slot: 11, acknowledgedAt: null }, 10), 'unreviewed');
});
