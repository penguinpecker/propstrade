// marketdata: the GMTrade market catalog, live prices, candles, recent trades and price-impact quotes
// (ARCHITECTURE.md §4.1). Routes under /v1; publishes batched 'price' and changed 'market' stream events.
import type { FastifyReply } from 'fastify';
import type {
  ApiError, Candle, CandleInterval, CandlesResponse, DataFreshness, Market, MarketCategory, MarketTrade, PriceImpactQuote, PriceTick,
} from '@props/shared';
import {
  DERIVED_FROM, INTERVAL_SECONDS, KeeperFeed, PUBLIC_RPC, USD_DECIMALS, USD_UNIT, aggregateCandles, bucketNext, bucketStart, decodeMarket,
  buildCatalog, fetchCandles, fetchCandlesBatch, fetchPairs, fetchTradeEvents, formatFixed, isMarketClosed, modelInput, parseFixed,
  priceString, priceTick, sessionOf, usdString, type FeedState, type KeeperMarket, type NativeInterval, type Pair, type PropsLimits,
} from '@props/gmtrade';
import { model } from '@props/gmsol-wasm';
import { fromMicro, orderFee, toUnitPrice } from '@props/sdk';
import { z } from 'zod';
import { parse } from '../../errors.ts';
import { orderFeeRateOf } from '../../lib/order-fee.ts';
import { adminAuth } from '../../routes/admin.ts';
import { plainRefusal, withPosition } from '../sim/model.ts';
import type { MarketDataService, MarketState, ModuleContext } from '../types.ts';
import { fetchAllowlist, type MarketConfigLimits } from './allowlist.ts';
import { covers, createHistoryStore, type CandleWindow } from './history.ts';
import { createPriceRecord, mergeCandles } from './record.ts';
import { createUpstreams, within, type UpstreamStatus } from './upstreams.ts';

/** Props defaults (ARCHITECTURE.md §1) until a market has an onchain MarketConfig. */
const DEFAULT_LIMITS: Record<MarketCategory, { maxLeverage: number; closedMaxLeverage: number | null }> = {
  Crypto: { maxLeverage: 25, closedMaxLeverage: null },
  Forex: { maxLeverage: 20, closedMaxLeverage: 8 },
  Commodities: { maxLeverage: 15, closedMaxLeverage: null },
  Stocks: { maxLeverage: 8, closedMaxLeverage: 8 },
};
const NOT_ENABLED_YET = 'Not yet enabled for funded trading';
const MICRO_TO_USD = 10n ** 14n; // USDC base units → GMTrade USD (1e20)
const NOT_ALLOWLISTED = 'Not available for funded trading';

const PRICE_FLUSH_MS = 100; // at most 10 'price' events per second, each carrying only the symbols whose price moved
const MAX_CANDLES = 2_000;
const TRADES_TTL_MS = 5_000;
// How long a request waits for GMTrade when there is nothing at all to show. The call keeps going and fills the cache.
const CANDLE_WAIT_MS = 4_000;
const TRADES_WAIT_MS = 5_000;
const MARKET_INFO_TIMEOUT_MS = 45_000; // a background refresh; the service has taken 20 s to answer
// The pre-warm refreshes every market's latest window of every interval at least this often (a copy under two minutes
// old answers 'live') and again this long after each bucket boundary, when the cache key rotates.
const PREWARM_EVERY_S = 60;
const PREWARM_AFTER_BOUNDARY_S = 2;
// The table's copy of a series' latest window only has to reach within two buckets of now at the next boot (the
// pre-warm then patches it, about 2 s after ready when GMTrade is quick): it is rewritten when the window's start
// rotates or this long after its last write, not by every pre-warm (that rewrote all 340 rows of ~30 KB every minute,
// measured 2026-09-25).
const LATEST_STORE_EVERY_MS = 5 * 60_000;
// Index tokens per full-window batch: 8 × 300 candles answer in 0.1-4 s depending on the span, 17 take 3 s and all 68
// time out (measured 2026-09-24); a 3-bucket patch for all 68 takes 0.1-0.3 s. Fill order: the app's default chart
// interval first (a fresh process gets its 24h change from one small request ahead of the fills), then 5m.
const PREWARM_CHUNK = 8;
const PREWARM_ORDER: NativeInterval[] = ['1h', '5m', '15m', '4h', '1D'];
// The history backfill (after the first pre-warm pass): every series is walked in turn and its newest missing page of
// PAGE_BARS settled bars (pages are aligned to multiples of their span, so a page never moves) is fetched and stored,
// until the series holds BACKFILL_BARS or reaches GMTrade's history start (an empty page, stored as the marker). One
// query at a time, only while GMTrade is idle and answering (no request fetch or pre-warm batch in flight, the candles
// source not down and its last answer under BACKFILL_MAX_LATENCY_MS), one every BACKFILL_EVERY_MS. Measured 2026-09-25:
// a 300-bar page answers in 0.1-0.3 s when GMTrade is idle, so the 68 markets' 1,972 pages take about 75 minutes;
// gated on 'ok' under 2 s, the walk stayed shut through GMTrade's slow spells all day (windowsStored 0), so the gate
// shuts only for the outages the walk cannot get through.
// ponytail: an empty page inside a closure (a stock's 5m page on a weekend) reads as that series' history start, as
// the app's own scroll does; derive the start from the 1D series if that ever matters.
const PAGE_BARS = 300;
const BACKFILL_BARS: Record<NativeInterval, number> = { '5m': 1_000, '15m': 1_000, '1h': 2_000, '4h': 2_000, '1D': 2_000 };
const BACKFILL_EVERY_MS = 2_000;
const BACKFILL_MAX_LATENCY_MS = 5_000;
// A copy the price record (the same live feed) completes through the bucket in progress is a current chart: 'live'
// while the copy is this old at most (the pre-warm refreshes it every minute whenever GMTrade answers), 'delayed' after.
const COPY_LIVE_MS = 10 * 60_000;
// Minute bars kept in memory per market: the price record's tail (record.ts writes a finished minute within a minute)
// and the minute in progress, so the 1m and 3m charts are current to the last tick.
const RECENT_MINUTES = 5;

/** What the service does while each outside source fails (reported by /v1/health). */
const FALLBACKS: Record<string, string> = {
  priceFeed: 'Prices are polled over HTTP while the live stream reconnects.',
  candles: "Charts use the last copy, completed from Props.trade's own price record.",
  trades: 'Recent trades show the last list fetched.',
  marketInfo: '24h volume keeps its last value.',
  solanaRpc: 'The funded-trading allowlist keeps its last value.',
  candleStore: 'Chart history is kept in memory only; windows fetched meanwhile are written once the database is back.',
};

/** GMTrade keeps revising a candle for seconds after its bucket closes: a window is settled once its last bucket
 *  closed more than a minute ago. */
export const settled = (end: number, res: number, nowSec: number) => end + res <= nowSec - 60;
/** A settled range is cached for an hour, any other for seconds. */
export const candleCacheTtl = (end: number, res: number, nowSec: number) => (settled(end, res, nowSec) ? 3_600_000 : 5_000);

