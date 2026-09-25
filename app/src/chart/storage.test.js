import { describe, expect, it } from 'vitest';
import { DEFAULT_INTERVALS, DRAWING_COLOR, MAX_DRAWINGS, loadDrawings, loadInterval, loadIntervals, loadStudies, saveDrawings, validDrawings, validIntervals, validStudies } from './storage.js';

/** A localStorage stand-in. */
function memory(entries = {}) {
  const map = new Map(Object.entries(entries));
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k), map };
}

describe('indicator instances from storage', () => {
  it('keeps valid instances and resets each bad field to its default', () => {
    const [ma, bb] = validStudies([
      { id: 'ma-1', type: 'sma', inputs: { length: 50 }, colors: ['#123456'], hidden: true },
      { id: 'bb-1', type: 'bb', inputs: { length: 0, mult: 'x' }, colors: ['red', 7, '#abcdef'], hidden: 'yes' },
    ]);
    expect(ma).toEqual({ id: 'ma-1', type: 'sma', inputs: { length: 50 }, colors: ['#123456'], hidden: true });
    expect(bb).toEqual({ id: 'bb-1', type: 'bb', inputs: { length: 20, mult: 2 }, colors: ['#f5a524', '#3b82f6', '#abcdef'], hidden: false });
  });

  it('drops unknown types, bad or repeated ids and non-objects, and caps the count', () => {
    const rows = [
      { id: 'x', type: 'volume' }, { id: 'y', type: 'constructor' }, { id: '<b>', type: 'rsi' }, { id: 'z', type: 'rsi' },
      { id: 'z', type: 'ema' }, null, 'rsi', { id: 'w', type: 'atr', inputs: 'abc' },
    ];
    expect(validStudies(rows).map(s => `${s.id}:${s.type}:${JSON.stringify(s.inputs)}`)).toEqual(['z:rsi:{"length":14}', 'w:atr:{"length":14}']);
    expect(validStudies(Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, type: 'sma' })))).toHaveLength(20);
    for (const junk of [null, {}, 'sma', 42]) expect(validStudies(junk)).toEqual([]);
  });

  it('refuses inputs out of range or fractional where whole numbers are expected', () => {
    const inputs = raw => validStudies([{ id: 'm', type: 'macd', inputs: raw }])[0].inputs;
    expect(inputs({ fast: 5, slow: 35, signal: 4 })).toEqual({ fast: 5, slow: 35, signal: 4 });
    expect(inputs({ fast: 2.5, slow: 501, signal: -1 })).toEqual({ fast: 12, slow: 26, signal: 9 });
    expect(validStudies([{ id: 'b', type: 'bb', inputs: { mult: 2.5 } }])[0].inputs.mult).toBe(2.5);
    expect(validStudies([{ id: 'b', type: 'bb', inputs: { mult: Infinity } }])[0].inputs.mult).toBe(2);
  });

  it('migrates the old indicator toggles once, keeping their settings and colours', () => {
    const storage = memory({ 'props.chart-indicators': JSON.stringify(['rsi', 'ma50', 'bogus', 'ma20', 'ema20', 'bb', 'macd']) });
    const studies = loadStudies(storage);
    expect(studies.map(s => [s.type, Object.values(s.inputs).join(' '), s.colors[0]])).toEqual([
      ['sma', '20', '#f5a524'], ['sma', '50', '#3b82f6'], ['ema', '20', '#e879f9'], ['bb', '20 2', '#f5a524'], ['rsi', '14', '#8b5cf6'], ['macd', '12 26 9', null],
    ]);
    expect(storage.map.has('props.chart-indicators')).toBe(false);
    expect(JSON.parse(storage.map.get('props.chart-studies'))).toEqual(studies);
    // Once migrated, the saved instances are the source: toggles written again later are ignored.
    storage.setItem('props.chart-indicators', JSON.stringify(['macd']));
    storage.setItem('props.chart-studies', JSON.stringify([studies[4]]));
    expect(loadStudies(storage)).toEqual([studies[4]]);
  });

  it('starts empty without saved data, and from defaults when the saved data cannot be read', () => {
    expect(loadStudies(memory())).toEqual([]);
    expect(loadStudies(memory({ 'props.chart-studies': '{not json' }))).toEqual([]);
    expect(loadStudies(memory({ 'props.chart-indicators': '"rsi"' }))).toEqual([]);
    expect(loadStudies(null)).toEqual([]);
  });
});

