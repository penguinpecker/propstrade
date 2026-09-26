import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownUp, ArrowRight, ArrowUpRight, ChevronDown, Clock3, Info, Layers3, Plus, Settings2, ShieldCheck, Star, Wallet, X } from 'lucide-react';
import { useApp, useSaved } from './App.jsx';
import { DASH, ORDER_STATUS, STAGE_LABELS, STATUS, compactUsd, dateTime, explorerTx, freshnessLabel, isOpenOrder, marginFor, marketPrice, money, number, percent, price, signedUsd, sol, stageRestriction, time, tone, usd, usdBase, utcTime } from './data.js';
import { Badge, Button, DataRow, Dialog, Empty, Field, FreshnessBadge, IconButton, InlineLink, MarketIcon, Notice, Pending, Progress, Tabs, Unavailable, touch } from './ui.jsx';
import { api } from './lib/api';
import { INTERVAL_SECONDS } from './lib/candles';
import { SLIDER_STEPS, leverageToPosition, pageLeverage, positionToLeverage } from './lib/leverage';
import { buyingPower as marginBuyingPower, expectedPnl, feeRate, feeRateLabel, hourlyCostUsd, propsFeeUsd, sideRates } from './lib/pnl';
import { useChartSettings } from './chart/storage.js';
import { candlesOptions, keys, useCancelSimOrder, useCandles, useCloseSimPosition, useHistory, useMarketTrades, useOrderFee, useOrders, usePlaceSimOrder, usePositions, useQuote, useResetPractice, useSetSimProtection } from './lib/queries';
import { useTxCost, useWalletTransaction } from './lib/transactions';
// The chart's code (lightweight-charts) downloads while the first API calls are in flight rather than once the market row
// is in; a failed download surfaces where the chart renders (React.lazy), not as an unhandled rejection.
const chartModule = import('./Chart.jsx');
chartModule.catch(() => {});
const ChartPanel = lazy(() => chartModule);

const TRADABLE_STATUSES = ['active', 'near_limit'];
/** The Margin row's hover in the order summary (touch screens show it under the label). */
const MARGIN_NOTE = 'The exchange takes the fee out of this margin';
const newId = () => crypto.randomUUID();
/** Idempotency keys for simulated requests: the same composed request keeps its key across retries until the map is cleared. */
const keyFor = (ids, request) => { const key = JSON.stringify(request); if (!ids.has(key)) ids.set(key, newId()); return ids.get(key); };
const bps = pct => Math.round(Number(pct) * 100);
const leverageText = leverage => number(leverage, Number.isInteger(leverage) ? 0 : 1);
const marketRef = m => ({ marketToken: m.marketToken, symbol: m.symbol });
/** The highest leverage a new position on `side` can take now: the lower of Props' limit and the exchange's (a server without the per-side limits gives the market's). */
const sideMaxLeverage = (market, side) => Math.max(1, (side === 'Long' ? market.maxLeverageLong : market.maxLeverageShort) ?? market.maxLeverage);
/** Where a slider label sits: under the thumb at fraction `f` of the track (8 px = half the native thumb), the first and last flush with the track's ends. */
const labelAt = f => f <= 0 ? undefined : f >= 1 ? { justifySelf: 'end' } : { left: `calc(8px + ${f} * (100% - 16px))`, transform: 'translateX(-50%)' };
export function useDebounced(value, ms) { const [debounced, setDebounced] = useState(value); useEffect(() => { const id = setTimeout(() => setDebounced(value), ms); return () => clearTimeout(id); }, [value, ms]); return debounced; }
const sessionBadge = m => m.session === 'unknown' ? ['neutral', 'Session unknown'] : [m.session === 'open' ? 'green' : 'amber', `${['Stocks', 'Forex'].includes(m.category) ? 'Session' : 'Market'} ${m.session}`];
const rate = value => value == null ? DASH : `${number(value, 4)}%`;
/** "L +0.0012% · S -0.0009%" for a pair of hourly rates: funding signed (longs pay when positive), borrowing always paid. */
const rateLine = (long, short, signed) => `L ${signed ? percent(long, 4) : rate(long)} · S ${signed ? percent(short, 4) : rate(short)}`;
/** The same rates over 8 hours and a year (×8, ×8760 of the hourly figure: nothing new), for a hover. */
const rateTitle = (long, short, signed) => { const times = (v, n) => v == null ? null : v * n; return `${signed ? 'Longs pay when positive, shorts when negative. ' : 'Always paid. '}Per 8h: ${rateLine(times(long, 8), times(short, 8), signed)} · per year: ${rateLine(times(long, 8760), times(short, 8760), signed)}`; };
/** The market's rates for a position's side, under its leverage badge. */
const sideRateLine = (market, side) => { const r = sideRates(market, side); return `F ${percent(r.funding, 4)} · B ${rate(r.borrow)} / h`; };
/** The same rates spelled out, with the market's funding over 8h and a year: the market cell's hover where hover works. */
const sideRateTitle = (market, side) => { const r = sideRates(market, side); return `${side} rates per hour: funding ${percent(r.funding, 4)} · borrow ${rate(r.borrow)}\nFunding: ${rateTitle(market.fundingRateHourlyLong, market.fundingRateHourlyShort, true)}`; };
/**
 * What closing the ticket's order at `target` would make (for the TP/SL rows and the chart labels), or null without a
 * usable target, entry and size. The estimated entry already carries the open leg's price impact; the close leg's is
 * not quoted, so it is assumed to cost as much as the open leg's did. Props' fees on the open and the close count too.
 */
function legEstimate(target, { side, sizeUsd, entry, marginUsd, quote, propsCloseFeeUsd }) {
  const priceValue = Number(target);
  if (!(priceValue > 0) || !(entry > 0) || !(sizeUsd > 0)) return null;
  const openFeeUsd = Number(quote?.openFeeUsd ?? 0), propsFee = Number(quote?.platformFeeUsd ?? 0);
  const closeFeeUsd = Number(quote?.closeFeeUsd ?? openFeeUsd) + (propsCloseFeeUsd ?? Number(quote?.platformCloseFeeUsd ?? propsFee));
  const pnl = expectedPnl({ side, sizeUsd, entry, target: priceValue, openFeeUsd: openFeeUsd + propsFee, closeFeeUsd, priceImpactUsd: Math.abs(Number(quote?.priceImpactPct ?? 0) / 100 * sizeUsd) });
  return { price: priceValue, pnl, pct: marginUsd > 0 ? pnl / marginUsd * 100 : null };
}
/**
 * Props' fee under a take profit and stop loss: about what each costs, and its maximum (the rate on the account's
 * exposure cap, which the order signs as its max_fee, since the position can grow before it executes).
 */
