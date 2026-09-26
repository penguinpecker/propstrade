// Props.trade's fee on funded orders (docs/design/order-fee.md §9). The program assesses each order's fee when it is
// placed or updated and makes it due once the order leaves the book; the keeper settles what is due with
// settle_order_fees(charge, waive, expected_due, expected_settlements). This module holds the per-order ledger the
// indexer keeps from the events (order_fees), what an executed order owes (the fee its fills carry: at most the
// assessment, the rate of its latest assessment on the size executed), the settlement plan, and the settlement records
// (order_fee_settlements): written with the signature before the transaction is sent, applied to the ledger once the
// indexed OrderFeesSettled confirms it, so a settlement is counted once whatever is retried or replayed.
import { and, asc, eq, gt, ne, sql } from 'drizzle-orm';
import { fromMicro, orderFee, type OrderFeeRate } from '@props/sdk';
import type { OrderStatus } from '@props/shared';
import type { Db } from '../../db/client.ts';
import { gmOrders, orderFees, orderFeeSettlements, venueFills } from '../../db/schema.ts';
import { toMicro6 } from './reader.ts';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Q = Db | Tx;

/** An order's outcome is unknown this long after its fee became due: raise an alert. */
export const UNKNOWN_ALERT_MS = 10 * 60_000;
/** ... and this long after: waive its fee (a trader is never blocked from payouts for good by an order no one can see). */
export const UNKNOWN_WAIVE_MS = 24 * 3_600_000;

export interface FeeRow {
  order: string;
  isIncrease: boolean;
  state: 'assessed' | 'released' | 'due';
  /** USDC base units. */
  assessed: bigint;
  rate: OrderFeeRate;
  charged: bigint;
  waived: bigint;
  dueAt: Date | null;
  /** gm_orders.status: the order's outcome on the exchange as far as it is known. */
  status: OrderStatus;
  /** Σ of the size its indexed fills executed (venue_fills.size_usd), GMTrade USD; null before any fill is indexed. */
  executed: bigint | null;
}

export interface Allocation { order: string; charge: bigint; waive: bigint }
export interface SettlementPlan { charge: bigint; waive: bigint; allocations: Allocation[] }

const remainingOf = (r: FeeRow) => r.assessed - r.charged - r.waived;

/**
 * What an executed order owes in all, or null while that is not known: an increase executes once and in full, so it
 * owes its assessment; a decrease owes min(assessed, the rate of its latest assessment on the size its fills executed),
 * worked out from the ledger as it is now (a fill indexed before its order's re-assessment carries the old rate's fee).
 * Orders that did not execute owe nothing.
 */
export function owedOf(r: FeeRow): bigint | null {
  if (r.status !== 'executed') return null;
  if (r.isIncrease) return r.assessed;
  if (r.executed === null) return null;
  const owed = orderFee(r.rate, r.executed);
  return owed < r.assessed ? owed : r.assessed;
}

/**
 * The fees executed orders owe and nothing has charged or waived yet: what the funded valuation subtracts from equity,
 * whether or not a sync has made them due (never a cancelled order's, never one whose outcome is unknown).
 */
export function feesOwed(rows: FeeRow[]): bigint {
  return rows.reduce((sum, r) => {
    const owed = owedOf(r);
    if (owed === null || r.state === 'released') return sum;
    const left = owed - r.charged;
    const open = remainingOf(r);
    const liability = left < open ? left : open;
    return liability > 0n ? sum + liability : sum;
  }, 0n);
}

/**
 * Whether an account's Props fees need its ledger read: some are due, or a tracked order is no longer pending (it may have
 * executed, and owe its fee before a sync makes it due). An account with only resting orders, or none, owes nothing new.
 */
export const feesInMotion = (due: bigint, orders: { state: string }[]) => due > 0n || orders.some((o) => o.state !== 'pending');

/** Σ of what the due rows still hold: equals the account's order_fees_due while the ledger is in step with the chain. */
export const dueInLedger = (rows: FeeRow[]) => rows.filter((r) => r.state === 'due').reduce((s, r) => s + remainingOf(r), 0n);

/**
 * The next settlement of an account's due fees, oldest first. An executed order is charged what it owes and the rest of
 * its assessment is waived; an order the exchange cancelled is waived at once; an order whose outcome is still unknown
 * waits, and is waived after UNKNOWN_WAIVE_MS. Charges stop at the account's USDC `balance` (the rest stays due for a
 * later tick). `closing`: the account is being closed, so everything left after the charges is waived.
 */
