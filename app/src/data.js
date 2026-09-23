import { env } from './lib/env';

// Formatting for API values: amounts and prices arrive as decimal strings, times as unix milliseconds.
export const money = (value, digits = 2) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
export const number = (value, digits = 2) => new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
export const shortAddress = address => `${address.slice(0, 4)}…${address.slice(-4)}`;

/** `—` for values the API reports as unavailable (null). */
export const DASH = '—';
export const usd = (value, digits = 2) => value == null ? DASH : money(Number(value), digits);
export const signedUsd = (value, digits = 2) => value == null ? DASH : `${Number(value) >= 0 ? '+' : '−'}${money(Math.abs(Number(value)), digits)}`;
export const compactUsd = value => value == null ? DASH : '$' + new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value));
export const percent = (value, digits = 2) => value == null ? DASH : `${value > 0 ? '+' : ''}${number(value, digits)}%`;
export const price = (value, decimals) => value == null ? DASH : number(Number(value), decimals);
export const sol = lamports => `${number(lamports / 1e9, 6)} SOL`;
/**
 * Margin for a position size at a leverage, in USD with 6 decimals, rounded up: rounded down, size ÷ margin would exceed
 * the leverage (and a market's maximum). 15 significant digits drop the float noise before rounding.
 */
export const marginFor = (sizeUsd, leverage) => (Math.ceil(Number((sizeUsd / leverage * 1e6).toPrecision(15))) / 1e6).toFixed(6);
export const tone = value => Number(value) >= 0 ? 'positive' : 'negative';

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
const dateTimeFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const timeFormat = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const date = ts => ts == null ? DASH : dateFormat.format(ts);
export const dateTime = ts => ts == null ? DASH : dateTimeFormat.format(ts);
export const time = ts => ts == null ? DASH : timeFormat.format(ts);
export const utcTime = ts => ts == null ? DASH : `${new Date(ts).toISOString().slice(11, 19)} UTC`;

const explorerCluster = env.cluster === 'localnet' ? `?cluster=custom&customUrl=${encodeURIComponent(env.rpcUrl ?? '')}` : '';
export const explorerTx = signature => `https://explorer.solana.com/tx/${signature}${explorerCluster}`;
export const explorerAddress = address => `https://explorer.solana.com/address/${address}${explorerCluster}`;

/** A tier's rules in the AccountRules shape (what an evaluation bought under this tier starts with). */
export function tierRules(tier) {
  const size = Number(tier.sizeUsd);
  const loss = size * tier.maxDrawdownBps / 10_000;
  return {
    sizeUsd: tier.sizeUsd, lossAllowanceUsd: String(loss), floorUsd: String(size - loss), profitTargetUsd: String(size * tier.profitTargetBps / 10_000),
    maxExposureUsd: String(size * tier.maxExposureBps / 10_000), traderShareBps: tier.traderShareBps, termsHash: tier.termsHash, version: tier.version,
  };
}
export const bpsPercent = bps => `${number(bps / 100, bps % 100 ? 2 : 0)}%`;

export const STAGE_LABELS = { practice: 'Practice', evaluation: 'Evaluation', funded: 'Funded' };
export const STATUS = {
  active: ['Active', 'green'], near_limit: ['Near limit', 'amber'], checking: ['Checking result', 'amber'], passed: ['Passed', 'green'],
  breached: ['Rule breached', 'red'], failed: ['Ended', 'red'], awaiting_capacity: ['Awaiting capital', 'amber'], activating: ['Activating', 'amber'],
  restricted: ['Restricted', 'amber'], payout_pending: ['Payout pending', 'amber'], closure_pending: ['Closing', 'amber'], closed: ['Closed', 'neutral'],
};
/** Accounts that can still trade or progress. A passed evaluation stays current until a funded account is activated from it. */
export const isCurrent = (account, accounts) => !['breached', 'failed', 'closed'].includes(account.status)
  && !(account.stage === 'evaluation' && accounts.some(a => a.stage === 'funded' && a.evidence.evaluation === account.id));

export const ORDER_STATUS = {
  draft: 'Draft', signing: 'Signing', submitted: 'Submitted', awaiting_execution: 'Awaiting execution', awaiting_price: 'Awaiting price',
  executed: 'Executed', canceled: 'Canceled', rejected: 'Rejected', frozen: 'Frozen', unknown: 'Status unknown',
};
/** Orders still working (shown under Open orders and counted against exposure when they increase a position). */
export const isOpenOrder = order => !['executed', 'canceled', 'rejected'].includes(order.status);
/** Base asset of a pair, e.g. "BTC" in "BTC / USD"; null when prices are not quoted in USD (USD / JPY). */
export const usdBase = market => market.pair.endsWith('/ USD') ? market.pair.split(' / ')[0] : null;
/** A market's price, with "$" when the pair is quoted in USD ("$64,482.00"; "147.214" for USD / JPY). */
export const marketPrice = (value, market) => value == null ? DASH : `${usdBase(market) ? '$' : ''}${price(value, market.priceDecimals)}`;
/**
 * Why the stage's accounts cannot trade a market, or null when they can: funded accounts and evaluations (identical
 * rules) trade the allowlisted markets, practice any market whose preferred GMTrade pool is USDC-only (as the engine
 * checks). `label` names it in market lists, `reason` explains it where an order would be placed.
 */
export function stageRestriction(market, stage, usdcMint) {
  if (stage === 'practice') {
    const pool = market.pools.find(p => p.marketToken === market.marketToken);
    const usdcOnly = pool?.pure && (!usdcMint || (pool.longToken === usdcMint && pool.shortToken === usdcMint));
    return usdcOnly ? null : { label: 'Not available in practice', reason: `${market.symbol} has no USDC-only pool on GMTrade, so it cannot be traded here.` };
  }
  if (market.tradable) return null;
  return stage === 'funded'
    ? { label: 'Not available for funded trading', reason: market.unavailableReason ?? 'Not available for funded trading.' }
    : { label: 'Not available in evaluations', reason: `${market.symbol} is not available in evaluations: they trade only the markets funded accounts can.` };
}
/** Label for a market price that is not live ('Stale', 'Delayed', 'Unavailable'), or null when it is live. */
export const freshnessLabel = market => market.freshness === 'live' ? null : market.freshness[0].toUpperCase() + market.freshness.slice(1);
