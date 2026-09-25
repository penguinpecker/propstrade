import { describe, expect, it, vi } from 'vitest';
import { TRADE_CSV_HEADER, downloadCsv, tradeCsvRow } from './Workspace.jsx';

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

describe('downloadCsv', () => {
  it('clicks an attached link and keeps the file URL alive afterwards (WebKit drops the download otherwise)', () => {
    vi.useFakeTimers();
    const log = [], body = new Set();
    const anchor = { click: () => log.push(`click attached=${body.has(anchor)} revoked=${log.includes('revoke')}`), remove: () => body.delete(anchor) };
    vi.stubGlobal('document', { createElement: () => anchor, body: { append: el => body.add(el) } });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:1', revokeObjectURL: () => log.push('revoke') });
    const notify = vi.fn();
    downloadCsv('t.csv', ['a'], [['x,y']], notify);
    expect(log).toEqual(['click attached=true revoked=false']);
    expect(body.size).toBe(0);
    expect(notify).toHaveBeenCalledWith('Report exported', '1 row · t.csv');
    vi.advanceTimersByTime(30_000);
    expect(log.at(-1)).toBe('revoke');
    vi.unstubAllGlobals(); vi.useRealTimers();
  });
});
