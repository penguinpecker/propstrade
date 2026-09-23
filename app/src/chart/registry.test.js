import { describe, expect, it } from 'vitest';
import { STUDIES, newStudy, tickBars } from './registry.js';

describe('new indicator instances', () => {
  it('give an overlay colours no visible overlay already uses; lines that share a colour keep sharing one', () => {
    const studies = [];
    for (const type of ['sma', 'sma', 'bb', 'dc']) studies.push(newStudy(type, studies));
    const [ma1, ma2, bb, dc] = studies;
    expect(ma1.colors).toEqual([STUDIES.sma.lines[0].color]);
    expect(bb.colors[1]).toBe(bb.colors[2]); // both bands
    expect(dc.colors[1]).toBe(dc.colors[2]);
    const lines = [ma1.colors[0], ma2.colors[0], bb.colors[0], bb.colors[1], dc.colors[0], dc.colors[1]];
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('reuse a hidden overlay\'s colour, and keep default colours in panes of their own', () => {
    const hidden = { ...newStudy('sma', []), hidden: true };
    expect(newStudy('sma', [hidden]).colors).toEqual(hidden.colors);
    const rsi = newStudy('rsi', [newStudy('sma', [])]);
    expect(rsi.colors).toEqual([STUDIES.rsi.lines[0].color]);
  });
});

// Deterministic candles with a trend, swings and gaps between closes and the next opens.
const bars = Array.from({ length: 3000 }, (_, i) => {
  const mid = 100 + i * 0.01 + Math.sin(i / 7) * 3 + Math.sin(i / 61) * 9;
  const open = mid + Math.sin(i * 1.3), close = mid + Math.cos(i * 0.9);
  return { time: 1_700_000_000 + i * 300, open, high: Math.max(open, close) + 0.5 + Math.abs(Math.sin(i)), low: Math.min(open, close) - 0.5 - Math.abs(Math.cos(i)), close };
});

describe('live-tick windows', () => {
  const cases = Object.keys(STUDIES).flatMap(type => {
    const defaults = newStudy(type, []);
    const longer = { ...defaults, inputs: Object.fromEntries(Object.entries(defaults.inputs).map(([k, v]) => [k, Number.isInteger(v) ? v * 2 + 1 : v])) };
    return [defaults, longer];
  });
  it.each(cases.map(study => [`${study.type} ${Object.values(study.inputs).join(' ')}`, study]))('%s: the latest values over tickBars candles equal those over the whole history', (_, study) => {
    const def = STUDIES[study.type];
    const whole = def.compute(bars, study.inputs);
    const tail = def.compute(bars.slice(-tickBars(study)), study.inputs);
    whole.forEach((points, k) => {
      expect(tail[k].at(-1).time).toBe(points.at(-1).time);
      expect(tail[k].at(-1).value).toBeCloseTo(points.at(-1).value, 9);
    });
  });
});
