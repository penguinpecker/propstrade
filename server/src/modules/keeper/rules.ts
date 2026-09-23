// Keeper decisions (ARCHITECTURE.md §4.5), pure so they can be checked with fixtures: what the next transaction for a
// funded account must do, whether a payout request can be approved, and whether GMTrade was upgraded. The loop reads
// the chain, asks here, sends one transaction, reads again and asks again, so every decision is made on fresh state.
import { parseFixed, formatFixed } from '@props/gmtrade';
import { nextSessionClose, type Schedule } from './sessions.ts';

/** Tracked-order capacity of a funded account (programs/props_vault state.rs MAX_ORDERS). */
export const MAX_ORDERS = 8;
/** The session guard closes over-levered positions from this long before a session ends (at least 10 min early). */
export const GUARD_LEAD_MS = 15 * 60_000;
const BPS = 10_000n;
const MICRO_TO_GM = 10n ** 14n;

export type OrderType = 'market' | 'limit' | 'close' | 'takeProfit' | 'stopLoss';
export type OrderState = 'pending' | 'completed' | 'cancelled' | 'missing';
export type FundedStatus = 'active' | 'restricted' | 'payoutPending' | 'breached' | 'closed';

/** A used position slot as the program last synced it. Sizes GMTrade USD (1e20), collateral USDC base units. */
export interface SlotView { index: number; marketToken: string; isLong: boolean; gmPosition: string; sizeUsd: bigint; collateral: bigint; pendingUsd: bigint }
/** A tracked GMTrade order and what its account says now. `createdAt` (unix ms) once the indexer has seen it. */
export interface OrderView { order: string; slot: number; type: OrderType; sizeUsd: bigint; placedByRisk: boolean; state: OrderState; createdAt?: number }
/** A GMTrade Position account that exists now; netValue from the model at live prices (null when not valued). */
export interface PositionView { size: bigint; collateral: bigint; netValue: bigint | null }
export interface MarketView { symbol: string; open: boolean; schedule: Schedule | null; closedMaxLeverageBps: number }

export interface AccountView {
  funded: string;
  status: FundedStatus;
  slots: SlotView[];
  orders: OrderView[];
  /** By Position account address. */
  positions: Map<string, PositionView>;
  /**
   * V = owner USDC + collateral escrowed in pending increases + Σ position net value (GMTrade USD), so equity − floor
   * = V; null when a position could not be valued at fresh prices (no risk decision is made on stale data).
   */
  value: bigint | null;
  ownerLamports: bigint;
  /** By market token, for every used slot. */
  markets: Map<string, MarketView>;
}

export type Action =
  | { type: 'topUp' }
  | { type: 'sync' }
  | { type: 'restrict' }
  | { type: 'closeCompleted'; order: string }
  | { type: 'cancel'; order: string }
  | { type: 'close'; slot: number };
export type StepKind = 'topUp' | 'breach' | 'session' | 'upgrade' | 'cleanup' | 'sync';
/** One transaction's worth of work, in execution order (a prefix is sent when all of it does not fit). */
export interface Step { kind: StepKind; actions: Action[]; detail: string }

export interface PlanContext {
  now: number;
  /** Config.owner_sol_min, lamports. */
  ownerSolMin: bigint;
  /** GMTrade was upgraded and no operator has acknowledged the new release yet: every active account is restricted. */
  upgradePending: boolean;
  /** Step kinds that already failed this tick. */
  skip?: ReadonlySet<StepKind>;
}

const isIncrease = (o: OrderView) => o.type === 'market' || o.type === 'limit';
const sizeOf = (v: AccountView, s: SlotView) => v.positions.get(s.gmPosition)?.size ?? 0n;
const openSlots = (v: AccountView) => v.slots.filter((s) => sizeOf(v, s) > 0n);

/**
 * Which of the trader's pending orders a risk close cancels first when it needs a tracked-order slot: orders on the
 * slots being closed (their TP/SL are moot once the position is gone, then their increases), then increases elsewhere,
 * and the stop-loss or take-profit of another open position only last.
 */
function cancelRank(o: OrderView, closing: Set<number>): number {
  if (closing.has(o.slot)) return isIncrease(o) ? 1 : 0;
  return isIncrease(o) ? 2 : 3;
}