const legFeeNote = (expected, max, both) => <p className="fee-note">{both ? `Props fee ≈ ${usd(expected)} each, at most ${usd(max)}: only the one that executes is charged` : `Props fee ≈ ${usd(expected)}, at most ${usd(max)}: charged only if it executes`}, on the size it closes.</p>;

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
  const { account, stage, market, marketSymbol, markets, marketsQuery, theme, setModal, favorites, selectMarket, notify, streamStatus, openRecord, navigate, signedIn, accountsQuery, config } = useApp();
  const client = useQueryClient();
  const chart = useChartSettings(market?.symbol ?? '');
  const { interval, showGuides } = chart;
  const [feedTab, setFeedTab] = useState('Recent trades');
  const [positionTab, setPositionTab] = useState('Positions');
  const [dialog, setDialog] = useState(null);
  const [reducePercent, setReducePercent] = useState(100);
  const [mobileOrder, setMobileOrder] = useState(false);
  // The browser tab shows the chart's market and its live price; leaving the terminal puts the page title back.
  // First, so it keeps the page title from before the market's.
  useEffect(() => { const page = document.title; return () => { document.title = page; }; }, []);
  useEffect(() => { if (market) document.title = `${market.symbol}${market.price == null ? '' : ` ${price(market.price, market.priceDecimals)}`} — Props.trade`; }, [market?.symbol, market?.price, market?.priceDecimals]);
  const [onlyMarket, setOnlyMarket] = useState(false);
  const [showBalances, setShowBalances] = useState(true);
  const [take, setTake] = useState('');
  const [stop, setStop] = useState('');
  const [side, setSide] = useState('Long');
  const [size, setSize] = useState('1000');
  const [slippage, setSlippage] = useState('0.5');
  // The rest of the ticket lives here too: the quote is priced at its margin and limit, and the chart draws its TP/SL.
  const [ticket, setTicket] = useState({ leverage: 5, orderType: 'Market', limitPrice: '', take: '', stop: '' });
  const patchTicket = useCallback(next => setTicket(t => ({ ...t, ...next })), []);
  // The TP/SL drafts and a limit price were typed against one market's price: the next market's ticket starts without
  // them, reset in the same render as the switch (an effect would first paint their estimates at the new market's price).
  const [draftsFor, setDraftsFor] = useState(market?.symbol);
  if (market?.symbol !== draftsFor) { setDraftsFor(market?.symbol); setTicket(t => ({ ...t, take: '', stop: '', limitPrice: '' })); }
  const [actionError, setActionError] = useState(null);
  /** Positions whose close was requested, by id: { orderId } (null for a funded close, which GMTrade's keeper executes). */
  const [closing, setClosing] = useState(() => new Map());
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
  // Props' fee rate on every stage (/v1/order-fee answers before the program is live too); none while off.
  const propsRate = feeRate(useOrderFee().data);
  const orders = useOrders(accountId);
  const history = useHistory(accountId);
  const openOrders = (orders.data ?? []).filter(isOpenOrder);
  const bySymbol = useMemo(() => new Map(markets.map(m => [m.symbol, m])), [markets]);
  // Candles are asked for from the saved symbol at mount, before the catalog is in; the chart mounts once both are.
  const symbol = market?.symbol ?? marketSymbol;
  const candles = useCandles(symbol, interval);
  const warmed = useRef(null); // the interval the watchlist's candles were prefetched for
  // Once this market's candles are in (a saved copy older than staleTime: once its refetch answered, so nothing queues
  // ahead of that), the watchlist's for the same interval (at most 4 other markets), so a watchlist click paints from
  // memory: once per interval, not on ticks or catalog updates; ones still fresh (staleTime) are skipped.
  useEffect(() => {
    if (!candles.isSuccess || candles.isFetching || warmed.current === interval) return;
    warmed.current = interval;
    for (const other of favorites.filter(s => s !== symbol).slice(0, 4)) client.query(candlesOptions(other, interval)).catch(() => {});
  }, [candles.isSuccess, candles.isFetching, interval]);
  const marketTrades = useMarketTrades(market?.symbol ?? '');
  const lev = Math.min(ticket.leverage, market ? sideMaxLeverage(market, side) : ticket.leverage);
  const quoteSize = useDebounced(Number(size) > 0 ? Number(size).toFixed(2) : null, 300);
  const quoteCollateral = useDebounced(Number(size) > 0 ? marginFor(Number(size), lev) : '', 300);
  const quoteLimit = useDebounced(ticket.orderType === 'Limit' && Number(ticket.limitPrice) > 0 ? ticket.limitPrice : '', 300);
  const quote = useQuote(market?.symbol ?? '', side, market ? quoteSize : null, quoteCollateral, quoteLimit);
  // Funded orders pay the Solana network fee from the trader's wallet: the fee of the transaction the ticket would send.
  const openCost = useTxCost(['open', accountId, market?.symbol, side, ticket.orderType, quoteSize, quoteCollateral],
    (chain, connection, trader, rate) => chain.prepareOpen(connection, trader, { funded: accountId, market: marketRef(market), isLong: side === 'Long', kind: ticket.orderType, price: ticket.orderType === 'Market' ? market.price : quoteLimit, sizeUsd: Number(quoteSize), collateralUsd: Number(quoteCollateral), slippageBps: bps(slippage), rate }),
    stage === 'funded' && !!accountId && !!market?.price && Number(quoteSize) > 0 && Number(quoteCollateral) > 0 && (ticket.orderType === 'Market' || Number(quoteLimit) > 0));
  // The price the order opens at: the quote's execution price (impact included) for a market order, the limit price otherwise.
  const entry = ticket.orderType === 'Market' ? Number(quote.data?.executionPrice ?? market?.price ?? 0) : Number(ticket.limitPrice);
  const held = Number((positions.data ?? []).find(p => p.symbol === market?.symbol && p.side === side)?.sizeUsd ?? 0);
  const estimates = useMemo(() => {
    const sizeUsd = Number(size) || 0;
    // The ticket's take profit and stop loss close the whole position on this side: their Props fee covers what is
    // already open too (the quote knows only the new size).
    const propsCloseFeeUsd = held > 0 ? propsFeeUsd(propsRate, held + sizeUsd) : undefined;
    const input = { side, sizeUsd, entry, marginUsd: sizeUsd / lev, quote: quote.data, propsCloseFeeUsd };
    return { tp: legEstimate(ticket.take, input), sl: legEstimate(ticket.stop, input), propsCloseFeeUsd };
  }, [side, size, entry, lev, quote.data, ticket.take, ticket.stop, held, propsRate.feeUsdc, propsRate.feeBps]);
  const closeSim = useCloseSimPosition(accountId ?? '');
  const cancelSim = useCancelSimOrder(accountId ?? '');
  const protectSim = useSetSimProtection(accountId ?? '');
  const resetPractice = useResetPractice();
  const refresh = () => client.invalidateQueries({ queryKey: ['account', accountId] }).then(() => client.invalidateQueries({ queryKey: ['accounts'] }));
  const tick = useMemo(() => market?.price && market.updatedAt ? { price: Number(market.price), ts: market.updatedAt } : null, [market?.price, market?.updatedAt]);
  /** The `count` candles (300 by default, at most 2,000 per request) before `before` (unix seconds), as the chart goes back in time. */
  const loadOlder = useCallback((before, count = 300) => { const step = INTERVAL_SECONDS[interval]; return api.candles(market.symbol, interval, before - count * step, before - step).then(r => r.candles); }, [market?.symbol, interval]);
  // Chart lines: each open position's entry, liquidation price and TP/SL orders (behind the toolbar's Positions toggle),
  // and the ticket's own TP/SL while they are typed, labelled with what they would make.
  const guides = useMemo(() => {
    const list = [];
    if (showGuides) for (const p of (positions.data ?? []).filter(p => p.symbol === market?.symbol)) {
      list.push({ price: Number(p.entryPrice), title: `${p.side} entry`, kind: 'entry' });
      if (p.liquidationPrice) list.push({ price: Number(p.liquidationPrice), title: 'Liq.', kind: 'liquidation' });
      if (p.takeProfit) list.push({ price: Number(p.takeProfit.price), title: 'TP', kind: 'tp' });
      if (p.stopLoss) list.push({ price: Number(p.stopLoss.price), title: 'SL', kind: 'sl' });
    }
    if (estimates.tp) list.push({ price: estimates.tp.price, title: `TP ≈ ${signedUsd(estimates.tp.pnl, 0)}`, kind: 'tp', draft: true });
    if (estimates.sl) list.push({ price: estimates.sl.price, title: `SL ≈ ${signedUsd(estimates.sl.pnl, 0)}`, kind: 'sl', draft: true });
    return list;
  }, [showGuides, positions.data, market?.symbol, estimates]);
  useEffect(() => { if ([tx.phase, openTx.phase].some(phase => phase === 'done' || phase === 'failed')) void refresh(); }, [tx.phase, openTx.phase]);
  // A position reads "Closing…" from the close request until the positions stream drops it. A close the venue canceled
  // or rejected gives the row back with the reason; one that executed with the position still here was partial.
  useEffect(() => {
    if (!closing.size) return;
    const next = new Map(closing);
    let reason = null;
    for (const [positionId, watch] of closing) {
      const order = watch.orderId ? (orders.data ?? []).find(o => o.id === watch.orderId) : null;
      if (positions.data && !positions.data.some(p => p.id === positionId)) next.delete(positionId);
      else if (order?.status === 'canceled' || order?.status === 'rejected') { next.delete(positionId); reason = order.statusDetail ?? `The close order was ${order.status}.`; }
      else if (order?.status === 'executed') next.delete(positionId);
    }
    if (next.size !== closing.size) { setClosing(next); if (reason) setActionError(`The position was not closed: ${reason}`); }
  }, [positions.data, orders.data, closing]);
  useEffect(() => { tx.reset(); openTx.reset(); setActionError(null); }, [accountId]);

  const watchlist = <div className="watchlist-bar"><button className="watchlist-title" onClick={() => navigate('/markets')}><Star size={12} /> Watchlist</button>{markets.filter(m => favorites.includes(m.symbol)).map(m => <button key={m.symbol} className={market?.symbol === m.symbol ? 'selected' : ''} onClick={() => selectMarket(m.symbol)}><span>{m.symbol}</span><span>{price(m.price, m.priceDecimals)}</span>{freshnessLabel(m) ? <FreshnessBadge market={m} /> : <small className={m.change24h > 0 ? 'positive' : 'negative'}>{percent(m.change24h)}</small>}</button>)}<IconButton icon={Plus} label="Add a market to your watchlist" onClick={() => setModal({ type: 'markets', tab: 'All' })} /><a href="#/markets">All markets <ArrowUpRight size={12} /></a></div>;
  if (!market && marketsQuery.isError) return <><AccountStrip /><div className="page"><Unavailable title="Markets are unavailable" error={marketsQuery.error} retry={marketsQuery.refetch} /></div></>;
  // The terminal's frame with the chart's skeleton in place while the catalog loads: the candles are already on their way.
  if (!market) return <><AccountStrip />{watchlist}<div className="trading-layout"><section className="market-workspace"><div className="market-heading" /><div className="chart-and-feed"><div className="chart-section"><div className="chart-skeleton" /></div></div></section></div></>;
  const dec = market.priceDecimals;
  const paused = streamStatus === 'reconnecting' || streamStatus === 'offline';
  const stale = market.freshness === 'stale' || market.freshness === 'unavailable';
  const chartLive = candles.data?.freshness === 'live' && !paused && !stale;
  const chartPanel = onExpand => <Suspense fallback={<div className="chart-skeleton" />}><ChartPanel settings={chart} theme={theme} market={market} candles={candles} tick={tick} live={chartLive} loadOlder={loadOlder} guides={guides} onExpand={onExpand} /></Suspense>;
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
      // Two closes per transaction stay under Solana's 1,232-byte limit (three measure 1,285 B with their max_fee
      // arguments). ponytail: an address lookup table would fit all eight slots in one transaction.
      for (let i = 0; i < list.length; i += 2) {
        const chunk = list.slice(i, i + 2);
        setClosing(prev => new Map([...prev, ...chunk.map(p => [p.id, { orderId: null }])]));
        const result = await runFunded('close', (chain, connection, trader, rate) => chain.prepareClose(connection, trader, { funded: accountId, slippageBps: bps(slippage), positions: chunk.map(p => ({ market: marketRef(bySymbol.get(p.symbol)), isLong: p.side === 'Long', markPrice: p.markPrice ?? bySymbol.get(p.symbol).price, sizeUsd: Number(p.sizeUsd), percent: percentValue })), rate }), { execution: prepared => prepared.follows, done: 'Close executed by the exchange.' });
        // The request is over: from here the server's Position.closing (a whole-size decrease pending in gm_orders) says
        // whether a row is still closing, so a follow that timed out and was cancelled later gives the row back, and a
        // partial close that executed does at once. A whole position that executed leaves with the next positions read.
        if (!(result?.execution === 'executed' && percentValue === 100)) setClosing(prev => { const next = new Map(prev); for (const p of chunk) next.delete(p.id); return next; });
        if (!result || result.execution === 'cancelled') return; // the dialog stays open with the outcome; Positions shows what is still open
      }
      closeDialog(shown);
      return;
    }
    try {
      for (const p of list) {
        const { order } = await closeSim.mutateAsync({ positionId: p.id, body: { clientId: keyFor(closeIds.current, [accountId, p.id, percentValue]), percent: percentValue, slippageBps: bps(slippage) } });
        setClosing(prev => new Map(prev).set(p.id, { orderId: order.id }));
      }
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
      const result = await runFunded('protection', (chain, connection, trader, rate) => chain.prepareProtection(connection, trader, { funded: accountId, market: marketRef(bySymbol.get(position.symbol)), isLong: position.side === 'Long', takeProfit: { order: orderOf(position.takeProfit), price: next.takeProfit }, stopLoss: { order: orderOf(position.stopLoss), price: next.stopLoss }, rate }), { done: 'Protection orders updated on the exchange.' });
      if (result) { closeDialog(shown); notify('Protection updated', `${position.symbol} · confirmed onchain`); }
      return;
    }
    try { await protectSim.mutateAsync({ positionId: position.id, body: next }); closeDialog(shown); notify('Position protection updated'); } catch (error) { setActionError(error.message); }
  }
  async function cancelOrder(order) {
    setActionError(null);
    if (funded) {
      const address = order.gmOrder ?? order.id;
      const result = await runFunded('cancel', (chain, connection, trader) => chain.prepareCancel(connection, trader, accountId, address), { done: 'Order canceled on the exchange.' });
      // The ticket was waiting for GMTrade to execute this order: it ended by the trader's cancel, not by the venue.
      if (result && openFollows.current.includes(address)) openTx.reset();
      return;
    }
    try { await cancelSim.mutateAsync(order.id); notify('Simulated order canceled'); } catch (error) { setActionError(error.message); }
  }
  const protectionInvalid = position => { const mark = Number(position.markPrice ?? market.price); const long = position.side === 'Long'; return (take && !(long ? Number(take) > mark : Number(take) < mark && Number(take) > 0)) || (stop && !(long ? Number(stop) < mark && Number(stop) > 0 : Number(stop) > mark)); };
  const actionStatus = action => txAction === action && tx.phase !== 'idle' ? <TxStatus tx={tx} /> : actionError && <Notice tone="amber" role="alert">{actionError}</Notice>;
  const isClosing = p => p.closing || closing.has(p.id);
  // Props' fee on a close, or on a position's take profit and stop loss, shown before the order is sent (none while off).
  const propsOn = feeRateLabel(propsRate) !== null;
  const closeFeeRow = (list, share) => propsOn && <DataRow label="Props fee" value={`≈ ${usd(list.reduce((sum, p) => sum + propsFeeUsd(propsRate, Number(p.sizeUsd) * share / 100), 0))}`} />;
  const feesTitle = p => `Borrowing ${usd(p.pendingBorrowUsd)} · funding ${usd(p.pendingFundingUsd)} · close fee ${usd(p.closeFeeUsd)}: settled at this position's next fill`;
  const noAccountEmpty = !signedIn ? <Empty icon={Wallet} title="Sign in to trade" action={<Button small onClick={() => setModal('wallet')}>Connect wallet</Button>}>Your positions, orders and history appear here once you sign in.</Empty> : !account && (accountsQuery.isPending ? <Pending>Loading your account…</Pending> : accountsQuery.isError ? <Unavailable title="Accounts are unavailable" error={accountsQuery.error} retry={accountsQuery.refetch} /> : <Empty icon={Layers3} title={`No ${stage} account yet`} action={<Button small variant="secondary" onClick={() => navigate(stage === 'practice' ? '/accounts' : '/get-funded')}>{stage === 'practice' ? 'Open accounts' : 'Get funded'}</Button>}>{stage === 'funded' ? 'Pass an evaluation and activate funding to trade live on the exchange.' : stage === 'evaluation' ? 'Buy an evaluation to start trading under its rules.' : 'Start a free practice account from the order ticket.'}</Empty>);

  return <>
    <AccountStrip />
    {watchlist}
    <div className="trading-layout">
      <section className="market-workspace">
        <div className="market-heading"><button className="market-select" onClick={() => setModal('markets')}><MarketIcon market={market} /><span><strong>{market.pair.split(' / ')[0]}<span className="quiet"> / {market.pair.split(' / ')[1]}</span></strong><small>{market.name} perpetual</small></span><ChevronDown size={15} /></button><div className="market-price"><strong>{price(market.price, dec)}</strong><span className={market.change24h > 0 ? 'positive' : 'negative'}>{percent(market.change24h)} <small>24h</small></span></div><div className="market-metrics"><div className="market-metric volume-metric"><span>24h volume</span><strong>{compactUsd(market.volume24h)}</strong></div><div className="market-metric"><span>Open interest</span><strong>{compactUsd(openInterest)}</strong></div><div className="market-metric rate-metric"><span>Funding / h</span><strong title={rateTitle(market.fundingRateHourlyLong, market.fundingRateHourlyShort, true)} role={touch() ? 'button' : undefined} tabIndex={touch() ? 0 : undefined} onClick={touch() ? () => notify('Funding / h', rateTitle(market.fundingRateHourlyLong, market.fundingRateHourlyShort, true)) : undefined}>L <b className={market.fundingRateHourlyLong == null ? '' : tone(market.fundingRateHourlyLong)}>{percent(market.fundingRateHourlyLong, 4)}</b> · S <b className={market.fundingRateHourlyShort == null ? '' : tone(market.fundingRateHourlyShort)}>{percent(market.fundingRateHourlyShort, 4)}</b></strong></div><div className="market-metric rate-metric"><span>Borrow / h</span><strong title={rateTitle(market.borrowRateHourlyLong, market.borrowRateHourlyShort, false)} role={touch() ? 'button' : undefined} tabIndex={touch() ? 0 : undefined} onClick={touch() ? () => notify('Borrow / h', rateTitle(market.borrowRateHourlyLong, market.borrowRateHourlyShort, false)) : undefined}>{rateLine(market.borrowRateHourlyLong, market.borrowRateHourlyShort, false)}</strong></div></div><Badge tone={sessionTone} dot title={market.sessionNote}>{sessionLabel}</Badge>{touch() && market.session !== 'open' && market.sessionNote && <small className="market-session-note">{market.sessionNote}</small>}</div>
        <div className="chart-and-feed"><div className="chart-section">{chartPanel(() => setDialog('chart'))}{(paused || stale) && <div className="stale-overlay"><Clock3 size={19} /><strong>{paused ? 'Price updates paused' : market.freshness === 'unavailable' ? 'Price unavailable' : 'Price is stale'}</strong><span>{paused ? `Last price shown${market.updatedAt ? ` from ${utcTime(market.updatedAt)}` : ''}. Reconnecting automatically.` : market.updatedAt ? `The last price update was at ${utcTime(market.updatedAt)}.` : 'No price has been published for this market yet.'}</span></div>}</div>
          <aside className="trade-feed"><Tabs items={['Recent trades', 'Liquidity']} value={feedTab} onChange={setFeedTab} />{feedTab === 'Recent trades' ? trades.state ?? <><div className="feed-labels"><span>Price ({market.pair.split(' / ')[1]})</span><span>Size ({base ?? 'USD'})</span><span>Time</span></div><div className="feed-rows">{trades.rows.map(t => <div key={t.id}><span className={t.buy ? 'positive' : 'negative'}>{price(t.price, dec)}</span><span>{base ? number(Number(t.sizeUsd) / Number(t.price), 4) : compactUsd(t.sizeUsd)}</span><time>{time(t.ts)}</time></div>)}</div><div className="feed-bottom"><span>Buy volume <b>{number(trades.buyShare, 0)}%</b></span><Progress value={trades.buyShare} tone="green" label="Buy share of recent trade volume" /><span>Sell volume <b>{number(100 - trades.buyShare, 0)}%</b></span></div></> : <div className="liquidity-view"><Badge tone="purple">Exchange pool</Badge><h3>{pool?.name ?? market.pair}</h3><p>Open interest this pool can still take, and the pool's own liquidity.</p><DataRow label="Long capacity" value={compactUsd(market.capacityLong)} /><Progress value={capacityShare(market.capacityLong, market.openInterestLong)} tone="green" label="Long capacity left" /><DataRow label="Short capacity" value={compactUsd(market.capacityShort)} /><Progress value={capacityShare(market.capacityShort, market.openInterestShort)} label="Short capacity left" /><DataRow label="Pool liquidity" value={compactUsd(market.poolLiquidity)} /><DataRow label={`Price impact · ${money(Number(size) || 0, 0)} ${side.toLowerCase()}`} value={quote.data ? `${number(quote.data.priceImpactPct, 4)}%` : quote.isError ? 'Unavailable' : '—'} /><p className="micro-copy">Execution depends on pool conditions when the exchange executes the order.</p><button className="text-button" onClick={() => navigate('/vault')}>About the capital vault <ArrowUpRight size={13} /></button></div>}</aside>
        </div>
        <div className="positions-panel"><div className="position-toolbar"><Tabs items={[{ value: 'Positions', label: <>Positions <span className="tab-count">{positions.data?.length ?? 0}</span></> }, { value: 'Open orders', label: <>Open orders <span className="tab-count">{openOrders.length}</span></> }, 'Trade history']} value={positionTab} onChange={setPositionTab} /><div className="position-tools"><label className="checkbox-label"><input type="checkbox" checked={onlyMarket} onChange={e => setOnlyMarket(e.target.checked)} /> This market</label><button className="text-button" onClick={() => { setActionError(null); setDialog('close-all'); }} disabled={!positions.data?.length || busy}>Close all</button><IconButton icon={Settings2} label="Toggle account balances" onClick={() => setShowBalances(!showBalances)} /></div></div>
        {!dialog && (txAction && tx.phase !== 'idle' ? <TxStatus tx={tx} /> : actionError && <Notice tone="amber" role="alert">{actionError}</Notice>)}
        {positionTab === 'Positions' && <div className="table-scroll">{noAccountEmpty || (positions.isPending ? <Pending>Loading positions…</Pending> : positions.isError ? <Unavailable title="Positions are unavailable" error={positions.error} retry={positions.refetch} /> : <><table className="position-table"><thead><tr><th>Market / side</th><th>Position size</th><th>Entry price</th><th>Mark price</th><th>Liq. price</th><th>Unrealized P&L</th><th>Fees accrued</th><th>TP / SL</th><th /></tr></thead><tbody>{visiblePositions.map(p => { const m = bySymbol.get(p.symbol) ?? { symbol: p.symbol, priceDecimals: 2, pair: `${p.symbol} / USD` }; const out = isClosing(p); return <tr key={p.id} className={out ? 'closing' : ''}><td><button type="button" className="table-market market-name-button" title={touch() ? undefined : sideRateTitle(m, p.side)} aria-label={`Show ${m.pair} on the chart`} onClick={() => selectMarket(p.symbol)}><MarketIcon market={m} small /><span><strong>{m.pair}</strong><small className={p.side === 'Long' ? 'positive' : 'negative'}>{p.side} <span className="leverage-badge">{leverageText(p.leverage)}×</span></small>{touch() && <small className="side-rate" title={rateTitle(m.fundingRateHourlyLong, m.fundingRateHourlyShort, true)}>{sideRateLine(m, p.side)}</small>}</span></button></td><td><strong>{number(Number(p.sizeTokens), 4)} {p.symbol}</strong><small>{usd(p.sizeUsd)} · {usd(p.collateralUsd)} margin</small></td><td>{price(p.entryPrice, m.priceDecimals)}</td><td>{price(p.markPrice ?? m.price, m.priceDecimals)}</td><td title="The exchange liquidates this position at about this price: its own collateral backs it">{price(p.liquidationPrice, m.priceDecimals)}</td><td><strong className={tone(p.unrealizedPnl ?? 0)}>{signedUsd(p.unrealizedPnl)}</strong><small className={tone(p.unrealizedPnl ?? 0)}>{p.unrealizedPnl == null ? '' : percent(Number(p.unrealizedPnl) / Number(p.collateralUsd) * 100)}</small></td><td title={feesTitle(p)}>{usd(p.pendingFeesUsd)}</td><td><button className="position-protection" disabled={out} onClick={() => { setActionError(null); setDialog({ type: 'protection', position: p }); setTake(p.takeProfit?.price ?? ''); setStop(p.stopLoss?.price ?? ''); }}>{p.takeProfit ? price(p.takeProfit.price, m.priceDecimals) : 'Add TP'} <span>/</span> {p.stopLoss ? price(p.stopLoss.price, m.priceDecimals) : 'Add SL'}</button></td><td>{out ? <span className="closing-note" role="status">Closing…</span> : <button className="table-action" disabled={busy} onClick={() => { setActionError(null); setReducePercent(100); setDialog({ type: 'close', position: p }); }}>Close <X size={11} /></button>}</td></tr>; })}</tbody></table><div className="mobile-positions">{visiblePositions.map(p => { const m = bySymbol.get(p.symbol) ?? { symbol: p.symbol, priceDecimals: 2, pair: `${p.symbol} / USD` }; const out = isClosing(p); return <article key={p.id} className={out ? 'closing' : ''}><div className="mobile-position-title"><button type="button" className="table-market market-name-button" aria-label={`Show ${m.pair} on the chart`} onClick={() => selectMarket(p.symbol)}><MarketIcon market={m} small /><strong>{m.pair}</strong></button><Badge tone={p.side === 'Long' ? 'green' : 'red'}>{p.side} · {leverageText(p.leverage)}×</Badge><strong className={tone(p.unrealizedPnl ?? 0)}>{signedUsd(p.unrealizedPnl)}</strong></div><div className="mobile-position-stats"><span>Size <b>{number(Number(p.sizeTokens), 4)} {p.symbol}</b></span><span>Margin <b>{usd(p.collateralUsd)}</b></span><span>Entry <b>{price(p.entryPrice, m.priceDecimals)}</b></span><span>Liq. price <b>{price(p.liquidationPrice, m.priceDecimals)}</b></span><span title={feesTitle(p)}>Fees accrued <b>{usd(p.pendingFeesUsd)}</b>{touch() && <small className="row-note">{feesTitle(p)}</small>}</span><span>Rates / h <b>{sideRateLine(m, p.side)}</b></span></div><div className="mobile-position-actions"><button disabled={out} onClick={() => { setActionError(null); setDialog({ type: 'protection', position: p }); setTake(p.takeProfit?.price ?? ''); setStop(p.stopLoss?.price ?? ''); }}>TP / SL <ShieldCheck size={12} /></button>{out ? <span className="closing-note" role="status">Closing…</span> : <button disabled={busy} onClick={() => { setActionError(null); setReducePercent(100); setDialog({ type: 'close', position: p }); }}>Close position <X size={12} /></button>}</div></article>; })}</div>{visiblePositions.length === 0 && <Empty icon={Layers3} title="Room for your next trade">Your open positions will appear here, with risk and P&L in one place.</Empty>}</>)}</div>}
        {positionTab === 'Open orders' && <div className="table-scroll">{noAccountEmpty || (orders.isPending ? <Pending>Loading orders…</Pending> : orders.isError ? <Unavailable title="Orders are unavailable" error={orders.error} retry={orders.refetch} /> : <><table className="card-table"><thead><tr><th>Market</th><th>Side / type</th><th>Size</th><th>Trigger price</th><th>Status</th><th /></tr></thead><tbody>{openOrders.filter(o => !onlyMarket || o.symbol === market.symbol).map(o => <tr key={o.id}><td data-label="Market"><button type="button" className="market-name-button" aria-label={`Show ${bySymbol.get(o.symbol)?.pair ?? o.symbol} on the chart`} onClick={() => selectMarket(o.symbol)}><strong>{bySymbol.get(o.symbol)?.pair ?? o.symbol}</strong></button></td><td data-label="Side / type">{o.side} · {o.kind === 'TakeProfit' ? 'Take profit' : o.kind === 'StopLoss' ? 'Stop loss' : o.kind}</td><td data-label="Size">{o.isIncrease ? usd(o.sizeUsd) : 'Whole position'}{Number(o.platformFeeUsd) > 0 && <small className="row-note">Props fee {o.isIncrease ? '' : 'at most '}{usd(o.platformFeeUsd)}</small>}</td><td data-label="Trigger price">{price(o.triggerPrice, bySymbol.get(o.symbol)?.priceDecimals ?? 2)}</td><td data-label="Status"><span title={o.statusDetail}><Badge tone={o.status === 'frozen' || o.status === 'unknown' ? 'red' : 'amber'}>{ORDER_STATUS[o.status]}</Badge></span>{touch() && o.statusDetail && <small className="row-note">{o.statusDetail}</small>}</td><td><button className="table-action" disabled={busy} onClick={() => cancelOrder(o)}>Cancel</button></td></tr>)}</tbody></table>{openOrders.length === 0 && <Empty icon={Clock3} title="No working orders">Limit and trigger orders will appear here until filled or canceled.</Empty>}</>)}</div>}
        {positionTab === 'Trade history' && <div className="table-scroll">{noAccountEmpty || (history.isPending ? <Pending>Loading trade history…</Pending> : history.isError ? <Unavailable title="Trade history is unavailable" error={history.error} retry={history.refetch} /> : <><table className="card-table"><thead><tr><th>Market</th><th>Side</th><th>Closed at</th><th>Size</th><th>Realized P&L</th><th /></tr></thead><tbody>{history.data.slice(0, 10).map(t => <tr key={t.id}><td data-label="Market"><button type="button" className="market-name-button" aria-label={`Show ${bySymbol.get(t.symbol)?.pair ?? t.symbol} on the chart`} onClick={() => selectMarket(t.symbol)}><strong>{bySymbol.get(t.symbol)?.pair ?? t.symbol}</strong></button></td><td data-label="Side">{t.side}</td><td data-label="Closed at">{dateTime(t.closedAt)}</td><td data-label="Size">{usd(t.sizeUsd)}</td><td data-label="Realized P&L" className={tone(t.netPnl)}>{signedUsd(t.netPnl)}</td><td><IconButton icon={ArrowUpRight} label={`View trade ${t.id}`} onClick={() => openRecord(tradeRecord(t, bySymbol))} /></td></tr>)}</tbody></table>{history.data.length === 0 && <Empty icon={Clock3} title="No closed trades yet">Closed trades appear here with their fees and net result.</Empty>}</>)}</div>}
        {showBalances && account && <div className="positions-summary"><span>Unrealized P&L <b className={tone(account.unrealizedPnl)}>{signedUsd(account.unrealizedPnl)}</b></span><span>Account <b>{account.shortId}</b></span><button onClick={() => navigate('/activity')}>All activity <ArrowUpRight size={12} /></button></div>}</div>
      </section>
      <OrderTicket mobileOrder={mobileOrder} setMobileOrder={setMobileOrder} tx={openTx} follows={openFollows} walletPrompt={tx.sending} side={side} setSide={setSide} size={size} setSize={setSize} slippage={slippage} setDialog={setDialog} quote={quote} orders={orders.data} openOrders={openOrders} resetPractice={resetPractice} ticket={ticket} patch={patchTicket} lev={lev} entry={entry} estimates={estimates} openCost={openCost} />
    </div><button className="mobile-trade-action" onClick={() => setMobileOrder(true)}>Trade {market.symbol} <ArrowDownUp size={17} /></button>
    {dialog === 'slippage' && <SlippageDialog value={slippage} onSave={setSlippage} onClose={() => setDialog(null)} />}
    {dialog === 'chart' && <Dialog title={`${market.pair} · Price chart`} wide className="chart-dialog" onClose={() => setDialog(null)}><div className="expanded-chart">{chartPanel()}</div></Dialog>}
    {(dialog === 'close-all' || dialog?.type === 'close') && <Dialog title={dialog === 'close-all' ? 'Close all positions?' : `Close ${dialog.position.symbol} position`} onClose={() => setDialog(null)}><Notice>{funded ? `A market close order goes to the exchange from your funded account, with ${slippage}% slippage tolerance. The exchange executes it, usually within seconds.` : 'The simulator closes at the next live price, with the same fees and price impact as the venue. Borrowing and funding accrued so far and the close fee are settled in this fill.'}</Notice>{dialog !== 'close-all' && <><DataRow label="Current position" value={`${number(Number(dialog.position.sizeTokens), 4)} ${dialog.position.symbol} · ${usd(dialog.position.sizeUsd)}`} /><Field label={`Amount to close · ${reducePercent}%`}><input type="range" min="10" max="100" step="10" value={reducePercent} onChange={e => setReducePercent(Number(e.target.value))} /></Field></>}{dialog === 'close-all' ? closeFeeRow(positions.data ?? [], 100) : closeFeeRow([dialog.position], reducePercent)}{actionStatus('close')}<div className="button-row"><Button variant="secondary" onClick={() => setDialog(null)}>Keep position</Button><Button disabled={busy || followingAction('close')} onClick={() => closePositions(dialog === 'close-all' ? positions.data : [dialog.position], dialog === 'close-all' ? 100 : reducePercent)}>{closeSim.isPending || followingAction('close') ? 'Closing…' : funded ? 'Send close order' : 'Confirm close'}</Button></div></Dialog>}
    {dialog?.type === 'protection' && <Dialog title={`Protect your ${dialog.position.symbol} position`} onClose={() => setDialog(null)}><Field label="Take-profit price"><input type="number" step="any" min="0" value={take} placeholder="None" onChange={e => setTake(e.target.value)} /></Field><Field label="Stop-loss price"><input type="number" step="any" min="0" value={stop} placeholder="None" onChange={e => setStop(e.target.value)} /></Field>{protectionInvalid(dialog.position) && <p className="field-error">Set take profit and stop loss on the correct sides of the mark price.</p>}{propsOn && (take || stop) && legFeeNote(propsFeeUsd(propsRate, Number(dialog.position.sizeUsd)), propsFeeUsd(propsRate, Number(account.rules.maxExposureUsd)), take && stop)}<Notice>{funded ? 'Take-profit and stop-loss orders close the whole position when the exchange\'s price reaches them. They execute as market orders, so the fill can differ from the trigger price.' : 'The simulator triggers these on live prices, like the exchange\'s own trigger orders. Leave a field empty to remove it.'}</Notice>{actionStatus('protection')}<Button className="full-width" disabled={busy || followingAction('protection') || !!protectionInvalid(dialog.position)} onClick={() => saveProtection(dialog.position)}>{protectSim.isPending || followingAction('protection') ? 'Saving…' : 'Save protections'}</Button></Dialog>}
  </>;
}

