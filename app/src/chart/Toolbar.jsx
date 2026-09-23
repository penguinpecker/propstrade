import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChartArea, ChartCandlestick, ChartLine, Expand, Layers3, PencilRuler } from 'lucide-react';

/** Glyphs lucide has no match for, drawn in its 24-unit stroke style. */
const glyph = paths => function Glyph({ size = 18, strokeWidth = 1.6 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>;
};
export const TrendLineIcon = glyph(<><path d="M6.4 17.6 17.6 6.4" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="5" r="2" /></>);
export const RayIcon = glyph(<><path d="M6.4 17.6 21 3" /><circle cx="5" cy="19" r="2" /></>);
export const HorizontalRayIcon = glyph(<><circle cx="5" cy="12" r="2" /><path d="M7 12h14" /></>);
export const FibIcon = glyph(<><path d="M3 4.5h18M3 9.5h18M3 14.5h18M3 19.5h18" /><path d="m6 18 12-12" strokeDasharray="1.5 2.5" /></>);
export const BarsIcon = glyph(<path d="M8 4v15M5 7h3m0 9h3M16 6v14m-3-11h3m0 8h3" />);

const INTERVALS = ['5m', '15m', '1h', '4h', '1D'];
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

/** Interval, chart type, indicators and the Positions toggle; on phones also the drawing-tools button (lit while a tool is armed). */
export function ChartToolbar({ interval, onInterval, chartType, onChartType, onIndicators, showGuides, onShowGuides, drawTools, drawing, onDrawTools, onExpand }) {
  const type = CHART_TYPES.find(t => t.value === chartType) ?? CHART_TYPES[0];
  return <div className="chart-toolbar" data-tip-side="bottom">
    <div className="timeframes" role="group" aria-label="Candle interval">{INTERVALS.map(t => <button key={t} type="button" aria-pressed={interval === t} className={interval === t ? 'active' : ''} onClick={() => onInterval(t)}>{t}</button>)}</div>
    <span className="toolbar-divider" />
    <Menu label={`Chart type: ${type.label}`} className="tv-icon-button" trigger={<type.icon size={18} strokeWidth={1.6} />} items={CHART_TYPES} value={chartType} onChange={onChartType} />
    <span className="toolbar-divider" />
    <button type="button" className="chart-option" aria-label="Indicators" onClick={onIndicators}><span className="tv-fx" aria-hidden="true">ƒx</span><span>Indicators</span></button>
    <span className="toolbar-divider" />
    <button type="button" className={showGuides ? 'chart-option active' : 'chart-option'} aria-label="Positions" aria-pressed={showGuides} data-tip="Entry prices of your open positions" onClick={() => onShowGuides(!showGuides)}><Layers3 size={14} /><span>Positions</span></button>
    <div className="toolbar-spacer" />
    <button type="button" className={`tv-icon-button tv-draw-toggle ${drawTools || drawing ? 'active' : ''}`} aria-label="Drawing tools" aria-expanded={drawTools} onClick={onDrawTools}><PencilRuler size={17} strokeWidth={1.6} /></button>
    {onExpand && <button type="button" className="tv-icon-button" aria-label="Expand price chart" data-tip="Expand price chart" onClick={onExpand}><Expand size={16} strokeWidth={1.7} /></button>}
  </div>;
}