export function planSettlement(rows: FeeRow[], o: { balance: bigint; now: number; closing?: boolean }): SettlementPlan {
  let budget = o.balance;
  const allocations: Allocation[] = [];
  const due = rows.filter((r) => r.state === 'due' && remainingOf(r) > 0n)
    .sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0) || (a.order < b.order ? -1 : 1));
  for (const r of due) {
    const remaining = remainingOf(r);
    const owed = owedOf(r);
    const known = owed !== null || r.status === 'canceled';
    const stale = r.dueAt !== null && o.now - r.dueAt.getTime() >= UNKNOWN_WAIVE_MS;
    if (!known && !stale && !o.closing) continue;
    const left = owed === null ? 0n : owed - r.charged;
    const chargeable = left <= 0n ? 0n : left < remaining ? left : remaining;
    const charge = chargeable < budget ? chargeable : budget;
    budget -= charge;
    // What it does not owe is waived; what it owes and the balance does not cover stays due (unless the account closes).
    const waive = remaining - chargeable + (o.closing ? chargeable - charge : 0n);
    if (charge || waive) allocations.push({ order: r.order, charge, waive });
  }
  return {
    charge: allocations.reduce((s, a) => s + a.charge, 0n),
    waive: allocations.reduce((s, a) => s + a.waive, 0n),
    allocations,
  };
}

/** The oldest due fee whose order's outcome is still unknown (for the keeper's alert), or null. */
export function unknownSince(rows: FeeRow[]): Date | null {
  const unknown = rows.filter((r) => r.state === 'due' && remainingOf(r) > 0n && owedOf(r) === null && r.status !== 'canceled' && r.dueAt);
  return unknown.reduce<Date | null>((min, r) => (!min || r.dueAt! < min ? r.dueAt! : min), null);
}

export type SettlementRow = typeof orderFeeSettlements.$inferSelect;

/**
 * An account's fee rows still open (assessed or due), with their outcomes; its settlement awaiting the chain; and the
 * settlements the indexer has confirmed (how many, and their charges in all).
 */
export async function feeLedger(q: Q, funded: string): Promise<{ rows: FeeRow[]; pending: SettlementRow | undefined; settled: { count: bigint; charged: bigint } }> {
  const [rows, [pending], [settled]] = await Promise.all([
    q.select({
      order: orderFees.order, isIncrease: orderFees.isIncrease, state: orderFees.state, assessed: orderFees.assessedUsd,
      rateUsd: orderFees.rateUsd, rateBps: orderFees.rateBps, charged: orderFees.chargedUsd, waived: orderFees.waivedUsd,
      dueAt: orderFees.dueAt, status: gmOrders.status,
      executed: sql<string | null>`(select sum(${venueFills.sizeUsd}) from ${venueFills} where ${venueFills.order} = ${orderFees.order})`,
    }).from(orderFees).innerJoin(gmOrders, eq(gmOrders.address, orderFees.order))
      .where(and(eq(orderFees.fundedAccount, funded), ne(orderFees.state, 'released'))),
    q.select().from(orderFeeSettlements).where(and(eq(orderFeeSettlements.fundedAccount, funded), eq(orderFeeSettlements.status, 'sent')))
      .orderBy(asc(orderFeeSettlements.createdAt)).limit(1),
    q.select({ count: sql<string>`count(*)`, charged: sql<string | null>`sum(${orderFeeSettlements.chargeUsd})` }).from(orderFeeSettlements)
      .where(and(eq(orderFeeSettlements.fundedAccount, funded), eq(orderFeeSettlements.status, 'confirmed'))),
  ]);
  return {
    rows: rows.map((r) => ({
      order: r.order, isIncrease: r.isIncrease, state: r.state, assessed: toMicro6(r.assessed), rate: { feeUsdc: toMicro6(r.rateUsd), feeBps: r.rateBps },
      charged: toMicro6(r.charged), waived: toMicro6(r.waived), dueAt: r.dueAt, status: r.status, executed: r.executed === null ? null : toMicro6(r.executed) * 10n ** 14n,
    })),
    pending,
    settled: { count: BigInt(settled?.count ?? 0), charged: toMicro6(settled?.charged ?? '0') },
  };
}

