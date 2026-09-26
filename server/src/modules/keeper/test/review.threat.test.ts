// Threat-model review: a funded account whose equity reached the floor must end (mark_breached, then close_funded once
// flat), as its evaluation would (sim: failed is terminal). Nothing in the server, the keeper, the admin API or
// scripts/admin sends either instruction, so a breached account stays `restricted` for good: its SOL float and any
// leftover USDC stay in the owner PDA, Config.allocated_principal keeps its principal, TraderProfile.active_funded
// stays 1 (the trader's next passed evaluation cannot be activated: AlreadyFunded), and once liquidation leftovers put
// V above zero the keeper no longer sees a breach, so lifting the restriction (the documented step after a GMTrade
// upgrade review) lets the account trade again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStep, type AccountView, type PlanContext } from '../rules.ts';

const USD = 10n ** 20n;
const SOL = 'SolMarketToken';
const ctx: PlanContext = { now: Date.parse('2026-09-23T15:00:00Z'), ownerSolMin: 100_000_000n, tradingPaused: false, upgradePending: false };
const actions = (v: AccountView) => planStep(v, ctx)?.actions.map((a) => a.type as string) ?? [];

/** Long SOL worth nothing: equity is at the floor (V = 0). */
const atFloor: AccountView = {
  funded: 'Funded1', status: 'active',
  slots: [{ index: 0, marketToken: SOL, isLong: true, gmPosition: 'position-0', sizeUsd: 1_000n * USD, collateral: 1n, pendingUsd: 0n }],
  orders: [], positions: new Map([['position-0', { size: 1_000n * USD, collateral: 1n, netValue: 0n }]]), value: 0n,
  ownerLamports: 200_000_000n, markets: new Map([[SOL, { symbol: 'SOL', open: true, schedule: null, closedMaxLeverageBps: 0 }]]),
  fees: { due: 0n, settlements: 0n, plan: null, closing: null },
};

test('reaching the floor marks the funded account breached onchain, not only restricted', () => {
  const planned = actions(atFloor);
  assert.ok(planned.includes('markBreached'), `the keeper plans ${JSON.stringify(planned)}`);
});

test('a breached account that is flat is closed: SOL float and USDC back to the vault, principal and the trader\'s slot released', () => {
  // A liquidation left $5 of collateral in the owner's USDC account.
  const flat: AccountView = { ...atFloor, status: 'breached', slots: [], positions: new Map(), value: 5n * USD };
  const planned = actions(flat);
  assert.ok(planned.includes('closeFunded'), `the keeper plans ${JSON.stringify(planned)}`);
});
