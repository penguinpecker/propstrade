// Catalog rows from a real snapshot (test/fixtures/snapshot.json), offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { model, type MarketStatus } from '@props/gmsol-wasm';
import {
  PriceBook, USD_UNIT, buildCatalog, categoryOf, displayDecimals, pairOf, subcategoryOf, type CatalogInput, type FeedState, type KeeperMarket,
  type KeeperToken, type Pair, type PropsLimits,
} from '../src/index.ts';

const snapshot = JSON.parse(readFileSync(new URL('fixtures/snapshot.json', import.meta.url), 'utf8'));
const SOL_TICK_MS = 1_790_115_741_000;

function feed(overrides: Partial<FeedState> = {}): FeedState {
  const accounts = new Map<string, { data: string; slot: number }>();
  for (const m of snapshot.markets) accounts.set(m.pubkey, { data: m.data, slot: m.slot });
  for (const v of snapshot.virtualInventories) accounts.set(v.pubkey, { data: v.data, slot: Number(v.slot) });
  return {
    tokens: new Map(snapshot.tokens.map((t: KeeperToken) => [t.pubkey, t])),
    markets: new Map(snapshot.markets.map((m: KeeperMarket) => [m.marketToken, { ...m, data: null }])),
    accounts,
    mode: 'ws',
    ...overrides,
  };
}

const limits: CatalogInput['limits'] = ({ pureUsdc }): PropsLimits =>
  pureUsdc ? { tradable: true, maxLeverage: 25, closedMaxLeverage: 8 } : { tradable: false, unavailableReason: 'no USDC pool', maxLeverage: 25, closedMaxLeverage: null };

function catalog(f = feed(), now = SOL_TICK_MS + 1_000, pairs = new Map<string, Pair>()) {
  const errors: unknown[] = [];
  const rows = buildCatalog({
    feed: f, pairs, opens24h: new Map([['So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH', 120]]),
    limits, onError: (_m, e) => errors.push(e), now,
  });
  assert.deepEqual(errors, []);
  return Object.fromEntries(rows.map((r) => [r.symbol, r]));
}

test('one row per index asset, preferring the pure USDC pool, with model stats', () => {
  const { SOL, NVDA } = catalog();
  assert.equal(SOL!.marketToken, '6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc');
  assert.equal(SOL!.pools.length, 2);
  assert.deepEqual([SOL!.pair, SOL!.name, SOL!.category, SOL!.subcategory], ['SOL / USD', 'Solana', 'Crypto', 'Layer 1 & 2']);
  assert.equal(SOL!.price, '118.13082');
  assert.equal(SOL!.priceDecimals, 5);
  assert.equal(SOL!.indexTokenDecimals, 9);
  assert.equal(SOL!.change24h!.toFixed(4), ((118.13082 / 120 - 1) * 100).toFixed(4));
  assert.ok(Math.abs(Number(SOL!.openInterestLong) - 1_137_971) < 2); // research: OI long=$1137971
  // research: shorts paid 6.2473491685e-9 /s borrowing, longs nothing
  assert.equal(SOL!.borrowRateHourlyShort!.toFixed(6), (6.2473491685e-9 * 3600 * 100).toFixed(6));
  assert.equal(SOL!.borrowRateHourlyLong, 0);
  assert.ok(Number(SOL!.capacityLong) > 0 && Number(SOL!.poolLiquidity) > 1_100_000);
  assert.equal(SOL!.maxLeverage, 25); // venue 250x, Props 25x
  assert.deepEqual([SOL!.session, SOL!.freshness, SOL!.tradable], ['open', 'live', true]);
  assert.equal(SOL!.sessionNote, undefined);

  assert.deepEqual([NVDA!.category, NVDA!.subcategory, NVDA!.name, NVDA!.session], ['Stocks', 'Companies', 'NVIDIA', 'closed']);
  assert.deepEqual([NVDA!.price, NVDA!.priceDecimals], ['228.82', 2]); // keeper precision 6
  assert.equal(NVDA!.sessionNote, 'US regular market hours, Mon–Fri 9:30–16:00 New York time');
  assert.equal(NVDA!.volume24h, null);
});

