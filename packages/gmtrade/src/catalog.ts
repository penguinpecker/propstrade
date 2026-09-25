// Turns live GMTrade state into api.ts `Market` rows: one per index asset with a pure USDC-USDC pool (55 of the 68
// assets of 93 enabled pools on 2026-09-25), with that pool's stats and limits from the gmsol-sdk model.
import type { DataFreshness, Market, MarketCategory, PriceTick, SessionState } from '@props/shared';
import { model, type MarketStatus, type ModelInput, type Price } from '@props/gmsol-wasm';
import { storeIdl, MarketFlag } from './accounts.ts';
import { NO_ACCOUNT, STALE_AFTER_MS, USDC_MINT } from './constants.ts';
import type { KeeperFeed, KeeperMarket, KeeperPrice, KeeperToken } from './keeper.ts';
import type { Pair } from './marketInfo.ts';
import { NAMES, SESSION_NOTES, categoryOf, displayDecimals, pairOf, subcategoryOf } from './metadata.ts';
import { USD_DECIMALS, USD_UNIT, priceDecimals, priceString, toNumber, usdString } from './units.ts';

export type FeedState = Pick<KeeperFeed, 'tokens' | 'markets' | 'accounts' | 'mode'>;

/** Props rules for an asset's preferred pool (from its MarketConfig, or the defaults). */
export interface PropsLimits {
  tradable: boolean;
  unavailableReason?: string;
  maxLeverage: number;
  closedMaxLeverage: number | null;
}

export interface CatalogInput {
  feed: FeedState;
  /** market-info rows by pool market token. */
  pairs: Map<string, Pair>;
  /** USD price 24 h ago by index token. */
  opens24h: Map<string, number>;
  limits(market: { symbol: string; category: MarketCategory; marketToken: string }): PropsLimits;
  /** A pool whose state the model rejects gets null stats; this reports why. */
  onError(marketToken: string, err: unknown): void;
  now: number;
}

const FLAGS_OFFSET = storeIdl.offsetOf('Market', 'flags');
const MIN_COLLATERAL_FACTOR_OFFSET = storeIdl.offsetOf('Market', 'config.min_collateral_factor');
const MIN_COLLATERAL_VALUE_OFFSET = storeIdl.offsetOf('Market', 'config.min_collateral_value');
const MAX_OPEN_INTEREST_OFFSET = {
  long: storeIdl.offsetOf('Market', 'config.max_open_interest_for_long'), short: storeIdl.offsetOf('Market', 'config.max_open_interest_for_short'),
};
const RESERVE_FACTOR_OFFSETS = [storeIdl.offsetOf('Market', 'config.reserve_factor'), storeIdl.offsetOf('Market', 'config.open_interest_reserve_factor')];
const MAX_POSITIVE_IMPACT_OFFSET = storeIdl.offsetOf('Market', 'config.max_positive_position_impact_factor');
const IMPACT_POOL_OFFSET = storeIdl.offsetOf('Market', 'state.pools.position_impact.pool.long_token_amount');
const LONG_TOKENS_OFFSETS = [
  storeIdl.offsetOf('Market', 'state.pools.open_interest_in_tokens_for_long.pool.long_token_amount'),
  storeIdl.offsetOf('Market', 'state.pools.open_interest_in_tokens_for_long.pool.short_token_amount'),
];

const isPureUsdc = (m: KeeperMarket) => m.meta!.isPure && m.meta!.longToken.pubkey === USDC_MINT;

const bigPrice = (p: KeeperPrice) => ({ min: BigInt(p.min), max: BigInt(p.max) });

/** Model input for a pool from the feed: raw accounts plus oracle prices; undefined until all are loaded. */
export function modelInput(feed: FeedState, market: KeeperMarket): ModelInput | undefined {
  const meta = market.meta;
  const account = feed.accounts.get(market.pubkey);
  if (!meta || !account) return undefined;
  const virtualInventories: Record<string, string> = {};
  for (const vi of [market.virtualInventoryForSwaps, market.virtualInventoryForPositions]) {
    if (vi === NO_ACCOUNT) continue;
    const data = feed.accounts.get(vi)?.data;
    if (!data) return undefined;
    virtualInventories[vi] = data;
  }
  const [index, long, short] = [meta.indexToken, meta.longToken, meta.shortToken].map((t) => feed.tokens.get(t.pubkey)?.price);
  if (!index || !long || !short) return undefined;
  return { market: account.data, virtualInventories, prices: { index: bigPrice(index), long: bigPrice(long), short: bigPrice(short) } };
}

/** The Market account's Closed flag, read from the first bytes of its base64 data. */
export function isMarketClosed(accountBase64: string): boolean {
  const head = Buffer.from(accountBase64.slice(0, 4 * Math.ceil((FLAGS_OFFSET + 1) / 3)), 'base64');
  return ((head[FLAGS_OFFSET]! >> MarketFlag.Closed) & 1) === 1;
}

/** A u128 field of a Market account image (factors 1e20 = 100 %, USD 1e20 = $1). */
const u128 = (b: Buffer, at: number) => b.readBigUInt64LE(at) | (b.readBigUInt64LE(at + 8) << 64n);

