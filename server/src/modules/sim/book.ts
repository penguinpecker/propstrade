// The simulated book: row types, loaders, API forms, and valuation with live marks from GMTrade's model.
// ARCHITECTURE.md §1 definitions, in USDC micro units (m = 1e-6 USDC):
//   equity = S + realized + unrealized; allowance = equity − (S − L);
//   available margin = L + realized − Σ collateral of open positions − Σ collateral of pending increase orders.
// realized moves only on fills: an increase realizes its costs (collateral in minus collateral credited), a decrease
// or liquidation realizes what it pays out minus the collateral it releases. So realized = Σ fills' realizedPnl.
import { and, asc, desc, eq, inArray, isNull, not, or, type SQL } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import type { AccountRules, AccountSummary, Fill, Order, OrderStatus, Position, PriceTick } from '@props/shared';
import { model, type PositionStatus } from '@props/gmsol-wasm';
import type * as schema from '../../db/schema.ts';
import { accounts, evaluations, simFills, simOrders, simPositions, simResults } from '../../db/schema.ts';
import type { MarketDataService, MarketState } from '../types.ts';
import { micro, microText, modelInput, priceText, tickUnits, trim, usd, usdText, usdToMicro } from './model.ts';

export type Q = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;
export type AccountRow = typeof accounts.$inferSelect & { purchaseSignature: string | null; resultSignature: string | null };
export type PositionRow = typeof simPositions.$inferSelect;
export type OrderRow = typeof simOrders.$inferSelect;
export type FillRow = typeof simFills.$inferSelect;

export const PENDING: OrderStatus[] = ['awaiting_execution', 'awaiting_price'];
/** Statuses that accept new orders; the others only close (passed, failed, breached). */
export const TRADING = new Set<string>(['active', 'near_limit', 'checking']);
export const STALE_MS = 20_000;
export const practiceId = (wallet: string) => `practice:${wallet}`;
export const shortIdOf = (a: Pick<AccountRow, 'id' | 'stage'>) => (a.stage === 'practice' ? 'PRACTICE' : `PT-${a.id.slice(0, 4)}…`);

/** The model's Position account image (base64), which carries GMTrade's fee checkpoints. */
export const modelAccount = (p: PositionRow) => (p.modelState as { account: string }).account;

/** Accounts a wallet can see: its evaluations and its live practice account (archived practice accounts are not). */
export const visibleTo = (wallet: string) =>
  and(eq(accounts.wallet, wallet), or(eq(accounts.stage, 'evaluation'), eq(accounts.id, practiceId(wallet))));

async function selectAccounts(q: Q, where: SQL | undefined): Promise<AccountRow[]> {
  // The result's transaction as the chain module confirmed it to the engine (markRecorded).
  const rows = await q.select({ account: accounts, purchaseSignature: evaluations.purchaseSignature, resultSignature: simResults.recordedSignature })
    .from(accounts).leftJoin(evaluations, eq(evaluations.address, accounts.id)).leftJoin(simResults, eq(simResults.evaluation, accounts.id)).where(where);
  return rows.map((row) => ({ ...row.account, purchaseSignature: row.purchaseSignature, resultSignature: row.resultSignature }));
}

export async function loadAccount(q: Q, id: string, wallet?: string): Promise<AccountRow | undefined> {
  const [row] = await selectAccounts(q, wallet === undefined ? eq(accounts.id, id) : and(eq(accounts.id, id), visibleTo(wallet)));
  return row;
}

export const loadAccounts = async (q: Q, ids: string[]) => (ids.length ? selectAccounts(q, inArray(accounts.id, ids)) : []);

export async function loadBook(q: Q, accountId: string) {
  const [positions, orders] = await Promise.all([
    q.select().from(simPositions).where(and(eq(simPositions.accountId, accountId), isNull(simPositions.closedAt))).orderBy(asc(simPositions.openedAt)),
    q.select().from(simOrders).where(and(eq(simOrders.accountId, accountId), inArray(simOrders.status, PENDING))).orderBy(asc(simOrders.createdAt)),
  ]);
  return { positions, orders };
}
export type Book = Awaited<ReturnType<typeof loadBook>>;

