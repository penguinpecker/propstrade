// marketdata: the GMTrade market catalog, live prices, candles, recent trades and price-impact quotes
// (ARCHITECTURE.md §4.1). Routes under /v1; publishes batched 'price' and changed 'market' stream events.
import type { FastifyReply } from 'fastify';
import type {
  ApiError, Candle, CandleInterval, CandlesResponse, Market, MarketCategory, MarketTrade, PriceImpactQuote, PriceTick,
} from '@props/shared';
import {
  INTERVAL_SECONDS, KeeperFeed, PUBLIC_RPC, USD_DECIMALS, USD_UNIT, buildCatalog, fetchCandles, fetchCandlesBatch,
  fetchPairs, fetchTradeEvents, formatFixed, isMarketClosed, modelInput, parseFixed, priceString, priceTick, sessionOf,
  usdString, type KeeperMarket, type Pair, type PropsLimits,
} from '@props/gmtrade';
import { model } from '@props/gmsol-wasm';
import { z } from 'zod';
import { parse } from '../../errors.ts';
import { adminAuth } from '../../routes/admin.ts';
import type { MarketDataService, MarketState, ModuleContext } from '../types.ts';
import { fetchAllowlist, type MarketConfigLimits } from './allowlist.ts';
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
const NOT_ALLOWLISTED = 'Not available for funded trading';
const NO_USDC_POOL = 'Not available for funded trading: GMTrade has no USDC-only pool for this market';

const PRICE_FLUSH_MS = 250; // at most 4 'price' events per second
const MAX_CANDLES = 2_000;
const TRADES_TTL_MS = 5_000;
// How long a request waits for GMTrade before answering without it. The call keeps going and fills the cache.
const CANDLE_WAIT_MS = 4_000;
const TRADES_WAIT_MS = 5_000;
const MARKET_INFO_TIMEOUT_MS = 45_000; // a background refresh; the service has taken 20 s to answer

/** What the service does while each outside source fails (reported by /v1/health). */
const FALLBACKS: Record<string, string> = {
  priceFeed: 'Prices are polled over HTTP while the live stream reconnects.',
  candles: "Charts use the last copy, completed from Props.trade's own price record.",
  trades: 'Recent trades show the last list fetched.',
  marketInfo: '24h volume keeps its last value.',
  solanaRpc: 'The funded-trading allowlist keeps its last value.',
};

/** GMTrade keeps revising a candle for seconds after its bucket closes, so a range is cached for an
 *  hour only once its last bucket closed more than a minute ago. */
export const candleCacheTtl = (end: number, res: number, nowSec: number) => (end + res <= nowSec - 60 ? 3_600_000 : 5_000);

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const badRequest = (message: string) => new HttpError(400, 'bad_request', message);

function intParam(v: string | undefined, name: string): number | undefined {
  if (v === undefined || v === '') return undefined;
  if (!/^\d+$/.test(v)) throw badRequest(`${name} must be a non-negative integer`);
  return Number(v);
}

