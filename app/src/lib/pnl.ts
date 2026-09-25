// Order-ticket arithmetic: what a take-profit or stop-loss would make, and what carrying the position costs. Pure, so
// the ticket, the chart labels and the tests read the same numbers.
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
