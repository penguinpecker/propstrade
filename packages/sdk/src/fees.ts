import { PublicKey } from '@solana/web3.js';
import { enumName } from './client.ts';
import type { FundedAccount } from './client.ts';

/** Props.trade's order fee rate, as `Config.orderFeeUsdc` / `Config.orderFeeBps` hold it. */
export interface OrderFeeRate {
  /** USDC base units per order. */
  feeUsdc: bigint;
  /** Of the order's USD size. */
  feeBps: number;
}

const GM_PER_MICRO = 10n ** 14n;

/**
 * The program's Props fee (USDC base units) of an order of `sizeUsd` (GMTrade USD, 10^20 per USD) counting at most
 * `capUsd` of it: feeUsdc + ⌊⌊size / 10^14⌋ × feeBps / 10^4⌋, 0 for a size of 0 (a collateral-only increase). An
 * increase has no cap. A decrease (close, take profit, stop loss) is capped at the account's exposure cap
 * (⌊terms.sizeUsd × terms.maxExposureBps / 10^4⌋ × 10^14), since the position can grow before it fires but never past
 * that cap: that is the most it can cost, and it is charged `orderFee(rate, executed size)` when it executes (at most
 * the assessed fee). A risk authority's close is assessed the same way (the session guard), except on a breached
 * account, where it is free. The same numbers on the demo stage and on funded accounts.
 */
export function orderFee(rate: OrderFeeRate, sizeUsd: bigint, capUsd?: bigint): bigint {
  if (sizeUsd === 0n) return 0n;
  const base = capUsd !== undefined && capUsd < sizeUsd ? capUsd : sizeUsd;
  return rate.feeUsdc + ((base / GM_PER_MICRO) * BigInt(rate.feeBps)) / 10_000n;
}

/**
 * Fees an order that adds exposure must leave in the account's USDC next to its collateral and its own fee: the fees
 * due plus the fees of pending increase orders (decrease orders hold nothing). A plain list, for accounts the program
 * does not hold (the demo stage); `fundedReservedFees` reads a funded account.
 */
export function reservedFees(due: bigint, orders: { fee: bigint; isIncrease: boolean }[]): bigint {
  return orders.reduce((sum, o) => (o.isIncrease ? sum + o.fee : sum), due);
}

/** `reservedFees` of a decoded funded account, as the program computes it. */
export function fundedReservedFees(account: FundedAccount): bigint {
  const orders = account.orders
    .map((o, j) => ({ fee: BigInt(account.orderFees[j]!.toString()), isIncrease: ['market', 'limit'].includes(enumName(o.orderType)), free: o.order.equals(PublicKey.default) }))
    .filter((o) => !o.free);
  return reservedFees(BigInt(account.orderFeesDue.toString()), orders);
}