/** Edits a draft: only a saved value (above 0, at most 5%) becomes the tolerance orders use. */
function SlippageDialog({ value, onSave, onClose }) {
  const [draft, setDraft] = useState(value);
  const valid = Number(draft) > 0 && Number(draft) <= 5;
  return <Dialog title="Slippage tolerance" onClose={onClose}><p className="dialog-note">The maximum price change you accept between submitting and execution. The exchange cancels a market order it cannot fill within this limit.</p><Field label="Maximum slippage (%)"><input type="number" min="0.01" max="5" step=".1" value={draft} onChange={e => setDraft(e.target.value)} /></Field><Button className="full-width" disabled={!valid} onClick={() => { onSave(draft); onClose(); }}>Save tolerance</Button></Dialog>;
}

/** Recent GMTrade trades for the feed: the rows, the buy share of their volume, or the state to show instead. */
function marketTradesView(query) {
  if (query.isPending) return { state: <Pending>Loading trades…</Pending> };
  if (query.isError) return { state: <Unavailable title="Trades are unavailable" error={query.error} retry={query.refetch} /> };
  if (!query.data.length) return { state: <Empty icon={Clock3} title="No recent trades">No recent trades in this market.</Empty> };
  const rows = query.data.map(t => ({ ...t, buy: (t.side === 'Long') === t.isIncrease }));
  const total = rows.reduce((sum, t) => sum + Number(t.sizeUsd), 0);
  return { rows, buyShare: total ? rows.filter(t => t.buy).reduce((sum, t) => sum + Number(t.sizeUsd), 0) / total * 100 : 0 };
}

