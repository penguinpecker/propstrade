// Black-swan load: 200 practice and 100 evaluation accounts, every one fully levered in SOL, wiped by one report.
// Once through the report's own fill step (a stop loss on each position) and once through the leader's rules pass
// (no orders). Measures wall time and Postgres statements (postgres-js debug hook on the harness's connection), what a
// trader's own request waits meanwhile, and checks that every account ends exactly once. Two defects of 3c53c9d are
// pinned here, fixed on 2026-09-25: one report's fill steps took every pool connection at once, and the rules pass
// liquidated each account at the price current when it reached it.
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { and, eq, inArray, isNull, sql as raw } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PriceTick } from '@props/shared';
import { decodePosition } from '@props/gmtrade';
import { model } from '@props/gmsol-wasm';
import { fromUnitPrice, toUnitPrice } from '@props/sdk';
import { accounts, notifications, simFills, simPositions, simResults } from '../../src/db/schema.js';
import { withPosition } from '../../src/modules/sim/model.js';
import type { EvaluationResult } from '../../src/modules/types.js';
import { startSim, type Sim } from './harness.js';

let t: Sim;
const resolved: EvaluationResult[] = [];
beforeAll(async () => { t = await startSim('blackswan_load', { onResolved: (r) => resolved.push(r) }); });
afterAll(async () => { await t.stop(); });

const later = () => Date.now() + 2_500;
const clientId = () => `c-${randomUUID()}`;
const mid = () => toUnitPrice(t.md.price('SOL')!.mid, 9);
const at = (price: bigint, ts = later()): PriceTick => {
  const p = fromUnitPrice(price, 9);
  return { symbol: 'SOL', min: p, max: p, mid: p, ts, session: 'open' };
};
const terms = { tierId: 2, sizeUsd: '25000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8_000, termsHash: 'ab'.repeat(32) };

/** 200 practice + 100 evaluation accounts, each with a 25,000 SOL long on the whole allowance (with a stop loss if asked). */
async function cohort(withStop: boolean) {
  await t.tick(t.md.scaled('SOL', 1, later())); // the recorded price, whatever an earlier test left
  const ids: string[] = [];
  const stopLoss = withStop ? fromUnitPrice((mid() * 97n) / 100n, 9) : undefined;
  for (let i = 0; i < 300; i++) {
    const wallet = Keypair.generate().publicKey.toBase58();
    let id = `practice:${wallet}`;
    if (i < 200) await t.practice({ wallet });
    else {
      id = Keypair.generate().publicKey.toBase58();
      await t.sim.createEvaluation({ evaluation: id, wallet, terms, purchasedAt: Date.now(), signature: '4'.repeat(87) });
    }
    await t.sim.engine.placeOrder(wallet, id, { clientId: clientId(), symbol: 'SOL', side: 'Long', kind: 'Market', sizeUsd: '25000', collateralUsd: '1250', slippageBps: 50, stopLoss });
    ids.push(id);
  }
  const start = performance.now();
  await t.tick(t.md.scaled('SOL', 1, later()));
  console.log(`300 opens filled by one report in ${(performance.now() - start).toFixed(0)} ms`);
  return ids;
}

/** Counts Postgres statements sent through the harness's pool while `fn` runs; `onQuery` sees each one as it is sent. */
async function counted<T>(fn: () => Promise<T>, onQuery?: (query: string) => void) {
  const kinds = new Map<string, number>();
  let statements = 0;
  const options = t.sql.options as unknown as { debug: unknown };
  options.debug = (_id: number, query: string) => {
    statements++;
    const kind = query.trim().split(/\s+/, 1)[0]!.toLowerCase();
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    onQuery?.(query);
  };
  const start = performance.now();
  try {
    const result = await fn();
    return { result, ms: performance.now() - start, statements, kinds: Object.fromEntries(kinds) };
  } finally {
    options.debug = false;
  }
}

const rowsOf = (ids: string[]) =>
  t.db.select({ id: accounts.id, stage: accounts.stage, status: accounts.status, realizedPnl: accounts.realizedPnl }).from(accounts).where(inArray(accounts.id, ids));

/** Exit fills, sealed results, floor notices and emitted results for these accounts. */
async function endings(ids: string[]) {
  const exits = await t.db.select({ n: raw<number>`count(*)::int` }).from(simFills).where(and(inArray(simFills.accountId, ids), eq(simFills.isIncrease, false)));
  const results = await t.db.select().from(simResults).where(inArray(simResults.evaluation, ids));
  const wallets = await t.db.select({ wallet: accounts.wallet }).from(accounts).where(inArray(accounts.id, ids));
  const notes = await t.db.select({ n: raw<number>`count(*)::int` }).from(notifications)
    .where(and(inArray(notifications.wallet, wallets.map((w) => w.wallet)), inArray(notifications.title, ['Practice account reached its loss limit', 'Evaluation failed'])));
  return { exits: exits[0]!.n, results: results.length, notices: notes[0]!.n, resolved: resolved.filter((r) => ids.includes(r.evaluation)).length };
}

/** A price under the liquidation price where GMTrade liquidates and a remainder is still paid out (1 bp steps). */
function solventLiquidatable(market: { market: string; virtualInventories: Record<string, string>; prices: object }, account: string, liq: bigint): bigint {
  for (let bps = 1n; bps <= 500n; bps++) {
    const p = (liq * (10_000n - bps)) / 10_000n;
    const input = { ...market, market: withPosition(market.market, account), prices: { ...(market.prices as object), index: { min: p, max: p } } } as never;
    if (!model.positionStatus(input, account).liquidatable) continue;
    if (model.simulateDecrease({ market: input, position: account, sizeDeltaUsd: decodePosition(account).state.size_in_usd, liquidation: true }).outputAmount > 0n) return p;
  }
  throw new Error('no solvent liquidatable price');
}

it('DB statements for one account: an open, a stop-loss close, a liquidation with the breach', async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const id = await t.practice({ wallet });
  await t.tick(t.md.scaled('SOL', 1, later()));
  const stop = fromUnitPrice((mid() * 97n) / 100n, 9);
  await t.sim.engine.placeOrder(wallet, id, { clientId: clientId(), symbol: 'SOL', side: 'Long', kind: 'Market', sizeUsd: '10000', collateralUsd: '500', slippageBps: 50, stopLoss: stop });
  const open = await counted(() => t.tick(t.md.scaled('SOL', 1, later())));
  const close = await counted(() => t.tick(at((mid() * 96n) / 100n)));
  expect((await t.db.select().from(simFills).where(eq(simFills.accountId, id)))).toHaveLength(2);
  const other = Keypair.generate().publicKey.toBase58();
  await t.practice({ wallet: other });
  await t.tick(t.md.scaled('SOL', 1, later()));
  await t.sim.engine.placeOrder(other, `practice:${other}`, { clientId: clientId(), symbol: 'SOL', side: 'Long', kind: 'Market', sizeUsd: '25000', collateralUsd: '1250', slippageBps: 50 });
  await t.tick(t.md.scaled('SOL', 1, later()));
  await t.tick(at((mid() * 90n) / 100n));
  const liquidation = await counted(() => t.rules());
  console.log(`statements: open fill ${open.statements}, stop-loss close ${close.statements}, liquidation + breach in the rules pass ${liquidation.statements}`, { open: open.kinds, close: close.kinds, liquidation: liquidation.kinds });
  expect((await t.db.select().from(accounts).where(eq(accounts.id, `practice:${other}`)))[0]!.status).toBe('breached');
});

