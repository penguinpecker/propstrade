// GMTrade price candles. The service serves any bucket size natively (verified 2026-09-22: its
// 900 s candles equal 3 x 300 s aggregated), so 15m and 4h come straight from it. The other intervals the app offers
// are rolled up from those (DERIVED_FROM, aggregateCandles) or built from Props.trade's own minute record.
import type { Candle, CandleInterval } from '@props/shared';
import { CANDLES } from './constants.ts';
import { graphql } from './graphql.ts';

/** The intervals fetched from GMTrade as they are (the pre-warm, the backfill and the history table hold only these). */
export type NativeInterval = '5m' | '15m' | '1h' | '4h' | '1D';
export const NATIVE_INTERVALS: NativeInterval[] = ['5m', '15m', '1h', '4h', '1D'];
/** Bucket span. A month's is nominal (30 days): month buckets follow the calendar (bucketStart). */
export const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1_800, '1h': 3_600, '2h': 7_200, '4h': 14_400, '6h': 21_600, '12h': 43_200,
  '1D': 86_400, '1W': 604_800, '1M': 2_592_000,
};
/** What each derived interval is rolled up from: a native interval, or the price record's one-minute bars. */
export const DERIVED_FROM: Partial<Record<CandleInterval, NativeInterval | 'record'>> = {
  '1m': 'record', '3m': 'record', '30m': '15m', '2h': '1h', '6h': '1h', '12h': '1h', '1W': '1D', '1M': '1D',
};

const MONDAY_EPOCH = 4 * 86_400; // 1970-01-05 00:00 UTC, the first Monday after the epoch

/** Start (unix seconds) of the `interval` bucket holding `t`: multiples of the span from the epoch, except weeks
 *  (Monday 00:00 UTC) and months (calendar months, UTC). */
export function bucketStart(interval: CandleInterval, t: number): number {
  if (interval === '1W') return Math.floor((t - MONDAY_EPOCH) / 604_800) * 604_800 + MONDAY_EPOCH;
  if (interval === '1M') { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth()) / 1000; }
  const res = INTERVAL_SECONDS[interval];
  return Math.floor(t / res) * res;
}

/** Start of the bucket after the one holding `t`. */
export function bucketNext(interval: CandleInterval, t: number): number {
  if (interval === '1M') { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1) / 1000; }
  return bucketStart(interval, t) + INTERVAL_SECONDS[interval];
}

/** `source` bars (oldest first, any finer resolution) rolled into `interval` buckets: open = first, high = max,
 *  low = min, close = last. The leading bucket is dropped when the source window, which starts at `coveredFrom`, does
 *  not reach its start (it would show a partial bar as a whole one); the trailing bucket, in progress, is kept. */
export function aggregateCandles(source: Candle[], interval: CandleInterval, coveredFrom: number): Candle[] {
  const out: Candle[] = [];
  for (const c of source) {
    const time = bucketStart(interval, c.time);
    const last = out.at(-1);
    if (last && last.time === time) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
    } else {
      out.push({ time, open: c.open, high: c.high, low: c.low, close: c.close });
    }
  }
  return out.length && out[0]!.time < coveredFrom ? out.slice(1) : out;
}

interface CandleNode { indexToken: string; timestamp: number; open: string; high: string; low: string; close: string }

/** Candle prices are USD with 18 decimals for every token. */
const price = (v: string) => Number(BigInt(v)) / 1e18;

const toCandle = (c: CandleNode): Candle => ({
  time: c.timestamp, open: price(c.open), high: price(c.high), low: price(c.low), close: price(c.close),
});

/** Candles with bucket start in [from, to] (unix seconds), oldest first. */
export async function fetchCandles(indexToken: string, resolution: number, from: number, to: number, url = CANDLES): Promise<Candle[]> {
  const d = await graphql<{ candles: CandleNode[] }>(url,
    `{ candles(indexToken: "${indexToken}", resolution: ${resolution}, from: ${from}, to: ${to}) { indexToken timestamp open high low close } }`);
  return d.candles.map(toCandle).sort((a, b) => a.time - b.time);
}

/** Candles for several index tokens in one request, by index token. */
export async function fetchCandlesBatch(indexTokens: string[], resolution: number, from: number, to: number, url = CANDLES): Promise<Map<string, Candle[]>> {
  const d = await graphql<{ candlesBatch: CandleNode[] }>(url,
    `{ candlesBatch(indexTokens: ${JSON.stringify(indexTokens)}, resolution: ${resolution}, from: ${from}, to: ${to}) { indexToken timestamp open high low close } }`);
  const out = new Map<string, Candle[]>();
  for (const c of d.candlesBatch) {
    const list = out.get(c.indexToken) ?? [];
    list.push(toCandle(c));
    out.set(c.indexToken, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.time - b.time);
  return out;
}
