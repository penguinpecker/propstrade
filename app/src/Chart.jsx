import React, { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, CrosshairMode } from 'lightweight-charts';
import { applyTick } from './lib/candles';
import { INDICATORS, bollinger, ema, macd, rsi, sma } from './lib/indicators';

/** Bars shown when a chart opens; older ones are a drag away. */
const RECENT_BARS = 120;
/** Older history loads when the view comes this close (in bars) to the first loaded candle. */
const LOAD_OLDER_WITHIN = 15;
/** A press that moves this far vertically pans the price axis (auto-scale off until "Auto" or a price-axis double-click). */
const VERTICAL_PAN_PX = 6;

const OVERLAY = { lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false };
const BAND = { ...OVERLAY, lastValueVisible: false, color: 'rgba(148,163,184,.75)' };

/** The series each indicator draws, and the points each shows for a list of bars. */
function addIndicator(chart, id, pane, colors) {
  const line = (options, values) => ({ series: chart.addSeries(LineSeries, { ...OVERLAY, ...options }, pane), values });
  switch (id) {
    case 'ma20': return [line({ color: '#f5a524' }, b => sma(b, 20))];
    case 'ma50': return [line({ color: '#3b82f6' }, b => sma(b, 50))];
    case 'ema20': return [line({ color: '#e879f9' }, b => ema(b, 20))];
    case 'bb': return [line(BAND, b => bollinger(b).upper), line({ ...BAND, lineStyle: 2 }, b => bollinger(b).middle), line(BAND, b => bollinger(b).lower)];
    case 'rsi': {
      const r = line({ color: colors.purple, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) }, b => rsi(b));
      for (const price of [70, 30]) r.series.createPriceLine({ price, color: colors.axis, lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
      return [r];
    }
    case 'macd': return [
      { series: chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane),
        values: b => macd(b).histogram.map(p => ({ ...p, color: p.value >= 0 ? colors.greenSoft : colors.redSoft })) },
      line({ color: '#3b82f6' }, b => macd(b).macd),
      line({ color: '#f5a524' }, b => macd(b).signal),
    ];
    default: return [];
  }
}

/**
 * GMTrade candles (`candles`), moved live by `tick` ({ price, ts }); `guides` are horizontal price lines ({ price, title }).
 * Drag in any direction pans; the wheel or a pinch zooms. `loadOlder(beforeTime)` supplies earlier candles as the view
 * nears the first one. `indicators` are INDICATORS ids; `resetKey` changing restores auto-scale and the latest bars.
 */
