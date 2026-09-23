// Practice + evaluation engine (ARCHITECTURE.md §1, §4.3): the same rules as funded accounts, priced by GMTrade's own
// model on live GMTrade market state and price ticks.
//
// The database is the source of truth. Every change to an account runs in one transaction that holds the account row
// lock (SELECT … FOR UPDATE, safe across processes), behind an in-process queue per account so waiting requests do not
// pin pool connections. Order intake runs anywhere; fills, liquidations and the rules loop run only on the leader.
//
// Execution follows GMTrade: every order executes on the first price tick with ts ≥ its last update + the keeper delay
// (SIM_FILL_DELAY_MS, measured 2 s); market orders at that tick, limit / take-profit / stop-loss orders on the first such
// tick that meets GMTrade's trigger rule; the model picks the side-correct min/max price and an order whose execution
// price is worse than its acceptable price is cancelled. Nothing opens, closes or triggers while the market is closed;
// liquidation (GMTrade's own check, including its closed-market factor, read from the Market account) always runs.
// Take profit, stop loss and 100% closes close the whole position at execution (GMTrade CLOSE_ALL, as funded places
// them), and an account holds at most the 8 orders and 8 positions a funded account can (program MAX_ORDERS/MAX_SLOTS).
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { AccountSummary, Market, Notification, PriceTick, SimCloseRequest, SimOrderRequest, SimOrderResponse, SimProtectionRequest, Position } from '@props/shared';
import { USDC_MINT, decodePosition, formatFixed } from '@props/gmtrade';
import { model, type DecreaseResult, type IncreaseResult } from '@props/gmsol-wasm';
import { acceptablePrice } from '@props/sdk';
import type { Db } from '../../db/client.ts';
import { accountEvents, accounts, closedTrades, equitySnapshots, simFills, simOrders, simPositions, simResults } from '../../db/schema.ts';
import { ApiError } from '../../errors.ts';
import type { EvaluationResult, EvaluationTerms, MarketDataService, MarketState, ModuleContext } from '../types.ts';
import {
  PENDING, STALE_MS, TRADING, loadAccount, loadAccounts, loadBook, markPositions, modelAccount, orderList, practiceId, snapshot,
  toFill, toOrder, value, type AccountRow, type Book, type Mark, type OrderRow, type PositionRow, type Valuation,
} from './book.ts';
import { tradesRoot } from './merkle.ts';
import {
  MICRO_PER_USD, micro, microText, modelInput, priceText, quoteFor, stampPosition, tickUnits, triggered, trim, unitOf, usd,
  usdText, withinAcceptable,
} from './model.ts';

const PRACTICE = { sizeUsd: '25000', lossAllowanceUsd: '1250', maxExposureBps: 10_000 } as const;
const MARKET_ORDER_TTL_MS = 30 * 60_000; // GMTrade store request_expiration
const SNAPSHOT_MS = 5 * 60_000;
const PASS_MS = 1_000;
const REDELIVER_MS = 5 * 60_000;
const NEAR_LIMIT_NOTICE_MS = 60 * 60_000;
const MIN_DECREASE_USD = 10n ** 20n; // GMTrade's $1 minimum for a partial decrease
const MAX_ORDERS = 8; // programs/props_vault state.rs MAX_ORDERS: tracked orders, each take profit and stop loss included
const MAX_POSITIONS = 8; // MAX_SLOTS: (market, side) pairs with a position or a pending increase
const TERMINAL = new Set<string>(['passed', 'failed', 'breached']);

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Notice = Pick<Notification, 'title' | 'body' | 'href' | 'kind'>;
interface Effects {
  accountId: string; wallet: string;
  changed: boolean; filled: boolean;
  notices: Notice[]; resolved: EvaluationResult[];
  /** Pending orders a tick could now fill, and orders that are done: the fill watch follows them once committed. */
  watch: OrderRow[]; unwatch: OrderRow[];
  /** In-process bookkeeping that holds only if the transaction commits. */
  onCommit: (() => void)[];
  valuation?: Valuation;
}

/** A mark from an open market whose feed went quiet decides nothing; a closed market's last price stands. */
const fresh = (m: Mark, now: number) => m.tick !== undefined && (m.tick.session !== 'open' || now - m.tick.ts <= STALE_MS);
const expired = (o: OrderRow, now: number) => o.kind === 'Market' && now - o.createdAt.getTime() > MARKET_ORDER_TTL_MS;

export interface EngineDeps {
  db: Db;
  log: FastifyBaseLogger;
  marketdata: MarketDataService;
  publish: ModuleContext['publish'];
  notify: ModuleContext['notify'];
  fillDelayMs: number;
}

export type Engine = ReturnType<typeof createEngine>;

const failure = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** Order times come from this process's clock, the one fill timing compares ticks against. */
const stamped = () => {
  const now = new Date();
  return { createdAt: now, updatedAt: now };
};
const money = (s: string) => `$${Number(s).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hrefOf = (a: Pick<AccountRow, 'stage'>) => `#/account/${a.stage}`;
const sizeLabel = (sizeUsd: string) => `${Number(sizeUsd) / 1000}K`;

