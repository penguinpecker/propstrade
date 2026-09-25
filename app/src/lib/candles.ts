import type { Candle, CandleInterval, CandlesResponse } from '@props/shared';

/** Bucket span; a month's is nominal (30 days): week and month buckets follow the calendar (bucketStart). */
export const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1_800, '1h': 3_600, '2h': 7_200, '4h': 14_400, '6h': 21_600, '12h': 43_200,
  '1D': 86_400, '1W': 604_800, '1M': 2_592_000,
};
/** Every interval the chart offers, shortest first. */
export const INTERVALS = Object.keys(INTERVAL_SECONDS) as CandleInterval[];
export const isInterval = (value: unknown): value is CandleInterval => typeof value === 'string' && Object.hasOwn(INTERVAL_SECONDS, value);
const MONDAY_EPOCH = 4 * 86_400; // 1970-01-05 00:00 UTC, the first Monday after the epoch
// The server's bucket rule (packages/gmtrade/src/candles.ts), copied rather than imported: the app does not depend on
// that package (it pulls graphql-ws and the node WASM in).
/** Start (unix seconds) of the `interval` bucket holding `t`: multiples of the span, except weeks (Monday 00:00 UTC) and months (calendar, UTC). */
export function bucketStart(interval: CandleInterval, t: number): number {
  if (interval === '1W') return Math.floor((t - MONDAY_EPOCH) / 604_800) * 604_800 + MONDAY_EPOCH;
  if (interval === '1M') { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth()) / 1000; }
  return Math.floor(t / INTERVAL_SECONDS[interval]) * INTERVAL_SECONDS[interval];
}
/** Start of the bucket after the one holding `t`. */
export function bucketNext(interval: CandleInterval, t: number): number {
  if (interval === '1M') { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1) / 1000; }
  return bucketStart(interval, t) + INTERVAL_SECONDS[interval];
}

/**
 * The last candle moved by a live price at `ts` (ms): the same bucket updates it, a later bucket opens a new candle at
 * the previous close. Returns null for a price older than the last candle.
 */
export function applyTick(last: Candle | null | undefined, price: number, ts: number, interval: CandleInterval): Candle | null {
  const time = bucketStart(interval, Math.floor(ts / 1000));
  if (!last || time < last.time) return null;
  if (time === last.time) return { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price };
  return { time, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price };
}

// ---------- saved bars ----------
// The last live copy of each chart the browser fetched, kept in localStorage ('props.candles.<symbol>.<interval>') so
// the next visit paints before /v1/candles answers. localStorage is a trust boundary: every read is validated and
// anything malformed reads as no copy.

/** Bars kept per symbol and interval: the server's default window, so a copy is what its fetch returned. */
export const SNAPSHOT_BARS = 300;
/** Pairs kept in this browser; the least recently fetched go first. */
export const SNAPSHOT_PAIRS = 12;
/** A copy older than this is not shown: the gap to the live bar would read as a broken chart, not a head start. */
export const SNAPSHOT_MAX_AGE_MS = 3 * 86_400_000;
const PREFIX = 'props.candles.';
const LAST_TIME = 4_102_444_800; // 2100-01-01
const MAX_PRICE = 1e15;

const store = (): Storage | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const key = (symbol: string, interval: CandleInterval) => `${PREFIX}${symbol}.${interval}`;
const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** One saved bar ({ time, open, high, low, close } numbers, after `after`, prices within reason), or null. */
function validBar(raw: unknown, after: number): Candle | null {
  const bar = raw as Partial<Record<keyof Candle, unknown>> | null;
  if (typeof bar !== 'object' || bar === null) return null;
  const { time, open, high, low, close } = bar;
  if (!num(time) || !num(open) || !num(high) || !num(low) || !num(close)) return null;
  if (!Number.isInteger(time) || time <= after || time >= LAST_TIME) return null;
  if (low <= 0 || high >= MAX_PRICE || low > Math.min(open, close) || high < Math.max(open, close)) return null;
  return { time, open, high, low, close };
}

/**
 * The saved bars of a market and interval as the response they came from, with the time they were fetched; null when
 * there are none, they are malformed, they are older than SNAPSHOT_MAX_AGE_MS, or they end before the window a fetch
 * returns. Reading never writes.
 */
export function readCandleSnapshot(symbol: string, interval: CandleInterval, storage = store()): { at: number; response: CandlesResponse } | null {
  let raw: unknown;
  try { raw = JSON.parse(storage?.getItem(key(symbol, interval)) ?? 'null'); } catch { return null; }
  if (typeof raw !== 'object' || raw === null) return null;
  const { at, candles } = raw as { at?: unknown; candles?: unknown };
  if (!num(at) || Date.now() - at < 0 || Date.now() - at > SNAPSHOT_MAX_AGE_MS) return null;
  if (!Array.isArray(candles) || candles.length === 0 || candles.length > SNAPSHOT_BARS) return null;
  const list: Candle[] = [];
  for (const item of candles) {
    const bar = validBar(item, list.at(-1)?.time ?? 0);
    if (!bar) return null;
    list.push(bar);
  }
  // The chart keeps a copy's bars in front of the fetch's (Chart.jsx), so one that ends before the fetch's window of
  // SNAPSHOT_BARS starts would leave a hole it cannot show (bars are drawn by index): on 5m that is 25 h, well inside
  // SNAPSHOT_MAX_AGE_MS.
  if (Date.now() / 1000 - list.at(-1)!.time > SNAPSHOT_BARS * INTERVAL_SECONDS[interval]) return null;
  return { at, response: { symbol, interval, candles: list, source: 'venue', freshness: 'live' } };
}

/** When a saved pair was fetched; 0 for one that cannot be read, so it is the first to go. */
function fetchedAt(storage: Storage, name: string) {
  try {
    const at = (JSON.parse(storage.getItem(name) ?? 'null') as { at?: unknown } | null)?.at;
    return num(at) ? at : 0;
  } catch {
    return 0;
  }
}

/**
 * Keeps the last SNAPSHOT_BARS of a live response for the next visit, dated now. A fallback copy ('delayed') or an
 * empty list is not kept: the last live copy stays, and the footer's "saved copy" follows the server, never this.
 */
export function writeCandleSnapshot(symbol: string, interval: CandleInterval, response: CandlesResponse, storage = store()) {
  if (!storage || response.freshness !== 'live' || response.candles.length === 0) return;
  const candles = response.candles.slice(-SNAPSHOT_BARS).map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
  try {
    storage.setItem(key(symbol, interval), JSON.stringify({ at: Date.now(), candles }));
    const names: string[] = [];
    for (let i = 0; i < storage.length; i++) { const name = storage.key(i); if (name?.startsWith(PREFIX)) names.push(name); }
    if (names.length <= SNAPSHOT_PAIRS) return;
    const dated = names.map(name => [name, fetchedAt(storage, name)] as const).sort((a, b) => a[1] - b[1]);
    for (const [name] of dated.slice(0, names.length - SNAPSHOT_PAIRS)) storage.removeItem(name);
  } catch { /* private mode or full: the chart still paints from the fetch */ }
}
