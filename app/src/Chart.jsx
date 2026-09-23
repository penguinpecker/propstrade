import React, { useEffect, useReducer, useRef, useState } from 'react';
import { ChevronsRight, LineChart, Trash2, Type } from 'lucide-react';
import { AreaSeries, BarSeries, CandlestickSeries, CrosshairMode, HistogramSeries, LineSeries, LineStyle, PriceScaleMode, createChart } from 'lightweight-charts';
import { Button, Dialog, Empty, Unavailable } from './ui.jsx';
import { applyTick, INTERVAL_SECONDS } from './lib/candles';
import { BottomBar } from './chart/BottomBar.jsx';
import { DrawingToolbar } from './chart/DrawingToolbar.jsx';
import { createDrawingLayer, formatTime, ink, logicalToTime, readable, rgba, timeToLogical } from './chart/drawings.js';
import { IndicatorsDialog, StudySettings } from './chart/IndicatorsDialog.jsx';
import { Legend, StudyLegend } from './chart/Legend.jsx';
import { STUDIES, newStudy, tickBars } from './chart/registry.js';
import { MAX_DRAWINGS, MAX_STUDIES, MAX_TEXT } from './chart/storage.js';
import { ChartToolbar } from './chart/Toolbar.jsx';

/** Bars shown when a chart opens; older ones are a drag away. */
const RECENT_BARS = 120;
const RIGHT_OFFSET = 7;
/** Older history loads when the view comes this close (in bars) to the first loaded candle. */
const LOAD_OLDER_WITHIN = 15;
/** Going to a range or a date loads older candles this many at a time (the API's most per request), up to REACH_BARS on the chart. */
const REACH_BATCH = 2000;
const REACH_BARS = 30_000;
/** A press that moves this far vertically pans the price axis (auto-scale off until "auto" or a price-axis double-click). */
const VERTICAL_PAN_PX = 6;
const FONT = 'Manrope, sans-serif';
const FONT_SIZE = 10;
/** Height of one price-axis label: the library pads its text by 2.5 px per 12 px of font above and below. */
const AXIS_LABEL = FONT_SIZE * 17 / 12;
const SCROLL = { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true };
const SERIES = { candles: CandlestickSeries, bars: BarSeries, line: LineSeries, area: AreaSeries };
const PALETTES = {
  dark: { surface: '#19181f', axis: '#afa6bc', grid: '#2b2732', border: '#35313e', separatorHover: 'rgba(178,138,255,.18)', purple: '#b28aff', green: '#0ecb81', red: '#f6465d', greenSoft: 'rgba(14,203,129,.55)', redSoft: 'rgba(246,70,93,.55)', entry: '#9168ba', entryBg: '#332743', entryText: '#c8a3f3' },
  light: { surface: '#fdfdfb', axis: '#6e6975', grid: '#efeee9', border: '#eeece6', separatorHover: 'rgba(121,70,188,.14)', purple: '#8552cc', green: '#0a9e6b', red: '#e5354d', greenSoft: 'rgba(10,158,107,.5)', redSoft: 'rgba(229,53,77,.5)', entry: '#976ccc', entryBg: '#f0e8fa', entryText: '#76529b' },
};
const closesOnly = type => type === 'line' || type === 'area';
const toPoint = (type, bar) => closesOnly(type) ? { time: bar.time, value: bar.close } : bar;
/** The main series; its own last-value label is off because it follows the last candle in view (see lastPrice). */
function seriesOptions(type, c) {
  const common = { lastValueVisible: false };
  if (type === 'line') return { ...common, color: c.purple, lineWidth: 2 };
  if (type === 'area') return { ...common, lineColor: c.purple, topColor: rgba(c.purple, 0.28), bottomColor: rgba(c.purple, 0), lineWidth: 2 };
  return type === 'bars' ? { ...common, upColor: c.green, downColor: c.red, thinBars: false } : { ...common, upColor: c.green, downColor: c.red, wickUpColor: c.green, wickDownColor: c.red, borderVisible: false };
}
/** Index of the candle at `time`, or the latest when there is none there. */
function barIndex(list, time) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].time === time) return mid; if (list[mid].time < time) lo = mid + 1; else hi = mid - 1; }
  return list.length - 1;
}

/**
 * TradingView's last-price label: the latest candle's close in its colour (the library's own label shows the last candle
 * in view, so it is off), and right under it the time left in that candle, padded to the price's width so the axis's
 * own labels never show beside it. The axis stacks labels outward from the price in view, so a label exactly one label
 * height lower stays right under the price.
 */