/** Closes for `targets`, freeing tracked-order capacity first when all 8 are in use. */
function riskCloses(v: AccountView, targets: SlotView[]): Action[] {
  const needed = targets.filter((s) => !v.orders.some((o) => o.slot === s.index && o.type === 'close' && o.placedByRisk && o.state === 'pending'));
  if (!needed.length) return [];
  const actions: Action[] = [];
  let free = MAX_ORDERS - v.orders.length;
  const missing = v.orders.filter((o) => o.state === 'missing').length;
  if (free < needed.length && missing) {
    actions.push({ type: 'sync' }); // drops orders whose accounts are gone
    free += missing;
  }
  for (const o of v.orders.filter((x) => x.state === 'completed' || x.state === 'cancelled')) {
    if (free >= needed.length) break;
    actions.push({ type: 'closeCompleted', order: o.order });
    free++;
  }
  const closing = new Set(needed.map((s) => s.index));
  const cancellable = v.orders.filter((o) => o.state === 'pending' && !o.placedByRisk).sort((a, b) => cancelRank(a, closing) - cancelRank(b, closing));
  for (const o of cancellable) {
    if (free >= needed.length) break;
    actions.push({ type: 'cancel', order: o.order });
    free++;
  }
  return [...actions, ...needed.slice(0, free).map((s): Action => ({ type: 'close', slot: s.index }))];
}

/** size / net value above `capBps`; a position the model could not value counts at its collateral. */
export function leverageAbove(p: PositionView, capBps: number): boolean {
  return p.size * BPS > (p.netValue ?? p.collateral * MICRO_TO_GM) * BigInt(capBps);
}

/** Would `sync` change anything: a slot's size, collateral or pending sum, an order gone, or an idle slot to free. */
export function syncDiffers(v: AccountView): boolean {
  if (v.orders.some((o) => o.state === 'missing')) return true;
  return v.slots.some((s) => {
    const p = v.positions.get(s.gmPosition);
    const pending = v.orders.filter((o) => o.slot === s.index && isIncrease(o) && o.state === 'pending').reduce((sum, o) => sum + o.sizeUsd, 0n);
    const idle = (p?.size ?? 0n) === 0n && pending === 0n && !v.orders.some((o) => o.slot === s.index);
    return (p?.size ?? 0n) !== s.sizeUsd || (p?.collateral ?? 0n) !== s.collateral || pending !== s.pendingUsd || idle;
  });
}

/**
 * TP/SL orders left behind by a position that is gone: GMTrade keeps them, and they would hit the next position in that
 * market and side. One placed for a position still being opened (a pending increase on the slot at least as old as
 * it) is kept; so is any whose age is not known yet.
 */
export function staleProtections(v: AccountView): OrderView[] {
  return v.orders.filter((o) => {
    if ((o.type !== 'takeProfit' && o.type !== 'stopLoss') || o.state !== 'pending' || o.createdAt === undefined) return false;
    const slot = v.slots.find((s) => s.index === o.slot);
    if (slot && sizeOf(v, slot) > 0n) return false;
    return !v.orders.some((i) => i.slot === o.slot && isIncrease(i) && i.state === 'pending' && (i.createdAt === undefined || i.createdAt <= o.createdAt!));
  });
}