/** The bucket-aligned window a request (or the pre-warm) asks GMTrade for, ending no later than the current bucket:
 *  `latest` when it is the default 300 bars up to now. Its cache key rotates at every bucket boundary. */
export function candleWindow(res: number, nowSec: number, from?: number, to?: number) {
  const nowBucket = Math.floor(nowSec / res) * res;
  const end = Math.min(Math.floor((to ?? nowBucket) / res) * res, nowBucket);
  const start = Math.floor((from ?? end - (300 - 1) * res) / res) * res;
  return { start, end, nowBucket, latest: from === undefined && end === nowBucket };
}
export const candleKey = (symbol: string, res: number, w: { start: number; end: number }) => `${symbol}:${res}:${w.start}:${w.end}`;

/** Same price and session: a tick that differs only by its timestamp changes nothing the app shows (staleness travels
 *  in the market rows), so it is not sent. */
const samePrice = (a: PriceTick, b: PriceTick) => a.min === b.min && a.max === b.max && a.session === b.session;

/** How far a figure the app shows must move, since the row was last sent, for the row to be sent again: the 24h change
 *  and the four hourly rates (funding and borrowing, each side) by their display precision (percent with 2 and 4
 *  decimals), a USD figure (volume, OI, capacity, pool liquidity, the largest new position per side) by 1 % (shown
 *  compact, "$1.2M", so a smaller move is rarely visible; the engine checks orders against the current figure). Every
 *  other field (session, freshness, tradable, leverage per side, min collateral, pools...) counts on any change; price
 *  and updatedAt travel in the ticks. Measured 2026-09-25: without this, OI, capacity and liquidity drift re-sent all
 *  68 rows every 5 s. */
const ROW_STEPS: Partial<Record<keyof Market, { abs: number } | { rel: number } | 'ignored'>> = {
  price: 'ignored', updatedAt: 'ignored',
  change24h: { abs: 0.01 },
  fundingRateHourlyLong: { abs: 0.0001 }, fundingRateHourlyShort: { abs: 0.0001 }, borrowRateHourlyLong: { abs: 0.0001 }, borrowRateHourlyShort: { abs: 0.0001 },
  volume24h: { rel: 0.01 }, openInterestLong: { rel: 0.01 }, openInterestShort: { rel: 0.01 },
  capacityLong: { rel: 0.01 }, capacityShort: { rel: 0.01 }, poolLiquidity: { rel: 0.01 },
  maxSizeLong: { rel: 0.01 }, maxSizeShort: { rel: 0.01 },
};

