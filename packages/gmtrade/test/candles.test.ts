// Derived candle intervals, offline: bucket alignment (weeks from Monday 00:00 UTC, months by the calendar) and the
// roll-up of finer bars (open first, high max, low min, close last; a leading bucket only when its start is covered).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '@props/shared';
import { DERIVED_FROM, INTERVAL_SECONDS, NATIVE_INTERVALS, aggregateCandles, bucketNext, bucketStart } from '../src/index.ts';

const utc = (y: number, m: number, d = 1, h = 0, min = 0, s = 0) => Date.UTC(y, m - 1, d, h, min, s) / 1000;
/** `n` bars of `res` seconds from `from`: open = index, high = index + 2, low = index − 1, close = bucket time. */
const series = (from: number, res: number, n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ time: from + i * res, open: i, high: i + 2, low: i - 1, close: from + i * res }));

test('buckets: spans from the epoch, weeks from Monday 00:00 UTC, months by the calendar', () => {
  const t = utc(2026, 9, 25, 13, 7, 9); // a Friday
  assert.equal(bucketStart('30m', t), utc(2026, 9, 25, 13));
  assert.equal(bucketNext('30m', t), utc(2026, 9, 25, 13, 30));
  assert.equal(bucketStart('12h', t), utc(2026, 9, 25, 12));
  assert.equal(bucketStart('1W', t), utc(2026, 9, 21), 'the Monday before');
  assert.equal(bucketNext('1W', t), utc(2026, 9, 28));
  assert.equal(bucketStart('1W', utc(2026, 9, 21)), utc(2026, 9, 21), 'Monday 00:00 opens its own week');
  assert.equal(bucketStart('1W', utc(2026, 9, 20, 23, 59, 59)), utc(2026, 9, 14), 'Sunday 23:59:59 is still the week before');
  assert.equal(bucketStart('1M', t), utc(2026, 9));
  assert.equal(bucketNext('1M', t), utc(2026, 10));
  assert.equal(bucketNext('1M', utc(2026, 12, 31, 23)), utc(2027, 1), 'December rolls into the next year');
  assert.equal(bucketStart('1M', utc(2028, 2, 29, 23, 59)), utc(2028, 2), 'a leap day');
  assert.deepEqual([bucketStart('1M', utc(2026, 2, 1)), bucketNext('1M', utc(2026, 2, 1))], [utc(2026, 2), utc(2026, 3)], 'a 28-day month');
  for (const interval of NATIVE_INTERVALS) assert.equal(DERIVED_FROM[interval], undefined, `${interval} is native`);
  // Every derived bucket starts on a source bucket boundary, so the server's source window is bucket-aligned.
  for (const [interval, source] of Object.entries(DERIVED_FROM) as [keyof typeof DERIVED_FROM, NonNullable<(typeof DERIVED_FROM)[keyof typeof DERIVED_FROM]>][]) {
    const res = source === 'record' ? 60 : INTERVAL_SECONDS[source];
    for (const at of [t, utc(2026, 1, 1), utc(2027, 3, 31, 23, 59, 59)]) {
      assert.equal(bucketStart(interval, at) % res, 0, `${interval} from ${source} at ${at}`);
      assert.equal(bucketNext(interval, at) % res, 0, `${interval} from ${source} at ${at}`);
      assert.ok(bucketStart(interval, at) <= at && at < bucketNext(interval, at), `${interval} holds ${at}`);
    }
  }
});

