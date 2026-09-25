import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, Crosshair, Eye, EyeOff, GitCommitHorizontal, GitCommitVertical, Lock, LockOpen, Magnet, PencilLine, RectangleHorizontal, Ruler, Trash2, Type, ZoomIn } from 'lucide-react';
import { MAX_DRAWINGS } from './storage.js';
import { FibIcon, HorizontalRayIcon, Menu, RayIcon, TrendLineIcon } from './Toolbar.jsx';

/** The line tools share one button, as on TradingView: it shows the last one picked, its arrow lists them all. */
const LINES = [
  { value: 'trend', label: 'Trend line', icon: TrendLineIcon },
  { value: 'ray', label: 'Ray', icon: RayIcon },
  { value: 'hline', label: 'Horizontal line', icon: GitCommitHorizontal },
  { value: 'hray', label: 'Horizontal ray', icon: HorizontalRayIcon },
  { value: 'vline', label: 'Vertical line', icon: GitCommitVertical },
];

function Tool({ label, icon: Icon, active, onClick, disabled = false, className = '' }) {
  return <button type="button" className={`tv-tool ${active ? 'active' : ''} ${className}`} aria-label={label} data-tip={label} aria-pressed={active} disabled={disabled} onClick={onClick}><Icon size={20} strokeWidth={1.6} /></button>;
}

/** Which ends of a scrolling box hide more of its content. */
function useOverflow(ref) {
  const [more, setMore] = useState({ up: false, down: false });
  useEffect(() => {
    const el = ref.current;
    const check = () => {
      const up = el.scrollTop > 1;
      const down = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setMore(m => m.up === up && m.down === down ? m : { up, down });
    };
    const observer = new ResizeObserver(check);
    observer.observe(el);
    el.addEventListener('scroll', check, { passive: true });
    return () => { observer.disconnect(); el.removeEventListener('scroll', check); };
  }, [ref]);
  return more;
}

/**
 * TradingView's left toolbar: drawing tools, the ruler and zoom, the drawing toggles and "remove all". When the chart is
 * too short for every tool, arrows at the ends scroll the rest into view (keyboard focus scrolls them in by itself).
 * On phones it opens over the chart (`open`); a press outside it (other than its toggle) or Escape calls `onClose`.
 */
export function DrawingToolbar({ tool, onTool, prefs, onPrefs, count, onClear, open, onClose }) {
  const [line, setLine] = useState('trend');
  const tools = useRef(null);
  const rail = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = e => { if (!rail.current?.contains(e.target) && !e.target.closest?.('.tv-draw-toggle')) onClose(); };
    const escape = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape); };
  }, [open, onClose]);
  const more = useOverflow(tools);
  const full = count >= MAX_DRAWINGS; // measure and zoom place nothing, so they stay available
  const drawingTool = label => full ? `${label} (limit of ${MAX_DRAWINGS} drawings reached)` : label;
  const current = LINES.find(l => l.value === tool) ?? LINES.find(l => l.value === line);
  const pick = next => onTool(tool === next ? 'cursor' : next);
  const toggle = key => onPrefs({ ...prefs, [key]: !prefs[key] });
  const scroll = direction => tools.current.scrollBy({ top: direction * Math.max(40, tools.current.clientHeight - 60) });
  return <div ref={rail} className={`tv-drawbar ${open ? 'open' : ''}`} role="group" aria-label="Drawing tools" data-tip-side="right">
    <div className="tv-drawbar-tools" ref={tools}>
      <Tool label="Cursor" icon={Crosshair} active={tool === 'cursor'} onClick={() => onTool('cursor')} />
      <div className="tv-tool-group">
        <Tool label={drawingTool(current.label)} icon={current.icon} active={tool === current.value} disabled={full} onClick={() => pick(current.value)} />
        {!full && <Menu label="Line tools" className="tv-group-arrow" side="right" trigger={<ChevronRight size={9} strokeWidth={2.4} />} items={LINES} value={current.value} onChange={next => { setLine(next); onTool(next); }} />}
      </div>
      <Tool label={drawingTool('Fib retracement')} icon={FibIcon} active={tool === 'fib'} disabled={full} onClick={() => pick('fib')} />
      <Tool label={drawingTool('Rectangle')} icon={RectangleHorizontal} active={tool === 'rect'} disabled={full} onClick={() => pick('rect')} />
      <Tool label={drawingTool('Text note')} icon={Type} active={tool === 'text'} disabled={full} onClick={() => pick('text')} />
      <hr />
      <Tool label="Measure" icon={Ruler} active={tool === 'measure'} onClick={() => pick('measure')} />
      <Tool label="Zoom in on a time range" icon={ZoomIn} active={tool === 'zoom'} onClick={() => pick('zoom')} />
      <hr />
      <Tool label="Magnet: snap to open, high, low or close" icon={Magnet} active={prefs.magnet} onClick={() => toggle('magnet')} />
      <Tool label="Stay in drawing mode" icon={PencilLine} active={prefs.stay} onClick={() => toggle('stay')} />
      <Tool label={prefs.locked ? 'Unlock all drawings' : 'Lock all drawings'} icon={prefs.locked ? Lock : LockOpen} active={prefs.locked} onClick={() => toggle('locked')} />
      <Tool label={prefs.hidden ? 'Show all drawings' : 'Hide all drawings'} icon={prefs.hidden ? EyeOff : Eye} active={prefs.hidden} onClick={() => toggle('hidden')} />
      <hr />
      <Tool label={count ? `Remove all drawings (${count})` : 'Remove all drawings'} icon={Trash2} disabled={!count} onClick={onClear} />
    </div>
    {more.up && <button type="button" className="tv-drawbar-scroll up" tabIndex={-1} aria-hidden="true" onClick={() => scroll(-1)}><ChevronUp size={15} /></button>}
    {more.down && <button type="button" className="tv-drawbar-scroll down" tabIndex={-1} aria-hidden="true" onClick={() => scroll(1)}><ChevronDown size={15} /></button>}
  </div>;
}
