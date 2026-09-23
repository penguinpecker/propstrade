import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownUp, ArrowRight, ArrowUpRight, ChevronDown, Clock3, Expand, Info, Layers3, LineChart, Plus, Settings2, ShieldCheck, Star, Wallet, X } from 'lucide-react';
import { useApp } from './App.jsx';
import { ORDER_STATUS, STAGE_LABELS, STATUS, compactUsd, dateTime, explorerTx, freshnessLabel, isOpenOrder, marginFor, marketPrice, money, number, percent, price, signedUsd, stageRestriction, time, tone, usd, usdBase, utcTime } from './data.js';
import { Badge, Button, DataRow, Dialog, Empty, Field, FreshnessBadge, IconButton, InlineLink, MarketIcon, Notice, Pending, Progress, Tabs, Toggle, Unavailable } from './ui.jsx';
import { applyTick } from './lib/candles';
import { useCancelSimOrder, useCandles, useCloseSimPosition, useHistory, useMarketTrades, useOrders, usePlaceSimOrder, usePositions, useQuote, useResetPractice, useSetSimProtection } from './lib/queries';
import { useWalletTransaction } from './lib/transactions';
const PriceChart = lazy(() => import('./Chart.jsx'));

const TRADABLE_STATUSES = ['active', 'near_limit'];
const newId = () => crypto.randomUUID();
/** Idempotency keys for simulated requests: the same composed request keeps its key across retries until the map is cleared. */
const keyFor = (ids, request) => { const key = JSON.stringify(request); if (!ids.has(key)) ids.set(key, newId()); return ids.get(key); };
const bps = pct => Math.round(Number(pct) * 100);
const leverageText = leverage => number(leverage, Number.isInteger(leverage) ? 0 : 1);
const marketRef = m => ({ marketToken: m.marketToken, symbol: m.symbol });
function useDebounced(value, ms) { const [debounced, setDebounced] = useState(value); useEffect(() => { const id = setTimeout(() => setDebounced(value), ms); return () => clearTimeout(id); }, [value, ms]); return debounced; }
const sessionBadge = m => m.session === 'unknown' ? ['neutral', 'Session unknown'] : [m.session === 'open' ? 'green' : 'amber', `${['Stocks', 'Forex'].includes(m.category) ? 'Session' : 'Market'} ${m.session}`];

export function AccountStrip() {
  const { account, stage, setModal, navigate, signedIn, accountsQuery } = useApp();
  const size = account ? Number(account.rules.sizeUsd) : 0;
  const change = account ? (Number(account.equity) - size) / size * 100 : null;
  const evaluation = stage === 'evaluation';
  const loading = signedIn && !account && accountsQuery.isPending;
  const failed = signedIn && !account && accountsQuery.isError;
  const name = !signedIn ? 'Connect a wallet' : account ? account.label : loading ? 'Loading account…' : failed ? 'Accounts unavailable' : `No ${stage} account`;
  const detail = account ? `${account.shortId}${account.status === 'active' ? '' : ` · ${STATUS[account.status][0]}`}` : !signedIn ? 'Sign in to trade' : loading ? `${STAGE_LABELS[stage]} account` : failed ? 'Your accounts could not be loaded' : stage === 'funded' ? 'Pass an evaluation to get funded' : stage === 'evaluation' ? 'Choose an evaluation to start' : 'Free, with virtual capital';
  const margin = account ? Number(account.availableMargin) / Number(account.rules.lossAllowanceUsd) * 100 : 0;
  return <section className="account-strip" aria-label="Active trading account"><button className="active-account" onClick={() => setModal(signedIn ? 'accounts' : 'wallet')}><span className="account-emblem">{signedIn ? <ShieldCheck size={19} /> : <Wallet size={19} />}</span><span><span className="account-name">{name} <ChevronDown size={12} /></span><small>{detail}</small></span><Badge tone={stage === 'funded' ? 'green' : 'purple'} dot>{stage === 'funded' ? 'Funded' : 'Simulated'}</Badge></button><div className="strip-stat"><span>Account equity</span><strong>{account ? usd(account.equity) : '—'} {account && <small className={tone(change)}>{percent(change)}</small>}</strong></div><div className="strip-stat"><span>Loss allowance <button aria-label="View loss allowance definition" onClick={() => setModal('rules')}><Info size={11} /></button></span><strong>{account ? usd(account.allowanceRemaining) : '—'}<small>remaining</small></strong></div><div className="strip-stat strip-progress"><span>{evaluation ? 'Profit target' : 'Margin available'}<strong>{!account ? '—' : evaluation ? percent(account.targetProgressPct, 1).replace('+', '') : usd(account.availableMargin)}</strong></span><Progress value={!account ? 0 : evaluation ? account.targetProgressPct ?? 0 : margin} label={evaluation ? 'Evaluation target progress' : 'Available margin'} /></div><button className="account-overview" onClick={() => failed ? accountsQuery.refetch() : navigate(account ? `/account/${stage}` : stage === 'practice' ? '/accounts' : '/get-funded')}>{failed ? 'Try again' : account ? 'Account overview' : stage === 'practice' ? 'All accounts' : 'Get funded'} <ArrowUpRight size={14} /></button></section>;
}