function lastPrice(series, step, getBars, isLive) {
  let timer;
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `${FONT_SIZE}px ${FONT}`;
  const width = text => ctx.measureText(text).width;
  const last = () => series.lastValueData(true);
  const left = () => { const bar = getBars().at(-1); return bar ? bar.time + step - Date.now() / 1000 : 0; };
  const two = n => String(Math.floor(n)).padStart(2, '0');
  const price = () => { const d = last(); return d.noData ? '' : series.priceFormatter().format(d.price); };
  const clock = () => {
    const s = Math.max(0, left());
    const text = `${s >= 3600 ? `${two(s / 3600)}:` : ''}${two(s % 3600 / 60)}:${two(s % 60)}`;
    const gap = width(price()) - width(text);
    const space = width('\u2009');
    return gap > 0 && space > 0 ? text + '\u2009'.repeat(Math.ceil(gap / space)) : text;
  };
  const color = () => { const d = last(); return d.noData ? '#000000' : d.color; };
  const label = (offset, text, visible) => ({
    coordinate: () => { const d = last(); const y = d.noData ? null : series.priceToCoordinate(d.price); return y === null ? -1e4 : y + offset; },
    text, backColor: color, textColor: () => ink(color()), visible, tickVisible: () => offset === 0,
  });
  const views = [label(0, price, () => !last().noData), label(AXIS_LABEL, clock, () => isLive() && left() > 0 && left() <= step)]; // the countdown only while the latest candle is the current one
  return { attached: ({ requestUpdate }) => { timer = setInterval(requestUpdate, 1000); }, detached: () => clearInterval(timer), priceAxisViews: () => views };
}

function setStudyData(st, list, colors) {
  const def = STUDIES[st.inst.type];
  st.data = def.compute(list, st.inst.inputs);
  st.data.forEach((points, k) => st.series[k].setData(def.lines[k].histogram ? points.map(p => ({ ...p, color: p.value >= 0 ? colors.greenSoft : colors.redSoft })) : points));
}
/** After a live tick: the latest value of each line, computed over the recent candles only (tickBars), so a tick costs the same however much history is loaded. */
function setStudyTail(st, list, colors, time) {
  const def = STUDIES[st.inst.type];
  def.compute(list.slice(-tickBars(st.inst)), st.inst.inputs).forEach((points, k) => {
    const last = points.at(-1);
    if (last?.time !== time) return;
    const data = st.data[k];
    if (data.at(-1)?.time === time) data[data.length - 1] = last; else data.push(last);
    st.series[k].update(def.lines[k].histogram ? { ...last, color: last.value >= 0 ? colors.greenSoft : colors.redSoft } : last);
  });
}
function draw(current, list) {
  current.series.setData(list.map(b => toPoint(current.type, b)));
  for (const st of current.studies.values()) setStudyData(st, list, current.colors);
}
/** Brings the chart's indicator series in line with the instances: overlays on the price pane, each oscillator in a pane of its own. */
function syncStudies(current, instances, decimals, list) {
  const { chart, studies, colors } = current;
  for (const [id, st] of studies) if (!instances.some(i => i.id === id)) { for (const s of st.series) chart.removeSeries(s); studies.delete(id); }
  for (const inst of instances) {
    const def = STUDIES[inst.type];
    let st = studies.get(inst.id);
    if (!st) {
      st = { inst, series: [], inputs: null, data: [] };
      let pane = def.pane ? chart.panes().length : 0;
      def.lines.forEach((line, k) => {
        st.series.push(chart.addSeries(line.histogram ? HistogramSeries : LineSeries, line.histogram ? { priceLineVisible: false, lastValueVisible: false } : { lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false }, pane));
        if (k === 0) pane = st.series[0].getPane().paneIndex();
      });
      if (def.range) st.series[0].applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: def.range[0], maxValue: def.range[1] } }) });
      for (const level of def.levels ?? []) st.series[0].createPriceLine({ price: level, color: colors.axis, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
      studies.set(inst.id, st);
    }
    const precision = def.decimals ?? decimals;
    const priceFormat = def.pane ? { type: 'price', precision, minMove: 10 ** -precision } : current.priceFormat(); // overlays read like the price axis
    st.series.forEach((s, k) => s.applyOptions({ visible: !inst.hidden, priceFormat, ...(def.lines[k].histogram ? {} : { color: inst.colors[k] }) }));
    st.inst = inst;
    const inputs = JSON.stringify(inst.inputs);
    if (st.inputs !== inputs) { st.inputs = inputs; setStudyData(st, list, colors); }
  }
}