/** Pending orders first, then the 50 most recently finished; newest first within each. */
export async function orderList(q: Q, accountId: string): Promise<Order[]> {
  const byAccount = eq(simOrders.accountId, accountId);
  const [pending, done] = await Promise.all([
    q.select().from(simOrders).where(and(byAccount, inArray(simOrders.status, PENDING))).orderBy(desc(simOrders.createdAt)),
    q.select().from(simOrders).where(and(byAccount, not(inArray(simOrders.status, PENDING)))).orderBy(desc(simOrders.updatedAt)).limit(50),
  ]);
  return [...pending, ...done].map(toOrder);
}

export function toOrder(o: OrderRow): Order {
  return {
    id: o.id, symbol: o.symbol, side: o.side, kind: o.kind, isIncrease: o.isIncrease, sizeUsd: trim(o.sizeUsd),
    collateralUsd: o.collateralUsd === null ? null : trim(o.collateralUsd),
    triggerPrice: o.triggerPrice === null ? null : trim(o.triggerPrice),
    acceptablePrice: o.acceptablePrice === null ? null : trim(o.acceptablePrice),
    status: o.status, ...(o.statusDetail ? { statusDetail: o.statusDetail } : {}),
    createdAt: o.createdAt.getTime(), updatedAt: o.updatedAt.getTime(),
  };
}

export function toFill(f: FillRow): Fill {
  return {
    id: f.id, symbol: f.symbol, side: f.side, isIncrease: f.isIncrease, sizeUsd: trim(f.sizeUsd), price: trim(f.price),
    feeUsd: trim(f.feeUsd), priceImpactUsd: trim(f.priceImpactUsd), fundingUsd: trim(f.fundingUsd), borrowUsd: trim(f.borrowUsd),
    realizedPnl: f.realizedPnl === null ? null : trim(f.realizedPnl), ts: f.ts.getTime(), venue: 'simulated',
  };
}

export interface Mark { position: PositionRow; tick?: PriceTick; state?: MarketState; status?: PositionStatus }

/** Values each open position at the latest tick with the live market state, as GMTrade would (pending fees included). */
export async function markPositions(md: MarketDataService, positions: PositionRow[]): Promise<Mark[]> {
  return Promise.all(positions.map(async (position): Promise<Mark> => {
    const tick = md.price(position.symbol);
    if (!tick) return { position }; // no price yet (market data starting): nothing to value against
    const state = await md.marketState(position.marketToken).catch(() => undefined);
    if (!state) return { position, tick };
    try {
      const account = modelAccount(position);
      return { position, tick, state, status: model.positionStatus(modelInput(state, tickUnits(tick, state.indexDecimals), account), account) };
    } catch {
      return { position, tick, state };
    }
  }));
}

const unrealizedOf = (m: Mark) => (m.status && m.state ? usdToMicro(m.status.netValue - m.status.collateralValue, m.state) : undefined);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function rulesOf(a: AccountRow): AccountRules {
  const size = micro(a.sizeUsd);
  return {
    sizeUsd: trim(a.sizeUsd), lossAllowanceUsd: trim(a.lossAllowanceUsd), floorUsd: microText(size - micro(a.lossAllowanceUsd)),
    profitTargetUsd: a.profitTargetUsd === null ? null : trim(a.profitTargetUsd),
    maxExposureUsd: microText((size * BigInt(a.maxExposureBps)) / 10_000n), traderShareBps: a.traderShareBps,
    drawdownType: 'static', includesOpenPnl: true, dailyLossLimit: null, timeLimit: null,
    termsHash: a.termsHash, version: a.termsVersion,
  };
}

