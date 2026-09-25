import React, { useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight, CheckCheck, Clock3, FileCheck2, Fingerprint, Layers3, Search, Wallet } from 'lucide-react';
import { useApp } from './App.jsx';
import { STAGE_LABELS, STATUS, date, dateTime, explorerTx, isSolanaAddress, number, percent, price, signedUsd, tone, usd } from './data.js';
import { Badge, Button, Empty, FullAddress, InlineLink, MarketIcon, Notice, PageHeading, Pending, SectionHeading, Unavailable } from './ui.jsx';
import { PAYOUT_STATUS } from './Money.jsx';
import { tradeRecord } from './Trading.jsx';
import { TradeTable } from './Workspace.jsx';
import { tradesRoot } from '@props/shared/merkle';
import { api } from './lib/api';
import { env } from './lib/env';
import { useTrader, useVerify } from './lib/queries';

const EVIDENCE_STATE = { confirmed: ['Confirmed', 'green'], pending: ['Pending', 'amber'], indexing: ['Indexing', 'amber'], stale: ['Stale', 'amber'], unavailable: ['Unavailable', 'neutral'], simulated: ['Simulated', 'purple'] };
const NOT_AN_ADDRESS = 'is not a Solana address. Paste the whole address: 32 to 44 letters and digits, no spaces.';

/**
 * Search: any trader by wallet address (their accounts at every stage, open positions, recent trades and payouts; never
 * identity data), then the verification records behind accounts, payouts and transactions. Signed out or in.
 */
export function SearchPage() {
  const { query: route, navigate } = useApp();
  const submitted = route.get('trader') ?? '';
  const valid = isSolanaAddress(submitted);
  const [address, setAddress] = useState(submitted);
  useEffect(() => setAddress(submitted), [submitted]);
  const trader = useTrader(valid ? submitted : null); // a malformed address is refused here, before the API refuses it
  function search(e) { e.preventDefault(); navigate(`/search?trader=${encodeURIComponent(address.trim())}`); }
  return <div className="page verify-page"><PageHeading title="Search" description="Any trader by Solana address: accounts, open positions, recent trades and payouts. Then the records behind them." /><form className="verify-search" onSubmit={search}><Wallet size={20} /><input aria-label="Search a trader" value={address} onChange={e => setAddress(e.target.value)} placeholder="Paste a trader's Solana address" /><Button type="submit" disabled={!address.trim()} icon={ArrowRight}>Search trader</Button></form>{submitted && !valid && <Notice role="status">“{submitted}” {NOT_AN_ADDRESS}</Notice>}{valid && (trader.isPending ? <Pending>Looking up the trader…</Pending> : trader.isError ? (trader.error.status === 404 ? <Empty icon={Search} title="No trader with this address">No Props.trade account belongs to this wallet. Practice, evaluation and funded accounts all count.</Empty> : trader.error.status === 400 ? <Notice role="status">“{submitted}” {NOT_AN_ADDRESS}</Notice> : <Unavailable title="The search is unavailable" error={trader.error} retry={trader.refetch} />) : <TraderResults trader={trader.data} />)}<VerificationRecords /></div>;
}

