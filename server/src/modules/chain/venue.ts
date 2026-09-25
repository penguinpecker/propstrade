// Funded accounts on GMTrade. Each tick reads an account's onchain state (FundedAccount, owner USDC, the GMTrade
// Position and Order accounts it tracks), keeps gm_orders statuses, position snapshots, venue fills and closed trades
// current, and values open positions with the GMTrade model at live prices. The accounts API and the stream serve
// the cached valuation.
import { createHash } from 'node:crypto';
import { PublicKey, type Connection } from '@solana/web3.js';
import { and, desc, eq, gt, inArray, isNull, lt, max, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { DataFreshness } from '@props/shared';
import {
  GMTRADE_PROGRAM_ID, ORDER_LAYOUT, decodeGmPosition, enumName, ownerPda, ownerUsdcAddress, type FundedAccount, type GmPosition, type PropsVaultClient,
} from '@props/sdk';
import {
  fetchOrderRemovals, fetchTradeEvents, fetchTxSignatures, parseFixed, formatFixed, type OrderRemoval, type TradeEvent,
} from '@props/gmtrade';
import { model, type PositionStatus } from '@props/gmsol-wasm';
import type { Db } from '../../db/client.ts';
import { accountEvents, closedTrades, fundedAccounts, gmOrders, gmPositionSnapshots, venueFills } from '../../db/schema.ts';
import { tokenAccountAmount } from '../../lib/solana.ts';
import { why } from '../marketdata/upstreams.ts';
import type { MarketDataService } from '../types.ts';
import { fundedHref, type Notice } from './projector.ts';
import { gmUsd, micro, tokenAmount, unitPrice, type ChainReader, type MarketInfo } from './reader.ts';

/** GMTrade's indexer (subsquid): fills and order removals of an owner. Injectable for tests. */
export interface GmIndexer {
  /** Fills of `owner` after `afterId`, oldest first. */
  trades(owner: string, afterId: string | undefined): Promise<TradeEvent[]>;
  signatures(eventIds: string[]): Promise<Map<string, string>>;
  removals(orders: string[]): Promise<OrderRemoval[]>;
}

const TRADES_PAGE = 100;
export const subsquid: GmIndexer = {
  async trades(owner, afterId) {
    const newestFirst: TradeEvent[] = [];
    let beforeId: string | undefined;
    for (;;) {
      const page = await fetchTradeEvents({ user: owner, afterId, beforeId }, TRADES_PAGE);
      newestFirst.push(...page);
      if (page.length < TRADES_PAGE) return newestFirst.reverse();
      beforeId = page.at(-1)!.id;
    }
  },
  signatures: (ids) => fetchTxSignatures(ids),
  removals: (orders) => fetchOrderRemovals(orders),
};

type OrderState = 'pending' | 'completed' | 'cancelled' | 'missing';
const ORDER_STATES: Record<number, OrderState> = { 0: 'pending', 1: 'completed', 2: 'cancelled' };
/** gm_orders statuses of an order GMTrade has not finished, as far as the row knows. */
const PRE_EXECUTION = ['awaiting_execution', 'awaiting_price'] as const;
/** Statuses an order that has a closedAt can still leave: finished, but how is not known yet. */
const UNSETTLED = [...PRE_EXECUTION, 'unknown'] as const;
const FREE = PublicKey.default;

export interface ValuedPosition {
  address: string;
  market: MarketInfo;
  isLong: boolean;
  position: GmPosition;
  /** Model status at live prices; null when the market state or prices were unavailable. */
  status: PositionStatus | null;
  /** Mid oracle unit price; null when unavailable. */
  mark: bigint | null;
}

export interface Valuation {
  funded: string;
  at: number;
  /** props_vault FundedStatus variant, camelCase ("active", "payoutPending", …). */
  status: string;
  /** Owner PDA USDC, base units. */
  ownerUsdc: bigint;
  /** Collateral escrowed in increase orders GMTrade still holds, USDC base units. */
  pendingCollateral: bigint;
  positions: ValuedPosition[];
  /** Tracked orders GMTrade still holds as pending. */
  pendingOrders: number;
  /** The program's own flat test: no used slot and no tracked order (what request_payout checks). */
  flat: boolean;
  freshness: DataFreshness;
}

export interface VenueDeps {
  db: Db;
  rpc: Pick<Connection, 'getMultipleAccountsInfoAndContext'>;
  client: PropsVaultClient;
  reader: ChainReader;
  marketdata?: Pick<MarketDataService, 'marketState' | 'market'>;
  gm: GmIndexer;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  notify(n: Notice): Promise<void>;
}

const FRESHNESS_ORDER: DataFreshness[] = ['live', 'delayed', 'stale', 'unavailable'];
const worst = (a: DataFreshness, b: DataFreshness) => (FRESHNESS_ORDER.indexOf(a) >= FRESHNESS_ORDER.indexOf(b) ? a : b);
const MARKET_STATE_TIMEOUT_MS = 3_000;
const NOTIFY_WITHIN_MS = 3_600_000;
/** Accounts closed within this window still get their last fills indexed. */
const CLOSED_GRACE_MS = 3_600_000;
/** GMTrade's indexer runs ~35 s behind the chain: fills are read this long after an account was last seen trading. */
const FILLS_AFTER_FLAT_MS = 180_000;
/** Equity snapshots for the performance chart: at most one per account per interval. */
const SNAPSHOT_EVERY_MS = 60_000;

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms).unref())]);

