import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChartArea, ChartCandlestick, ChartLine, ChevronDown, Expand, Layers3, PencilRuler, Star } from 'lucide-react';
import { INTERVALS } from '../lib/candles';

/** Glyphs lucide has no match for, drawn in its 24-unit stroke style. */
const glyph = paths => function Glyph({ size = 18, strokeWidth = 1.6 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>;
};
export const TrendLineIcon = glyph(<><path d="M6.4 17.6 17.6 6.4" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="5" r="2" /></>);
export const RayIcon = glyph(<><path d="M6.4 17.6 21 3" /><circle cx="5" cy="19" r="2" /></>);
export const HorizontalRayIcon = glyph(<><circle cx="5" cy="12" r="2" /><path d="M7 12h14" /></>);
export const FibIcon = glyph(<><path d="M3 4.5h18M3 9.5h18M3 14.5h18M3 19.5h18" /><path d="m6 18 12-12" strokeDasharray="1.5 2.5" /></>);
export const BarsIcon = glyph(<path d="M8 4v15M5 7h3m0 9h3M16 6v14m-3-11h3m0 8h3" />);

/** Every interval, grouped as TradingView's menu groups them; the pinned ones sit in the toolbar, the rest a click away. */
export const INTERVAL_GROUPS = [['Minutes', ['1m', '3m', '5m', '15m', '30m']], ['Hours', ['1h', '2h', '4h', '6h', '12h']], ['Days', ['1D', '1W', '1M']]];
const INTERVAL_NAMES = { '1m': '1 minute', '3m': '3 minutes', '5m': '5 minutes', '15m': '15 minutes', '30m': '30 minutes', '1h': '1 hour', '2h': '2 hours', '4h': '4 hours', '6h': '6 hours', '12h': '12 hours', '1D': '1 day', '1W': '1 week', '1M': '1 month' };
export const CHART_TYPES = [
  { value: 'candles', label: 'Candles', icon: ChartCandlestick },
  { value: 'bars', label: 'Bars', icon: BarsIcon },
  { value: 'line', label: 'Line', icon: ChartLine },
  { value: 'area', label: 'Area', icon: ChartArea },
];

/**
 * A popup opened by a button: fixed-positioned beside it (`side` bottom, right or top), so a scrolling toolbar never
 * clips it, and moved back inside the window when it would run off its right edge; a press outside, a resize or a
 * scroll closes it, and `close` hands focus back to the button.
 */
export function usePopup(side = 'bottom') {
  const [at, setAt] = useState(null);
  const button = useRef(null);
  const box = useRef(null);
  useEffect(() => {
    if (!at) return;
    const outside = e => { if (!box.current?.contains(e.target) && !button.current?.contains(e.target)) setAt(null); };
    const away = e => { if (e.type === 'resize' || e.target.contains?.(button.current)) setAt(null); }; // the button moved
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', away);
    window.addEventListener('scroll', away, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', away); window.removeEventListener('scroll', away, true); };
  }, [at]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!at || !el) return;
    const over = el.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);
    if (over > 0) el.style.left = `${Math.max(8, at.left - over)}px`;
  }, [at]);
  const open = () => {
    const r = button.current.getBoundingClientRect();
    setAt(side === 'right' ? { left: r.right + 6, top: r.top } : side === 'top' ? { left: r.left, bottom: window.innerHeight - r.top + 6 } : { left: r.left, top: r.bottom + 4 });
  };
  return { at, button, box, toggle: () => at ? setAt(null) : open(), close: () => { setAt(null); button.current?.focus(); } };
}

/** A button opening a list to pick one option (role=menu: arrow keys move, Enter picks, Escape closes). */
export function Menu({ label, trigger, className = '', items, value, onChange, side = 'bottom' }) {
  const popup = usePopup(side);
  useEffect(() => { if (popup.at) (popup.box.current.querySelector('[aria-checked="true"]') ?? popup.box.current.firstElementChild).focus({ preventScroll: true }); }, [popup.at]);
  const onKeyDown = e => {
    const options = [...popup.box.current.children];
    const i = options.indexOf(document.activeElement);
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: options.length - 1 }[e.key];
    if (next !== undefined) { e.preventDefault(); options[(next + options.length) % options.length].focus({ preventScroll: true }); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); popup.close(); }
  };
  return <>
    <button ref={popup.button} type="button" className={className} aria-label={label} data-tip={label} aria-haspopup="menu" aria-expanded={popup.at !== null} onClick={popup.toggle}>{trigger}</button>
    {popup.at && <div ref={popup.box} className="tv-menu" role="menu" aria-label={label} style={popup.at} onKeyDown={onKeyDown}>{items.map(({ value: v, label: text, icon: Icon }) => <button key={v} type="button" role="menuitemradio" aria-checked={v === value} onClick={() => { onChange(v); popup.close(); }}><Icon size={17} strokeWidth={1.6} /><span>{text}</span></button>)}</div>}
  </>;
}

