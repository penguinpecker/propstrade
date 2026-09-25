import { describe, expect, it } from 'vitest';
import { SLIDER_STEPS, leverageToPosition, pageLeverage, positionToLeverage } from './leverage';

describe('leverage slider mapping', () => {
  const anchors = [1, 2, 5, 10, 25]; // presets 1×, 2×, 5×, 10× and Max 25×: a label every quarter of the track

  it('puts every anchor at an even share of the track, where its label is', () => {
    expect(anchors.map(v => leverageToPosition(v, anchors))).toEqual([0, 250, 500, 750, 1000]);
    expect([0, 250, 500, 750, 1000].map(p => positionToLeverage(p, anchors))).toEqual(anchors);
  });

  it('is linear between neighbouring anchors, rounded to a whole leverage within [1, max]', () => {
    expect(positionToLeverage(375, anchors)).toBe(4); // halfway from 2× to 5×: 3.5, rounded
    expect(positionToLeverage(875, anchors)).toBe(18); // halfway from 10× to 25×: 17.5, rounded
    expect([-50, SLIDER_STEPS + 50].map(p => positionToLeverage(p, anchors))).toEqual([1, 25]);
    expect([990, SLIDER_STEPS].map(p => positionToLeverage(p, [1, 2, 5, 10, 12.5]))).toEqual([12, 12.5]); // a max that is not whole is not rounded past
  });

  it('round-trips every whole leverage, so the thumb snaps onto the chosen value', () => {
    for (const list of [anchors, [1, 2, 5, 8], [1, 2, 5, 10, 25, 500], [1, 2]])
      for (let v = 1; v <= list[list.length - 1]!; v += 1) expect(positionToLeverage(leverageToPosition(v, list), list)).toBe(v);
    // 6× on the old linear 1..25 track sat under the "2×" label; here it sits between 5× and 10×.
    expect(leverageToPosition(6, anchors)).toBe(550);
  });

  it('moves Page Up / Page Down to the next labelled value either way, stopping at the ends', () => {
    expect([1, 2, 3, 10, 24, 25].map(v => pageLeverage(v, anchors, true))).toEqual([2, 5, 5, 25, 25, 25]);
    expect([25, 24, 10, 6, 2, 1].map(v => pageLeverage(v, anchors, false))).toEqual([10, 10, 5, 5, 1, 1]);
    expect([pageLeverage(1, [1], true), pageLeverage(1, [1], false)]).toEqual([1, 1]);
  });

  it('keeps a single anchor (a side capped at 1×) at the end of the track', () => {
    expect([leverageToPosition(1, [1]), positionToLeverage(0, [1]), positionToLeverage(SLIDER_STEPS, [1])]).toEqual([SLIDER_STEPS, 1, 1]);
  });
});