/** Deterministic uuid for a row derived from chain data (idempotent inserts). */
export const uuidOf = (key: string) => {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** Subsquid ids are "slot-blockhash-tx-instruction-inner"; instruction and inner index identify the event in its tx. */
export function eventIndexOf(venueId: string): number {
  const [, , , ix, inner] = venueId.split('-');
  const i = Number(ix);
  const j = Number(inner);
  if (!Number.isInteger(i) || !Number.isInteger(j) || j >= 10_000 || i >= 200_000) throw new Error(`unexpected GMTrade event id ${venueId}`);
  return i * 10_000 + j;
}

const abs = (v: bigint) => (v < 0n ? -v : v);
const d6 = (v: string) => parseFixed(v, 6);
const d18 = (v: string) => parseFixed(v, 18);
const fmt6 = (v: bigint) => formatFixed(v, 6, 6);

/** A venue_fills row for a GMTrade fill. Costs are valued at the collateral token's min price, as GMTrade charges them. */
export function fillRow(e: TradeEvent, funded: string, market: MarketInfo, signature: string) {
  const collateralPrice = e.isCollateralLong ? e.prices.long.min : e.prices.short.min;
  const orderFee = (e.fees.order + e.fees.liquidation) * collateralPrice;
  const borrow = e.fees.borrowing * collateralPrice;
  const funding = e.fees.funding * collateralPrice;
  return {
    signature, eventIndex: eventIndexOf(e.id), venueId: e.id, slot: e.slot, fundedAccount: funded, position: e.position, order: e.order,
    symbol: market.symbol, side: (e.isLong ? 'Long' : 'Short') as 'Long' | 'Short', isIncrease: e.isIncrease,
    sizeUsd: gmUsd(abs(e.after.sizeInUsd - e.before.sizeInUsd)), sizeAfterUsd: gmUsd(e.after.sizeInUsd),
    price: unitPrice(e.executionPrice, market.decimals), feeUsd: gmUsd(orderFee), priceImpactUsd: gmUsd(e.priceImpactValue),
    fundingUsd: gmUsd(funding), borrowUsd: gmUsd(borrow),
    // Realized on decreases: GMTrade's position PnL plus the decrease's price impact (charged to collateral separately),
    // net of this fill's costs. An increase's impact is already in its size in tokens, so it shows in the later PnL.
    realizedPnl: e.isIncrease ? null : gmUsd(e.pnl + e.priceImpactValue - orderFee - borrow - funding),
    ts: new Date(e.ts),
  };
}

type Fill = typeof venueFills.$inferSelect;

/** One round trip (first increase from flat → the fill that made the position flat) as a closed_trades row. */
export function roundTrip(accountId: string, fills: Fill[]) {
  const last = fills.at(-1)!;
  const weighted = (list: Fill[]) => {
    const size = list.reduce((s, f) => s + d6(f.sizeUsd), 0n);
    return size === 0n ? last.price : formatFixed(list.reduce((s, f) => s + d6(f.sizeUsd) * d18(f.price), 0n) / size, 18, 18);
  };
  const sum = (of: (f: Fill) => bigint, list = fills) => list.reduce((s, f) => s + of(f), 0n);
  const costs = (f: Fill) => d6(f.feeUsd) + d6(f.fundingUsd) + d6(f.borrowUsd);
  const increases = fills.filter((f) => f.isIncrease);
  const decreases = fills.filter((f) => !f.isIncrease);
  const net = sum((f) => d6(f.realizedPnl ?? '0'), decreases) - sum(costs, increases);
  const peak = fills.reduce((m, f) => (d6(f.sizeAfterUsd) > m ? d6(f.sizeAfterUsd) : m), 0n);
  return {
    id: uuidOf(`closed:${last.venueId}`), accountId, symbol: last.symbol, side: last.side, venue: 'gmtrade' as const,
    openedAt: fills[0]!.ts, closedAt: last.ts,
    sizeUsd: fmt6(peak > 0n ? peak : d6(last.sizeUsd)), // peak size; a trip indexed from its closing fill only has the fill
    entryPrice: weighted(increases), exitPrice: weighted(decreases),
    feesUsd: fmt6(sum(costs)), orderFeesUsd: fmt6(sum((f) => d6(f.feeUsd))), fundingUsd: fmt6(sum((f) => d6(f.fundingUsd))),
    borrowUsd: fmt6(sum((f) => d6(f.borrowUsd))), priceImpactUsd: fmt6(sum((f) => d6(f.priceImpactUsd))), netPnl: fmt6(net),
    signatures: [...new Set(fills.map((f) => f.signature))],
  };
}

function fillActivity(f: ReturnType<typeof fillRow>, e: TradeEvent) {
  const opened = e.isIncrease && e.before.sizeInUsd === 0n;
  const closed = !e.isIncrease && e.after.sizeInUsd === 0n;
  const verb = e.isLiquidation ? 'liquidated' : opened ? 'opened' : closed ? 'closed' : e.isIncrease ? 'increased' : 'reduced';
  return {
    type: (e.isLiquidation ? 'liquidation' : 'fill') as 'liquidation' | 'fill',
    title: `${f.side} ${f.symbol} ${verb}`,
    detail: `${f.sizeUsd} USD filled on the exchange at ${f.price}${f.realizedPnl === null ? '' : `; realized ${f.realizedPnl} USD after costs`}.`,
    amountUsd: f.realizedPnl, symbol: f.symbol, signature: f.signature, ts: f.ts,
  };
}

/** What reading and valuing a funded account needs. */
export type FundedReadDeps = Pick<VenueDeps, 'rpc' | 'client' | 'reader' | 'marketdata' | 'log'>;

/** A GMTrade account at an address GMTrade derives; anything else there (e.g. lamports sent to a closed one) is absent. */
const gmOwned = <T extends { owner: PublicKey }>(info: T | null | undefined) => (info?.owner.equals(GMTRADE_PROGRAM_ID) ? info : null);

/** Times the funded account may change between the read that lists its accounts and the read of all of them. */
const READ_RETRIES = 3;

/**
 * Onchain state of a funded account as of one slot; null when the account does not exist. The first read finds which
 * Position and Order accounts it tracks; the second reads those together with the account, its USDC and its SOL in one
 * call, at a slot no older than the first. That call is what counts: USDC GMTrade pays out as it closes an order lands
 * in the same slot the order disappears, so the two are always seen together (read apart, the refund of an order
 * holding the whole allowance reads as zero equity). When the account itself changed in between, it reads again.
 */
export async function readFundedState(d: FundedReadDeps, funded: string, extraPositions: string[] = []) {
  const address = new PublicKey(funded);
  const own = [address, ownerUsdcAddress(address), ownerPda(address)];
  let listed = await d.rpc.getMultipleAccountsInfoAndContext(own);
  for (let attempt = 1; ; attempt++) {
    const [info] = listed.value;
    if (!info) return null;
    const account: FundedAccount = d.client.decode('fundedAccount', info.data);
    const slots = account.slots.filter((s) => !s.marketToken.equals(FREE));
    const orders = account.orders.filter((o) => !o.order.equals(FREE));
    const positionKeys = [...new Set([...slots.map((s) => s.gmPosition.toBase58()), ...extraPositions])];
    const read = await d.rpc.getMultipleAccountsInfoAndContext(
      [...own, ...[...positionKeys, ...orders.map((o) => o.order.toBase58())].map((k) => new PublicKey(k))],
      { minContextSlot: listed.context.slot },
    );
    const [again, ata, owner] = read.value;
    if (!again?.data.equals(info.data)) {
      if (attempt >= READ_RETRIES) throw new Error(`funded account ${funded} kept changing while it was read`);
      listed = { context: read.context, value: read.value.slice(0, own.length) };
      continue;
    }
    const rest = read.value.slice(own.length);
    const positions = positionKeys.flatMap((k, i) => {
      const p = gmOwned(rest[i]);
      return p ? [{ address: k, data: p.data, position: decodeGmPosition(p.data) }] : [];
    });
    const orderStates = orders.map((o, i) => {
      const data = gmOwned(rest[positionKeys.length + i])?.data;
      return { tracked: o, state: data ? (ORDER_STATES[data[ORDER_LAYOUT.actionState]!] ?? 'pending') : ('missing' as OrderState) };
    });
    return {
      account, slot: read.context.slot, ownerUsdc: ata ? tokenAccountAmount(ata.data) : 0n, ownerLamports: BigInt(owner?.lamports ?? 0),
      positions, orders: orderStates, flat: !slots.length && !orders.length,
    };
  }
}

export type FundedState = NonNullable<Awaited<ReturnType<typeof readFundedState>>>;

/** Values the open positions with the GMTrade model at live prices. */
export async function valueFunded(d: FundedReadDeps, funded: string, state: FundedState): Promise<Valuation> {
  let freshness: DataFreshness = 'live';
  const positions: ValuedPosition[] = [];
  for (const p of state.positions) {
    if (p.position.sizeInUsd === 0n) continue;
    const market = await d.reader.market(p.position.marketToken.toBase58());
    let status: PositionStatus | null = null;
    let mark: bigint | null = null;
    try {
      if (!d.marketdata) throw new Error('market data module absent');
      const ms = await withTimeout(d.marketdata.marketState(market.marketToken), MARKET_STATE_TIMEOUT_MS);
      const raw = ms.raw as { market: string; virtualInventories: Record<string, string> };
      status = model.positionStatus({ market: raw.market, virtualInventories: raw.virtualInventories, prices: ms.prices }, p.data.toString('base64'));
      mark = (ms.prices.index.min + ms.prices.index.max) / 2n;
      freshness = worst(freshness, d.marketdata.market(market.symbol)?.freshness ?? 'unavailable');
    } catch (err) {
      d.log.warn({ err, funded, market: market.marketToken }, 'position could not be valued');
      freshness = 'unavailable';
    }
    positions.push({ address: p.address, market, isLong: p.position.isLong, position: p.position, status, mark });
  }
  const pending = state.orders.filter((o) => o.state === 'pending');
  const increase = (t: string) => t === 'market' || t === 'limit';
  return {
    funded, at: Date.now(), status: enumName(state.account.status), ownerUsdc: state.ownerUsdc,
    pendingCollateral: pending.filter((o) => increase(enumName(o.tracked.orderType))).reduce((s, o) => s + BigInt(o.tracked.collateral.toString()), 0n),
    positions, pendingOrders: pending.length, flat: state.flat, freshness,
  };
}

export function createVenue(d: VenueDeps) {
  const cache = new Map<string, Valuation>();
  const lastActive = new Map<string, number>();
  const lastEquitySnapshot = new Map<string, number>();
  const listeners = new Set<(v: Valuation, trader: string) => void>();

  type Outcome = { status: 'executed' | 'canceled' | 'unknown'; statusDetail: string | null };
  const executed: Outcome = { status: 'executed', statusDetail: null };
  const unexecuted = (reason: string): Outcome => ({ status: 'canceled', statusDetail: `The exchange could not execute this order${reason}` });

  /** Records how an order ended, once. When GMTrade itself cancelled it, the trader gets an activity row and a notice. */
  async function settle(funded: string, address: string, outcome: Outcome, endedAt: number, cancelledByGmtrade = false) {
    const [order] = await d.db.update(gmOrders).set({ ...outcome, closedAt: sql`coalesce(${gmOrders.closedAt}, now())`, updatedAt: new Date() })
      .where(and(eq(gmOrders.address, address), or(isNull(gmOrders.closedAt), inArray(gmOrders.status, UNSETTLED)))).returning();
    if (!order || !cancelledByGmtrade) return;
    const title = `${order.side} ${order.symbol} order cancelled by the exchange`;
    const detail = `${outcome.statusDetail}. Its collateral and deposit returned to the account.`;
    await d.db.insert(accountEvents).values({
      accountId: funded, type: 'cancel', title, detail, symbol: order.symbol, status: 'confirmed', simulated: false, ts: new Date(endedAt),
    });
    const [row] = await d.db.select({ trader: fundedAccounts.trader }).from(fundedAccounts).where(eq(fundedAccounts.address, funded));
    if (row && Date.now() - endedAt < NOTIFY_WITHIN_MS) {
      await d.notify({ wallet: row.trader, kind: 'fill', title, body: detail, href: fundedHref(funded) })
        .catch((err: unknown) => d.log.warn({ err }, 'notification failed'));
    }
  }

  /**
   * Brings gm_orders in line with GMTrade: every order still open, or finished without a known outcome (also one the
   * indexed sync already marked finished), is read now (an order read before the indexer saw it cannot be mistaken for
   * a finished one): pending → unchanged; finished but still open → from its state byte; gone → from GMTrade's removal
   * record, 'unknown' until the indexer has one.
   */
  async function syncOrders(funded: string) {
    const open = await d.db.select({ address: gmOrders.address }).from(gmOrders).where(and(
      eq(gmOrders.fundedAccount, funded),
      or(isNull(gmOrders.closedAt), inArray(gmOrders.status, PRE_EXECUTION), and(eq(gmOrders.status, 'unknown'), gt(gmOrders.closedAt, new Date(Date.now() - 86_400_000)))),
    ));
    if (!open.length) return;
    const { value } = await d.rpc.getMultipleAccountsInfoAndContext(open.map((o) => new PublicKey(o.address)));
    const gone: string[] = [];
    for (const [i, { address }] of open.entries()) {
      const data = gmOwned(value[i])?.data;
      const state: OrderState = data ? (ORDER_STATES[data[ORDER_LAYOUT.actionState]!] ?? 'pending') : 'missing';
      if (state === 'missing') gone.push(address);
      else if (state === 'completed') await settle(funded, address, executed, Date.now());
      else if (state === 'cancelled') await settle(funded, address, unexecuted(''), Date.now(), true);
    }
    if (!gone.length) return;
    const removals = new Map((await d.gm.removals(gone)).map((r) => [r.order, r]));
    for (const address of gone) {
      const r = removals.get(address);
      if (!r) await settle(funded, address, { status: 'unknown', statusDetail: 'Finished on the exchange; waiting for its result from the exchange\'s indexer' }, Date.now());
      else if (r.state === 'Completed') await settle(funded, address, executed, r.ts);
      // The indexer's free-text reason reaches the trader (order detail, activity, notification): scrubbed as health is.
      else if (r.state === 'Cancelled') await settle(funded, address, unexecuted(` (${why(r.reason)})`), r.ts, true);
      else await settle(funded, address, { status: 'canceled', statusDetail: 'Cancelled' }, r.ts);
    }
  }

  /** Indexes new GMTrade fills of the owner PDA; closing fills also write the round trip to closed_trades. */
  async function syncFills(funded: string, owner: string, trader: string): Promise<number> {
    const [{ cursor } = { cursor: null }] = await d.db.select({ cursor: max(venueFills.venueId) }).from(venueFills).where(eq(venueFills.fundedAccount, funded));
    const trades = await d.gm.trades(owner, cursor ?? undefined);
    if (!trades.length) return 0;
    const signatures = await d.gm.signatures(trades.map((t) => t.id));
    let added = 0;
    for (const e of trades) {
      const signature = signatures.get(e.id);
      if (!signature) break; // the indexer has not linked it yet: resume from here next tick, keeping fills in order
      const market = await d.reader.market(e.marketToken);
      const row = fillRow(e, funded, market, signature);
      const notice = await d.db.transaction(async (tx) => {
        const inserted = await tx.insert(venueFills).values(row).onConflictDoNothing().returning({ id: venueFills.venueId });
        if (!inserted.length) return null;
        await tx.update(gmOrders).set({ status: 'executed', statusDetail: null, closedAt: sql`coalesce(${gmOrders.closedAt}, now())`, updatedAt: sql`now()` })
          .where(eq(gmOrders.address, e.order));
        const a = fillActivity(row, e);
        await tx.insert(accountEvents).values({ accountId: funded, status: 'confirmed', simulated: false, ...a });
        if (!e.isIncrease && e.after.sizeInUsd === 0n) {
          const [previousClose] = await tx.select({ id: max(venueFills.venueId) }).from(venueFills).where(and(
            eq(venueFills.fundedAccount, funded), eq(venueFills.position, e.position), eq(venueFills.sizeAfterUsd, '0'), lt(venueFills.venueId, e.id),
          ));
          const fills = await tx.select().from(venueFills).where(and(
            eq(venueFills.fundedAccount, funded), eq(venueFills.position, e.position), sql`${venueFills.venueId} <= ${e.id}`,
            ...(previousClose?.id ? [gt(venueFills.venueId, previousClose.id)] : []),
          )).orderBy(venueFills.venueId);
          await tx.insert(closedTrades).values(roundTrip(funded, fills)).onConflictDoNothing();
        }
        return { wallet: trader, kind: 'fill' as const, title: a.title, body: a.detail, href: fundedHref(funded) };
      });
      if (notice) {
        added++;
        if (Date.now() - e.ts < NOTIFY_WITHIN_MS) await d.notify(notice).catch((err: unknown) => d.log.warn({ err }, 'notification failed'));
      }
    }
    return added;
  }

  /** Records a Position account's size and collateral whenever they change. */
  async function snapshotPositions(funded: string, slot: number, positions: { address: string; position: GmPosition }[], decimalsOf: (token: string) => Promise<number>) {
    for (const { address, position } of positions) {
      const [last] = await d.db.select().from(gmPositionSnapshots).where(eq(gmPositionSnapshots.position, address)).orderBy(desc(gmPositionSnapshots.slot)).limit(1);
      const sizeUsd = gmUsd(position.sizeInUsd);
      const collateralUsd = micro(position.collateralAmount);
      const changed = last ? d6(last.sizeUsd) !== d6(sizeUsd) || d6(last.collateralUsd) !== d6(collateralUsd) : position.sizeInUsd > 0n;
      if (!changed) continue;
      const marketToken = position.marketToken.toBase58();
      await d.db.insert(gmPositionSnapshots).values({
        position: address, slot, fundedAccount: funded, marketToken, side: position.isLong ? 'Long' : 'Short', sizeUsd,
        sizeTokens: tokenAmount(position.sizeInTokens, await decimalsOf(marketToken)), collateralUsd, ts: new Date(),
      }).onConflictDoNothing();
    }
  }

  /** Positions whose last snapshot is not flat: read them even after a sync freed their slot, to record the close. */
  async function openSnapshots(funded: string): Promise<string[]> {
    // The account's positions from the (funded_account, position) index, then each one's newest row by primary key:
    // a distinct-on over every snapshot of the account sorted thousands of rows a tick once it had traded for a while.
    const seen = d.db.selectDistinct({ position: gmPositionSnapshots.position }).from(gmPositionSnapshots)
      .where(eq(gmPositionSnapshots.fundedAccount, funded)).as('seen');
    const last = d.db.select({ position: gmPositionSnapshots.position, sizeUsd: gmPositionSnapshots.sizeUsd }).from(gmPositionSnapshots)
      .where(eq(gmPositionSnapshots.position, seen.position)).orderBy(desc(gmPositionSnapshots.slot)).limit(1).as('last');
    const latest = await d.db.select({ position: last.position, sizeUsd: last.sizeUsd }).from(seen).crossJoinLateral(last);
    return latest.filter((r) => d6(r.sizeUsd) !== 0n).map((r) => r.position);
  }

  /** One full refresh of a funded account; returns its valuation (null when the account does not exist onchain). */
  async function tick(funded: string, owner: string, trader: string, withFills: boolean): Promise<Valuation | null> {
    const state = await readFundedState(d, funded, await openSnapshots(funded));
    if (!state) return null;
    await syncOrders(funded);
    if (!state.flat) lastActive.set(funded, Date.now());
    if (withFills || Date.now() - (lastActive.get(funded) ?? -Infinity) < FILLS_AFTER_FLAT_MS) {
      try {
        await syncFills(funded, owner, trader);
      } catch (err) {
        d.log.warn({ err, funded }, 'GMTrade fills unavailable; retrying next tick');
      }
    }
    await snapshotPositions(funded, state.slot, state.positions, async (t) => (await d.reader.market(t)).decimals);
    const valuation = await valueFunded(d, funded, state);
    cache.set(funded, valuation);
    for (const fn of listeners) fn(valuation, trader);
    return valuation;
  }

  async function accountsToSync() {
    return d.db.select({ address: fundedAccounts.address, owner: fundedAccounts.ownerPda, trader: fundedAccounts.trader })
      .from(fundedAccounts)
      .where(or(sql`${fundedAccounts.status} <> 'closed'`, gt(fundedAccounts.closedAt, new Date(Date.now() - CLOSED_GRACE_MS))));
  }

  let wakeAccount = (_funded: string) => {};

  /** Leader loop: every account each `intervalMs` (at once again when the indexer saw one change); fills for all on the first pass. */
  async function run(signal: AbortSignal, intervalMs = 5_000) {
    let first = true;
    let again = false;
    wakeAccount = () => {
      again = true;
    };
    try {
      while (!signal.aborted) {
        const started = Date.now();
        again = false;
        const list = await accountsToSync().catch((err: unknown) => {
          d.log.error({ err }, 'funded account list failed');
          return [];
        });
        for (const a of list) {
          if (signal.aborted) break;
          try {
            await tick(a.address, a.owner, a.trader, first);
          } catch (err) {
            d.log.error({ err, funded: a.address }, 'funded account sync failed');
          }
        }
        first = false;
        if (again) continue;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, Math.max(0, intervalMs - (Date.now() - started)));
          signal.addEventListener('abort', done, { once: true });
        });
      }
    } finally {
      wakeAccount = () => {};
    }
  }

  return {
    tick,
    run,
    syncOrders,
    syncFills,
    /** Asks the loop for another pass right away (the indexer saw these accounts change). */
    changed(funded: string[]) {
      for (const f of funded) wakeAccount(f);
    },
    onValued(fn: (v: Valuation, trader: string) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Cached valuation if younger than `maxAgeMs`, else a fresh read (also on followers, where no loop runs). */
    async valuation(funded: string, maxAgeMs = 10_000): Promise<Valuation | null> {
      const hit = cache.get(funded);
      if (hit && Date.now() - hit.at <= maxAgeMs) return hit;
      const [row] = await d.db.select().from(fundedAccounts).where(eq(fundedAccounts.address, funded));
      if (!row) return null;
      const state = await readFundedState(d, funded, await openSnapshots(funded));
      if (!state) return null;
      const v = await valueFunded(d, funded, state);
      cache.set(funded, v);
      return v;
    },
    /** Writes an equity point at most once a minute per account (performance series). */
    shouldSnapshot(funded: string) {
      const last = lastEquitySnapshot.get(funded) ?? 0;
      if (Date.now() - last < SNAPSHOT_EVERY_MS) return false;
      lastEquitySnapshot.set(funded, Date.now());
      return true;
    },
  };
}

export type Venue = ReturnType<typeof createVenue>;