const steps: Record<StepKind, (v: AccountView, c: PlanContext) => Step | null> = {
  topUp: (v, c) => (v.ownerLamports < c.ownerSolMin
    ? { kind: 'topUp', actions: [{ type: 'topUp' }], detail: `owner PDA holds ${formatFixed(v.ownerLamports, 9, 9)} SOL, below the ${formatFixed(c.ownerSolMin, 9, 9)} minimum` }
    : null),

  breach: (v) => {
    if (v.value === null || v.value > 0n) return null;
    const closable = openSlots(v).filter((s) => v.markets.get(s.marketToken)?.open);
    const actions = [...(v.status === 'active' ? [{ type: 'restrict' } as const] : []), ...riskCloses(v, closable)];
    return actions.length ? { kind: 'breach', actions, detail: 'equity is at or below the account floor' } : null;
  },

  session: (v, c) => {
    const targets = openSlots(v).filter((s) => {
      const m = v.markets.get(s.marketToken);
      if (!m?.open || !m.schedule) return false; // never try to close a closed market
      const close = nextSessionClose(m.schedule, c.now);
      return close !== null && c.now >= close - GUARD_LEAD_MS && leverageAbove(v.positions.get(s.gmPosition)!, m.closedMaxLeverageBps);
    });
    const actions = riskCloses(v, targets);
    const names = targets.map((s) => `${s.isLong ? 'Long' : 'Short'} ${v.markets.get(s.marketToken)!.symbol}`).join(', ');
    return actions.length ? { kind: 'session', actions, detail: `${names} above the closed-session leverage cap before the session ends` } : null;
  },

  upgrade: (v, c) => (c.upgradePending && v.status === 'active'
    ? { kind: 'upgrade', actions: [{ type: 'restrict' }], detail: 'GMTrade was upgraded' }
    : null),

  cleanup: (v) => {
    const finished = v.orders.filter((o) => o.state === 'completed' || o.state === 'cancelled');
    const stale = staleProtections(v);
    const actions: Action[] = [
      ...finished.map((o): Action => ({ type: 'closeCompleted', order: o.order })),
      ...stale.map((o): Action => ({ type: 'cancel', order: o.order })),
      ...(finished.length || stale.length ? [{ type: 'sync' } as const] : []),
    ];
    return actions.length ? { kind: 'cleanup', actions, detail: `${finished.length} finished order(s) still open, ${stale.length} TP/SL without a position` } : null;
  },

  sync: (v) => (syncDiffers(v) ? { kind: 'sync', actions: [{ type: 'sync' }], detail: 'GMTrade state differs from the last sync' } : null),
};

/** The next transaction for an account, most urgent first; null when there is nothing to do. */
export function planStep(v: AccountView, c: PlanContext): Step | null {
  if (v.status === 'closed') return null;
  for (const kind of Object.keys(steps) as StepKind[]) {
    if (c.skip?.has(kind)) continue;
    const step = steps[kind](v, c);
    if (step) return step;
  }
  return null;
}

// ---------- payout review ----------

/** The indexed fill-level P&L matched the owner's USDC to within $0.006 on a real round trip; allow a cent per fill. */
export const RECONCILE_TOLERANCE_PER_FILL = 10_000n; // micro USDC
/** GMTrade's indexer runs ~35 s behind: a request younger than this waits for its last fills instead of being held. */
export const REVIEW_GRACE_MS = 5 * 60_000;
/** Exposure added to the same market this close together in two funded accounts is linked. */
// ponytail: same-market timing heuristic; add cross-market correlation (e.g. BTC vs ETH) if hedging moves there.
export const LINK_WINDOW_MS = 5 * 60_000;

export interface FillRow {
  account: string; position: string | null; symbol: string; side: 'Long' | 'Short'; isIncrease: boolean;
  sizeUsd: string; sizeAfterUsd: string; feeUsd: string; fundingUsd: string; borrowUsd: string; realizedPnl: string | null;
  venueId: string; ts: Date;
}
/** Exposure one increase fill added to a position (from flat or not), and when that position was next flat (null: open). */
export interface Exposure { account: string; symbol: string; side: 'Long' | 'Short'; at: number; closedAt: number | null }
export interface Link { ours: Exposure; theirs: Exposure }

const d6 = (v: string) => parseFixed(v, 6);

/** Realized P&L of fills after all costs, micro USD: decreases' realized P&L less every increase's costs. */
export function realizedOf(fills: FillRow[]): bigint {
  return fills.reduce((sum, f) => sum + (f.isIncrease ? -(d6(f.feeUsd) + d6(f.fundingUsd) + d6(f.borrowUsd)) : d6(f.realizedPnl ?? '0')), 0n);
}

/**
 * Every increase of every position, from its fills: an open from flat, a top-up of a small stub or of a position opened
 * long before (any of them adds the exposure a hedge needs), each with the time its position was flat again.
 */
