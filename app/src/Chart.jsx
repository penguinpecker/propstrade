import React, { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, CrosshairMode } from 'lightweight-charts';
import { makeCandles } from './data.js';

export default function PriceChart({ market, interval, line = false, guides = true, theme = 'dark' }) {
  const container = useRef(null);
  useEffect(() => {
    const dark = theme === 'dark';
    const colors = dark ? { surface: '#19181f', axis: '#afa6bc', grid: '#2b2732', border: '#35313e', purple: '#b28aff', green: '#6caf95', red: '#ca7d8b', volumeUp: '#274239', volumeDown: '#493039', entryBg: '#332743', entryText: '#c8a3f3' } : { surface: '#fdfdfb', axis: '#6e6975', grid: '#efeee9', border: '#eeece6', purple: '#8552cc', green: '#459583', red: '#c27878', volumeUp: '#d9e8df', volumeDown: '#efdedd', entryBg: '#f0e8fa', entryText: '#76529b' };
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { background: { color: colors.surface }, textColor: colors.axis, fontFamily: 'Manrope, sans-serif', fontSize: 10, attributionLogo: true },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border, scaleMargins: { top: .12, bottom: .22 } },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false, rightOffset: 7, barSpacing: 6, fixLeftEdge: true },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#b6aec3', labelBackgroundColor: '#645474' }, horzLine: { color: '#b6aec3', labelBackgroundColor: '#645474' } },
      handleScale: { mouseWheel: true, pinch: true }, handleScroll: { mouseWheel: false, pressedMouseMove: true },
    });
    const data = makeCandles(market, interval);
    const series = chart.addSeries(line ? LineSeries : CandlestickSeries, line ? { color: colors.purple, lineWidth: 2 } : { upColor: colors.green, downColor: colors.red, wickUpColor: colors.green, wickDownColor: colors.red, borderVisible: false });
    const lastCandle = data[data.length - 1];
    series.applyOptions({ priceLineColor: line ? '#7946bc' : lastCandle.close >= lastCandle.open ? '#267963' : '#a24c58', priceFormat: { type: 'price', precision: market.price < 2 ? 5 : 2, minMove: market.price < 2 ? .00001 : .01 } });
    series.setData(line ? data.map(c => ({ time: c.time, value: c.close })) : data);
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', priceLineVisible: false, lastValueVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: .83, bottom: .035 } });
    volume.setData(data.map((c, i) => ({ time: c.time, value: (Math.sin(i * 2.5) + 1.6) * 420 + Math.abs(c.close - c.open) * 5, color: c.close >= c.open ? colors.volumeUp : colors.volumeDown })));
    if (guides) series.createPriceLine({ price: market.price * .98314, color: dark ? '#9168ba' : '#976ccc', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'Entry', axisLabelColor: colors.entryBg, axisLabelTextColor: colors.entryText });
    chart.timeScale().fitContent();
    // Refit only when the plot width changes; ordinary chart pan/zoom remains user-controlled.
    let width = 0;
    let resizeFrame;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = Math.round(entry.contentRect.width);
      if (nextWidth === width || nextWidth <= 0) return;
      width = nextWidth;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => chart.timeScale().fitContent());
    });
    observer.observe(container.current);
    return () => { observer.disconnect(); cancelAnimationFrame(resizeFrame); chart.remove(); };
  }, [market.symbol, interval, line, guides, theme]);
  return <div className="price-chart" ref={container} aria-label={`${market.name} interactive sample price chart. Drag to pan, pinch or scroll to zoom.`} />;
}
