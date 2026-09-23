import React, { useEffect, useRef } from 'react';
import { ArrowUpRight, ArrowRight, ArrowLeft, Bitcoin, CircleDollarSign, Cpu, Euro, PoundSterling, Smartphone, Check, X, ChevronDown, Info, ExternalLink, Wallet } from 'lucide-react';
import { number, seriesValues } from './data.js';

export function Brand({ compact = false }) {
  return <a href="#/trade/funded" className="brand" aria-label="Props.trade home"><img src="/brand/symbol.svg" alt="" />{!compact && <span>Props<span className="brand-dot">.</span>trade</span>}</a>;
}
export function Button({ children, variant = 'primary', small = false, className = '', icon: Icon, ...props }) {
  return <button className={`button ${variant} ${small ? 'small' : ''} ${className}`} {...props}>{children}{Icon && <Icon size={15} />}</button>;
}
export function IconButton({ icon: Icon, label, className = '', ...props }) {
  return <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}><Icon size={17} strokeWidth={1.7} /></button>;
}
export function Badge({ children, tone = 'neutral', dot = false }) { return <span className={`badge ${tone}`}>{dot && <i />}{children}</span>; }
export function MarketIcon({ market, small = false }) {
  const size = small ? 15 : 20;
  const Icon = { BTC: Bitcoin, EUR: Euro, GBP: PoundSterling, AAPL: Smartphone, NVDA: Cpu }[market.symbol];
  const paths = {
    ETH: <><path d="m12 2 6 10-6 3-6-3Z" fill="currentColor" /><path d="m6 14 6 8 6-8-6 3Z" fill="currentColor" opacity=".7" /></>,
    SOL: <><path d="M6 4h15l-3 4H3ZM3 10h15l3 4H6ZM6 16h15l-3 4H3Z" fill="currentColor" /></>,
    XAU: <><path d="m7 6-4 12h18L17 6Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M7 6h10l-3 5H5m9 0 7 7M14 11v7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></>,
  };
  return <span className={`market-icon ${small ? 'small' : ''}`} style={{ '--coin-color': market.color }} aria-hidden="true">{Icon ? <Icon size={size} strokeWidth={1.8} /> : <svg width={size} height={size} viewBox="0 0 24 24">{paths[market.symbol]}</svg>}</span>;
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
export function LineGraph({ height = 220, end = 1742.5, muted = false, showLabels = true, period = '1M' }) {
  const values = seriesValues(period === '1W' ? 28 : 60, end);
  const width = 900, pad = 20, baseline = height - 38;
  const max = Math.max(...values.map(v => v.value)) * 1.13;
  const points = values.map((v, i) => `${pad + i / (values.length - 1) * (width - pad * 2)},${baseline - Math.max(0, v.value) / max * (height - 68)}`).join(' ');
  return <svg className={`line-graph ${muted ? 'muted' : ''}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Sample net profit over the selected period, ending at ${number(end)} dollars`} preserveAspectRatio="none">{[0, 1, 2, 3].map(i => <line key={i} x1={pad} x2={width - pad} y1={28 + i * (baseline - 28) / 3} y2={28 + i * (baseline - 28) / 3} stroke="var(--line-soft)" strokeDasharray="3 5" />)}<polygon points={`${pad},${baseline} ${points} ${width - pad},${baseline}`} fill={muted ? 'var(--graph-muted-fill, #efefeb)' : 'var(--graph-fill, #f0eaf8)'} opacity=".65" /><polyline points={points} fill="none" stroke={muted ? 'var(--subtle)' : 'var(--purple)'} strokeWidth="2.3" vectorEffect="non-scaling-stroke" />{showLabels && ['Sep 01', 'Sep 05', 'Sep 09', 'Sep 13', 'Sep 17', 'Sep 23'].map((s, i) => <text key={s} x={pad + i * (width - pad * 2) / 5} y={height - 6} textAnchor={i === 0 ? 'start' : i === 5 ? 'end' : 'middle'}>{s}</text>)}</svg>;
}
export function Steps({ active = 1, labels = ['Choose account', 'Connect wallet', 'Start evaluation'] }) { return <div className="steps">{labels.map((label, i) => <div key={label} className={`${i + 1 === active ? 'current' : ''} ${i + 1 < active ? 'done' : ''}`}><span>{i + 1 < active ? <Check size={13} /> : i + 1}</span>{label}{i < labels.length - 1 && <div className="step-rule" />}</div>)}</div>; }
export function InlineLink({ href, children, external = false }) { return <a href={href} className="inline-link" {...external ? { target: '_blank', rel: 'noreferrer' } : {}}>{children}{external ? <ExternalLink size={13} /> : <ArrowUpRight size={14} />}</a>; }
export function RuleList({ size = 25000 }) { return <div className="rule-list"><DataRow label="Profit target" value={`8% · $${number(size * .08, 0)}`} /><DataRow label="Maximum drawdown" value={`5% · $${number(size * .05, 0)}`} /><DataRow label="Drawdown type" value="Static · includes open P&L" /><DataRow label="Daily loss limit" value="None" /><DataRow label="Time limit" value="None" /><DataRow label="Your profit share" value="80%" /></div>; }
/** One live region (role=status) so screen readers announce each sign-in problem as it replaces the guidance. */
export function SessionNotice({ session, children }) {
  // A wrong network blocks sign-in, so it wins; otherwise the latest failure beats a slow-RPC warning.
  const problem = session.network.state === 'wrong' ? session.network.reason : session.notice ?? session.network.reason;
  return <Notice tone={problem ? 'amber' : 'neutral'} role="status">{problem ?? children}</Notice>;
}
export function WalletOptions({ session, onChoose }) {
  if (!session.wallets.length) return <Notice tone="amber">No Solana wallet was found in this browser. Install <InlineLink href="https://phantom.com/download" external>Phantom</InlineLink>, <InlineLink href="https://solflare.com/download" external>Solflare</InlineLink> or <InlineLink href="https://backpack.app/download" external>Backpack</InlineLink>, then reload this page.</Notice>;
  const waiting = session.status === 'connecting' || session.status === 'signing';
  return session.wallets.map(w => { const busy = waiting && session.walletName === w.name; return <button key={w.name} className="wallet-option" onClick={() => onChoose(w.name)} disabled={waiting}><span className="wallet-option-icon">{w.icon ? <img src={w.icon} alt="" width="23" height="23" /> : <Wallet size={23} />}</span><span><strong>{w.name}</strong><small>{busy ? (session.status === 'signing' ? 'Approve the sign-in message in your wallet' : 'Approve the connection in your wallet') : 'Detected in this browser'}</small></span>{busy ? <span className="spinner" /> : <ArrowRight size={17} />}</button>; });
}