describe('drawings from storage', () => {
  const trend = { id: 'd-1', type: 'trend', points: [{ time: 1_700_000_000, price: 64_000 }, { time: 1_700_003_600, price: 65_000 }], color: '#3b82f6' };

  it('keeps valid drawings and only their known fields', () => {
    const text = { id: 'd-2', type: 'text', points: [{ time: 1_700_000_000, price: 1 }], text: '  breakout <img src=x onerror=alert(1)>  ', extra: 1 };
    expect(validDrawings([{ ...trend, onclick: 'x' }, text])).toEqual([trend, { id: 'd-2', type: 'text', points: text.points, color: DRAWING_COLOR, text: 'breakout <img src=x onerror=alert(1)>' }]);
  });

  it('drops drawings with the wrong number of points, impossible coordinates or no text', () => {
    const bad = [
      { ...trend, id: 'a', points: [trend.points[0]] },
      { ...trend, id: 'b', type: 'hline' },
      { ...trend, id: 'c', points: [{ time: '1700000000', price: 1 }, trend.points[1]] },
      { ...trend, id: 'd', points: [{ time: 1_700_000_000, price: NaN }, trend.points[1]] },
      { ...trend, id: 'e', points: [{ time: -5, price: 1 }, trend.points[1]] },
      { ...trend, id: 'f', points: [{ time: 9e12, price: 1 }, trend.points[1]] },
      { id: 'g', type: 'text', points: [trend.points[0]], text: '   ' },
      { id: 'h', type: 'text', points: [trend.points[0]], text: ['x'] },
      { ...trend, id: 'i', type: 'toString' },
      { ...trend, id: 'j k' },
      trend, { ...trend },
    ];
    expect(validDrawings(bad).map(d => d.id)).toEqual(['d-1']);
    expect(validDrawings([{ ...trend, color: 'url(javascript:1)' }])[0].color).toBe(DRAWING_COLOR);
    expect(validDrawings([{ id: 't', type: 'text', points: [trend.points[0]], text: 'x'.repeat(500) }])[0].text).toHaveLength(200);
    expect(validDrawings(Array.from({ length: 300 }, (_, i) => ({ ...trend, id: `d${i}` })))).toHaveLength(MAX_DRAWINGS);
    for (const junk of [null, {}, 'x', 1]) expect(validDrawings(junk)).toEqual([]);
  });

  it('saves and loads per market', () => {
    const storage = memory();
    saveDrawings('BTC', [trend], storage);
    expect(loadDrawings('BTC', storage)).toEqual([trend]);
    expect(loadDrawings('ETH', storage)).toEqual([]);
    storage.setItem('props.chart-drawings.ETH', '[{"id":');
    expect(loadDrawings('ETH', storage)).toEqual([]);
  });
});

describe('interval settings from storage', () => {
  it('reads the saved interval when the chart offers it, 1h otherwise', () => {
    expect(loadInterval(memory({ 'props.chart-interval': '"3m"' }))).toBe('3m');
    for (const raw of ['"7m"', '"1d"', '1', '{not json', 'null']) expect(loadInterval(memory({ 'props.chart-interval': raw }))).toBe('1h');
    expect(loadInterval(memory())).toBe('1h');
  });

  it('keeps known pinned intervals once each in the chart’s order, and falls back to the defaults for anything else', () => {
    expect(validIntervals(['1D', '3m', '3m', '7m', 4, '1h'])).toEqual(['3m', '1h', '1D']);
    expect(validIntervals([])).toEqual([]);
    expect(validIntervals('1h')).toEqual(DEFAULT_INTERVALS);
    expect(loadIntervals(memory({ 'props.chart-intervals': '["1W","1m"]' }))).toEqual(['1m', '1W']);
    expect(loadIntervals(memory({ 'props.chart-intervals': '{bad' }))).toEqual(DEFAULT_INTERVALS);
    expect(loadIntervals(memory())).toEqual(DEFAULT_INTERVALS);
  });
});