export function createEngine({ db, log, marketdata: md, publish, notify, fillDelayMs }: EngineDeps) {
  const queues = new Map<string, Promise<unknown>>();
  const inflight = new Set<Promise<unknown>>();
  /**
   * symbol → pending orders in it by id: what a tick can fill, checked in memory before any account is locked. Rebuilt
   * from the database by every rules pass (1 s, shorter than the fill delay), so orders placed by another process are
   * watched before they can fill; this process's own changes are applied as they commit.
   */
  let watched = new Map<string, Map<string, OrderRow>>();
  /** Orders watched while a rules pass reads the book: added back once it swaps in its rebuilt watch. */
  const rebuilding = new Set<OrderRow[]>();
  const listeners = new Set<(r: EvaluationResult) => void>();
  const lastSnapshot = new Map<string, number>();
  const lastPublished = new Map<string, string>();
  /** When each account last published a committed change: a rules pass that read it earlier publishes nothing. */
  const publishedAt = new Map<string, number>();
  const nearLimitNoticeAt = new Map<string, number>();
  let leading = false;

  // ---------- plumbing ----------

  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    queues.set(key, tail);
    void tail.then(() => queues.get(key) === tail && queues.delete(key));
    return run;
  }

  function track<T>(p: Promise<T>): Promise<T> {
    inflight.add(p);
    p.then(() => inflight.delete(p), () => inflight.delete(p));
    return p;
  }

  /** Runs `fn` in a transaction holding the account's row lock; stream events, notifications and results go out after commit. */
  function inAccount<T>(accountId: string, fn: (tx: Tx, account: AccountRow, fx: Effects) => Promise<T>): Promise<T> {
    return track(serial(accountId, async () => {
      const fx: Effects = {
        accountId, wallet: '', changed: false, filled: false, notices: [], resolved: [], watch: [], unwatch: [], onCommit: [],
      };
      const result = await db.transaction(async (tx) => {
        await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).for('update');
        const account = await loadAccount(tx, accountId);
        if (!account) throw new ApiError(404, 'not_found', 'Account not found');
        fx.wallet = account.wallet;
        return fn(tx, account, fx);
      });
      await afterCommit(fx);
      return result;
    }));
  }

  async function afterCommit(fx: Effects) {
    for (const f of fx.onCommit) f();
    for (const o of fx.unwatch) watched.get(o.symbol)?.delete(o.id);
    for (const o of fx.watch) watch(o);
    if (fx.changed || fx.valuation) publishedAt.set(fx.accountId, Date.now());
    try {
      if (fx.changed) await publishAccount(fx.accountId);
      else if (fx.valuation) publishValuation(fx.wallet, fx.accountId, fx.valuation);
    } catch (err) {
      log.warn({ err, account: fx.accountId }, 'sim: stream publish failed');
    }
    for (const n of fx.notices) await notify(fx.wallet, n).catch((err: unknown) => log.warn({ err }, 'sim: notification failed'));
    for (const r of fx.resolved) emit(r);
  }

  function watch(order: OrderRow) {
    if (!leading) return; // a new leader's first rules pass reads the whole book
    watched.set(order.symbol, (watched.get(order.symbol) ?? new Map<string, OrderRow>()).set(order.id, order));
    for (const added of rebuilding) added.push(order);
  }

  function publishValuation(wallet: string, accountId: string, v: Valuation) {
    const frame = JSON.stringify([v.summary, v.positions]);
    if (lastPublished.get(accountId) === frame) return;
    lastPublished.set(accountId, frame);
    publish({ type: 'account', account: v.summary }, { wallet });
    publish({ type: 'positions', accountId, positions: v.positions }, { wallet });
  }

  async function publishAccount(accountId: string) {
    const account = await loadAccount(db, accountId);
    if (!account) return;
    const [{ valuation }, orders] = await Promise.all([snapshot(db, md, account), orderList(db, accountId)]);
    publish({ type: 'orders', accountId, orders }, { wallet: account.wallet });
    lastPublished.delete(accountId);
    publishValuation(account.wallet, accountId, valuation);
  }

  function emit(result: EvaluationResult) {
    for (const listener of listeners) {
      try {
        listener(result);
      } catch (err) {
        log.error({ err, evaluation: result.evaluation }, 'sim: onResolved listener failed');
      }
    }
  }

  async function event(tx: Tx, accountId: string, type: typeof accountEvents.$inferInsert.type, title: string, detail: string,
    extra: { amountUsd?: string; symbol?: string; signature?: string; status?: 'confirmed' | 'failed'; ts?: Date } = {}) {
    await tx.insert(accountEvents).values({ accountId, type, title, detail, status: 'confirmed', simulated: true, ts: new Date(), ...extra });
  }

  async function cancel(tx: Tx, order: OrderRow, detail: string) {
    await tx.update(simOrders).set({ status: 'canceled', statusDetail: detail, updatedAt: new Date() })
      .where(and(eq(simOrders.id, order.id), inArray(simOrders.status, PENDING)));
    // Protection placed with an increase order dies with it.
    await tx.update(simOrders).set({ status: 'canceled', statusDetail: 'Its opening order did not fill', updatedAt: new Date() })
      .where(and(eq(simOrders.parentOrderId, order.id), inArray(simOrders.status, PENDING)));
  }

  // ---------- accounts ----------

  async function ensurePractice(wallet: string): Promise<void> {
    const now = new Date();
    const [created] = await db.insert(accounts).values({
      id: practiceId(wallet), wallet, stage: 'practice', status: 'active', label: 'Practice account',
      sizeUsd: PRACTICE.sizeUsd, lossAllowanceUsd: PRACTICE.lossAllowanceUsd, maxExposureBps: PRACTICE.maxExposureBps,
      traderShareBps: 0, createdAt: now, updatedAt: now,
    }).onConflictDoNothing().returning({ id: accounts.id });
    if (!created) return;
    await db.insert(equitySnapshots).values({ accountId: created.id, ts: now, equity: PRACTICE.sizeUsd, realizedPnl: '0', unrealizedPnl: '0' });
    await db.insert(accountEvents).values({
      accountId: created.id, type: 'account', title: 'Practice account opened', detail: '25,000 USD of simulated capital',
      status: 'confirmed', simulated: true, ts: now,
    });
  }

  /** The wallet's account, or 404 (also for other wallets' accounts). Opens the practice account on first use. */
  async function owned(wallet: string, id: string): Promise<AccountRow> {
    let account = await loadAccount(db, id, wallet);
    if (!account && id === practiceId(wallet)) {
      await ensurePractice(wallet);
      account = await loadAccount(db, id, wallet);
    }
    if (!account) throw new ApiError(404, 'not_found', 'Account not found');
    return account;
  }

  async function summary(accountId: string): Promise<AccountSummary> {
    return (await snapshot(db, md, (await loadAccount(db, accountId))!)).valuation.summary;
  }

  async function createEvaluation(input: { evaluation: string; wallet: string; terms: EvaluationTerms; purchasedAt: number; signature: string }) {
    const { terms } = input;
    const size = micro(terms.sizeUsd);
    const at = new Date(input.purchasedAt);
    const [created] = await db.insert(accounts).values({
      id: input.evaluation, wallet: input.wallet, stage: 'evaluation', status: 'active', label: `Evaluation ${sizeLabel(terms.sizeUsd)}`,
      tierId: terms.tierId, evaluation: input.evaluation, sizeUsd: terms.sizeUsd,
      lossAllowanceUsd: microText((size * BigInt(terms.maxDrawdownBps)) / 10_000n),
      profitTargetUsd: microText((size * BigInt(terms.profitTargetBps)) / 10_000n),
      maxExposureBps: terms.maxExposureBps, traderShareBps: terms.traderShareBps, termsHash: terms.termsHash,
      createdAt: at, updatedAt: at,
    }).onConflictDoNothing().returning({ id: accounts.id });
    if (!created) return;
    await db.insert(equitySnapshots).values({ accountId: created.id, ts: at, equity: terms.sizeUsd, realizedPnl: '0', unrealizedPnl: '0' });
    await db.insert(accountEvents).values({
      accountId: created.id, type: 'account', title: 'Evaluation started', detail: `Evaluation ${sizeLabel(terms.sizeUsd)} purchased`,
      status: 'confirmed', simulated: false, signature: input.signature, ts: at,
    });
  }

  async function resetPractice(wallet: string): Promise<AccountSummary> {
    await ensurePractice(wallet);
    const id = practiceId(wallet);
    await inAccount(id, async (tx, account, fx) => {
      const now = new Date();
      const archive = `${id}:${now.getTime()}`;
      await tx.update(simOrders).set({ status: 'canceled', statusDetail: 'Practice account reset', updatedAt: now })
        .where(and(eq(simOrders.accountId, id), inArray(simOrders.status, PENDING)));
      await tx.update(simPositions).set({ closedAt: now, updatedAt: now }).where(and(eq(simPositions.accountId, id), isNull(simPositions.closedAt)));
      const { purchaseSignature: _, ...row } = account;
      await tx.insert(accounts).values({ ...row, id: archive, resolvedAt: now, updatedAt: now });
      for (const table of [simPositions, simOrders, simFills, closedTrades, equitySnapshots, accountEvents]) {
        await tx.update(table).set({ accountId: archive }).where(eq(table.accountId, id));
      }
      await tx.update(accounts).set({ status: 'active', realizedPnl: '0', createdAt: now, resolvedAt: null, updatedAt: now }).where(eq(accounts.id, id));
      await tx.insert(equitySnapshots).values({ accountId: id, ts: now, equity: account.sizeUsd, realizedPnl: '0', unrealizedPnl: '0' });
      await event(tx, id, 'account', 'Practice account reset', 'A fresh 25,000 USD practice account; the previous one is archived', { ts: now });
      fx.onCommit.push(() => lastSnapshot.delete(id));
      fx.changed = true;
    });
    return summary(id);
  }

  // ---------- order intake ----------

  function marketOf(symbol: string): Market {
    const market = md.market(symbol);
    if (!market) throw new ApiError(404, 'not_found', `Unknown market ${symbol}`);
    return market;
  }

  async function tradableMarket(account: AccountRow, symbol: string): Promise<{ market: Market; tick: PriceTick; state: MarketState }> {
    const market = marketOf(symbol);
    const pool = market.pools.find((p) => p.marketToken === market.marketToken);
    const pureUsdc = pool?.pure === true && pool.longToken === USDC_MINT && pool.shortToken === USDC_MINT;
    if (account.stage === 'practice' && !pureUsdc) {
      throw new ApiError(422, 'market_unavailable', `${market.symbol} has no USDC-only pool on GMTrade, so it cannot be traded here`);
    }
    if (account.stage === 'evaluation' && !market.tradable) {
      throw new ApiError(422, 'market_unavailable', market.unavailableReason ?? `${market.symbol} is not available for evaluation trading`);
    }
    return { market, ...(await liveSession(market)) };
  }

  async function liveSession(market: Market): Promise<{ tick: PriceTick; state: MarketState }> {
    const tick = md.price(market.symbol);
    if (!tick || (tick.session === 'open' && Date.now() - tick.ts > STALE_MS)) {
      throw new ApiError(503, 'price_unavailable', `No live ${market.symbol} price right now, try again shortly`);
    }
    const state = await md.marketState(market.marketToken);
    if (tick.session !== 'open' || state.isClosed) {
      throw new ApiError(409, 'market_closed', `${market.symbol} is closed; GMTrade accepts no orders for it until it reopens`);
    }
    return { tick, state };
  }

  function priceArg(value: string, decimals: number, field: string): bigint {
    let unit: bigint;
    try {
      unit = unitOf(value, decimals);
    } catch {
      throw new ApiError(400, 'bad_request', `Invalid ${field}: at most ${20 - decimals} decimal places`);
    }
    if (unit <= 0n) throw new ApiError(400, 'bad_request', `Invalid ${field}: must be above zero`);
    return unit;
  }

  /** Take-profit above and stop-loss below the reference price for longs, the other way round for shorts. */
  function checkProtection(isLong: boolean, reference: bigint, referenceName: string, tp: bigint | null, sl: bigint | null) {
    if (tp !== null && (isLong ? tp <= reference : tp >= reference)) {
      throw new ApiError(422, 'order_rejected', `Take profit must be ${isLong ? 'above' : 'below'} the ${referenceName}`);
    }
    if (sl !== null && (isLong ? sl >= reference : sl <= reference)) {
      throw new ApiError(422, 'order_rejected', `Stop loss must be ${isLong ? 'below' : 'above'} the ${referenceName}`);
    }
  }

  /** The program's tracked-order limit, for an action that adds `adding` pending orders. */
  function checkOrderCount(book: Book, adding: number) {
    if (book.orders.length + adding > MAX_ORDERS) {
      throw new ApiError(422, 'order_rejected', `At most ${MAX_ORDERS} orders can be pending at once, as on a funded account (take profit and stop loss count as one each)`);
    }
  }

  /**
   * The program's open_position checks (§1): tracked orders (this one and its take profit / stop loss), position slots,
   * per-market leverage, available margin, total exposure.
   */
  function checkLimits(account: AccountRow, market: Market, book: Book, req: SimOrderRequest, size: bigint, collateral: bigint) {
    if (size <= 0n || collateral <= 0n) throw new ApiError(400, 'bad_request', 'Size and margin must be above zero');
    checkOrderCount(book, 1 + Number(req.takeProfit !== undefined) + Number(req.stopLoss !== undefined));
    const slots = new Set([...book.positions, ...book.orders.filter((o) => o.isIncrease)].map((x) => `${x.symbol}:${x.side}`));
    if (!slots.has(`${market.symbol}:${req.side}`) && slots.size >= MAX_POSITIONS) {
      throw new ApiError(422, 'order_rejected', `At most ${MAX_POSITIONS} positions can be open or pending at once, as on a funded account`);
    }
    const maxLeverageBps = BigInt(Math.round(market.maxLeverage * 10_000));
    if (size * 10_000n > maxLeverageBps * collateral * MICRO_PER_USD) {
      const leverage = (Number(size) / Number(collateral * MICRO_PER_USD)).toFixed(2);
      throw new ApiError(422, 'order_rejected', `Leverage ${leverage}x is above the ${market.maxLeverage}x limit for ${market.symbol}`);
    }
    const inPositions = book.positions.reduce((s, p) => s + micro(p.collateralUsd), 0n);
    const increases = book.orders.filter((o) => o.isIncrease);
    const reserved = increases.reduce((s, o) => s + micro(o.collateralUsd ?? '0'), 0n);
    const available = micro(account.lossAllowanceUsd) + micro(account.realizedPnl) - inPositions - reserved;
    if (collateral > available) {
      throw new ApiError(422, 'order_rejected', `Margin ${money(microText(collateral))} is more than the ${money(microText(available > 0n ? available : 0n))} available`);
    }
    const exposure = [...book.positions, ...increases].reduce((s, x) => s + usd(x.sizeUsd), 0n);
    const cap = (usd(account.sizeUsd) * BigInt(account.maxExposureBps)) / 10_000n;
    if (exposure + size > cap) {
      throw new ApiError(422, 'order_rejected', `Total exposure would be ${money(usdText(exposure + size))}, above the ${money(usdText(cap))} limit`);
    }
  }

  /** The order a client id already placed on the account (a retry gets it back), or 409 if it was a different request. */
  async function byClientId(tx: Tx, accountId: string, clientId: string, same: (o: OrderRow) => boolean) {
    const [row] = await tx.select().from(simOrders).where(and(eq(simOrders.accountId, accountId), eq(simOrders.clientId, clientId)));
    if (row && !same(row)) throw new ApiError(409, 'idempotency_conflict', 'This client id was already used for a different order');
    return row;
  }

  const sameOrder = (req: SimOrderRequest) => (o: OrderRow) => o.isIncrease && o.kind === req.kind && o.side === req.side
    && o.symbol === req.symbol.toUpperCase() && usd(o.sizeUsd) === usd(req.sizeUsd) && micro(o.collateralUsd!) === micro(req.collateralUsd)
    && (o.triggerPrice === null ? req.triggerPrice === undefined : req.triggerPrice !== undefined && usd(o.triggerPrice) === usd(req.triggerPrice));

  async function placeOrder(wallet: string, accountId: string, req: SimOrderRequest): Promise<SimOrderResponse> {
    await owned(wallet, accountId);
    const order = await inAccount(accountId, async (tx, account, fx) => {
      const existing = await byClientId(tx, accountId, req.clientId, sameOrder(req));
      if (existing) return existing;
      if (!TRADING.has(account.status)) throw new ApiError(409, 'account_inactive', `This account is ${account.status}; it takes no new orders`);
      const { market, tick, state } = await tradableMarket(account, req.symbol);
      const dec = state.indexDecimals;
      const isLong = req.side === 'Long';
      const size = usd(req.sizeUsd);
      const collateral = micro(req.collateralUsd);
      const trigger = req.kind === 'Limit' ? priceArg(req.triggerPrice!, dec, 'triggerPrice') : null;
      const tp = req.takeProfit === undefined ? null : priceArg(req.takeProfit, dec, 'takeProfit');
      const sl = req.stopLoss === undefined ? null : priceArg(req.stopLoss, dec, 'stopLoss');
      const book = await loadBook(tx, accountId);
      checkLimits(account, market, book, req, size, collateral);

      const quote = tickUnits(tick, dec);
      checkProtection(isLong, trigger ?? (quote.min + quote.max) / 2n, trigger === null ? 'current price' : 'limit price', tp, sl);
      // GMTrade's own validation (min size and collateral, its leverage and open-interest limits) at the fill price.
      const open = book.positions.find((p) => p.symbol === market.symbol && p.side === req.side);
      const position = open && modelAccount(open);
      try {
        model.simulateIncrease({
          market: modelInput(state, trigger === null ? quote : { min: trigger, max: trigger }, position),
          position, isLong, collateralToken: USDC_MINT, collateralAmount: collateral, sizeDeltaUsd: size,
        });
      } catch (err) {
        throw new ApiError(422, 'rejected_by_venue', `GMTrade would reject this order: ${failure(err)}`);
      }
      const acceptable = acceptablePrice(trigger ?? quoteFor(quote, isLong, true), isLong, true, req.slippageBps);
      const base = { accountId, symbol: market.symbol, marketToken: market.marketToken, side: req.side, slippageBps: req.slippageBps };
      const [row] = await tx.insert(simOrders).values({
        ...base, ...stamped(), clientId: req.clientId, kind: req.kind, isIncrease: true, sizeUsd: usdText(size), collateralUsd: microText(collateral),
        triggerPrice: trigger === null ? null : priceText(trigger, dec), acceptablePrice: priceText(acceptable, dec),
        status: req.kind === 'Market' ? 'awaiting_execution' : 'awaiting_price',
      }).returning();
      // Protection covers the whole position this order fills into (CLOSE_ALL); the size shown follows the position.
      const protects = usdText(size + (open ? usd(open.sizeUsd) : 0n));
      for (const [kind, price] of [['TakeProfit', tp], ['StopLoss', sl]] as const) {
        if (price === null) continue;
        await tx.insert(simOrders).values({
          ...base, ...stamped(), clientId: `${req.clientId}:${kind}`, kind, isIncrease: false, closeAll: true, sizeUsd: protects,
          triggerPrice: priceText(price, dec), status: 'awaiting_price', parentOrderId: row!.id,
        });
      }
      await event(tx, accountId, 'order', `${req.kind} ${req.side.toLowerCase()} ${market.symbol}`,
        `${money(usdText(size))} with ${money(microText(collateral))} margin${trigger === null ? '' : ` at ${priceText(trigger, dec)}`}`,
        { amountUsd: usdText(size), symbol: market.symbol });
      fx.changed = true;
      fx.watch.push(row!);
      return row!;
    });
    return { order: toOrder(order), account: await summary(accountId) };
  }

  async function cancelOrder(wallet: string, accountId: string, orderId: string): Promise<SimOrderResponse> {
    await owned(wallet, accountId);
    const order = await inAccount(accountId, async (tx, _account, fx) => {
      const [row] = await tx.select().from(simOrders).where(and(eq(simOrders.id, orderId), eq(simOrders.accountId, accountId)));
      if (!row) throw new ApiError(404, 'not_found', 'Order not found');
      if (!PENDING.includes(row.status)) return row;
      await cancel(tx, row, 'Cancelled by you');
      await event(tx, accountId, 'cancel', `${row.kind} order cancelled`, `${row.side} ${row.symbol} ${money(row.sizeUsd)}`, { symbol: row.symbol });
      fx.changed = true;
      fx.unwatch.push(row);
      const [updated] = await tx.select().from(simOrders).where(eq(simOrders.id, orderId));
      return updated!;
    });
    return { order: toOrder(order), account: await summary(accountId) };
  }

  async function openPosition(tx: Tx, accountId: string, positionId: string): Promise<PositionRow> {
    const [row] = await tx.select().from(simPositions)
      .where(and(eq(simPositions.id, positionId), eq(simPositions.accountId, accountId), isNull(simPositions.closedAt)));
    if (!row) throw new ApiError(404, 'not_found', 'Position not found or already closed');
    return row;
  }

  async function closePosition(wallet: string, accountId: string, positionId: string, req: SimCloseRequest): Promise<SimOrderResponse> {
    await owned(wallet, accountId);
    const closeAll = req.percent === 100;
    const order = await inAccount(accountId, async (tx, _account, fx) => {
      const existing = await byClientId(tx, accountId, req.clientId,
        (o) => !o.isIncrease && o.kind === 'Market' && o.positionId === positionId && o.closeAll === closeAll);
      if (existing) return existing;
      const position = await openPosition(tx, accountId, positionId);
      const { tick, state } = await liveSession(marketOf(position.symbol));
      const isLong = position.side === 'Long';
      // 100% is CLOSE_ALL: whatever the position is when it executes (the size shown follows the position).
      const size = closeAll ? usd(position.sizeUsd) : (usd(position.sizeUsd) * BigInt(Math.round(req.percent * 100))) / 10_000n;
      if (!closeAll && size < MIN_DECREASE_USD) throw new ApiError(422, 'order_rejected', 'GMTrade closes at least $1 at a time');
      const acceptable = acceptablePrice(quoteFor(tickUnits(tick, state.indexDecimals), isLong, false), isLong, false, req.slippageBps);
      const [row] = await tx.insert(simOrders).values({
        ...stamped(), accountId, clientId: req.clientId, positionId, symbol: position.symbol, marketToken: position.marketToken, side: position.side,
        kind: 'Market', isIncrease: false, closeAll, sizeUsd: usdText(size), acceptablePrice: priceText(acceptable, state.indexDecimals),
        slippageBps: req.slippageBps, status: 'awaiting_execution',
      }).returning();
      await event(tx, accountId, 'order', `Close ${position.side.toLowerCase()} ${position.symbol}`, `${req.percent}% of ${money(position.sizeUsd)}`,
        { amountUsd: usdText(size), symbol: position.symbol });
      fx.changed = true;
      fx.watch.push(row!);
      return row!;
    });
    return { order: toOrder(order), account: await summary(accountId) };
  }

  async function setProtection(wallet: string, accountId: string, positionId: string, req: SimProtectionRequest): Promise<Position> {
    await owned(wallet, accountId);
    await inAccount(accountId, async (tx, account, fx) => {
      const position = await openPosition(tx, accountId, positionId);
      if (!TRADING.has(account.status)) throw new ApiError(409, 'account_inactive', `This account is ${account.status}; it takes no new orders`);
      const { tick, state } = await liveSession(marketOf(position.symbol));
      const dec = state.indexDecimals;
      const isLong = position.side === 'Long';
      const want = {
        TakeProfit: req.takeProfit === null ? null : priceArg(req.takeProfit, dec, 'takeProfit'),
        StopLoss: req.stopLoss === null ? null : priceArg(req.stopLoss, dec, 'stopLoss'),
      };
      const quote = tickUnits(tick, dec);
      checkProtection(isLong, (quote.min + quote.max) / 2n, 'current price', want.TakeProfit, want.StopLoss);
      const book = await loadBook(tx, accountId);
      const current = book.orders.filter((o) => o.positionId === positionId && (o.kind === 'TakeProfit' || o.kind === 'StopLoss'));
      const kinds = ['TakeProfit', 'StopLoss'] as const;
      checkOrderCount(book, kinds.filter((kind) => want[kind] !== null && !current.some((o) => o.kind === kind)).length);
      for (const kind of kinds) {
        const have = current.find((o) => o.kind === kind);
        const price = want[kind];
        if (have && price !== null && unitOf(have.triggerPrice!, dec) === price) continue;
        if (have) {
          await cancel(tx, have, price === null ? 'Removed by you' : 'Replaced by a new price');
          fx.unwatch.push(have);
        }
        if (price === null) continue;
        const [row] = await tx.insert(simOrders).values({
          ...stamped(), accountId, clientId: `protection:${randomUUID()}`, positionId, symbol: position.symbol, marketToken: position.marketToken,
          side: position.side, kind, isIncrease: false, closeAll: true, sizeUsd: position.sizeUsd, triggerPrice: priceText(price, dec),
          slippageBps: 0, status: 'awaiting_price',
        }).returning();
        fx.watch.push(row!);
      }
      const text = (p: bigint | null) => (p === null ? 'none' : priceText(p, dec));
      await event(tx, accountId, 'protection', `Protection on ${position.side.toLowerCase()} ${position.symbol}`,
        `Take profit ${text(want.TakeProfit)}, stop loss ${text(want.StopLoss)}`, { symbol: position.symbol });
      fx.changed = true;
    });
    const account = (await loadAccount(db, accountId))!;
    const { valuation } = await snapshot(db, md, account);
    return valuation.positions.find((p) => p.id === positionId)!;
  }

  // ---------- execution (leader) ----------

  /** Whether `order` may execute on `tick`: open market, the keeper delay since its last change, GMTrade's trigger rule. */
  function executable(order: OrderRow, tick: PriceTick, state: MarketState): boolean {
    if (tick.session !== 'open' || state.isClosed || tick.ts < order.updatedAt.getTime() + fillDelayMs) return false;
    if (order.kind === 'Market') return true;
    if (!order.isIncrease && order.positionId === null) return false; // protection armed only once its order fills
    const dec = state.indexDecimals;
    return triggered(order.kind, order.side === 'Long', unitOf(order.triggerPrice!, dec), tickUnits(tick, dec));
  }

  async function fillOrders(tx: Tx, account: AccountRow, fx: Effects, tick: PriceTick) {
    const orders = await tx.select().from(simOrders)
      .where(and(eq(simOrders.accountId, account.id), eq(simOrders.symbol, tick.symbol), inArray(simOrders.status, PENDING)))
      .orderBy(asc(simOrders.createdAt));
    for (const order of orders) {
      const state = await md.marketState(order.marketToken);
      if (executable(order, tick, state)) await execute(tx, account, fx, order, tick, state);
    }
    if (fx.filled || fx.changed) fx.valuation = await applyRules(tx, account.id, fx);
  }

  async function execute(tx: Tx, account: AccountRow, fx: Effects, order: OrderRow, tick: PriceTick, state: MarketState) {
    const isLong = order.side === 'Long';
    const dec = state.indexDecimals;
    fx.changed = true;
    fx.unwatch.push(order); // executed or cancelled below
    let position: PositionRow | undefined;
    if (order.isIncrease) {
      [position] = await tx.select().from(simPositions).where(and(eq(simPositions.accountId, account.id),
        eq(simPositions.symbol, order.symbol), eq(simPositions.side, order.side), isNull(simPositions.closedAt)));
    } else if (order.positionId) {
      [position] = await tx.select().from(simPositions).where(and(eq(simPositions.id, order.positionId), isNull(simPositions.closedAt)));
    }
    if (!order.isIncrease && !position) return cancel(tx, order, 'The position is already closed');

    const image = position && modelAccount(position);
    const market = modelInput(state, tickUnits(tick, dec), image);
    let result: IncreaseResult | DecreaseResult;
    try {
      if (order.isIncrease) {
        result = model.simulateIncrease({
          market, position: image, isLong, collateralToken: USDC_MINT, collateralAmount: micro(order.collateralUsd!), sizeDeltaUsd: usd(order.sizeUsd),
        });
      } else {
        const requested = usd(order.sizeUsd); // a partial close larger than the position closes it (GMTrade caps it)
        const all = order.closeAll || requested >= usd(position!.sizeUsd);
        result = model.simulateDecrease({ market, position: image!, sizeDeltaUsd: all ? decodePosition(image!).state.size_in_usd : requested });
      }
    } catch (err) {
      await cancel(tx, order, `GMTrade would not execute this order: ${failure(err)}`);
      return event(tx, account.id, 'cancel', `${order.kind} order cancelled`, failure(err), { symbol: order.symbol, status: 'failed' });
    }
    if (order.acceptablePrice && !withinAcceptable(result.executionPrice, unitOf(order.acceptablePrice, dec), isLong, order.isIncrease)) {
      const detail = `Price moved past your slippage limit: it would fill at ${priceText(result.executionPrice, dec)}, worse than your acceptable price ${trim(order.acceptablePrice)}`;
      await cancel(tx, order, detail);
      return event(tx, account.id, 'cancel', `${order.kind} order cancelled`, detail, { symbol: order.symbol, status: 'failed' });
    }
    await recordFill(tx, account, fx, { order, position, result, tick, state, collateralIn: order.isIncrease ? micro(order.collateralUsd!) : 0n });
  }

  /** Liquidates a position as GMTrade's keeper would; false (nothing written) when the model refuses it. */
  async function liquidate(tx: Tx, account: AccountRow, fx: Effects, m: Required<Mark>): Promise<boolean> {
    const position = modelAccount(m.position);
    let result: DecreaseResult;
    try {
      result = model.simulateDecrease({
        market: modelInput(m.state, tickUnits(m.tick, m.state.indexDecimals), position), position,
        sizeDeltaUsd: decodePosition(position).state.size_in_usd, liquidation: true,
      });
    } catch (err) {
      log.warn({ err, account: account.id, position: m.position.id }, 'sim: the model refused a liquidation; retried next pass');
      return false;
    }
    fx.changed = true;
    await recordFill(tx, account, fx, { order: null, position: m.position, result, tick: m.tick, state: m.state, collateralIn: 0n });
    return true;
  }

  /**
   * Applies one executed fill: position, fill row, realized P&L, the order, protection, the round trip when the
   * position closes, activity and notification.
   */
  async function recordFill(tx: Tx, account: AccountRow, fx: Effects, f: {
    order: OrderRow | null; position: PositionRow | undefined; result: IncreaseResult | DecreaseResult;
    tick: PriceTick; state: MarketState; collateralIn: bigint;
  }) {
    const { order, result, state } = f;
    const dec = state.indexDecimals;
    const isIncrease = 'collateralDeltaAmount' in result;
    const now = new Date();
    const after = result.position;
    const before = f.position ? micro(f.position.collateralUsd) : 0n;
    const remaining = after?.collateralAmount ?? 0n;
    // Cash view: an increase realizes the costs taken from the collateral it adds; a decrease realizes what it pays
    // out minus the collateral it releases. (Excess negative impact GMTrade parks as claimable is not paid out.)
    const realized = isIncrease ? remaining - before - f.collateralIn : result.outputAmount + result.secondaryOutputAmount - (before - remaining);
    const values = after && {
      sizeUsd: usdText(after.sizeInUsd), sizeTokens: formatFixed(after.sizeInTokens, dec, dec), collateralUsd: microText(after.collateralAmount),
      entryPrice: priceText(after.sizeInUsd / after.sizeInTokens, dec), modelState: { account: stampPosition(after.account, isIncrease, now) },
      updatedAt: now,
    };
    let position = f.position;
    if (!position) {
      [position] = await tx.insert(simPositions).values({
        ...values!, accountId: account.id, symbol: order!.symbol, marketToken: order!.marketToken, side: order!.side, openedAt: now,
      }).returning();
    } else {
      await tx.update(simPositions).set(values ?? { closedAt: now, updatedAt: now }).where(eq(simPositions.id, position.id));
    }
    const p = position!;
    const sizeDelta = isIncrease ? usd(order!.sizeUsd) : result.sizeDeltaUsd;
    await tx.insert(simFills).values({
      accountId: account.id, orderId: order?.id ?? null, positionId: p.id, symbol: p.symbol, side: p.side, isIncrease,
      sizeUsd: usdText(sizeDelta), price: priceText(result.executionPrice, dec),
      feeUsd: usdText(result.fees.orderFeeValue + (result.fees.liquidationFeeValue ?? 0n)), priceImpactUsd: usdText(result.priceImpactValue),
      fundingUsd: microText(result.fees.fundingFeeAmount), borrowUsd: microText(result.fees.borrowingFeeAmount), realizedPnl: microText(realized),
      tickTs: new Date(f.tick.ts), ts: now,
    });
    await tx.update(accounts).set({ realizedPnl: sql`${accounts.realizedPnl} + ${microText(realized)}`, updatedAt: now }).where(eq(accounts.id, account.id));
    fx.filled = true;

    if (order) {
      await tx.update(simOrders).set({ status: 'executed', statusDetail: `Filled at ${priceText(result.executionPrice, dec)}`, positionId: p.id, updatedAt: now })
        .where(eq(simOrders.id, order.id));
      const armed = await tx.update(simOrders).set({ positionId: p.id, updatedAt: now })
        .where(and(eq(simOrders.parentOrderId, order.id), inArray(simOrders.status, PENDING))).returning();
      for (const o of armed) { // the newest protection of each kind replaces the position's previous one
        await tx.update(simOrders).set({ status: 'canceled', statusDetail: 'Replaced by a new price', updatedAt: now }).where(and(
          eq(simOrders.positionId, p.id), eq(simOrders.kind, o.kind), inArray(simOrders.status, PENDING), ne(simOrders.id, o.id)));
        fx.watch.push(o);
      }
    }
    if (after) { // what the position's close-all orders (protection, 100% closes) now close
      await tx.update(simOrders).set({ sizeUsd: values!.sizeUsd })
        .where(and(eq(simOrders.positionId, p.id), eq(simOrders.closeAll, true), inArray(simOrders.status, PENDING)));
    }
    const verb = !order ? 'liquidated' : isIncrease ? (f.position ? 'increased' : 'opened') : after ? 'reduced' : 'closed';
    const title = `${p.side} ${p.symbol} ${verb}`;
    const detail = `${money(usdText(sizeDelta))} at ${priceText(result.executionPrice, dec)}, P&L ${money(microText(realized))}`;
    await event(tx, account.id, order ? 'fill' : 'liquidation', title, detail, { amountUsd: usdText(sizeDelta), symbol: p.symbol, ts: now });
    fx.notices.push({ kind: order ? 'fill' : 'risk', title, body: `${detail} (simulated)`, href: hrefOf(account) });

    if (!after) {
      await tx.update(simOrders).set({ status: 'canceled', statusDetail: 'Position closed', updatedAt: now })
        .where(and(eq(simOrders.positionId, p.id), inArray(simOrders.status, PENDING)));
      await recordRoundTrip(tx, p, now);
    }
  }

  async function recordRoundTrip(tx: Tx, p: PositionRow, closedAt: Date) {
    const fills = await tx.select().from(simFills).where(eq(simFills.positionId, p.id));
    let size = 0n, fees = 0n, net = 0n, exitSize = 0n, exitValue = 0n;
    for (const f of fills) {
      const delta = usd(f.sizeUsd);
      if (f.isIncrease) size += delta;
      else [exitSize, exitValue] = [exitSize + delta, exitValue + delta * usd(f.price)];
      fees += usd(f.feeUsd) + (micro(f.fundingUsd) + micro(f.borrowUsd)) * MICRO_PER_USD;
      net += micro(f.realizedPnl ?? '0');
    }
    await tx.insert(closedTrades).values({
      accountId: p.accountId, symbol: p.symbol, side: p.side, venue: 'simulated', openedAt: p.openedAt, closedAt,
      sizeUsd: usdText(size), entryPrice: p.entryPrice, exitPrice: formatFixed(exitSize ? exitValue / exitSize : 0n, 20, 18),
      feesUsd: usdText(fees), netPnl: microText(net),
    });
  }

  // ---------- rules ----------

  /**
   * One rules step for an account: liquidations, market-order expiry, then equity vs floor and target, near-limit,
   * the evaluation's result once it is decided and flat, and the equity snapshot.
   *
   * Every position's collateral comes out of the available margin and a GMTrade position can lose no more than its
   * collateral, so equity reaches the floor only when every open position is worth nothing, and GMTrade liquidates
   * those in the same step: "close everything possible" on a breach is those liquidations plus cancelling every
   * pending order. A position the model refuses to liquidate stays open and is retried every pass; the rest of the
   * step goes ahead.
   */
  async function applyRules(tx: Tx, accountId: string, fx: Effects, now = Date.now()): Promise<Valuation> {
    const load = async () => {
      const account = (await loadAccount(tx, accountId))!;
      const book = await loadBook(tx, accountId);
      return { account, book, marks: await markPositions(md, book.positions) };
    };
    let { account, book, marks } = await load();
    let dirty = false;
    for (const m of marks) {
      if (m.status?.liquidatable && fresh(m, now) && await liquidate(tx, account, fx, m as Required<Mark>)) dirty = true;
    }
    for (const o of book.orders.filter((x) => expired(x, now))) {
      await cancel(tx, o, 'Expired: GMTrade drops market orders not executed within 30 minutes');
      fx.unwatch.push(o);
      fx.changed = dirty = true;
    }
    if (dirty) ({ account, book, marks } = await load());
    let v = value(account, marks, book.orders, now);

    const status = decide(account, marks, v, now);
    if (status !== account.status) {
      await statusChange(tx, account, status, fx, v, new Date(now));
      ({ account, book, marks } = await load());
      v = value(account, marks, book.orders, now);
    }
    if (TERMINAL.has(account.status) && account.stage === 'evaluation' && book.positions.length === 0) await resolve(tx, account, fx, v);
    if (v.complete && (fx.filled || snapshotDue(accountId, marks, v, now))) {
      await tx.insert(equitySnapshots).values({
        accountId, ts: new Date(now), equity: microText(v.equity), realizedPnl: microText(v.realized), unrealizedPnl: microText(v.unrealized),
      }).onConflictDoNothing();
      fx.onCommit.push(() => lastSnapshot.set(accountId, now));
    }
    return v;
  }

  /** The status the account rules give: equity vs floor and target, near-limit; unchanged when the marks cannot decide. */
  function decide(account: AccountRow, marks: Mark[], v: Valuation, now: number): AccountRow['status'] {
    if (!TRADING.has(account.status) || !v.complete || !marks.every((m) => fresh(m, now))) return account.status;
    const size = micro(account.sizeUsd);
    const allowance = micro(account.lossAllowanceUsd);
    const target = account.profitTargetUsd === null ? null : micro(account.profitTargetUsd);
    if (v.equity <= size - allowance) return account.stage === 'evaluation' ? 'failed' : 'breached';
    if (target !== null && marks.length === 0 && v.realized >= target) return 'passed';
    if (target !== null && marks.length > 0 && v.realized + v.unrealized >= target) return 'checking';
    return (v.equity - size + allowance) * 4n < allowance ? 'near_limit' : 'active';
  }

  /**
   * Open positions get an equity snapshot every 5 min; a flat account's equity moves only on fills, which take one.
   * ponytail: after a restart every open account is due at once (one locked step each); stagger them if that burst matters.
   */
  const snapshotDue = (accountId: string, marks: Mark[], v: Valuation, now: number) =>
    v.complete && marks.length > 0 && now - (lastSnapshot.get(accountId) ?? 0) >= SNAPSHOT_MS;

  async function statusChange(tx: Tx, account: AccountRow, status: AccountRow['status'], fx: Effects, v: Valuation, now: Date) {
    const terminal = TERMINAL.has(status);
    await tx.update(accounts).set({ status, resolvedAt: terminal ? now : null, updatedAt: now }).where(eq(accounts.id, account.id));
    fx.changed = true;
    const href = hrefOf(account);
    const equity = money(microText(v.equity));
    if (status === 'failed' || status === 'breached') {
      await tx.update(simOrders).set({ status: 'canceled', statusDetail: 'The account reached its loss limit', updatedAt: now })
        .where(and(eq(simOrders.accountId, account.id), inArray(simOrders.status, PENDING)));
      const title = status === 'failed' ? 'Evaluation failed' : 'Practice account reached its loss limit';
      const body = `Equity ${equity} reached the ${money(microText(micro(account.sizeUsd) - micro(account.lossAllowanceUsd)))} floor`;
      await event(tx, account.id, 'risk', title, body, { ts: now });
      fx.notices.push({ kind: 'risk', title, body, href });
    } else if (status === 'passed') {
      await tx.update(simOrders).set({ status: 'canceled', statusDetail: 'Evaluation passed', updatedAt: now })
        .where(and(eq(simOrders.accountId, account.id), inArray(simOrders.status, PENDING)));
      const body = `Realized profit ${money(microText(v.realized))} reached the ${money(account.profitTargetUsd!)} target with every position closed`;
      await event(tx, account.id, 'account', 'Evaluation passed', body, { ts: now });
      fx.notices.push({ kind: 'account', title: 'Evaluation passed', body, href: '#/result' });
    } else if (status === 'checking') {
      await event(tx, account.id, 'account', 'Profit target reached', 'Close your positions to lock in the result', { ts: now });
    } else if (status === 'near_limit' && now.getTime() - (nearLimitNoticeAt.get(account.id) ?? 0) >= NEAR_LIMIT_NOTICE_MS) {
      fx.onCommit.push(() => nearLimitNoticeAt.set(account.id, now.getTime()));
      const body = `Equity ${equity}: less than a quarter of the loss allowance is left`;
      await event(tx, account.id, 'risk', 'Close to the loss limit', body, { ts: now });
      fx.notices.push({ kind: 'risk', title: 'Close to the loss limit', body, href });
    }
  }

  /** Writes the evaluation's result once it is decided and flat; the chain module records it onchain. */
  async function resolve(tx: Tx, account: AccountRow, fx: Effects, v: Valuation) {
    const fills = await tx.select().from(simFills).where(eq(simFills.accountId, account.id));
    const result: EvaluationResult = {
      evaluation: account.id, wallet: account.wallet, passed: account.status === 'passed',
      finalEquityUsd: microText(micro(account.sizeUsd) + v.realized), tradesRoot: tradesRoot(fills.map(toFill)),
      resolvedAt: (account.resolvedAt ?? new Date()).getTime(),
    };
    const [written] = await tx.insert(simResults).values({
      evaluation: result.evaluation, wallet: result.wallet, passed: result.passed, finalEquity: result.finalEquityUsd,
      tradesRoot: result.tradesRoot, resolvedAt: new Date(result.resolvedAt),
    }).onConflictDoNothing().returning({ evaluation: simResults.evaluation });
    if (written) fx.resolved.push(result);
  }

  async function emitUnrecorded() {
    const rows = await db.select().from(simResults).where(isNull(simResults.recordedSignature));
    for (const r of rows) {
      emit({ evaluation: r.evaluation, wallet: r.wallet, passed: r.passed, finalEquityUsd: trim(r.finalEquity), tradesRoot: r.tradesRoot, resolvedAt: r.resolvedAt.getTime() });
    }
  }

  async function markRecorded(evaluation: string, signature: string) {
    const [row] = await db.update(simResults).set({ recordedSignature: signature, recordedAt: new Date() })
      .where(and(eq(simResults.evaluation, evaluation), isNull(simResults.recordedSignature))).returning();
    if (!row) return;
    await db.insert(accountEvents).values({
      accountId: evaluation, type: 'account', title: 'Result recorded onchain', detail: row.passed ? 'Passed' : 'Failed',
      status: 'confirmed', simulated: false, signature, ts: new Date(),
    });
  }

  // ---------- leader ----------

  /**
   * The leader's pass: one read of the whole open book rebuilds `watched` and values every account with positions in
   * memory. Only an account a rule has work for (a liquidation, an expired market order, a status change, a due
   * snapshot) gets a locked rules step, which decides again on what it reads under the lock; the others get their live
   * valuation streamed. Accounts with nothing but resting orders cost nothing here.
   */
  async function rulesPass() {
    const now = Date.now();
    const added: OrderRow[] = [];
    rebuilding.add(added);
    const [positions, orders] = await Promise.all([
      db.select().from(simPositions).where(isNull(simPositions.closedAt)).orderBy(asc(simPositions.openedAt)),
      db.select().from(simOrders).where(inArray(simOrders.status, PENDING)).orderBy(asc(simOrders.createdAt)),
    ]).finally(() => rebuilding.delete(added));
    watched = new Map();
    for (const o of [...orders, ...added]) watch(o);

    const books = new Map<string, Book>();
    const bookOf = (id: string) => books.get(id) ?? books.set(id, { positions: [], orders: [] }).get(id)!;
    for (const p of positions) bookOf(p.accountId).positions.push(p);
    for (const o of orders) bookOf(o.accountId).orders.push(o);
    const active = [...books].filter(([, b]) => b.positions.length || b.orders.some((o) => expired(o, now))).map(([id]) => id);
    for (const account of await loadAccounts(db, active)) {
      const book = books.get(account.id)!;
      const marks = await markPositions(md, book.positions);
      const v = value(account, marks, book.orders, now);
      const due = marks.some((m) => m.status?.liquidatable && fresh(m, now)) || book.orders.some((o) => expired(o, now))
        || decide(account, marks, v, now) !== account.status || snapshotDue(account.id, marks, v, now);
      if (due) {
        await inAccount(account.id, async (tx, _account, fx) => {
          fx.valuation = await applyRules(tx, account.id, fx);
        }).catch((err: unknown) => log.error({ err, account: account.id }, 'sim: rules step failed'));
      } else {
        // Behind anything queued for the account, and only if no committed change was published after this read.
        void track(serial(account.id, async () => {
          if ((publishedAt.get(account.id) ?? 0) < now) publishValuation(account.wallet, account.id, v);
        }));
      }
    }
  }

  function onTick(tick: PriceTick) {
    const orders = leading && tick.session === 'open' ? watched.get(tick.symbol) : undefined;
    if (orders?.size) {
      track(fillOn(tick, [...orders.values()])).catch((err: unknown) => log.error({ err, symbol: tick.symbol }, 'sim: tick failed'));
    }
  }

  /** Locks only the accounts with an order this tick can execute; their fill step checks again under the lock. */
  async function fillOn(tick: PriceTick, orders: OrderRow[]) {
    const states = new Map<string, MarketState>();
    for (const token of new Set(orders.map((o) => o.marketToken))) states.set(token, await md.marketState(token));
    for (const accountId of new Set(orders.filter((o) => executable(o, tick, states.get(o.marketToken)!)).map((o) => o.accountId))) {
      inAccount(accountId, (tx, account, fx) => fillOrders(tx, account, fx, tick))
        .catch((err: unknown) => log.error({ err, account: accountId }, 'sim: fill step failed'));
    }
  }

  /** Leader term: fills on ticks and the rules loop until `lost` aborts. */
  async function lead(lost: AbortSignal) {
    leading = true;
    const off = md.onTick(onTick);
    let redeliveredAt = 0;
    try {
      while (!lost.aborted) {
        await track(rulesPass()).catch((err: unknown) => log.error({ err }, 'sim: rules pass failed'));
        // Results reach the chain module at least once: re-sent until markRecorded (it must be idempotent).
        if (Date.now() - redeliveredAt >= REDELIVER_MS) {
          await emitUnrecorded().catch((err: unknown) => log.error({ err }, 'sim: result redelivery failed'));
          redeliveredAt = Date.now();
        }
        await sleep(PASS_MS, undefined, { signal: lost }).catch(() => undefined);
      }
    } finally {
      off();
      leading = false;
      watched = new Map();
      await settled();
    }
  }

  async function settled() {
    while (inflight.size) await Promise.allSettled([...inflight]);
  }

  return {
    ensurePractice, owned, createEvaluation, resetPractice, placeOrder, cancelOrder, closePosition, setProtection, markRecorded,
    onResolved(listener: (r: EvaluationResult) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    lead, rulesPass, settled,
    get leading() {
      return leading;
    },
  };
}
