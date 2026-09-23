// Live checks against GMTrade's public services (PROPS_OFFLINE=1 skips). They tolerate listing
// changes (counts are logged, not pinned) but fail on anything that does not parse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KeeperFeed, NAMES, buildCatalog, decodePosition, fetchCandles, fetchOrderRemovals, fetchPairs, fetchTradeEvents, fetchTxSignatures,
  fetchUser, positionAddress,
} from '../src/index.ts';

const skip = process.env.PROPS_OFFLINE === '1';
const DECIMAL = /^-?\d+(\.\d+)?$/;
const SOL_INDEX = 'So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH';
const SOL_POOL = '6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc';

async function until(check: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('live catalog: every GMTrade asset becomes a valid Market row (68 assets / 93 pools on 2026-09-23)', { skip, timeout: 90_000 }, async () => {
  const feed = new KeeperFeed();
  await feed.start();
  try {
    await until(() => feed.mode === 'ws', 20_000);
    const ticks: string[] = [];
    feed.onTick((t) => ticks.push(t.pubkey));
    await until(() => ticks.length > 0, 10_000);
    await feed.refreshAccounts();

    const pairs = new Map((await fetchPairs()).map((p) => [p.pool_id, p]));
    const errors: unknown[] = [];
    const rows = buildCatalog({
      feed, pairs, opens24h: new Map(), now: Date.now(), onError: (m, e) => errors.push([m, e]),
      limits: () => ({ tradable: false, unavailableReason: 'test', maxLeverage: 10_000, closedMaxLeverage: null }),
    });
    const pools = rows.reduce((n, r) => n + r.pools.length, 0);
    const byCategory: Record<string, number> = {};
    for (const r of rows) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    console.log(`${rows.length} assets from ${pools} pools:`, byCategory);
    assert.deepEqual(errors, []);
    assert.ok(rows.length >= 55 && rows.length <= 120, `${rows.length} assets`);
    assert.ok(pools >= rows.length && pools >= 80, `${pools} pools`);
    assert.equal(new Set(rows.map((r) => r.symbol)).size, rows.length);

    for (const r of rows) {
      assert.match(r.pair, /^\S+ \/ \S+$/, r.symbol);
      assert.ok(r.name.length > 0 && Number.isInteger(r.priceDecimals), r.symbol);
      assert.ok(r.pools.some((p) => p.marketToken === r.marketToken), r.symbol);
      assert.ok(r.maxLeverage >= 1, `${r.symbol} venue leverage`);
      for (const v of [r.price, r.volume24h, r.openInterestLong, r.openInterestShort, r.capacityLong, r.capacityShort, r.poolLiquidity]) {
        if (v !== null) assert.match(v, DECIMAL, r.symbol);
      }
    }
    assert.ok(rows.filter((r) => r.price !== null && r.poolLiquidity !== null).length >= rows.length * 0.9);
    for (const s of ['BTC', 'ETH', 'SOL', 'XAU', 'EUR', 'NVDA']) {
      const r = rows.find((x) => x.symbol === s);
      assert.ok(r?.pools.find((p) => p.marketToken === r.marketToken)?.pure, `${s} trades on a pure pool`);
    }
    // Crypto groups come from GMTrade; the curated groups must cover every live listing (else it shows under 'Other').
    const bySubcategory: Record<string, number> = {};
    for (const r of rows) {
      const key = `${r.category} › ${r.subcategory}`;
      bySubcategory[key] = (bySubcategory[key] ?? 0) + 1;
    }
    console.log('sub-categories:', bySubcategory);
    assert.ok(rows.every((r) => r.subcategory.length > 0));
    const uncurated = rows.filter((r) => r.category !== 'Crypto' && r.subcategory === 'Other').map((r) => r.symbol);
    assert.deepEqual(uncurated, [], `add ${uncurated.join(', ')} to GROUPS in src/metadata.ts`);
    // categoryOf and subcategoryOf read a listing without a GMTrade category as Crypto › Other, whatever the asset is.
    const listed = new Set(rows.map((r) => r.symbol));
    const uncategorised = [...feed.tokens.values()].filter((t) => t.meta && listed.has(t.meta.name) && !t.meta.category).map((t) => t.meta!.name);
    assert.deepEqual(uncategorised, [], `GMTrade lists ${uncategorised.join(', ')} without a category, so it shows as Crypto › Other`);
    const unnamed = rows.filter((r) => !(r.symbol in NAMES)).map((r) => r.symbol);
    if (unnamed.length) console.log('new listings without a curated name:', unnamed.join(', '));
  } finally {
    feed.stop();
  }
});

test('live candles: 15m buckets equal the 5m buckets they cover', { skip, timeout: 30_000 }, async () => {
  const to = Math.floor(Date.now() / 1000);
  const [m15, m5, h4] = await Promise.all([
    fetchCandles(SOL_INDEX, 900, to - 3 * 3600, to), fetchCandles(SOL_INDEX, 300, to - 3 * 3600 - 900, to),
    fetchCandles(SOL_INDEX, 14_400, to - 3 * 86_400, to),
  ]);
  assert.ok(m15.length >= 10 && h4.length >= 12);
  for (const c of [...m15, ...m5, ...h4]) assert.ok(c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close) && c.low > 0);
  assert.ok(h4.every((c) => c.time % 14_400 === 0));
  for (const c of m15.slice(0, -1)) {
    const parts = m5.filter((x) => x.time >= c.time && x.time < c.time + 900);
    assert.equal(parts.length, 3, `5m candles for ${c.time}`);
    assert.deepEqual(c, {
      time: c.time, open: parts[0]!.open, close: parts[2]!.close,
      high: Math.max(...parts.map((p) => p.high)), low: Math.min(...parts.map((p) => p.low)),
    });
  }
});

