// Display metadata GMTrade's APIs lack: human names (the keeper API names only 2 of 68 assets),
// category and sub-category mapping, session notes and display decimals. Keyed by keeper token `meta.name`.
import type { MarketCategory } from '@props/shared';

export const NAMES: Record<string, string> = {
  // crypto
  AAVE: 'Aave', ADA: 'Cardano', APE: 'ApeCoin', ARB: 'Arbitrum', ASTER: 'Aster', AVAX: 'Avalanche',
  BCH: 'Bitcoin Cash', BNB: 'BNB', BOME: 'Book of Meme', BONK: 'Bonk', BTC: 'Bitcoin', DOGE: 'Dogecoin',
  DOT: 'Polkadot', ENA: 'Ethena', ETH: 'Ethereum', FARTCOIN: 'Fartcoin', GMX: 'GMX', HYPE: 'Hyperliquid',
  LINK: 'Chainlink', LIT: 'Lighter', LTC: 'Litecoin', MELANIA: 'Official Melania Meme', NEAR: 'NEAR Protocol',
  ONDO: 'Ondo', PEPE: 'Pepe', PUMP: 'Pump.fun', SHIB: 'Shiba Inu', SOL: 'Solana', SUI: 'Sui', TAO: 'Bittensor',
  TON: 'Toncoin', TRUMP: 'Official Trump', TRX: 'TRON', UNI: 'Uniswap', VVV: 'Venice Token', WIF: 'dogwifhat',
  WLD: 'Worldcoin', WLFI: 'World Liberty Financial', XLM: 'Stellar', XMR: 'Monero', XPL: 'Plasma', XRP: 'XRP',
  ZEC: 'Zcash',
  // forex
  AUD: 'Australian Dollar / US Dollar', EUR: 'Euro / US Dollar', GBP: 'British Pound / US Dollar',
  NZD: 'New Zealand Dollar / US Dollar', USDCAD: 'US Dollar / Canadian Dollar', USDCHF: 'US Dollar / Swiss Franc',
  USDJPY: 'US Dollar / Japanese Yen', USDMXN: 'US Dollar / Mexican Peso',
  // commodities
  WTI: 'WTI Crude Oil', XAG: 'Silver', XAU: 'Gold', XCU: 'Copper', XPD: 'Palladium', XPT: 'Platinum',
  // stocks and ETFs
  AAPL: 'Apple', AMZN: 'Amazon', GOOGL: 'Alphabet', META: 'Meta Platforms', MSFT: 'Microsoft', MSTR: 'Strategy',
  NVDA: 'NVIDIA', QQQ: 'Invesco QQQ (Nasdaq-100 ETF)', SPCX: 'SpaceX', SPY: 'SPDR S&P 500 ETF', TSLA: 'Tesla',
};

const CATEGORY: Record<string, MarketCategory> = { Commodity: 'Commodities', Forex: 'Forex', Stock: 'Stocks' };

/** GMTrade category -> Props category; every other GMTrade category (Layer1&2, Meme, DeFi, Other) is crypto. */
export const categoryOf = (gmCategory: string | null): MarketCategory => (gmCategory && CATEGORY[gmCategory]) || 'Crypto';

// Sub-categories. Crypto uses GMTrade's own token category (live on 2026-09-23: Layer1&2 17, DeFi 10, Meme 10,
// Other 6), renamed where its spelling is not for display. The other categories are curated by symbol; a symbol missing
// here is 'Other' (a new listing can belong to any group), and the live catalog test fails until it is added.
const CRYPTO_GROUPS: Record<string, string> = { 'Layer1&2': 'Layer 1 & 2' };
const GROUPS: Record<string, string> = {
  // commodities
  XAU: 'Metals', XAG: 'Metals', XPT: 'Metals', XPD: 'Metals', XCU: 'Metals', WTI: 'Energy',
  // forex
  EUR: 'Majors', GBP: 'Majors', AUD: 'Majors', NZD: 'Majors', USDJPY: 'Majors', USDCAD: 'Majors', USDCHF: 'Majors', USDMXN: 'Emerging',
  // stocks and ETFs
  SPY: 'Index ETFs', QQQ: 'Index ETFs', AAPL: 'Companies', AMZN: 'Companies', GOOGL: 'Companies', META: 'Companies',
  MSFT: 'Companies', MSTR: 'Companies', NVDA: 'Companies', SPCX: 'Companies', TSLA: 'Companies',
};

/** Group of a market within its category; `gmCategory` is the keeper token's category. */
export const subcategoryOf = (symbol: string, category: MarketCategory, gmCategory: string | null): string =>
  category === 'Crypto' ? (gmCategory ? CRYPTO_GROUPS[gmCategory] ?? gmCategory : 'Other') : GROUPS[symbol] ?? 'Other';

/** "USD/JPY" -> "USD / JPY"; falls back to "<symbol> / USD". */
export const pairOf = (symbol: string, indexName: string | null) => (indexName ?? `${symbol}/USD`).replace('/', ' / ');

export const SESSION_NOTES: Partial<Record<MarketCategory, string>> = {
  Stocks: 'US regular market hours, Mon–Fri 9:30–16:00 New York time',
  Forex: 'Closed at weekends, Friday ~21:00 to Sunday ~21:00 UTC',
};

// The keeper's token `precision` is only an upper bound: stocks and commodities carry cents (NVDA has
// precision 6 and prices like 228.82), except copper, which quotes to 4 dp like COMEX.
const CATEGORY_DECIMALS: Partial<Record<MarketCategory, number>> = { Stocks: 2, Commodities: 2 };
const SYMBOL_DECIMALS: Record<string, number> = { XCU: 4 };

/** Decimals a price is displayed with. */
export const displayDecimals = (symbol: string, category: MarketCategory, precision: number) =>
  Math.min(precision, SYMBOL_DECIMALS[symbol] ?? CATEGORY_DECIMALS[category] ?? precision);
