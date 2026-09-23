import { describe, expect, it } from 'vitest';
import { atr, bollinger, donchian, ema, macd, rsi, sma, stochastic, wma } from './indicators';

const bars = (closes: number[]) => closes.map((close, i) => ({ time: i * 60, open: close, high: close, low: close, close }));
const values = (points: { value: number }[]) => points.map(p => Number(p.value.toFixed(4)));
/** Candles from [high, low, close] rows, one minute apart. */
const hlc = (rows: number[][]) => rows.map(([high, low, close], i) => ({ time: i * 60, open: close!, high: high!, low: low!, close: close! }));
// True ranges: 2 (first candle: high − low), 2 (high − previous close: 11 − 9), 3.5 (high − low: 10.5 − 7), 4 (gap up: 12 − 8).
const RANGES = hlc([[10, 8, 9], [11, 9.5, 10], [10.5, 7, 8], [12, 11, 11.5]]);

describe('indicators', () => {
  it('averages closes over the window, from the first full window on', () => {
    expect(values(sma(bars([1, 2, 3, 4, 5]), 3))).toEqual([2, 3, 4]);
    expect(sma(bars([1, 2]), 3)).toEqual([]);
  });

  it('seeds the EMA with the simple average, then weights recent closes', () => {
    // k = 2 / (3 + 1) = 0.5: 2, then 4 * 0.5 + 2 * 0.5 = 3, then 5 * 0.5 + 3 * 0.5 = 4
    expect(values(ema(bars([1, 2, 3, 4, 5]), 3))).toEqual([2, 3, 4]);
  });

  it('puts Bollinger Bands two population standard deviations around the average', () => {
    const { upper, middle, lower } = bollinger(bars([2, 4, 4, 4, 5, 5, 7, 9]), 8, 2); // mean 5, sd 2
    expect([values(upper), values(middle), values(lower)]).toEqual([[9], [5], [1]]);
  });

  it("computes Wilder's RSI: 100 with no losses, 0 with no gains, 50 when they balance", () => {
    expect(values(rsi(bars([1, 2, 3, 4]), 3))).toEqual([100]);
    expect(values(rsi(bars([4, 3, 2, 1]), 3))).toEqual([0]);
    expect(values(rsi(bars([1, 2, 1, 2, 1]), 4))).toEqual([50]);
  });

  it('weights the newest close most in the WMA', () => {
    // (1·1 + 2·2 + 3·3) / 6, (2·1 + 3·2 + 4·3) / 6, (3·1 + 4·2 + 5·3) / 6
    expect(values(wma(bars([1, 2, 3, 4, 5]), 3))).toEqual([2.3333, 3.3333, 4.3333]);
    expect(wma(bars([1, 2]), 3)).toEqual([]);
  });

  it("smooths true ranges with Wilder's average for the ATR", () => {
    // n = 2: seed (2 + 2) / 2 = 2, then (2 + 3.5) / 2 = 2.75, then (2.75 + 4) / 2 = 3.375
    expect(values(atr(RANGES, 2))).toEqual([2, 2.75, 3.375]);
    // n = 3: seed (2 + 2 + 3.5) / 3 = 2.5, then (2.5 · 2 + 4) / 3 = 3
    expect(values(atr(RANGES, 3))).toEqual([2.5, 3]);
    expect(atr(RANGES, 3)[0]!.time).toBe(120);
  });

  it('places the close in its high-low range for the stochastic, then smooths %K and %D', () => {
    const b = hlc([[10, 8, 9], [11, 9, 10], [12, 10, 11], [12, 9, 9], [13, 11, 13]]);
    // Raw %K over 3 candles: (11 − 8) / (12 − 8) = 75, (9 − 9) / (12 − 9) = 0, (13 − 9) / (13 − 9) = 100
    expect(values(stochastic(b, 3, 1, 1).k)).toEqual([75, 0, 100]);
    const { k, d } = stochastic(b, 3, 2, 2);
    expect(values(k)).toEqual([37.5, 50]); // (75 + 0) / 2, (0 + 100) / 2
    expect(values(d)).toEqual([43.75]); // (37.5 + 50) / 2
    expect(d[0]!.time).toBe(240);
    expect(values(stochastic(bars([5, 5, 5]), 3, 1, 1).k)).toEqual([50]); // no range: neither high nor low
  });

  it('bounds Donchian Channels by the highest high and lowest low, with the midpoint between', () => {
    const { upper, lower, basis } = donchian(RANGES, 2);
    expect(values(upper)).toEqual([11, 11, 12]);
    expect(values(lower)).toEqual([8, 7, 7]);
    expect(values(basis)).toEqual([9.5, 9, 9.5]);
  });

  it('builds MACD from the fast and slow EMAs, with its signal line and histogram', () => {
    const b = bars(Array.from({ length: 40 }, (_, i) => 100 + i)); // a steady rise: fast EMA above slow
    const { macd: line, signal, histogram } = macd(b);
    expect(line).toHaveLength(40 - 25);
    expect(signal).toHaveLength(40 - 25 - 8);
    expect(line.every(p => p.value > 0)).toBe(true);
    expect(histogram.at(-1)!.value).toBeCloseTo(line.at(-1)!.value - signal.at(-1)!.value, 10);
  });
});
