import React, { createContext, lazy, Suspense, useContext, useEffect, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ArrowUpRight, Bell, BookOpen, Check, ChevronDown, ExternalLink, HelpCircle, LayoutGrid, Menu, Moon, Search, ShieldCheck, Sun, Wallet, X } from 'lucide-react';
import { dateTime, explorerAddress, explorerTx, freshnessLabel, isCurrent, marketPrice, percent, shortAddress, stageRestriction, tierRules, usd } from './data.js';
import { Badge, Brand, Button, DataRow, Dialog, Empty, FreshnessBadge, IconButton, InlineLink, MarketIcon, Notice, Pending, RuleList, SessionNotice, Unavailable, WalletOptions } from './ui.jsx';
import Trading from './Trading.jsx';
import { AccountsPage, AccountPage, PerformancePage, ActivityPage, MarketsPage } from './Workspace.jsx';
import { FundingPage, ProgramPage, ConnectPage, CheckoutPage, PaymentPage, ResultPage, ActivationPage } from './Onboarding.jsx';
import { PayoutsPage, PayoutReview, PayoutReceipt, VerifyPage, VaultPage, SettingsPage } from './Money.jsx';
import { env } from './lib/env';
import { applyStreamEvent, useAccounts, useConfig, useMarkets, useNotifications, useReadNotifications } from './lib/queries';
import { useSession } from './lib/session';
import { useStream } from './lib/stream';

