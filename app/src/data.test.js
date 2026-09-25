import { describe, expect, it } from 'vitest';
import { RATES_TITLE, WATCHLIST_MAX, compactUsd, freshnessLabel, isCurrent, isSolanaAddress, marginFor, marketPrice, percent, pickMarkets, rates, signedUsd, stageRestriction, tierRules, toggleWatchlist, usd, usdBase, validWatchlist } from './data.js';

describe('formatters', () => {
  it('show a dash for values the API reports as unavailable', () => {
    for (const format of [usd, signedUsd, compactUsd, percent]) expect(format(null)).toBe('—');
    expect([usd('1234.5'), signedUsd('-49.86'), signedUsd('0'), compactUsd('142600000'), percent(2.481)]).toEqual(['$1,234.50', '−$49.86', '+$0.00', '$142.6M', '+2.48%']);
  });
});

describe('rates', () => {
  it('shows both sides per hour, funding signed and borrowing unsigned, with the reading guide as the title', () => {
    expect(rates({ fundingRateHourlyLong: 0.0012, fundingRateHourlyShort: -0.0009, borrowRateHourlyLong: 0.0008, borrowRateHourlyShort: 0 }))
      .toEqual({ funding: '+0.0012% / -0.0009%', borrow: '0.0008% / 0.0000%', title: RATES_TITLE });
  });
  it('dashes a side the server does not give (a catalog from before the short funding rate) and unavailable rates', () => {
    expect(rates({ fundingRateHourlyLong: 0.0012, borrowRateHourlyLong: null, borrowRateHourlyShort: 0.0001 })).toMatchObject({ funding: '+0.0012% / —', borrow: '— / 0.0001%' });
  });
});

