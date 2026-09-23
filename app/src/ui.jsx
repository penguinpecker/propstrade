import React, { useEffect, useRef } from 'react';
import { ArrowUpRight, ArrowRight, ArrowLeft, Bitcoin, CircleDollarSign, Cpu, Euro, PoundSterling, Smartphone, Check, X, ChevronDown, Info, ExternalLink, TriangleAlert, Wallet } from 'lucide-react';
import { bpsPercent, date, freshnessLabel, usd, utcTime } from './data.js';

export function Brand({ compact = false }) {
  return <a href="#/" className="brand" aria-label="Props.trade home"><img src="/brand/symbol.svg" alt="" />{!compact && <span>Props<span className="brand-dot">.</span>trade</span>}</a>;
}
export function Button({ children, variant = 'primary', small = false, className = '', icon: Icon, ...props }) {
  return <button className={`button ${variant} ${small ? 'small' : ''} ${className}`} {...props}>{children}{Icon && <Icon size={15} />}</button>;
}
export function IconButton({ icon: Icon, label, className = '', ...props }) {
  return <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}><Icon size={17} strokeWidth={1.7} /></button>;
}
export function Badge({ children, tone = 'neutral', dot = false, title }) { return <span className={`badge ${tone}`} title={title}>{dot && <i />}{children}</span>; }
/** Marks a market price that is not live ("Stale", "Delayed", "Unavailable"), with the time of GMTrade's last update. */
export function FreshnessBadge({ market }) { return <Badge tone="amber" title={market.updatedAt ? `Last update ${utcTime(market.updatedAt)}` : 'GMTrade has not published a price'}>{freshnessLabel(market)}</Badge>; }
const ICON_COLORS = { BTC: '#bd8238', ETH: '#7b79a4', SOL: '#756193', XAU: '#aa8b37', EUR: '#59749a', AAPL: '#72706e', NVDA: '#61825b', GBP: '#776384' };
/** A stable hue per symbol, so a market keeps its monogram color everywhere. */
const monogramColor = symbol => `hsl(${[...symbol].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)} 28% 56%)`;
export function MarketIcon({ market, small = false }) {
  const size = small ? 15 : 20;
  const Icon = { BTC: Bitcoin, EUR: Euro, GBP: PoundSterling, AAPL: Smartphone, NVDA: Cpu }[market.symbol];
  const paths = {
    ETH: <><path d="m12 2 6 10-6 3-6-3Z" fill="currentColor" /><path d="m6 14 6 8 6-8-6 3Z" fill="currentColor" opacity=".7" /></>,
    SOL: <><path d="M6 4h15l-3 4H3ZM3 10h15l3 4H6ZM6 16h15l-3 4H3Z" fill="currentColor" /></>,
    XAU: <><path d="m7 6-4 12h18L17 6Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M7 6h10l-3 5H5m9 0 7 7M14 11v7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></>,
  };
  const mark = Icon ? <Icon size={size} strokeWidth={1.8} /> : paths[market.symbol] ? <svg width={size} height={size} viewBox="0 0 24 24">{paths[market.symbol]}</svg> : <span style={{ fontSize: small ? 9 : 11, letterSpacing: '-.02em' }}>{market.symbol.slice(0, 2)}</span>;
  return <span className={`market-icon ${small ? 'small' : ''}`} style={{ '--coin-color': ICON_COLORS[market.symbol] ?? monogramColor(market.symbol) }} aria-hidden="true">{mark}</span>;
}
export function UsdcIcon() { return <span className="usdc-icon" aria-hidden="true"><CircleDollarSign size={18} strokeWidth={1.6} /></span>; }
export function PageHeading({ title, description, children, back }) {
  return <div className="page-heading"><div>{back && <a className="back-link" href={back.href}><ArrowLeft size={13} />{back.label}</a>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className="heading-actions">{children}</div>}</div>;
}
export function SectionHeading({ children, action }) { return <div className="section-heading"><h2>{children}</h2>{action}</div>; }
export function Stat({ label, value, detail, positive, children }) { return <div className="stat"><span className="stat-label">{label}</span><strong className={positive ? 'positive' : ''}>{value}</strong>{detail && <span className="stat-detail">{detail}</span>}{children}</div>; }
export function Field({ label, children, hint }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function DataRow({ label, value, className = '', children }) { return <div className={`data-row ${className}`}><span>{label}</span><strong>{value ?? children}</strong></div>; }
export function Progress({ value, tone = 'purple', label }) { return <div className={`progress ${tone}`} role="progressbar" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>; }
export function Notice({ children, tone = 'neutral', icon: Icon = Info, role }) { return <div className={`notice ${tone}`} role={role}><Icon size={17} /><div>{children}</div></div>; }
export function Empty({ icon: Icon, title, children, action }) { return <div className="empty">{Icon && <Icon size={26} strokeWidth={1.3} />}<h3>{title}</h3><p>{children}</p>{action}</div>; }
export function Tabs({ items, value, onChange, className = '' }) { return <div className={`tabs ${className}`} role="tablist">{items.map(item => { const v = typeof item === 'string' ? item : item.value; return <button role="tab" aria-selected={value === v} key={v} className={value === v ? 'active' : ''} onClick={() => onChange(v)}>{typeof item === 'string' ? item : item.label}</button>; })}</div>; }
export function Toggle({ checked, onChange, label }) { return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`toggle ${checked ? 'checked' : ''}`} onClick={() => onChange(!checked)}><span /></button>; }
export function Dialog({ title, children, onClose, wide = false }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => { const node = ref.current; node.showModal(); const handler = e => { e.preventDefault(); closeRef.current(); }; node.addEventListener('cancel', handler); return () => { node.removeEventListener('cancel', handler); if (node.open) node.close(); }; }, []);
  return <dialog ref={ref} className={`dialog ${wide ? 'wide' : ''}`} onClick={e => { if (e.target === ref.current) onClose(); }} aria-labelledby="dialog-title"><div className="dialog-head"><h2 id="dialog-title">{title}</h2><IconButton icon={X} label="Close dialog" onClick={onClose} /></div>{children}</dialog>;
}
/** Real series only: `points` are { ts, value } in time order; fewer than two points render nothing. */
const hourMinute = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
export function LineGraph({ points, height = 220, muted = false, showLabels = true, label }) {
  if (points.length < 2) return null;
  const width = 900, pad = 20, top = 28, baseline = height - 38;
  const values = points.map(p => p.value);
  const low = Math.min(0, ...values), high = Math.max(0, ...values);
  const span = high - low || 1;
  const x = i => pad + i / (points.length - 1) * (width - pad * 2);
  const y = v => baseline - (v - low) / span * (baseline - top);
  const line = points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
  // Times of day for a series under two days long (dates would all read the same), and no label twice.
  const labelOf = points.at(-1).ts - points[0].ts < 2 * 86_400_000 ? ts => hourMinute.format(ts) : ts => date(ts).slice(0, 6);
  const labels = [...new Map([0, 1, 2, 3, 4, 5].map(i => Math.round(i * (points.length - 1) / 5)).reverse().map(index => [labelOf(points[index].ts), index])).entries()]
    .map(([text, index]) => ({ text, index })).sort((a, b) => a.index - b.index);
  return <svg className={`line-graph ${muted ? 'muted' : ''}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} preserveAspectRatio="none">{[0, 1, 2, 3].map(i => <line key={i} x1={pad} x2={width - pad} y1={top + i * (baseline - top) / 3} y2={top + i * (baseline - top) / 3} stroke="var(--line-soft)" strokeDasharray="3 5" />)}<polygon points={`${pad},${y(Math.max(low, 0))} ${line} ${width - pad},${y(Math.max(low, 0))}`} fill={muted ? 'var(--graph-muted-fill, #efefeb)' : 'var(--graph-fill, #f0eaf8)'} opacity=".65" /><polyline points={line} fill="none" stroke={muted ? 'var(--subtle)' : 'var(--purple)'} strokeWidth="2.3" vectorEffect="non-scaling-stroke" />{showLabels && labels.map(({ text, index }) => <text key={index} x={x(index)} y={height - 6} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}>{text}</text>)}</svg>;
}
export function Steps({ active = 1, labels = ['Choose account', 'Connect wallet', 'Start evaluation'] }) { return <div className="steps">{labels.map((label, i) => <div key={label} className={`${i + 1 === active ? 'current' : ''} ${i + 1 < active ? 'done' : ''}`}><span>{i + 1 < active ? <Check size={13} /> : i + 1}</span>{label}{i < labels.length - 1 && <div className="step-rule" />}</div>)}</div>; }
export function InlineLink({ href, children, external = false }) { return <a href={href} className="inline-link" {...external ? { target: '_blank', rel: 'noreferrer' } : {}}>{children}{external ? <ExternalLink size={13} /> : <ArrowUpRight size={14} />}</a>; }
/** Rules in the AccountRules shape (an account's pinned terms, or `tierRules(tier)` before purchase). */
export function RuleList({ rules }) { const size = Number(rules.sizeUsd), share = pct => bpsPercent(Math.round(pct * 10_000)); return <div className="rule-list"><DataRow label="Profit target" value={rules.profitTargetUsd == null ? 'None' : `${share(Number(rules.profitTargetUsd) / size)} · ${usd(rules.profitTargetUsd, 0)}`} /><DataRow label="Maximum drawdown" value={`${share(Number(rules.lossAllowanceUsd) / size)} · ${usd(rules.lossAllowanceUsd, 0)}`} /><DataRow label="Drawdown type" value="Static · includes open P&L" /><DataRow label="Daily loss limit" value="None" /><DataRow label="Time limit" value="None" /><DataRow label="Your profit share" value={bpsPercent(rules.traderShareBps)} /></div>; }
/** Loading state for a section. */
export function Pending({ children }) { return <div className="empty" role="status"><span className="spinner" /><p>{children}</p></div>; }
/** A section whose data failed to load, with a retry. */
export function Unavailable({ title, error, retry }) { return <Empty icon={TriangleAlert} title={title} action={retry && <Button variant="secondary" small onClick={() => retry()}>Try again</Button>}>{error?.message ?? 'The Props.trade service could not be reached.'}</Empty>; }
/** One live region (role=status) so screen readers announce each sign-in problem as it replaces the guidance. */
export function SessionNotice({ session, children }) {
  // A wrong network blocks sign-in, so it wins; otherwise the latest failure beats a slow-RPC warning.
  const problem = session.network.state === 'wrong' ? session.network.reason : session.notice ?? session.network.reason;
  return <Notice tone={problem ? 'amber' : 'neutral'} role="status">{problem ?? children}</Notice>;
}
export function WalletOptions({ session, onChoose }) {
  if (!session.wallets.length) return <Notice tone="amber">No Solana wallet was found in this browser. Install <InlineLink href="https://phantom.com/download" external>Phantom</InlineLink>, <InlineLink href="https://solflare.com/download" external>Solflare</InlineLink> or <InlineLink href="https://backpack.app/download" external>Backpack</InlineLink>, then reload this page.</Notice>;
  const waiting = session.status === 'connecting' || session.status === 'signing';
  return session.wallets.map(w => { const busy = waiting && session.walletName === w.name; return <button key={w.name} className="wallet-option" onClick={() => onChoose(w.name)} disabled={waiting}><span className="wallet-option-icon">{w.icon ? <img src={w.icon} alt="" width="23" height="23" /> : <Wallet size={23} />}</span><span><strong>{w.name}</strong><small>{busy ? (w.privy ? (session.status === 'signing' ? 'Signing you in…' : 'Opening Google…') : session.status === 'signing' ? 'Approve the sign-in message in your wallet' : 'Approve the connection in your wallet') : w.privy ? 'A Solana wallet for your Google account. No extension needed' : 'Detected in this browser'}</small></span>{busy ? <span className="spinner" /> : <ArrowRight size={17} />}</button>; });
}