/** One tooltip for every control with a data-tip, beside it (on the side its nearest data-tip-side names), on mouse hover or keyboard focus. */
function useTips(root) {
  const [tip, setTip] = useState(null);
  useEffect(() => {
    const el = root.current;
    const show = target => {
      const control = target instanceof Element ? target.closest('[data-tip]') : null;
      if (!control || !el.contains(control) || control.getAttribute('aria-expanded') === 'true') { setTip(null); return; }
      const r = control.getBoundingClientRect();
      const side = control.closest('[data-tip-side]')?.dataset.tipSide ?? 'bottom';
      setTip({ text: control.dataset.tip, side, style: side === 'right' ? { left: r.right + 8, top: r.top + r.height / 2 } : { left: r.left + r.width / 2, top: side === 'top' ? r.top - 6 : r.bottom + 6 } });
    };
    const over = e => { if (e.pointerType !== 'touch') show(e.target); };
    const focus = e => { if (e.target.matches?.(':focus-visible')) show(e.target); };
    const hide = () => setTip(null);
    const events = [['pointerover', over], ['pointerleave', hide], ['pointerdown', hide], ['focusin', focus], ['focusout', hide]];
    for (const [type, fn] of events) el.addEventListener(type, fn);
    return () => { for (const [type, fn] of events) el.removeEventListener(type, fn); };
  }, [root]);
  return tip;
}

/** Types a text note; Enter or a press elsewhere keeps it, Escape drops it. */
function TextEditor({ edit, onDone }) {
  const [value, setValue] = useState(edit.drawing.text ?? '');
  const input = useRef(null);
  const latest = useRef(null);
  latest.current = { value, onDone };
  useEffect(() => {
    const focus = setTimeout(() => input.current?.focus()); // after the click that opened it, which moves focus to the chart
    const outside = e => { if (e.target !== input.current) latest.current.onDone(latest.current.value); };
    document.addEventListener('pointerdown', outside, true);
    return () => { clearTimeout(focus); document.removeEventListener('pointerdown', outside, true); };
  }, []);
  return <input ref={input} className="tv-text-editor" style={{ left: edit.x - 6, top: edit.y - 13, color: edit.drawing.color }} size={Math.max(12, value.length + 2)} maxLength={MAX_TEXT} value={value} placeholder="Type a note" aria-label="Text note"
    onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') onDone(value); else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone(null); } }} />;
}

/**
 * The trade page's price chart, laid out like TradingView: interval, chart type and indicators above; drawing tools on
 * the left, running down beside the plot; the legend and indicator panes on the plot; ranges, go-to-date, the UTC clock
 * and price-scale modes under the plot. `settings` comes from useChartSettings, shared with the expanded copy of the chart.
 */