export default async function register(ctx: ModuleContext): Promise<MarketDataService> {
  const rpcUrl = ctx.env.RPC_URL || PUBLIC_RPC;
  const programId = ctx.env.PROGRAM_ID || undefined;
  const feed = new KeeperFeed({ rpcUrl, log: ctx.log });
  const timers: NodeJS.Timeout[] = [];
  const upstreams = createUpstreams(FALLBACKS, (name, s) => (s.state === 'down'
    ? ctx.log.warn({ upstream: name, since: s.since, error: s.lastError }, `marketdata: ${name} is down (${s.lastError}). ${s.fallback}`)
    : ctx.log.info({ upstream: name }, `marketdata: ${name} recovered`)));
  const record = createPriceRecord(ctx.sql);
  let lastTickAt = 0;

  let pairs = new Map<string, Pair>();
  let opens24h = new Map<string, number>();
  let allowlist = new Map<string, MarketConfigLimits>();
  let rows: Market[] = [];
  let builtAt = 0;
  let started = false;
  const bySymbol = new Map<string, Market>();
  const symbolByIndexToken = new Map<string, string>();
  const published = new Map<string, string>();
  const pendingTicks = new Map<string, PriceTick>();
  const tickListeners = new Set<(tick: PriceTick) => void>();
  /** Prices pinned by the test hook below (NODE_ENV=test on localnet only), by symbol. */
  const pinned = new Map<string, string>();
  const candleCache = new Map<string, { at: number; ttl: number; candles: CandlesResponse['candles'] }>();
  const tradeCache = new Map<string, { at: number; trades: MarketTrade[] }>();
  /** The latest candles GMTrade returned for the current window, by symbol:resolution. */
  const lastGood = new Map<string, Candle[]>();
  const inflight = new Map<string, Promise<unknown>>();

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

  function send(reply: FastifyReply, err: unknown) {
    if (!(err instanceof HttpError)) ctx.log.warn({ err }, 'marketdata upstream request failed');
    const e = err instanceof HttpError ? err : new HttpError(502, 'upstream_unavailable', 'GMTrade data is unavailable right now');
    const body: ApiError = { error: { code: e.code, message: e.message } };
    return reply.code(e.status).send(body);
  }

  const limits = ({ category, marketToken, pureUsdc }: { category: MarketCategory; marketToken: string; pureUsdc: boolean }): PropsLimits => {
    const defaults = DEFAULT_LIMITS[category];
    if (!pureUsdc) return { tradable: false, unavailableReason: NO_USDC_POOL, ...defaults };
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
      const { price: _p, change24h: _c, updatedAt: _u, ...slow } = market;
      const signature = JSON.stringify(slow);
      if (published.get(market.symbol) === signature) continue;
      published.set(market.symbol, signature);
      ctx.publish({ type: 'market', market });
    }
  }

  function preferredPool(symbol: string): { row: Market; pool: KeeperMarket } {
    if (!started) throw new HttpError(503, 'unavailable', 'market data is starting');
    const row = current().find((r) => r.symbol === symbol.toUpperCase());
    const pool = row && feed.markets.get(row.marketToken);
    if (!row || !pool) throw new HttpError(404, 'not_found', `unknown market ${symbol}`);
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

  function emitTick(tick: PriceTick) {
    lastTickAt = Date.now();
    record.add(tick);
    pendingTicks.set(tick.symbol, tick);
    for (const fn of tickListeners) fn(tick);
  }

  async function refreshPairs() {
    pairs = new Map((await upstreams.track('marketInfo', () => fetchPairs(undefined, MARKET_INFO_TIMEOUT_MS))).map((p) => [p.pool_id, p]));
  }

  /** Price 24 h ago: close of the last 5-minute candle completed by then, or, for markets that were
   *  closed at the time, of the last hourly candle in the 4 days before (covers weekends). */
  async function refreshOpens24h() {
    const t = Math.floor(Date.now() / 1000) - 86_400;
    const closeBefore = (list: CandlesResponse['candles'] | undefined, res: number) => list?.filter((c) => c.time + res <= t).at(-1)?.close;
    const tokens = [...new Set([...feed.markets.values()].flatMap((m) => (m.meta ? [m.meta.indexToken.pubkey] : [])))];
    const next = new Map<string, number>();
    const recent = await upstreams.track('candles', () => fetchCandlesBatch(tokens, 300, t - 3_600, t));
    const missing = tokens.filter((k) => {
      const close = closeBefore(recent.get(k), 300);
      if (close !== undefined) next.set(k, close);
      return close === undefined;
    });
    if (missing.length) {
      const older = await upstreams.track('candles', () => fetchCandlesBatch(missing, 3_600, t - 4 * 86_400, t));
      for (const k of missing) {
        const close = closeBefore(older.get(k), 3_600);
        if (close !== undefined) next.set(k, close);
      }
    }
    opens24h = next;
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
    const initial = [refreshPairs(), refreshOpens24h(), ...(programId ? [refreshAllowlist()] : [])];
    for (const r of await Promise.allSettled(initial)) {
      if (r.status === 'rejected') ctx.log.warn({ err: r.reason }, 'marketdata: initial refresh failed');
    }
    publishChangedMarkets();
    every(PRICE_FLUSH_MS, 'price publish', () => {
      if (!pendingTicks.size) return;
      ctx.publish({ type: 'price', ticks: [...pendingTicks.values()] });
      pendingTicks.clear();
    });
    every(5_000, 'market publish', publishChangedMarkets);
    every(60_000, 'market-info', refreshPairs, 3);
    every(300_000, '24h change', refreshOpens24h, 3);
    if (programId) every(60_000, 'allowlist', refreshAllowlist, 3);
    every(60_000, 'price record', record.flush);
    every(3_600_000, 'price record pruning', record.prune);
  })();
  ready.catch((err) => ctx.log.error({ err }, 'marketdata failed to start'));

  ctx.signal.addEventListener('abort', () => {
    feed.stop();
    for (const t of timers) clearInterval(t);
  });

  async function candles(symbol: string, interval: CandleInterval, from?: number, to?: number): Promise<CandlesResponse> {
    const res = Object.hasOwn(INTERVAL_SECONDS, interval) ? INTERVAL_SECONDS[interval] : undefined;
    if (!res) throw badRequest(`interval must be one of ${Object.keys(INTERVAL_SECONDS).join(', ')}`);
    const { row, pool } = preferredPool(symbol);
    const nowSec = Math.floor(Date.now() / 1000);
    const nowBucket = Math.floor(nowSec / res) * res;
    const end = Math.min(Math.floor((to ?? nowBucket) / res) * res, nowBucket);
    const start = Math.floor((from ?? end - (300 - 1) * res) / res) * res;
    if (start > end) throw badRequest('from must not be after to');
    if ((end - start) / res + 1 > MAX_CANDLES) throw badRequest(`at most ${MAX_CANDLES} candles per request`);
    const key = `${row.symbol}:${res}:${start}:${end}`;
    const series = `${row.symbol}:${res}`;
    const cached = candleCache.get(key);
    const base = { symbol: row.symbol, interval, source: 'gmtrade' as const };
    if (cached && Date.now() - cached.at < cached.ttl) return { ...base, candles: cached.candles, freshness: 'live' };
    const fetching = shared(`candles:${key}`, () => upstreams.track('candles', () => fetchCandles(pool.meta!.indexToken.pubkey, res, start, end))
      .then((list) => {
        if (candleCache.size >= 1_000) candleCache.delete(candleCache.keys().next().value!);
        candleCache.set(key, { at: Date.now(), ttl: candleCacheTtl(end, res, nowSec), candles: list });
        if (end === nowBucket) lastGood.set(series, list);
        return list;
      }));
    // An expired copy answers at once while the refresh runs (live ticks move its last candle in the app).
    if (cached) return { ...base, candles: cached.candles, freshness: Date.now() - cached.at < 120_000 ? 'live' : 'delayed' };
    try {
      return { ...base, candles: await within(fetching, CANDLE_WAIT_MS), freshness: 'live' };
    } catch (err) {
      // GMTrade's candle service is slow or down: the last copy of this chart, completed from the price record.
      const copy = (lastGood.get(series) ?? []).filter((c) => c.time >= start && c.time <= end);
      const recorded = await record.candles(row.symbol, res, start, end).catch(() => []);
      const list = mergeCandles(copy, recorded);
      if (!list.length) throw err;
      return { ...base, candles: list, freshness: 'delayed' };
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

  /** Each outside source's state, for /v1/health. */
  function health(): Record<string, UpstreamStatus> {
    const silentMs = Date.now() - lastTickAt;
    const priceFeed: UpstreamStatus = {
      state: !lastTickAt ? 'checking' : silentMs > 60_000 ? 'down' : feed.mode === 'poll' ? 'degraded' : 'ok',
      since: null, lastOkAt: lastTickAt || null, latencyMs: null, fallback: FALLBACKS.priceFeed!,
      lastError: !lastTickAt ? 'no price received yet' : silentMs > 60_000 ? `no price for ${Math.round(silentMs / 1000)} s`
        : feed.mode === 'poll' ? 'live stream reconnecting' : null,
    };
    return { priceFeed, ...upstreams.report() };
  }

  async function quote(symbol: string, side: 'Long' | 'Short', sizeUsd: string): Promise<PriceImpactQuote> {
    let size: bigint;
    try {
      size = parseFixed(sizeUsd, USD_DECIMALS);
    } catch {
      throw badRequest('sizeUsd must be a decimal number');
    }
    if (size <= 0n || size > 100_000_000n * USD_UNIT) throw badRequest('sizeUsd must be between 0 and 100,000,000');
    const { row, pool } = preferredPool(symbol);
    const input = modelInput(feed, pool);
    const meta = feed.tokens.get(pool.meta!.indexToken.pubkey)?.meta;
    if (!input || !meta) throw new HttpError(503, 'unavailable', `no live state for ${row.symbol} yet`);
    // Collateral in the pool's short token (USDC for every preferred pool) worth the full size: fees and
    // impact do not depend on leverage, and 1x never trips the min-collateral checks.
    let result;
    try {
      result = model.simulateIncrease({
        market: input, isLong: side === 'Long', collateralToken: pool.meta!.shortToken.pubkey,
        collateralAmount: size / input.prices.short.min + 1n, sizeDeltaUsd: size,
      });
    } catch (err) {
      throw new HttpError(422, 'rejected_by_venue', `GMTrade would reject this order: ${(err as Error).message}`);
    }
    return {
      symbol: row.symbol, side, sizeUsd: formatFixed(size, USD_DECIMALS, 6),
      priceImpactPct: (Number(result.priceImpactValue) / Number(size)) * 100,
      openFeeUsd: usdString(result.fees.orderFeeValue),
      executionPrice: priceString(result.executionPrice, meta.decimals, meta.precision),
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
      return await candles(symbol, interval as CandleInterval, intParam(req.query.from, 'from'), intParam(req.query.to, 'to'));
    } catch (err) {
      return send(reply, err);
    }
  });
  app.get<{ Querystring: { symbol?: string; side?: string; sizeUsd?: string } }>('/v1/quote', async (req, reply) => {
    try {
      const { symbol, side, sizeUsd } = req.query;
      if (!symbol || !sizeUsd) throw badRequest('symbol and sizeUsd are required');
      if (side !== 'Long' && side !== 'Short') throw badRequest('side must be Long or Short');
      return await quote(symbol, side, sizeUsd);
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
      if (!started || !bySymbol.has(symbol)) return send(reply, new HttpError(404, 'not_found', `unknown market ${symbol}`));
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
