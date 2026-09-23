import { describe, expect, it } from 'vitest';
import { bollinger, ema, macd, rsi, sma } from './indicators';

const bars = (closes: number[]) => closes.map((close, i) => ({ time: i * 60, open: close, high: close, low: close, close }));
const values = (points: { value: number }[]) => points.map(p => Number(p.value.toFixed(4)));

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

  it('builds MACD from the fast and slow EMAs, with its signal line and histogram', () => {
    const b = bars(Array.from({ length: 40 }, (_, i) => 100 + i)); // a steady rise: fast EMA above slow
    const { macd: line, signal, histogram } = macd(b);
    expect(line).toHaveLength(40 - 25);
    expect(signal).toHaveLength(40 - 25 - 8);
    expect(line.every(p => p.value > 0)).toBe(true);
    expect(histogram.at(-1)!.value).toBeCloseTo(line.at(-1)!.value - signal.at(-1)!.value, 10);
  });
});
