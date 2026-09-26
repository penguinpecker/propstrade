// Order-ticket arithmetic: what a take-profit or stop-loss would make, what carrying the position costs and what Props
// charges per order. Pure, so the ticket, the chart labels and the tests read the same numbers.
import type { OrderFeeRate } from '@props/sdk';
import type { Market } from '@props/shared';

export interface ExpectedPnlInput {
  side: 'Long' | 'Short';
  sizeUsd: number;
  /** The price the position opens at: the quote's execution price for a market order, the limit price for a limit order. */
  entry: number;
  /** The take-profit or stop-loss price. */
  target: number;
  openFeeUsd?: number;
  closeFeeUsd?: number;
  /** Price impact counted as a cost (a positive number lowers the result). */
  priceImpactUsd?: number;
}

/**
 * Net result of closing `sizeUsd` at `target` after opening at `entry`: the price move in the side's favour is positive
 * (a long's target above its entry, a short's below), and the open fee, the close fee and the impact are taken off.
 */
export function expectedPnl({ side, sizeUsd, entry, target, openFeeUsd = 0, closeFeeUsd = 0, priceImpactUsd = 0 }: ExpectedPnlInput): number {
  const move = (target - entry) / entry * (side === 'Long' ? 1 : -1);
  return sizeUsd * move - openFeeUsd - closeFeeUsd - priceImpactUsd;
}

/** A market's hourly funding and borrow rates (percent per hour) for one side; null where the server gives none. */
export function sideRates(market: Pick<Market, 'fundingRateHourlyLong' | 'fundingRateHourlyShort' | 'borrowRateHourlyLong' | 'borrowRateHourlyShort'>, side: 'Long' | 'Short') {
  return side === 'Long'
    ? { funding: market.fundingRateHourlyLong, borrow: market.borrowRateHourlyLong }
    : { funding: market.fundingRateHourlyShort, borrow: market.borrowRateHourlyShort };
}

/**
 * What a position of `sizeUsd` on `side` pays per hour: borrowing plus funding when this side pays it (USD), or null
 * without both rates. Funding received is never credited to an account (GMTrade parks it as a claimable that neither
 * stage counts), so a receiving side carries only its borrow rate.
 */
export function hourlyCostUsd(market: Parameters<typeof sideRates>[0], side: 'Long' | 'Short', sizeUsd: number): number | null {
  const { funding, borrow } = sideRates(market, side);
  return funding == null || borrow == null ? null : sizeUsd * (Math.max(0, funding) + borrow) / 100;
}

/** Props.trade's fee per order as AppConfig gives it; a server that predates it gives none, which is no fee. */
export interface FeeConfig { orderFeeUsd?: string; orderFeeBps?: number }

/** The rate as the program and the SDK read it: USDC base units per order plus bps of the order's size. */
export const feeRate = (config: FeeConfig | null | undefined): OrderFeeRate => ({ feeUsdc: BigInt(Math.round((Number(config?.orderFeeUsd) || 0) * 1e6)), feeBps: config?.orderFeeBps ?? 0 });

/**
 * The Props fee of an order of `sizeUsd`, in USD: the program's formula (the flat part plus the bps of the size in
 * micro-USD, rounded down), which @props/sdk orderFee computes for the orders the app signs. Restated here so the
 * ticket's code stays out of the SDK's chunk; pnl.test.ts holds it to orderFee. A close, take profit or stop loss is
 * assessed on at most the account's exposure cap: the fee on the cap is its maximum.
 */
export const propsFeeUsd = (rate: OrderFeeRate, sizeUsd: number) =>
  sizeUsd > 0 ? Number(rate.feeUsdc + BigInt(sizeUsd.toFixed(6).replace('.', '')) * BigInt(rate.feeBps) / 10_000n) / 1e6 : 0;

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 });
/** The rate as the ticket and the rules name it: "$0.50 + 0.02%", "$0.50" or "0.02%"; null while it is off. */
export function feeRateLabel(rate: OrderFeeRate): string | null {
  const parts = [rate.feeUsdc > 0n ? dollars.format(Number(rate.feeUsdc) / 1e6) : '', rate.feeBps > 0 ? `${rate.feeBps / 100}%` : ''].filter(Boolean);
  return parts.length ? parts.join(' + ') : null;
}

/**
 * The largest order `availableMarginUsd` opens at `leverage` with the order's own Props fee left beside its margin, as
 * the program requires of a funded order (collateral + fee + held fees ≤ the account's USDC; availableMargin is already
 * net of the held fees): size / leverage + flat + size × bps ≤ margin. Demo accounts follow the same rule.
 */
export function buyingPower(availableMarginUsd: number, leverage: number, rate: OrderFeeRate): number {
  const flat = Number(rate.feeUsdc) / 1e6, share = rate.feeBps / 10_000;
  return Math.max(0, (availableMarginUsd - flat) * leverage / (1 + share * leverage));
}
