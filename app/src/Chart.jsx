import React, { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries, LineSeries, CrosshairMode } from 'lightweight-charts';
import { applyTick } from './lib/candles';

/** Bars shown when a chart opens (of the 300 loaded). */
const RECENT_BARS = 120;

/** GMTrade candles (`candles`), moved live by `tick` ({ price, ts }); `guides` are horizontal price lines ({ price, title }). */
export default function PriceChart({ market, candles, tick, interval, line = false, guides = [], theme = 'dark' }) {
  const container = useRef(null);
  const chartRef = useRef(null);
  const last = useRef(null);
  useEffect(() => {
    const dark = theme === 'dark';
    const colors = dark ? { surface: '#19181f', axis: '#afa6bc', grid: '#2b2732', border: '#35313e', purple: '#b28aff', green: '#0ecb81', red: '#f6465d', entry: '#9168ba', entryBg: '#332743', entryText: '#c8a3f3' } : { surface: '#fdfdfb', axis: '#6e6975', grid: '#efeee9', border: '#eeece6', purple: '#8552cc', green: '#0a9e6b', red: '#e5354d', entry: '#976ccc', entryBg: '#f0e8fa', entryText: '#76529b' };
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { background: { color: colors.surface }, textColor: colors.axis, fontFamily: 'Manrope, sans-serif', fontSize: 10, attributionLogo: true },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border, scaleMargins: { top: .12, bottom: .1 } },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false, rightOffset: 7, barSpacing: 6, fixLeftEdge: true },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#b6aec3', labelBackgroundColor: '#645474' }, horzLine: { color: '#b6aec3', labelBackgroundColor: '#645474' } },
      handleScale: { mouseWheel: true, pinch: true }, handleScroll: { mouseWheel: false, pressedMouseMove: true },
    });
    const series = chart.addSeries(line ? LineSeries : CandlestickSeries, line ? { color: colors.purple, lineWidth: 2 } : { upColor: colors.green, downColor: colors.red, wickUpColor: colors.green, wickDownColor: colors.red, borderVisible: false });
    series.applyOptions({ priceLineColor: line ? '#7946bc' : colors.green, priceFormat: { type: 'price', precision: market.priceDecimals, minMove: 10 ** -market.priceDecimals } });
    // The latest bars at a readable width; the older ones are a drag away.
    const showRecent = () => { const n = chartRef.current?.count; if (n) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - RECENT_BARS), to: n - 1 + 7 }); };
    chartRef.current = { chart, series, line, colors, priceLines: [], count: 0, showRecent };
    // Re-show the latest bars only when the plot width changes; ordinary chart pan/zoom remains user-controlled.
    let width = 0;
    let resizeFrame;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = Math.round(entry.contentRect.width);
      if (nextWidth === width || nextWidth <= 0) return;
      width = nextWidth;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(showRecent);
    });
    observer.observe(container.current);
    return () => { observer.disconnect(); cancelAnimationFrame(resizeFrame); chart.remove(); chartRef.current = null; };
  }, [market.symbol, market.priceDecimals, interval, line, theme]);

  useEffect(() => {
    const current = chartRef.current;
    if (!current) return;
    current.series.setData(current.line ? candles.map(c => ({ time: c.time, value: c.close })) : candles);
    last.current = candles.at(-1) ?? null;
    current.count = candles.length;
    // Place the first data of each chart; later refetches keep the user's pan and zoom.
    if (!current.fitted && candles.length) { current.showRecent(); current.fitted = true; }
  }, [candles, market.symbol, interval, line, theme]);

  useEffect(() => {
    const current = chartRef.current;
    if (!current || !tick) return;
    const bar = applyTick(last.current, tick.price, tick.ts, interval);
    if (!bar) return;
    last.current = bar;
    current.series.update(current.line ? { time: bar.time, value: bar.close } : bar);
  }, [tick, candles, market.symbol, interval, line, theme]);

  useEffect(() => {
    const current = chartRef.current;
    if (!current) return;
    for (const priceLine of current.priceLines) current.series.removePriceLine(priceLine);
    current.priceLines = guides.map(g => current.series.createPriceLine({ price: g.price, color: current.colors.entry, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: g.title, axisLabelColor: current.colors.entryBg, axisLabelTextColor: current.colors.entryText }));
  }, [guides, market.symbol, interval, line, theme]);

  return <div className="price-chart" ref={container} aria-label={`${market.name} price chart from GMTrade. Drag to pan, pinch or scroll to zoom.`} />;
}