function venueMaxLeverage(accountBase64: string): number {
  const factor = u128(Buffer.from(accountBase64, 'base64'), MIN_COLLATERAL_FACTOR_OFFSET);
  return factor > 0n ? Number(USD_UNIT / factor) : 0;
}

/** What the venue accepts for a new position on each side of a pool right now. */
export interface VenueLimits {
  maxLeverageLong: number; maxLeverageShort: number;
  /** USD, null without the model's status of the pool. */
  maxSizeLong: string | null; maxSizeShort: string | null;
  /** USD, null when the market sets no minimum. */
  minCollateralUsd: string | null;
}

/**
 * The venue's limits for a new position, as its model computes them (gmsol-sdk MarketStatus, the store's checks on an
 * increase): leverage = 1 / the side's min collateral factor (the config's, or the open-interest multiplier × the
 * side's open interest when that is higher), whole, Infinity for a factor of 0; min collateral = the config's min
 * collateral value. Size = the lower of two headrooms, each as the store checks it after the increase:
 *   - reserve: the side's pool value × the lower of the reserve and open interest reserve factors, less what the side
 *     reserves: shorts their open interest in USD; longs their open interest in tokens at the index max price, so a
 *     long reserves its size plus its positive price impact (which buys it more tokens). That impact is at most
 *     max_positive_position_impact_factor of the size and at most the position impact pool (at the index min price),
 *     so a long's room is the reserve headroom less the largest impact it could get;
 *   - max open interest: the config's, less the side's open interest in USD.
 * (gmsol-sdk's own liquidity is neither: it takes the reserved value off the max open interest too, and ignores impact.)
 * Without a status (the model has no state for the pool) or an index price, leverage comes from the config factor alone
 * and sizes are unknown.
 */
export function venueLimits(accountBase64: string, s: MarketStatus | null, index: Price | null): VenueLimits {
  const b = Buffer.from(accountBase64, 'base64');
  const leverage = (factor: bigint) => (factor > 0n ? Number(USD_UNIT / factor) : Infinity);
  const [reserveFactor, oiReserveFactor] = RESERVE_FACTOR_OFFSETS.map((at) => u128(b, at)) as [bigint, bigint];
  const maxReserve = (poolValue: bigint) => (poolValue * (reserveFactor < oiReserveFactor ? reserveFactor : oiReserveFactor)) / USD_UNIT;
  const size = (side: 'long' | 'short', reserveRoom: bigint, openInterest: bigint) => {
    const oiRoom = u128(b, MAX_OPEN_INTEREST_OFFSET[side]) - openInterest;
    const max = reserveRoom < oiRoom ? reserveRoom : oiRoom;
    return usdString(max > 0n ? max : 0n);
  };
  const base = u128(b, MIN_COLLATERAL_FACTOR_OFFSET);
  const minCollateral = u128(b, MIN_COLLATERAL_VALUE_OFFSET);
  const known = s !== null && index !== null;
  let longRoom = 0n;
  if (known) {
    const headroom = maxReserve(s.poolValueForLong) - LONG_TOKENS_OFFSETS.reduce((sum, at) => sum + u128(b, at), 0n) * index.max;
    // The largest size whose impact still fits: headroom / (1 + max factor) while the factor caps the impact, else
    // headroom less the whole impact pool.
    const byFactor = (headroom * USD_UNIT) / (USD_UNIT + u128(b, MAX_POSITIVE_IMPACT_OFFSET));
    const byPool = headroom - u128(b, IMPACT_POOL_OFFSET) * index.min;
    longRoom = byFactor > byPool ? byFactor : byPool;
  }
  return {
    maxLeverageLong: leverage(s ? s.minCollateralFactorForLong : base),
    maxLeverageShort: leverage(s ? s.minCollateralFactorForShort : base),
    maxSizeLong: known ? size('long', longRoom, s.openInterestForLong) : null,
    maxSizeShort: known ? size('short', maxReserve(s.poolValueForShort) - s.openInterestForShort, s.openInterestForShort) : null,
    minCollateralUsd: minCollateral > 0n ? usdString(minCollateral) : null,
  };
}

export function sessionOf(price: KeeperPrice | null | undefined, closedFlag: boolean): SessionState {
  if (!price) return 'unknown';
  return price.isOpen && !closedFlag ? 'open' : 'closed';
}

export function freshnessOf(price: KeeperPrice | null | undefined, mode: FeedState['mode'], now: number): DataFreshness {
  if (!price) return 'unavailable';
  if (price.isOpen && now - price.ts * 1000 > STALE_AFTER_MS) return 'stale';
  return mode === 'poll' ? 'delayed' : 'live';
}

/** A price tick in API form for an index token. */
export function priceTick(symbol: string, token: KeeperToken, session: SessionState): PriceTick | undefined {
  if (!token.price || !token.meta) return undefined;
  const { decimals, precision } = token.meta;
  const min = BigInt(token.price.min);
  const max = BigInt(token.price.max);
  return {
    symbol,
    min: priceString(min, decimals, precision),
    max: priceString(max, decimals, precision),
    mid: priceString((min + max) / 2n, decimals, precision),
    ts: token.price.ts * 1000,
    session,
  };
}

