// Catalog rows from a real snapshot (test/fixtures/snapshot.json), offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { model, type MarketStatus, type ModelInput } from '@props/gmsol-wasm';
import {
  PriceBook, USDC_MINT, USD_UNIT, buildCatalog, categoryOf, displayDecimals, modelInput, pairOf, parseFixed, storeIdl, subcategoryOf, usdString, venueLimits,
  type CatalogInput, type FeedState, type KeeperMarket, type KeeperToken, type Pair,
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

const limits: CatalogInput['limits'] = () => ({ tradable: true, maxLeverage: 25, closedMaxLeverage: 8 });

/** A new position of `sizeUsd` (USD, 1e20 = $1) at `leverage`, as the venue's model executes it (throws its refusal). */
const opener = (input: ModelInput) => (isLong: boolean, sizeUsd: bigint, leverage = 1) => () => model.simulateIncrease({
  market: input, isLong, collateralToken: USDC_MINT, collateralAmount: (sizeUsd * 1_000_000n) / (USD_UNIT * BigInt(leverage)) + 1n, sizeDeltaUsd: sizeUsd,
});

function catalog(f = feed(), now = SOL_TICK_MS + 1_000, pairs = new Map<string, Pair>(), propsLimits = limits) {
  const errors: unknown[] = [];
  const rows = buildCatalog({
    feed: f, pairs, opens24h: new Map([['So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH', 120]]),
    limits: propsLimits, onError: (_m, e) => errors.push(e), now,
  });
  assert.deepEqual(errors, []);
  return Object.fromEntries(rows.map((r) => [r.symbol, r]));
}

test('one row per index asset with a pure USDC pool, which it trades on, with model stats', () => {
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

test('an asset without an enabled pure USDC pool is not listed (its other pools cannot be traded here); a market outside its session is', () => {
  const f = feed();
  f.markets.delete('6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc');
  assert.deepEqual(Object.keys(catalog(f)), ['NVDA'], 'SOL/USD[WSOL-USDC] alone lists nothing');
  const disabled = feed();
  const usdcPool = disabled.markets.get('6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc')!;
  disabled.markets.set(usdcPool.marketToken, { ...usdcPool, meta: { ...usdcPool.meta!, isEnabled: false } });
  assert.deepEqual(Object.keys(catalog(disabled)), ['NVDA'], 'nor does a USDC pool the venue disabled');
  // NVDA's Market account has the Closed flag set (captured outside US hours): that is its session, not a delisting.
  assert.deepEqual([catalog().NVDA!.session, catalog().NVDA!.tradable], ['closed', true]);
});

test('limits for a new position on the real SOL pool: the venue\'s own, per side, as its model enforces them, under the Props cap', () => {
  const f = feed();
  const uncapped = catalog(f, undefined, undefined, () => ({ tradable: true, maxLeverage: 10_000, closedMaxLeverage: null }));
  const { SOL, NVDA } = uncapped;
  const pool = f.markets.get('6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc')!;
  const input = modelInput(f, pool)!;
  const s = model.marketStatus(input);
  // min collateral factor 0.004 (250x): open interest × its multiplier (≈ $1.14M × 2.2e-10) is far below it here.
  assert.deepEqual([SOL!.maxLeverageLong, SOL!.maxLeverageShort, NVDA!.maxLeverageLong, NVDA!.maxLeverageShort], [250, 250, 50, 50]);
  // Sizes: the reserve headroom, below the $25M max open interest less the side's open interest. A short's is gmsol-sdk's
  // liquidity; a long's is that less the largest positive price impact it could get (here the whole impact pool, $275).
  assert.equal(SOL!.maxSizeShort, usdString(s.liquidityForShort));
  const longGap = s.liquidityForLong - parseFixed(SOL!.maxSizeLong!, 20);
  assert.ok(longGap > 0n && longGap < 1_000n * USD_UNIT, `a long's room is below the sdk's liquidity by the impact pool (${usdString(longGap)})`);
  assert.equal(SOL!.minCollateralUsd, '1');
  const open = opener(input);
  for (const [isLong, max] of [[true, SOL!.maxSizeLong!], [false, SOL!.maxSizeShort!]] as const) {
    const size = parseFixed(max, 20);
    assert.doesNotThrow(open(isLong, size), `${isLong ? 'long' : 'short'} of the max size`);
    assert.throws(open(isLong, (size * 1005n) / 1000n), /insufficient reserve/, `${isLong ? 'long' : 'short'} 0.5 % above it`);
  }
  assert.doesNotThrow(open(true, 1_000n * USD_UNIT, 225));
  assert.throws(open(true, 1_000n * USD_UNIT, 250), /insufficient collateral/, 'the factor binds before fees: 250x itself is refused');

  const capped = catalog(f);
  assert.deepEqual([capped.SOL!.maxLeverageLong, capped.SOL!.maxLeverageShort, capped.SOL!.maxLeverage], [25, 25, 25], 'the Props cap is lower');
  const noState = feed();
  noState.accounts.delete(pool.pubkey);
  const bare = catalog(noState).SOL!;
  assert.deepEqual([bare.maxLeverageLong, bare.maxLeverageShort, bare.maxSizeLong, bare.maxSizeShort, bare.minCollateralUsd], [25, 25, null, null, null], 'no pool state: the Props cap, sizes unknown');
});

test('near its max open interest a side takes that max less its open interest, even while longs are in profit', () => {
  const f = feed();
  const pool = f.markets.get('6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc')!;
  const s = model.marketStatus(modelInput(f, pool)!);
  // The venue checks max open interest against the side's open interest in USD. Longs here hold $1.138M, reserved at
  // $1.207M (their tokens at today's price): taking the reserve off the max open interest would leave no room at all.
  const image = Buffer.from(f.accounts.get(pool.pubkey)!.data, 'base64');
  for (const [side, oi] of [['long', s.openInterestForLong], ['short', s.openInterestForShort]] as const) {
    const at = storeIdl.offsetOf('Market', `config.max_open_interest_for_${side}`);
    const max = oi + 10_000n * USD_UNIT;
    image.writeBigUInt64LE(max & (2n ** 64n - 1n), at);
    image.writeBigUInt64LE(max >> 64n, at + 8);
  }
  f.accounts.set(pool.pubkey, { ...f.accounts.get(pool.pubkey)!, data: image.toString('base64') });
  const { SOL } = catalog(f);
  assert.deepEqual([SOL!.maxSizeLong, SOL!.maxSizeShort], ['10000', '10000']);
  const open = opener(modelInput(f, pool)!);
  for (const isLong of [true, false]) {
    assert.doesNotThrow(open(isLong, 10_000n * USD_UNIT), `a $10,000 ${isLong ? 'long' : 'short'}`);
    assert.throws(open(isLong, 10_100n * USD_UNIT), /max open interest exceeded/, `a $10,100 ${isLong ? 'long' : 'short'}`);
  }
});

test("a long's room is net of the positive price impact it can get: the venue reserves the long's tokens, which the impact adds to (live WLFI)", () => {
  const w = JSON.parse(readFileSync(new URL('fixtures/wlfi-long-impact.json', import.meta.url), 'utf8'));
  const image = Buffer.from(w.market, 'base64');
  for (const clock of ['price_impact_distribution', 'borrowing', 'funding']) { // a day ahead: no accrual, exact and repeatable
    image.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 86_400), storeIdl.offsetOf('Market', `state.clocks.${clock}`));
  }
  const price = (p: { min: string; max: string }) => ({ min: BigInt(p.min), max: BigInt(p.max) });
  const input = { market: image.toString('base64'), virtualInventories: w.virtualInventories, prices: { index: price(w.prices.index), long: price(w.prices.long), short: price(w.prices.short) } };
  const s = model.marketStatus(input);
  const { maxSizeLong, maxSizeShort } = venueLimits(input.market, s, input.prices.index);
  const room = parseFixed(maxSizeLong!, 20);
  const open = opener(input);
  assert.ok(open(true, room)().priceImpactValue > 0n, 'a long improves the balance here: its impact is positive');
  assert.throws(open(true, s.liquidityForLong), /insufficient reserve/, `gmsol-sdk's liquidity ($${usdString(s.liquidityForLong)}) is more than the venue takes`);
  assert.throws(open(true, (room * 101n) / 100n), /insufficient reserve/);
  assert.deepEqual([maxSizeLong, maxSizeShort], ['2025.453175', '0'], 'the room less 0.5 % (the max positive impact factor); no short room');
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
