// Glue between the engine's decimal strings and GMTrade's model (@props/gmsol-wasm). Units:
//   usd    USD values, 1e20 = $1 (GMTrade)            micro  USDC amounts, 1e6 = 1 USDC (collateral token base units)
//   unit   GMTrade unit prices: USD × 10^(20 − token decimals), as the oracle quotes min/max
// Account money is USDC: collateral goes in and comes out of GMTrade positions as USDC.
import type { Market, PriceTick } from '@props/shared';
import { USD_DECIMALS, decodePosition, formatFixed, parseFixed, storeIdl } from '@props/gmtrade';
import type { ModelInput, Price } from '@props/gmsol-wasm';
import { toUnitPrice } from '@props/sdk';
import type { MarketState } from '../types.ts';

export const MICRO_PER_USD = 10n ** 14n; // usd / MICRO_PER_USD = micro at 1 USDC = $1 (sizes vs collateral only)

export const usd = (s: string) => parseFixed(s, USD_DECIMALS);
export const micro = (s: string) => parseFixed(s, 6);
export const usdText = (v: bigint) => formatFixed(v, USD_DECIMALS, 6);
export const microText = (v: bigint) => formatFixed(v, 6, 6);
/** Decimal strings from numeric columns without trailing zeros ("118.500000" → "118.5"). */
export const trim = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

/** USD price string of a unit price, exact. */
export const priceText = (unit: bigint, decimals: number) => formatFixed(unit, USD_DECIMALS - decimals, USD_DECIMALS - decimals);
export const unitOf = (price: string, decimals: number) => toUnitPrice(price, decimals);
export const tickUnits = (tick: Pick<PriceTick, 'min' | 'max'>, decimals: number): Price =>
  ({ min: unitOf(tick.min, decimals), max: unitOf(tick.max, decimals) });

/**
 * Model input for a market at an index price; collateral prices are the market state's (USDC in pure pools).
 * With `position` (a simulated Position account), the market is the live one as if that position were in it.
 */
export function modelInput(state: MarketState, index: Price, position?: string): ModelInput {
  const raw = state.raw as { market: string; virtualInventories: Record<string, string> };
  const market = position === undefined ? raw.market : withPosition(raw.market, position);
  return { market, virtualInventories: raw.virtualInventories, prices: { ...state.prices, index } };
}

const poolAmount = (pool: string, token: 'long' | 'short' = 'long') => storeIdl.offsetOf('Market', `state.pools.${pool}.pool.${token}_token_amount`);
const OPEN_INTEREST = { long: poolAmount('open_interest_for_long'), short: poolAmount('open_interest_for_short') };
const OPEN_INTEREST_TOKENS = { long: poolAmount('open_interest_in_tokens_for_long'), short: poolAmount('open_interest_in_tokens_for_short') };
const COLLATERAL_SUM = { long: poolAmount('collateral_sum_for_long'), short: poolAmount('collateral_sum_for_short') };
const TOTAL_BORROWING = { long: poolAmount('total_borrowing', 'long'), short: poolAmount('total_borrowing', 'short') };
const BORROWING_FACTOR = { long: poolAmount('borrowing_factor', 'long'), short: poolAmount('borrowing_factor', 'short') };
const FUNDING_PER_SIZE = { long: poolAmount('funding_amount_per_size_for_long'), short: poolAmount('funding_amount_per_size_for_short') };
const CLAIMABLE_PER_SIZE = { long: poolAmount('claimable_funding_amount_per_size_for_long'), short: poolAmount('claimable_funding_amount_per_size_for_short') };
const CLOCK = { borrowing: storeIdl.offsetOf('Market', 'state.clocks.borrowing'), funding: storeIdl.offsetOf('Market', 'state.clocks.funding') };
const CHANGED_AT = { increase: storeIdl.offsetOf('Position', 'state.increased_at'), decrease: storeIdl.offsetOf('Position', 'state.decreased_at') };

/** The Position account with its last increase or decrease time (unix seconds), as GMTrade's execution records it. */
export function stampPosition(position: string, isIncrease: boolean, at: Date): string {
  const b = Buffer.from(position, 'base64');
  b.writeBigInt64LE(BigInt(Math.floor(at.getTime() / 1000)), isIncrease ? CHANGED_AT.increase : CHANGED_AT.decrease);
  return b.toString('base64');
}

/**
 * The Market account with a simulated position added to the totals GMTrade keeps for every real position: open
 * interest (USD and tokens), collateral sum and total borrowing (size × borrowing factor). A funded account's
 * position is part of those totals, so this is the pool its changes and valuation run against; without it, valuing
 * or closing a simulated position larger than the real open interest (a thin or closed market) underflows the pool.
 *
 * Fees accrue from the position's last change on: GMTrade commits the market's accrual up to that moment when it
 * executes the change, and the position's fee snapshots are that committed state. So while the market has not
 * changed onchain since (its clock is older), its borrowing and funding restart there, from those snapshots, and
 * accrue at the rates with the position in the pool; otherwise a new position would pay the time before it existed,
 * at rates it did not cause. Pure pools only (the only ones simulated): their totals sit in the long-token amount,
 * and each collateral side of a per-size pool reads as half of it (gmsol-programs model/pool.rs).
 */