/**
 * The pinned intervals as buttons (and the current one while it is not pinned), then a menu of every interval by
 * group, each with a star that pins or unpins it. The arrow keys move between the intervals, Enter picks, Escape
 * closes; Tab reaches the stars, and focus leaving the menu closes it.
 */
function IntervalPicker({ interval, onInterval, pinned, onPinned }) {
  const popup = usePopup();
  const options = () => [...popup.box.current.querySelectorAll('[role=menuitemradio]')];
  useEffect(() => { if (popup.at) (popup.box.current.querySelector('[aria-checked="true"]') ?? options()[0]).focus({ preventScroll: true }); }, [popup.at]);
  const onKeyDown = e => {
    const items = options();
    const i = items.indexOf(document.activeElement);
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (next !== undefined) { e.preventDefault(); items[(next + items.length) % items.length].focus({ preventScroll: true }); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); popup.close(); }
  };
  const pin = t => onPinned(pinned.includes(t) ? pinned.filter(x => x !== t) : INTERVALS.filter(x => x === t || pinned.includes(x)));
  return <div className="timeframes" role="group" aria-label="Candle interval">
    {INTERVALS.filter(t => pinned.includes(t) || t === interval).map(t => <button key={t} type="button" aria-pressed={interval === t} className={interval === t ? 'active' : ''} onClick={() => onInterval(t)}>{t}</button>)}
    <button ref={popup.button} type="button" className="tv-interval-more" aria-label="More intervals" data-tip="More intervals" aria-haspopup="menu" aria-expanded={popup.at !== null} onClick={popup.toggle}><ChevronDown size={13} /></button>
    {popup.at && <div ref={popup.box} className="tv-menu tv-intervals" role="menu" aria-label="Candle interval" style={popup.at} onKeyDown={onKeyDown} onBlur={e => { if (!popup.box.current.contains(e.relatedTarget)) popup.toggle(); }}>
      {INTERVAL_GROUPS.map(([name, list]) => <div key={name} className="tv-menu-group" role="group" aria-label={name}><span>{name}</span>{list.map(t => <div key={t} className="tv-menu-row">
        <button type="button" role="menuitemradio" aria-checked={t === interval} onClick={() => { onInterval(t); popup.close(); }}>{INTERVAL_NAMES[t]}</button>
        <button type="button" className={pinned.includes(t) ? 'pinned' : ''} aria-label={`${pinned.includes(t) ? 'Unpin' : 'Pin'} ${t}`} aria-pressed={pinned.includes(t)} onClick={() => pin(t)}><Star size={12} /></button>
      </div>)}</div>)}
    </div>}
  </div>;
}

/** Interval, chart type, indicators and the Positions toggle; on phones also the drawing-tools button (lit while a tool is armed). */
export function ChartToolbar({ interval, onInterval, pinned, onPinned, chartType, onChartType, onIndicators, showGuides, onShowGuides, drawTools, drawing, onDrawTools, onExpand }) {
  const type = CHART_TYPES.find(t => t.value === chartType) ?? CHART_TYPES[0];
  return <div className="chart-toolbar" data-tip-side="bottom">
    <IntervalPicker interval={interval} onInterval={onInterval} pinned={pinned} onPinned={onPinned} />
    <span className="toolbar-divider" />
    <Menu label={`Chart type: ${type.label}`} className="tv-icon-button" trigger={<type.icon size={18} strokeWidth={1.6} />} items={CHART_TYPES} value={chartType} onChange={onChartType} />
    <span className="toolbar-divider" />
    <button type="button" className="chart-option" aria-label="Indicators" onClick={onIndicators}><span className="tv-fx" aria-hidden="true">ƒx</span><span>Indicators</span></button>
    <span className="toolbar-divider" />
    <button type="button" className={showGuides ? 'chart-option active' : 'chart-option'} aria-label="Positions" aria-pressed={showGuides} data-tip="Entry, liquidation, take-profit and stop-loss levels of your open positions, and your resting orders" onClick={() => onShowGuides(!showGuides)}><Layers3 size={14} /><span>Positions</span></button>
    <div className="toolbar-spacer" />
    <button type="button" className={`tv-icon-button tv-draw-toggle ${drawTools || drawing ? 'active' : ''}`} aria-label="Drawing tools" aria-expanded={drawTools} onClick={onDrawTools}><PencilRuler size={17} strokeWidth={1.6} /></button>
    {onExpand && <button type="button" className="tv-icon-button" aria-label="Expand price chart" data-tip="Expand price chart" onClick={onExpand}><Expand size={16} strokeWidth={1.7} /></button>}
  </div>;
}