export default function ChartPanel({ settings, market, candles, tick, theme, live, loadOlder, guides, onExpand }) {
  const { interval, chartType, studies, drawings, prefs } = settings;
  const [tool, setTool] = useState('cursor');
  const [selected, setSelected] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [scaleMode, setScaleMode] = useState('normal');
  const [autoScale, setAutoScale] = useState(true);
  const [request, setRequest] = useState(null); // a range or date to show, once its candles are on the chart
  const [drawTools, setDrawTools] = useState(false); // phones: the drawing toolbar is folded behind one button
  const root = useRef(null);
  const tip = useTips(root);
  const data = candles.data;
  const saved = Boolean(data) && data.freshness !== 'live';
  const chooseTool = next => { setTool(next); setDrawTools(false); if (next !== 'cursor' && prefs.hidden) settings.setPrefs({ ...prefs, hidden: false }); };
  const study = dialog?.settings ? studies.find(s => s.id === dialog.settings) : null;
  const studyActions = {
    onToggle: s => settings.setStudies(studies.map(x => x.id === s.id ? { ...x, hidden: !x.hidden } : x)),
    onSettings: s => setDialog({ settings: s.id }),
    onRemove: s => settings.setStudies(studies.filter(x => x.id !== s.id)),
  };
  return <div className="tv-panel" ref={root}>
    <ChartToolbar interval={interval} onInterval={settings.setInterval} chartType={chartType} onChartType={settings.setChartType} onIndicators={() => setDialog('indicators')} showGuides={settings.showGuides} onShowGuides={settings.setShowGuides} drawTools={drawTools} drawing={tool !== 'cursor'} onDrawTools={() => setDrawTools(!drawTools)} onExpand={onExpand} />
    <div className="tv-body">
      <DrawingToolbar tool={tool} onTool={chooseTool} prefs={prefs} onPrefs={next => { settings.setPrefs(next); if (next.locked || next.hidden) setSelected(null); }} count={drawings.length} onClear={() => setDialog('clear')} open={drawTools} />
      <div className="tv-plot">
        <div className="tv-stage">
          {candles.isPending ? <div className="chart-skeleton" role="status" aria-label="Loading candles" />
            : candles.isError ? <Unavailable title="Candles are unavailable" error={candles.error} retry={candles.refetch} />
            : !data.candles.length ? <Empty icon={LineChart} title="No candles yet">GMTrade has no price history for this market and interval.</Empty>
            : <PriceChart market={market} candles={data.candles} tick={tick} interval={interval} chartType={chartType} theme={theme} live={live} guides={guides} loadOlder={loadOlder}
              studies={studies} studyActions={studyActions} drawings={drawings} onDrawings={settings.setDrawings} prefs={prefs} tool={tool} onTool={chooseTool} selected={selected} onSelect={setSelected}
              scaleMode={scaleMode} autoScale={autoScale} onAutoScale={setAutoScale} request={request} onRequestDone={key => setRequest(r => r?.key === key ? null : r)} />}
        </div>
        <BottomBar onRange={(next, seconds) => { settings.setInterval(next); setRequest({ interval: next, from: Date.now() / 1000 - seconds, key: Date.now() }); }} onGoTo={time => setRequest({ interval, time, key: Date.now() })}
          source={`GMTrade prices${saved ? " · saved copy while GMTrade's charts recover" : ''}`} saved={saved} scaleMode={scaleMode} onScaleMode={setScaleMode} autoScale={autoScale} onAutoScale={setAutoScale} />
      </div>
    </div>
    {tip && <div className={`tv-tip ${tip.side}`} role="tooltip" style={tip.style}>{tip.text}</div>}
    {dialog === 'indicators' && <IndicatorsDialog studies={studies} onAdd={type => { if (studies.length < MAX_STUDIES) settings.setStudies([...studies, newStudy(type, studies)]); }} onClose={() => setDialog(null)} />}
    {study && <StudySettings study={study} onApply={next => { settings.setStudies(studies.map(s => s.id === next.id ? next : s)); setDialog(null); }} onClose={() => setDialog(null)} />}
    {dialog === 'clear' && <Dialog title="Remove all drawings?" onClose={() => setDialog(null)}><p className="dialog-note">{`The ${drawings.length} ${drawings.length === 1 ? 'drawing' : 'drawings'} on ${market.pair} will be removed from this browser.`}</p><div className="button-row"><Button variant="secondary" onClick={() => setDialog(null)}>Keep drawings</Button><Button onClick={() => { settings.setDrawings([]); setSelected(null); setDialog(null); }}>Remove all</Button></div></Dialog>}
  </div>;
}

/**
 * GMTrade candles (`candles`), moved live by `tick` ({ price, ts }); `guides` are horizontal price lines ({ price, title }).
 * Drag in any direction pans; the wheel or a pinch zooms. `loadOlder(beforeTime, count)` supplies earlier candles as the
 * view nears the first one. Drawings and indicator instances come from the chart settings.
 */
