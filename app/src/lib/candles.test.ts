import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandlesResponse } from '@props/shared';
import { INTERVALS, INTERVAL_SECONDS, SNAPSHOT_BARS, SNAPSHOT_MAX_AGE_MS, SNAPSHOT_PAIRS, applyTick, bucketNext, bucketStart, isInterval, readCandleSnapshot, writeCandleSnapshot } from './candles';

const last = { time: 3600, open: 100, high: 105, low: 99, close: 102 };

describe('intervals', () => {
  it('offers the 13 chart intervals, shortest first, each with its span', () => {
    expect(INTERVALS).toEqual(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1D', '1W', '1M']);
    expect(INTERVALS.map(i => INTERVAL_SECONDS[i])).toEqual([60, 180, 300, 900, 1800, 3600, 7200, 14_400, 21_600, 43_200, 86_400, 604_800, 2_592_000]);
    expect(isInterval('3m')).toBe(true);
    for (const bad of ['7m', '1d', 1, null, 'constructor']) expect(isInterval(bad)).toBe(false);
  });

  it('starts weeks on Monday 00:00 UTC and months on the first, as the server does; the rest are multiples of the span', () => {
    const wed = Date.UTC(2026, 8, 23, 15, 42) / 1000; // Wednesday 2026-09-23
    expect(bucketStart('1W', wed)).toBe(Date.UTC(2026, 8, 21) / 1000);
    expect(bucketNext('1W', wed)).toBe(Date.UTC(2026, 8, 28) / 1000);
    expect(bucketStart('1M', wed)).toBe(Date.UTC(2026, 8, 1) / 1000);
    expect(bucketNext('1M', wed)).toBe(Date.UTC(2026, 9, 1) / 1000);
    expect(bucketNext('1M', Date.UTC(2026, 11, 31) / 1000)).toBe(Date.UTC(2027, 0, 1) / 1000);
    expect(bucketStart('3m', 1_700_000_150)).toBe(1_700_000_100);
    expect(bucketNext('12h', wed)).toBe(Date.UTC(2026, 8, 24) / 1000);
  });
});

describe('applyTick', () => {
  it('moves the close, high and low of the current candle', () => {
    expect(applyTick(last, 107, 3600_000 + 1_000, '1h')).toEqual({ time: 3600, open: 100, high: 107, low: 99, close: 107 });
    expect(applyTick(last, 98, 7_199_000, '1h')).toEqual({ time: 3600, open: 100, high: 105, low: 98, close: 98 });
  });

  it('opens the next candle at the previous close', () => {
    expect(applyTick(last, 103, 7_200_000, '1h')).toEqual({ time: 7200, open: 102, high: 103, low: 102, close: 103 });
    expect(applyTick(last, 101, 86_400_000, '1D')).toEqual({ time: 86_400, open: 102, high: 102, low: 101, close: 101 });
  });

  it('keeps a weekly candle through its Monday-aligned week and a monthly one through its calendar month', () => {
    const week = { ...last, time: Date.UTC(2026, 8, 21) / 1000 }; // Monday
    expect(applyTick(week, 104, Date.UTC(2026, 8, 27, 23, 59), '1W')).toMatchObject({ time: week.time, close: 104 });
    expect(applyTick(week, 104, Date.UTC(2026, 8, 28), '1W')).toMatchObject({ time: Date.UTC(2026, 8, 28) / 1000, open: 102 });
    const month = { ...last, time: Date.UTC(2026, 9, 1) / 1000 };
    expect(applyTick(month, 104, Date.UTC(2026, 9, 31, 12), '1M')).toMatchObject({ time: month.time });
    expect(applyTick(month, 104, Date.UTC(2026, 10, 1), '1M')).toMatchObject({ time: Date.UTC(2026, 10, 1) / 1000 });
  });

  it('ignores prices older than the last candle and a chart without candles', () => {
    expect(applyTick(last, 90, 3_599_000, '1h')).toBeNull();
    expect(applyTick(undefined, 90, 3_600_000, '1h')).toBeNull();
  });
});

/** A localStorage stand-in. */
function memory(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  const storage = {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    map,
  };
  return storage as typeof storage & Storage;
}
const NOW = 1_700_000_000_000; // when the saved-candle tests run: 800 s into the hourly bucket that opened at LAST
const LAST = 1_699_999_200;
/** `n` hourly bars ending at LAST, as a fetch of the current window returns them. */
const bars = (n: number) => Array.from({ length: n }, (_, i) => ({ time: LAST - (n - 1 - i) * 3600, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i }));
const live = (candles = bars(3)): CandlesResponse => ({ symbol: 'BTC', interval: '1h', candles, source: 'gmtrade', freshness: 'live' });

describe('saved candles', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it('keeps the last 300 bars of a live response, dated now, with their five fields only, and reads them back as that response', () => {
    const storage = memory();
    writeCandleSnapshot('BTC', '1h', live(bars(SNAPSHOT_BARS + 20).map(b => ({ ...b, volume: 5, onclick: 'x' }))), storage);
    const saved = readCandleSnapshot('BTC', '1h', storage);
    expect(saved?.at).toBe(NOW);
    expect(saved?.response).toEqual({ symbol: 'BTC', interval: '1h', candles: bars(SNAPSHOT_BARS + 20).slice(-SNAPSHOT_BARS), source: 'gmtrade', freshness: 'live' });
    expect(readCandleSnapshot('BTC', '4h', storage)).toBeNull();
    expect(readCandleSnapshot('ETH', '1h', storage)).toBeNull();
  });

  it('does not keep a fallback copy or an empty list: the last live copy stays', () => {
    const storage = memory();
    writeCandleSnapshot('BTC', '1h', { ...live(), freshness: 'delayed' }, storage);
    expect(storage.map.size).toBe(0);
    writeCandleSnapshot('BTC', '1h', live(), storage);
    writeCandleSnapshot('BTC', '1h', { ...live(bars(5)), freshness: 'delayed' }, storage);
    writeCandleSnapshot('BTC', '1h', live([]), storage);
    expect(readCandleSnapshot('BTC', '1h', storage)?.response.candles).toEqual(bars(3));
  });

  it('reads nothing from a copy that is malformed, out of order, out of range, too large, too old, dated in the future or ending before the window a fetch returns', () => {
    const now = Date.now();
    const entry = (value: unknown) => memory({ 'props.candles.BTC.1h': typeof value === 'string' ? value : JSON.stringify(value) });
    const dated = (candles: unknown, at: unknown = now) => entry({ at, candles });
    const good = bars(3);
    const ago = (hours: number) => good.map(b => ({ ...b, time: b.time - hours * 3600 })); // the same bars, `hours` earlier
    expect(readCandleSnapshot('BTC', '1h', dated(good))?.response.candles).toEqual(good);
    const bad: [string, Storage][] = [
      ['not json', entry('{not json')],
      ['a string', entry('"bars"')],
      ['a bare list', entry(good)],
      ['no date', entry({ candles: good })],
      ['a date as text', dated(good, String(now))],
      ['dated in the future', dated(good, now + 60_000)],
      ['older than the bound', dated(good, now - SNAPSHOT_MAX_AGE_MS - 1)],
      ['candles not a list', dated({ 0: good[0] })],
      ['no candles', dated([])],
      ['too many candles', dated(bars(SNAPSHOT_BARS + 1))],
      ['a bar that is not an object', dated([...good, null])],
      ['a time as text', dated([{ ...good[0], time: '3600' }])],
      ['a fractional time', dated([{ ...good[0], time: 3600.5 }])],
      ['a time past 2100', dated([{ ...good[0], time: 4_102_444_800 }])],
      ['times out of order', dated([good[1], good[0]])],
      ['a repeated time', dated([good[0], good[0]])],
      ['a missing price', dated([{ ...good[0], close: null }])],
      ['a price of zero', dated([{ ...good[0], low: 0 }])],
      ['a high below the close', dated([{ ...good[0], high: 100 }])],
      ['a low above the open', dated([{ ...good[0], low: 100.2 }])],
      ['an absurd price', dated([{ ...good[0], high: 1e15 }])],
      ['a last bar older than the window a fetch returns', dated(ago(SNAPSHOT_BARS))],
    ];
    for (const [what, storage] of bad) expect(readCandleSnapshot('BTC', '1h', storage), what).toBeNull();
    expect(readCandleSnapshot('BTC', '1h', null)).toBeNull();
    // A copy the fetch's window still reaches is shown: the chart keeps its bars in front of the fetch's without a hole.
    expect(readCandleSnapshot('BTC', '1h', dated(ago(SNAPSHOT_BARS - 1)))?.response.candles).toEqual(ago(SNAPSHOT_BARS - 1));
  });

  it('keeps the 12 most recently fetched pairs and drops the rest, undatable copies first', () => {
    const storage = memory();
    const symbols = Array.from({ length: SNAPSHOT_PAIRS + 1 }, (_, i) => `S${i}`);
    for (const symbol of symbols) { vi.advanceTimersByTime(1000); writeCandleSnapshot(symbol, '1h', live(), storage); }
    expect(readCandleSnapshot('S0', '1h', storage)).toBeNull();
    expect(symbols.slice(1).every(s => readCandleSnapshot(s, '1h', storage))).toBe(true);
    // A pair fetched again is the most recent: the next new pair pushes out the oldest of the others.
    vi.advanceTimersByTime(1000); writeCandleSnapshot('S1', '1h', live(), storage);
    vi.advanceTimersByTime(1000); writeCandleSnapshot('S1', '4h', live(), storage);
    expect(readCandleSnapshot('S2', '1h', storage)).toBeNull();
    expect(readCandleSnapshot('S1', '1h', storage)).not.toBeNull();
    expect(storage.map.size).toBe(SNAPSHOT_PAIRS);
    storage.setItem('props.candles.JUNK.1h', '{"candles":[]}');
    vi.advanceTimersByTime(1000); writeCandleSnapshot('S1', '1D', live(), storage);
    expect(storage.map.has('props.candles.JUNK.1h')).toBe(false);
    expect(readCandleSnapshot('S3', '1h', storage)).toBeNull();
    expect(readCandleSnapshot('S4', '1h', storage)).not.toBeNull();
    expect(storage.map.size).toBe(SNAPSHOT_PAIRS);
  });

  it('never writes while reading, so the copy of a market that left the catalog is not renewed', () => {
    const storage = memory({ 'props.candles.ZZZ.1h': JSON.stringify({ at: Date.now() - 1000, candles: bars(2) }) });
    const setItem = vi.spyOn(storage, 'setItem');
    expect(readCandleSnapshot('ZZZ', '1h', storage)?.response.candles).toEqual(bars(2));
    expect(setItem).not.toHaveBeenCalled();
  });
});