const perHourPct = (perSecond: bigint) => toNumber(perSecond * 3600n * 100n, USD_DECIMALS);

export function buildCatalog({ feed, pairs, opens24h, limits, onError, now }: CatalogInput): Market[] {
  const status = (market: KeeperMarket): MarketStatus | null => {
    const input = modelInput(feed, market);
    try {
      return input ? model.marketStatus(input) : null;
    } catch (err) {
      onError(market.marketToken, err);
      return null;
    }
  };

  const byIndex = new Map<string, KeeperMarket[]>();
  for (const m of feed.markets.values()) {
    if (!m.meta?.isEnabled) continue;
    const list = byIndex.get(m.meta.indexToken.pubkey) ?? [];
    list.push(m);
    byIndex.set(m.meta.indexToken.pubkey, list);
  }

  const rows: Market[] = [];
  for (const [indexToken, pools] of byIndex) {
    const token = feed.tokens.get(indexToken);
    if (!token?.meta) continue;
    const symbol = token.meta.name;
    const category = categoryOf(token.meta.category);

    // Props.trade trades only pure USDC-USDC pools (collateral in and out is USDC): an asset without one could never be
    // traded here, so it is not listed. (A pool the venue disabled is left out above; one whose Closed flag is set is
    // only outside its trading session, which `session` shows.)
    const preferred = pools.find(isPureUsdc);
    if (!preferred) continue;
    const s = status(preferred);
    const account = feed.accounts.get(preferred.pubkey)?.data;
    const closedFlag = account ? isMarketClosed(account) : false;
    const props = limits({ symbol, category, marketToken: preferred.marketToken });
    const venue = account ? venueLimits(account, s, token.price ? bigPrice(token.price) : null) : null;

    const price = token.price;
    const session = sessionOf(price, closedFlag);
    const tick = priceTick(symbol, token, session);
    const open24h = opens24h.get(indexToken);
    const mid = price ? toNumber((BigInt(price.min) + BigInt(price.max)) / 2n, priceDecimals(token.meta.decimals)) : null;
    // The asset's 24 h volume across all its pools; OI, rates, capacity and liquidity are the preferred pool's.
    const volumes = pools.flatMap((p) => pairs.get(p.marketToken)?.target_volume ?? []);

    rows.push({
      symbol,
      pair: pairOf(symbol, token.meta.indexName),
      name: NAMES[symbol] ?? token.meta.uiName ?? symbol,
      category,
      subcategory: subcategoryOf(symbol, category, token.meta.category),
      marketToken: preferred.marketToken,
      pools: pools.map((p) => ({
        marketToken: p.marketToken, name: p.meta!.name, pure: p.meta!.isPure, longToken: p.meta!.longToken.pubkey, shortToken: p.meta!.shortToken.pubkey,
      })),
      tradable: props.tradable,
      ...(props.unavailableReason ? { unavailableReason: props.unavailableReason } : {}),
      price: tick?.mid ?? null,
      priceDecimals: displayDecimals(symbol, category, token.meta.precision),
      indexTokenDecimals: token.meta.decimals,
      change24h: mid !== null && open24h ? ((mid - open24h) / open24h) * 100 : null,
      volume24h: volumes.length ? volumes.reduce((a, v) => a + v, 0).toFixed(2) : null,
      openInterestLong: s ? usdString(s.openInterestForLong) : null,
      openInterestShort: s ? usdString(s.openInterestForShort) : null,
      fundingRateHourlyLong: s ? perHourPct(s.fundingRatePerSecondForLong) : null,
      fundingRateHourlyShort: s ? perHourPct(s.fundingRatePerSecondForShort) : null,
      borrowRateHourlyLong: s ? perHourPct(s.borrowingRatePerSecondForLong) : null,
      borrowRateHourlyShort: s ? perHourPct(s.borrowingRatePerSecondForShort) : null,
      capacityLong: s ? usdString(s.liquidityForLong) : null,
      capacityShort: s ? usdString(s.liquidityForShort) : null,
      poolLiquidity: s ? usdString(s.poolValueForLong + s.poolValueForShort) : null,
      maxLeverage: account ? Math.min(venueMaxLeverage(account), props.maxLeverage) : props.maxLeverage,
      closedMaxLeverage: props.closedMaxLeverage,
      maxLeverageLong: Math.min(venue?.maxLeverageLong ?? Infinity, props.maxLeverage),
      maxLeverageShort: Math.min(venue?.maxLeverageShort ?? Infinity, props.maxLeverage),
      maxSizeLong: venue?.maxSizeLong ?? null,
      maxSizeShort: venue?.maxSizeShort ?? null,
      minCollateralUsd: venue?.minCollateralUsd ?? null,
      session,
      ...(SESSION_NOTES[category] ? { sessionNote: SESSION_NOTES[category] } : {}),
      freshness: freshnessOf(price, feed.mode, now),
      updatedAt: price ? price.ts * 1000 : null,
    });
  }
  return rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
