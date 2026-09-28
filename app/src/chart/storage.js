// Chart settings kept in this browser. localStorage is a trust boundary: every read is validated, and anything
// malformed falls back to the defaults.
import { useCallback, useState } from 'react';
import { INTERVALS, isInterval } from '../lib/candles';
import { STUDIES, validInput } from './registry.js';

export const MAX_STUDIES = 20;
export const MAX_DRAWINGS = 200;
export const MAX_TEXT = 200;
export const DRAWING_COLOR = '#9063e3';
/** Drawing types and the number of time/price points each is anchored to. */
export const DRAWING_POINTS = { trend: 2, ray: 2, hline: 1, hray: 1, vline: 1, rect: 2, fib: 2, text: 1 };
const ID = /^[\w-]{1,40}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const LAST_TIME = 4_102_444_800; // 2100-01-01
const isColor = value => typeof value === 'string' && HEX.test(value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const store = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
/** The stored value: undefined when there is none, null when it cannot be read. */
function read(storage, key) {
  try { const raw = storage?.getItem(`props.${key}`); return raw == null ? undefined : JSON.parse(raw); } catch { return null; }
}
function write(storage, key, value) {
  try { storage?.setItem(`props.${key}`, JSON.stringify(value)); } catch { /* private mode or full: kept for this visit */ }
}

/** Indicator instances ({ id, type, inputs, colors, hidden }): unknown types and repeated ids dropped, bad fields reset. */
export function validStudies(raw) {
  if (!Array.isArray(raw)) return [];
  const ids = new Set();
  return raw.slice(0, MAX_STUDIES).flatMap(item => {
    const def = isObject(item) && typeof item.type === 'string' && Object.hasOwn(STUDIES, item.type) ? STUDIES[item.type] : null;
    if (!def || typeof item.id !== 'string' || !ID.test(item.id) || ids.has(item.id)) return [];
    ids.add(item.id);
    const inputs = isObject(item.inputs) ? item.inputs : {};
    const colors = Array.isArray(item.colors) ? item.colors : [];
    return [{
      id: item.id,
      type: item.type,
      inputs: Object.fromEntries(Object.entries(def.inputs).map(([key, spec]) => [key, validInput(spec, inputs[key]) ? inputs[key] : spec.value])),
      colors: def.lines.map((line, k) => line.histogram ? null : isColor(colors[k]) ? colors[k] : line.color),
      hidden: item.hidden === true,
    }];
  });
}

/** The toggles the chart used to save ('chart-indicators'), as instances with the same settings and colours. */
const LEGACY = {
  ma20: { type: 'sma', inputs: { length: 20 }, colors: ['#f5a524'] },
  ma50: { type: 'sma', inputs: { length: 50 }, colors: ['#3b82f6'] },
  ema20: { type: 'ema', inputs: { length: 20 }, colors: ['#e879f9'] },
  bb: { type: 'bb' },
  rsi: { type: 'rsi' },
  macd: { type: 'macd' },
};

/** Saved instances; on the first load after the change, the old toggles migrated once (and their key removed). */
export function loadStudies(storage = store()) {
  const saved = read(storage, 'chart-studies');
  if (saved !== undefined) return validStudies(saved);
  const legacy = read(storage, 'chart-indicators');
  const studies = validStudies(Object.keys(LEGACY).filter(id => Array.isArray(legacy) && legacy.includes(id)).map(id => ({ id: `legacy-${id}`, ...LEGACY[id] })));
  write(storage, 'chart-studies', studies);
  try { storage?.removeItem('props.chart-indicators'); } catch { /* nothing to clean up */ }
  return studies;
}

const validPoint = p => isObject(p) && Number.isFinite(p.time) && p.time > 0 && p.time < LAST_TIME && Number.isFinite(p.price) && Math.abs(p.price) < 1e12;

/** Drawings ({ id, type, points: [{ time, price }], color, text? }): anything malformed is dropped. */
export function validDrawings(raw) {
  if (!Array.isArray(raw)) return [];
  const ids = new Set();
  return raw.slice(0, MAX_DRAWINGS).flatMap(d => {
    if (!isObject(d) || typeof d.type !== 'string' || !Object.hasOwn(DRAWING_POINTS, d.type) || typeof d.id !== 'string' || !ID.test(d.id) || ids.has(d.id)) return [];
    if (!Array.isArray(d.points) || d.points.length !== DRAWING_POINTS[d.type] || !d.points.every(validPoint)) return [];
    const text = d.type === 'text' && typeof d.text === 'string' ? d.text.trim().slice(0, MAX_TEXT) : '';
    if (d.type === 'text' && !text) return [];
    ids.add(d.id);
    return [{ id: d.id, type: d.type, points: d.points.map(p => ({ time: p.time, price: p.price })), color: isColor(d.color) ? d.color : DRAWING_COLOR, ...(text ? { text } : {}) }];
  });
}

/** The intervals pinned in the chart's toolbar until the trader stars others. */
export const DEFAULT_INTERVALS = ['5m', '15m', '1h', '4h', '1D'];
/** The saved interval, or 1h when there is none or it is not one the chart offers. */
export const loadInterval = (storage = store()) => { const saved = read(storage, 'chart-interval'); return isInterval(saved) ? saved : '1h'; };
/** The pinned intervals: known ones only, each once, in the chart's order; anything else reads as the defaults. */
export const validIntervals = raw => Array.isArray(raw) ? INTERVALS.filter(i => raw.includes(i)) : DEFAULT_INTERVALS;
export const loadIntervals = (storage = store()) => validIntervals(read(storage, 'chart-intervals'));
/** The Positions toggle (position and order lines on the chart): on unless it was switched off. */
export const loadShowGuides = (storage = store()) => read(storage, 'chart-guides') !== false;
export const loadDrawings = (symbol, storage = store()) => validDrawings(read(storage, `chart-drawings.${symbol}`));
export const saveDrawings = (symbol, list, storage = store()) => write(storage, `chart-drawings.${symbol}`, list);

/**
 * Chart state shared by the trade page's chart and its expanded copy: interval and the intervals pinned in the toolbar
 * (both saved in this browser), chart type, the Positions toggle (saved), indicator instances (saved in this browser),
 * the market's drawings (saved per market) and the drawing toggles.
 */
export function useChartSettings(symbol) {
  const [interval, setIntervalState] = useState(() => loadInterval());
  const setInterval = useCallback(next => { write(store(), 'chart-interval', next); setIntervalState(next); }, []);
  const [pinned, setPinnedState] = useState(() => loadIntervals());
  const setPinned = useCallback(list => { write(store(), 'chart-intervals', list); setPinnedState(list); }, []);
  const [chartType, setChartType] = useState('candles');
  const [showGuides, setShowGuidesState] = useState(() => loadShowGuides());
  const setShowGuides = useCallback(on => { write(store(), 'chart-guides', on); setShowGuidesState(on); }, []);
  const [studies, setStudiesState] = useState(() => loadStudies());
  const setStudies = useCallback(list => { write(store(), 'chart-studies', list); setStudiesState(list); }, []);
  const [saved, setSaved] = useState(() => ({ symbol, list: loadDrawings(symbol) }));
  const drawings = saved.symbol === symbol ? saved : { symbol, list: loadDrawings(symbol) };
  if (drawings !== saved) setSaved(drawings);
  const setDrawings = useCallback(list => { saveDrawings(symbol, list); setSaved({ symbol, list }); }, [symbol]);
  const [prefs, setPrefs] = useState({ magnet: false, stay: false, locked: false, hidden: false });
  return { interval, setInterval, pinned, setPinned, chartType, setChartType, showGuides, setShowGuides, studies, setStudies, drawings: drawings.list, setDrawings, prefs, setPrefs };
}
