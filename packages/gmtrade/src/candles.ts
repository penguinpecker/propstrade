// GMTrade price candles. The service serves any bucket size natively (verified 2026-09-22: its
// 900 s candles equal 3 x 300 s aggregated), so 15m and 4h come straight from it.
import type { Candle, CandleInterval } from '@props/shared';
import { CANDLES } from './constants.ts';
import { graphql } from './graphql.ts';

export const INTERVAL_SECONDS: Record<CandleInterval, number> = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1D': 86_400 };

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