export function exposuresOf(fills: FillRow[]): Exposure[] {
  const open = new Map<string, Exposure[]>();
  const all: Exposure[] = [];
  for (const f of [...fills].sort((a, b) => (a.venueId < b.venueId ? -1 : 1))) {
    const key = `${f.account}:${f.position}`;
    if (f.isIncrease) {
      const e: Exposure = { account: f.account, symbol: f.symbol, side: f.side, at: f.ts.getTime(), closedAt: null };
      all.push(e);
      open.set(key, [...(open.get(key) ?? []), e]);
    } else if (d6(f.sizeAfterUsd) === 0n) {
      for (const e of open.get(key) ?? []) e.closedAt = f.ts.getTime();
      open.delete(key);
    }
  }
  return all;
}

/** Other accounts' exposure in the same market added within LINK_WINDOW_MS of ours, both positions open after both. */
export function linkedPositions(ours: Exposure[], others: Exposure[], now: number): Link[] {
  return ours.flatMap((a) => others.filter((b) => b.account !== a.account && b.symbol === a.symbol
    && Math.abs(a.at - b.at) <= LINK_WINDOW_MS
    && Math.max(a.at, b.at) < Math.min(a.closedAt ?? now, b.closedAt ?? now)).map((theirs) => ({ ours: a, theirs })));
}

export interface PayoutFacts {
  /** Requested profit (owner USDC − principal at request), micro USDC. */
  profit: bigint;
  requestedAt: number;
  /** No slot or tracked order, and every GMTrade position of the owner PDA exists at size 0. */
  flat: boolean;
  verified: boolean;
  /** Fills since the last paid payout. */
  fills: FillRow[];
  links: Link[];
  now: number;
}
export type Review = { decision: 'approve' } | { decision: 'hold'; reasons: string[] } | { decision: 'wait'; reason: string };

const usdc = (micro: bigint) => formatFixed(micro, 6, 6);
const at = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

export function reviewPayout(f: PayoutFacts): Review {
  const reasons: string[] = [];
  if (!f.flat) reasons.push('The account still had GMTrade positions or orders at review');
  if (!f.verified) reasons.push('The trader\'s identity is not verified onchain');
  for (const { ours, theirs } of f.links) {
    const kind = ours.side === theirs.side ? 'Matching' : 'Opposite';
    const reason = `${kind} ${theirs.side} ${theirs.symbol} exposure added in funded account ${theirs.account} within ${LINK_WINDOW_MS / 60_000} minutes of this account's ${ours.side} ${ours.symbol} (${at(ours.at)} UTC)`;
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  const realized = realizedOf(f.fills);
  const tolerance = BigInt(Math.max(1, f.fills.length)) * RECONCILE_TOLERANCE_PER_FILL;
  if (f.profit > realized + tolerance) {
    if (!reasons.length && f.now - f.requestedAt < REVIEW_GRACE_MS) return { decision: 'wait', reason: 'waiting for GMTrade\'s indexer to report the last fills' };
    reasons.push(`Requested profit ${usdc(f.profit)} USDC is more than the ${usdc(realized)} USDC realized in GMTrade fills since the last payout; USDC sent to the account is not profit`);
  }
  return reasons.length ? { decision: 'hold', reasons } : { decision: 'approve' };
}

// ---------- GMTrade upgrade watch ----------

/** Last-deploy slot of an upgradeable program's ProgramData account (bincode: u32 variant 3, then the u64 slot). */
export function programDeploySlot(data: Uint8Array): number {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < 12 || b.readUInt32LE(0) !== 3) throw new Error('not an upgradeable program data account');
  return Number(b.readBigUInt64LE(4));
}

/**
 * What the deploy slot read now means, given the newest deploy recorded: first = nothing recorded yet; upgraded = a
 * newer deploy; unreviewed = the newest deploy, not acknowledged yet; current = acknowledged. A lower slot (a lagging
 * RPC node) is read as the newest recorded one.
 */
export function upgradeState(latest: { slot: number; acknowledgedAt: Date | null } | undefined, slot: number): 'first' | 'upgraded' | 'unreviewed' | 'current' {
  if (!latest) return 'first';
  if (slot > latest.slot) return 'upgraded';
  return latest.acknowledgedAt ? 'current' : 'unreviewed';
}
