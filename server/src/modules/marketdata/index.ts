// marketdata: the GMTrade market catalog, live prices, candles, recent trades and price-impact quotes
// (ARCHITECTURE.md §4.1). Routes under /v1; publishes batched 'price' and changed 'market' stream events.
import type { FastifyReply } from 'fastify';
import type {
  ApiError, CandleInterval, CandlesResponse, Market, MarketCategory, MarketTrade, PriceImpactQuote, PriceTick,
} from '@props/shared';
import {
  INTERVAL_SECONDS, KeeperFeed, PUBLIC_RPC, USD_DECIMALS, USD_UNIT, buildCatalog, fetchCandles, fetchCandlesBatch,
  fetchPairs, fetchTradeEvents, formatFixed, isMarketClosed, modelInput, parseFixed, priceString, priceTick, sessionOf,
  usdString, type KeeperMarket, type Pair, type PropsLimits,
} from '@props/gmtrade';
import { model } from '@props/gmsol-wasm';
import type { MarketDataService, MarketState, ModuleContext } from '../types.ts';
import { fetchAllowlist, fetchAnchorIdl, type MarketConfigLimits } from './allowlist.ts';

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
  const candleCache = new Map<string, { at: number; ttl: number; candles: CandlesResponse['candles'] }>();
  const tradeCache = new Map<string, { at: number; trades: MarketTrade[] }>();

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
    return priceTick(symbol, token, sessionOf(token.price, data ? isMarketClosed(data) : false));
  }

  async function refreshPairs() {
    pairs = new Map((await fetchPairs()).map((p) => [p.pool_id, p]));
  }

  /** Price 24 h ago: close of the last 5-minute candle completed by then, or, for markets that were
   *  closed at the time, of the last hourly candle in the 4 days before (covers weekends). */
  async function refreshOpens24h() {
    const t = Math.floor(Date.now() / 1000) - 86_400;
    const closeBefore = (list: CandlesResponse['candles'] | undefined, res: number) => list?.filter((c) => c.time + res <= t).at(-1)?.close;
    const tokens = [...new Set([...feed.markets.values()].flatMap((m) => (m.meta ? [m.meta.indexToken.pubkey] : [])))];
    const next = new Map<string, number>();
    const recent = await fetchCandlesBatch(tokens, 300, t - 3_600, t);
    const missing = tokens.filter((k) => {
      const close = closeBefore(recent.get(k), 300);
      if (close !== undefined) next.set(k, close);
      return close === undefined;
    });
    if (missing.length) {
      const older = await fetchCandlesBatch(missing, 3_600, t - 4 * 86_400, t);
      for (const k of missing) {
        const close = closeBefore(older.get(k), 3_600);
        if (close !== undefined) next.set(k, close);
      }
    }
    opens24h = next;
  }

  let idl: Awaited<ReturnType<typeof fetchAnchorIdl>> | undefined;
  async function refreshAllowlist() {
    idl ??= await fetchAnchorIdl(rpcUrl, programId!);
    const tokens = [...feed.markets.values()].flatMap((m) => (m.meta?.isPure ? [m.marketToken] : []));
    allowlist = await fetchAllowlist(rpcUrl, programId!, idl, tokens);
  }

  function every(ms: number, what: string, fn: () => unknown) {
    const t = setInterval(async () => {
      try {
        await fn();
      } catch (err) {
        ctx.log.warn({ err }, `marketdata: ${what} refresh failed`);
      }
    }, ms);
    t.unref();
    timers.push(t);
  }

  feed.onTick((token) => {
    const symbol = symbolByIndexToken.get(token.pubkey);
    const tick = symbol && tickFor(symbol);
    if (!tick) return;
    pendingTicks.set(tick.symbol, tick);
    for (const fn of tickListeners) fn(tick);
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
    every(60_000, 'market-info', refreshPairs);
    every(300_000, '24h change', refreshOpens24h);
    if (programId) every(60_000, 'allowlist', refreshAllowlist);
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
    const cached = candleCache.get(key);
    const base = { symbol: row.symbol, interval, source: 'gmtrade' as const };
    if (cached && Date.now() - cached.at < cached.ttl) return { ...base, candles: cached.candles, freshness: 'live' };
    try {
      const list = await fetchCandles(pool.meta!.indexToken.pubkey, res, start, end);
      if (candleCache.size >= 1_000) candleCache.delete(candleCache.keys().next().value!);
      candleCache.set(key, { at: Date.now(), ttl: candleCacheTtl(end, res, nowSec), candles: list });
      return { ...base, candles: list, freshness: 'live' };
    } catch (err) {
      if (!cached) throw err;
      ctx.log.warn({ err }, 'candles unavailable; serving cached');
      return { ...base, candles: cached.candles, freshness: 'stale' };
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
    const events = await fetchTradeEvents({ marketTokens: row.pools.map((p) => p.marketToken) }, limit);
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
    if (!pool?.meta || !input || !account) throw new Error(`no onchain state for market ${marketToken}`);
    const index = pool.meta.indexToken.pubkey;
    return {
      symbol: symbolByIndexToken.get(index) ?? feed.tokens.get(index)?.meta?.name ?? index,
      marketToken,
      indexToken: index,
      pure: pool.meta.isPure,
      isClosed: isMarketClosed(account.data),
      raw: { market: input.market, virtualInventories: input.virtualInventories, slot: account.slot },
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
  };
}