type Ledger = Awaited<ReturnType<typeof feeLedger>>;

/**
 * Whether the ledger accounts for everything the chain shows: the fees due, every settlement (their number) and every
 * charge (order_fees_paid). A settlement that landed without reaching the ledger yet (the risk-key fallback script, or
 * one the indexer has not applied) leaves its orders looking due: a plan from that ledger would charge them again once
 * a new fee of the same amount came due. Plan only when this holds.
 */
export const inStep = (l: Ledger, chain: { due: bigint; paid: bigint; settlements: bigint }) =>
  dueInLedger(l.rows) === chain.due && l.settled.count === chain.settlements && l.settled.charged === chain.paid;
type Share = { order: string; chargeUsd: string; waiveUsd: string };

/**
 * The ledger's rows as the chain has them: a settlement sent and not confirmed yet counts once the account's settlement
 * count shows it landed (its USDC already moved; the indexed event applies it moments later), so a valuation never
 * subtracts a fee the account has just paid.
 */
export function asOnchain({ rows, pending }: Ledger, settlementsOnchain: bigint): FeeRow[] {
  if (!pending || settlementsOnchain <= BigInt(pending.expectedSettlements)) return rows;
  const shares = new Map((pending.allocations as Share[]).map((a) => [a.order, a]));
  return rows.map((r) => {
    const s = shares.get(r.order);
    return s ? { ...r, charged: r.charged + toMicro6(s.chargeUsd), waived: r.waived + toMicro6(s.waiveUsd) } : r;
  });
}

/** Props fees charged on an account's settlements that landed after `since` (chain time), USDC base units. */
export async function chargedSince(q: Q, funded: string, since: Date | null): Promise<bigint> {
  const [row] = await q.select({ sum: sql<string | null>`sum(${orderFeeSettlements.chargeUsd})` }).from(orderFeeSettlements)
    .where(and(eq(orderFeeSettlements.fundedAccount, funded), eq(orderFeeSettlements.status, 'confirmed'),
      since ? gt(orderFeeSettlements.settledAt, since) : undefined));
  return toMicro6(row?.sum ?? '0');
}

/**
 * The Props fee a fill carries (USDC base units): its order's fee (min(assessed, the rate of its latest assessment on the
 * size its fills executed), @props/sdk orderFee) less what the order's earlier fills carried; 0 for an order indexed
 * without one (placed before the fee existed). Null when the indexer has not seen the order: not yet, or never (an
 * order the account did not place, such as deleveraging).
 */
export async function fillFee(q: Q, order: string, sizeUsd: bigint): Promise<bigint | null> {
  const [known] = await q.select({ row: orderFees }).from(gmOrders).leftJoin(orderFees, eq(orderFees.order, gmOrders.address)).where(eq(gmOrders.address, order));
  if (!known) return null;
  const row = known.row;
  if (!row) return 0n;
  const [earlier] = await q.select({ size: sql<string | null>`sum(${venueFills.sizeUsd})`, fee: sql<string | null>`sum(${venueFills.platformFeeUsd})` })
    .from(venueFills).where(eq(venueFills.order, order));
  const executed = sizeUsd + toMicro6(earlier?.size ?? '0') * 10n ** 14n;
  const owed = orderFee({ feeUsdc: toMicro6(row.rateUsd), feeBps: row.rateBps }, executed);
  const total = owed < toMicro6(row.assessedUsd) ? owed : toMicro6(row.assessedUsd);
  const fee = total - toMicro6(earlier?.fee ?? '0');
  return fee > 0n ? fee : 0n;
}

const allocationsJson = (plan: SettlementPlan) => plan.allocations.map((a) => ({ order: a.order, chargeUsd: fromMicro(a.charge), waiveUsd: fromMicro(a.waive) }));

/** Records a settlement about to be sent (in the transaction that stores its signature). */
export async function recordSettlement(q: Q, s: {
  signature: string; funded: string; plan: SettlementPlan; expectedDue: bigint; expectedSettlements: bigint; sentBy: string;
  /** Its blockhash's: it can land until the confirmed block height passes this. */
  lastValidBlockHeight: number;
}) {
  await q.insert(orderFeeSettlements).values({
    signature: s.signature, fundedAccount: s.funded, chargeUsd: fromMicro(s.plan.charge), waiveUsd: fromMicro(s.plan.waive),
    expectedDueUsd: fromMicro(s.expectedDue), expectedSettlements: Number(s.expectedSettlements), allocations: allocationsJson(s.plan),
    status: 'sent', sentBy: s.sentBy, lastValidBlockHeight: s.lastValidBlockHeight,
  });
}