export default function PriceChart({ market, candles, tick, interval, line = false, guides = [], theme = 'dark', indicators = [], loadOlder, resetKey = 0 }) {
  const container = useRef(null);
  const chartRef = useRef(null);
  const older = useRef({ key: '', bars: [] }); // history loaded by dragging back, before `candles`
  const bars = useRef([]); // older + candles, the last one moved by ticks
  const saved = useRef(null); // the view kept across a rebuild of the same chart (an indicator toggled)
  const indicatorKey = indicators.join();
  const chartKey = `${market.symbol}:${interval}`;
  if (older.current.key !== chartKey) older.current = { key: chartKey, bars: [] };

  useEffect(() => {
    const dark = theme === 'dark';
    const colors = dark
      ? { surface: '#19181f', axis: '#afa6bc', grid: '#2b2732', border: '#35313e', purple: '#b28aff', green: '#0ecb81', red: '#f6465d', greenSoft: 'rgba(14,203,129,.55)', redSoft: 'rgba(246,70,93,.55)', entry: '#9168ba', entryBg: '#332743', entryText: '#c8a3f3' }
      : { surface: '#fdfdfb', axis: '#6e6975', grid: '#efeee9', border: '#eeece6', purple: '#8552cc', green: '#0a9e6b', red: '#e5354d', greenSoft: 'rgba(10,158,107,.5)', redSoft: 'rgba(229,53,77,.5)', entry: '#976ccc', entryBg: '#f0e8fa', entryText: '#76529b' };
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { background: { color: colors.surface }, textColor: colors.axis, fontFamily: 'Manrope, sans-serif', fontSize: 10, attributionLogo: true, panes: { separatorColor: colors.border } },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border, scaleMargins: { top: .12, bottom: .1 } },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false, rightOffset: 7, barSpacing: 6 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#b6aec3', labelBackgroundColor: '#645474' }, horzLine: { color: '#b6aec3', labelBackgroundColor: '#645474' } },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true }, handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
    });
    const series = chart.addSeries(line ? LineSeries : CandlestickSeries, line ? { color: colors.purple, lineWidth: 2 } : { upColor: colors.green, downColor: colors.red, wickUpColor: colors.green, wickDownColor: colors.red, borderVisible: false });
    series.applyOptions({ priceLineColor: line ? '#7946bc' : colors.green, priceFormat: { type: 'price', precision: market.priceDecimals, minMove: 10 ** -market.priceDecimals } });
    // Overlays share the price pane; RSI and MACD each get a pane of their own below it.
    let pane = 0;
    const studies = INDICATORS.filter(i => indicators.includes(i.id)).flatMap(i => addIndicator(chart, i.id, i.pane ? ++pane : 0, colors));
    chart.panes()[0]?.setStretchFactor(3);
    const showRecent = () => { const n = bars.current.length; if (n) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - RECENT_BARS), to: n - 1 + 7 }); };
    const current = chartRef.current = { chart, series, studies, line, colors, priceLines: [], showRecent, placed: false };

    // The price axis follows a vertical drag, as on TradingView: auto-scale is switched off as a press starts (the chart
    // only pans prices when it is off then) and back on when the press ends without moving vertically.
    const el = container.current;
    let press = null;
    const scale = () => series.priceScale();
    const down = e => { if (e.button !== 0 || !scale().options().autoScale) return; press = { y: e.clientY, moved: false }; scale().applyOptions({ autoScale: false }); };
    const move = e => { if (press && Math.abs(e.clientY - press.y) >= VERTICAL_PAN_PX) press.moved = true; };
    const up = () => { if (press && !press.moved) scale().applyOptions({ autoScale: true }); press = null; };
    el.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);

    // Older history when the view nears the first loaded candle; a failed load is retried after a pause.
    let loading = false;
    let exhausted = false;
    const onRange = async range => {
      if (!range || range.from > LOAD_OLDER_WITHIN || loading || exhausted || !loadOlder || !bars.current.length) return;
      loading = true;
      try {
        const first = bars.current[0].time;
        const earlier = (await loadOlder(first)).filter(c => c.time < first);
        if (chartRef.current !== current) return;
        if (!earlier.length) { exhausted = true; return; }
        const view = chart.timeScale().getVisibleLogicalRange();
        older.current.bars = [...earlier, ...older.current.bars];
        bars.current = [...earlier, ...bars.current];
        draw(current, bars.current);
        if (view) chart.timeScale().setVisibleLogicalRange({ from: view.from + earlier.length, to: view.to + earlier.length });
      } catch {
        await new Promise(r => setTimeout(r, 10_000));
      } finally {
        loading = false;
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    // Re-show the latest bars only when the plot width changes; ordinary chart pan/zoom remains user-controlled.
    let width = 0;
    let resizeFrame;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = Math.round(entry.contentRect.width);
      if (nextWidth === width || nextWidth <= 0) return;
      const first = width === 0;
      width = nextWidth;
      if (first && current.restored) return; // a rebuild keeps its view
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(showRecent);
    });
    observer.observe(el);
    return () => {
      saved.current = { key: chartKey, range: chart.timeScale().getVisibleLogicalRange(), autoScale: scale().options().autoScale };
      el.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      chart.remove();
      chartRef.current = null;
    };
  }, [market.symbol, market.priceDecimals, interval, line, theme, indicatorKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const current = chartRef.current;
    if (!current) return;
    const first = candles[0]?.time ?? Infinity;
    bars.current = [...older.current.bars.filter(c => c.time < first), ...candles];
    draw(current, bars.current);
    if (current.placed || !bars.current.length) return;
    current.placed = true;
    // First data of this chart: the view it had before a rebuild, else the latest bars. Later refetches keep pan and zoom.
    const keep = saved.current?.key === chartKey ? saved.current : null;
    saved.current = null;
    current.restored = Boolean(keep?.range);
    if (keep?.range) {
      current.chart.timeScale().setVisibleLogicalRange(keep.range);
      current.series.priceScale().applyOptions({ autoScale: keep.autoScale });
    } else current.showRecent();
  }, [candles, market.symbol, interval, line, theme, indicatorKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const current = chartRef.current;
    if (!current || !tick) return;
    const bar = applyTick(bars.current.at(-1), tick.price, tick.ts, interval);
    if (!bar) return;
    bars.current = bar.time === bars.current.at(-1)?.time ? [...bars.current.slice(0, -1), bar] : [...bars.current, bar];
    current.series.update(current.line ? { time: bar.time, value: bar.close } : bar);
    for (const s of current.studies) { const last = s.values(bars.current).at(-1); if (last?.time === bar.time) s.series.update(last); }
  }, [tick, candles, market.symbol, interval, line, theme, indicatorKey]);

  useEffect(() => {
    const current = chartRef.current;
    if (!current) return;
    for (const priceLine of current.priceLines) current.series.removePriceLine(priceLine);
    current.priceLines = guides.map(g => current.series.createPriceLine({ price: g.price, color: current.colors.entry, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: g.title, axisLabelColor: current.colors.entryBg, axisLabelTextColor: current.colors.entryText }));
  }, [guides, market.symbol, interval, line, theme, indicatorKey]);

  // "Auto": prices fit the view again and the latest bars are shown.
  useEffect(() => {
    const current = chartRef.current;
    if (!current || !resetKey) return;
    current.series.priceScale().applyOptions({ autoScale: true });
    current.showRecent();
  }, [resetKey]);

  return <div className="price-chart" ref={container} aria-label={`${market.name} price chart from GMTrade. Drag in any direction to pan, pinch or scroll to zoom, double-click the price axis to fit prices.`} />;
}

function draw(current, list) {
  current.series.setData(current.line ? list.map(c => ({ time: c.time, value: c.close })) : list);
  for (const s of current.studies) s.series.setData(s.values(list));
}
