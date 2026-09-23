// Exact conversions between GMTrade fixed-point integers and API decimal strings.

/** GMTrade USD values and factors carry 20 decimals. */
export const USD_DECIMALS = 20;
export const USD_UNIT = 10n ** 20n;

/** `value / 10^decimals` as a decimal string rounded half away from zero to `dp` places, trailing zeros trimmed. */
export function formatFixed(value: bigint, decimals: number, dp: number): string {
  const neg = value < 0n;
  let abs = neg ? -value : value;
  if (dp < decimals) {
    const cut = 10n ** BigInt(decimals - dp);
    abs = (abs + cut / 2n) / cut;
  } else {
    abs *= 10n ** BigInt(dp - decimals);
  }
  const digits = abs.toString().padStart(dp + 1, '0');
  const int = digits.slice(0, digits.length - dp);
  const frac = digits.slice(digits.length - dp).replace(/0+$/, '');
  return `${neg && abs !== 0n ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** Parses a plain decimal string ("1234.5") into an integer with `decimals` places; rejects excess precision. */
export function parseFixed(s: string, decimals: number): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`not a decimal number: ${JSON.stringify(s)}`);
  const frac = m[3] ?? '';
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimal places: ${s}`);
  const v = BigInt(m[2]! + frac.padEnd(decimals, '0'));
  return m[1] ? -v : v;
}

/** API money: USD 1e20 -> decimal string with at most 6 dp. */
export const usdString = (v: bigint) => formatFixed(v, USD_DECIMALS, 6);

/** Decimals of a unit price: GMTrade prices are USD * 10^(20 - token decimals). */
export const priceDecimals = (tokenDecimals: number) => USD_DECIMALS - tokenDecimals;

/** Unit price -> USD decimal string at `dp` places. */
export const priceString = (unitPrice: bigint, tokenDecimals: number, dp: number) =>
  formatFixed(unitPrice, priceDecimals(tokenDecimals), dp);

/** Approximate float for rates and percentages (never for money). */
export const toNumber = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;