export const tradeRecord = (t, bySymbol) => ({
  title: `${bySymbol.get(t.symbol)?.pair ?? t.symbol} · ${t.side} closed`, simulated: t.venue === 'simulated', signature: t.signatures[0],
  rows: [['Opened', dateTime(t.openedAt)], ['Closed', dateTime(t.closedAt)], ['Position value', usd(t.sizeUsd)], ['Entry price', price(t.entryPrice, bySymbol.get(t.symbol)?.priceDecimals ?? 2)], ['Exit price', price(t.exitPrice, bySymbol.get(t.symbol)?.priceDecimals ?? 2)], ['Open + close fees', usd(t.orderFeesUsd)], ...(Number(t.platformFeeUsd) > 0 ? [['Props fee', usd(t.platformFeeUsd)]] : []), ['Funding', usd(t.fundingUsd)], ['Borrowing', usd(t.borrowUsd)], ['Price impact', signedUsd(t.priceImpactUsd)], ['Total costs', usd(t.feesUsd)], ['Net P&L', signedUsd(t.netPnl)]],
});

const TX_LABELS = { preparing: 'Preparing transaction…', signing: 'Approve in your wallet…', submitted: 'Confirming onchain…', awaiting_execution: 'Awaiting execution…' };
/** Progress and outcome of the terminal's wallet transaction. */
function TxStatus({ tx }) {
  if (tx.busy) return <Notice role="status"><span>{TX_LABELS[tx.phase]}{tx.signature && <> · <InlineLink href={explorerTx(tx.signature)} external>View transaction</InlineLink></>}</span></Notice>;
  if (!tx.message && tx.phase !== 'failed') return null;
  return <Notice tone={tx.phase === 'failed' ? 'amber' : 'purple'} role={tx.phase === 'failed' ? 'alert' : 'status'}><span>{tx.message}{tx.signature && <> · <InlineLink href={explorerTx(tx.signature)} external>View transaction</InlineLink></>}</span></Notice>;
}