export default function Trading() {
  const { account, stage, market, markets, marketsQuery, theme, setModal, favorites, selectMarket, notify, streamStatus, openRecord, navigate, signedIn, accountsQuery } = useApp();
  const client = useQueryClient();
  const [interval, setInterval] = useState('1h');
  const [asLine, setAsLine] = useState(false);
  const [showGuides, setShowGuides] = useState(true);
  const [feedTab, setFeedTab] = useState('Recent trades');
  const [positionTab, setPositionTab] = useState('Positions');
  const [dialog, setDialog] = useState(null);
  const [reducePercent, setReducePercent] = useState(100);
  const [mobileOrder, setMobileOrder] = useState(false);
  const [onlyMarket, setOnlyMarket] = useState(false);
  const [showBalances, setShowBalances] = useState(true);
  const [take, setTake] = useState('');
  const [stop, setStop] = useState('');
  const [side, setSide] = useState('Long');
  const [size, setSize] = useState('1000');
  const [slippage, setSlippage] = useState('0.5');
  const [actionError, setActionError] = useState(null);
  // Two lanes, so an order the ticket sent can await execution while positions are closed and orders canceled.
  const openTx = useWalletTransaction();
  const tx = useWalletTransaction(); // close, protection, cancel
  const [txAction, setTxAction] = useState(null);
  const closeIds = useRef(new Map());
  /** GMTrade orders the order ticket's last funded submit is waiting on. */
  const openFollows = useRef([]);
  const funded = stage === 'funded';
  const accountId = account?.id ?? null;
  const positions = usePositions(accountId);
  const orders = useOrders(accountId);
  const history = useHistory(accountId);
  const openOrders = (orders.data ?? []).filter(isOpenOrder);
  const bySymbol = useMemo(() => new Map(markets.map(m => [m.symbol, m])), [markets]);
  const candles = useCandles(market?.symbol ?? '', interval);
  const marketTrades = useMarketTrades(market?.symbol ?? '');
  const quoteSize = useDebounced(Number(size) > 0 ? Number(size).toFixed(2) : null, 300);
  const quote = useQuote(market?.symbol ?? '', side, market ? quoteSize : null);
  const closeSim = useCloseSimPosition(accountId ?? '');
  const cancelSim = useCancelSimOrder(accountId ?? '');
  const protectSim = useSetSimProtection(accountId ?? '');
  const resetPractice = useResetPractice();
  const refresh = () => client.invalidateQueries({ queryKey: ['account', accountId] }).then(() => client.invalidateQueries({ queryKey: ['accounts'] }));
  const tick = useMemo(() => market?.price && market.updatedAt ? { price: Number(market.price), ts: market.updatedAt } : null, [market?.price, market?.updatedAt]);
  const guides = useMemo(() => showGuides ? (positions.data ?? []).filter(p => p.symbol === market?.symbol).map(p => ({ price: Number(p.entryPrice), title: `${p.side} entry` })) : [], [showGuides, positions.data, market?.symbol]);
  useEffect(() => { if ([tx.phase, openTx.phase].some(phase => phase === 'done' || phase === 'failed')) void refresh(); }, [tx.phase, openTx.phase]);
  useEffect(() => { tx.reset(); openTx.reset(); setActionError(null); }, [accountId]);

  if (!market) return <><AccountStrip /><div className="page">{marketsQuery.isError ? <Unavailable title="Markets are unavailable" error={marketsQuery.error} retry={marketsQuery.refetch} /> : <Pending>Loading GMTrade markets…</Pending>}</div></>;
  const dec = market.priceDecimals;
  const lastCandle = candles.data?.candles.at(-1);
  const bar = tick && lastCandle ? applyTick(lastCandle, tick.price, tick.ts, interval) ?? lastCandle : lastCandle;
  const paused = streamStatus === 'reconnecting' || streamStatus === 'offline';
  const stale = market.freshness === 'stale' || market.freshness === 'unavailable';
  const [sessionTone, sessionLabel] = sessionBadge(market);
  const openInterest = market.openInterestLong != null && market.openInterestShort != null ? Number(market.openInterestLong) + Number(market.openInterestShort) : null;
  const visiblePositions = (positions.data ?? []).filter(p => !onlyMarket || p.symbol === market.symbol);
  const pool = market.pools.find(p => p.marketToken === market.marketToken);
  const capacityShare = (capacity, interest) => capacity == null || interest == null ? 0 : Number(capacity) / (Number(capacity) + Number(interest)) * 100;
  const base = usdBase(market);
  const trades = marketTradesView(marketTrades);
  // A wallet prompt is open (either lane) or a simulated request is in flight. Orders already sent do not block.
  const busy = tx.sending || openTx.sending || closeSim.isPending || cancelSim.isPending || protectSim.isPending;
  const followingAction = action => txAction === action && tx.busy;
  /** Closes a dialog once its action finished, unless another dialog was opened meanwhile. */
  const closeDialog = shown => setDialog(current => current === shown ? null : current);

  async function runFunded(action, prepare, options) { setTxAction(action); return tx.run(prepare, options); }
  async function closePositions(list, percentValue) {
    setActionError(null);
    const shown = dialog;
    if (funded) {
      // Two closes per transaction stay under Solana's 1,232-byte limit (three measure 1,223 B, too tight once a wallet
      // adds its own instructions). ponytail: an address lookup table would fit all eight slots in one transaction.
      for (let i = 0; i < list.length; i += 2) {
        const chunk = list.slice(i, i + 2);
        const result = await runFunded('close', (chain, connection, trader) => chain.prepareClose(connection, trader, { funded: accountId, slippageBps: bps(slippage), positions: chunk.map(p => ({ market: marketRef(bySymbol.get(p.symbol)), isLong: p.side === 'Long', markPrice: p.markPrice ?? bySymbol.get(p.symbol).price, sizeUsd: Number(p.sizeUsd), percent: percentValue })) }), { execution: prepared => prepared.follows, done: 'Close executed by GMTrade.' });
        if (!result || result.execution === 'cancelled') return; // the dialog stays open with the outcome; Positions shows what is still open
      }
      closeDialog(shown);
      return;
    }
    try {
      for (const p of list) await closeSim.mutateAsync({ positionId: p.id, body: { clientId: keyFor(closeIds.current, [accountId, p.id, percentValue]), percent: percentValue, slippageBps: bps(slippage) } });
      closeIds.current.clear();
      closeDialog(shown); notify(percentValue === 100 ? 'Simulated close submitted' : 'Simulated reduce submitted', `${list.map(p => p.symbol).join(', ')} · ${percentValue}%`);
    } catch (error) { setActionError(error.message); }
  }
  async function saveProtection(position) {
    setActionError(null);
    const next = { takeProfit: take.trim() || null, stopLoss: stop.trim() || null };
    const shown = dialog;
    if (funded) {
      const orderOf = protection => protection ? (orders.data ?? []).find(o => o.id === protection.orderId)?.gmOrder ?? protection.orderId : null;
      const result = await runFunded('protection', (chain, connection, trader) => chain.prepareProtection(connection, trader, { funded: accountId, market: marketRef(bySymbol.get(position.symbol)), isLong: position.side === 'Long', takeProfit: { order: orderOf(position.takeProfit), price: next.takeProfit }, stopLoss: { order: orderOf(position.stopLoss), price: next.stopLoss } }), { done: 'Protection orders updated on GMTrade.' });
      if (result) { closeDialog(shown); notify('Protection updated', `${position.symbol} · confirmed onchain`); }
      return;
    }
    try { await protectSim.mutateAsync({ positionId: position.id, body: next }); closeDialog(shown); notify('Position protection updated'); } catch (error) { setActionError(error.message); }
  }
  async function cancelOrder(order) {
    setActionError(null);
    if (funded) {
      const address = order.gmOrder ?? order.id;
      const result = await runFunded('cancel', (chain, connection, trader) => chain.prepareCancel(connection, trader, accountId, address), { done: 'Order canceled on GMTrade.' });
      // The ticket was waiting for GMTrade to execute this order: it ended by the trader's cancel, not by the venue.
      if (result && openFollows.current.includes(address)) openTx.reset();
      return;
    }
    try { await cancelSim.mutateAsync(order.id); notify('Simulated order canceled'); } catch (error) { setActionError(error.message); }
  }
  const protectionInvalid = position => { const mark = Number(position.markPrice ?? market.price); const long = position.side === 'Long'; return (take && !(long ? Number(take) > mark : Number(take) < mark && Number(take) > 0)) || (stop && !(long ? Number(stop) < mark && Number(stop) > 0 : Number(stop) > mark)); };
  const actionStatus = action => txAction === action && tx.phase !== 'idle' ? <TxStatus tx={tx} /> : actionError && <Notice tone="amber" role="alert">{actionError}</Notice>;
  const noAccountEmpty = !signedIn ? <Empty icon={Wallet} title="Sign in to trade" action={<Button small onClick={() => setModal('wallet')}>Connect wallet</Button>}>Your positions, orders and history appear here once you sign in.</Empty> : !account && (accountsQuery.isPending ? <Pending>Loading your account…</Pending> : accountsQuery.isError ? <Unavailable title="Accounts are unavailable" error={accountsQuery.error} retry={accountsQuery.refetch} /> : <Empty icon={Layers3} title={`No ${stage} account yet`} action={<Button small variant="secondary" onClick={() => navigate(stage === 'practice' ? '/accounts' : '/get-funded')}>{stage === 'practice' ? 'Open accounts' : 'Get funded'}</Button>}>{stage === 'funded' ? 'Pass an evaluation and activate funding to trade live on GMTrade.' : stage === 'evaluation' ? 'Buy an evaluation to start trading under its rules.' : 'Start a free practice account from the order ticket.'}</Empty>);

  return <>
    <AccountStrip />
    <div className="watchlist-bar"><button className="watchlist-title" onClick={() => navigate('/markets')}><Star size={12} /> Watchlist</button>{markets.filter(m => favorites.includes(m.symbol)).map(m => <button key={m.symbol} className={market.symbol === m.symbol ? 'selected' : ''} onClick={() => selectMarket(m.symbol)}><span>{m.symbol}</span><span>{price(m.price, m.priceDecimals)}</span>{freshnessLabel(m) ? <FreshnessBadge market={m} /> : <small className={m.change24h > 0 ? 'positive' : 'negative'}>{percent(m.change24h)}</small>}</button>)}<IconButton icon={Plus} label="Add a market to your watchlist" onClick={() => navigate('/markets')} /><a href="#/markets">All markets <ArrowUpRight size={12} /></a></div>
    <div className="trading-layout">
      <section className="market-workspace">
        <div className="market-heading"><button className="market-select" onClick={() => setModal('markets')}><MarketIcon market={market} /><span><strong>{market.pair.split(' / ')[0]}<span className="quiet"> / {market.pair.split(' / ')[1]}</span></strong><small>{market.name} perpetual</small></span><ChevronDown size={15} /></button><div className="market-price"><strong>{price(market.price, dec)}</strong><span className={market.change24h > 0 ? 'positive' : 'negative'}>{percent(market.change24h)} <small>24h</small></span></div><div className="market-metric"><span>24h volume</span><strong>{compactUsd(market.volume24h)}</strong></div><div className="market-metric"><span>Open interest</span><strong>{compactUsd(openInterest)}</strong></div><div className="market-metric rate-metric"><span>Funding / hour</span><strong className={market.fundingRateHourlyLong == null ? '' : tone(market.fundingRateHourlyLong)} title="Paid by longs when positive, received when negative">{percent(market.fundingRateHourlyLong, 4)}</strong></div><Badge tone={sessionTone} dot title={market.sessionNote}>{sessionLabel}</Badge></div>
        <div className="chart-and-feed"><div className="chart-section"><div className="chart-toolbar"><div className="timeframes">{['5m', '15m', '1h', '4h', '1D'].map(t => <button key={t} className={interval === t ? 'active' : ''} onClick={() => setInterval(t)}>{t}</button>)}</div><span className="toolbar-divider" /><button className={asLine ? 'chart-option active' : 'chart-option'} onClick={() => setAsLine(!asLine)}><LineChart size={14} /><span>{asLine ? 'Candles' : 'Line'}</span></button><button className={showGuides ? 'chart-option active' : 'chart-option'} onClick={() => setShowGuides(!showGuides)}><Layers3 size={14} /><span>Positions</span></button><div className="toolbar-spacer" /><IconButton icon={Expand} label="Expand price chart" onClick={() => setDialog('chart')} /></div><div className="ohlc-line"><span>{market.symbol} · {interval}</span><span>O <b>{price(bar?.open, dec)}</b></span><span>H <b>{price(bar?.high, dec)}</b></span><span>L <b>{price(bar?.low, dec)}</b></span><span>C <b className={bar && bar.close < bar.open ? 'negative' : 'positive'}>{price(bar?.close, dec)}</b></span></div>{candles.isPending ? <div className="chart-skeleton" role="status" aria-label="Loading candles" /> : candles.isError ? <Unavailable title="Candles are unavailable" error={candles.error} retry={candles.refetch} /> : !candles.data.candles.length ? <Empty icon={LineChart} title="No candles yet">GMTrade has no price history for this market and interval.</Empty> : <Suspense fallback={<div className="chart-skeleton" />}><PriceChart theme={theme} market={market} candles={candles.data.candles} tick={tick} interval={interval} line={asLine} guides={guides} /></Suspense>}<div className="chart-bottom"><span>GMTrade prices{candles.data && candles.data.freshness !== 'live' ? " · saved copy while GMTrade's charts recover" : ''}</span><a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView <ArrowUpRight size={10} /></a><span>{utcTime(market.updatedAt)}</span><button onClick={() => setInterval('1D')}>Auto</button></div>{(paused || stale) && <div className="stale-overlay"><Clock3 size={19} /><strong>{paused ? 'Price updates paused' : market.freshness === 'unavailable' ? 'Price unavailable' : 'Price is stale'}</strong><span>{paused ? `Last price shown${market.updatedAt ? ` from ${utcTime(market.updatedAt)}` : ''}. Reconnecting automatically.` : market.updatedAt ? `GMTrade's last update was at ${utcTime(market.updatedAt)}.` : 'GMTrade has not published a price for this market.'}</span></div>}</div>
          <aside className="trade-feed"><Tabs items={['Recent trades', 'Liquidity']} value={feedTab} onChange={setFeedTab} />{feedTab === 'Recent trades' ? trades.state ?? <><div className="feed-labels"><span>Price ({market.pair.split(' / ')[1]})</span><span>Size ({base ?? 'USD'})</span><span>Time</span></div><div className="feed-rows">{trades.rows.map(t => <div key={t.id}><span className={t.buy ? 'positive' : 'negative'}>{price(t.price, dec)}</span><span>{base ? number(Number(t.sizeUsd) / Number(t.price), 4) : compactUsd(t.sizeUsd)}</span><time>{time(t.ts)}</time></div>)}</div><div className="feed-bottom"><span>Buy volume <b>{number(trades.buyShare, 0)}%</b></span><Progress value={trades.buyShare} tone="green" label="Buy share of recent trade volume" /><span>Sell volume <b>{number(100 - trades.buyShare, 0)}%</b></span></div></> : <div className="liquidity-view"><Badge tone="purple">GMTrade pool</Badge><h3>{pool?.name ?? market.pair}</h3><p>Open interest this pool can still take, and the pool's own liquidity.</p><DataRow label="Long capacity" value={compactUsd(market.capacityLong)} /><Progress value={capacityShare(market.capacityLong, market.openInterestLong)} tone="green" label="Long capacity left" /><DataRow label="Short capacity" value={compactUsd(market.capacityShort)} /><Progress value={capacityShare(market.capacityShort, market.openInterestShort)} label="Short capacity left" /><DataRow label="Pool liquidity" value={compactUsd(market.poolLiquidity)} /><DataRow label={`Price impact · ${money(Number(size) || 0, 0)} ${side.toLowerCase()}`} value={quote.data ? `${number(quote.data.priceImpactPct, 4)}%` : quote.isError ? 'Unavailable' : '—'} /><p className="micro-copy">Execution depends on pool conditions when a GMTrade keeper executes the order.</p><button className="text-button" onClick={() => navigate('/vault')}>About the capital vault <ArrowUpRight size={13} /></button></div>}</aside>
        </div>
        <div className="positions-panel"><div className="position-toolbar"><Tabs items={[{ value: 'Positions', label: <>Positions <span className="tab-count">{positions.data?.length ?? 0}</span></> }, { value: 'Open orders', label: <>Open orders <span className="tab-count">{openOrders.length}</span></> }, 'Trade history']} value={positionTab} onChange={setPositionTab} /><div className="position-tools"><label className="checkbox-label"><input type="checkbox" checked={onlyMarket} onChange={e => setOnlyMarket(e.target.checked)} /> This market</label><button className="text-button" onClick={() => { setActionError(null); setDialog('close-all'); }} disabled={!positions.data?.length || busy}>Close all</button><IconButton icon={Settings2} label="Toggle account balances" onClick={() => setShowBalances(!showBalances)} /></div></div>
        {!dialog && (txAction && tx.phase !== 'idle' ? <TxStatus tx={tx} /> : actionError && <Notice tone="amber" role="alert">{actionError}</Notice>)}
        {positionTab === 'Positions' && <div className="table-scroll">{noAccountEmpty || (positions.isPending ? <Pending>Loading positions…</Pending> : positions.isError ? <Unavailable title="Positions are unavailable" error={positions.error} retry={positions.refetch} /> : <><table className="position-table"><thead><tr><th>Market / side</th><th>Position size</th><th>Entry price</th><th>Mark price</th><th>Liq. price</th><th>Unrealized P&L</th><th>TP / SL</th><th /></tr></thead><tbody>{visiblePositions.map(p => { const m = bySymbol.get(p.symbol) ?? { symbol: p.symbol, priceDecimals: 2, pair: `${p.symbol} / USD` }; return <tr key={p.id}><td><div className="table-market"><MarketIcon market={m} small /><span><strong>{m.pair}</strong><small className={p.side === 'Long' ? 'positive' : 'negative'}>{p.side} <span className="leverage-badge">{leverageText(p.leverage)}×</span></small></span></div></td><td><strong>{number(Number(p.sizeTokens), 4)} {p.symbol}</strong><small>{usd(p.sizeUsd)} · {usd(p.collateralUsd)} margin</small></td><td>{price(p.entryPrice, m.priceDecimals)}</td><td>{price(p.markPrice ?? m.price, m.priceDecimals)}</td><td title="GMTrade liquidates this position at about this price: its own collateral backs it">{price(p.liquidationPrice, m.priceDecimals)}</td><td><strong className={tone(p.unrealizedPnl ?? 0)}>{signedUsd(p.unrealizedPnl)}</strong><small className={tone(p.unrealizedPnl ?? 0)}>{p.unrealizedPnl == null ? '' : percent(Number(p.unrealizedPnl) / Number(p.collateralUsd) * 100)}</small></td><td><button className="position-protection" onClick={() => { setActionError(null); setDialog({ type: 'protection', position: p }); setTake(p.takeProfit?.price ?? ''); setStop(p.stopLoss?.price ?? ''); }}>{p.takeProfit ? price(p.takeProfit.price, m.priceDecimals) : 'Add TP'} <span>/</span> {p.stopLoss ? price(p.stopLoss.price, m.priceDecimals) : 'Add SL'}</button></td><td><button className="table-action" disabled={busy} onClick={() => { setActionError(null); setReducePercent(100); setDialog({ type: 'close', position: p }); }}>Close <X size={11} /></button></td></tr>; })}</tbody></table><div className="mobile-positions">{visiblePositions.map(p => { const m = bySymbol.get(p.symbol) ?? { symbol: p.symbol, priceDecimals: 2, pair: `${p.symbol} / USD` }; return <article key={p.id}><div className="mobile-position-title"><MarketIcon market={m} small /><strong>{m.pair}</strong><Badge tone={p.side === 'Long' ? 'green' : 'red'}>{p.side} · {leverageText(p.leverage)}×</Badge><strong className={tone(p.unrealizedPnl ?? 0)}>{signedUsd(p.unrealizedPnl)}</strong></div><div className="mobile-position-stats"><span>Size <b>{number(Number(p.sizeTokens), 4)} {p.symbol}</b></span><span>Margin <b>{usd(p.collateralUsd)}</b></span><span>Entry <b>{price(p.entryPrice, m.priceDecimals)}</b></span><span>Liq. price <b>{price(p.liquidationPrice, m.priceDecimals)}</b></span></div><div className="mobile-position-actions"><button onClick={() => { setActionError(null); setDialog({ type: 'protection', position: p }); setTake(p.takeProfit?.price ?? ''); setStop(p.stopLoss?.price ?? ''); }}>TP / SL <ShieldCheck size={12} /></button><button disabled={busy} onClick={() => { setActionError(null); setReducePercent(100); setDialog({ type: 'close', position: p }); }}>Close position <X size={12} /></button></div></article>; })}</div>{visiblePositions.length === 0 && <Empty icon={Layers3} title="Room for your next trade">Your open positions will appear here, with risk and P&L in one place.</Empty>}</>)}</div>}
        {positionTab === 'Open orders' && <div className="table-scroll">{noAccountEmpty || (orders.isPending ? <Pending>Loading orders…</Pending> : orders.isError ? <Unavailable title="Orders are unavailable" error={orders.error} retry={orders.refetch} /> : <><table><thead><tr><th>Market</th><th>Side / type</th><th>Size</th><th>Trigger price</th><th>Status</th><th /></tr></thead><tbody>{openOrders.filter(o => !onlyMarket || o.symbol === market.symbol).map(o => <tr key={o.id}><td><strong>{bySymbol.get(o.symbol)?.pair ?? o.symbol}</strong></td><td>{o.side} · {o.kind === 'TakeProfit' ? 'Take profit' : o.kind === 'StopLoss' ? 'Stop loss' : o.kind}</td><td>{o.isIncrease ? usd(o.sizeUsd) : 'Whole position'}</td><td>{price(o.triggerPrice, bySymbol.get(o.symbol)?.priceDecimals ?? 2)}</td><td><span title={o.statusDetail}><Badge tone={o.status === 'frozen' || o.status === 'unknown' ? 'red' : 'amber'}>{ORDER_STATUS[o.status]}</Badge></span></td><td><button className="table-action" disabled={busy} onClick={() => cancelOrder(o)}>Cancel</button></td></tr>)}</tbody></table>{openOrders.length === 0 && <Empty icon={Clock3} title="No working orders">Limit and trigger orders will appear here until filled or canceled.</Empty>}</>)}</div>}
        {positionTab === 'Trade history' && <div className="table-scroll">{noAccountEmpty || (history.isPending ? <Pending>Loading trade history…</Pending> : history.isError ? <Unavailable title="Trade history is unavailable" error={history.error} retry={history.refetch} /> : <><table><thead><tr><th>Market</th><th>Side</th><th>Closed at</th><th>Size</th><th>Realized P&L</th><th /></tr></thead><tbody>{history.data.slice(0, 10).map(t => <tr key={t.id}><td><strong>{bySymbol.get(t.symbol)?.pair ?? t.symbol}</strong></td><td>{t.side}</td><td>{dateTime(t.closedAt)}</td><td>{usd(t.sizeUsd)}</td><td className={tone(t.netPnl)}>{signedUsd(t.netPnl)}</td><td><IconButton icon={ArrowUpRight} label={`View trade ${t.id}`} onClick={() => openRecord(tradeRecord(t, bySymbol))} /></td></tr>)}</tbody></table>{history.data.length === 0 && <Empty icon={Clock3} title="No closed trades yet">Closed trades appear here with their fees and net result.</Empty>}</>)}</div>}
        {showBalances && account && <div className="positions-summary"><span>Unrealized P&L <b className={tone(account.unrealizedPnl)}>{signedUsd(account.unrealizedPnl)}</b></span><span>Account <b>{account.shortId}</b></span><button onClick={() => navigate('/activity')}>All activity <ArrowUpRight size={12} /></button></div>}</div>
      </section>
      <OrderTicket mobileOrder={mobileOrder} setMobileOrder={setMobileOrder} tx={openTx} follows={openFollows} walletPrompt={tx.sending} side={side} setSide={setSide} size={size} setSize={setSize} slippage={slippage} setDialog={setDialog} quote={quote} orders={orders.data} openOrders={openOrders} resetPractice={resetPractice} />
    </div><button className="mobile-trade-action" onClick={() => setMobileOrder(true)}>Trade {market.symbol} <ArrowDownUp size={17} /></button>
    {dialog === 'slippage' && <SlippageDialog value={slippage} onSave={setSlippage} onClose={() => setDialog(null)} />}
    {dialog === 'chart' && <Dialog title={`${market.pair} · Price chart`} wide onClose={() => setDialog(null)}><div className="expanded-chart">{candles.data?.candles.length ? <Suspense fallback={<div className="chart-skeleton" />}><PriceChart theme={theme} market={market} candles={candles.data.candles} tick={tick} interval={interval} line={asLine} guides={guides} /></Suspense> : <div className="chart-skeleton" />}</div></Dialog>}
    {(dialog === 'close-all' || dialog?.type === 'close') && <Dialog title={dialog === 'close-all' ? 'Close all positions?' : `Close ${dialog.position.symbol} position`} onClose={() => setDialog(null)}><Notice>{funded ? `A market close order goes to GMTrade from your funded account, with ${slippage}% slippage tolerance. A GMTrade keeper executes it, usually within seconds.` : 'The simulator closes at the next live GMTrade price, with the same fees and price impact as the venue.'}</Notice>{dialog !== 'close-all' && <><DataRow label="Current position" value={`${number(Number(dialog.position.sizeTokens), 4)} ${dialog.position.symbol} · ${usd(dialog.position.sizeUsd)}`} /><Field label={`Amount to close · ${reducePercent}%`}><input type="range" min="10" max="100" step="10" value={reducePercent} onChange={e => setReducePercent(Number(e.target.value))} /></Field></>}{actionStatus('close')}<div className="button-row"><Button variant="secondary" onClick={() => setDialog(null)}>Keep position</Button><Button disabled={busy || followingAction('close')} onClick={() => closePositions(dialog === 'close-all' ? positions.data : [dialog.position], dialog === 'close-all' ? 100 : reducePercent)}>{closeSim.isPending || followingAction('close') ? 'Closing…' : funded ? 'Send close order' : 'Confirm close'}</Button></div></Dialog>}
    {dialog?.type === 'protection' && <Dialog title={`Protect your ${dialog.position.symbol} position`} onClose={() => setDialog(null)}><Field label="Take-profit price"><input type="number" step="any" min="0" value={take} placeholder="None" onChange={e => setTake(e.target.value)} /></Field><Field label="Stop-loss price"><input type="number" step="any" min="0" value={stop} placeholder="None" onChange={e => setStop(e.target.value)} /></Field>{protectionInvalid(dialog.position) && <p className="field-error">Set take profit and stop loss on the correct sides of the mark price.</p>}<Notice>{funded ? 'Take-profit and stop-loss orders close the whole position when GMTrade\'s price reaches them. They execute as market orders, so the fill can differ from the trigger price.' : 'The simulator triggers these on live GMTrade prices, like GMTrade\'s own trigger orders. Leave a field empty to remove it.'}</Notice>{actionStatus('protection')}<Button className="full-width" disabled={busy || followingAction('protection') || !!protectionInvalid(dialog.position)} onClick={() => saveProtection(dialog.position)}>{protectSim.isPending || followingAction('protection') ? 'Saving…' : 'Save protections'}</Button></Dialog>}
  </>;
}

/** Edits a draft: only a saved value (above 0, at most 5%) becomes the tolerance orders use. */
function SlippageDialog({ value, onSave, onClose }) {
  const [draft, setDraft] = useState(value);
  const valid = Number(draft) > 0 && Number(draft) <= 5;
  return <Dialog title="Slippage tolerance" onClose={onClose}><p className="dialog-note">The maximum price change you accept between submitting and execution. GMTrade cancels a market order it cannot fill within this limit.</p><Field label="Maximum slippage (%)"><input type="number" min="0.01" max="5" step=".1" value={draft} onChange={e => setDraft(e.target.value)} /></Field><Button className="full-width" disabled={!valid} onClick={() => { onSave(draft); onClose(); }}>Save tolerance</Button></Dialog>;
}

/** Recent GMTrade trades for the feed: the rows, the buy share of their volume, or the state to show instead. */
function marketTradesView(query) {
  if (query.isPending) return { state: <Pending>Loading trades…</Pending> };
  if (query.isError) return { state: <Unavailable title="Trades are unavailable" error={query.error} retry={query.refetch} /> };
  if (!query.data.length) return { state: <Empty icon={Clock3} title="No recent trades">GMTrade has no recent trades in this market.</Empty> };
  const rows = query.data.map(t => ({ ...t, buy: (t.side === 'Long') === t.isIncrease }));
  const total = rows.reduce((sum, t) => sum + Number(t.sizeUsd), 0);
  return { rows, buyShare: total ? rows.filter(t => t.buy).reduce((sum, t) => sum + Number(t.sizeUsd), 0) / total * 100 : 0 };
}

export const tradeRecord = (t, bySymbol) => ({
  title: `${bySymbol.get(t.symbol)?.pair ?? t.symbol} · ${t.side} closed`, simulated: t.venue === 'simulated', signature: t.signatures[0],
  rows: [['Opened', dateTime(t.openedAt)], ['Closed', dateTime(t.closedAt)], ['Position value', usd(t.sizeUsd)], ['Entry price', price(t.entryPrice, bySymbol.get(t.symbol)?.priceDecimals ?? 2)], ['Exit price', price(t.exitPrice, bySymbol.get(t.symbol)?.priceDecimals ?? 2)], ['Trading fees', usd(t.feesUsd)], ['Net P&L', signedUsd(t.netPnl)]],
});

const TX_LABELS = { preparing: 'Preparing transaction…', signing: 'Approve in your wallet…', submitted: 'Confirming onchain…', awaiting_execution: 'Awaiting execution…' };
/** Progress and outcome of the terminal's wallet transaction. */
function TxStatus({ tx }) {
  if (tx.busy) return <Notice role="status"><span>{TX_LABELS[tx.phase]}{tx.signature && <> · <InlineLink href={explorerTx(tx.signature)} external>View transaction</InlineLink></>}</span></Notice>;
  if (!tx.message && tx.phase !== 'failed') return null;
  return <Notice tone={tx.phase === 'failed' ? 'amber' : 'purple'} role={tx.phase === 'failed' ? 'alert' : 'status'}><span>{tx.message}{tx.signature && <> · <InlineLink href={explorerTx(tx.signature)} external>View transaction</InlineLink></>}</span></Notice>;
}

function OrderTicket({ mobileOrder, setMobileOrder, tx, follows, walletPrompt, side, setSide, size, setSize, slippage, setDialog, quote, orders, openOrders, resetPractice }) {
  const { account, stage, market, setModal, notify, live, navigate, signedIn, session, config, accountsQuery } = useApp();
  const client = useQueryClient();
  const [orderType, setOrderType] = useState('Market');
  const [limitPrice, setLimitPrice] = useState('');
  const [leverage, setLeverage] = useState(5);
  const [leverageOpen, setLeverageOpen] = useState(false);
  const [protection, setProtection] = useState(false);
  const [take, setTake] = useState('');
  const [stop, setStop] = useState('');
  const [simOrder, setSimOrder] = useState(null); // { id, since, status, message }
  const orderIds = useRef(new Map());
  const placeSim = usePlaceSimOrder(account?.id ?? '');
  const funded = stage === 'funded';
  const maxLeverage = market.maxLeverage;
  const lev = Math.min(leverage, maxLeverage);
  const sizeNum = Number(size) || 0;
  const reference = orderType === 'Market' ? Number(market.price) : Number(limitPrice);
  const pendingIncrease = openOrders.filter(o => o.isIncrease).reduce((sum, o) => sum + Number(o.sizeUsd), 0);
  const exposureRoom = account ? Number(account.rules.maxExposureUsd) - Number(account.openNotional) - pendingIncrease : 0;
  const buyingPower = account ? Math.max(0, Math.min(exposureRoom, Number(account.availableMargin) * lev)) : 0;
  const wrongLimit = orderType === 'Limit' && !(Number(limitPrice) > 0);
  const wrongProtection = protection && ((take && !(side === 'Long' ? Number(take) > reference : Number(take) < reference && Number(take) > 0)) || (stop && !(side === 'Long' ? Number(stop) < reference && Number(stop) > 0 : Number(stop) > reference)) || (!take && !stop));
  const tooSmall = sizeNum > 0 && sizeNum < 1;
  const restriction = stageRestriction(market, stage, config.data?.usdcMint);
  const blocked = !signedIn ? null
    : !account ? (accountsQuery.isError ? 'Your accounts could not be loaded. Orders are accepted once they load.' : stage === 'practice' || accountsQuery.isPending ? null : `You have no ${stage} account yet.`)
    : !TRADABLE_STATUSES.includes(account.status) ? `This account is ${STATUS[account.status][0].toLowerCase()}: new orders are not accepted. Closing positions still works.`
    : restriction ? restriction.reason
    : funded && config.data?.paused.trading ? 'Funded trading is paused by the operator. Closing positions and canceling orders still work.'
    : funded && (market.freshness === 'stale' || market.freshness === 'unavailable') ? `GMTrade's price for ${market.pair} is ${market.freshness}. Funded orders resume when it updates.`
    : market.session === 'closed' ? `${market.pair} is closed. GMTrade accepts orders again when the ${['Stocks', 'Forex'].includes(market.category) ? 'session' : 'market'} reopens.`
    : funded && session.network.state === 'wrong' ? session.network.reason
    : null;
  const simBusy = placeSim.isPending || simOrder?.status === 'awaiting';
  const busy = funded ? tx.busy || walletPrompt : simBusy;
  const invalid = !(sizeNum > 0) || sizeNum > buyingPower || tooSmall || wrongLimit || wrongProtection || !(reference > 0);
  useEffect(() => { setSimOrder(null); }, [account?.id]);
  useEffect(() => { if (leverage > maxLeverage) setLeverage(maxLeverage); }, [maxLeverage]);
  // A simulated market order fills at the first live price at least 2 s after submission: follow it until it leaves Open orders.
  const tracked = simOrder?.status === 'awaiting' && orders ? orders.find(o => o.id === simOrder.id) ?? null : undefined;
  useEffect(() => {
    if (simOrder?.status !== 'awaiting') return;
    const timer = setInterval(() => client.invalidateQueries({ queryKey: ['account', account?.id] }), 2000);
    return () => clearInterval(timer);
  }, [simOrder?.status, account?.id]);
  useEffect(() => {
    if (tracked === undefined) return;
    if (tracked?.status === 'rejected' || tracked?.status === 'canceled') setSimOrder({ ...simOrder, status: 'failed', message: tracked.statusDetail ?? `The order was ${tracked.status}.` });
    else if (tracked?.status === 'executed') { setSimOrder({ ...simOrder, status: 'done', message: 'Simulated order filled at the live GMTrade price.' }); notify('Simulated order filled', `${simOrder.symbol} · ${account.label}`); }
    else if (tracked === null) setSimOrder({ ...simOrder, status: 'done', message: 'The simulated order is no longer pending. Positions and Activity show its result.' });
    else if (Date.now() - simOrder.since > 60_000) setSimOrder({ ...simOrder, status: 'done', message: 'Still awaiting execution. It stays under Open orders until it fills.' });
  }, [tracked]);
  function toggleProtection(on) { setProtection(on); if (!on) { setTake(''); setStop(''); } }
  async function submit(e) {
    e.preventDefault();
    if (invalid || busy || blocked || !live || !account) return;
    const body = { sizeUsd: sizeNum.toFixed(6), collateralUsd: marginFor(sizeNum, lev), takeProfit: protection && take ? take : undefined, stopLoss: protection && stop ? stop : undefined };
    if (funded) {
      const result = await tx.run((chain, connection, trader) => chain.prepareOpen(connection, trader, { funded: account.id, market: marketRef(market), isLong: side === 'Long', kind: orderType, price: orderType === 'Market' ? market.price : limitPrice, sizeUsd: sizeNum, collateralUsd: Number(body.collateralUsd), slippageBps: bps(slippage), takeProfit: body.takeProfit, stopLoss: body.stopLoss }), { execution: prepared => { follows.current = orderType === 'Market' ? prepared.follows.map(f => f.order) : []; return orderType === 'Market' ? prepared.follows : []; }, done: orderType === 'Market' ? `${market.symbol} ${side.toLowerCase()} executed on GMTrade.` : 'Limit order placed on GMTrade. It executes when the price reaches your limit.' });
      if (result) setMobileOrder(false);
      return;
    }
    setSimOrder(null);
    try {
      const request = { symbol: market.symbol, side, kind: orderType, triggerPrice: orderType === 'Limit' ? limitPrice : undefined, slippageBps: bps(slippage), ...body };
      const { order } = await placeSim.mutateAsync({ clientId: keyFor(orderIds.current, [account.id, request]), ...request });
      orderIds.current.clear();
      if (orderType === 'Market' && order.status !== 'executed') setSimOrder({ id: order.id, symbol: market.symbol, since: Date.now(), status: 'awaiting' });
      else { setSimOrder({ id: order.id, status: 'done', message: orderType === 'Market' ? 'Simulated order filled at the live GMTrade price.' : 'Simulated limit order placed. It fills when the live price reaches your limit.' }); notify(orderType === 'Market' ? 'Simulated order filled' : 'Limit order added', `${market.symbol} ${side.toLowerCase()} · ${account.label}`); }
      setMobileOrder(false);
    } catch (error) { setSimOrder({ status: 'failed', message: error.message }); }
  }
  const submitLabel = funded && tx.busy ? TX_LABELS[tx.phase] : placeSim.isPending ? 'Submitting…' : simOrder?.status === 'awaiting' ? 'Awaiting execution…' : `${side === 'Long' ? 'Buy / Long' : 'Sell / Short'} ${market.symbol}`;
  const rules = account?.rules;
  return <><aside className={`order-panel ${mobileOrder ? 'mobile-visible' : ''}`}><div className="order-panel-heading"><h2>Place an order</h2><Badge tone={funded ? 'green' : 'purple'}>{funded ? 'Funded' : stage === 'practice' ? 'Practice' : 'Evaluation'}</Badge><IconButton className="mobile-close-order" icon={X} label="Close order form" onClick={() => setMobileOrder(false)} /></div><form onSubmit={submit} className="order-form"><div className="side-toggle"><button type="button" className={side === 'Long' ? 'active long' : ''} onClick={() => setSide('Long')}>Buy / Long</button><button type="button" className={side === 'Short' ? 'active short' : ''} onClick={() => setSide('Short')}>Sell / Short</button></div><Tabs items={['Market', 'Limit']} value={orderType} onChange={setOrderType} className="order-type-tabs" /><div className="ticket-subrow"><span>Margin · USDC</span><button type="button" onClick={() => setLeverageOpen(true)}>{lev}× leverage <ChevronDown size={12} /></button></div>{orderType === 'Limit' && <Field label="Limit price"><div className="input-unit"><input aria-label="Order price" type="number" min="0" step="any" value={limitPrice} placeholder={price(market.price, market.priceDecimals)} onChange={e => setLimitPrice(e.target.value)} /><span>{market.pair.split(' / ')[1]}</span></div></Field>}<Field label="Order size"><div className="input-unit large-input"><input aria-label="Order size in USD" type="number" min="1" max={buyingPower} value={size} onChange={e => setSize(e.target.value)} /><span>USD</span></div></Field><div className="size-equivalent"><span>{usdBase(market) && reference > 0 ? `≈ ${number(sizeNum / reference, 5)} ${usdBase(market)}` : `Margin ${money(sizeNum / lev)}`}</span><span>Buying power <b>{account ? money(buyingPower, 0) : '—'}</b></span></div><input className="size-slider" aria-label="Percentage of buying power" type="range" min="0" max="100" step="1" disabled={!buyingPower} value={buyingPower ? Math.min(sizeNum / buyingPower * 100, 100) : 0} onChange={e => setSize(String(Math.floor(Number(e.target.value) / 100 * buyingPower)))} style={{ '--range': `${buyingPower ? Math.min(sizeNum / buyingPower * 100, 100) : 0}%` }} /><div className="size-presets">{[25, 50, 75, 100].map(n => <button type="button" key={n} disabled={!buyingPower} onClick={() => setSize(String(Math.floor(n / 100 * buyingPower)))}>{n}%</button>)}</div><div className="protection-toggle"><span><ShieldCheck size={14} /> Take profit / Stop loss</span><Toggle label="Enable take profit and stop loss" checked={protection} onChange={toggleProtection} /></div>{protection && <div className="dual-fields"><Field label="Take profit"><input type="number" step="any" min="0" value={take} placeholder="None" onChange={e => setTake(e.target.value)} /></Field><Field label="Stop loss"><input type="number" step="any" min="0" value={stop} placeholder="None" onChange={e => setStop(e.target.value)} /></Field></div>}<div className="execution-details"><DataRow label="Estimated entry" value={marketPrice(orderType === 'Market' ? quote.data?.executionPrice ?? market.price : limitPrice || null, market)} /><DataRow label="Required margin" value={money(sizeNum / lev)} /><DataRow label="Trading fee" value={quote.data ? usd(quote.data.openFeeUsd) : quote.isError ? 'Unavailable' : '—'} /><DataRow label="Price impact" value={quote.data ? `${number(quote.data.priceImpactPct, 4)}%` : quote.isError ? 'Unavailable' : '—'} /><div className="data-row"><span>Slippage tolerance</span><button type="button" onClick={() => setDialog('slippage')}>{slippage}% <Settings2 size={11} /></button></div></div>{account && sizeNum > buyingPower && <p className="field-error">Order exceeds this account's buying power.</p>}{tooSmall && <p className="field-error">GMTrade's minimum position is $1.</p>}{wrongProtection && <p className="field-error">Set take profit and stop loss on the correct sides of the {orderType === 'Market' ? 'current' : 'limit'} price.</p>}{blocked && <Notice tone="amber">{blocked}</Notice>}{!live && <Notice tone="amber">Waiting for live prices before you can submit.</Notice>}{!signedIn ? <Button type="button" className="full-width order-submit" onClick={() => setModal('wallet')} icon={Wallet}>Connect wallet to trade</Button> : stage === 'practice' && !account && accountsQuery.isSuccess ? <Button type="button" className="full-width order-submit" disabled={resetPractice.isPending} onClick={() => resetPractice.mutate(undefined, { onSuccess: () => notify('Practice account ready', 'Virtual capital, live GMTrade prices.'), onError: error => notify('Practice is unavailable', error.message) })}>{resetPractice.isPending ? 'Starting practice…' : 'Start practice account'}</Button> : <Button type="submit" variant={side === 'Long' ? 'buy' : 'sell'} className="full-width order-submit" disabled={invalid || busy || !!blocked || !live || !account}>{submitLabel}{!busy && <ArrowRight size={16} />}</Button>}{funded ? <TxStatus tx={tx} /> : simOrder?.message && <Notice tone={simOrder.status === 'failed' ? 'amber' : 'purple'} role={simOrder.status === 'failed' ? 'alert' : 'status'}>{simOrder.message}</Notice>}<p className="order-note">{funded ? 'Live order · GMTrade executes it with your funded account\'s USDC' : 'Simulated trading · profits are not withdrawable'}</p></form><div className="ticket-account"><div className="ticket-account-title"><ShieldCheck size={15} /><h3>Your account, in view</h3></div><DataRow label={funded ? 'Account size' : 'Virtual account size'} value={rules ? usd(rules.sizeUsd) : '—'} /><DataRow label="Equity floor" value={rules ? usd(rules.floorUsd) : '—'} /><DataRow label="Remaining loss allowance" value={account ? usd(account.allowanceRemaining) : '—'} /><Progress value={account ? Math.min(100, Number(account.allowanceRemaining) / Number(rules.lossAllowanceUsd) * 100) : 0} label="Remaining original loss budget, capped at 100 percent" /><p>Open P&L and trading costs count toward your account limits.</p><button className="text-button" onClick={() => setModal('rules')}>View account rules <ArrowUpRight size={12} /></button></div>{stage === 'practice' && <div className="practice-upgrade"><p>Ready to make it count?</p><Button variant="secondary" small onClick={() => navigate('/get-funded')} icon={ArrowRight}>Start an evaluation</Button>{account && <button className="text-button" disabled={resetPractice.isPending} onClick={() => resetPractice.mutate(undefined, { onSuccess: () => notify('Practice account reset'), onError: error => notify('Reset failed', error.message) })}>Reset practice account</button>}</div>}</aside>
    {leverageOpen && <Dialog title="Adjust leverage" onClose={() => setLeverageOpen(false)}><div className="leverage-value">{lev}<span>×</span></div><input aria-label="Leverage" className="size-slider" type="range" min="1" max={maxLeverage} value={lev} onChange={e => setLeverage(Number(e.target.value))} /><div className="leverage-options">{[...new Set([1, 2, 3, 5, 10, 20, maxLeverage])].filter(v => v <= maxLeverage).map(v => <Button key={v} variant={lev === v ? 'primary' : 'secondary'} small onClick={() => setLeverage(v)}>{v}×</Button>)}</div><Notice>Higher leverage lowers the margin a position needs and brings its liquidation price closer. {market.pair} allows up to {maxLeverage}×{market.closedMaxLeverage ? `; positions above ${market.closedMaxLeverage}× are closed before the session ends` : ''}.</Notice><Button className="full-width" onClick={() => setLeverageOpen(false)}>Apply leverage</Button></Dialog>}</>;
}