test('freshness: stale only for open markets, delayed while polling, unavailable without a price', () => {
  const later = catalog(feed(), SOL_TICK_MS + 21_000);
  assert.equal(later.SOL!.freshness, 'stale');
  assert.equal(later.NVDA!.freshness, 'live'); // closed market: its last price is the current price
  assert.equal(catalog(feed({ mode: 'poll' })).SOL!.freshness, 'delayed');

  const noPrice = feed();
  noPrice.tokens.set('So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH', { ...noPrice.tokens.get('So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH')!, price: null });
  const { SOL } = catalog(noPrice);
  assert.deepEqual([SOL!.freshness, SOL!.price, SOL!.session, SOL!.openInterestLong], ['unavailable', null, 'unknown', null]);
});

test('an asset without a pure USDC pool falls back to its pool with the most LP value', () => {
  const f = feed();
  f.markets.delete('6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc');
  const { SOL } = catalog(f);
  assert.equal(SOL!.marketToken, 'BwN2FWixP5JyKjJNyD1YcRKN1XhgvFtnzrPrkfyb4DkW');
  assert.equal(SOL!.tradable, false);
  assert.equal(SOL!.unavailableReason, 'no USDC pool');
  assert.ok(Number(SOL!.poolLiquidity) > 0);
});

test('24h volume sums every pool of the asset in market-info', () => {
  const pair = (poolId: string, volume: number) => [poolId, { pool_id: poolId, target_volume: volume } as Pair] as const;
  const usdcPool = pair('6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc', 1_000.25);
  const wsolPool = pair('BwN2FWixP5JyKjJNyD1YcRKN1XhgvFtnzrPrkfyb4DkW', 9_000.5);
  assert.equal(catalog(feed(), undefined, new Map([usdcPool, wsolPool])).SOL!.volume24h, '10000.75');
  assert.equal(catalog(feed(), undefined, new Map([wsolPool])).SOL!.volume24h, '9000.50', 'the preferred pool may have no row');
  assert.equal(catalog(feed(), undefined, new Map([usdcPool])).NVDA!.volume24h, null);
});

test('display metadata', () => {
  assert.equal(pairOf('USDJPY', 'USD/JPY'), 'USD / JPY');
  assert.equal(pairOf('EUR', 'EUR/USD'), 'EUR / USD');
  assert.equal(pairOf('NEW', null), 'NEW / USD');
  assert.deepEqual(['Commodity', 'Forex', 'Stock', 'Layer1&2', 'Meme', 'DeFi', 'Other', null].map(categoryOf),
    ['Commodities', 'Forex', 'Stocks', 'Crypto', 'Crypto', 'Crypto', 'Crypto', 'Crypto']);
  // [symbol, Props category, GMTrade category, sub-category]: crypto keeps GMTrade's grouping, the rest is curated by symbol.
  for (const [symbol, category, gm, sub] of [
    ['SOL', 'Crypto', 'Layer1&2', 'Layer 1 & 2'], ['HYPE', 'Crypto', 'DeFi', 'DeFi'], ['BONK', 'Crypto', 'Meme', 'Meme'],
    ['TAO', 'Crypto', 'Other', 'Other'], ['NEW', 'Crypto', 'AI', 'AI'], ['NEW', 'Crypto', null, 'Other'],
    ['XAU', 'Commodities', 'Commodity', 'Metals'], ['XCU', 'Commodities', 'Commodity', 'Metals'], ['WTI', 'Commodities', 'Commodity', 'Energy'],
    ['EUR', 'Forex', 'Forex', 'Majors'], ['USDJPY', 'Forex', 'Forex', 'Majors'], ['USDMXN', 'Forex', 'Forex', 'Emerging'],
    ['SPY', 'Stocks', 'Stock', 'Index ETFs'], ['QQQ', 'Stocks', 'Stock', 'Index ETFs'], ['NVDA', 'Stocks', 'Stock', 'Companies'],
    ['CORN', 'Commodities', 'Commodity', 'Other'], ['USDSEK', 'Forex', 'Forex', 'Other'], ['IWM', 'Stocks', 'Stock', 'Other'],
  ] as const) assert.equal(subcategoryOf(symbol, category, gm), sub, `${symbol} (${gm})`);
  // [symbol, category, keeper precision, display decimals] as seen live on 2026-09-23
  for (const [symbol, category, precision, dp] of [
    ['NVDA', 'Stocks', 6, 2], ['XAU', 'Commodities', 4, 2], ['WTI', 'Commodities', 5, 2], ['XCU', 'Commodities', 6, 4],
    ['EUR', 'Forex', 7, 7], ['SOL', 'Crypto', 5, 5], ['BONK', 'Crypto', 10, 10],
  ] as const) assert.equal(displayDecimals(symbol, category, precision), dp, symbol);
});