// The screen index is a design artefact: dev builds only, so production bundles never contain it.
const ScreenIndex = import.meta.env.DEV ? lazy(() => import('./ScreenIndex.jsx')) : null;
const STREAM_LABELS = { connecting: 'Connecting to live data…', connected: 'Live data connected', reconnecting: 'Reconnecting to live data…', offline: 'Offline · retrying' };
const NETWORK_LABEL = env.cluster === 'mainnet-beta' ? 'Solana' : 'Solana · Localnet';
/** Which notification kinds each preference toggle controls; account notices always show. */
const NOTIFICATION_PREFS = { fill: 'fills', risk: 'risk', payout: 'payouts' };

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);
const read = (key, fallback) => { try { const value = localStorage.getItem('props.' + key); return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
export function useSaved(key, fallback) { const [value, setValue] = useState(() => read(key, fallback)); useEffect(() => { try { localStorage.setItem('props.' + key, JSON.stringify(value)); } catch { /* private mode: keep it for this visit */ } }, [key, value]); return [value, setValue]; }
/** An empty hash opens the terminal of the stage the trader last worked in. */
const parseHash = () => { const [path, search = ''] = location.hash.slice(1).split('?'); return { path: path && path !== '/' ? path : `/trade/${read('stage', 'funded')}`, query: new URLSearchParams(search) }; };
/** Pages that show one account: `?id=` names it (notification, past-account and result links), else the stage's account. */
const ACCOUNT_PAGE = /^\/(account\/|performance$|activity$)/;
/** Onboarding pages review a tier, not an account. */
const ONBOARDING = ['/get-funded', '/program', '/connect', '/checkout'];
const newestFirst = (a, b) => b.createdAt - a.createdAt;

export default function App() {
  const [{ path, query }, setRoute] = useState(parseHash);
  const [stage, setStage] = useSaved('stage', 'funded');
  const [marketSymbol, setMarketSymbol] = useSaved('market', 'BTC');
  const [tierId, setTierId] = useSaved('tier', null);
  const [selected, setSelected] = useSaved('accounts', {});
  const queryClient = useQueryClient();
  const session = useSession();
  const signedIn = session.status === 'signed-in';
  const [favorites, setFavorites] = useSaved('favorites', ['BTC', 'ETH', 'SOL', 'XAU']);
  const [prefs, setPrefs] = useSaved('preferences', { fills: true, risk: true, payouts: true, density: 'Comfortable', currency: 'USD', motion: false, theme: 'dark' });
  const theme = prefs.theme === 'light' ? 'light' : 'dark';
  const setTheme = next => setPrefs(prev => ({ ...prev, theme: next }));
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const showsNotification = n => n.kind === 'account' || prefs[NOTIFICATION_PREFS[n.kind]] !== false;
  const notify = useCallback((message, detail = '') => setToast({ message, detail, key: Date.now() }), []);
  const streamStatus = useStream(`${env.apiUrl}/v1/stream`, session.me?.wallet ?? '', event => {
    applyStreamEvent(queryClient, event);
    if (event.type === 'notification' && showsNotification(event.notification)) notify(event.notification.title, event.notification.body);
  });
  const live = streamStatus === 'connected';
  const config = useConfig();
  const marketsQuery = useMarkets();
  const markets = marketsQuery.data ?? [];
  const accountsQuery = useAccounts(signedIn);
  const notificationsQuery = useNotifications(signedIn);
  const accounts = signedIn ? accountsQuery.data ?? [] : [];
  const closeModal = useCallback(() => { setModal(null); setSearch(''); }, []);
  const navigate = useCallback((to) => { location.hash = to; setModal(null); setMobileNav(false); window.scrollTo(0, 0); }, []);
  useEffect(() => { const handler = () => setRoute(parseHash()); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  const routeId = ACCOUNT_PAGE.test(path) ? query.get('id') : null;
  const routed = routeId ? accounts.find(a => a.id === routeId) ?? null : null;
  useEffect(() => { const next = routed?.stage ?? path.match(/\/(trade|account)\/(funded|evaluation|practice)/)?.[2]; if (next) setStage(next); }, [path, routed?.stage]);
  // A link to a current account also makes it the stage's selected account (switcher, terminal); a past one is only shown.
  useEffect(() => { if (routed && isCurrent(routed, accounts)) setSelected(prev => prev[routed.stage] === routed.id ? prev : { ...prev, [routed.stage]: routed.id }); }, [routed?.id]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 4800); return () => clearTimeout(id); }, [toast]);
  useEffect(() => { const handler = e => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setModal('markets'); } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, []);
  useEffect(() => { document.documentElement.dataset.density = prefs.density.toLowerCase(); document.documentElement.dataset.motion = prefs.motion ? 'reduced' : 'normal'; }, [prefs]);
  useEffect(() => { document.documentElement.dataset.theme = theme; document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#131217' : '#f6f5f1'; }, [theme]);
  const market = markets.find(m => m.symbol === marketSymbol) ?? markets.find(m => m.symbol === 'BTC') ?? markets[0];
  /** The account a stage works with: the one chosen in the switcher, else the newest current one, else the newest. */
  const accountFor = s => { const list = accounts.filter(a => a.stage === s).sort(newestFirst); return list.find(a => a.id === selected[s]) ?? list.find(a => isCurrent(a, accounts)) ?? list[0] ?? null; };
  const account = routeId ? routed : accountFor(stage);
  const tiers = config.data?.tiers ?? [];
  const tier = tiers.find(t => t.id === tierId && t.enabled) ?? tiers.find(t => t.enabled) ?? null;
  const selectMarket = (symbol) => { setMarketSymbol(symbol); closeModal(); navigate(`/trade/${stage}`); };
  const selectAccount = (next, to = path.startsWith('/trade') ? 'trade' : 'account') => { setSelected(prev => ({ ...prev, [next.stage]: next.id })); setStage(next.stage); navigate(`/${to}/${next.stage}`); };
  const copy = async (value) => { try { await navigator.clipboard.writeText(value); notify('Copied to clipboard'); } catch { notify('Copy unavailable', 'Select the address and copy it manually.'); } };
  const openRecord = record => setModal({ type: 'record', record });
  const value = { path, query, navigate, stage, setStage, config, tiers, tier, setTierId, markets, marketsQuery, market, marketSymbol, selectMarket, accounts, accountsQuery, account, accountFor, selectAccount, session, signedIn, favorites, setFavorites, prefs, setPrefs, theme, setTheme, modal, setModal, closeModal, notify, streamStatus, live, openRecord, copy, showsNotification, notificationsQuery };
  const currentSection = path.startsWith('/trade') || path === '/markets' ? 'Trade' : ['/payouts', '/payout/review', '/payout/receipt'].includes(path) ? 'Payouts' : ['/verify', '/vault'].includes(path) ? 'Verify' : path.includes('account') || ['/performance', '/activity', '/result', '/activate'].includes(path) ? 'Accounts' : '';
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
  else if (ScreenIndex && path === '/screens') page = <Suspense fallback={null}><ScreenIndex /></Suspense>;
  else page = <div className="page"><h1>This page has moved.</h1><Button onClick={() => navigate(`/trade/${stage}`)}>Open workspace</Button></div>;
  const pickerRows = markets.filter(m => `${m.symbol} ${m.pair} ${m.name} ${m.category}`.toLowerCase().includes(search.toLowerCase()));
  const unread = (notificationsQuery.data ?? []).filter(n => !n.read && showsNotification(n)).length;
  const bellLabel = unread ? `Notifications, ${unread} unread` : 'Notifications';

  return <AppContext.Provider value={value}><div className="app-shell">
    <a className="skip-link" href="#main" onClick={e => { e.preventDefault(); document.getElementById("main").focus(); }}>Skip to content</a>
    <header className="app-header"><Brand /><nav className={mobileNav ? 'main-nav mobile-open' : 'main-nav'} aria-label="Main navigation">{navItems.map(([label, href]) => <a key={label} href={`#${href}`} className={currentSection === label ? 'active' : ''} onClick={() => setMobileNav(false)}>{label}</a>)}<button className="nav-extra" onClick={() => { setMobileNav(false); setModal('markets'); }}><Search size={14} /> Search markets</button></nav><div className="header-end"><button className="search-trigger" onClick={() => setModal('markets')}><Search size={15} /><span>Search markets</span><kbd>⌘ K</kbd></button><a className="funding-link" href="#/get-funded">Get funded <ArrowUpRight size={14} /></a><span className="header-rule" /><IconButton className="theme-toggle" icon={theme === 'dark' ? Sun : Moon} label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} /><span className="notifications-bell"><IconButton icon={Bell} label={bellLabel} onClick={() => setModal('notifications')} />{unread > 0 && <span className="unread-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}</span><button className="wallet-button" onClick={() => setModal('wallet')}><span className="wallet-avatar"><Wallet size={13} /></span><span>{signedIn ? shortAddress(session.me.wallet) : session.status === 'connecting' ? 'Connecting…' : session.address ? 'Sign in' : 'Connect wallet'}</span><ChevronDown size={13} /></button><IconButton className="mobile-menu" icon={mobileNav ? X : Menu} label="Toggle navigation" onClick={() => setMobileNav(!mobileNav)} /></div></header>
    <main id="main" tabIndex="-1" className={path.startsWith('/trade') ? 'terminal-main' : ''}>{page}</main>
    <footer className="app-footer"><div><span className={`connection-dot ${live ? '' : 'offline'}`} /><span role="status">{STREAM_LABELS[streamStatus]}</span></div><div>{ScreenIndex && <a href="#/screens"><LayoutGrid size={12} /> Screen index</a>}<button onClick={() => setModal('rules')}>Rules</button><button onClick={() => setModal('help')}><HelpCircle size={13} /> Help</button><span className="network-label">{NETWORK_LABEL} <span className="solana-lines" aria-hidden="true"><i /><i /><i /></span></span></div></footer>
  </div>
  {toast && <div className="toast" role="status" key={toast.key}><span className="toast-check"><Check size={16} /></span><div><strong>{toast.message}</strong>{toast.detail && <p>{toast.detail}</p>}</div><IconButton icon={X} label="Dismiss notification" onClick={() => setToast(null)} /></div>}
  {modal === 'markets' && <Dialog title="Find a market" onClose={closeModal}><div className="search-field"><Search size={17} /><input autoFocus placeholder="Search markets, symbols or asset classes" aria-label="Search markets" value={search} onChange={e => setSearch(e.target.value)} /><kbd>ESC</kbd></div><div className="market-picker-list">{marketsQuery.isPending ? <Pending>Loading GMTrade markets…</Pending> : marketsQuery.isError ? <Unavailable title="Markets are unavailable" error={marketsQuery.error} retry={marketsQuery.refetch} /> : pickerRows.map(m => <button key={m.symbol} onClick={() => selectMarket(m.symbol)}><MarketIcon market={m} /><span><strong>{m.pair}</strong><small>{m.name} · {stageRestriction(m, stage, config.data?.usdcMint)?.label ?? 'Perpetual'}</small></span><span className="picker-price"><strong>{marketPrice(m.price, m)}</strong>{freshnessLabel(m) ? <FreshnessBadge market={m} /> : <small className={m.change24h > 0 ? 'positive' : 'negative'}>{percent(m.change24h)}</small>}</span><ArrowUpRight size={15} /></button>)}{marketsQuery.isSuccess && !pickerRows.length && <div className="empty"><h3>No matching market</h3><p>Try a symbol such as BTC or an asset class.</p></div>}</div><p className="dialog-note">{markets.length ? `${markets.length} GMTrade perpetual markets. Prices update live.` : 'Markets come from GMTrade.'}</p></Dialog>}
  {modal === 'accounts' && <AccountSwitcher onClose={closeModal} />}
  {modal === 'wallet' && <WalletDialog session={session} onClose={closeModal} navigate={navigate} notify={notify} />}
  {modal === 'rules' && <RulesDialog onClose={closeModal} />}
  {modal === 'notifications' && <NotificationsDialog onClose={closeModal} />}
  {modal === 'help' && <Dialog title="A little help, right here" onClose={closeModal}><div className="help-links"><button onClick={() => setModal('rules')}><BookOpen size={20} /><span><strong>Understand your rules</strong><small>Targets, drawdown and payout eligibility.</small></span><ArrowRight size={16} /></button><button onClick={() => navigate('/verify')}><ShieldCheck size={20} /><span><strong>Follow the evidence</strong><small>Account, trade and payout records.</small></span><ArrowRight size={16} /></button><a href="https://docs.gmtrade.xyz/about/trading/" target="_blank" rel="noreferrer"><ExternalLink size={20} /><span><strong>GMTrade documentation</strong><small>How the execution venue fills funded trades.</small></span><ArrowUpRight size={16} /></a></div><div className="shortcut-row"><span>Find a market</span><kbd>⌘ / Ctrl K</kbd></div><div className="shortcut-row"><span>Close a dialog</span><kbd>Esc</kbd></div></Dialog>}
  {modal?.type === 'record' && <RecordDialog record={modal.record} onClose={closeModal} />}
  </AppContext.Provider>;
}

function AccountSwitcher({ onClose }) {
  const { accounts, accountsQuery, accountFor, selectAccount, signedIn, navigate, setModal, stage } = useApp();
  const current = accounts.filter(a => isCurrent(a, accounts)).sort(newestFirst);
  const active = accountFor(stage);
  return <Dialog title="Switch account" onClose={onClose}>{!signedIn ? <Empty icon={Wallet} title="Sign in to see your accounts" action={<Button onClick={() => setModal('wallet')}>Connect wallet</Button>}>Your practice, evaluation and funded accounts belong to your wallet.</Empty> : accountsQuery.isPending ? <Pending>Loading your accounts…</Pending> : accountsQuery.isError ? <Unavailable title="Accounts are unavailable" error={accountsQuery.error} retry={accountsQuery.refetch} /> : !current.length ? <Empty icon={ShieldCheck} title="No active accounts">Start practice for free, or choose an evaluation.</Empty> : <div className="account-picker">{current.map(item => <button key={item.id} onClick={() => selectAccount(item)}><span className="account-initial"><ShieldCheck size={20} /></span><span><strong>{item.label}</strong><small>{item.shortId} · {item.stage === 'funded' ? 'Funded' : 'Simulated'}</small></span><strong>{usd(item.equity)}</strong>{active?.id === item.id && <Check size={17} className="purple-text" />}</button>)}</div>}<Button variant="secondary" className="full-width" onClick={() => navigate('/get-funded')} icon={ArrowRight}>Start another evaluation</Button></Dialog>;
}

function RulesDialog({ onClose }) {
  const { account: stageAccount, tier, config, navigate, path } = useApp();
  // While a tier is being reviewed for purchase, its rules are the ones that matter, not the open account's.
  const account = ONBOARDING.includes(path) ? null : stageAccount;
  const rules = account?.rules ?? (tier && tierRules(tier));
  return <Dialog title={account ? `Rules for ${account.label}` : tier ? `Rules for the ${tier.name} evaluation` : 'Account rules'} onClose={onClose}>{rules ? <><RuleList rules={rules} /><DataRow label="Equity floor" value={usd(rules.floorUsd)} /><DataRow label="Maximum total exposure" value={usd(rules.maxExposureUsd, 0)} />{rules.version != null && <DataRow label="Terms version" value={`v${rules.version}${rules.termsHash ? ` · ${rules.termsHash.slice(0, 8)}` : ''}`} />}<Notice tone="purple">Each position is backed only by its own collateral, so GMTrade can liquidate one position while your account equity is still above its floor. The floor includes open P&L and trading costs across all positions.</Notice></> : config.isError ? <Unavailable title="Rules are unavailable" error={config.error} retry={config.refetch} /> : <Pending>Loading the program rules…</Pending>}{path === '/program' ? <Button className="full-width" onClick={onClose}>Back to program details</Button> : <Button className="full-width" onClick={() => navigate('/program')}>View program details</Button>}</Dialog>;
}

function NotificationsDialog({ onClose }) {
  const { signedIn, navigate, setModal, showsNotification, notificationsQuery: list } = useApp();
  const markRead = useReadNotifications();
  const shown = (list.data ?? []).filter(showsNotification);
  const open = n => { if (!n.read) markRead.mutate([n.id]); if (n.href.startsWith('/')) navigate(n.href); else window.open(n.href, '_blank', 'noreferrer'); };
  return <Dialog title="Notifications" onClose={onClose}>{!signedIn ? <Empty icon={Bell} title="Sign in to see notifications" action={<Button onClick={() => setModal('wallet')}>Connect wallet</Button>}>Fills, account risk and payout updates for your wallet appear here.</Empty> : list.isPending ? <Pending>Loading notifications…</Pending> : list.isError ? <Unavailable title="Notifications are unavailable" error={list.error} retry={list.refetch} /> : !shown.length ? <Empty icon={Bell} title="You're all caught up">New fills, risk alerts and payout updates will appear here.</Empty> : <><div className="notification-list">{shown.map(n => <button key={n.id} onClick={() => open(n)}><span className="notification-icon"><Check size={16} /></span><span><strong>{n.title}</strong><small>{n.body}</small><time>{dateTime(n.ts)}{n.read ? '' : ' · New'}</time></span><ArrowUpRight size={15} /></button>)}</div>{shown.some(n => !n.read) && <Button variant="secondary" className="full-width" disabled={markRead.isPending} onClick={() => markRead.mutate(undefined)}>Mark all as read</Button>}</>}</Dialog>;
}

/** Details of one record: an activity item, trade, payout or evidence item, with its onchain references when it has any. */
function RecordDialog({ record, onClose }) {
  const { navigate } = useApp();
  const reference = record.signature ?? record.address;
  return <Dialog title="Record details" onClose={onClose}><Badge tone={record.simulated ? 'purple' : 'green'}>{record.badge ?? (record.simulated ? 'Simulated' : 'Onchain record')}</Badge><h3 className="record-title">{record.title}</h3>{record.rows.map(([label, value]) => <DataRow key={label} label={label} value={value} />)}{record.signature && <DataRow label="Transaction"><InlineLink href={explorerTx(record.signature)} external>{shortAddress(record.signature)}</InlineLink></DataRow>}{record.address && <DataRow label="Account address"><InlineLink href={explorerAddress(record.address)} external>{shortAddress(record.address)}</InlineLink></DataRow>}<Notice>{record.note ?? (record.simulated ? 'Simulated by the Props.trade engine at live GMTrade prices. It has no blockchain transaction.' : reference ? 'The linked transaction or account is the source of this record.' : 'This record is still being indexed. Its transaction appears here once it is confirmed.')}</Notice>{!record.simulated && reference && <Button className="full-width" onClick={() => navigate(`/verify?q=${reference}`)}>Open verification workspace</Button>}</Dialog>;
}

function WalletDialog({ session, onClose, navigate, notify }) {
  const signedIn = session.status === 'signed-in';
  const usdc = session.me?.usdcBalance;
  async function disconnect() { await session.disconnect(); onClose(); notify('Wallet disconnected'); }
  return <Dialog title={signedIn ? 'Your wallet' : 'Connect a wallet'} onClose={onClose}><div className="wallet-summary"><div className="wallet-large"><Wallet size={25} /></div><strong>{session.address ? shortAddress(session.address) : 'Choose a Solana wallet'}</strong><Badge tone="purple">{session.walletName ?? 'Solana wallet'}</Badge></div><SessionNotice session={session}>{signedIn ? (session.autoSigns ? 'Signed in with Google. Props.trade signs each action when you confirm it here, with no wallet prompt.' : 'Signed in. Every transaction still needs your approval in your wallet.') : 'Signing in proves this wallet is yours. It sends no transaction and costs nothing.'}</SessionNotice>{signedIn ? <><DataRow label="USDC balance" value={usdc == null ? 'Unavailable' : usd(usdc)} /><DataRow label="Network" value={NETWORK_LABEL} /><div className="button-row"><Button variant="secondary" onClick={disconnect}>Disconnect</Button><Button onClick={() => navigate('/settings')}>Preferences</Button></div></> : session.address ? <div className="button-row"><Button variant="secondary" onClick={disconnect}>Disconnect</Button><Button disabled={session.status === 'signing' || session.network.state === 'wrong'} onClick={session.signIn}>{session.status === 'signing' ? (session.autoSigns ? 'Signing in…' : 'Check your wallet…') : 'Sign in'}</Button></div> : <WalletOptions session={session} onChoose={session.connect} />}</Dialog>;
}

