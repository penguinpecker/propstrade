// Props.trade's own record of GMTrade's live index price: one OHLC bar a minute per market, kept for good in price_bars
// (the 1m and 3m charts' history starts with it, 2026-09-23; about 300 MB per 30 days for 68 markets).
// Charts fall back to it while GMTrade's candle service is slow or down (index.ts), so they never depend on it alone.
import type { Candle, PriceTick } from '@props/shared';
import type { Sql } from '../../db/client.js';

const MAX_UNWRITTEN = 50_000; // about 12 hours of minutes for every market while the database is unreachable

export type PriceRecord = ReturnType<typeof createPriceRecord>;

export function createPriceRecord(sql: Sql) {
  const building = new Map<string, Candle>(); // the current minute, by symbol
  let finished: { symbol: string; bar: Candle }[] = [];

  return {
    add(tick: PriceTick): void {
      const price = Number(tick.mid);
      if (!(price > 0) || !Number.isFinite(price)) return;
      const time = Math.floor(tick.ts / 60_000) * 60;
      const bar = building.get(tick.symbol);
      if (bar && time < bar.time) return; // an older tick
      if (bar && time === bar.time) {
        bar.high = Math.max(bar.high, price);
        bar.low = Math.min(bar.low, price);
        bar.close = price;
        return;
      }
      if (bar) finished.push({ symbol: tick.symbol, bar });
      building.set(tick.symbol, { time, open: price, high: price, low: price, close: price });
    },

    /** Writes finished minutes. A minute already written (by the process before a restart) is merged, keeping its open. */
    async flush(): Promise<void> {
      if (!finished.length) return;
      const batch = finished;
      finished = [];
      try {
        await sql`insert into price_bars ${sql(batch.map(({ symbol, bar }) => ({
          symbol, t: bar.time, open: String(bar.open), high: String(bar.high), low: String(bar.low), close: String(bar.close),
        })))} on conflict (symbol, t) do update set high = greatest(price_bars.high, excluded.high),
          low = least(price_bars.low, excluded.low), close = excluded.close`;
      } catch (err) {
        finished = batch.concat(finished).slice(-MAX_UNWRITTEN); // written by the next flush
        throw err;
      }
    },

    /** Recorded minutes as `res`-second candles whose start is in [from, to], oldest first. */
    async candles(symbol: string, res: number, from: number, to: number): Promise<Candle[]> {
      const rows = await sql<{ time: string; open: string; high: string; low: string; close: string }[]>`
        select (t / ${res}) * ${res} as time, (array_agg(open order by t))[1] as open, max(high) as high, min(low) as low,
          (array_agg(close order by t desc))[1] as close
        from price_bars where symbol = ${symbol} and t >= ${from} and t < ${to + res}
        group by 1 order by 1`;
      return rows.map((r) => ({ time: Number(r.time), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
    },
  };
}

/**
 * GMTrade's candles where it has them, recorded ones where it has none. From GMTrade's last candle on (it may have
 * been copied mid-bucket) a recorded candle wins.
 */
export function mergeCandles(gmtrade: Candle[], recorded: Candle[]): Candle[] {
  const byTime = new Map(recorded.map((c) => [c.time, c]));
  const last = gmtrade.at(-1)?.time ?? -Infinity;
  for (const c of gmtrade) if (c.time < last || !byTime.has(c.time)) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
