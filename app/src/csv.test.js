import { describe, expect, it } from 'vitest';
import { TRADE_CSV_HEADER, tradeCsvRow } from './Workspace.jsx';

describe('tradeCsvRow', () => {
  const trade = { id: 'T-1', symbol: 'BTC', side: 'long', openedAt: '2026-09-01T00:00:00.000Z', closedAt: '2026-09-02T00:00:00.000Z', sizeUsd: '1000', entryPrice: '100', exitPrice: '110', feesUsd: '3.5', netPnl: '96.5', venue: 'sim', signatures: ['s1', 's2'] };
  it('puts the cost breakdown after total fees, in header order', () => {
    const row = tradeCsvRow({ ...trade, orderFeesUsd: '2', fundingUsd: '1', borrowUsd: '0.5', priceImpactUsd: '-0.25' });
    expect(row).toHaveLength(TRADE_CSV_HEADER.length);
    expect(Object.fromEntries(TRADE_CSV_HEADER.map((h, i) => [h, row[i]]))).toMatchObject({ 'Fees USD': '3.5', 'Order fees USD': '2', 'Funding USD': '1', 'Borrowing USD': '0.5', 'Price impact USD': '-0.25', 'Net PnL USD': '96.5', 'Signatures': 's1 s2' });
  });
  it('leaves the breakdown blank for a trade recorded without it', () => {
    expect(tradeCsvRow(trade).slice(9, 13)).toEqual(['', '', '', '']);
  });
});
