import { BPS, GM_USD_DECIMALS, MICRO_USD_DECIMALS } from './constants.ts';

/** Parses a non-negative decimal string into an integer with `decimals` places. Rejects excess precision. */
export function parseUnits(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) throw new Error(`not a non-negative decimal: "${value}"`);
  const [, whole, fraction = ''] = match;
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) {
    throw new Error(`"${value}" has more than ${decimals} decimal places`);
  }
  return BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, '0'));
}

/** Formats an integer with `decimals` places as a decimal string without trailing zeros. */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** "1234.5" USD → GMTrade USD (10^20 per USD). */
export const usdToGm = (usd: string): bigint => parseUnits(usd, GM_USD_DECIMALS);
export const gmToUsd = (gm: bigint): string => formatUnits(gm, GM_USD_DECIMALS);
/** "1234.5" USD or USDC → micro units (10^6). */
export const toMicro = (amount: string): bigint => parseUnits(amount, MICRO_USD_DECIMALS);
export const fromMicro = (micro: bigint): string => formatUnits(micro, MICRO_USD_DECIMALS);

/** Leverage multiple → basis points (25 → 250_000). */
export const leverageToBps = (leverage: number): number => Math.round(leverage * BPS);

/**
 * GMTrade "unit price" of an index token: USD per smallest token unit scaled by 10^20, i.e.
 * price × 10^(20 − tokenDecimals). GMTrade's keeper price API reports prices in this unit.
 */
export function toUnitPrice(price: string, tokenDecimals: number): bigint {
  return parseUnits(price, GM_USD_DECIMALS - tokenDecimals);
}

export function fromUnitPrice(unitPrice: bigint, tokenDecimals: number): string {
  return formatUnits(unitPrice, GM_USD_DECIMALS - tokenDecimals);
}

/**
 * Worst price an order may fill at, given the reference unit price and a slippage in bps.
 * Buying exposure (long increase, short decrease) caps the price above; selling floors it below.
 */
export function acceptablePrice(unitPrice: bigint, isLong: boolean, isIncrease: boolean, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= BPS) {
    throw new Error(`slippage must be an integer in [0, ${BPS}) bps`);
  }
  const bps = BigInt(BPS);
  const payingUp = isLong === isIncrease;
  return payingUp
    ? (unitPrice * (bps + BigInt(slippageBps)) + bps - 1n) / bps
    : (unitPrice * (bps - BigInt(slippageBps))) / bps;
}
