// Turns live GMTrade state into api.ts `Market` rows: one per index asset (68 on 2026-09-23, from
// 93 enabled pools), preferring the pure USDC-USDC pool, with pool stats from the gmsol-sdk model.
import type { DataFreshness, Market, MarketCategory, PriceTick, SessionState } from '@props/shared';
import { model, type MarketStatus, type ModelInput } from '@props/gmsol-wasm';
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
  limits(market: { symbol: string; category: MarketCategory; marketToken: string; pureUsdc: boolean }): PropsLimits;
  /** A pool whose state the model rejects gets null stats; this reports why. */
  onError(marketToken: string, err: unknown): void;
  now: number;
}

const FLAGS_OFFSET = storeIdl.offsetOf('Market', 'flags');
const MIN_COLLATERAL_FACTOR_OFFSET = storeIdl.offsetOf('Market', 'config.min_collateral_factor');

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

function venueMaxLeverage(accountBase64: string): number {
  const b = Buffer.from(accountBase64, 'base64');
  const factor = b.readBigUInt64LE(MIN_COLLATERAL_FACTOR_OFFSET) | (b.readBigUInt64LE(MIN_COLLATERAL_FACTOR_OFFSET + 8) << 64n);
  return factor > 0n ? Number(USD_UNIT / factor) : 0;
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

    // Without a pure USDC pool, prefer the pool with the most LP value.
    let preferred = pools.find(isPureUsdc);
    let s: MarketStatus | null = null;
    if (preferred) {
      s = status(preferred);
    } else {
      let best = -1n;
      for (const p of pools) {
        const ps = status(p);
        const value = ps ? ps.poolValueForLong + ps.poolValueForShort : -1n;
        if (!preferred || value > best) [preferred, s, best] = [p, ps, value];
      }
    }
    preferred = preferred!;
    const account = feed.accounts.get(preferred.pubkey)?.data;
    const closedFlag = account ? isMarketClosed(account) : false;
    const props = limits({ symbol, category, marketToken: preferred.marketToken, pureUsdc: isPureUsdc(preferred) });

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
      borrowRateHourlyLong: s ? perHourPct(s.borrowingRatePerSecondForLong) : null,
      borrowRateHourlyShort: s ? perHourPct(s.borrowingRatePerSecondForShort) : null,
      capacityLong: s ? usdString(s.liquidityForLong) : null,
      capacityShort: s ? usdString(s.liquidityForShort) : null,
      poolLiquidity: s ? usdString(s.poolValueForLong + s.poolValueForShort) : null,
      maxLeverage: account ? Math.min(venueMaxLeverage(account), props.maxLeverage) : props.maxLeverage,
      closedMaxLeverage: props.closedMaxLeverage,
      session,
      ...(SESSION_NOTES[category] ? { sessionNote: SESSION_NOTES[category] } : {}),
      freshness: freshnessOf(price, feed.mode, now),
      updatedAt: price ? price.ts * 1000 : null,
    });
  }
  return rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