it('300 accounts wiped through one report\'s fill step (a stop loss each): timing, statements, a trader\'s request meanwhile, and exactly one ending per account', async () => {
  // A bystander with a BTC position, who tries to close it while the SOL report is being processed.
  const wallet = Keypair.generate().publicKey.toBase58();
  const bystander = `practice:${wallet}`;
  await t.tick(t.md.scaled('BTC', 1, later()));
  await t.sim.engine.placeOrder(wallet, bystander, { clientId: clientId(), symbol: 'BTC', side: 'Long', kind: 'Market', sizeUsd: '1000', collateralUsd: '100', slippageBps: 50 });
  await t.tick(t.md.scaled('BTC', 1, later()));
  const [btc] = await t.db.select().from(simPositions).where(and(eq(simPositions.accountId, bystander), isNull(simPositions.closedAt)));
  const idle = performance.now();
  await t.sim.engine.setProtection(wallet, bystander, btc!.id, { takeProfit: null, stopLoss: fromUnitPrice(toUnitPrice(t.md.price('BTC')!.mid, 8) / 2n, 8) });
  const idleMs = performance.now() - idle;

  const ids = await cohort(true);
  const gap = at((mid() * 90n) / 100n);
  const timed = async (fn: () => Promise<unknown>) => {
    const start = performance.now();
    await fn();
    return performance.now() - start;
  };
  let requestMs = 0, readMs = 0, open = 0, mostOpen = 0;
  const run = await counted(async () => {
    const storm = t.tick(gap); // the report is delivered at once; its fill steps queue for the pool
    [requestMs, readMs] = await Promise.all([
      timed(() => t.sim.engine.closePosition(wallet, bystander, btc!.id, { clientId: clientId(), percent: 100, slippageBps: 50 })),
      timed(() => t.db.select({ id: accounts.id }).from(accounts).limit(1)), // what any other module's read (the keeper's) waits: one pool serves the server
    ]);
    await storm;
  }, (query) => {
    if (/^begin/i.test(query)) mostOpen = Math.max(mostOpen, ++open);
    else if (/^(commit|rollback)/i.test(query)) open--;
  });
  console.log(`fill step: 300 stops refused + 300 liquidations + 300 endings in ${run.ms.toFixed(0)} ms, ${run.statements} statements (${(run.statements / 300).toFixed(1)} per account)`, run.kinds);
  console.log(`during it a bystander's close request took ${requestMs.toFixed(0)} ms and a one-row read ${readMs.toFixed(0)} ms (${idleMs.toFixed(0)} ms for a protection change when idle); at most ${mostOpen} transactions open at once`);
  // The pool has 10 connections for the whole server: the leader's fill and rules steps take at most 4 of them at once
  // (plus the trader's own request), so another module's read does not wait for the storm.
  expect(mostOpen).toBeLessThanOrEqual(5);
  expect(readMs).toBeLessThan(run.ms / 4);
  const rows = await rowsOf(ids);
  expect(rows.filter((r) => r.status === 'breached')).toHaveLength(200);
  expect(rows.filter((r) => r.status === 'failed')).toHaveLength(100);
  for (const r of rows) expect(Number(r.realizedPnl)).toBe(-1250);
  const once = { exits: 300, results: 100, notices: 300, resolved: 100 };
  expect(await endings(ids)).toEqual(once);
  await t.rules();
  expect(await endings(ids)).toEqual(once);
}, 300_000);

