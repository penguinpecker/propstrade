// The price record charts fall back to, against the migrated test database: minutes built from ticks, written, merged
// after a restart, and read back as candles; and how the last GMTrade copy and the record are combined.
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import type { PriceTick } from '@props/shared';
import { createPriceRecord, mergeCandles } from '../src/modules/marketdata/record.js';
import { createUpstreams } from '../src/modules/marketdata/upstreams.js';
import { testDatabaseUrl } from './db.js';

const sql = postgres(testDatabaseUrl(), { max: 2, onnotice: () => {} });
afterAll(() => sql.end());

const H = 1_700_000_000 - (1_700_000_000 % 3600); // an hour boundary, unix seconds
const tick = (symbol: string, mid: number, sec: number): PriceTick =>
  ({ symbol, min: String(mid), max: String(mid), mid: String(mid), ts: sec * 1000, session: 'open' });

describe('price record', () => {
  it('builds one bar a minute from ticks, merges a minute written twice, and reads hourly candles', async () => {
    const record = createPriceRecord(sql);
    for (const [mid, sec] of [[100, H + 5], [104, H + 30], [99, H + 50], [101, H + 65], [98, H + 3_590], [97, H + 3_600]] as const) {
      record.add(tick('REC', mid, sec));
    }
    record.add(tick('REC', 500, H + 20)); // older than the current minute: ignored
    await record.flush(); // three minutes are finished; the one at H+3600 is still being built

    // A restarted process saw part of the first minute again: its high/low widen the stored bar, its open does not win.
    const again = createPriceRecord(sql);
    again.add(tick('REC', 110, H + 40));
    again.add(tick('REC', 90, H + 45));
    again.add(tick('REC', 95, H + 70)); // finishes the first minute
    await again.flush();

    const minutes = await sql`select t, open::float, high::float, low::float, close::float from price_bars where symbol = 'REC' order by t`;
    expect(minutes.map((r) => [Number(r.t), r.open, r.high, r.low, r.close])).toEqual([
      [H, 100, 110, 90, 90], [H + 60, 101, 101, 101, 101], [H + 3_540, 98, 98, 98, 98],
    ]);
    expect(await record.candles('REC', 3_600, H, H)).toEqual([{ time: H, open: 100, high: 110, low: 90, close: 98 }]);
    expect(await record.candles('REC', 3_600, H + 3_600, H + 7_200)).toEqual([]);
  });

  it('keeps unwritten minutes when the database fails and writes them on the next flush', async () => {
    let fail = true;
    // Queries (tagged templates) fail while `fail` is set; building their parameters does not.
    const isQuery = (args: unknown[]) => Array.isArray(args[0]) && 'raw' in (args[0] as object);
    const record = createPriceRecord(new Proxy(sql, {
      apply: (target, self, args) => (fail && isQuery(args) ? Promise.reject(new Error('db down')) : Reflect.apply(target, self, args)),
    }));
    record.add(tick('KEEP', 5, H));
    record.add(tick('KEEP', 6, H + 60));
    await expect(record.flush()).rejects.toThrow('db down');
    fail = false;
    await record.flush();
    expect((await sql`select count(*)::int as n from price_bars where symbol = 'KEEP'`)[0]!.n).toBe(1);
  });
});

describe('mergeCandles', () => {
  const c = (time: number, close: number) => ({ time, open: close, high: close, low: close, close });
  it("uses GMTrade's candles where it has them and the record after its last one", () => {
    expect(mergeCandles([c(0, 1), c(60, 2), c(120, 3)], [c(60, 20), c(120, 30), c(180, 40)]).map((x) => x.close)).toEqual([1, 2, 30, 40]);
    expect(mergeCandles([], [c(0, 5)]).map((x) => x.close)).toEqual([5]);
    expect(mergeCandles([c(0, 1)], []).map((x) => x.close)).toEqual([1]);
  });
});

describe('upstreams', () => {
  it('reports a source down after three failures in a row, with why and since when, and recovered on the next success', async () => {
    const changes: string[] = [];
    const u = createUpstreams({ candles: 'use the record' }, (name, s) => changes.push(`${name}:${s.state}`));
    expect(u.status('candles').state).toBe('checking'); // no answer yet
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    for (let i = 0; i < 3; i++) await expect(u.track('candles', () => Promise.reject(timeout))).rejects.toThrow();
    expect(u.status('candles')).toMatchObject({ state: 'down', lastError: 'no answer in time', fallback: 'use the record' });
    expect(u.status('candles').since).toBeGreaterThan(0);
    expect(await u.track('candles', async () => 7)).toBe(7);
    expect(u.status('candles')).toMatchObject({ state: 'ok', since: null });
    expect(changes).toEqual(['candles:down', 'candles:ok']);
  });
});