/** Whether the app would show `next` differently from `last`, the row it was last sent (see ROW_STEPS). */
export function changedForDisplay(last: Market, next: Market): boolean {
  for (const key of new Set([...Object.keys(last), ...Object.keys(next)]) as Set<keyof Market>) {
    const step = ROW_STEPS[key];
    if (step === 'ignored') continue;
    const [a, b] = [last[key], next[key]];
    if (!step) { if (JSON.stringify(a) !== JSON.stringify(b)) return true; continue; }
    if (a == null || b == null) { if (a !== b) return true; continue; }
    const [x, y] = [Number(a), Number(b)];
    if (x !== y && Math.abs(y - x) >= ('abs' in step ? step.abs : step.rel * Math.abs(x))) return true;
  }
  return false;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
const badRequest = (message: string) => new HttpError(400, 'bad_request', message);

function intParam(v: string | undefined, name: string): number | undefined {
  if (v === undefined || v === '') return undefined;
  if (!/^\d+$/.test(v)) throw badRequest(`${name} must be a non-negative integer`);
  return Number(v);
}

/** GMTrade's price feed and HTTP services, which marketdata.test.ts replaces with stubs. */
export interface MarketDataOptions {
  feed?: FeedState & Pick<KeeperFeed, 'onTick' | 'start' | 'stop'>;
  gm?: { fetchPairs?: typeof fetchPairs; fetchCandles?: typeof fetchCandles; fetchCandlesBatch?: typeof fetchCandlesBatch };
}

export async function createMarketData(ctx: ModuleContext, opts: MarketDataOptions = {}): Promise<MarketDataService> {
  const rpcUrl = ctx.env.RPC_URL || PUBLIC_RPC;
  const programId = ctx.env.PROGRAM_ID || undefined;
  const feed = opts.feed ?? new KeeperFeed({ rpcUrl, log: ctx.log });
  const gm = { fetchPairs, fetchCandles, fetchCandlesBatch, ...opts.gm };
  const timers: NodeJS.Timeout[] = [];
  const upstreams = createUpstreams(FALLBACKS, (name, s) => (s.state === 'down'
    ? ctx.log.warn({ upstream: name, since: s.since, error: s.lastError }, `marketdata: ${name} is down (${s.lastError}). ${s.fallback}`)
    : ctx.log.info({ upstream: name }, `marketdata: ${name} recovered`)));
  const record = createPriceRecord(ctx.sql);
  const history = createHistoryStore(ctx.sql, (call) => upstreams.track('candleStore', call));
  let lastTickAt = 0;

  let pairs = new Map<string, Pair>();
  let opens24h = new Map<string, number>();
  let allowlist = new Map<string, MarketConfigLimits>();
  let rows: Market[] = [];
  let builtAt = 0;
  let started = false;
  const bySymbol = new Map<string, Market>();
  const symbolByIndexToken = new Map<string, string>();
  /** The row each market was last sent as, and the tick each symbol was last sent in: only what moved past them
   *  goes out. */
  const published = new Map<string, Market>();
  const sentTicks = new Map<string, PriceTick>();
  const pendingTicks = new Map<string, PriceTick>();
  const tickListeners = new Set<(tick: PriceTick) => void>();
  /** Prices pinned by the test hook below (NODE_ENV=test on localnet only), by symbol. */
  const pinned = new Map<string, string>();
  const candleCache = new Map<string, { at: number; ttl: number; candles: Candle[] }>();
  const tradeCache = new Map<string, { at: number; trades: MarketTrade[] }>();
  /** The latest window GMTrade returned by symbol:resolution, with its cache key and when the table last got it: the
   *  copy a later window of the same series answers from at once, and what the pre-warm patches. */
  const lastGood = new Map<string, { at: number; storedAt: number; key: string; start: number; end: number; candles: Candle[] }>();
  /** When each resolution was last pre-warmed (unix seconds) and the bucket it saw then. */
  const warmed = new Map<number, { at: number; bucket: number }>();
  /** The pre-warm batch GMTrade is answering, if any: a request's own fetch queues behind it. */
  let filling: Promise<unknown> | null = null;
  const inflight = new Map<string, Promise<unknown>>();
  /** The backfill's query in flight, if any (a pre-warm batch waits behind it); whether the first pre-warm pass is
   *  over (it starts the backfill); the page in progress when each series was last found complete (revisited once it
   *  rotates), and the series the walk visits next; how many series the table restored at boot. */
  let backfilling: Promise<unknown> | null = null;
  let warmedOnce = false;
  const backfilled = new Map<string, number>();
  let backfillCursor = 0;
  let warmFromTable = 0;

  /** One upstream call per key at a time. It runs to the end even when no request waits for it any more. */
  function shared<T>(key: string, call: () => Promise<T>): Promise<T> {
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = call().finally(() => inflight.delete(key));
      p.catch(() => {}); // a failure nobody waits for is counted by upstreams
      inflight.set(key, p);
    }
    return p;
  }

  /** One pre-warm batch. GMTrade's candle service serializes requests, so it is sent once no request's own candle
   *  fetch is running (a batch ahead of one would hold that chart; a fresh process fills some 45) and exposed as
   *  `filling` while it runs, for the fetches that queue behind it. The pre-warm can wait: under constant misses, the
   *  requests keep the copies they ask for fresh themselves. */
  async function fillBatch(call: () => Promise<Map<string, Candle[]>>) {
    const running = () => [...inflight].flatMap(([key, p]) => (key.startsWith('candles:') ? [p] : [])).concat(backfilling ? [backfilling] : []);
    for (let busy = running(); busy.length; busy = running()) await Promise.allSettled(busy);
    const batch = upstreams.track('candles', call);
    filling = batch;
    try {
      return await batch;
    } finally {
      filling = null;
    }
  }

  function send(reply: FastifyReply, err: unknown) {
    if (!(err instanceof HttpError)) ctx.log.warn({ err }, 'marketdata upstream request failed');
    const e = err instanceof HttpError ? err : new HttpError(502, 'upstream_unavailable', 'Market data is unavailable right now');
    const body: ApiError = { error: { code: e.code, message: e.message } };
    return reply.code(e.status).headers(e.headers).send(body);
  }

  /** Caches a window GMTrade returned. The latest window of a series also becomes its copy, evicting the key it
   *  rotated from; a refresh that finished after the key rotated never replaces a newer copy. The copy (once it rotated,
   *  or LATEST_STORE_EVERY_MS after its last write) and every settled window with candles are written through to the
   *  table (only GMTrade's own answers reach here, never a fallback). A settled window GMTrade answered empty stays in
   *  memory only: stored, it would answer that range empty from every process for good, and the backfill would take it
   *  for the series' history start, while the answer may be a transient one (a backend hiccup lists no candles without
   *  an error). */
  function remember(symbol: string, res: number, w: ReturnType<typeof candleWindow>, list: Candle[], nowSec: number) {
    const key = candleKey(symbol, res, w);
    if (candleCache.size >= 1_000) candleCache.delete(candleCache.keys().next().value!);
    candleCache.set(key, { at: Date.now(), ttl: candleCacheTtl(w.end, res, nowSec), candles: list });
    const isSettled = settled(w.end, res, nowSec);
    const prev = lastGood.get(`${symbol}:${res}`);
    const copy = w.latest && !(prev && prev.end > w.end);
    const rewrite = copy && (!prev || prev.start !== w.start || Date.now() - prev.storedAt >= LATEST_STORE_EVERY_MS);
    if (copy) {
      if (prev && prev.key !== key) candleCache.delete(prev.key);
      lastGood.set(`${symbol}:${res}`, { at: Date.now(), storedAt: rewrite || !prev ? Date.now() : prev.storedAt, key, start: w.start, end: w.end, candles: list });
    }
    if (rewrite || (isSettled && list.length)) history.put({ symbol, res, start: w.start, end: w.end, candles: list, settled: isSettled, at: Date.now() });
  }

  const limits = ({ category, marketToken }: { category: MarketCategory; marketToken: string }): PropsLimits => {
    const defaults = DEFAULT_LIMITS[category];
    if (!programId) return { tradable: false, unavailableReason: NOT_ENABLED_YET, ...defaults };
    const config = allowlist.get(marketToken);
    if (!config?.enabled) return { tradable: false, unavailableReason: NOT_ALLOWLISTED, ...defaults };
    return {
      tradable: true,
      maxLeverage: config.maxLeverage,
      closedMaxLeverage: defaults.closedMaxLeverage === null ? null : config.closedMaxLeverage,
    };
  };

  function rebuild(): Market[] {
    rows = buildCatalog({
      feed, pairs, opens24h, limits, now: Date.now(),
      onError: (marketToken, err) => ctx.log.warn({ err, marketToken }, 'gmsol model rejected market state'),
    });
    builtAt = Date.now();
    bySymbol.clear();
    for (const row of rows) {
      bySymbol.set(row.symbol, row);
      const index = feed.markets.get(row.marketToken)?.meta?.indexToken.pubkey;
      if (index) symbolByIndexToken.set(index, row.symbol);
    }
    return rows;
  }

  const current = () => (Date.now() - builtAt > 1_000 ? rebuild() : rows);

  function publishChangedMarkets(): void {
    for (const market of rebuild()) {
      const last = published.get(market.symbol);
      if (last && !changedForDisplay(last, market)) continue;
      published.set(market.symbol, market);
      ctx.publish({ type: 'market', market });
    }
  }

  function preferredPool(symbol: string): { row: Market; pool: KeeperMarket } {
    if (!started) throw new HttpError(503, 'unavailable', 'market data is starting');
    const row = current().find((r) => r.symbol === symbol.toUpperCase());
    const pool = row && feed.markets.get(row.marketToken);
    if (!row || !pool) throw new HttpError(404, 'unknown_market', `unknown market ${symbol}`);
    return { row, pool };
  }

  function tickFor(symbol: string): PriceTick | undefined {
    const pool = feed.markets.get(bySymbol.get(symbol)?.marketToken ?? '');
    const token = pool?.meta && feed.tokens.get(pool.meta.indexToken.pubkey);
    if (!pool || !token) return undefined;
    const data = feed.accounts.get(pool.pubkey)?.data;
    const tick = priceTick(symbol, token, sessionOf(token.price, data ? isMarketClosed(data) : false));
    const price = pinned.get(symbol);
    return tick && price ? { ...tick, min: price, max: price, mid: price, ts: Date.now() } : tick;
  }

  /** The last RECENT_MINUTES minutes of every market as one-minute bars, built from the ticks as record.ts builds the
   *  rows it writes: what the 1m and 3m charts read over the table. */
  const recentMinutes = new Map<string, Candle[]>();

  function emitTick(tick: PriceTick) {
    lastTickAt = Date.now();
    record.add(tick);
    pendingTicks.set(tick.symbol, tick);
    for (const fn of tickListeners) fn(tick);
    const price = Number(tick.mid);
    if (!(price > 0) || !Number.isFinite(price)) return;
    const time = Math.floor(tick.ts / 60_000) * 60;
    const list = recentMinutes.get(tick.symbol) ?? [];
    const bar = list.at(-1);
    if (bar && time < bar.time) return; // an older tick
    if (bar && time === bar.time) {
      bar.high = Math.max(bar.high, price);
      bar.low = Math.min(bar.low, price);
      bar.close = price;
      return;
    }
    list.push({ time, open: price, high: price, low: price, close: price });
    if (list.length > RECENT_MINUTES) list.shift();
    recentMinutes.set(tick.symbol, list);
  }

  async function refreshPairs() {
    pairs = new Map((await upstreams.track('marketInfo', () => gm.fetchPairs(undefined, MARKET_INFO_TIMEOUT_MS))).map((p) => [p.pool_id, p]));
  }

  /** Every market's index token by symbol: the series the pre-warm keeps (each has a chart, tradable or not). */
  const indexTokens = () => new Map(current().flatMap((row) => {
    const token = feed.markets.get(row.marketToken)?.meta?.indexToken.pubkey;
    return token ? [[row.symbol, token] as const] : [];
  }));

  /** Price 24 h ago: close of the last 5-minute candle completed by then, or, for markets that were closed at the
   *  time, of the last hourly candle before. Read from the pre-warmed copies (the hourly one spans 12 days, so it
   *  covers weekends), else kept from the last refresh (a failed fill leaves markets without a copy); markets without
   *  a copy yet come from one small request when `fetchMissing`. */
  async function refreshOpens24h(fetchMissing: boolean) {
    const t = Math.floor(Date.now() / 1000) - 86_400;
    const closeBefore = (list: Candle[] | undefined, res: number) => list?.filter((c) => c.time + res <= t).at(-1)?.close;
    const next = new Map<string, number>();
    const missing: string[] = [];
    for (const [symbol, token] of indexTokens()) {
      const copy = lastGood.get(`${symbol}:300`)?.candles;
      if (!copy) missing.push(token);
      const fromCopies = copy && (closeBefore(copy, 300) ?? closeBefore(lastGood.get(`${symbol}:3600`)?.candles, 3_600));
      const close = fromCopies ?? opens24h.get(token);
      if (close !== undefined) next.set(token, close);
    }
    if (fetchMissing && missing.length) {
      const recent = await upstreams.track('candles', () => gm.fetchCandlesBatch(missing, 300, t - 3_600, t));
      const closed = missing.filter((k) => {
        const close = closeBefore(recent.get(k), 300);
        if (close !== undefined) next.set(k, close);
        return close === undefined;
      });
      if (closed.length) {
        const older = await upstreams.track('candles', () => gm.fetchCandlesBatch(closed, 3_600, t - 4 * 86_400, t));
        for (const k of closed) {
          const close = closeBefore(older.get(k), 3_600);
          if (close !== undefined) next.set(k, close);
        }
      }
    }
    opens24h = next;
  }

  /** Fills every market's latest `res` window: the whole window, in batches of a few tokens, for the series without a
   *  usable copy (a fresh process, or after an outage); one batch of only the last three buckets (GMTrade still
   *  revises a candle for a minute after its bucket closes) for the rest, spliced into their copies. A series the
   *  batch left out keeps its own candles, or stays without a copy for a request to fetch. */
  async function warm(res: number, nowSec: number) {
    const w = candleWindow(res, nowSec);
    const patchFrom = w.end - 2 * res;
    const full: [string, string][] = [];
    const patch: [string, string][] = [];
    for (const [symbol, token] of indexTokens()) {
      const copy = lastGood.get(`${symbol}:${res}`);
      (copy && copy.start <= w.start && copy.end >= patchFrom ? patch : full).push([symbol, token]);
    }
    for (let i = 0; i < full.length; i += PREWARM_CHUNK) {
      const chunk = full.slice(i, i + PREWARM_CHUNK);
      const got = await fillBatch(() => gm.fetchCandlesBatch(chunk.map(([, token]) => token), res, w.start, w.end));
      for (const [symbol, token] of chunk) {
        const list = got.get(token);
        if (list) remember(symbol, res, w, list, nowSec);
      }
    }
    if (patch.length) {
      const got = await fillBatch(() => gm.fetchCandlesBatch(patch.map(([, token]) => token), res, patchFrom, w.end));
      for (const [symbol, token] of patch) {
        const fresh = got.get(token);
        const kept = lastGood.get(`${symbol}:${res}`)!.candles.filter((c) => c.time >= w.start && (!fresh || c.time < patchFrom));
        remember(symbol, res, w, fresh ? kept.concat(fresh) : kept, nowSec);
      }
    }
  }

  /** Keeps every interval's latest window warm for every market, one resolution after another (GMTrade's candle
   *  service serializes requests): each again about 2 s after its bucket boundary, when the key rotates, and at least
   *  every minute. A failed run counts as a run (health records it); the copies stay, completed from the price
   *  record by requests, until the next. The 24h change follows the copies; a fresh process gets it from one small
   *  request ahead of the fills (so the app's default interval fills first), which take a minute when GMTrade is
   *  slow. */
  async function prewarm() {
    const nowSec = Math.floor(Date.now() / 1000);
    let first = true;
    for (const interval of PREWARM_ORDER) {
      const res = INTERVAL_SECONDS[interval];
      const bucket = Math.floor((nowSec - PREWARM_AFTER_BOUNDARY_S) / res) * res;
      const last = warmed.get(res);
      if (last && nowSec - last.at < PREWARM_EVERY_S && last.bucket === bucket) continue;
      warmed.set(res, { at: nowSec, bucket });
      if (first && !opens24h.size) await refreshOpens24h(true).catch(() => {});
      first = false;
      await warm(res, nowSec).catch(() => {});
      await refreshOpens24h(false);
    }
    warmedOnce = true;
  }

  /** Every market's index token by symbol × interval, the order the backfill walks. */
  const allSeries = () => [...indexTokens()].flatMap(([symbol, token]) => PREWARM_ORDER.map((interval) => ({ symbol, token, interval })));

  /** One backfill visit (see BACKFILL_BARS): the next series whose completeness is unknown, or known from an earlier
   *  page, gets its newest missing page fetched and stored. The table is re-read on every visit, so a restart resumes
   *  where the last process stopped and a page fetched for a request is never fetched again. */
  async function backfill() {
    if (!warmedOnce || filling || [...inflight.keys()].some((key) => key.startsWith('candles:'))) return;
    const source = upstreams.status('candles');
    if (source.state === 'down' || (source.latencyMs ?? Infinity) >= BACKFILL_MAX_LATENCY_MS) return;
    const series = allSeries();
    const nowSec = Math.floor(Date.now() / 1000);
    const pageOf = (res: number) => Math.floor(nowSec / (PAGE_BARS * res)); // the page in progress: the series' latest window covers it
    let pick: (typeof series)[number] | undefined;
    for (let i = 0; i < series.length && !pick; i++) {
      const s = series[backfillCursor]!;
      backfillCursor = (backfillCursor + 1) % series.length;
      if (backfilled.get(`${s.symbol}:${INTERVAL_SECONDS[s.interval]}`) !== pageOf(INTERVAL_SECONDS[s.interval])) pick = s;
    }
    if (!pick) return;
    const { symbol, token, interval } = pick;
    const res = INTERVAL_SECONDS[interval];
    const span = PAGE_BARS * res;
    const current = pageOf(res);
    const coverage = await history.coverage(symbol, res).catch(() => null);
    if (!coverage) return; // the database is unreachable: the store logged the outage once; the next visit asks again
    const { ranges, historyEnd: firstHistoryEnd } = coverage;
    if (filling || [...inflight.keys()].some((key) => key.startsWith('candles:'))) return; // a fetch began meanwhile
    let historyEnd = firstHistoryEnd;
    /** The newest page not stored; 'done' when they all are back to BACKFILL_BARS or the next lies before GMTrade's
     *  history start, 'wait' when it has not settled yet. */
    const next = (): { start: number; end: number } | 'done' | 'wait' => {
      for (let k = 1; k <= Math.ceil(BACKFILL_BARS[interval] / PAGE_BARS); k++) {
        const start = (current - k) * span;
        const end = start + (PAGE_BARS - 1) * res;
        if (covers(ranges, start, end, res)) continue;
        if (end <= historyEnd) return 'done';
        return settled(end, res, nowSec) ? { start, end } : 'wait';
      }
      return 'done';
    };
    const page = next();
    if (typeof page === 'string') {
      if (page === 'done') backfilled.set(`${symbol}:${res}`, current);
      return;
    }
    const fetching = upstreams.track('candles', () => gm.fetchCandles(token, res, page.start, page.end));
    backfilling = fetching;
    let list: Candle[];
    try {
      list = await fetching;
    } finally {
      backfilling = null;
    }
    history.put({ symbol, res, start: page.start, end: page.end, candles: list, settled: true, at: Date.now() });
    if (!(await history.flush())) return; // not stored: the next visit fetches it again
    ranges.push(page);
    if (!list.length) historyEnd = Math.max(historyEnd, page.end);
    if (next() !== 'done') return;
    backfilled.set(`${symbol}:${res}`, current);
    ctx.log.info({ symbol, interval, windows: ranges.length, historyStart: !list.length }, `marketdata: ${symbol} ${interval} history backfilled`);
  }

  async function refreshAllowlist() {
    const tokens = [...feed.markets.values()].flatMap((m) => (m.meta?.isPure ? [m.marketToken] : []));
    allowlist = await upstreams.track('solanaRpc', () => fetchAllowlist(rpcUrl, programId!, tokens));
  }

  /** Runs `fn` every `ms`, never two at once; a failed run is retried up to `attempts` times with backoff. */
  function every(ms: number, what: string, fn: () => unknown, attempts = 1) {
    let running = false;
    const t = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        for (let attempt = 1; ; attempt++) {
          try {
            await fn();
            break;
          } catch (err) {
            if (attempt >= attempts || ctx.signal.aborted) throw err;
            await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt * (0.5 + Math.random() / 2)));
          }
        }
      } catch (err) {
        ctx.log.warn({ err }, `marketdata: ${what} refresh failed`);
      } finally {
        running = false;
      }
    }, ms);
    t.unref();
    timers.push(t);
  }

  feed.onTick((token) => {
    const symbol = symbolByIndexToken.get(token.pubkey);
    const tick = symbol && tickFor(symbol);
    if (tick) emitTick(tick);
  });

  const ready = (async () => {
    // Every series' latest window from the table, read while the snapshot loads: the copies a restart would have lost.
    const restoring = history.latest().catch((err) => (ctx.log.warn({ err }, 'marketdata: candle history could not be read'), [] as CandleWindow[]));
    for (let attempt = 0; ; attempt++) {
      try {
        await feed.start();
        break;
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log.warn({ err, attempt }, 'marketdata: GMTrade snapshot failed; retrying');
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** attempt)));
      }
    }
    if (ctx.signal.aborted) return feed.stop();
    started = true;
    // Ready once prices flow: volume fills in when GMTrade's market-info answers (it can take many seconds, or fail),
    // 24h change and warm charts with the pre-warm, and nothing waits for them. The allowlist, which decides what can
    // be traded, is read first.
    const initialFailed = (err: unknown) => ctx.log.warn({ err }, 'marketdata: initial refresh failed');
    void refreshPairs().then(publishChangedMarkets, initialFailed);
    if (programId) await refreshAllowlist().catch(initialFailed);
    publishChangedMarkets();
    every(PRICE_FLUSH_MS, 'price publish', () => {
      if (!pendingTicks.size) return;
      const ticks = [...pendingTicks.values()].filter((tick) => {
        const last = sentTicks.get(tick.symbol);
        return !last || !samePrice(last, tick);
      });
      pendingTicks.clear();
      if (!ticks.length) return;
      for (const tick of ticks) sentTicks.set(tick.symbol, tick);
      ctx.publish({ type: 'price', ticks });
    });
    every(5_000, 'market publish', publishChangedMarkets);
    every(60_000, 'market-info', refreshPairs, 3);
    // The restored copies are in place before the pre-warm runs, so it only patches them and a restart costs nothing. A
    // request served meanwhile (the allowlist read above is a round trip) may have fetched a fresher copy: that one stays.
    for (const w of await restoring) {
      if ((lastGood.get(`${w.symbol}:${w.res}`)?.at ?? 0) < w.at) {
        lastGood.set(`${w.symbol}:${w.res}`, { at: w.at, storedAt: w.at, key: candleKey(w.symbol, w.res, w), start: w.start, end: w.end, candles: w.candles });
      }
      warmFromTable += 1;
    }
    every(1_000, 'candle pre-warm', prewarm);
    every(1_000, 'candle history', history.flush);
    every(BACKFILL_EVERY_MS, 'candle backfill', backfill);
    if (programId) every(60_000, 'allowlist', refreshAllowlist, 3);
    every(60_000, 'price record', record.flush);
  })();
  ready.catch((err) => ctx.log.error({ err }, 'marketdata failed to start'));

  ctx.signal.addEventListener('abort', () => {
    feed.stop();
    for (const t of timers) clearInterval(t);
  });

  /** A derived interval (DERIVED_FROM), rolled up through this same path. Its latest window comes from the source's
   *  latest window (the warm copy: no GMTrade call); an older one from the source windows it spans, the table else
   *  GMTrade, in one source request of at most MAX_CANDLES bars: a longer window answers its newest part, and the
   *  chart's loader continues from the oldest bar it got. 1m and 3m read the price record's minutes, the last few from
   *  memory (the table is written once a minute); their history starts with the record (2026-09-23), so an older window
   *  answers empty as GMTrade's history start does. The aggregate is cached under the derived interval as a native
   *  window is, a record one for seconds only (its tail may still be unwritten after a database outage). */
  async function derived(symbol: string, interval: CandleInterval, source: NativeInterval | 'record', from?: number, to?: number): Promise<CandlesResponse> {
    const res = INTERVAL_SECONDS[interval];
    const { row } = preferredPool(symbol);
    const nowSec = Math.floor(Date.now() / 1000);
    const nowBucket = bucketStart(interval, nowSec);
    const end = Math.min(bucketStart(interval, to ?? nowSec), nowBucket);
    let start = bucketStart(interval, from ?? end - (300 - 1) * res);
    if (start > end) throw badRequest('from must not be after to');
    if ((end - start) / res + 1 > MAX_CANDLES) throw badRequest(`at most ${MAX_CANDLES} candles per request`);
    const srcRes = source === 'record' ? 60 : INTERVAL_SECONDS[source];
    const srcWindow = source !== 'record' && from === undefined && end === nowBucket ? candleWindow(srcRes, nowSec) : null;
    const srcEnd = Math.min(bucketNext(interval, end) - srcRes, Math.floor(nowSec / srcRes) * srcRes);
    if (srcWindow) {
      start = bucketStart(interval, srcWindow.start);
    } else if (source !== 'record') {
      const capStart = srcEnd - (MAX_CANDLES - 1) * srcRes;
      if (start < capStart) start = bucketStart(interval, capStart) === capStart ? capStart : bucketNext(interval, capStart);
    }
    const key = candleKey(row.symbol, res, { start, end });
    const cached = candleCache.get(key);
    const base = { symbol: row.symbol, interval, source: source === 'record' ? 'record' as const : 'venue' as const };
    if (cached && Date.now() - cached.at < cached.ttl) return { ...base, candles: cached.candles, freshness: 'live' };
    let list: Candle[];
    let freshness: DataFreshness = 'live';
    if (source === 'record') {
      const minutes = await record.candles(row.symbol, 60, start, srcEnd).catch(() => null);
      if (!minutes) throw new HttpError(503, 'unavailable', 'the price record is unavailable right now', { 'retry-after': '5' });
      const byTime = new Map(minutes.map((c) => [c.time, c]));
      for (const m of recentMinutes.get(row.symbol) ?? []) if (m.time >= start && m.time <= srcEnd) byTime.set(m.time, { ...m });
      list = aggregateCandles([...byTime.values()].sort((a, b) => a.time - b.time), interval, start);
    } else {
      const r = srcWindow ? await candles(row.symbol, source) : await candles(row.symbol, source, start, srcEnd);
      list = aggregateCandles(r.candles.filter((c) => c.time >= start), interval, srcWindow ? srcWindow.start : start);
      freshness = r.freshness;
    }
    if (freshness === 'live') {
      const ttl = source !== 'record' && bucketNext(interval, end) <= nowSec - 60 ? 3_600_000 : 5_000;
      candleCache.set(key, { at: Date.now(), ttl, candles: list });
    }
    return { ...base, candles: list, freshness };
  }

  async function candles(symbol: string, interval: CandleInterval, from?: number, to?: number): Promise<CandlesResponse> {
    const res = Object.hasOwn(INTERVAL_SECONDS, interval) ? INTERVAL_SECONDS[interval] : undefined;
    if (!res) throw badRequest(`interval must be one of ${Object.keys(INTERVAL_SECONDS).join(', ')}`);
    const source = DERIVED_FROM[interval];
    if (source) return derived(symbol, interval, source, from, to);
    const { row, pool } = preferredPool(symbol);
    const nowSec = Math.floor(Date.now() / 1000);
    const w = candleWindow(res, nowSec, from, to);
    if (w.start > w.end) throw badRequest('from must not be after to');
    if ((w.end - w.start) / res + 1 > MAX_CANDLES) throw badRequest(`at most ${MAX_CANDLES} candles per request`);
    const key = candleKey(row.symbol, res, w);
    const cached = candleCache.get(key);
    const base = { symbol: row.symbol, interval, source: 'venue' as const };
    if (cached && Date.now() - cached.at < cached.ttl) return { ...base, candles: cached.candles, freshness: 'live' };
    // A copy answers at once: this window's expired entry or the series' latest window (the bucket before this one,
    // when the key has just rotated), whichever GMTrade returned last. It is 'live' for a settled window it reaches
    // the end of (final candles) and, under two minutes old and ending at the current or previous bucket, for the
    // latest one (live ticks move its last candle in the app); otherwise the price record completes it: 'live' when
    // that reaches the bucket in progress and the copy is under COPY_LIVE_MS old, 'delayed' else.
    const isSettled = settled(w.end, res, nowSec);
    const latest = lastGood.get(`${row.symbol}:${res}`);
    const copy = latest && latest.start <= w.start && (!cached || latest.at > cached.at)
      ? { at: latest.at, end: latest.end, candles: latest.candles.filter((c) => c.time >= w.start && c.time <= w.end) }
      : cached && { at: cached.at, end: w.end, candles: cached.candles };
    const fromCopy = copy && ((isSettled && copy.end >= w.end) || (copy.end >= w.nowBucket - res && Date.now() - copy.at < 120_000));
    // A copy reaching the window's end answers without a refresh: final candles for a settled window, and for the latest
    // one the pre-warm patches the copy every minute (after a restart, the table's copies answer without one call).
    if (fromCopy && copy.end >= w.end) return { ...base, candles: copy.candles, freshness: 'live' };
    // A settled window the table covers (stored pages, windows fetched before) is final too: no GMTrade call.
    if (isSettled) {
      const stored = await history.covering(row.symbol, res, w.start, w.end, latest).catch(() => null);
      if (stored) {
        candleCache.set(key, { at: Date.now(), ttl: candleCacheTtl(w.end, res, nowSec), candles: stored });
        return { ...base, candles: stored, freshness: 'live' };
      }
    }
    // One refresh of this exact window runs in the background whatever answers below; it caches (and, settled, stores)
    // only when it succeeds.
    const refresh = () => shared(`candles:${key}`, () => upstreams.track('candles', () => gm.fetchCandles(pool.meta!.indexToken.pubkey, res, w.start, w.end))
      .then((list) => (remember(row.symbol, res, w, list, nowSec), list)));
    if (fromCopy) {
      refresh();
      return { ...base, candles: copy.candles, freshness: 'live' }; // a bucket short: the refresh fills the rotated key
    }
    const recorded = await record.candles(row.symbol, res, w.start, w.end).catch(() => []);
    const list = mergeCandles(copy?.candles ?? [], recorded);
    if (list.length) {
      refresh();
      const current = copy !== undefined && list.at(-1)!.time === w.nowBucket && Date.now() - copy.at < COPY_LIVE_MS;
      return { ...base, candles: list, freshness: current ? 'live' : 'delayed' };
    }
    // Nothing to show at all (a window nobody asked for before, on a fresh process): wait for GMTrade, briefly. A
    // latest window waits first for the pre-warm batch GMTrade is answering, if any (it fills this series, and this
    // fetch queues behind it); a settled window only for its own fetch, and not at all while GMTrade is down (queued
    // behind the batch, a history scroll took 14-15 s to its 503 during an outage, measured 2026-09-25).
    const unavailable = () => new HttpError(503, 'unavailable', 'Candles are unavailable right now', { 'retry-after': '5' });
    if (!w.latest && upstreams.status('candles').state === 'down') throw unavailable();
    const fetching = refresh();
    try {
      if (filling && w.latest) await Promise.race([filling, fetching]).catch(() => {});
      return { ...base, candles: await within(fetching, CANDLE_WAIT_MS), freshness: 'live' };
    } catch {
      throw unavailable();
    }
  }

  async function trades(symbol: string, limit = 50): Promise<MarketTrade[]> {
    if (limit < 1 || limit > 200) throw badRequest('limit must be 1..200');
    const { row, pool } = preferredPool(symbol);
    const key = `${row.symbol}:${limit}`;
    const cached = tradeCache.get(key);
    if (cached && Date.now() - cached.at < TRADES_TTL_MS) return cached.trades;
    const meta = feed.tokens.get(pool.meta!.indexToken.pubkey)?.meta;
    if (!meta) throw new HttpError(503, 'unavailable', `no token metadata for ${row.symbol}`);
    const fetching = shared(`trades:${key}`, async () => {
      const events = await upstreams.track('trades', () => fetchTradeEvents({ marketTokens: row.pools.map((p) => p.marketToken) }, limit));
      const list = events.flatMap((e): MarketTrade[] => {
        const delta = e.after.sizeInUsd - e.before.sizeInUsd;
        if (delta === 0n) return []; // collateral-only change, not a trade
        return [{
          id: e.id, symbol: row.symbol, side: e.isLong ? 'Long' : 'Short', isIncrease: e.isIncrease,
          price: priceString(e.executionPrice, meta.decimals, meta.precision),
          sizeUsd: usdString(delta < 0n ? -delta : delta), ts: e.ts,
        }];
      });
      tradeCache.set(key, { at: Date.now(), trades: list });
      return list;
    });
    if (cached) return cached.trades; // refreshed in the background
    return within(fetching, TRADES_WAIT_MS);
  }

  /** Each outside source's state, for /v1/health; the candles source also carries the chart history's state. */
  function health(): Record<string, UpstreamStatus> {
    const silentMs = Date.now() - lastTickAt;
    const priceFeed: UpstreamStatus = {
      state: !lastTickAt ? 'checking' : silentMs > 60_000 ? 'down' : feed.mode === 'poll' ? 'degraded' : 'ok',
      since: null, lastOkAt: lastTickAt || null, latencyMs: null, fallback: FALLBACKS.priceFeed!,
      lastError: !lastTickAt ? 'no price received yet' : silentMs > 60_000 ? `no price for ${Math.round(silentMs / 1000)} s`
        : feed.mode === 'poll' ? 'live stream reconnecting' : null,
    };
    const candles: UpstreamStatus = {
      ...upstreams.status('candles'),
      history: { seriesWarmAtBoot: warmFromTable, backfill: { seriesDone: backfilled.size, seriesTotal: started ? allSeries().length : 0, windowsStored: history.stored() } },
    };
    return { priceFeed, ...upstreams.report(), candles };
  }

  /**
   * The order ticket's cost preview (api.ts PriceImpactQuote): GMTrade's open fee and impact from one simulateIncrease
   * on the pool as it is (the account's own position is not in it, as at a fresh open), then the resulting position
   * valued as the positions table will value it once filled — in the pool (sim/model.ts withPosition, pure pools),
   * which gives the close fee and the liquidation price from the same positionStatus the book runs. Two model calls,
   * both in-process: cheap enough for a debounced quote on every keystroke. Props.trade's fee is the current rate on the
   * order's size (@props/sdk orderFee, as the program assesses a funded open and the simulator a practice one).
   */
  async function quote(symbol: string, side: 'Long' | 'Short', sizeUsd: string, collateralUsd?: string, limitPrice?: string): Promise<PriceImpactQuote> {
    const decimal = (v: string, name: string, decimals: number) => {
      try {
        return parseFixed(v, decimals);
      } catch {
        throw badRequest(`${name} must be a decimal number`);
      }
    };
    const size = decimal(sizeUsd, 'sizeUsd', USD_DECIMALS);
    if (size <= 0n || size > 100_000_000n * USD_UNIT) throw badRequest('sizeUsd must be between 0 and 100,000,000');
    const { row, pool } = preferredPool(symbol);
    const live = modelInput(feed, pool);
    const meta = feed.tokens.get(pool.meta!.indexToken.pubkey)?.meta;
    if (!live || !meta) throw new HttpError(503, 'unavailable', `no live state for ${row.symbol} yet`);
    // Collateral in the pool's short token (USDC for every preferred pool): the ticket's margin, else one worth the
    // full size (fees and impact do not depend on leverage, and 1x never trips the min-collateral checks).
    const collateral = collateralUsd === undefined ? null : decimal(collateralUsd, 'collateralUsd', 6);
    if (collateral !== null && collateral <= 0n) throw badRequest('collateralUsd must be above zero');
    // A limit order is priced at its limit price, as the engine executes it (the model then takes min = max = limit).
    let input = live;
    if (limitPrice !== undefined) {
      let limit: bigint;
      try {
        limit = toUnitPrice(limitPrice, meta.decimals);
      } catch {
        throw badRequest('limitPrice must be a decimal price');
      }
      if (limit <= 0n) throw badRequest('limitPrice must be above zero');
      input = { ...live, prices: { ...live.prices, index: { min: limit, max: limit } } };
    }
    const collateralAmount = collateral ?? size / input.prices.short.min + 1n;
    let result;
    try {
      result = model.simulateIncrease({
        market: input, isLong: side === 'Long', collateralToken: pool.meta!.shortToken.pubkey, collateralAmount, sizeDeltaUsd: size,
      });
    } catch (err) {
      // In the engine's words for the same refusal, so the ticket can say why before the order is sent.
      throw new HttpError(422, 'rejected_by_venue', plainRefusal(err, row, side, size, collateralAmount) ?? `The exchange would reject this order: ${(err as Error).message}`);
    }
    // The position's status in the pool it would then be part of; null when the model cannot value it there (the
    // conservative fee factor stands in for the close fee: negative-impact, the larger of the two).
    let status: ReturnType<typeof model.positionStatus> | null = null;
    try {
      status = model.positionStatus({ ...input, market: pool.meta!.isPure ? withPosition(input.market, result.position.account) : input.market }, result.position.account);
    } catch (err) {
      ctx.log.warn({ err, symbol: row.symbol }, 'marketdata: the quote could not value the resulting position');
    }
    const closeFee = status ? status.closeOrderFeeValue : (size * decodeMarket(input.market).config.order_fee_factor_for_negative_impact) / USD_UNIT;
    // The resulting position is this order's size, so its close costs the same Props fee as its open.
    const platformFee = orderFee(await orderFeeRateOf(ctx), size);
    const [fundingRate, borrowRate] = side === 'Long' ? [row.fundingRateHourlyLong, row.borrowRateHourlyLong] : [row.fundingRateHourlyShort, row.borrowRateHourlyShort];
    // Received funding (a negative rate) is never credited here (claimables are not counted), so it costs nothing.
    const hourlyPct = fundingRate === null || borrowRate === null ? null : Math.max(fundingRate, 0) + borrowRate;
    return {
      symbol: row.symbol, side, sizeUsd: formatFixed(size, USD_DECIMALS, 6), orderValueUsd: formatFixed(size, USD_DECIMALS, 6),
      collateralUsd: collateral === null ? null : formatFixed(collateral, 6, 6),
      priceImpactPct: (Number(result.priceImpactValue) / Number(size)) * 100,
      openFeeUsd: usdString(result.fees.orderFeeValue), closeFeeUsd: usdString(closeFee),
      roundTripFeeUsd: usdString(result.fees.orderFeeValue + closeFee + 2n * platformFee * MICRO_TO_USD),
      executionPrice: priceString(result.executionPrice, meta.decimals, meta.precision),
      fundingRateHourlyPct: fundingRate, borrowRateHourlyPct: borrowRate,
      hourlyCostUsd: hourlyPct === null ? null : usdString((size * BigInt(Math.round(hourlyPct * 1e12))) / (100n * 10n ** 12n)),
      liquidationPrice: status?.liquidationPrice == null ? null : priceString(status.liquidationPrice, meta.decimals, meta.precision),
      platformFeeUsd: fromMicro(platformFee), maxFeeMicro: platformFee.toString(), platformCloseFeeUsd: fromMicro(platformFee),
      maxSizeUsd: side === 'Long' ? row.maxSizeLong : row.maxSizeShort,
      maxLeverage: side === 'Long' ? row.maxLeverageLong : row.maxLeverageShort,
    };
  }

  async function marketState(marketToken: string): Promise<MarketState> {
    await ready;
    const pool = feed.markets.get(marketToken);
    const input = pool && modelInput(feed, pool);
    const account = pool && feed.accounts.get(pool.pubkey);
    const indexDecimals = pool?.meta ? feed.tokens.get(pool.meta.indexToken.pubkey)?.meta?.decimals : undefined;
    if (!pool?.meta || !input || !account || indexDecimals === undefined) throw new Error(`no onchain state for market ${marketToken}`);
    const index = pool.meta.indexToken.pubkey;
    return {
      symbol: symbolByIndexToken.get(index) ?? feed.tokens.get(index)?.meta?.name ?? index,
      marketToken,
      indexToken: index,
      pure: pool.meta.isPure,
      isClosed: isMarketClosed(account.data),
      raw: { market: input.market, virtualInventories: input.virtualInventories, slot: account.slot },
      prices: input.prices,
      indexDecimals,
      fetchedAt: Date.now(),
    };
  }

  const app = ctx.app;
  app.get('/v1/markets', async (_req, reply) => (started ? current() : send(reply, new HttpError(503, 'unavailable', 'market data is starting'))));
  app.get<{ Params: { symbol: string } }>('/v1/markets/:symbol', async (req, reply) => {
    try {
      return preferredPool(req.params.symbol).row;
    } catch (err) {
      return send(reply, err);
    }
  });
  app.get<{ Params: { symbol: string }; Querystring: { limit?: string } }>('/v1/markets/:symbol/trades', async (req, reply) => {
    try {
      return await trades(req.params.symbol, intParam(req.query.limit, 'limit'));
    } catch (err) {
      return send(reply, err);
    }
  });
  app.get<{ Querystring: { symbol?: string; interval?: string; from?: string; to?: string } }>('/v1/candles', async (req, reply) => {
    try {
      const { symbol, interval } = req.query;
      if (!symbol) throw badRequest('symbol is required');
      const to = intParam(req.query.to, 'to');
      const body = await candles(symbol, interval as CandleInterval, intParam(req.query.from, 'from'), to);
      // A shared cache may keep a live latest window for seconds, a live settled window for an hour, a fallback never.
      // (A window is settled once the bucket holding `to` closed more than a minute ago, weeks and months by the calendar.)
      const nowSec = Math.floor(Date.now() / 1000);
      const past = to !== undefined && bucketNext(body.interval, Math.min(to, nowSec)) <= nowSec - 60;
      reply.header('cache-control', body.freshness !== 'live' ? 'no-store'
        : past ? 'public, s-maxage=3600, stale-while-revalidate=86400' : 'public, s-maxage=5, stale-while-revalidate=55');
      return body;
    } catch (err) {
      reply.header('cache-control', 'no-store');
      return send(reply, err);
    }
  });
  app.get<{ Querystring: { symbol?: string; side?: string; sizeUsd?: string; collateralUsd?: string; limitPrice?: string } }>('/v1/quote', async (req, reply) => {
    try {
      const { symbol, side, sizeUsd, collateralUsd, limitPrice } = req.query;
      if (!symbol || !sizeUsd) throw badRequest('symbol and sizeUsd are required');
      if (side !== 'Long' && side !== 'Short') throw badRequest('side must be Long or Short');
      return await quote(symbol, side, sizeUsd, collateralUsd || undefined, limitPrice || undefined);
    } catch (err) {
      return send(reply, err);
    }
  });

  // Test hook, registered only when NODE_ENV=test on a local cluster (never on mainnet, whatever NODE_ENV says: pinned
  // prices decide simulated fills, and so evaluation results that unlock funded capital): pins a market's price, which
  // then replaces the live one in every tick this module serves and ticks every second, so the full-stack rehearsal
  // (app/tests/fullstack.e2e.mjs) can decide an evaluation through the sim engine's own rules on a known price path.
  // `{ "price": null }` returns the market to live prices.
  if (ctx.env.NODE_ENV === 'test' && ctx.config.SOLANA_CLUSTER === 'localnet') {
    const PinBody = z.object({ price: z.string().regex(/^\d+(\.\d+)?$/).nullable() });
    app.put<{ Params: { symbol: string } }>('/v1/test/prices/:symbol', { onRequest: adminAuth(ctx.config.ADMIN_API_TOKEN) }, async (req, reply) => {
      const { price } = parse(PinBody, req.body);
      const symbol = req.params.symbol.toUpperCase();
      if (!started || !bySymbol.has(symbol)) return send(reply, new HttpError(404, 'unknown_market', `unknown market ${symbol}`));
      if (price === null) pinned.delete(symbol);
      else pinned.set(symbol, price);
      return tickFor(symbol) ?? null;
    });
    every(1_000, 'pinned prices', () => {
      for (const symbol of pinned.keys()) {
        const tick = tickFor(symbol);
        if (tick) emitTick(tick);
      }
    });
  }

  return {
    ready: () => ready,
    markets: current,
    market: (symbol) => current().find((r) => r.symbol === symbol.toUpperCase()),
    price: (symbol) => tickFor(symbol.toUpperCase()),
    onTick(listener) {
      tickListeners.add(listener);
      return () => tickListeners.delete(listener);
    },
    marketState,
    candles,
    trades,
    quote,
    health,
  };
}

export default async function register(ctx: ModuleContext): Promise<MarketDataService> {
  return createMarketData(ctx);
}