export function toPosition(m: Mark, orders: OrderRow[]): Position {
  const p = m.position;
  const protection = (kind: 'TakeProfit' | 'StopLoss') => {
    const o = orders.find((x) => x.positionId === p.id && x.kind === kind && PENDING.includes(x.status));
    return o ? { price: trim(o.triggerPrice!), orderId: o.id, status: o.status } : null;
  };
  const unrealized = unrealizedOf(m);
  const leverage = m.status?.leverage ? Number(m.status.leverage) / 1e20 : Number(p.sizeUsd) / Number(p.collateralUsd);
  return {
    id: p.id, symbol: p.symbol, side: p.side,
    sizeUsd: trim(p.sizeUsd), sizeTokens: trim(p.sizeTokens), collateralUsd: trim(p.collateralUsd), leverage: round2(leverage),
    entryPrice: trim(p.entryPrice), markPrice: m.tick?.mid ?? null,
    liquidationPrice: m.status?.liquidationPrice && m.state ? priceText(m.status.liquidationPrice, m.state.indexDecimals) : null,
    unrealizedPnl: unrealized === undefined ? null : microText(unrealized),
    pendingFeesUsd: m.status ? usdText(m.status.pendingBorrowingFeeValue + m.status.pendingFundingFeeValue) : '0',
    takeProfit: protection('TakeProfit'), stopLoss: protection('StopLoss'),
    openedAt: p.openedAt.getTime(), venue: 'simulated',
  };
}

export interface Valuation {
  summary: AccountSummary;
  positions: Position[];
  /** micro USDC */
  equity: bigint; realized: bigint; unrealized: bigint;
  /** Every open position has a mark; rules decide nothing on a partial valuation. */
  complete: boolean;
}

export function value(a: AccountRow, marks: Mark[], orders: OrderRow[], now = Date.now()): Valuation {
  const size = micro(a.sizeUsd);
  const allowance = micro(a.lossAllowanceUsd);
  const target = a.profitTargetUsd === null ? null : micro(a.profitTargetUsd);
  const realized = micro(a.realizedPnl);
  let unrealized = 0n, collateral = 0n, notional = 0n, complete = true, stale = false;
  for (const m of marks) {
    collateral += micro(m.position.collateralUsd);
    notional += usd(m.position.sizeUsd);
    const u = unrealizedOf(m);
    if (u === undefined) complete = false;
    else unrealized += u;
    if (m.tick?.session === 'open' && now - m.tick.ts > STALE_MS) stale = true;
  }
  const reserved = orders.reduce((sum, o) => sum + (o.isIncrease && o.collateralUsd ? micro(o.collateralUsd) : 0n), 0n);
  const equity = size + realized + unrealized;
  const summary: AccountSummary = {
    id: a.id, stage: a.stage, status: a.status, label: a.label,
    shortId: shortIdOf(a),
    rules: rulesOf(a),
    equity: microText(equity), realizedPnl: microText(realized), unrealizedPnl: microText(unrealized),
    allowanceRemaining: microText(equity - size + allowance),
    availableMargin: microText(allowance + realized - collateral - reserved),
    openNotional: usdText(notional),
    targetProgressPct: target ? Math.max(0, round2((Number(realized + unrealized) / Number(target)) * 100)) : null,
    eligiblePayout: null,
    createdAt: a.createdAt.getTime(), activatedAt: a.activatedAt?.getTime() ?? null, resolvedAt: a.resolvedAt?.getTime() ?? null,
    evidence: a.stage === 'evaluation'
      ? { evaluation: a.id, ...(a.purchaseSignature ? { purchaseSignature: a.purchaseSignature } : {}), ...(a.resultSignature ? { resultSignature: a.resultSignature } : {}) }
      : {},
    freshness: !complete ? 'unavailable' : stale ? 'stale' : 'live',
  };
  return { summary, positions: marks.map((m) => toPosition(m, orders)), equity, realized, unrealized, complete };
}

/** Everything a reader or the stream needs about one account right now. */
export async function snapshot(q: Q, md: MarketDataService, a: AccountRow) {
  const book = await loadBook(q, a.id);
  return { book, valuation: value(a, await markPositions(md, book.positions), book.orders) };
}