export function withPosition(market: string, position: string): string {
  const b = Buffer.from(market, 'base64');
  const p = decodePosition(position);
  const side = p.kind === 1 ? 'long' : 'short';
  const read = (offset: number) => b.readBigUInt64LE(offset) | (b.readBigUInt64LE(offset + 8) << 64n);
  const write = (offset: number, value: bigint) => {
    b.writeBigUInt64LE(value & 0xffff_ffff_ffff_ffffn, offset);
    b.writeBigUInt64LE(value >> 64n, offset + 8);
  };
  const add = (offset: number, value: bigint) => write(offset, read(offset) + value);
  add(OPEN_INTEREST[side], p.state.size_in_usd);
  add(OPEN_INTEREST_TOKENS[side], p.state.size_in_tokens);
  add(COLLATERAL_SUM[side], p.state.collateral_amount);
  add(TOTAL_BORROWING[side], (p.state.size_in_usd * p.state.borrowing_factor) / 10n ** BigInt(USD_DECIMALS));

  const changedAt = p.state.increased_at > p.state.decreased_at ? p.state.increased_at : p.state.decreased_at;
  if (b.readBigInt64LE(CLOCK.borrowing) <= changedAt) {
    write(BORROWING_FACTOR[side], p.state.borrowing_factor);
    b.writeBigInt64LE(changedAt, CLOCK.borrowing);
  }
  if (b.readBigInt64LE(CLOCK.funding) <= changedAt) {
    write(FUNDING_PER_SIZE[side], 2n * p.state.funding_fee_amount_per_size); // USDC collateral is the long token
    write(CLAIMABLE_PER_SIZE[side], p.state.long_token_claimable_funding_amount_per_size + p.state.short_token_claimable_funding_amount_per_size);
    b.writeBigInt64LE(changedAt, CLOCK.funding);
  }
  return b.toString('base64');
}

/** Why no new position of that size fits on a side: its room right now (Market.maxSizeLong/Short), in whole dollars. */
export function roomText(symbol: string, way: 'long' | 'short', maxSize: string): string {
  const whole = Math.floor(Number(maxSize));
  return whole > 0 ? `Up to $${whole.toLocaleString('en-US')} can be opened ${way} on ${symbol} right now` : `No new ${way} can be opened on ${symbol} right now`;
}

/**
 * The exchange's refusal of a new position (a gmsol-model error from simulateIncrease) in plain words naming the
 * market, side and the limit it hit: its reserve or max open interest, the collateral its min collateral factor asks
 * for after fees (leverage), or its min collateral, which fees count against. Null for any other reason.
 */
export function plainRefusal(err: unknown, market: Market, side: 'Long' | 'Short', size: bigint, collateral: bigint): string | null {
  const reason = err instanceof Error ? err.message : String(err);
  const way = side === 'Long' ? 'long' : 'short';
  if (/^(insufficient reserve|max open interest exceeded)/.test(reason)) {
    const room = side === 'Long' ? market.maxSizeLong : market.maxSizeShort;
    return room !== null && usd(room) < size ? roomText(market.symbol, way, room) : `The exchange cannot open a ${way} this large on ${market.symbol} right now`;
  }
  if (/insufficient collateral usd|min collateral for leverage|: <= 0$/.test(reason)) {
    return `Leverage ${(Number(size) / Number(collateral * MICRO_PER_USD)).toFixed(2)}x is above what the exchange accepts for ${way}s on ${market.symbol} right now`;
  }
  if (/: min collateral$/.test(reason) && market.minCollateralUsd !== null) {
    const min = Number(market.minCollateralUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `A ${way} on ${market.symbol} needs at least $${min} of margin after fees`;
  }
  return null;
}

/** USD value → USDC micro units at the collateral's min price, the price GMTrade values collateral at. */
export const usdToMicro = (value: bigint, state: MarketState) => value / state.prices.short.min;

export type TriggerKind = 'Limit' | 'TakeProfit' | 'StopLoss';

/**
 * GMTrade's trigger rule (gmsol-store 0.10.0 states/order.rs validate_trigger_price): the order may execute at `p`
 * when LimitIncrease long max ≤ trigger / short min ≥ trigger; LimitDecrease (take profit) long min ≥ trigger /
 * short max ≤ trigger; StopLossDecrease long min ≤ trigger / short max ≥ trigger.
 */
export function triggered(kind: TriggerKind, isLong: boolean, trigger: bigint, p: Price): boolean {
  if (kind === 'Limit') return isLong ? p.max <= trigger : p.min >= trigger;
  if (kind === 'TakeProfit') return isLong ? p.min >= trigger : p.max <= trigger;
  return isLong ? p.min <= trigger : p.max >= trigger;
}

/** The side of the quote an order trades against: buying exposure (long increase, short decrease) pays the max. */
export const quoteFor = (p: Price, isLong: boolean, isIncrease: boolean) => (isLong === isIncrease ? p.max : p.min);

/** gmsol-model's acceptable-price rule: buyers fill at or below it, sellers at or above it. */
export const withinAcceptable = (execution: bigint, acceptable: bigint, isLong: boolean, isIncrease: boolean) =>
  isLong === isIncrease ? execution <= acceptable : execution >= acceptable;