function OrderTicket({ mobileOrder, setMobileOrder, tx, follows, walletPrompt, side, setSide, size, setSize, slippage, setDialog, quote, orders, openOrders, resetPractice, ticket, patch, lev, entry, estimates, openCost }) {
  const { account, stage, market, setModal, notify, live, navigate, signedIn, session, config, accountsQuery } = useApp();
  const client = useQueryClient();
  const { leverage, orderType, limitPrice, take, stop } = ticket;
  const [simOrder, setSimOrder] = useState(null); // { id, since, status, message }
  const [detailsOpen, setDetailsOpen] = useSaved('orderDetails', false, saved => saved === true); // the Order details disclosure, per browser
  const orderIds = useRef(new Map());
  const placeSim = usePlaceSimOrder(account?.id ?? '');
  const funded = stage === 'funded';
  const maxLeverage = sideMaxLeverage(market, side);
  const sizeNum = Number(size) || 0;
  const orderFee = useOrderFee();
  const propsRate = feeRate(orderFee.data);
  const pendingIncrease = openOrders.filter(o => o.isIncrease).reduce((sum, o) => sum + Number(o.sizeUsd), 0);
  const exposureRoom = account ? Number(account.rules.maxExposureUsd) - Number(account.openNotional) - pendingIncrease : 0;
  // The order's own Props fee stays beside its margin (the program's rule on funded accounts; demo follows it).
  const buyingPower = account ? Math.max(0, Math.min(exposureRoom, marginBuyingPower(Number(account.availableMargin), lev, propsRate))) : 0;
  // What the exchange accepts for a new position on this side right now (null: no limit known); the size slider's 100%.
  const sideMaxSize = side === 'Long' ? market.maxSizeLong : market.maxSizeShort;
  const maxSize = sideMaxSize == null ? null : Number(sideMaxSize);
  const sizeCap = maxSize == null ? buyingPower : Math.min(buyingPower, maxSize);
  const overVenue = maxSize != null && sizeNum > maxSize;
  const underMargin = market.minCollateralUsd != null && sizeNum > 0 && Number(marginFor(sizeNum, lev)) < Number(market.minCollateralUsd);
  // The exchange's own model refuses this exact order (the quote runs it): what the limits above cannot see, such as fees
  // taking a margin at the minimum below it. Said in the server's words, and the order cannot be sent.
  const venueRefusal = !overVenue && !underMargin && sizeNum >= 1 && quote.error?.code === 'rejected_by_venue' ? quote.error.message : null;
  const wrongLimit = orderType === 'Limit' && !(Number(limitPrice) > 0);
  const wrongProtection = (take && !(side === 'Long' ? Number(take) > entry : Number(take) < entry && Number(take) > 0)) || (stop && !(side === 'Long' ? Number(stop) < entry && Number(stop) > 0 : Number(stop) > entry));
  const tooSmall = sizeNum > 0 && sizeNum < 1;
  const restriction = stageRestriction(market, stage, config.data?.usdcMint);
  const blocked = !signedIn ? null
    : !account ? (accountsQuery.isError ? 'Your accounts could not be loaded. Orders are accepted once they load.' : stage === 'practice' || accountsQuery.isPending ? null : `You have no ${stage} account yet.`)
    : !TRADABLE_STATUSES.includes(account.status) ? `This account is ${STATUS[account.status][0].toLowerCase()}: new orders are not accepted. Closing positions still works.`
    : restriction ? restriction.reason
    : funded && config.data?.paused.trading ? 'Funded trading is paused by the operator. Closing positions and canceling orders still work.'
    : funded && (market.freshness === 'stale' || market.freshness === 'unavailable') ? `The price for ${market.pair} is ${market.freshness}. Funded orders resume when it updates.`
    : market.session === 'closed' ? `${market.pair} is closed. The exchange accepts orders again when the ${['Stocks', 'Forex'].includes(market.category) ? 'session' : 'market'} reopens.`
    : funded && session.network.state === 'wrong' ? session.network.reason
    : null;
  const simBusy = placeSim.isPending || simOrder?.status === 'awaiting';
  const busy = funded ? tx.busy || walletPrompt : simBusy;
  const invalid = !(sizeNum > 0) || sizeNum > buyingPower || overVenue || underMargin || !!venueRefusal || tooSmall || wrongLimit || wrongProtection || !(entry > 0);
  useEffect(() => { setSimOrder(null); }, [account?.id]);
  useEffect(() => { if (leverage > maxLeverage) patch({ leverage: maxLeverage }); }, [maxLeverage]);
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
    else if (tracked?.status === 'executed') { setSimOrder({ ...simOrder, status: 'done', message: 'Simulated order filled at the live price.' }); notify('Simulated order filled', `${simOrder.symbol} · ${account.label}`); }
    else if (tracked === null) setSimOrder({ ...simOrder, status: 'done', message: 'The simulated order is no longer pending. Positions and Activity show its result.' });
    else if (Date.now() - simOrder.since > 60_000) setSimOrder({ ...simOrder, status: 'done', message: 'Still awaiting execution. It stays under Open orders until it fills.' });
  }, [tracked]);
  async function submit(e) {
    e.preventDefault();
    if (invalid || busy || blocked || !live || !account) return;
    const body = { sizeUsd: sizeNum.toFixed(6), collateralUsd: marginFor(sizeNum, lev), takeProfit: take || undefined, stopLoss: stop || undefined };
    if (funded) {
      const result = await tx.run((chain, connection, trader, rate) => chain.prepareOpen(connection, trader, { funded: account.id, market: marketRef(market), isLong: side === 'Long', kind: orderType, price: orderType === 'Market' ? market.price : limitPrice, sizeUsd: sizeNum, collateralUsd: Number(body.collateralUsd), slippageBps: bps(slippage), takeProfit: body.takeProfit, stopLoss: body.stopLoss, rate }), { execution: prepared => { follows.current = orderType === 'Market' ? prepared.follows.map(f => f.order) : []; return orderType === 'Market' ? prepared.follows : []; }, done: orderType === 'Market' ? `${market.symbol} ${side.toLowerCase()} executed on the exchange.` : 'Limit order placed on the exchange. It executes when the price reaches your limit.' });
      if (result) setMobileOrder(false);
      return;
    }
    setSimOrder(null);
    try {
      const request = { symbol: market.symbol, side, kind: orderType, triggerPrice: orderType === 'Limit' ? limitPrice : undefined, slippageBps: bps(slippage), ...body };
      const { order } = await placeSim.mutateAsync({ clientId: keyFor(orderIds.current, [account.id, request]), ...request });
      orderIds.current.clear();
      if (orderType === 'Market' && order.status !== 'executed') setSimOrder({ id: order.id, symbol: market.symbol, since: Date.now(), status: 'awaiting' });
      else { setSimOrder({ id: order.id, status: 'done', message: orderType === 'Market' ? 'Simulated order filled at the live price.' : 'Simulated limit order placed. It fills when the live price reaches your limit.' }); notify(orderType === 'Market' ? 'Simulated order filled' : 'Limit order added', `${market.symbol} ${side.toLowerCase()} · ${account.label}`); }
      setMobileOrder(false);
    } catch (error) { setSimOrder({ status: 'failed', message: error.message }); }
  }
  const submitLabel = funded && tx.busy ? TX_LABELS[tx.phase] : placeSim.isPending ? 'Submitting…' : simOrder?.status === 'awaiting' ? 'Awaiting execution…' : `${side === 'Long' ? 'Buy / Long' : 'Sell / Short'} ${market.symbol}`;
  const rules = account?.rules;
  // The exchange's cost rows and Props' fee on this order and on its close, sized by the quote for this margin and limit.
  const q = quote.data;
  const fee = value => value != null ? usd(value) : quote.isError ? 'Unavailable' : DASH;
  const perHour = q?.hourlyCostUsd != null ? Number(q.hourlyCostUsd) : hourlyCostUsd(market, side, sizeNum);
  // Props' fee per order ("$0.50 + 0.02%", null while off): this order's from the quote, the program's formula until it answers.
  const propsRateLabel = feeRateLabel(propsRate);
  const propsFee = q?.platformFeeUsd ?? propsFeeUsd(propsRate, sizeNum);
  const propsCloseFee = q?.platformCloseFeeUsd ?? propsFee;
  // The most a take profit or stop loss can cost: the rate on the account's exposure cap (what it signs as its max_fee).
  const propsLegMax = rules ? propsFeeUsd(propsRate, Number(rules.maxExposureUsd)) : null;
  // The quote prices Props' fee at the server's rate: one that differs from the rate here means the rate changed, so the
  // ticket, buying power and the max_fee a funded order signs read it again (and match what the order is charged).
  const quotedFee = q?.platformFeeUsd, quotedSize = q?.sizeUsd;
  useEffect(() => {
    if (quotedFee != null && orderFee.isSuccess && Math.abs(Number(quotedFee) - propsFeeUsd(propsRate, Number(quotedSize))) > 1e-6) void client.invalidateQueries({ queryKey: keys.orderFee });
  }, [quotedFee, quotedSize]);
  // The Fees row's info button: the round trip's fees (their sum is the row), the cost of holding, the rest.
  const feesHelp = [`Open fee ${fee(q?.openFeeUsd)}`, `Est. close fee ${fee(q?.closeFeeUsd)}`, ...(propsRateLabel ? [`Props fee ${usd(propsFee)} to open, ${usd(propsCloseFee)} to close`] : []), `Borrow + funding ${perHour == null ? DASH : `≈ ${usd(perHour)}/h`} while open`, ...(funded ? [`Network fee ${openCost.data ? sol(openCost.data.feeLamports) : DASH}`] : []), ...(propsRateLabel ? [] : ['No Props.trade fee per order'])].join(' · ');
  const leverageHelp = `Higher leverage needs less margin and brings the liquidation price closer. ${market.pair} allows up to ${maxLeverage}×${market.closedMaxLeverage ? `; positions above ${market.closedMaxLeverage}× are closed before the session ends` : ''}.`;
  const presets = [1, 2, 5, 10, 25].filter(v => v < maxLeverage);
  const anchors = [...presets, maxLeverage]; // the slider's evenly spaced stops, one under each label
  /** Arrow keys step the leverage by one and Page Up / Page Down move it to the next label's value, not the slider by some of its positions. */
  const stepLeverage = e => { const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]; const page = { PageUp: true, PageDown: false }[e.key]; if (!step && page === undefined) return; e.preventDefault(); patch({ leverage: step ? Math.min(maxLeverage, Math.max(1, Math.round(lev) + step)) : pageLeverage(lev, anchors, page) }); };
  return <aside className={`order-panel ${mobileOrder ? 'mobile-visible' : ''}`}><div className="order-panel-heading"><h2>Place an order</h2><Badge tone={funded ? 'green' : 'purple'}>{funded ? 'Funded' : stage === 'practice' ? 'Practice' : 'Evaluation'}</Badge><IconButton className="mobile-close-order" icon={X} label="Close order form" onClick={() => setMobileOrder(false)} /></div><form onSubmit={submit} className="order-form"><div className="side-toggle"><button type="button" className={side === 'Long' ? 'active long' : ''} onClick={() => setSide('Long')}>Buy / Long</button><button type="button" className={side === 'Short' ? 'active short' : ''} onClick={() => setSide('Short')}>Sell / Short</button></div><Tabs items={['Market', 'Limit']} value={orderType} onChange={value => patch({ orderType: value })} className="order-type-tabs" /><div className="ticket-subrow"><span>Margin · USDC<button type="button" className="info-tip" aria-label="About leverage and margin" title={leverageHelp} onClick={() => notify('Leverage and margin', leverageHelp)}><Info size={12} /></button></span><span className="leverage-readout">{leverageText(lev)}× leverage</span></div><input className="size-slider leverage-slider" aria-label="Leverage" aria-valuetext={`${leverageText(lev)}×`} type="range" min="0" max={SLIDER_STEPS} step="any" value={leverageToPosition(lev, anchors)} onChange={e => patch({ leverage: positionToLeverage(Number(e.target.value), anchors) })} onKeyDown={stepLeverage} /><div className="size-presets leverage-presets">{presets.map((v, i) => <button type="button" key={v} style={labelAt(i / presets.length)} aria-pressed={lev === v} className={lev === v ? 'active' : ''} onClick={() => patch({ leverage: v })}>{v}×</button>)}<button type="button" style={labelAt(1)} aria-pressed={lev === maxLeverage} className={lev === maxLeverage ? 'active' : ''} onClick={() => patch({ leverage: maxLeverage })}>Max {maxLeverage}×</button></div>{orderType === 'Limit' && <Field label="Limit price"><div className="input-unit"><input aria-label="Order price" type="number" min="0" step="any" value={limitPrice} placeholder={price(market.price, market.priceDecimals)} onChange={e => patch({ limitPrice: e.target.value })} /><span>{market.pair.split(' / ')[1]}</span></div></Field>}<Field label="Order size"><div className="input-unit large-input"><input aria-label="Order size in USD" type="number" min="1" max={sizeCap} value={size} onChange={e => setSize(e.target.value)} /><span>USD</span></div></Field><div className="size-equivalent"><span>{usdBase(market) && entry > 0 ? `≈ ${number(sizeNum / entry, 5)} ${usdBase(market)}` : `Margin ${money(sizeNum / lev)}`}</span><span>Buying power <b>{account ? money(buyingPower, 0) : '—'}</b></span></div><input className="size-slider" aria-label="Percentage of buying power" type="range" min="0" max="100" step="1" disabled={!sizeCap} value={sizeCap ? Math.min(sizeNum / sizeCap * 100, 100) : 0} onChange={e => setSize(String(Math.floor(Number(e.target.value) / 100 * sizeCap)))} style={{ '--range': `${sizeCap ? Math.min(sizeNum / sizeCap * 100, 100) : 0}%` }} /><div className="size-presets">{[25, 50, 75, 100].map(n => <button type="button" key={n} style={labelAt(n / 100)} disabled={!sizeCap} onClick={() => setSize(String(Math.floor(n / 100 * sizeCap)))}>{n}%</button>)}</div><div className="protection-legs"><span className="protection-title"><ShieldCheck size={14} /> Take profit / Stop loss</span><ProtectionLeg kind="tp" label="Take profit" value={take} onChange={value => patch({ take: value })} entry={entry} side={side} decimals={market.priceDecimals} est={estimates.tp} /><ProtectionLeg kind="sl" label="Stop loss" value={stop} onChange={value => patch({ stop: value })} entry={entry} side={side} decimals={market.priceDecimals} est={estimates.sl} />{propsRateLabel && (take || stop) && legFeeNote(estimates.propsCloseFeeUsd ?? propsCloseFee, propsLegMax, take && stop)}</div><div className="execution-details order-summary"><DataRow label="Liq. price" value={marketPrice(q?.liquidationPrice ?? null, market)} /><div className="data-row"><span>Margin{touch() ? <small className="row-note">{MARGIN_NOTE}</small> : <button type="button" className="info-tip" aria-label="About margin" title={MARGIN_NOTE} onClick={() => notify('Margin', MARGIN_NOTE)}><Info size={12} /></button>}</span><strong>{money(sizeNum / lev)}</strong></div><div className="data-row"><span>Fees<button type="button" className="info-tip" aria-label="Fee breakdown" title={feesHelp} onClick={() => notify('Fees', feesHelp)}><Info size={12} /></button></span><strong>{fee(q?.roundTripFeeUsd ?? (q?.closeFeeUsd == null ? undefined : Number(q.openFeeUsd) + Number(q.closeFeeUsd)))}</strong></div></div>{overVenue && <p className="field-error">{maxSize >= 1 ? <>Up to {money(Math.floor(maxSize), 0)} can be opened {side.toLowerCase()}</> : <>No new {side.toLowerCase()} can be opened</>} on {market.symbol} right now.</p>}{underMargin && <p className="field-error">The minimum margin on {market.symbol} is {usd(market.minCollateralUsd)}.</p>}{venueRefusal && <p className="field-error">{venueRefusal}.</p>}{account && sizeNum > buyingPower && <p className="field-error">Order exceeds this account's buying power.</p>}{tooSmall && <p className="field-error">The exchange's minimum position is $1.</p>}{wrongProtection && <p className="field-error">Set take profit and stop loss on the correct sides of the {orderType === 'Market' ? 'current' : 'limit'} price.</p>}{blocked && <Notice tone="amber">{blocked}</Notice>}{!live && <Notice tone="amber">Waiting for live prices before you can submit.</Notice>}{!signedIn ? <Button type="button" className="full-width order-submit" onClick={() => setModal('wallet')} icon={Wallet}>Connect wallet to trade</Button> : stage === 'practice' && !account && accountsQuery.isSuccess ? <Button type="button" className="full-width order-submit" disabled={resetPractice.isPending} onClick={() => resetPractice.mutate(undefined, { onSuccess: () => notify('Practice account ready', 'Virtual capital, live prices.'), onError: error => notify('Practice is unavailable', error.message) })}>{resetPractice.isPending ? 'Starting practice…' : 'Start practice account'}</Button> : <Button type="submit" variant={side === 'Long' ? 'buy' : 'sell'} className="full-width order-submit" disabled={invalid || busy || !!blocked || !live || !account}>{submitLabel}{!busy && <ArrowRight size={16} />}</Button>}{funded ? <TxStatus tx={tx} /> : simOrder?.message && <Notice tone={simOrder.status === 'failed' ? 'amber' : 'purple'} role={simOrder.status === 'failed' ? 'alert' : 'status'}>{simOrder.message}</Notice>}<p className="order-note">{funded ? 'Live order · the exchange executes it with your funded account\'s USDC' : 'Simulated trading · profits are not withdrawable'}</p><details className="order-details" open={detailsOpen} onToggle={e => setDetailsOpen(e.currentTarget.open)}><summary>Order details <ChevronDown size={14} /></summary><div className="execution-details"><DataRow label="Estimated entry" value={marketPrice(orderType === 'Market' ? q?.executionPrice ?? market.price : limitPrice || null, market)} /><DataRow label="Order value" value={usd(q?.orderValueUsd ?? sizeNum)} /><DataRow label="Open fee" value={fee(q?.openFeeUsd)} /><DataRow label="Est. close fee" value={fee(q?.closeFeeUsd)} /><div className="data-row"><span>Price impact<small className="row-note">+ = better than mark</small></span><strong>{q ? `${number(q.priceImpactPct, 4)}%` : quote.isError ? 'Unavailable' : DASH}</strong></div><DataRow label={`Borrow + funding · ${side.toLowerCase()}`} value={perHour == null ? DASH : `≈ ${usd(perHour)}/h · ${usd(perHour * 24)}/day`} /><div className="data-row"><span>Slippage tolerance</span><button type="button" aria-label={`Slippage tolerance ${slippage}%, change`} onClick={() => setDialog('slippage')}>{slippage}% <Settings2 size={11} /></button></div>{funded && <DataRow label="Network fee" value={openCost.data ? sol(openCost.data.feeLamports) : openCost.isError ? 'Unavailable' : DASH} />}{propsRateLabel ? <div className="data-row"><span>Props fee · {propsRateLabel}<small className="row-note">{funded ? 'Charged only if the order executes' : 'Simulated · charged only if the order executes'}</small></span><strong>{usd(propsFee)}</strong></div> : <p className="fee-note">Props.trade charges no fee per order: the evaluation fee and the profit share are its only charges.</p>}</div></details></form><div className="ticket-account"><div className="ticket-account-title"><ShieldCheck size={15} /><h3>Your account, in view</h3></div><DataRow label={funded ? 'Account size' : 'Virtual account size'} value={rules ? usd(rules.sizeUsd) : '—'} /><DataRow label="Equity floor" value={rules ? usd(rules.floorUsd) : '—'} /><DataRow label="Remaining loss allowance" value={account ? usd(account.allowanceRemaining) : '—'} /><Progress value={account ? Math.min(100, Number(account.allowanceRemaining) / Number(rules.lossAllowanceUsd) * 100) : 0} label="Remaining original loss budget, capped at 100 percent" />{Number(account?.platformFees?.heldUsd) > 0 && <DataRow label="Props fees held" value={usd(account.platformFees.heldUsd)} />}<p>Open P&L and trading costs count toward your account limits.</p><button className="text-button" onClick={() => setModal('rules')}>View account rules <ArrowUpRight size={12} /></button></div>{stage === 'practice' && <div className="practice-upgrade"><p>Ready to make it count?</p><Button variant="secondary" small onClick={() => navigate('/get-funded')} icon={ArrowRight}>Start an evaluation</Button>{account && <button className="text-button" disabled={resetPractice.isPending} onClick={() => resetPractice.mutate(undefined, { onSuccess: () => notify('Practice account reset'), onError: error => notify('Reset failed', error.message) })}>Reset practice account</button>}</div>}</aside>;
}

