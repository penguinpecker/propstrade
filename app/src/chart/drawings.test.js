import { describe, expect, it } from 'vitest';
import { contrast, formatSpan, logicalToTime, readable, timeToLogical } from './drawings.js';

// Hourly candles with a gap (a closed session) between the third and the fourth.
const bars = [0, 3600, 7200, 18_000, 21_600].map(time => ({ time }));
const H = 3600;

describe('drawing anchors', () => {
  it('places a time on the candles, interpolating across gaps and extrapolating past the ends', () => {
    expect(timeToLogical(bars, H, 3600)).toBe(1);
    expect(timeToLogical(bars, H, 5400)).toBe(1.5);
    expect(timeToLogical(bars, H, 10_800)).toBe(2 + 3600 / 10_800); // a third of the way through the gap
    expect(timeToLogical(bars, H, 28_800)).toBe(6); // two hours after the last candle
    expect(timeToLogical(bars, H, -7200)).toBe(-2); // two hours before the first
  });

  it('maps bar positions back to the same times', () => {
    for (const time of [-7200, 0, 1800, 7200, 12_000, 18_000, 25_200]) expect(logicalToTime(bars, H, timeToLogical(bars, H, time))).toBeCloseTo(time, 6);
  });

  it('keeps a point at its time when the interval changes or older candles are prepended', () => {
    const time = 7200 + 1800; // placed on hourly candles
    const fourHourly = [0, 14_400].map(t => ({ time: t }));
    expect(timeToLogical(fourHourly, 4 * H, time)).toBe(9000 / 14_400);
    const withOlder = [{ time: -7200 }, { time: -3600 }, ...bars];
    expect(logicalToTime(withOlder, H, timeToLogical(withOlder, H, time))).toBeCloseTo(time, 6);
    expect(timeToLogical(withOlder, H, time) - timeToLogical(bars, H, time)).toBeCloseTo(2, 9); // two candles later in the list, same time
  });

  it('reads spans as TradingView does', () => {
    expect([formatSpan(2700), formatSpan(8100), formatSpan(-277_200), formatSpan(0)]).toEqual(['45m', '2h 15m', '3d 5h', '0m']);
  });
});

describe('text colours on the chart', () => {
  const light = '#fdfdfb', dark = '#19181f';
  it('darken (light theme) or lighten (dark theme) a line colour until it reads at 4.5:1, and keep one that already does', () => {
    for (const color of ['#f5a524', '#2dd4bf', '#a3e635', '#e879f9', '#3b82f6', '#9063e3', '#ff0000']) {
      expect(contrast(readable(color, light), light)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(readable(color, dark), dark)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast('#f5a524', light)).toBeCloseTo(2.0, 1); // TradingView's MA orange on the light chart
    expect(readable('#267963', light)).toBe('#267963');
    expect(readable('#f5a524', dark)).toBe('#f5a524');
  });
});
