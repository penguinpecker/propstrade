// Chart indicators computed from candle closes. GMTrade candles carry no volume, so volume-based indicators are absent.
import type { Candle } from '@props/shared';

export interface Point { time: number; value: number }

export type IndicatorId = 'ma20' | 'ma50' | 'ema20' | 'bb' | 'rsi' | 'macd';
export const INDICATORS: { id: IndicatorId; name: string; description: string; pane: boolean }[] = [
  { id: 'ma20', name: 'MA 20', description: 'Average close of the last 20 candles', pane: false },
  { id: 'ma50', name: 'MA 50', description: 'Average close of the last 50 candles', pane: false },
  { id: 'ema20', name: 'EMA 20', description: 'Exponential average of 20 candles, weighted to recent closes', pane: false },
  { id: 'bb', name: 'Bollinger Bands', description: 'MA 20 with bands two standard deviations above and below', pane: false },
  { id: 'rsi', name: 'RSI 14', description: 'Relative strength index, in its own panel with 70 and 30 marked', pane: true },
  { id: 'macd', name: 'MACD 12 26 9', description: 'Moving average convergence divergence, in its own panel', pane: true },
];

export function sma(bars: Candle[], n: number): Point[] {
  const out: Point[] = [];
  let sum = 0;
  bars.forEach((b, i) => {
    sum += b.close;
    if (i >= n) sum -= bars[i - n]!.close;
    if (i >= n - 1) out.push({ time: b.time, value: sum / n });
  });
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

export const ema = (bars: Candle[], n: number): Point[] => emaOf(bars.map(b => ({ time: b.time, value: b.close })), n);

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
  const line = ema(bars, slow).map(p => ({ time: p.time, value: f.get(p.time)! - p.value }));
  const signal = emaOf(line, signalN);
  const s = new Map(signal.map(p => [p.time, p.value]));
  const histogram = line.filter(p => s.has(p.time)).map(p => ({ time: p.time, value: p.value - s.get(p.time)! }));
  return { macd: line, signal, histogram };
}
