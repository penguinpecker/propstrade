// Drawing tools on the price pane. One series primitive (lightweight-charts' plugin API: paneViews + hitTest + axis
// views) paints every drawing, the one being placed and the ruler / zoom in progress; the chart's pointer handlers pass
// presses here first. Drawings are anchored to time + price, never to bar indexes, so they stay put when the interval
// changes or older history is prepended.
import { newId } from './registry.js';
import { DRAWING_COLOR, DRAWING_POINTS, MAX_DRAWINGS } from './storage.js';

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const LINE_HIT = 6; // px from a line that still hovers it
const HANDLE = 4.5;
const DRAG_START = 3; // px a press moves before it drags a drawing
const CLICK = 6; // a press that moves less is a click: a two-point tool then waits for a second click
const NO_SCROLL = { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false };
const FONT = '500 12px Manrope, sans-serif';
const SMALL = '500 10px Manrope, sans-serif';
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

/** Fractional bar index of a time: interpolated between candles, extrapolated by the interval before the first and after the last. */
export function timeToLogical(bars, step, time) {
  const n = bars.length;
  if (!n) return null;
  if (time <= bars[0].time) return (time - bars[0].time) / step;
  if (time >= bars[n - 1].time) return n - 1 + (time - bars[n - 1].time) / step;
  let lo = 0;
  let hi = n - 1; // bars[lo].time <= time < bars[hi].time
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (bars[mid].time <= time) lo = mid; else hi = mid; }
  return lo + (time - bars[lo].time) / (bars[hi].time - bars[lo].time);
}

export function logicalToTime(bars, step, logical) {
  const n = bars.length;
  if (!n) return null;
  if (logical <= 0) return bars[0].time + logical * step;
  if (logical >= n - 1) return bars[n - 1].time + (logical - n + 1) * step;
  const i = Math.floor(logical);
  return bars[i].time + (logical - i) * (bars[i + 1].time - bars[i].time);
}

