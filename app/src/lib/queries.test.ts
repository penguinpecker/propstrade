import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountDetail, AccountSummary, CandlesResponse, Market, Notification, Position } from '@props/shared';
import { api } from './api';
import { applyStreamEvent, candlesOptions, createQueryClient, keys } from './queries';

const market = (symbol: string, updatedAt: number | null): Market => ({
  symbol, pair: `${symbol} / USD`, name: symbol, category: 'Crypto', subcategory: 'Layer 1 & 2', marketToken: 'token', pools: [], tradable: true,
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

describe('candles', () => {
  const candles = (symbol: string): CandlesResponse => ({ symbol, interval: '1h', candles: [{ time: 3600, open: 1, high: 2, low: 1, close: 2 }], source: 'gmtrade', freshness: 'live' });
  afterEach(() => vi.restoreAllMocks());

  it('is enabled by a symbol alone (the saved one, before the market catalog is in), on the key the chart and prefetches share', () => {
    expect(candlesOptions('BTC', '1h')).toMatchObject({ queryKey: keys.candles('BTC', '1h'), enabled: true });
    expect(candlesOptions('', '1h').enabled).toBe(false);
  });

  it('prefetches the watchlist onto the chart’s own keys, skipping candles still fresh and fetching again for a new interval', async () => {
    const fetch = vi.spyOn(api, 'candles').mockImplementation(async symbol => candles(symbol));
    const client = createQueryClient();
    await client.query(candlesOptions('ETH', '1h'));
    await client.query(candlesOptions('ETH', '1h'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(keys.candles('ETH', '1h'))).toMatchObject({ symbol: 'ETH' });
    await client.query(candlesOptions('ETH', '4h'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith('ETH', '4h');
  });

  it('is left alone by price ticks: they move the chart through the market row, not through a refetch', () => {
    const client = createQueryClient();
    client.setQueryData(keys.candles('BTC', '1h'), candles('BTC'));
    client.setQueryData(keys.markets, [market('BTC', 1000)]);
    applyStreamEvent(client, { type: 'price', ticks: [tick('BTC', '101', 2000)] });
    expect(client.getQueryState(keys.candles('BTC', '1h'))).toMatchObject({ isInvalidated: false, dataUpdateCount: 1 });
  });
});

describe('retries', () => {
  it('retries an outage but not a program that is not live yet, nor a client error', async () => {
    const { ApiRequestError } = await import('./api');
    const retry = createQueryClient().getDefaultOptions().queries!.retry as (failures: number, error: unknown) => boolean;
    expect(retry(0, new ApiRequestError(503, 'unavailable', 'market data is starting'))).toBe(true);
    expect(retry(0, new ApiRequestError(503, 'not_initialized', 'The Props.trade program is not live on Solana yet'))).toBe(false);
    expect(retry(0, new ApiRequestError(404, 'not_found', 'no such account'))).toBe(false);
    expect(retry(0, new ApiRequestError(404, 'not_found', 'unknown market ZZZ'))).toBe(false); // a saved symbol that left the catalog
    expect(retry(3, new ApiRequestError(503, 'unavailable', 'still down'))).toBe(false);
  });
});
