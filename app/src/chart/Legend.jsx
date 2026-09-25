import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Eye, EyeOff, Settings, X } from 'lucide-react';
import { number, price } from '../data.js';
import { STUDIES, studyTitle } from './registry.js';

const signed = (value, digits) => `${value < 0 ? '−' : '+'}${number(Math.abs(value), digits)}`;

/**
 * One indicator instance: its name and inputs, its values in the line colours (made readable on the chart's background
 * by `textColor`) and, on hover or focus, hide, settings and remove. The buttons open right after the name, as on
 * TradingView, so they stay put while the values change.
 */
export function StudyLegend({ study, values, decimals, textColor, onToggle, onSettings, onRemove, style }) {
  const def = STUDIES[study.type];
  const title = studyTitle(study);
  const digits = def.decimals ?? decimals;
  return <div className={`tv-study ${study.hidden ? 'off' : ''}`} style={style}>
    <span className="tv-study-name">{title}</span>
    <span className="tv-study-actions" data-tip-side="bottom">
      <button type="button" aria-label={`${study.hidden ? 'Show' : 'Hide'} ${title}`} data-tip={study.hidden ? 'Show' : 'Hide'} onClick={() => onToggle(study)}>{study.hidden ? <EyeOff size={13} /> : <Eye size={13} />}</button>
      <button type="button" aria-label={`${title} settings`} data-tip="Settings" onClick={() => onSettings(study)}><Settings size={13} /></button>
      <button type="button" aria-label={`Remove ${title}`} data-tip="Remove" onClick={() => onRemove(study)}><X size={13} /></button>
    </span>
    {!study.hidden && values?.map((v, k) => v !== null && (def.lines[k].histogram
      ? <b key={k} className={v >= 0 ? 'positive' : 'negative'}>{number(v, digits)}</b>
      : <b key={k} style={{ color: textColor(study.colors[k]) }}>{number(v, digits)}</b>))}
  </div>;
}

/**
 * TradingView's legend: market, interval, source and a dot for live (green) or not (amber), then open, high, low and
 * close of the candle under the crosshair (or the latest one), coloured by its direction, and its change from the
 * previous close, coloured by its sign. The indicator rows below fold away behind one button (folded at first on
 * phones, where they would cover much of the chart); while a drawing tool is armed (`drawing`) presses pass through them.
 */
export function Legend({ market, interval, live, bar, prevClose, drawing, legendRef, children }) {
  const [folded, setFolded] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 600px)').matches === true);
  const decimals = market.priceDecimals;
  const base = prevClose ?? bar?.open;
  const change = bar ? bar.close - base : 0;
  const rows = React.Children.count(children);
  return <div className={`tv-legend ${drawing ? 'drawing' : ''}`} ref={legendRef}>
    <div className="tv-legend-main">
      <span className="tv-legend-title">{market.pair} · {interval} · Props.trade</span>
      <i className={`tv-live ${live ? 'on' : 'off'}`} role="img" aria-label={live ? 'Live prices' : 'Prices not live'} title={live ? 'Live prices' : 'Not live: the last prices received'} />
      {bar && <span className={`tv-ohlc ${bar.close < bar.open ? 'down' : 'up'}`}>{[['O', bar.open], ['H', bar.high], ['L', bar.low], ['C', bar.close]].map(([k, v]) => <span key={k}>{k}<b>{price(v, decimals)}</b></span>)}<b className={change < 0 ? 'down' : 'up'}>{signed(change, decimals)} ({signed(base ? change / base * 100 : 0, 2)}%)</b></span>}
    </div>
    {!folded && children}
    {rows > 0 && <button type="button" className="tv-legend-fold" aria-expanded={!folded} aria-label={folded ? `Show ${rows} indicator ${rows === 1 ? 'row' : 'rows'}` : 'Hide the indicator rows'} data-tip={folded ? 'Show indicators' : 'Hide indicators'} onClick={() => setFolded(!folded)}>
      {folded ? <><ChevronDown size={13} />{rows}</> : <ChevronUp size={13} />}
    </button>}
  </div>;
}
