// Indicator types the chart offers, as TradingView names and configures them. GMTrade candles carry no volume, so
// nothing volume-based (Volume, VWAP, OBV, MFI) is here.
import { atr, bollinger, donchian, ema, macd, rsi, sma, stochastic, wma } from '../lib/indicators';

/** Colours a new overlay takes, in order, when its own are already on the price chart, so every line is told apart. */
export const PALETTE = ['#f5a524', '#3b82f6', '#e879f9', '#2dd4bf', '#f97066', '#a3e635'];

const whole = (label, value, max = 500) => ({ label, value, min: 1, max, step: 1 });
const length = value => whole('Length', value);

/**
 * `inputs`: name → { label, value (default), min, max, step }. `lines`: what the indicator draws, in order (a
 * `histogram` line is coloured by sign). `compute(bars, inputs)` returns one point list per line. `pane`: drawn in a
 * pane of its own below the price; `range` fixes that pane's scale, `levels` are dashed guides in it. `recursive`: each
 * value builds on the one before (an exponential or Wilder average), not on a fixed window of candles.
 */
export const STUDIES = {
  sma: { name: 'Moving Average', short: 'MA', description: 'Simple average of the last N closes', inputs: { length: length(20) }, lines: [{ name: 'MA', color: '#f5a524' }], compute: (b, i) => [sma(b, i.length)] },
  ema: { name: 'Exponential Moving Average', short: 'EMA', description: 'Average weighted towards the most recent closes', recursive: true, inputs: { length: length(20) }, lines: [{ name: 'EMA', color: '#e879f9' }], compute: (b, i) => [ema(b, i.length)] },
  wma: { name: 'Weighted Moving Average', short: 'WMA', description: 'Average weighting each close by how recent it is', inputs: { length: length(20) }, lines: [{ name: 'WMA', color: '#2dd4bf' }], compute: (b, i) => [wma(b, i.length)] },
  bb: {
    name: 'Bollinger Bands', short: 'BB', description: 'Moving average with bands standard deviations above and below',
    inputs: { length: length(20), mult: { label: 'Standard deviations', value: 2, min: 0.1, max: 10, step: 0.1 } },
    lines: [{ name: 'Basis', color: '#f5a524' }, { name: 'Upper', color: '#3b82f6' }, { name: 'Lower', color: '#3b82f6' }],
    compute: (b, i) => { const r = bollinger(b, i.length, i.mult); return [r.middle, r.upper, r.lower]; },
  },
  dc: { name: 'Donchian Channels', short: 'DC', description: 'Highest high and lowest low of the last N candles', inputs: { length: length(20) }, lines: [{ name: 'Basis', color: '#f97066' }, { name: 'Upper', color: '#2dd4bf' }, { name: 'Lower', color: '#2dd4bf' }], compute: (b, i) => { const r = donchian(b, i.length); return [r.basis, r.upper, r.lower]; } },
  rsi: { name: 'Relative Strength Index', short: 'RSI', description: 'Momentum from 0 to 100, with 70 and 30 marked', pane: true, recursive: true, range: [0, 100], levels: [70, 30], decimals: 2, inputs: { length: length(14) }, lines: [{ name: 'RSI', color: '#8b5cf6' }], compute: (b, i) => [rsi(b, i.length)] },
  macd: {
    name: 'MACD', short: 'MACD', description: 'Moving average convergence divergence, with its signal line', pane: true, recursive: true,
    inputs: { fast: whole('Fast length', 12), slow: whole('Slow length', 26), signal: whole('Signal smoothing', 9, 50) },
    lines: [{ name: 'Histogram', histogram: true }, { name: 'MACD', color: '#3b82f6' }, { name: 'Signal', color: '#f5a524' }],
    compute: (b, i) => { const r = macd(b, i.fast, i.slow, i.signal); return [r.histogram, r.macd, r.signal]; },
  },
  stoch: {
    name: 'Stochastic', short: 'Stoch', description: 'Where the close sits in its recent range, from 0 to 100', pane: true, range: [0, 100], levels: [80, 20], decimals: 2,
    inputs: { length: whole('%K length', 14), smoothK: whole('%K smoothing', 3, 50), smoothD: whole('%D smoothing', 3, 50) },
    lines: [{ name: '%K', color: '#3b82f6' }, { name: '%D', color: '#f5a524' }],
    compute: (b, i) => { const r = stochastic(b, i.length, i.smoothK, i.smoothD); return [r.k, r.d]; },
  },
  atr: { name: 'Average True Range', short: 'ATR', description: 'Average candle range, gaps included', pane: true, recursive: true, inputs: { length: length(14) }, lines: [{ name: 'ATR', color: '#f97066' }], compute: (b, i) => [atr(b, i.length)] },
};

/** A value an input accepts: a number within its range, whole when the input steps by 1. */
export const validInput = (spec, value) => typeof value === 'number' && Number.isFinite(value) && value >= spec.min && value <= spec.max && (spec.step !== 1 || Number.isInteger(value));

export const newId = prefix => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * A new instance with TradingView's default inputs. An overlay whose colours a visible overlay already uses takes the
 * first palette colours nobody uses (lines that share a colour, such as both bands, keep sharing one).
 */
export function newStudy(type, studies) {
  const def = STUDIES[type];
  const used = new Set(studies.filter(s => !s.hidden && !STUDIES[s.type].pane).flatMap(s => s.colors));
  const chosen = new Map();
  const pick = color => {
    if (!chosen.has(color)) { const free = [color, ...PALETTE].find(c => !used.has(c)) ?? color; chosen.set(color, free); used.add(free); }
    return chosen.get(color);
  };
  const colors = def.lines.map(line => line.histogram ? null : def.pane ? line.color : pick(line.color));
  return { id: newId(type), type, inputs: Object.fromEntries(Object.entries(def.inputs).map(([key, spec]) => [key, spec.value])), colors, hidden: false };
}

/**
 * The candles a live tick recomputes an instance over: enough for its latest value to equal the one over the whole
 * history (its windows fit, and a recursive average forgets its first values within 40 of its lengths).
 */
export function tickBars(study) {
  const lengths = Object.values(study.inputs).reduce((sum, v) => sum + v, 0);
  return Math.ceil((STUDIES[study.type].recursive ? 40 * lengths : lengths) + 2);
}

/** "MA 20", "BB 20 2", "MACD 12 26 9". */
export const studyTitle = study => [STUDIES[study.type].short, ...Object.values(study.inputs)].join(' ');
