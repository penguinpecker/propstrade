import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';
import type { AccountDetail, AccountSummary, CandlesResponse, Market, Notification, Position } from '@props/shared';
import { api, ApiRequestError } from './api';
import { SNAPSHOT_MAX_AGE_MS } from './candles';
import { applyStreamEvent, candlesOptions, createQueryClient, keys } from './queries';

const market = (symbol: string, updatedAt: number | null): Market => ({
  symbol, pair: `${symbol} / USD`, name: symbol, category: 'Crypto', subcategory: 'Layer 1 & 2', marketToken: 'token', pools: [], tradable: true,
  price: '100', priceDecimals: 2, indexTokenDecimals: 9, change24h: null, volume24h: null, openInterestLong: null, openInterestShort: null,
  fundingRateHourlyLong: null, fundingRateHourlyShort: null, borrowRateHourlyLong: null, borrowRateHourlyShort: null, capacityLong: null, capacityShort: null,
  poolLiquidity: null, maxLeverage: 25, closedMaxLeverage: null, maxLeverageLong: 25, maxLeverageShort: 25, maxSizeLong: null, maxSizeShort: null, minCollateralUsd: null,
  session: 'open', freshness: 'stale', updatedAt,
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

  it('applies a frame of many ticks with one write to the markets list, patching only the single-market rows that are loaded', () => {
    const client = createQueryClient();
    const symbols = Array.from({ length: 68 }, (_, i) => `S${i}`);
    client.setQueryData(keys.markets, symbols.map(s => market(s, 1000)));
    client.setQueryData(keys.market('S1'), market('S1', 1000));
    client.setQueryData(keys.marketTrades('S2'), []);
    const writes = () => client.getQueryState(keys.markets)!.dataUpdateCount;
    const before = writes();
    applyStreamEvent(client, { type: 'price', ticks: symbols.slice(0, 67).map((s, i) => tick(s, String(200 + i), 2000)) }); // S67 has no tick this frame
    expect(writes()).toBe(before + 1);
    const list = client.getQueryData<Market[]>(keys.markets)!;
    expect(list.slice(0, 67).map(m => m.price)).toEqual(symbols.slice(0, 67).map((_, i) => String(200 + i)));
    expect(list[67]).toMatchObject({ price: '100', updatedAt: 1000, freshness: 'stale' });
    expect(client.getQueryData<Market>(keys.market('S1'))).toMatchObject({ price: '201', updatedAt: 2000, freshness: 'live' });
    expect(client.getQueryData(keys.market('S2'))).toBeUndefined(); // a market with only its trades loaded gets no row
    expect(client.getQueryData(keys.marketTrades('S2'))).toEqual([]);
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

/** A localStorage stand-in. */
function memory(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  const storage = { get length() { return map.size; }, key: (i: number) => [...map.keys()][i] ?? null, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, String(v)); }, removeItem: (k: string) => { map.delete(k); }, clear: () => map.clear() };
  return storage as typeof storage & Storage;
}

describe('candles', () => {
  const hour = Math.floor(Date.now() / 3_600_000) * 3600; // the current bar: a saved copy that ends before the fetch's window is not read
  const candles = (symbol: string): CandlesResponse => ({ symbol, interval: '1h', candles: [{ time: hour, open: 1, high: 2, low: 1, close: 2 }], source: 'venue', freshness: 'live' });
  /** What the browser keeps of a fetch (lib/candles.ts), dated `at`. */
  const saved = (symbol: string, at: number) => JSON.stringify({ at, candles: candles(symbol).candles });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

  it('starts from the saved copy before any request and, when the copy is older than staleTime, refetches at once and keeps the fetch', async () => {
    const storage = memory({ 'props.candles.BTC.1h': saved('BTC', Date.now() - 20_000) });
    vi.stubGlobal('localStorage', storage);
    const server = { ...candles('BTC'), candles: [{ time: hour - 3600, open: 1, high: 3, low: 1, close: 3 }, { time: hour, open: 3, high: 4, low: 3, close: 4 }] };
    const fetch = vi.spyOn(api, 'candles').mockResolvedValue(server);
    const client = createQueryClient();
    const observer = new QueryObserver(client, candlesOptions('BTC', '1h'));
    expect(observer.getCurrentResult()).toMatchObject({ status: 'success', data: candles('BTC') });
    expect(fetch).not.toHaveBeenCalled();
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(client.getQueryData(keys.candles('BTC', '1h'))).toEqual(server));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.getItem('props.candles.BTC.1h')!)).toMatchObject({ candles: server.candles });
    expect(JSON.parse(storage.getItem('props.candles.BTC.1h')!).at).toBeGreaterThan(Date.now() - 5_000);
    unsubscribe();
  });

  it('is not fetched while the saved copy is younger than staleTime: the watchlist prefetch resolves from it', async () => {
    vi.stubGlobal('localStorage', memory({ 'props.candles.BTC.1h': saved('BTC', Date.now()) }));
    const fetch = vi.spyOn(api, 'candles');
    expect(await createQueryClient().query(candlesOptions('BTC', '1h'))).toEqual(candles('BTC'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores a saved copy older than three days and fetches as if there were none', async () => {
    vi.stubGlobal('localStorage', memory({ 'props.candles.BTC.1h': saved('BTC', Date.now() - SNAPSHOT_MAX_AGE_MS - 1) }));
    const fetch = vi.spyOn(api, 'candles').mockImplementation(async symbol => candles(symbol));
    const client = createQueryClient();
    expect(new QueryObserver(client, candlesOptions('BTC', '1h')).getCurrentResult()).toMatchObject({ status: 'pending', data: undefined });
    expect(await client.query(candlesOptions('BTC', '1h'))).toEqual(candles('BTC'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('saves nothing the server did not return: a saved market that left the catalog gets no copy', async () => {
    const storage = memory();
    vi.stubGlobal('localStorage', storage);
    vi.spyOn(api, 'candles').mockRejectedValue(new ApiRequestError(404, 'not_found', 'unknown market ZZZ'));
    await expect(createQueryClient().query(candlesOptions('ZZZ', '1h'))).rejects.toThrow('unknown market ZZZ');
    expect(storage.length).toBe(0);
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