it('300 identical positions liquidated by one rules pass end the same way, whatever their place in the pass: a report landing mid-pass decides nothing in it (one price per market per pass)', async () => {
  const ids = await cohort(false);
  const entry = mid();
  const [first] = await t.db.select().from(simPositions).where(and(eq(simPositions.accountId, ids[0]!), isNull(simPositions.closedAt)));
  const account = (first!.modelState as { account: string }).account;
  const state = await t.md.marketState(t.md.market('SOL')!.marketToken);
  const raw = state.raw as { market: string; virtualInventories: Record<string, string> };
  const liq = model.positionStatus({ market: withPosition(raw.market, account), virtualInventories: raw.virtualInventories, prices: { ...state.prices, index: { min: entry, max: entry } } }, account).liquidationPrice!;
  const band = solventLiquidatable({ ...raw, prices: state.prices }, account, liq);
  const tick = await counted(() => t.tick(at(band))); // liquidatable, a remainder left: nothing happens on the report itself
  expect(tick.statements).toBe(0);

  let commits = 0;
  const run = await counted(() => t.rules(), (query) => {
    if (/^commit/i.test(query) && ++commits === 100) t.md.push(at((entry * 90n) / 100n)); // the crash goes on while the pass works
  });
  console.log(`rules pass: 300 liquidations + endings in ${run.ms.toFixed(0)} ms, ${run.statements} statements (${(run.statements / 300).toFixed(1)} per account)`, run.kinds);
  const rows = await rowsOf(ids);
  const kept = rows.filter((r) => Number(r.realizedPnl) > -1250);
  const wiped = rows.filter((r) => Number(r.realizedPnl) === -1250);
  const byStatus = (list: typeof rows) => list.reduce<Record<string, number>>((m, r) => ({ ...m, [`${r.stage}:${r.status}`]: (m[`${r.stage}:${r.status}`] ?? 0) + 1 }), {});
  console.log(`same position, same report: ${kept.length} liquidated with a remainder`, byStatus(kept), `${wiped.length} at the floor`, byStatus(wiped));
  const failed = wiped.filter((r) => r.stage === 'evaluation').length;
  expect(await endings(ids)).toEqual({ exits: 300, results: failed, notices: wiped.length, resolved: failed }); // each ended once either way
  expect(kept.length + wiped.length).toBe(300);
  expect(Math.min(kept.length, wiped.length), 'identical evaluations failed or lived on by their place in the pass').toBe(0);
}, 300_000);