function PriceChart({ market, candles, tick, interval, chartType, theme, live, guides, loadOlder, studies, studyActions, drawings, onDrawings, prefs, tool, onTool, selected, onSelect, scaleMode, autoScale, onAutoScale, request, onRequestDone }) {
  const container = useRef(null);
  const chartRef = useRef(null);
  const chartKey = `${market.symbol}:${interval}`;
  const bars = useRef([]); // every candle of this market and interval on the chart, oldest first; the last one moved by ticks
  const barsKey = useRef(chartKey);
  if (barsKey.current !== chartKey) { barsKey.current = chartKey; bars.current = []; }
  const saved = useRef(null); // the view kept across a rebuild of the same chart (the chart type or theme changed)
  const editing = useRef(null);
  const legendBox = useRef(null);
  const [, bump] = useReducer(n => n + 1, 0); // bars or indicator values changed: the legend reads them again
  const [hover, setHover] = useState(null); // time of the candle under the crosshair
  const [paneTops, setPaneTops] = useState([]);
  const [text, setText] = useState(null); // the text note being typed: { drawing, x, y }
  const [behind, setBehind] = useState(false); // the latest candle is out of view
  const [legendHeight, setLegendHeight] = useState(0);
  const [notice, setNotice] = useState(null); // why a range or date could not be shown in full
  const startText = edit => { editing.current = edit; setText(edit); };
  const latest = useRef(null);
  latest.current = { live, loadOlder, request, onDrawings, onSelect, onTool, onAutoScale, onRequestDone, startText, onNotice: setNotice };

  useEffect(() => {
    const colors = PALETTES[theme];
    const el = container.current;
    const step = INTERVAL_SECONDS[interval];
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: colors.surface }, textColor: colors.axis, fontFamily: FONT, fontSize: FONT_SIZE, attributionLogo: true, panes: { separatorColor: colors.border, separatorHoverColor: colors.separatorHover, enableResize: true } },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border, scaleMargins: { top: .12, bottom: .1 }, entireTextOnly: true },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false, rightOffset: RIGHT_OFFSET, barSpacing: 6 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#b6aec3', labelBackgroundColor: '#645474' }, horzLine: { color: '#b6aec3', labelBackgroundColor: '#645474' } },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true }, handleScroll: SCROLL,
    });
    const series = chart.addSeries(SERIES[chartType], seriesOptions(chartType, colors));
    const minMove = 10 ** -market.priceDecimals;
    series.applyOptions({ priceFormat: { type: 'price', precision: market.priceDecimals, minMove } });
    chart.panes()[0].setStretchFactor(3);
    const layer = createDrawingLayer({
      chart, series, step, scroll: SCROLL, bars: () => bars.current, theme: { surface: colors.surface, up: colors.green, down: colors.red, accent: colors.purple }, formatPrice: price => price.toFixed(market.priceDecimals),
      onChange: list => latest.current.onDrawings(list), onSelect: id => latest.current.onSelect(id), onTool: t => latest.current.onTool(t), onText: edit => latest.current.startText(edit),
    });
    series.attachPrimitive(layer.primitive);
    const label = lastPrice(series, step, () => bars.current, () => latest.current.live);
    series.attachPrimitive(label);
    const showRecent = () => { const n = bars.current.length; if (n) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - RECENT_BARS), to: n - 1 + RIGHT_OFFSET }); };
    // `view` shows what the chart was opened with (the latest bars, the view before a rebuild, or a range or date asked
    // for), found by time so older candles loaded meanwhile do not move it; it runs again once the chart knows its width.
    const current = chartRef.current = { chart, series, layer, colors, type: chartType, interval, studies: new Map(), priceLines: [], showRecent, view: showRecent, placed: false, percent: false };

    // The % scale as TradingView draws it: prices stay on one linear scale, so overlays, drawings and guides keep their
    // places, and every label reads as the change from the first candle in view. (The library's own percentage mode
    // measures each series from its own first value, which pulls overlays off the candles.)
    let base = null;
    const percent = price => `${price < base ? '−' : ''}${Math.abs((price / base - 1) * 100).toFixed(2)}%`;
    current.priceFormat = () => current.percent && base ? { type: 'custom', minMove, formatter: percent } : { type: 'price', precision: market.priceDecimals, minMove };
    current.rebase = force => {
      const range = chart.timeScale().getVisibleLogicalRange();
      const list = bars.current;
      const next = current.percent && range && list.length ? list[Math.min(list.length - 1, Math.max(0, Math.floor(range.from)))].close : null;
      if (next === base && !force) return;
      base = next;
      const priceFormat = current.priceFormat();
      series.applyOptions({ priceFormat });
      for (const st of current.studies.values()) if (!STUDIES[st.inst.type].pane) for (const s of st.series) s.applyOptions({ priceFormat });
    };

    // Presses go to the drawings first. Otherwise the price axis follows a vertical drag, as on TradingView: auto-scale
    // is switched off as a press starts (the chart only pans prices when it is off then) and back on when the press ends
    // without moving vertically.
    const local = e => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const scale = () => series.priceScale();
    const report = () => latest.current.onAutoScale(scale().options().autoScale);
    const panel = () => el.closest('.tv-panel');
    let press = null;
    const down = e => {
      if (e.button !== 0) return;
      el.focus({ preventScroll: true }); // Delete and Escape then reach this chart's drawings
      if (layer.down(e, local(e)) || !scale().options().autoScale) return;
      press = { y: e.clientY, moved: false };
      scale().applyOptions({ autoScale: false });
    };
    const move = e => { layer.move(e, local(e)); if (press && Math.abs(e.clientY - press.y) >= VERTICAL_PAN_PX) press.moved = true; };
    const up = e => { layer.up(e, local(e)); if (!press) return; if (!press.moved) scale().applyOptions({ autoScale: true }); press = null; report(); };
    const dblclick = e => { if (!layer.dblclick(local(e))) requestAnimationFrame(report); }; // a price-axis double-click fits prices again
    const leave = () => layer.leave();
    // Keys act on the drawings only while focus is in this chart's panel (the chart itself takes focus on a press).
    const key = e => {
      if (e.defaultPrevented || !panel()?.contains(document.activeElement) || (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]'))) return;
      if ([...document.querySelectorAll('dialog[open]')].some(d => !d.contains(el))) return; // a dialog is in front of this chart
      if (layer.key(e)) e.preventDefault();
    };
    const away = e => { if (!panel()?.contains(e.target)) latest.current.onSelect(null); }; // a press elsewhere on the page ends the selection
    el.addEventListener('pointerdown', down, true);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('dblclick', dblclick);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', key);
    document.addEventListener('pointerdown', away, true);
    const crosshair = param => setHover(param.time ?? null);
    chart.subscribeCrosshairMove(crosshair);

    // Older history when the view nears the first loaded candle; a failed load is retried after a pause.
    let loading = null;
    let exhausted = false;
    let retryAt = 0;
    const fetchEarlier = async count => {
      if (exhausted || Date.now() < retryAt || !bars.current.length || !latest.current.loadOlder) return false;
      try {
        const first = bars.current[0].time;
        const earlier = (await latest.current.loadOlder(first, count)).filter(c => c.time < first);
        if (chartRef.current !== current) return false;
        if (!earlier.length) { exhausted = true; return false; }
        const view = chart.timeScale().getVisibleLogicalRange();
        bars.current = [...earlier, ...bars.current];
        draw(current, bars.current);
        if (view) chart.timeScale().setVisibleLogicalRange({ from: view.from + earlier.length, to: view.to + earlier.length });
        bump();
        return true;
      } catch {
        retryAt = Date.now() + 10_000;
        return false;
      }
    };
    /** Loads the `count` (300 by default) candles before the first one; resolves false when none came (history exhausted, or the load failed). */
    current.loadEarlier = (count = 300) => loading ??= fetchEarlier(count).finally(() => { loading = null; });
    /**
     * Loads older candles, REACH_BATCH at a time, until the chart starts at or before `time` (unix seconds): 'ok', or why
     * it stopped short: 'start' (GMTrade's history starts later), 'limit' (REACH_BARS on the chart) or 'failed'.
     */
    current.reach = async time => {
      while (bars.current.length && bars.current[0].time > time) {
        if (bars.current.length >= REACH_BARS) return 'limit';
        if (!await current.loadEarlier(REACH_BATCH)) return exhausted ? 'start' : 'failed';
      }
      return 'ok';
    };
    const onRange = range => {
      if (!range) return;
      setBehind(range.to < bars.current.length - 1.5);
      current.rebase();
      if (range.from <= LOAD_OLDER_WITHIN) void current.loadEarlier();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    // Once the chart knows its width, show the view it was opened with; later width changes re-show the latest bars
    // (ordinary pan and zoom stay user-controlled).
    let width = 0;
    let resizeFrame;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = Math.round(entry.contentRect.width);
      if (nextWidth === width || nextWidth <= 0) return;
      const first = width === 0;
      width = nextWidth;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(first ? () => current.view() : showRecent);
    });
    observer.observe(el);
    // Where each pane starts, for the indicator legends at their tops; a divider drag resizes the panes.
    const measure = () => {
      if (chartRef.current !== current) return;
      const top = el.getBoundingClientRect().top;
      const tops = chart.panes().map(p => Math.round((p.getHTMLElement()?.getBoundingClientRect().top ?? top) - top));
      setPaneTops(prev => prev.length === tops.length && prev.every((t, i) => t === tops[i]) ? prev : tops);
    };
    const panes = new ResizeObserver(measure);
    current.watchPanes = () => requestAnimationFrame(() => requestAnimationFrame(() => {
      if (chartRef.current !== current) return;
      panes.disconnect();
      for (const p of chart.panes()) { const row = p.getHTMLElement(); if (row) panes.observe(row); }
    }));
    return () => {
      const range = chart.timeScale().getVisibleLogicalRange();
      saved.current = { key: chartKey, range: range && bars.current.length ? { from: logicalToTime(bars.current, step, range.from), to: logicalToTime(bars.current, step, range.to) } : null, autoScale: scale().options().autoScale };
      el.removeEventListener('pointerdown', down, true);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('dblclick', dblclick);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', away, true);
      chart.unsubscribeCrosshairMove(crosshair);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      observer.disconnect();
      panes.disconnect();
      cancelAnimationFrame(resizeFrame);
      series.detachPrimitive(label);
      chart.remove();
      chartRef.current = null;
      editing.current = null;
      setText(null); // a note being typed belongs to the chart it was placed on
      setNotice(null);
    };
  }, [market.symbol, market.priceDecimals, interval, chartType, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const current = chartRef.current;
    if (!current) return;
    syncStudies(current, studies, market.priceDecimals, bars.current);
    current.watchPanes();
    bump();
  }, [studies, market.symbol, market.priceDecimals, interval, chartType, theme]);

  /** Shows the range or date asked for (bottom bar), loading older candles first when it starts before them. */
  async function follow(current) {
    const req = latest.current.request;
    if (!req || req.interval !== current.interval || current.following === req.key) return;
    current.following = req.key;
    const step = INTERVAL_SECONDS[current.interval];
    const timeScale = current.chart.timeScale();
    const view = timeScale.getVisibleLogicalRange();
    const half = view ? (view.to - view.from) / 2 : RECENT_BARS / 2;
    const reached = await current.reach(req.from ?? req.time - half * step);
    if (chartRef.current !== current) return;
    current.view = () => {
      const list = bars.current;
      if (req.from !== undefined) { timeScale.setVisibleLogicalRange({ from: Math.max(0, timeToLogical(list, step, req.from)), to: list.length - 1 + RIGHT_OFFSET }); return; }
      const at = Math.min(Math.max(timeToLogical(list, step, req.time), 0), list.length - 1);
      timeScale.setVisibleLogicalRange({ from: at - half, to: at + half });
    };
    current.view();
    current.series.priceScale().applyOptions({ autoScale: true });
    latest.current.onAutoScale(true);
    // Say why the chart stops short of a date (a range simply starts where GMTrade's history does).
    const first = formatTime(bars.current[0].time, 86_400);
    if (reached === 'failed') latest.current.onNotice('Older candles could not be loaded. Try again in a moment.');
    else if (reached === 'limit' && req.time !== undefined) latest.current.onNotice(`The chart loads up to ${REACH_BARS.toLocaleString('en-US')} ${interval} candles, back to ${first}. Pick a longer interval to go further back.`);
    else if (reached === 'start' && req.time !== undefined) latest.current.onNotice(`GMTrade's ${interval} candles for ${market.pair} begin on ${first}.`);
    latest.current.onRequestDone(req.key);
  }

  useEffect(() => {
    const current = chartRef.current;
    if (!current) return;
    const first = candles[0]?.time ?? Infinity;
    bars.current = [...bars.current.filter(c => c.time < first), ...candles]; // older history, and candles earlier fetches had, stay before the new ones
    draw(current, bars.current);
    bump();
    if (current.placed || !bars.current.length) return;
    current.placed = true;
    // First data of this chart: the view it had before a rebuild, else the latest bars. Later refetches keep pan and zoom.
    const keep = saved.current?.key === chartKey ? saved.current : null;
    saved.current = null;
    if (keep?.range) {
      const step = INTERVAL_SECONDS[interval];
      current.view = () => current.chart.timeScale().setVisibleLogicalRange({ from: timeToLogical(bars.current, step, keep.range.from), to: timeToLogical(bars.current, step, keep.range.to) });
      current.series.priceScale().applyOptions({ autoScale: keep.autoScale });
    } else onAutoScale(true); // a new market or interval opens with its prices fitted
    current.view();
    void follow(current);
  }, [candles, market.symbol, interval, chartType, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const current = chartRef.current; if (current?.placed) void follow(current); }, [request]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const current = chartRef.current;
    if (!current || !tick) return;
    const bar = applyTick(bars.current.at(-1), tick.price, tick.ts, interval);
    if (!bar) return;
    bars.current = bar.time === bars.current.at(-1)?.time ? [...bars.current.slice(0, -1), bar] : [...bars.current, bar];
    current.series.update(toPoint(current.type, bar));
    for (const st of current.studies.values()) setStudyTail(st, bars.current, current.colors, bar.time);
    bump();
  }, [tick, candles, market.symbol, interval, chartType, theme]);

  useEffect(() => {
    const current = chartRef.current;
    if (!current) return;
    for (const priceLine of current.priceLines) current.series.removePriceLine(priceLine);
    current.priceLines = guides.map(g => current.series.createPriceLine({ price: g.price, color: current.colors.entry, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: g.title, axisLabelColor: current.colors.entryBg, axisLabelTextColor: current.colors.entryText }));
  }, [guides, market.symbol, interval, chartType, theme]);

  useEffect(() => {
    const current = chartRef.current;
    if (!current) return;
    current.percent = scaleMode === 'percent';
    current.series.priceScale().applyOptions({ mode: scaleMode === 'log' ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
    current.rebase(true);
  }, [scaleMode, market.symbol, interval, chartType, theme]);
  useEffect(() => { chartRef.current?.series.priceScale().applyOptions({ autoScale }); }, [autoScale, market.symbol, interval, chartType, theme]);
  useEffect(() => { chartRef.current?.layer.sync({ drawings, tool, prefs, selected }); }, [drawings, tool, prefs, selected, market.symbol, interval, chartType, theme]);
  useEffect(() => { if (!notice) return undefined; const id = setTimeout(() => setNotice(null), 8000); return () => clearTimeout(id); }, [notice]);
  useEffect(() => {
    const el = legendBox.current;
    const observer = new ResizeObserver(() => setLegendHeight(Math.round(el.offsetHeight)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const endText = value => {
    const edit = editing.current;
    if (!edit) return;
    editing.current = null;
    setText(null);
    container.current?.focus({ preventScroll: true }); // Delete and Escape keep working on the chart
    const note = value?.trim().slice(0, MAX_TEXT);
    const known = drawings.some(d => d.id === edit.drawing.id);
    if (!note || (!known && drawings.length >= MAX_DRAWINGS)) return;
    onDrawings(known ? drawings.map(d => d.id === edit.drawing.id ? { ...d, text: note } : d) : [...drawings, { ...edit.drawing, text: note }]);
    onSelect(edit.drawing.id);
  };

  // The legend reads the candle under the crosshair (the latest otherwise) and each indicator's value there. Indicator
  // values end with the latest candle, so the one for candle i sits (candles − values) places earlier. (Everything here
  // reads chartRef when called: a render-time copy of the chart object would keep every earlier chart alive.)
  const list = bars.current;
  const index = hover === null ? list.length - 1 : barIndex(list, hover);
  const valuesOf = inst => { const st = chartRef.current?.studies.get(inst.id); return st && index >= 0 ? st.data.map(points => points[index - (list.length - points.length)]?.value ?? null) : null; };
  const paneTop = inst => { const st = chartRef.current?.studies.get(inst.id); return st ? paneTops[st.series[0].getPane().paneIndex()] : undefined; };
  const drawing = !prefs.locked && !prefs.hidden ? drawings.find(d => d.id === selected) : null;
  const surface = PALETTES[theme].surface;
  const textColor = color => readable(color, surface);
  const legend = inst => <StudyLegend key={inst.id} study={inst} values={valuesOf(inst)} decimals={market.priceDecimals} textColor={textColor} {...studyActions} />;
  return <>
    <div className={`price-chart ${tool === 'cursor' ? '' : 'drawing'}`} ref={container} tabIndex={0} role="group" aria-label={`${market.name} price chart from GMTrade. Drag in any direction to pan, pinch or scroll to zoom, double-click the price axis to fit prices.`} />
    <Legend market={market} interval={interval} live={live} bar={list[index]} prevClose={list[index - 1]?.close} drawing={tool !== 'cursor'} legendRef={legendBox}>{studies.filter(s => !STUDIES[s.type].pane).map(legend)}</Legend>
    {studies.filter(s => STUDIES[s.type].pane).map(inst => { const top = paneTop(inst); return top === undefined ? null : <div key={inst.id} className="tv-pane-legend" style={{ top: top + 4 }}>{legend(inst)}</div>; })}
    {drawing && <div className="tv-selection" role="group" aria-label="Selected drawing" data-tip-side="bottom" style={{ '--legend-h': `${legendHeight}px` }}>
      <label className="tv-swatch" data-tip="Colour"><input type="color" value={drawing.color} aria-label="Drawing colour" onChange={e => onDrawings(drawings.map(d => d.id === drawing.id ? { ...d, color: e.target.value } : d))} /><i style={{ background: drawing.color }} /></label>
      {drawing.type === 'text' && <button type="button" aria-label="Edit text" data-tip="Edit text" onClick={() => chartRef.current?.layer.edit(drawing.id)}><Type size={15} /></button>}
      <button type="button" aria-label="Remove drawing" data-tip="Remove drawing" onClick={() => { onDrawings(drawings.filter(d => d.id !== drawing.id)); onSelect(null); }}><Trash2 size={15} /></button>
    </div>}
    {text && <TextEditor edit={text} onDone={endText} />}
    {notice && <div className="tv-notice" role="status">{notice}</div>}
    {behind && <button type="button" className="tv-latest" aria-label="Scroll to the latest candle" data-tip="Scroll to the latest candle" style={{ right: (chartRef.current?.series.priceScale().width() ?? 60) + 10 }} onClick={() => chartRef.current?.chart.timeScale().scrollToRealTime()}><ChevronsRight size={15} /></button>}
  </>;
}