/** A sent settlement the chain refused, or that can no longer land: it changed nothing. */
export async function failSettlement(q: Q, signature: string) {
  await q.update(orderFeeSettlements).set({ status: 'failed', resolvedAt: sql`now()` })
    .where(and(eq(orderFeeSettlements.signature, signature), eq(orderFeeSettlements.status, 'sent')));
}

/**
 * Applies an indexed OrderFeesSettled to the ledger, once: the shares its sender recorded, or, for a settlement this
 * server did not send (e.g. the risk-key fallback script), its amounts over the account's due rows oldest first (charges
 * to what executed orders owe first). Other settlements sent against the same count can no longer land: failed.
 */
export async function confirmSettlement(tx: Tx, e: { signature: string; funded: string; charged: bigint; waived: bigint; by: string; at: Date }) {
  // One row per (transaction, account): an operators' transaction can settle several accounts.
  // ponytail: two settlements of the same account in one transaction (only a hand-built one) count as one here.
  const mine = and(eq(orderFeeSettlements.signature, e.signature), eq(orderFeeSettlements.fundedAccount, e.funded));
  const [sent] = await tx.select().from(orderFeeSettlements).where(mine).for('update');
  if (sent?.status === 'confirmed') return;
  let allocations: Allocation[];
  if (sent) {
    allocations = (sent.allocations as Share[])
      .map((a) => ({ order: a.order, charge: toMicro6(a.chargeUsd), waive: toMicro6(a.waiveUsd) }));
    await tx.update(orderFeeSettlements).set({ status: 'confirmed', resolvedAt: sql`now()`, settledAt: e.at }).where(mine);
    await tx.update(orderFeeSettlements).set({ status: 'failed', resolvedAt: sql`now()` }).where(and(
      eq(orderFeeSettlements.fundedAccount, e.funded), eq(orderFeeSettlements.status, 'sent'),
      eq(orderFeeSettlements.expectedSettlements, sent.expectedSettlements),
    ));
  } else {
    const { rows } = await feeLedger(tx, e.funded);
    allocations = spread(rows, e.charged, e.waived);
    const expectedDue = dueInLedger(rows);
    await tx.insert(orderFeeSettlements).values({
      signature: e.signature, fundedAccount: e.funded, chargeUsd: fromMicro(e.charged), waiveUsd: fromMicro(e.waived), expectedDueUsd: fromMicro(expectedDue),
      expectedSettlements: -1, allocations: allocationsJson({ charge: e.charged, waive: e.waived, allocations }), status: 'confirmed', sentBy: e.by,
      resolvedAt: sql`now()`, settledAt: e.at,
    });
  }
  for (const a of allocations) {
    await tx.update(orderFees).set({
      chargedUsd: sql`${orderFees.chargedUsd} + ${fromMicro(a.charge)}`, waivedUsd: sql`${orderFees.waivedUsd} + ${fromMicro(a.waive)}`,
    }).where(eq(orderFees.order, a.order));
  }
}

/** A settlement's amounts over due rows, oldest first: each charge to what an executed order owes first, then the rest. */
function spread(rows: FeeRow[], charged: bigint, waived: bigint): Allocation[] {
  const due = rows.filter((r) => r.state === 'due' && remainingOf(r) > 0n).sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0));
  const out = new Map(due.map((r) => [r.order, { order: r.order, charge: 0n, waive: 0n }]));
  const room = new Map(due.map((r) => [r.order, remainingOf(r)]));
  const take = (r: FeeRow, want: bigint, kind: 'charge' | 'waive') => {
    const free = room.get(r.order)!;
    const n = want < free ? want : free;
    room.set(r.order, free - n);
    out.get(r.order)![kind] += n;
    return n;
  };
  for (const r of due) {
    const owed = owedOf(r);
    if (owed !== null && owed > r.charged) charged -= take(r, owed - r.charged < charged ? owed - r.charged : charged, 'charge');
  }
  for (const r of due) if (charged > 0n) charged -= take(r, charged, 'charge');
  for (const r of due) if (waived > 0n) waived -= take(r, waived, 'waive');
  return [...out.values()].filter((a) => a.charge || a.waive);
}