test('live subsquid + keeper: an owner\'s fills, positions and Position accounts agree', { skip, timeout: 60_000 }, async () => {
  const recent = await fetchTradeEvents({ marketTokens: [SOL_POOL] }, 20);
  assert.ok(recent.length > 0);
  assert.ok(recent.every((e, i) => e.marketToken === SOL_POOL && (i === 0 || e.id < recent[i - 1]!.id)));
  const owner = recent.find((e) => e.after.sizeInUsd > 0n)!.user;

  const history = await fetchTradeEvents({ user: owner }, 20);
  assert.ok(history.length > 0 && history.every((e) => e.user === owner));
  for (const e of history) assert.ok(e.prices.index.min > 0n && e.prices.index.min <= e.prices.index.max && e.executionPrice > 0n);

  let checked = 0;
  for (const user of [...new Set(recent.filter((e) => e.after.sizeInUsd > 0n).map((e) => e.user))].slice(0, 5)) {
    const { positions } = await fetchUser(user);
    for (const p of positions.filter((x) => x.data)) {
      const decoded = decodePosition(p.data!);
      assert.equal(decoded.owner, user);
      assert.equal(decoded.state.size_in_usd.toString(), p.size);
      assert.equal(decoded.state.collateral_amount.toString(), p.collateralAmount);
      assert.equal(positionAddress(user, decoded.market_token, decoded.collateral_token, decoded.kind === 1), p.pubkey);
      checked++;
    }
  }
  assert.ok(checked > 0, 'no open position found among recent traders');
});

test('live subsquid: incremental fills, their transactions and why their orders were removed', { skip, timeout: 60_000 }, async () => {
  const [newest, older] = await fetchTradeEvents({ marketTokens: [SOL_POOL] }, 2);
  const after = await fetchTradeEvents({ marketTokens: [SOL_POOL], afterId: older!.id }, 50);
  assert.ok(after.some((e) => e.id === newest!.id) && after.every((e) => e.id > older!.id));

  const signatures = await fetchTxSignatures([newest!.id, older!.id]);
  for (const id of [newest!.id, older!.id]) assert.match(signatures.get(id) ?? '', /^[1-9A-HJ-NP-Za-km-z]{64,88}$/);

  const removals = await fetchOrderRemovals([newest!.order]);
  assert.equal(removals.length, 1);
  assert.deepEqual([removals[0]!.order, removals[0]!.state], [newest!.order, 'Completed']);
});

test('live market-info: one row per pool', { skip, timeout: 30_000 }, async () => {
  const pairs = await fetchPairs();
  assert.ok(pairs.length >= 80);
  for (const p of pairs) assert.ok(p.pool_id.length >= 32 && Number.isFinite(p.target_volume) && p.target_volume >= 0, p.ticker_id);
  assert.ok(pairs.some((p) => p.pool_id === SOL_POOL));
});
