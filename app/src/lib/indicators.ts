// Chart indicators computed from candle prices. GMTrade candles carry no volume, so volume-based indicators are absent.
import type { Candle } from '@props/shared';

export interface Point { time: number; value: number }

const closes = (bars: Candle[]): Point[] => bars.map(b => ({ time: b.time, value: b.close }));

function smaOf(values: Point[], n: number): Point[] {
  const out: Point[] = [];
  let sum = 0;
  values.forEach((p, i) => {
    sum += p.value;
    if (i >= n) sum -= values[i - n]!.value;
    if (i >= n - 1) out.push({ time: p.time, value: sum / n });
  });
  return out;
}

export const sma = (bars: Candle[], n: number): Point[] => smaOf(closes(bars), n);

/** Linearly weighted: the newest close weighs n, the oldest 1. */
export function wma(bars: Candle[], n: number): Point[] {
  const out: Point[] = [];
  for (let i = n - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = 1; j <= n; j++) sum += bars[i - n + j]!.close * j;
    out.push({ time: bars[i]!.time, value: sum / (n * (n + 1) / 2) });
  }
  return out;
}

/** Seeded with the simple average of the first `n` values. */
function emaOf(values: Point[], n: number): Point[] {
  if (values.length < n) return [];
  const k = 2 / (n + 1);
  let value = values.slice(0, n).reduce((s, p) => s + p.value, 0) / n;
  const out = [{ time: values[n - 1]!.time, value }];
  for (const p of values.slice(n)) out.push({ time: p.time, value: (value = p.value * k + value * (1 - k)) });
  return out;
}

export const ema = (bars: Candle[], n: number): Point[] => emaOf(closes(bars), n);

/** Wilder's smoothing, seeded with the simple average of the first `n` values. */
function rmaOf(values: Point[], n: number): Point[] {
  if (values.length < n) return [];
  let value = values.slice(0, n).reduce((s, p) => s + p.value, 0) / n;
  const out = [{ time: values[n - 1]!.time, value }];
  for (const p of values.slice(n)) out.push({ time: p.time, value: (value = (value * (n - 1) + p.value) / n) });
  return out;
}

/** Highest high and lowest low of the `n` candles ending at each candle, from the first full window on. */
function extremes(bars: Candle[], n: number): { time: number; high: number; low: number }[] {
  const out = [];
  for (let i = n - 1; i < bars.length; i++) {
    let high = -Infinity;
    let low = Infinity;
    for (let j = i - n + 1; j <= i; j++) { high = Math.max(high, bars[j]!.high); low = Math.min(low, bars[j]!.low); }
    out.push({ time: bars[i]!.time, high, low });
  }
  return out;
}

/** Wilder's average true range: the first candle's range is its high − low (it has no previous close). */
export function atr(bars: Candle[], n = 14): Point[] {
  const ranges = bars.map((b, i) => {
    const prev = bars[i - 1]?.close;
    return { time: b.time, value: prev === undefined ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev)) };
  });
  return rmaOf(ranges, n);
}

/**
 * Slow stochastic as TradingView computes it: %K is the close's place in the `length`-candle high-low range (0-100),
 * averaged over `smoothK` candles; %D averages %K over `smoothD`. A window with no range (high = low) reads 50.
 */
export function stochastic(bars: Candle[], length = 14, smoothK = 3, smoothD = 3): { k: Point[]; d: Point[] } {
  const raw = extremes(bars, length).map((w, j) => ({ time: w.time, value: w.high === w.low ? 50 : (bars[j + length - 1]!.close - w.low) / (w.high - w.low) * 100 }));
  const k = smaOf(raw, smoothK);
  return { k, d: smaOf(k, smoothD) };
}

export function donchian(bars: Candle[], n = 20): { upper: Point[]; lower: Point[]; basis: Point[] } {
  const w = extremes(bars, n);
  return { upper: w.map(p => ({ time: p.time, value: p.high })), lower: w.map(p => ({ time: p.time, value: p.low })), basis: w.map(p => ({ time: p.time, value: (p.high + p.low) / 2 })) };
}

export function bollinger(bars: Candle[], n = 20, k = 2): { upper: Point[]; middle: Point[]; lower: Point[] } {
  const middle = sma(bars, n);
  const upper: Point[] = [];
  const lower: Point[] = [];
  middle.forEach((m, j) => {
    const window = bars.slice(j, j + n);
    const sd = Math.sqrt(window.reduce((s, b) => s + (b.close - m.value) ** 2, 0) / n);
    upper.push({ time: m.time, value: m.value + k * sd });
    lower.push({ time: m.time, value: m.value - k * sd });
  });
  return { upper, middle, lower };
}

/** Wilder's RSI. */
export function rsi(bars: Candle[], n = 14): Point[] {
  if (bars.length <= n) return [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = bars[i]!.close - bars[i - 1]!.close;
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n;
  loss /= n;
  const value = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  const out = [{ time: bars[n]!.time, value: value() }];
  for (let i = n + 1; i < bars.length; i++) {
    const d = bars[i]!.close - bars[i - 1]!.close;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out.push({ time: bars[i]!.time, value: value() });
  }
  return out;
}

export function macd(bars: Candle[], fast = 12, slow = 26, signalN = 9): { macd: Point[]; signal: Point[]; histogram: Point[] } {
  const f = new Map(ema(bars, fast).map(p => [p.time, p.value]));
  const line = ema(bars, slow).filter(p => f.has(p.time)).map(p => ({ time: p.time, value: f.get(p.time)! - p.value })); // from where both averages exist
  const signal = emaOf(line, signalN);
  const s = new Map(signal.map(p => [p.time, p.value]));
  const histogram = line.filter(p => s.has(p.time)).map(p => ({ time: p.time, value: p.value - s.get(p.time)! }));
  return { macd: line, signal, histogram };
}
