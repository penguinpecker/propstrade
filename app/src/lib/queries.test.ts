import { describe, expect, it } from 'vitest';
import type { AccountDetail, AccountSummary, Market, Notification, Position } from '@props/shared';
import { applyStreamEvent, createQueryClient, keys } from './queries';

const market = (symbol: string, updatedAt: number | null): Market => ({
  symbol, pair: `${symbol} / USD`, name: symbol, category: 'Crypto', marketToken: 'token', pools: [], tradable: true,
  price: '100', priceDecimals: 2, indexTokenDecimals: 9, change24h: null, volume24h: null, openInterestLong: null, openInterestShort: null,
  fundingRateHourlyLong: null, borrowRateHourlyLong: null, borrowRateHourlyShort: null, capacityLong: null, capacityShort: null,
  poolLiquidity: null, maxLeverage: 25, closedMaxLeverage: null, session: 'open', freshness: 'stale', updatedAt,
});
const tick = (symbol: string, mid: string, ts: number) => ({ symbol, min: mid, max: mid, mid, ts, session: 'open' as const });
const account = { id: 'acc', equity: '25000' } as AccountSummary;
const notification = (id: string): Notification => ({ id, title: id, body: '', href: '/', ts: 0, read: false, kind: 'fill' });

describe('applyStreamEvent', () => {
  it('applies newer price ticks and ignores older ones', () => {
    const client = createQueryClient();
    client.setQueryData(keys.markets, [market('BTC', 1000), market('ETH', 1000)]);
    client.setQueryData(keys.market('BTC'), market('BTC', 1000));
    applyStreamEvent(client, { type: 'price', ticks: [tick('BTC', '101', 2000), tick('ETH', '99', 500)] });
    const [btc, eth] = client.getQueryData<Market[]>(keys.markets)!;
    expect(btc).toMatchObject({ price: '101', updatedAt: 2000, freshness: 'live' });
    expect(eth).toMatchObject({ price: '100', updatedAt: 1000, freshness: 'stale' });
    expect(client.getQueryData<Market>(keys.market('BTC'))).toMatchObject({ price: '101' });
  });

  it('merges account summaries into the list and the detail', () => {
    const client = createQueryClient();
    client.setQueryData(keys.accounts, [{ id: 'other' }]);
    client.setQueryData(keys.account('acc'), { id: 'acc', equity: '1', positions: [], orders: [] });
    applyStreamEvent(client, { type: 'account', account });
    expect(client.getQueryData<AccountSummary[]>(keys.accounts)!.map(a => a.id)).toEqual(['other', 'acc']);
    expect(client.getQueryData<AccountDetail>(keys.account('acc'))).toMatchObject({ equity: '25000', positions: [] });
  });

  it('replaces positions in both caches without creating details that were never loaded', () => {
    const client = createQueryClient();
    const positions = [{ id: 'p1' } as Position];
    applyStreamEvent(client, { type: 'positions', accountId: 'acc', positions });
    expect(client.getQueryData(keys.positions('acc'))).toEqual(positions);
    expect(client.getQueryData(keys.account('acc'))).toBeUndefined();
  });

  it('refetches trade history when a position leaves the list, not on every valuation', () => {
    const client = createQueryClient();
    client.setQueryData(keys.positions('acc'), [{ id: 'p1' }, { id: 'p2' }]);
    client.setQueryData(keys.history('acc'), []);
    const stale = () => client.getQueryState(keys.history('acc'))!.isInvalidated;
    applyStreamEvent(client, { type: 'positions', accountId: 'acc', positions: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] as Position[] });
    expect(stale()).toBe(false);
    applyStreamEvent(client, { type: 'positions', accountId: 'acc', positions: [{ id: 'p1' }, { id: 'p3' }] as Position[] });
    expect(stale()).toBe(true);
  });

  it('prepends notifications to the loaded list, newest 100, without duplicates', () => {
    const client = createQueryClient();
    client.setQueryData<Notification[]>(keys.notifications, [notification('old')]);
    for (let i = 0; i < 110; i++) applyStreamEvent(client, { type: 'notification', notification: notification(`n${i}`) });
    applyStreamEvent(client, { type: 'notification', notification: notification('n109') });
    const list = client.getQueryData<Notification[]>(keys.notifications)!;
    expect(list).toHaveLength(100);
    expect(list[0]!.id).toBe('n109');
    expect(new Set(list.map(n => n.id)).size).toBe(100);
  });

  it('re-reads /v1/me on account and payout notices, not on fills', () => {
    const client = createQueryClient();
    client.setQueryData(keys.me, { wallet: 'w', kyc: 'pending' });
    const stale = () => client.getQueryState(keys.me)!.isInvalidated;
    applyStreamEvent(client, { type: 'notification', notification: notification('fill') });
    expect(stale()).toBe(false);
    applyStreamEvent(client, { type: 'notification', notification: { ...notification('kyc'), kind: 'account', title: 'Identity verified' } });
    expect(stale()).toBe(true);
  });

  it('leaves an unloaded notification list for its first fetch', () => {
    const client = createQueryClient();
    applyStreamEvent(client, { type: 'notification', notification: notification('n1') });
    expect(client.getQueryData(keys.notifications)).toBeUndefined();
  });
});
