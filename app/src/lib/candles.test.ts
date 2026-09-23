import { describe, expect, it } from 'vitest';
import { applyTick } from './candles';

const last = { time: 3600, open: 100, high: 105, low: 99, close: 102 };

describe('applyTick', () => {
  it('moves the close, high and low of the current candle', () => {
    expect(applyTick(last, 107, 3600_000 + 1_000, '1h')).toEqual({ time: 3600, open: 100, high: 107, low: 99, close: 107 });
    expect(applyTick(last, 98, 7_199_000, '1h')).toEqual({ time: 3600, open: 100, high: 105, low: 98, close: 98 });
  });

  it('opens the next candle at the previous close', () => {
    expect(applyTick(last, 103, 7_200_000, '1h')).toEqual({ time: 7200, open: 102, high: 103, low: 102, close: 103 });
    expect(applyTick(last, 101, 86_400_000, '1D')).toEqual({ time: 86_400, open: 102, high: 102, low: 101, close: 101 });
  });

  it('ignores prices older than the last candle and a chart without candles', () => {
    expect(applyTick(last, 90, 3_599_000, '1h')).toBeNull();
    expect(applyTick(undefined, 90, 3_600_000, '1h')).toBeNull();
  });
});
