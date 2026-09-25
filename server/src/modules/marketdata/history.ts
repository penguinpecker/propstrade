// Chart history that survives a restart: GMTrade candle windows kept in candle_windows (db/schema.ts). A series' latest
// window (unsettled, rewritten when it rotates or five minutes after its last write) restores marketdata's in-memory
// copies at boot; settled windows, fetched for a request or by the backfill in 300-bar pages, answer history scrolls
// without GMTrade (index.ts).
import type { Candle } from '@props/shared';
import type { Sql } from '../../db/client.js';

/** Bars kept per series, what the app's chart can reach (REACH_BARS in app/src/Chart.jsx): the oldest-fetched settled
 *  windows beyond them are evicted. */
export const KEEP_BARS = 30_000;
const MAX_UNWRITTEN = 1_000; // windows queued while the database is unreachable (the pre-warm queues 340 every five minutes)

export interface CandleWindow { symbol: string; res: number; start: number; end: number; candles: Candle[]; settled: boolean; at: number /* ms */ }
type Range = { start: number; end: number };

/** Whether `pieces` (first and last bucket of each) cover every bucket of [start, end] between them, with no hole. */
export function covers(pieces: Range[], start: number, end: number, res: number): boolean {
  let next = start; // the first bucket not covered yet
  for (const p of [...pieces].sort((a, b) => a.start - b.start)) {
    if (p.start > next) break;
    next = Math.max(next, p.end + res);
  }
  return next > end;
}

export type HistoryStore = ReturnType<typeof createHistoryStore>;

/** `track` wraps every database call (index.ts counts failures for /v1/health and logs an outage once). Timestamps
 *  travel as strings and epoch milliseconds: drizzle makes the shared client's timestamp handlers transparent. */