/** What is public about a trader. A market in a position or trade row opens it in the terminal. */
function TraderResults({ trader }) {
  const { markets, selectMarket, openRecord } = useApp();
  const bySymbol = new Map(markets.map(m => [m.symbol, m]));
  const leverage = value => number(value, Number.isInteger(value) ? 0 : 1);
  return <div className="trader-results"><div className="trader-address"><span>Trader</span><FullAddress address={trader.address} /></div>
    <section className="surface"><SectionHeading>Accounts</SectionHeading>{trader.accounts.length ? <div className="table-scroll"><table><thead><tr><th>Stage</th><th>Status</th><th>Size</th><th>Equity</th><th>Since</th></tr></thead><tbody>{trader.accounts.map(a => { const [statusLabel, statusTone] = STATUS[a.status] ?? [a.status, 'neutral']; return <tr key={a.id}><td><Badge tone={a.stage === 'funded' ? 'green' : 'purple'}>{STAGE_LABELS[a.stage] ?? a.stage}</Badge></td><td><Badge tone={statusTone} dot>{statusLabel}</Badge></td><td>{usd(a.sizeUsd, 0)}</td><td><strong>{usd(a.equityUsd)}</strong></td><td className="quiet">{date(a.createdAt)}</td></tr>; })}</tbody></table></div> : <Empty icon={Clock3} title="No accounts">This wallet has not opened a Props.trade account.</Empty>}</section>
    <section className="surface"><SectionHeading>Open positions</SectionHeading>{trader.positions.length ? <div className="table-scroll"><table><thead><tr><th>Market / side</th><th>Position size</th><th>Entry price</th><th>Mark price</th><th>Unrealized P&L</th></tr></thead><tbody>{trader.positions.map(p => { const m = bySymbol.get(p.symbol) ?? { symbol: p.symbol, priceDecimals: 2, pair: `${p.symbol} / USD` }; return <tr key={p.id}><td><button className="table-market market-name-button" onClick={() => selectMarket(p.symbol)}><MarketIcon market={m} small /><span><strong>{m.pair}</strong><small className={p.side === 'Long' ? 'positive' : 'negative'}>{p.side} · {leverage(p.leverage)}× · {p.venue === 'simulated' ? 'Simulated' : 'Funded'}</small></span></button></td><td><strong>{number(Number(p.sizeTokens), 4)} {p.symbol}</strong><small>{usd(p.sizeUsd)}</small></td><td>{price(p.entryPrice, m.priceDecimals)}</td><td>{price(p.markPrice ?? m.price, m.priceDecimals)}</td><td><strong className={tone(p.unrealizedPnl ?? 0)}>{signedUsd(p.unrealizedPnl)}</strong><small className={tone(p.unrealizedPnl ?? 0)}>{p.unrealizedPnl == null ? '' : percent(Number(p.unrealizedPnl) / Number(p.collateralUsd) * 100)}</small></td></tr>; })}</tbody></table></div> : <Empty icon={Clock3} title="No open positions">Open positions at every stage appear here with their mark and unrealized P&L.</Empty>}</section>
    <section className="surface"><SectionHeading>Recent trades</SectionHeading>{trader.trades.length ? <TradeTable trades={trader.trades.slice(0, 50)} onRecord={t => openRecord(tradeRecord(t, bySymbol))} /> : <Empty icon={Clock3} title="No closed trades">Closed trades appear here with their fees and net result.</Empty>}</section>
    <section className="surface"><SectionHeading>Payouts</SectionHeading>{trader.payouts.length ? <div className="table-scroll"><table><thead><tr><th>Status</th><th>Amount</th><th>Requested</th><th>Paid</th><th>Transaction</th></tr></thead><tbody>{trader.payouts.map(p => { const [label, badgeTone] = PAYOUT_STATUS[p.status] ?? [p.status, 'neutral']; return <tr key={p.id}><td><Badge tone={badgeTone} dot>{label}</Badge></td><td><strong>{usd(p.amountUsd)}</strong></td><td className="quiet">{dateTime(p.requestedAt)}</td><td className="quiet">{dateTime(p.paidAt)}</td><td>{p.signature ? <InlineLink href={explorerTx(p.signature)} external>Transaction</InlineLink> : '—'}</td></tr>; })}</tbody></table></div> : <Empty icon={Clock3} title="No payouts">Payouts from a funded account appear here with their onchain transfer.</Empty>}</section>
  </div>;
}

const evidenceRecord = item => ({
  title: item.title, simulated: item.state === 'simulated', badge: EVIDENCE_STATE[item.state][0], signature: item.signature, address: item.address, note: item.description,
  rows: [['What it establishes', item.establishes], ['State', EVIDENCE_STATE[item.state][0]], ...(item.slot ? [['Slot', number(item.slot, 0)]] : []), ...(item.ts ? [['Time', dateTime(item.ts)]] : [])],
});

/** Recomputes an evaluation's trades root in the browser from its public fill list, and compares it with the recorded one. */
function TradesRootCheck({ committed }) {
  const [check, setCheck] = useState(null); // { busy } | { root, count } | { error }
  async function run() {
    setCheck({ busy: true });
    try {
      const fills = await api.fills(committed.evaluation);
      setCheck({ root: await tradesRoot(fills), count: fills.length });
    } catch (error) { setCheck({ error: error.message }); }
  }
  return <>
    <button onClick={run} disabled={check?.busy}>{check?.busy ? 'Recomputing…' : 'Recompute trades root'} <Fingerprint size={12} /></button>
    <InlineLink href={`${env.apiUrl}/v1/sim/${encodeURIComponent(committed.evaluation)}/fills`} external>Fill list (JSON)</InlineLink>
    {check && !check.busy && <p role="status">{check.error ? `The fill list could not be checked: ${check.error}`
      : check.root === committed.root ? `Matches the recorded trades root: recomputed here from ${check.count} ${check.count === 1 ? 'fill' : 'fills'}.`
      : `Does not match the recorded trades root: ${check.count} ${check.count === 1 ? 'fill gives' : 'fills give'} ${check.root}.`}</p>}
  </>;
}