test('aggregate: 30m from 15m and 12h from 1h, bucket-aligned, open first / high max / low min / close last', () => {
  const half = 1_800_000_000; // a 30m boundary
  assert.deepEqual(aggregateCandles(series(half, 900, 6), '30m', half), [
    { time: half, open: 0, high: 3, low: -1, close: half + 900 },
    { time: half + 1_800, open: 2, high: 5, low: 1, close: half + 2_700 },
    { time: half + 3_600, open: 4, high: 7, low: 3, close: half + 4_500 },
  ]);
  const day = 1_799_971_200; // a day boundary, so a 12h one
  const twelve = aggregateCandles(series(day, 3_600, 30), '12h', day);
  assert.deepEqual(twelve.map((c) => c.time), [day, day + 43_200, day + 86_400]);
  assert.deepEqual(twelve[1], { time: day + 43_200, open: 12, high: 25, low: 11, close: day + 23 * 3_600 });
  assert.deepEqual(twelve[2], { time: day + 86_400, open: 24, high: 31, low: 23, close: day + 29 * 3_600 }, 'the bucket in progress is kept');
  const source = series(half, 900, 6);
  const before = structuredClone(source);
  aggregateCandles(source, '30m', half);
  assert.deepEqual(source, before, 'the source bars are not changed');
});

test('aggregate: a leading bucket is dropped only when the source window does not reach its start; a trailing partial one stays', () => {
  const half = 1_800_000_000;
  const midway = series(half + 900, 900, 5); // starts on the second 15m bar of the first 30m bucket
  assert.deepEqual(aggregateCandles(midway, '30m', half + 900).map((c) => c.time), [half + 1_800, half + 3_600], 'the window starts inside the first bucket: dropped');
  assert.deepEqual(aggregateCandles(midway, '30m', half).map((c) => c.time), [half, half + 1_800, half + 3_600], 'the window covers its start (a market closed then): kept');
  assert.deepEqual(aggregateCandles(midway, '30m', half)[0], { time: half, open: 0, high: 2, low: -1, close: half + 900 });
  assert.deepEqual(aggregateCandles(series(half, 900, 5), '30m', half).at(-1), { time: half + 3_600, open: 4, high: 6, low: 3, close: half + 3_600 }, 'one bar so far');
  assert.deepEqual(aggregateCandles([], '30m', half), []);
});

test('aggregate: weeks from days start on Monday, months from days on the 1st', () => {
  const wed = utc(2026, 9, 23); // Wednesday
  const weeks = aggregateCandles(series(wed, 86_400, 12), '1W', wed); // Wed 23 Sep .. Sun 4 Oct
  assert.deepEqual(weeks, [{ time: utc(2026, 9, 28), open: 5, high: 13, low: 4, close: utc(2026, 10, 4) }], 'the week of the 21st is not covered from Monday: dropped');
  const fromMonday = aggregateCandles(series(utc(2026, 9, 21), 86_400, 9), '1W', utc(2026, 9, 21));
  assert.deepEqual(fromMonday.map((c) => [c.time, c.open, c.close]), [[utc(2026, 9, 21), 0, utc(2026, 9, 27)], [utc(2026, 9, 28), 7, utc(2026, 9, 29)]]);
  const months = aggregateCandles(series(utc(2026, 1, 15), 86_400, 60), '1M', utc(2026, 1, 15)); // 15 Jan .. 15 Mar
  assert.deepEqual(months, [
    { time: utc(2026, 2), open: 17, high: 46, low: 16, close: utc(2026, 2, 28) },
    { time: utc(2026, 3), open: 45, high: 61, low: 44, close: utc(2026, 3, 15) },
  ], 'January, covered from the 15th only, is dropped; February is whole; March is in progress');
});

test('aggregate: 3m from one-minute bars, three to a bucket from a multiple of 180 s; 1m is the record itself', () => {
  const m = 1_800_000_000; // a multiple of 180
  const minutes = series(m, 60, 7);
  const three = aggregateCandles(minutes, '3m', m);
  assert.deepEqual(three.map((c) => c.time), [m, m + 180, m + 360]);
  assert.deepEqual(three[1], { time: m + 180, open: 3, high: 7, low: 2, close: m + 300 });
  assert.deepEqual(aggregateCandles(series(m + 60, 60, 6), '3m', m + 60).map((c) => c.time), [m + 180, m + 360], 'a record starting mid-bucket: its first bucket is dropped');
  const one = aggregateCandles(minutes, '1m', m);
  assert.deepEqual(one, minutes);
  assert.notEqual(one[0], minutes[0], 'new bar objects');
});
