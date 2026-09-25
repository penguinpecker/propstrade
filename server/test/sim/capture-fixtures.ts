// Records live GMTrade state for the sim engine tests: for a few markets, the raw Market and VirtualInventory account
// images, collateral (USDC) prices, index token decimals and the catalog row, plus every price tick the keeper stream
// sends during the capture window, exactly as the marketdata module turns them into api.ts PriceTicks.
//
//   node --import tsx test/sim/capture-fixtures.ts [seconds=60]      (from server/; read-only public GMTrade APIs + RPC)
import { writeFileSync } from 'node:fs';
import type { Market, MarketCategory, PriceTick } from '@props/shared';
import { KeeperFeed, buildCatalog, fetchPairs, isMarketClosed, modelInput, priceTick, sessionOf } from '@props/gmtrade';

const SYMBOLS = ['SOL', 'BTC', 'XAU', 'EUR', 'NVDA'];
const seconds = Number(process.argv[2] ?? 60);
// The Props defaults every allowlisted market gets (ARCHITECTURE.md §1), as marketdata applies them.
const LIMITS: Record<MarketCategory, { maxLeverage: number; closedMaxLeverage: number | null }> = {
  Crypto: { maxLeverage: 25, closedMaxLeverage: null },
  Forex: { maxLeverage: 20, closedMaxLeverage: 8 },
  Commodities: { maxLeverage: 15, closedMaxLeverage: null },
  Stocks: { maxLeverage: 8, closedMaxLeverage: 8 },
};

const feed = new KeeperFeed({ log: { warn: (obj, msg) => console.warn(msg, obj) } });
await feed.start();
const pairs = new Map((await fetchPairs()).map((p) => [p.pool_id, p]));
const catalog = () => buildCatalog({
  feed, pairs, opens24h: new Map(), now: Date.now(),
  limits: ({ category }) => ({ tradable: true, ...LIMITS[category] }),
  onError: (marketToken, err) => console.warn('model rejected', marketToken, err),
});
const rows = new Map<string, Market>(catalog().filter((m) => SYMBOLS.includes(m.symbol)).map((m) => [m.symbol, m]));
const symbolByIndex = new Map([...rows.values()].map((m) => [feed.markets.get(m.marketToken)!.meta!.indexToken.pubkey, m.symbol]));

const ticks: PriceTick[] = [];
feed.onTick((token) => {
  const symbol = symbolByIndex.get(token.pubkey);
  const market = symbol && rows.get(symbol);
  if (!market) return;
  const data = feed.accounts.get(feed.markets.get(market.marketToken)!.pubkey)?.data;
  const tick = priceTick(symbol, token, sessionOf(token.price, data ? isMarketClosed(data) : false));
  if (tick) ticks.push(tick);
});
await new Promise((r) => setTimeout(r, seconds * 1000));
feed.stop();

const markets = [...rows.values()].map((row) => {
  const pool = feed.markets.get(row.marketToken)!;
  const input = modelInput(feed, pool)!;
  const account = feed.accounts.get(pool.pubkey)!;
  const index = feed.tokens.get(pool.meta!.indexToken.pubkey)!;
  return {
    row: catalog().find((m) => m.symbol === row.symbol),
    indexToken: index.pubkey,
    indexDecimals: index.meta!.decimals,
    isClosed: isMarketClosed(account.data),
    slot: account.slot,
    market: input.market,
    virtualInventories: input.virtualInventories,
    prices: {
      index: { min: String(input.prices.index.min), max: String(input.prices.index.max) },
      long: { min: String(input.prices.long.min), max: String(input.prices.long.max) },
      short: { min: String(input.prices.short.min), max: String(input.prices.short.max) },
    },
  };
});
const out = new URL(`fixtures/gmtrade-live.json`, import.meta.url);
writeFileSync(out, `${JSON.stringify({
  source: `GMTrade keeper API (HTTP snapshot + graphql-ws ticks), market-info and mainnet RPC, captured ${new Date().toISOString()} over ${seconds} s`,
  markets, ticks,
}, null, 1)}\n`);
console.log(`wrote ${markets.length} markets, ${ticks.length} ticks to ${out.pathname}`);