/**
 * One take-profit or stop-loss leg of the ticket: a price and its distance from the entry in %, linked both ways,
 * ±1/2/5% chips in the leg's direction (a take profit sits above a long's entry, a stop loss below; a short is the
 * mirror) and what closing there would make. The % field is a draft while it is typed; otherwise it follows the price.
 */
function ProtectionLeg({ kind, label, value, onChange, entry, side, decimals, est }) {
  const [pctDraft, setPctDraft] = useState(null);
  const away = (kind === 'tp') === (side === 'Long') ? 1 : -1;
  const pct = pctDraft ?? (value && entry > 0 ? ((Number(value) / entry - 1) * 100).toFixed(2) : '');
  const fromPct = p => entry > 0 ? (entry * (1 + Number(p) / 100)).toFixed(decimals) : '';
  const set = (next, draft = null) => { setPctDraft(draft); onChange(next); };
  return <div className="protection-leg"><div className="leg-head"><span>{label}</span>{est ? <b className={tone(est.pnl)}>Est. P&L ≈ {signedUsd(est.pnl)}{est.pct == null ? '' : ` (${percent(est.pct, 1)} on margin)`}</b> : <b className="quiet">Est. P&L {DASH}</b>}</div><div className="leg-inputs"><input aria-label={`${label} price`} type="number" step="any" min="0" value={value} placeholder="Price" onChange={e => set(e.target.value)} /><div className="input-unit"><input aria-label={`${label} distance in percent`} type="number" step="any" value={pct} placeholder="Distance" onChange={e => set(e.target.value === '' ? '' : fromPct(e.target.value), e.target.value)} onBlur={() => setPctDraft(null)} /><span>%</span></div></div><div className="leg-chips">{[1, 2, 5].map(p => <button type="button" key={p} disabled={!(entry > 0)} onClick={() => set(fromPct(p * away))}>{away > 0 ? '+' : '−'}{p}%</button>)}<button type="button" disabled={!value} onClick={() => set('')}>Clear</button></div></div>;
}