export function createHistoryStore(sql: Sql, track: <T>(call: () => Promise<T>) => Promise<T>) {
  let pending: CandleWindow[] = [];
  let stored = 0;
  const seriesKey = (w: { symbol: string; res: number }) => `${w.symbol}:${w.res}`;

  return {
    /** Every series' latest window, for the in-memory copies at boot. */
    async latest(): Promise<CandleWindow[]> {
      return track(async () => {
        const rows = await sql<{ symbol: string; resolution: number; start_time: string; end_time: string; candles: Candle[]; at: number }[]>`
          select symbol, resolution, start_time, end_time, candles, extract(epoch from fetched_at) * 1000 as at from candle_windows where not settled`;
        stored = (await sql<{ count: number }[]>`select count(*)::int as count from candle_windows where settled`)[0]!.count;
        return rows.map((r) => ({
          symbol: r.symbol, res: r.resolution, start: Number(r.start_time), end: Number(r.end_time), candles: r.candles, settled: false, at: Number(r.at),
        }));
      });
    },

    /** Settled candles for every bucket of [start, end], from the stored settled windows overlapping it and `copy` (the
     *  series' in-memory latest window), the later fetched winning where they overlap; null when they leave a hole. */
    async covering(symbol: string, res: number, start: number, end: number, copy?: Range & { at: number; candles: Candle[] }): Promise<Candle[] | null> {
      const rows = await track(() => sql<{ start_time: string; end_time: string; candles: Candle[]; at: number }[]>`
        select start_time, end_time, candles, extract(epoch from fetched_at) * 1000 as at from candle_windows
        where symbol = ${symbol} and resolution = ${res} and settled and start_time <= ${end} and end_time >= ${start}`);
      const pieces = rows.map((r) => ({ start: Number(r.start_time), end: Number(r.end_time), candles: r.candles, at: Number(r.at) }));
      if (copy && copy.start <= end && copy.end >= start) pieces.push(copy);
      if (!covers(pieces, start, end, res)) return null;
      const byTime = new Map<number, Candle>();
      for (const p of pieces.sort((a, b) => a.at - b.at)) for (const c of p.candles) if (c.time >= start && c.time <= end) byTime.set(c.time, c);
      return [...byTime.values()].sort((a, b) => a.time - b.time);
    },

    /** The series' stored settled windows, and the end of the newest empty one: GMTrade's history starts after it. */
    async coverage(symbol: string, res: number): Promise<{ ranges: Range[]; historyEnd: number }> {
      const rows = await track(() => sql<{ start_time: string; end_time: string; empty: boolean }[]>`
        select start_time, end_time, jsonb_array_length(candles) = 0 as empty from candle_windows
        where symbol = ${symbol} and resolution = ${res} and settled order by start_time`);
      return {
        ranges: rows.map((r) => ({ start: Number(r.start_time), end: Number(r.end_time) })),
        historyEnd: Math.max(-Infinity, ...rows.filter((r) => r.empty).map((r) => Number(r.end_time))),
      };
    },

    /** Queues a window for the next flush. A series' latest window replaces its previous one. */
    put(w: CandleWindow): void {
      pending.push(w);
      if (pending.length > MAX_UNWRITTEN) pending.splice(0, pending.length - MAX_UNWRITTEN);
    },

    /** Writes the queued windows: the latest ones replace their series' previous one, then all are upserted, then the
     *  series that gained a settled window are evicted beyond KEEP_BARS (oldest fetched first). A failed write keeps
     *  them for the next flush. Returns whether everything queued was written. */
    async flush(): Promise<boolean> {
      if (!pending.length) return true;
      const batch = [...new Map(pending.map((w) => [`${seriesKey(w)}:${w.start}`, w])).values()]; // one row per key: the last queued
      pending = [];
      try {
        await track(async () => {
          const latest = [...new Map(batch.filter((w) => !w.settled).map((w) => [seriesKey(w), w])).values()];
          if (latest.length) {
            await sql`delete from candle_windows w
              using unnest(${latest.map((w) => w.symbol)}::text[], ${latest.map((w) => w.res)}::int[], ${latest.map((w) => w.start)}::bigint[]) as v(symbol, resolution, start_time)
              where w.symbol = v.symbol and w.resolution = v.resolution and not w.settled and w.start_time <> v.start_time`;
          }
          await sql`insert into candle_windows ${sql(batch.map((w) => ({
            symbol: w.symbol, resolution: w.res, start_time: w.start, end_time: w.end, candles: JSON.stringify(w.candles), fetched_at: new Date(w.at).toISOString(), settled: w.settled,
          })))} on conflict (symbol, resolution, start_time) do update
            set end_time = excluded.end_time, candles = excluded.candles, fetched_at = excluded.fetched_at, settled = excluded.settled`;
          const grown = [...new Map(batch.filter((w) => w.settled).map((w) => [seriesKey(w), w])).values()];
          if (grown.length) {
            // A settled window goes once the ones fetched after it already hold KEEP_BARS bars of the series.
            await sql`delete from candle_windows w using (
                select symbol, resolution, start_time,
                  sum(bars) over (partition by symbol, resolution order by fetched_at desc, start_time rows between unbounded preceding and current row) - bars as before
                from (
                  select symbol, resolution, start_time, fetched_at, (end_time - start_time) / resolution + 1 as bars from candle_windows
                  where settled and (symbol, resolution) in (select * from unnest(${grown.map((w) => w.symbol)}::text[], ${grown.map((w) => w.res)}::int[]))
                ) s) s
              where w.symbol = s.symbol and w.resolution = s.resolution and w.start_time = s.start_time and s.before >= ${KEEP_BARS}`;
            stored = (await sql<{ count: number }[]>`select count(*)::int as count from candle_windows where settled`)[0]!.count;
          }
        });
        return true;
      } catch {
        pending = batch.concat(pending).slice(-MAX_UNWRITTEN);
        return false;
      }
    },

    /** Settled windows in the table, as of the last flush or boot. */
    stored: () => stored,
  };
}