/** The verification workspace (once the Verify page): a record by account, payout or transaction id, with its evidence. */
function VerificationRecords() {
  const { query: route, navigate, openRecord } = useApp();
  const [query, setQuery] = useState(route.get('q') ?? '');
  const submitted = route.get('q') ?? '';
  const result = useVerify(submitted);
  useEffect(() => setQuery(submitted), [submitted]); // a record link can open another search while this page is shown
  function search(e) { e.preventDefault(); navigate(`/search?q=${encodeURIComponent(query.trim())}`); }
  const r = result.data;
  const found = r && !['not_found', 'unsupported'].includes(r.kind);
  return <><div className="records-intro"><h2>Follow the record.</h2><p>Capital, account rules, trades and payouts. Know what each record tells you.</p></div><form className="verify-search" onSubmit={search}><Search size={20} /><input aria-label="Search verification records" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search an account, payout, transaction or wallet" /><Button type="submit" disabled={!query.trim()} icon={ArrowRight}>Find record</Button></form>{r?.kind === 'not_found' && <Notice>No record matches “{r.query}”. Search an evaluation, funded account or payout address, a transaction signature or a wallet.</Notice>}{r?.kind === 'unsupported' && <Notice>“{r.query}” is not a Solana address or transaction signature.</Notice>}{found && <div className="verify-search-result"><FileCheck2 size={21} /><span><strong>{r.title}</strong><small>{r.items.length} {r.items.length === 1 ? 'record' : 'records'} · {r.items.filter(i => i.state === 'confirmed').length} confirmed onchain</small></span>{r.items[0] && <Button variant="secondary" small onClick={() => openRecord(evidenceRecord(r.items[0]))}>Inspect record</Button>}</div>}<div className="verification-layout"><section className="surface verification-record">{!submitted ? <Empty icon={Search} title="Search a record">Paste an evaluation, funded account or payout address, a transaction signature or a wallet. Every result links to its onchain source.</Empty> : result.isPending ? <Pending>Looking up the record…</Pending> : result.isError ? <Unavailable title="Verification is unavailable" error={result.error} retry={result.refetch} /> : !found ? <Empty icon={Search} title="Nothing to show">Try another identifier.</Empty> : <><SectionHeading action={<Badge tone="purple">{r.kind === 'transaction' ? 'Transaction' : r.kind === 'wallet' ? 'Wallet' : r.kind === 'payout' ? 'Payout' : r.kind === 'funded' ? 'Funded account' : 'Evaluation'}</Badge>}>{r.title}</SectionHeading><div className="proof-timeline">{r.items.map((item, i) => { const [label, badgeTone] = EVIDENCE_STATE[item.state]; const Icon = item.state === 'confirmed' ? CheckCheck : item.state === 'simulated' ? Layers3 : Clock3; return <div key={`${item.title}-${i}`}><span className="proof-step-icon"><Icon size={18} /></span><div><h3>{item.title}</h3><p>{item.description}</p><button onClick={() => openRecord(evidenceRecord(item))}>{item.signature ? 'Transaction' : item.address ? 'Account' : 'Details'} <ArrowUpRight size={12} /></button>{item.tradesRoot && <TradesRootCheck committed={item.tradesRoot} />}</div><Badge tone={badgeTone}>{label}</Badge></div>; })}</div></>}</section><aside><section className="surface proof-about"><Fingerprint size={26} className="purple-text" /><h2>Evidence with context.</h2><p>A record should tell you what happened, where the information came from and what remains pending.</p><div className="proof-key"><span className="proof-key-dot" /><span>Transaction submission and execution are different events.</span></div><div className="proof-key"><span className="proof-key-dot" /><span>Simulated evaluations have no real venue fills.</span></div><div className="proof-key"><span className="proof-key-dot" /><span>Data freshness is part of the record.</span></div></section><div className="vault-link-panel"><Wallet size={22} /><h3>Where the capital comes from.</h3><p>See the vault's capital, allocations and every movement.</p><Button variant="secondary" icon={ArrowUpRight} onClick={() => navigate('/vault')}>View vault transparency</Button></div></aside></div><Notice>Funded trades, payouts and vault movements link to their Solana transactions. Evaluation trades are simulated: their fill list is committed onchain as a hash when the evaluation ends.</Notice></>;
}
