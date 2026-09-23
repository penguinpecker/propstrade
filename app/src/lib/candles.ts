import type { Candle, CandleInterval } from '@props/shared';

const STEP: Record<CandleInterval, number> = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1D': 86_400 };

/**
 * The last candle moved by a live price at `ts` (ms): the same bucket updates it, a later bucket opens a new candle at
 * the previous close. Returns null for a price older than the last candle.
 */
export function applyTick(last: Candle | null | undefined, price: number, ts: number, interval: CandleInterval): Candle | null {
  const time = Math.floor(ts / 1000 / STEP[interval]) * STEP[interval];
  if (!last || time < last.time) return null;
  if (time === last.time) return { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price };
  return { time, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price };
}