const pad = n => String(n).padStart(2, '0');
/** "24 Sep '26 14:00" in UTC, as the chart's time axis reads; the date alone on daily candles. */
export function formatTime(time, step) {
  const d = new Date(time * 1000);
  const day = `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
  return step >= 86_400 ? day : `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
/** "3d 4h", "2h 15m", "45m". */
export function formatSpan(seconds) {
  const s = Math.abs(Math.round(seconds));
  const [d, h, m] = [Math.floor(s / 86_400), Math.floor(s % 86_400 / 3600), Math.floor(s % 3600 / 60)];
  return [d && `${d}d`, h && `${h}h`, !d && m && `${m}m`].filter(Boolean).join(' ') || '0m';
}

export const rgba = (hex, alpha) => `rgba(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',')},${alpha})`;
/** Text colour readable on a label of this colour. */
export const ink = hex => [1, 3, 5].reduce((sum, i, k) => sum + parseInt(hex.slice(i, i + 2), 16) * [0.299, 0.587, 0.114][k], 0) > 165 ? '#17151c' : '#ffffff';
const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = hex => { const [r, g, b] = channels(hex).map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** WCAG contrast ratio of two #rrggbb colours. */
export const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
/** `hex` for text on `surface`: as it is when it reads at 4.5:1, else darkened (light surface) or lightened (dark) until it does. */
export function readable(hex, surface) {
  const toward = luminance(surface) > 0.5 ? 0 : 255;
  for (let k = 0; k <= 20; k++) {
    const color = `#${channels(hex).map(v => Math.round(v + (toward - v) * k / 20).toString(16).padStart(2, '0')).join('')}`;
    if (contrast(color, surface) >= 4.5) return color;
  }
  return toward ? '#ffffff' : '#000000';
}
const crisp = v => Math.round(v) + 0.5;
const line = (ctx, x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
/** A point far along a→b, beyond any edge of the pane. */
const rayEnd = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1; return { x: b.x + dx / len * 1e4, y: b.y + dy / len * 1e4 }; };
function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
const within = (p, a, b, margin) => p.x >= Math.min(a.x, b.x) - margin && p.x <= Math.max(a.x, b.x) + margin && p.y >= Math.min(a.y, b.y) - margin && p.y <= Math.max(a.y, b.y) + margin;
function arrow(ctx, x1, y1, x2, y2) {
  line(ctx, x1, y1, x2, y2);
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 10) return;
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  ctx.beginPath(); ctx.moveTo(x2 - ux * 6 - uy * 4, y2 - uy * 6 + ux * 4); ctx.lineTo(x2, y2); ctx.lineTo(x2 - ux * 6 + uy * 4, y2 - uy * 6 - ux * 4); ctx.stroke();
}

/**
 * The drawings of one chart. `bars()` returns the candles on the chart (sorted by time), `step` the interval in
 * seconds, `scroll` the chart's own handleScroll options, `formatPrice` writes a price for the labels on the plot (the
 * price axis labels follow the axis, which may read in percent). It reports through `onChange(list)` (a drawing added,
 * moved or removed), `onSelect(id)`, `onTool(tool)` (back to the cursor after a drawing) and `onText({ drawing, x, y })`
 * (a text note to type or edit). React state reaches it through `sync`.
 */
export function createDrawingLayer({ chart, series, bars, step, scroll, theme, formatPrice, onChange, onSelect, onTool, onText }) {
  const s = { drawings: [], tool: 'cursor', prefs: {}, selected: null, hover: null, draft: null, placing: null, downAt: null, drag: null, measure: null, note: null, render: null, widths: new Map(), axisKey: null, priceViews: [], timeViews: [] };
  let requestUpdate = () => {};
  const update = () => requestUpdate();
  const find = id => s.drawings.find(d => d.id === id);
  const format = price => series.priceFormatter().format(price); // as the price axis reads
  const inPane = p => { const { width, height } = chart.paneSize(0); return p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height; };

  /** Conversions between the pane's pixels and time/price for the current view, or null before there is data. */
  function frame() {
    const list = bars();
    const x0 = chart.timeScale().logicalToCoordinate(0);
    const x1 = chart.timeScale().logicalToCoordinate(1);
    if (!list.length || x0 === null || x1 === null || x1 === x0) return null;
    const spacing = x1 - x0;
    const { width, height } = chart.paneSize(0);
    return {
      bars: list, spacing, width, height,
      x: time => x0 + timeToLogical(list, step, time) * spacing,
      y: price => series.priceToCoordinate(price),
      logical: x => (x - x0) / spacing,
      price: y => series.coordinateToPrice(y),
    };
  }
  const pixels = (f, d) => { const pts = d.points.map(p => ({ x: f.x(p.time), y: f.y(p.price) })); return pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) ? pts : null; };

  /** The time and price under the pointer: on the nearest candle, and on its nearest open/high/low/close with the magnet on. */
  function pointAt(f, p) {
    const logical = Math.round(f.logical(p.x));
    let price = f.price(p.y);
    if (price === null || !Number.isFinite(price)) return null;
    const bar = s.prefs.magnet ? f.bars[logical] : undefined;
    if (bar) price = [bar.open, bar.high, bar.low, bar.close].reduce((best, v) => Math.abs(f.y(v) - p.y) < Math.abs(f.y(best) - p.y) ? v : best);
    return { time: logicalToTime(f.bars, step, logical), price };
  }

  function handles(f, d, pts) {
    const [a, b] = pts;
    if (d.type === 'rect') return [a, b, { x: a.x, y: b.y }, { x: b.x, y: a.y }];
    if (d.type === 'hline') return [{ x: Math.min(Math.max(a.x, 12), f.width - 12), y: a.y }];
    if (d.type === 'vline') return [{ x: a.x, y: f.height / 2 }];
    return d.type === 'text' ? [] : pts;
  }
  function near(d, pts, p) {
    const [a, b] = pts;
    switch (d.type) {
      case 'trend': return segmentDistance(p, a, b) <= LINE_HIT;
      case 'ray': return segmentDistance(p, a, rayEnd(a, b)) <= LINE_HIT;
      case 'hline': return Math.abs(p.y - a.y) <= LINE_HIT;
      case 'hray': return p.x >= a.x - LINE_HIT && Math.abs(p.y - a.y) <= LINE_HIT;
      case 'vline': return Math.abs(p.x - a.x) <= LINE_HIT;
      case 'text': return p.x >= a.x - 4 && p.x <= a.x + (s.widths.get(d.id) ?? d.text.length * 7) + 4 && Math.abs(p.y - a.y) <= 11;
      default: return within(p, a, b, LINE_HIT); // rect, fib
    }
  }
  /** The drawing (and handle) under a pane point: handles of the selected or hovered drawing first, then the topmost drawing. */
  function hit(p) {
    const f = frame();
    if (!f || s.prefs.hidden || s.prefs.locked) return null;
    for (const id of new Set([s.selected, s.hover?.id])) {
      const d = id && find(id);
      const pts = d && pixels(f, d);
      const k = pts ? handles(f, d, pts).findIndex(h => Math.hypot(h.x - p.x, h.y - p.y) <= HANDLE + 3) : -1;
      if (k >= 0) return { id, handle: k };
    }
    for (let i = s.drawings.length - 1; i >= 0; i--) {
      const d = s.drawings[i];
      const pts = pixels(f, d);
      if (pts && near(d, pts, p)) return { id: d.id, handle: null };
    }
    return null;
  }

  function measureOf(f, m) {
    const pts = pixels(f, m);
    if (!pts) return null;
    const [p1, p2] = m.points;
    const change = p2.price - p1.price;
    const sign = change < 0 ? '−' : '+';
    const count = Math.round(timeToLogical(f.bars, step, p2.time) - timeToLogical(f.bars, step, p1.time));
    return { pts, up: change >= 0, lines: [`${sign}${formatPrice(Math.abs(change))} (${sign}${Math.abs(change / p1.price * 100).toFixed(2)}%)`, `${count} ${Math.abs(count) === 1 ? 'bar' : 'bars'}, ${formatSpan(p2.time - p1.time)}`] };
  }
  /** What the next frame paints, in pane pixels. */
  function build() {
    const f = frame();
    if (!f) return null;
    const item = (d, hot) => { const pts = pixels(f, d); return pts && { d, pts, hot, handles: hot ? handles(f, d, pts) : [] }; };
    const transient = s.draft && (s.draft.type === 'measure' || s.draft.type === 'zoom');
    return {
      items: s.prefs.hidden ? [] : s.drawings.map(d => item(d, d.id === s.selected || d.id === s.hover?.id)).filter(Boolean),
      draft: s.draft && !transient ? item(s.draft, true) : null,
      measure: s.draft?.type === 'measure' ? measureOf(f, s.draft) : s.measure && measureOf(f, s.measure),
      zoom: s.draft?.type === 'zoom' ? pixels(f, s.draft) : null,
    };
  }

  function paintFib(ctx, d, a, b) {
    const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
    const [p1, p2] = d.points.map(p => p.price);
    const levels = FIB_LEVELS.map(level => ({ level, price: p2 + (p1 - p2) * level })).map(l => ({ ...l, y: series.priceToCoordinate(l.price) })).filter(l => Number.isFinite(l.y));
    levels.slice(1).forEach((l, i) => { ctx.fillStyle = rgba(d.color, i % 2 ? 0.1 : 0.05); ctx.fillRect(left, levels[i].y, right - left, l.y - levels[i].y); });
    ctx.font = SMALL; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.lineJoin = 'round';
    for (const l of levels) { ctx.lineWidth = 1; ctx.strokeStyle = d.color; line(ctx, left, crisp(l.y), right, crisp(l.y)); }
    ctx.setLineDash([4, 4]); ctx.strokeStyle = rgba(d.color, 0.7); line(ctx, a.x, a.y, b.x, b.y); ctx.setLineDash([]);
    // Labels last, each ringed in the chart's background so candles and lines behind never cut through the digits.
    ctx.lineWidth = 3; ctx.strokeStyle = theme.surface; ctx.fillStyle = readable(d.color, theme.surface);
    for (const l of levels) { const text = `${l.level} (${formatPrice(l.price)})`; ctx.strokeText(text, left + 4, l.y - 2); ctx.fillText(text, left + 4, l.y - 2); }
  }
  function paint(ctx, { d, pts, hot, handles: points }, width, height) {
    const [a, b] = pts;
    ctx.strokeStyle = d.color; ctx.lineWidth = 1;
    switch (d.type) {
      case 'trend': ctx.lineWidth = 2; line(ctx, a.x, a.y, b.x, b.y); break;
      case 'ray': { ctx.lineWidth = 2; const end = rayEnd(a, b); line(ctx, a.x, a.y, end.x, end.y); break; }
      case 'hline': line(ctx, 0, crisp(a.y), width, crisp(a.y)); break;
      case 'hray': line(ctx, a.x, crisp(a.y), width, crisp(a.y)); break;
      case 'vline': line(ctx, crisp(a.x), 0, crisp(a.x), height); break;
      case 'rect': {
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
        ctx.fillStyle = rgba(d.color, 0.14); ctx.fillRect(x, y, w, h); ctx.strokeRect(crisp(x), crisp(y), Math.round(w), Math.round(h)); break;
      }
      case 'fib': paintFib(ctx, d, a, b); break;
      case 'text': {
        ctx.font = FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const w = ctx.measureText(d.text).width;
        s.widths.set(d.id, w);
        if (hot) { ctx.strokeStyle = rgba(d.color, 0.8); ctx.strokeRect(crisp(a.x - 5), crisp(a.y - 11), Math.round(w + 10), 22); }
        ctx.fillStyle = readable(d.color, theme.surface); ctx.fillText(d.text, a.x, a.y); break;
      }
    }
    for (const h of points) { ctx.beginPath(); ctx.arc(h.x, h.y, HANDLE, 0, Math.PI * 2); ctx.fillStyle = theme.surface; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = d.color; ctx.stroke(); }
  }
  function paintMeasure(ctx, { pts: [a, b], up, lines }, width, height) {
    const color = up ? theme.up : theme.down;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    ctx.fillStyle = rgba(color, 0.16); ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    arrow(ctx, crisp((a.x + b.x) / 2), a.y, crisp((a.x + b.x) / 2), b.y);
    arrow(ctx, a.x, crisp((a.y + b.y) / 2), b.x, crisp((a.y + b.y) / 2));
    ctx.font = SMALL;
    const lw = Math.max(...lines.map(t => ctx.measureText(t).width)) + 18, lh = 38;
    const lx = Math.min(Math.max((a.x + b.x) / 2 - lw / 2, 4), width - lw - 4);
    const ly = up ? Math.max(y - lh - 6, 4) : Math.min(y + h + 6, height - lh - 4);
    ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(lx, ly, lw, lh, 4); ctx.fill();
    ctx.fillStyle = ink(color); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(lines[0], lx + lw / 2, ly + 12); ctx.fillText(lines[1], lx + lw / 2, ly + 26);
  }
  function draw(target) {
    const r = s.render;
    if (!r) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize: { width, height } }) => {
      ctx.save();
      for (const item of r.items) paint(ctx, item, width, height);
      if (r.draft) paint(ctx, r.draft, width, height);
      if (r.measure) paintMeasure(ctx, r.measure, width, height);
      if (r.zoom) {
        const [a, b] = r.zoom, x = Math.min(a.x, b.x), w = Math.abs(b.x - a.x);
        ctx.fillStyle = rgba(theme.accent, 0.12); ctx.fillRect(x, 0, w, height);
        ctx.strokeStyle = theme.accent; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.strokeRect(crisp(x), 0.5, Math.round(w), height - 1);
      }
      ctx.restore();
    });
  }

  // Price-axis labels for horizontal lines and rays, time-axis labels for vertical lines, in the drawing's colour.
  const label = (id, coordinate, text) => ({
    coordinate: () => { const d = find(id); return (d && coordinate(d)) ?? -1e4; },
    text: () => { const d = find(id); return d ? text(d) : ''; },
    textColor: () => ink(find(id)?.color ?? DRAWING_COLOR),
    backColor: () => find(id)?.color ?? DRAWING_COLOR,
    visible: () => !s.prefs.hidden && find(id) !== undefined,
    tickVisible: () => true,
  });
  function setList(list) {
    s.drawings = list;
    const key = list.filter(d => ['hline', 'hray', 'vline'].includes(d.type)).map(d => d.id).join();
    if (key === s.axisKey) return; // the library wants the same arrays until the set of labels changes
    s.axisKey = key;
    s.priceViews = list.filter(d => d.type === 'hline' || d.type === 'hray').map(d => label(d.id, x => series.priceToCoordinate(x.points[0].price), x => format(x.points[0].price)));
    s.timeViews = list.filter(d => d.type === 'vline').map(d => label(d.id, x => frame()?.x(x.points[0].time) ?? null, x => formatTime(x.points[0].time, step)));
  }

  const select = id => { s.selected = id; onSelect(id); update(); };
  const done = () => { if (!s.prefs.stay) onTool('cursor'); };
  function create({ type, points }) {
    if (s.drawings.length >= MAX_DRAWINGS) { onTool('cursor'); return; } // the toolbar says so; more would not be kept
    const d = { id: newId('d'), type, points, color: DRAWING_COLOR };
    done();
    if (type === 'text') { const f = frame(); onText({ drawing: d, x: f.x(points[0].time), y: f.y(points[0].price) }); return; }
    setList([...s.drawings, d]);
    onChange(s.drawings);
    select(d.id);
  }
  function finish() {
    const d = s.draft;
    const f = frame();
    s.draft = null;
    s.placing = null;
    const pts = f && pixels(f, d);
    if (!pts || Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) < 2) { update(); return; } // both clicks on one spot: nothing drawn
    if (d.type === 'zoom') {
      const [from, to] = d.points.map(p => timeToLogical(f.bars, step, p.time)).sort((x, y) => x - y);
      if (to - from >= 2) chart.timeScale().setVisibleLogicalRange({ from, to });
      done(); update(); return;
    }
    if (d.type === 'measure') { s.measure = d; done(); update(); return; }
    create(d);
  }
  function place(f, p) {
    const at = pointAt(f, p);
    if (!at) return;
    if (s.draft) { s.draft.points[1] = at; finish(); return; }
    if (s.tool === 'text') { s.note = at; return; } // its editor opens on release: the chart takes focus as the button goes down
    if (DRAWING_POINTS[s.tool] === 1) { create({ type: s.tool, points: [at] }); return; }
    s.draft = { id: 'new', type: s.tool, points: [at, at], color: DRAWING_COLOR };
    s.placing = 'first';
    s.downAt = p;
    update();
  }

  /** A press on the chart at pane point `p`: true when drawing took it (the chart must not pan). */
  function down(e, p) {
    if (!e.isPrimary || !inPane(p)) return false;
    const f = frame();
    if (!f) return false;
    if (s.measure && !s.draft) { s.measure = null; update(); }
    if (s.tool !== 'cursor') { place(f, p); return true; }
    const h = hit(p);
    if (!h) { if (s.selected) select(null); return false; }
    select(h.id);
    s.drag = { id: h.id, handle: h.handle, start: p, moved: false, orig: find(h.id).points.map(pt => ({ ...pt, l: timeToLogical(f.bars, step, pt.time), y: f.y(pt.price) })) };
    chart.applyOptions({ handleScroll: NO_SCROLL });
    return true;
  }
  function dragTo(p) {
    const g = s.drag;
    const d = find(g.id);
    const f = frame();
    if (!d || !f) return;
    const dx = p.x - g.start.x, dy = p.y - g.start.y;
    if (!g.moved && Math.hypot(dx, dy) < DRAG_START) return;
    g.moved = true;
    let points;
    if (g.handle === null) { // the whole drawing, by whole candles
      const shift = Math.round(dx / f.spacing);
      points = g.orig.map(o => ({ time: logicalToTime(f.bars, step, o.l + shift), price: (o.y === null ? null : f.price(o.y + dy)) ?? o.price }));
    } else {
      const at = pointAt(f, p);
      if (!at) return;
      points = g.orig.map(o => ({ time: o.time, price: o.price }));
      if (d.type === 'rect' && g.handle > 1) { const [t, q] = g.handle === 2 ? [0, 1] : [1, 0]; points[t].time = at.time; points[q].price = at.price; } // the two derived corners
      else points[g.handle] = at;
    }
    s.drawings = s.drawings.map(x => x.id === g.id ? { ...x, points } : x);
    update();
  }
  function move(e, p) {
    if (!e.isPrimary) return;
    if (s.drag) { dragTo(p); return; }
    if (s.draft) { const f = frame(); const at = f && pointAt(f, p); if (at) { s.draft.points[1] = at; update(); } return; }
    if (s.tool !== 'cursor' || e.buttons) return;
    const h = inPane(p) ? hit(p) : null;
    if (h?.id !== s.hover?.id || h?.handle !== s.hover?.handle) { s.hover = h; update(); }
  }
  function up(e, p) {
    if (!e.isPrimary) return;
    if (s.note) { const at = s.note; s.note = null; create({ type: 'text', points: [at] }); return; }
    if (s.drag) {
      const { moved } = s.drag;
      s.drag = null;
      chart.applyOptions({ handleScroll: s.tool === 'cursor' ? scroll : NO_SCROLL });
      if (moved) onChange(s.drawings);
      return;
    }
    if (s.draft && s.placing === 'first') {
      if (Math.hypot(p.x - s.downAt.x, p.y - s.downAt.y) > CLICK) finish(); // pressed, dragged, released
      else s.placing = 'second'; // clicked: the next click places the second point
    }
  }
  /** Escape cancels what is in progress, then the tool, then the selection; Delete or Backspace removes the selected drawing. */
  function key(e) {
    if (e.key === 'Escape') {
      if (s.draft) { s.draft = null; s.placing = null; update(); return true; }
      if (s.measure) { s.measure = null; update(); return true; }
      if (s.tool !== 'cursor') { onTool('cursor'); return true; }
      if (s.selected) { select(null); return true; }
      return false;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && s.selected && find(s.selected) && !s.prefs.locked) {
      setList(s.drawings.filter(d => d.id !== s.selected));
      onChange(s.drawings);
      select(null);
      return true;
    }
    return false;
  }
  /** Opens the editor of a text note; false when `id` is not one. */
  function edit(id) {
    const d = find(id);
    const f = frame();
    if (d?.type !== 'text' || !f) return false;
    onText({ drawing: d, x: f.x(d.points[0].time), y: f.y(d.points[0].price) });
    return true;
  }
  /** A double-click on a text note edits it. */
  const dblclick = p => { const h = s.tool === 'cursor' && inPane(p) ? hit(p) : null; return h ? edit(h.id) : false; };
  function sync(next) {
    if (next.tool !== s.tool) {
      s.tool = next.tool;
      s.draft = null;
      s.placing = null;
      s.note = null;
      s.hover = null;
      if (!s.drag) chart.applyOptions({ handleScroll: next.tool === 'cursor' ? scroll : NO_SCROLL });
    }
    if (!s.drag) setList(next.drawings);
    s.prefs = next.prefs;
    s.selected = next.selected;
    update();
  }

  const renderer = { draw };
  const views = [{ zOrder: () => 'top', renderer: () => renderer }];
  const primitive = {
    attached: param => { requestUpdate = param.requestUpdate; },
    detached: () => { requestUpdate = () => {}; },
    updateAllViews: () => { s.render = build(); },
    paneViews: () => views,
    priceAxisViews: () => s.priceViews,
    timeAxisViews: () => s.timeViews,
    // The library asks on every pointer move; its answer sets the cursor over a drawing.
    hitTest: (x, y) => { const h = s.tool === 'cursor' ? hit({ x, y }) : null; return h && { externalId: h.id, zOrder: 'top', cursorStyle: h.handle === null ? 'move' : 'pointer' }; },
  };
  return { primitive, sync, down, move, up, key, dblclick, edit, leave: () => { if (s.hover) { s.hover = null; update(); } } };
}
