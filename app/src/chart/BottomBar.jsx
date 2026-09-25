import React, { useEffect, useState } from 'react';
import { ArrowUpRight, CalendarDays } from 'lucide-react';
import { usePopup } from './Toolbar.jsx';

/** Each range with the interval that suits it; older candles load as needed to fill it. */
const RANGES = [
  { label: '1d', name: '1 day', interval: '5m', days: 1 },
  { label: '5d', name: '5 days', interval: '15m', days: 5 },
  { label: '1m', name: '1 month', interval: '1h', days: 30 },
  { label: '3m', name: '3 months', interval: '4h', days: 91 },
  { label: '6m', name: '6 months', interval: '4h', days: 182 },
  { label: '1y', name: '1 year', interval: '1D', days: 365 },
  { label: '5y', name: '5 years', interval: '1W', days: 1826 },
];

function Clock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id); }, []);
  const iso = new Date(now).toISOString();
  return <time className="tv-clock" dateTime={iso}>{iso.slice(11, 19)} (UTC)</time>;
}

/** The calendar button: a date field whose date the chart scrolls to. */
function GoToDate({ onGoTo }) {
  const popup = usePopup('top');
  const [value, setValue] = useState('');
  useEffect(() => { if (popup.at) popup.box.current.querySelector('input').focus({ preventScroll: true }); }, [popup.at]);
  const submit = e => {
    e.preventDefault();
    const time = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(time)) return;
    onGoTo(time / 1000);
    popup.close();
  };
  return <>
    <button ref={popup.button} type="button" className="tv-icon-button" aria-label="Go to date" data-tip="Go to date" aria-expanded={popup.at !== null} onClick={popup.toggle}><CalendarDays size={15} strokeWidth={1.7} /></button>
    {popup.at && <form ref={popup.box} className="tv-popover" style={popup.at} onSubmit={submit} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); popup.close(); } }}>
      <label><span>Go to date (UTC)</span><input type="date" required min="2015-01-01" max={new Date().toISOString().slice(0, 10)} value={value} onChange={e => setValue(e.target.value)} /></label>
      <button type="submit" className="button primary small">Go to</button>
    </form>}
  </>;
}

/**
 * Ranges and go-to-date on the left; the price source, TradingView attribution, UTC clock and price-scale modes on the
 * right. When the chart is too narrow for one row, the source and attribution take a row of their own (never cut short).
 */
export function BottomBar({ onRange, onGoTo, source, saved, scaleMode, onScaleMode, autoScale, onAutoScale }) {
  const mode = next => onScaleMode(scaleMode === next ? 'normal' : next);
  return <div className={`tv-bottom ${saved ? 'saved' : ''}`} data-tip-side="top">
    <div className="tv-ranges" role="group" aria-label="Time range">{RANGES.map(r => <button key={r.label} type="button" aria-label={`${r.label}: ${r.name} on ${r.interval} candles`} data-tip={`${r.name} · ${r.interval} candles`} onClick={() => onRange(r.interval, r.days * 86_400)}>{r.label}</button>)}</div>
    <span className="toolbar-divider" />
    <GoToDate onGoTo={onGoTo} />
    <span className="tv-meta"><span className="tv-source">{source}</span><a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView <ArrowUpRight size={10} /></a></span>
    <span className="toolbar-divider tv-clock-rule" />
    <Clock />
    <span className="toolbar-divider tv-scale-rule" />
    <div className="tv-scale" role="group" aria-label="Price scale">
      <button type="button" aria-label="Percent scale" data-tip="Percentage scale" aria-pressed={scaleMode === 'percent'} onClick={() => mode('percent')}>%</button>
      <button type="button" aria-label="Log scale" data-tip="Logarithmic scale" aria-pressed={scaleMode === 'log'} onClick={() => mode('log')}>log</button>
      <button type="button" aria-label="Auto scale" data-tip="Fit prices to the view" aria-pressed={autoScale} onClick={() => onAutoScale(!autoScale)}>auto</button>
    </div>
  </div>;
}