describe('isSolanaAddress', () => {
  it('accepts base58 keys of 32 to 44 characters and nothing else', () => {
    expect(isSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
    expect(isSolanaAddress('1'.repeat(32))).toBe(true);
    for (const bad of ['', 'PT-002841', '0'.repeat(32), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1vX', ' EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '1'.repeat(31)]) expect(isSolanaAddress(bad)).toBe(false);
  });
});

describe('tierRules', () => {
  it('derives the pinned rules of a tier', () => {
    expect(tierRules({ sizeUsd: '25000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000, termsHash: 'h', version: 3 }))
      .toEqual({ sizeUsd: '25000', lossAllowanceUsd: '1250', floorUsd: '23750', profitTargetUsd: '2000', maxExposureUsd: '25000', traderShareBps: 8000, termsHash: 'h', version: 3 });
  });
});

describe('isCurrent', () => {
  const evaluation = { id: 'e1', stage: 'evaluation', status: 'passed', evidence: {} };
  it('keeps a passed evaluation current until a funded account is activated from it', () => {
    expect(isCurrent(evaluation, [evaluation])).toBe(true);
    expect(isCurrent(evaluation, [evaluation, { stage: 'funded', status: 'active', evidence: { evaluation: 'e1' } }])).toBe(false);
  });
  it('moves ended accounts to the past', () => {
    for (const status of ['breached', 'failed', 'closed']) expect(isCurrent({ ...evaluation, status }, [])).toBe(false);
  });
});

describe('usdBase', () => {
  it('names the base asset only for pairs quoted in USD', () => {
    expect(usdBase({ pair: 'BTC / USD' })).toBe('BTC');
    expect(usdBase({ pair: 'USD / JPY' })).toBeNull();
  });
});

describe('marketPrice', () => {
  it('prefixes $ only for pairs quoted in USD', () => {
    expect(marketPrice('64482', { pair: 'BTC / USD', priceDecimals: 2 })).toBe('$64,482.00');
    expect(marketPrice('147.214', { pair: 'USD / JPY', priceDecimals: 3 })).toBe('147.214');
    expect(marketPrice(null, { pair: 'BTC / USD', priceDecimals: 2 })).toBe('—');
  });
});

describe('freshnessLabel', () => {
  it('names every state but live', () => {
    expect(['live', 'delayed', 'stale', 'unavailable'].map(freshness => freshnessLabel({ freshness }))).toEqual([null, 'Delayed', 'Stale', 'Unavailable']);
  });
});

describe('marginFor', () => {
  it('rounds up to the micro-USD so size ÷ margin stays within the leverage, without float noise', () => {
    expect([marginFor(1001, 15), marginFor(1000.5, 5), marginFor(1000, 10)]).toEqual(['66.733334', '200.100000', '100.000000']);
    expect(1001 / Number(marginFor(1001, 15))).toBeLessThanOrEqual(15);
  });
});

describe('stageRestriction', () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const market = (symbol, tradable, pool) => ({ symbol, tradable, marketToken: 'm', pools: [{ marketToken: 'm', ...pool }], ...(tradable ? {} : { unavailableReason: 'Not available for funded trading' }) });
  const usdcPool = { pure: true, longToken: USDC, shortToken: USDC };
  const doge = market('DOGE', false, usdcPool);
  const aave = market('AAVE', false, { pure: false, longToken: 'aave', shortToken: USDC });
  const btc = market('BTC', true, usdcPool);

  it('lets each stage trade what its engine or program accepts, with copy for that stage', () => {
    expect([btc, doge, aave].map(m => stageRestriction(m, 'funded', USDC)?.label ?? null)).toEqual([null, 'Not available for funded trading', 'Not available for funded trading']);
    expect(stageRestriction(doge, 'evaluation', USDC)).toEqual({ label: 'Not available in evaluations', reason: 'DOGE is not available in evaluations: they trade only the markets funded accounts can.' });
    expect(stageRestriction(btc, 'evaluation', USDC)).toBeNull();
    expect(stageRestriction(doge, 'practice', USDC)).toBeNull();
    expect(stageRestriction(aave, 'practice', USDC)).toEqual({ label: 'Not available in practice', reason: 'AAVE has no USDC-only pool, so it cannot be traded here.' });
  });
});

describe('watchlist', () => {
  const full = Array.from({ length: WATCHLIST_MAX }, (_, i) => `M${i}`);
  it('reads only symbol-shaped strings from storage, each once, capped; anything but a list is the fallback', () => {
    expect(validWatchlist(['BTC', 'BTC', 'btc', 1, null, 'X'.repeat(17), 'BAD SYM', {}, ['SOL']], ['ETH'])).toEqual(['BTC', 'btc']);
    expect(validWatchlist([...full, 'ONE MORE', 'M99'], [])).toEqual(full);
    for (const junk of ['BTC', { 0: 'BTC' }, 12, null]) expect(validWatchlist(junk, ['ETH'])).toEqual(['ETH']);
  });
  it('adds a symbol last, removes one, and leaves a full watchlist as it is', () => {
    expect(toggleWatchlist(['BTC'], 'ETH')).toEqual(['BTC', 'ETH']);
    expect(toggleWatchlist(['BTC', 'ETH'], 'BTC')).toEqual(['ETH']);
    expect(toggleWatchlist(full, 'ETH')).toBe(full);
    expect(toggleWatchlist(full, 'M0')).toEqual(full.slice(1));
  });
});

describe('pickMarkets', () => {
  const markets = [['BTC', 'Bitcoin', 'Crypto', 'Layer 1 & 2'], ['SOL', 'Solana', 'Crypto', 'Layer 1 & 2'], ['TAO', 'Bittensor', 'Crypto', 'Other'],
    ['BONK', 'Bonk', 'Crypto', 'Meme'], ['PEPE', 'Pepe', 'Crypto', 'Meme'], ['HYPE', 'Hyperliquid', 'Crypto', 'DeFi'], ['XAU', 'Gold', 'Commodities', 'Metals'],
    ['SPY', 'SPDR S&P 500 ETF', 'Stocks', 'Index ETFs'], ['NVDA', 'NVIDIA', 'Stocks', 'Companies']]
    .map(([symbol, name, category, subcategory]) => ({ symbol, pair: `${symbol} / USD`, name, category, subcategory }));
  const pick = (tab, subcategory = null, search = '') => pickMarkets(markets, ['BTC', 'XAU', 'DELISTED'], { tab, subcategory, search });
  const symbols = result => result.rows.map(m => m.symbol);

  it('counts every tab, watchlist symbols only while they are listed', () => {
    expect(pick('All').counts).toEqual({ All: 9, Watchlist: 2, Crypto: 6, Commodities: 1, Forex: 0, Stocks: 2 });
  });
  it('filters by tab and sub-category, and lists sub-categories largest first with Other last', () => {
    expect(symbols(pick('Watchlist'))).toEqual(['BTC', 'XAU']);
    expect(pick('Crypto').subcategories).toEqual([['Layer 1 & 2', 2], ['Meme', 2], ['DeFi', 1], ['Other', 1]]);
    expect(symbols(pick('Crypto', 'Meme'))).toEqual(['BONK', 'PEPE']);
    expect(pick('Stocks').subcategories).toEqual([['Companies', 1], ['Index ETFs', 1]]);
    for (const tab of ['All', 'Watchlist']) expect(pick(tab).subcategories).toEqual([]);
    expect(pick('Forex')).toMatchObject({ rows: [], subcategories: [] });
  });
  it('shows the whole tab once the chosen sub-category has no markets left (a refetch can remove them)', () => {
    expect(pick('Crypto', 'Meme').subcategory).toBe('Meme');
    expect(pick('Commodities', 'Energy')).toMatchObject({ subcategory: null, rows: [markets[6]] });
  });
  it('searches within the selection, and counts matches anywhere for the empty state', () => {
    expect(symbols(pick('Crypto', null, 'meme'))).toEqual(['BONK', 'PEPE']);
    expect(symbols(pick('Stocks', null, 'etf'))).toEqual(['SPY']);
    expect(pick('Crypto', 'Meme', 'BTC')).toMatchObject({ rows: [], matchesAnywhere: 1 });
    expect(pick('Stocks', 'Companies', 'gold')).toMatchObject({ rows: [], matchesAnywhere: 1 });
    expect(pick('All', null, 'nothing')).toMatchObject({ rows: [], matchesAnywhere: 0 });
  });
});
