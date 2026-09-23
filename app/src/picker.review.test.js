import { describe, expect, it } from 'vitest';
import { pickMarkets } from './data.js';

// Review: the app (Vercel) and the server (Railway) deploy separately. Until the server that sends `subcategory` is live,
// the new picker reads rows without it.
describe('pickMarkets against rows from a server that predates subcategory', () => {
  const rows = [['BTC', 'Bitcoin', 'Crypto'], ['SOL', 'Solana', 'Crypto'], ['XAU', 'Gold', 'Commodities'], ['NVDA', 'NVIDIA', 'Stocks']]
    .map(([symbol, name, category]) => ({ symbol, pair: `${symbol} / USD`, name, category }));
  const pick = (tab, search = '') => pickMarkets(rows, [], { tab, subcategory: null, search });

  it('offers no chip without a name', () => {
    expect(pick('Crypto').subcategories.every(([name]) => typeof name === 'string')).toBe(true);
  });
  it('does not match every market for a search that is part of "undefined"', () => {
    expect(pick('All', 'fin').rows).toEqual([]);
  });
});
