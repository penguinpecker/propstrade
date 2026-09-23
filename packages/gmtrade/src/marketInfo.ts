import { MARKET_INFO } from './constants.ts';

/** One pool row of GMTrade's market-info API (24 h window). */
export interface Pair {
  ticker_id: string;
  /** Market token of the pool. */
  pool_id: string;
  base_currency: string;
  last_price: number;
  high: number;
  low: number;
  /** 24 h volume in USD. */
  target_volume: number;
  base_volume: number;
  /** Spare open-interest capacity in USD, NOT LP deposits. */
  liquidity_in_usd: number;
  open_interest: number;
  long_open_interest: number;
  short_open_interest: number;
  /** Funding factor per second. */
  funding_rate: number;
}

export async function fetchPairs(url = MARKET_INFO, timeoutMs = 15_000): Promise<Pair[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const pairs = (await res.json()) as unknown;
  if (!Array.isArray(pairs)) throw new Error(`${url}: expected an array`);
  return pairs as Pair[];
}