test('price book keeps timestamps monotonic per token', () => {
  const book = new PriceBook();
  const p = (ts: number, min = '1') => ({ ts, min, max: min, isOpen: true });
  assert.equal(book.accept('A', p(10)), true);
  assert.equal(book.accept('A', p(9, '2')), false, 'older tick dropped');
  assert.equal(book.accept('A', p(10)), false, 'exact duplicate dropped');
  assert.equal(book.accept('A', p(10, '3')), true, 'same second, new price');
  assert.equal(book.accept('B', p(1)), true, 'tokens are independent');
  assert.equal(book.accept('A', p(10, '3')), false, 'the newest accepted tick is the reference');
});

test('rates: the paying side pays the funding factor, the other side receives it scaled by the OI ratio; borrowing falls on the larger side', () => {
  const { SOL, NVDA } = catalog();
  // research: SOL shorts held more OI ($1,153,947 vs $1,137,971), so shorts pay funding and longs receive it
  assert.ok(SOL!.fundingRateHourlyShort! > 0 && SOL!.fundingRateHourlyLong! < 0, `SOL ${SOL!.fundingRateHourlyLong} / ${SOL!.fundingRateHourlyShort}`);
  const solRatio = Number(SOL!.openInterestShort) / Number(SOL!.openInterestLong);
  assert.ok(Math.abs(-SOL!.fundingRateHourlyLong! / SOL!.fundingRateHourlyShort! - solRatio) < 1e-4, `|long| = short × OI_short/OI_long (${solRatio})`);
  assert.notEqual(SOL!.fundingRateHourlyShort, -SOL!.fundingRateHourlyLong!, 'the short rate is not the negative of the long one');
  // NVDA the other way round: longs held $561 against $235
  assert.ok(NVDA!.fundingRateHourlyLong! > 0 && NVDA!.fundingRateHourlyShort! < 0);
  const nvdaRatio = Number(NVDA!.openInterestLong) / Number(NVDA!.openInterestShort);
  assert.ok(Math.abs(-NVDA!.fundingRateHourlyShort! / NVDA!.fundingRateHourlyLong! - nvdaRatio) < 1e-4, `|short| = long × OI_long/OI_short (${nvdaRatio})`);
  // Borrowing: SOL's smaller side (longs) is waived, the larger pays; NVDA's pool charges both sides.
  assert.deepEqual([SOL!.borrowRateHourlyLong, SOL!.borrowRateHourlyShort! > 0], [0, true]);
  assert.ok(NVDA!.borrowRateHourlyLong! > 0 && NVDA!.borrowRateHourlyShort! > 0);
});

test('rates: percent per hour from the model\'s per-second factors (1e20 = 100 %), each side with its sign', (t) => {
  const status: MarketStatus = {
    fundingRatePerSecondForLong: 10n ** 12n, fundingRatePerSecondForShort: -3n * 10n ** 12n,
    borrowingRatePerSecondForLong: 0n, borrowingRatePerSecondForShort: 2n * 10n ** 12n,
    openInterestForLong: 3n * USD_UNIT, openInterestForShort: USD_UNIT, liquidityForLong: USD_UNIT, liquidityForShort: USD_UNIT,
    poolValueForLong: USD_UNIT, poolValueForShort: USD_UNIT, minCollateralFactorForLong: 0n, minCollateralFactorForShort: 0n,
  };
  t.mock.method(model, 'marketStatus', () => status);
  const { SOL } = catalog();
  assert.deepEqual(
    [SOL!.fundingRateHourlyLong, SOL!.fundingRateHourlyShort, SOL!.borrowRateHourlyLong, SOL!.borrowRateHourlyShort],
    [0.0036, -0.0108, 0, 0.0072], // 1e12 /s × 3600 × 100 / 1e20
  );
  assert.deepEqual([SOL!.openInterestLong, SOL!.openInterestShort], ['3', '1']);
});
