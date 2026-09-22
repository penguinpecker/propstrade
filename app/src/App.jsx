import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { ArrowRight, ArrowUpRight, Bell, BookOpen, Check, ChevronDown, Command, Copy, ExternalLink, HelpCircle, LayoutGrid, Menu, Moon, Search, Settings, ShieldCheck, Sun, Wallet, X } from 'lucide-react';
import { accounts, initialOrders, initialPositions, markets, programs, screens, money } from './data.js';
import { Badge, Brand, Button, DataRow, Dialog, IconButton, MarketIcon, Notice, RuleList } from './ui.jsx';
import Trading from './Trading.jsx';
import { AccountsPage, AccountPage, PerformancePage, ActivityPage, MarketsPage } from './Workspace.jsx';
import { FundingPage, ProgramPage, ConnectPage, CheckoutPage, PaymentPage, ResultPage, ActivationPage } from './Onboarding.jsx';
import { PayoutsPage, PayoutReview, PayoutReceipt, VerifyPage, VaultPage, SettingsPage, ScreenIndex } from './Money.jsx';

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);
const read = (key, fallback) => { try { const value = localStorage.getItem('props.' + key); return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
function useSaved(key, fallback) { const [value, setValue] = useState(() => read(key, fallback)); useEffect(() => { localStorage.setItem('props.' + key, JSON.stringify(value)); }, [key, value]); return [value, setValue]; }
const getPath = () => (location.hash.slice(1) || '/trade/funded').split('?')[0];

export default function App() {
  const [path, setPath] = useState(getPath);
  const [stage, setStage] = useSaved('stage', 'funded');
  const [marketSymbol, setMarketSymbol] = useSaved('market', 'BTC');
  const [programSize, setProgramSize] = useSaved('program', 25000);
  const [evaluationSize, setEvaluationSize] = useSaved('evaluation-size', 25000);
  const [fundedSize, setFundedSize] = useSaved('funded-size', 25000);
  const [wallet, setWallet] = useSaved('wallet', true);
  const [positions, setPositions] = useSaved('positions', { funded: initialPositions, evaluation: initialPositions, practice: [] });
  const [orders, setOrders] = useSaved('orders', { funded: initialOrders, evaluation: initialOrders, practice: [] });
  const [favorites, setFavorites] = useSaved('favorites', ['BTC', 'ETH', 'SOL', 'XAU']);
  const [prefs, setPrefs] = useSaved('preferences', { fills: true, risk: true, payouts: true, density: 'Comfortable', currency: 'USD', motion: false, theme: 'dark' });
  const theme = prefs.theme === 'light' ? 'light' : 'dark';
  const setTheme = next => setPrefs(prev => ({ ...prev, theme: next }));
  const [payouts, setPayouts] = useSaved('payouts', []);
  const [selectedReceipt, setSelectedReceipt] = useSaved('selected-receipt', null);
  useEffect(() => { const pending = payouts.filter(p => p.status === 'Processing'); if (!pending.length) return; const delay = Math.max(0, Math.min(...pending.map(p => p.createdAt + 1500)) - Date.now()); const timer = setTimeout(() => setPayouts(prev => prev.map(p => p.status === 'Processing' && Date.now() >= p.createdAt + 1500 ? { ...p, status: 'Paid' } : p)), delay + 20); return () => clearTimeout(timer); }, [payouts]);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [network, setNetwork] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const [tradeEvents, setTradeEvents] = useSaved('events', []);
  const closeModal = useCallback(() => { setModal(null); setSearch(''); }, []);
  const navigate = useCallback((to) => { location.hash = to; setModal(null); setMobileNav(false); window.scrollTo(0, 0); }, []);
  const notify = useCallback((message, detail = '') => setToast({ message, detail, key: Date.now() }), []);
  useEffect(() => { const handler = () => setPath(getPath()); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  useEffect(() => { const match = path.match(/\/(trade|account)\/(funded|evaluation|practice)/); if (match) setStage(match[2]); }, [path]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 4800); return () => clearTimeout(id); }, [toast]);
  useEffect(() => { const handler = e => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setModal('markets'); } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, []);
  useEffect(() => { document.documentElement.dataset.density = prefs.density.toLowerCase(); document.documentElement.dataset.motion = prefs.motion ? 'reduced' : 'normal'; }, [prefs]);
  useEffect(() => { document.documentElement.dataset.theme = theme; document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#131217' : '#f6f5f1'; }, [theme]);
  const market = markets.find(m => m.symbol === marketSymbol) || markets[0];
  const scaleAccount = (base, size) => { const ratio = size / base.size; return { ...base, size, equity: base.equity * ratio, profit: base.profit * ratio, realized: base.realized * ratio, headroom: base.headroom * ratio, floor: size * .95, target: base.target === null ? null : size * .08, label: `${base.stage} ${size / 1000}K` }; };
  const accountMap = { ...accounts, funded: scaleAccount(accounts.funded, fundedSize), evaluation: scaleAccount(accounts.evaluation, evaluationSize) };
  const account = accountMap[stage];
  const availableMargin = Math.max(0, account.size - (positions[stage] || []).reduce((sum, p) => sum + p.entry * p.quantity / p.leverage, 0));
  const availablePayout = Math.round(Math.max(0, accountMap.funded.realized * .8 - payouts.reduce((sum, p) => sum + (p.share || 0), 0)) * 100) / 100;
  const program = programs.find(p => p.size === programSize) || programs[1];
  const selectMarket = (symbol) => { setMarketSymbol(symbol); closeModal(); navigate(`/trade/${stage}`); };
  const switchAccount = next => { setStage(next); navigate(path.startsWith('/trade') ? `/trade/${next}` : `/account/${next}`); };
  const copy = async (value) => { try { await navigator.clipboard.writeText(value); notify('Copied to clipboard'); } catch { notify('Copy unavailable', 'Select the address and copy it manually.'); } };
  const openRecord = record => setModal({ type: 'record', record });
  const value = { path, navigate, stage, setStage, account, accountMap, availableMargin, availablePayout, evaluationSize, setEvaluationSize, fundedSize, setFundedSize, market, marketSymbol, setMarketSymbol, selectMarket, program, setProgramSize, wallet, setWallet, positions: positions[stage] || [], allPositions: positions, setPositions: next => setPositions(p => ({ ...p, [stage]: typeof next === 'function' ? next(p[stage] || []) : next })), orders: orders[stage] || [], setOrders: next => setOrders(p => ({ ...p, [stage]: typeof next === 'function' ? next(p[stage] || []) : next })), favorites, setFavorites, prefs, setPrefs, theme, setTheme, payouts, setPayouts, selectedReceipt, setSelectedReceipt, modal, setModal, closeModal, notify, network, setNetwork, openRecord, copy, tradeEvents, setTradeEvents };
  const currentSection = path.startsWith('/trade') || path === '/markets' ? 'Trade' : ['/payouts', '/payout/review', '/payout/receipt'].includes(path) ? 'Payouts' : ['/verify', '/vault'].includes(path) ? 'Verify' : ['Accounts', ''].includes(path) ? 'Accounts' : path.includes('account') || ['/performance', '/activity', '/result', '/activate'].includes(path) ? 'Accounts' : '';
  const navItems = [['Trade', `/trade/${stage}`], ['Accounts', '/accounts'], ['Payouts', '/payouts'], ['Verify', '/verify']];
  let page;
  if (path.startsWith('/trade')) page = <Trading />;
  else if (path === '/get-funded') page = <FundingPage />;
  else if (path === '/program') page = <ProgramPage />;
  else if (path === '/connect') page = <ConnectPage />;
  else if (path === '/checkout') page = <CheckoutPage />;
  else if (path === '/payment') page = <PaymentPage />;
  else if (path === '/accounts') page = <AccountsPage />;
  else if (path.startsWith('/account/')) page = <AccountPage />;
  else if (path === '/result') page = <ResultPage />;
  else if (path === '/activate') page = <ActivationPage />;
  else if (path === '/markets') page = <MarketsPage />;
  else if (path === '/performance') page = <PerformancePage />;
  else if (path === '/activity') page = <ActivityPage />;
  else if (path === '/payouts') page = <PayoutsPage />;
  else if (path === '/payout/review') page = <PayoutReview />;
  else if (path === '/payout/receipt') page = <PayoutReceipt />;
  else if (path === '/verify') page = <VerifyPage />;
  else if (path === '/vault') page = <VaultPage />;
  else if (path === '/settings') page = <SettingsPage />;
  else if (path === '/screens') page = <ScreenIndex />;
  else page = <div className="page"><h1>This page has moved.</h1><Button onClick={() => navigate('/trade/funded')}>Open workspace</Button></div>;

  return <AppContext.Provider value={value}><div className="app-shell">
    <a className="skip-link" href="#main" onClick={e => { e.preventDefault(); document.getElementById("main").focus(); }}>Skip to content</a>
    <header className="app-header"><Brand /><nav className={mobileNav ? 'main-nav mobile-open' : 'main-nav'} aria-label="Main navigation">{navItems.map(([label, href]) => <a key={label} href={`#${href}`} className={currentSection === label ? 'active' : ''} onClick={() => setMobileNav(false)}>{label}</a>)}</nav><div className="header-end"><button className="search-trigger" onClick={() => setModal('markets')}><Search size={15} /><span>Search markets</span><kbd>⌘ K</kbd></button><a className="funding-link" href="#/get-funded">Get funded <ArrowUpRight size={14} /></a><span className="header-rule" /><IconButton className="theme-toggle" icon={theme === 'dark' ? Sun : Moon} label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} /><IconButton icon={Bell} label="Notifications" onClick={() => setModal('notifications')} /><button className="wallet-button" onClick={() => setModal('wallet')}><span className="wallet-avatar"><Wallet size={13} /></span><span>{wallet ? '7d3k…aF8v' : 'Connect wallet'}</span><ChevronDown size={13} /></button><IconButton className="mobile-menu" icon={mobileNav ? X : Menu} label="Toggle navigation" onClick={() => setMobileNav(!mobileNav)} /></div></header>
    <main id="main" tabIndex="-1" className={path.startsWith('/trade') ? 'terminal-main' : ''}>{page}</main>
    <footer className="app-footer"><div><span className={`connection-dot ${network ? '' : 'offline'}`} /><button onClick={() => { setNetwork(!network); notify(network ? 'Connection paused in preview' : 'Preview connection restored'); }}>{network ? 'Preview connected' : 'Preview connection paused'}</button><span className="footer-divider" /><span>All figures illustrative · No live orders</span></div><div><a href="#/screens"><LayoutGrid size={12} /> Screen index</a><button onClick={() => setModal('rules')}>Preview rules</button><button onClick={() => setModal('help')}><HelpCircle size={13} /> Help</button><span className="network-label">Solana <span className="solana-lines" aria-hidden="true"><i /><i /><i /></span></span></div></footer>
  </div>
  {toast && <div className="toast" role="status" key={toast.key}><span className="toast-check"><Check size={16} /></span><div><strong>{toast.message}</strong>{toast.detail && <p>{toast.detail}</p>}</div><IconButton icon={X} label="Dismiss notification" onClick={() => setToast(null)} /></div>}
  {modal === 'markets' && <Dialog title="Find a market" onClose={closeModal}><div className="search-field"><Search size={17} /><input autoFocus placeholder="Search markets, symbols or asset classes" aria-label="Search markets" value={search} onChange={e => setSearch(e.target.value)} /><kbd>ESC</kbd></div><div className="market-picker-list">{markets.filter(m => `${m.symbol} ${m.name} ${m.category}`.toLowerCase().includes(search.toLowerCase())).map(m => <button key={m.symbol} onClick={() => selectMarket(m.symbol)}><MarketIcon market={m} /><span><strong>{m.symbol} / USD</strong><small>{m.name} · Perpetual</small></span><span className="picker-price"><strong>{money(m.price, m.price < 2 ? 5 : 2)}</strong><small className={m.change > 0 ? 'positive' : 'negative'}>{m.change > 0 ? '+' : ''}{m.change}%</small></span><ArrowUpRight size={15} /></button>)}{!markets.some(m => `${m.symbol} ${m.name} ${m.category}`.toLowerCase().includes(search.toLowerCase())) && <div className="empty"><h3>No matching market</h3><p>Try a symbol such as BTC or an asset class.</p></div>}</div><p className="dialog-note">Illustrative market selection. Live availability follows venue support.</p></Dialog>}
  {modal === 'accounts' && <Dialog title="Switch account" onClose={closeModal}><div className="account-picker">{Object.entries(accountMap).map(([key, item]) => <button key={key} onClick={() => switchAccount(key)}><span className="account-initial"><ShieldCheck size={20} /></span><span><strong>{item.label}</strong><small>{item.id} · {key === 'funded' ? 'Funded preview' : 'Simulated'}</small></span><strong>{money(item.equity)}</strong>{stage === key && <Check size={17} className="purple-text" />}</button>)}</div><Button variant="secondary" className="full-width" onClick={() => navigate('/get-funded')} icon={ArrowRight}>Start another evaluation</Button></Dialog>}
  {modal === 'wallet' && <Dialog title={wallet ? 'Your wallet' : 'Connect a preview wallet'} onClose={closeModal}><div className="wallet-summary"><div className="wallet-large"><Wallet size={25} /></div><strong>{wallet ? '7d3k…aF8v' : 'Explore the complete journey'}</strong><Badge tone="purple">Sample Solana wallet</Badge></div><Notice>No wallet extension or real signature is used in this design preview.</Notice>{wallet ? <><DataRow label="Illustrative USDC balance" value="$2,500.00" /><DataRow label="Network" value="Solana" /><div className="button-row"><Button variant="secondary" onClick={() => { setWallet(false); closeModal(); notify('Preview wallet disconnected'); }}>Disconnect</Button><Button onClick={() => navigate('/settings')}>Preferences</Button></div></> : <Button className="full-width" onClick={() => { setWallet(true); closeModal(); notify('Preview wallet connected'); }}>Use preview wallet</Button>}</Dialog>}
  {modal === 'rules' && <Dialog title="Rules for this design preview" onClose={closeModal}><Notice tone="purple">These are illustrative settings for exploring the design. Final program terms are still to be set.</Notice><RuleList size={program.size} /><p className="dialog-note">The example uses a static equity floor, includes fees and open P&L, and assumes an account can continue after payout. Supported markets and leverage require integration validation.</p><Button className="full-width" onClick={() => navigate('/program')}>View program details</Button></Dialog>}
  {modal === 'notifications' && <Dialog title="Notifications" onClose={closeModal}><div className="notification-list">{[['Your evaluation is complete', 'All example objectives have been met.', '/result'], ['Payout received', 'Your sample receipt is ready to inspect.', '/payout/receipt'], ['Your next trading session', 'You have two open sample positions.', `/trade/${stage}`]].map(([title, body, href], i) => <button key={title} onClick={() => navigate(href)}><span className="notification-icon"><Check size={16} /></span><span><strong>{title}</strong><small>{body}</small><time>{i === 0 ? '12 minutes ago' : i === 1 ? 'Yesterday' : 'Sep 21'}</time></span><ArrowUpRight size={15} /></button>)}</div></Dialog>}
  {modal === 'help' && <Dialog title="A little help, right here" onClose={closeModal}><div className="help-links"><button onClick={() => setModal('rules')}><BookOpen size={20} /><span><strong>Understand your rules</strong><small>Targets, drawdown and payout eligibility.</small></span><ArrowRight size={16} /></button><button onClick={() => navigate('/verify')}><ShieldCheck size={20} /><span><strong>Follow the evidence</strong><small>Account, trade and payout records.</small></span><ArrowRight size={16} /></button><a href="https://docs.gmtrade.xyz/about/trading/" target="_blank" rel="noreferrer"><ExternalLink size={20} /><span><strong>GMTrade documentation</strong><small>Learn about the proposed execution venue.</small></span><ArrowUpRight size={16} /></a></div><div className="shortcut-row"><span>Find a market</span><kbd>⌘ / Ctrl K</kbd></div><div className="shortcut-row"><span>Close a dialog</span><kbd>Esc</kbd></div></Dialog>}
  {modal?.type === 'record' && <Dialog title="Record details" onClose={closeModal}><Badge tone="purple">Illustrative record</Badge><h3 className="record-title">{modal.record.title || `${modal.record.symbol || 'Account'} · ${modal.record.id || 'PT-1046'}`}</h3><DataRow label="Record ID" value={modal.record.id || 'PT-1046'} /><DataRow label="Account" value={account.id} /><DataRow label="Status" value="Confirmed in preview" /><DataRow label="Source" value={stage === 'funded' ? 'Sample venue execution' : 'Simulation engine'} /><Notice>This sample has no blockchain transaction. Live records would link to their specific source and confirmation.</Notice><Button className="full-width" onClick={() => navigate('/verify')}>Open verification workspace</Button></Dialog>}
  </AppContext.Provider>;
}
