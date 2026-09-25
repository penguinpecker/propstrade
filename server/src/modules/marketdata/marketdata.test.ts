// marketdata module through Fastify inject against live GMTrade services (PROPS_OFFLINE=1 skips the
// live tests). The Props allowlist is served by a local JSON-RPC stub holding MarketConfig accounts encoded by the
// props_vault client in @props/sdk. The candle cache and pre-warm run against a stand-in feed and candle service on
// node's mock timers, which move the clock across bucket boundaries; the candle history table tests add a real
// Postgres (TEST_DATABASE_URL, as the other module suites; skipped without it).
import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { inflateSync } from 'node:zlib';
import BN from 'bn.js';
import Fastify from 'fastify';
import { Connection, PublicKey } from '@solana/web3.js';
import type { ApiError, Candle, CandleInterval, CandlesResponse, Market, MarketTrade, PriceImpactQuote, PriceTick, StreamEvent } from '@props/shared';
import { model, type MarketStatus } from '@props/gmsol-wasm';
import {
  IdlCoder, INTERVAL_SECONDS, NATIVE_INTERVALS, NO_ACCOUNT, USDC_MINT, base58Encode, decodeMarket, findProgramAddress, getMultipleAccounts,
  parseFixed, priceString, pubkeyBytes, storeIdl, usdString, venueLimits, type Idl, type KeeperMarket, type KeeperToken,
} from '@props/gmtrade';
import { PropsVaultClient } from '@props/sdk';
import { createDb, type Sql } from '../../db/client.ts';
import { runMigrations } from '../../db/migrate.ts';
import { recreateDatabase, testDatabaseUrl } from '../../../test/db.ts';
import type { ModuleContext } from '../types.ts';
import register, { candleCacheTtl, candleWindow, changedForDisplay, createMarketData, type MarketDataOptions } from './index.ts';
import { withPosition } from '../sim/model.ts';
import { fetchAllowlist, marketConfigAddress } from './allowlist.ts';
import { covers, createHistoryStore } from './history.ts';
import { createUpstreams, why } from './upstreams.ts';

const skip = process.env.PROPS_OFFLINE === '1';
const dbSkip = !process.env.TEST_DATABASE_URL;
/** Real time, whatever the mock clock says: lets database I/O land between mock ticks. */
const realSetTimeout = setTimeout;
const io = (ms = 30) => new Promise<void>((r) => realSetTimeout(r, ms));
const PROGRAM_ID = base58Encode(createHash('sha256').update('props-vault-test-program').digest());
const SOL_POOL = '6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc';
const BTC_POOL = 'Dqq58gS1TgRMDouUbdvhhzc51XXTNHG921WLxH9X2eB8';
const DECIMAL = /^-?\d+(\.\d+)?$/;

// ---- local RPC stub with MarketConfig accounts ----
const vaultCoder = new PropsVaultClient(new Connection('http://127.0.0.1:1')).program.coder.accounts;

/** A MarketConfig account image exactly as props_vault writes it (Anchor's coder over the bundled IDL). */
async function marketConfig(marketToken: string, enabled: boolean, symbol: string, maxBps: number, closedBps: number): Promise<Buffer> {
  const indexSymbol = Buffer.alloc(16);
  indexSymbol.write(symbol);
  return vaultCoder.encode('marketConfig', {
    marketToken: new PublicKey(marketToken), gmMarket: PublicKey.default, enabled, indexSymbol: [...indexSymbol], maxLeverageBps: maxBps,
    closedMaxLeverageBps: closedBps, maxPositionUsd: new BN(10_000_000_000), maxTotalOiUsd: new BN(50_000_000_000), oiLongUsd: new BN(0),
    oiShortUsd: new BN(0), sessionRestricted: false, bump: 255,
  });
}

/** Anchor's IDL account: createWithSeed(PDA([], program), "anchor:idl", program); data = disc, authority, u32 len, zlib JSON. */
async function fetchAnchorIdl(rpcUrl: string, programId: string): Promise<Idl> {
  const base = pubkeyBytes(findProgramAddress([], programId));
  const address = base58Encode(createHash('sha256').update(base).update('anchor:idl').update(pubkeyBytes(programId)).digest());
  const [data] = (await getMultipleAccounts(rpcUrl, [address])).accounts;
  if (!data) throw new Error(`program ${programId} has no Anchor IDL account (${address})`);
  const buf = Buffer.from(data, 'base64');
  return JSON.parse(inflateSync(buf.subarray(44, 44 + buf.readUInt32LE(40))).toString('utf8')) as Idl;
}

async function rpcStub(accounts: Map<string, Buffer>): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: [string[]] };
      assert.equal(method, 'getMultipleAccounts');
      const value = params[0].map((k) => {
        const d = accounts.get(k);
        return d ? { data: [d.toString('base64'), 'base64'], owner: PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 } : null;
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { context: { slot: 1 }, value } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, server };
}

async function allowlistAccounts(): Promise<Map<string, Buffer>> {
  return new Map([
    [marketConfigAddress(PROGRAM_ID, SOL_POOL), await marketConfig(SOL_POOL, true, 'SOL', 200_000, 80_000)],
    [marketConfigAddress(PROGRAM_ID, BTC_POOL), await marketConfig(BTC_POOL, false, 'BTC', 250_000, 80_000)],
    // Lamports sent to an unused MarketConfig address leave a data-less system account there.
    [marketConfigAddress(PROGRAM_ID, 'DAY6Qr1FKgJQFvjJAhFUZUWHzx8UbbbkRmt6G6AYswWG'), Buffer.alloc(0)],
  ]);
}

async function start(env: Record<string, string>) {
  const app = Fastify({ logger: false });
  const events: { at: number; event: StreamEvent }[] = [];
  const abort = new AbortController();
  const ctx: ModuleContext = {
    app, log: app.log, env, services: {}, signal: abort.signal,
    publish: (event) => events.push({ at: Date.now(), event }),
    config: {} as never, db: {} as never, sql: {} as never, rpc: {} as never, notify: async () => {}, // marketdata reads only env
  };
  const service = await register(ctx);
  await app.ready();
  const beforeReady = (await app.inject({ method: 'GET', url: '/v1/markets' })).statusCode;
  await service.ready();
  const get = async <T>(url: string) => {
    const res = await app.inject({ method: 'GET', url });
    return { status: res.statusCode, body: res.json() as T };
  };
  return { app, service, events, get, beforeReady, stop: async () => (abort.abort(), app.close()) };
}

// ---- stand-in GMTrade for the candle cache tests: nine markets (SOL allowlisted, the rest not), no price stream ----
const SOL_INDEX = 'So11111111111111111111111111111111111111112';
const BTC_INDEX = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
const fakeKey = (seed: string) => base58Encode(createHash('sha256').update(seed).digest());
const STUB_MARKETS = [
  { symbol: 'SOL', pool: SOL_POOL, index: SOL_INDEX, decimals: 9, usd: 200n },
  { symbol: 'BTC', pool: BTC_POOL, index: BTC_INDEX, decimals: 8, usd: 100_000n },
  // Seven more, so a full fill of a resolution takes two batches (eight tokens at most each).
  ...Array.from({ length: 7 }, (_, i) => ({ symbol: `M${i + 1}`, pool: fakeKey(`pool-${i}`), index: fakeKey(`index-${i}`), decimals: 9, usd: 10n })),
];
/** Index tokens in catalog order (rows sort by symbol), as the pre-warm lists them. */
const INDEX_ORDER = [...STUB_MARKETS].sort((a, b) => a.symbol.localeCompare(b.symbol)).map((m) => m.index);
/** Resolutions in the order the pre-warm fills them (the app's default interval first, then 5m for the 24h change). */
const PREWARM = [3_600, 300, 900, 14_400, 86_400];

/** A feed already holding the markets' metadata and one price each (unit prices: USD × 10^(20 − decimals)); `tick`
 *  delivers a new price for a market, as the keeper stream would. */
function stubFeed(nowSec: number) {
  const tokens = new Map<string, KeeperToken>();
  const markets = new Map<string, KeeperMarket>();
  const unitPrice = (m: (typeof STUB_MARKETS)[number], usd: bigint) => String(usd * 10n ** BigInt(20 - m.decimals));
  for (const m of STUB_MARKETS) {
    const unit = unitPrice(m, m.usd);
    tokens.set(m.index, {
      pubkey: m.index, price: { ts: nowSec, min: unit, max: unit, isOpen: true },
      meta: { name: m.symbol, decimals: m.decimals, precision: 4, isEnabled: true, isSynthetic: false, category: 'Layer 1 & 2', indexName: null, uiSymbol: m.symbol, uiName: null, launchTime: null, expectedProvider: 'pyth' },
    });
    markets.set(m.pool, {
      marketToken: m.pool, pubkey: m.pool, slot: null, data: null, virtualInventoryForSwaps: NO_ACCOUNT, virtualInventoryForPositions: NO_ACCOUNT,
      meta: { name: `${m.symbol}/USD[USDC-USDC]`, isPure: true, isEnabled: true, indexToken: { pubkey: m.index }, longToken: { pubkey: USDC_MINT }, shortToken: { pubkey: USDC_MINT } },
    });
  }
  const listeners = new Set<(token: KeeperToken) => void>();
  const feed: NonNullable<MarketDataOptions['feed']> = {
    tokens, markets, accounts: new Map(), mode: 'ws', onTick: (fn) => (listeners.add(fn), () => listeners.delete(fn)), start: async () => {}, stop: () => {},
  };
  const tick = (symbol: string, usd: bigint, isOpen = true) => {
    const m = STUB_MARKETS.find((x) => x.symbol === symbol)!;
    const token = tokens.get(m.index)!;
    const unit = unitPrice(m, usd);
    token.price = { ts: Math.floor(Date.now() / 1000), min: unit, max: unit, isOpen };
    for (const fn of listeners) fn(token);
  };
  return { feed, tick };
}

/** A candle service that records every call and answers with synthetic candles whose `open` is the call's number (so a
 *  response says which call it came from) and whose `close` is the bucket time, from `since` on (its history start:
 *  nothing before). The calls `hang` matches (single-token ones, for `true`) wait until `release` resolves or rejects
 *  them; a batch call `fail` matches is rejected, and a batch answer leaves the `omit`ted token out. */
function stubCandles() {
  type Call = { batch: boolean; tokens: string[]; res: number; from: number; to: number };
  const calls: Call[] = [];
  let hanging: (call: Call) => boolean = () => false;
  let failing: (call: Call) => boolean = () => false;
  let omitted = '';
  let since = 0;
  let pending: ((ok: boolean) => void)[] = [];
  const bars = (from: number, to: number, res: number, tag: number): Candle[] => {
    const out: Candle[] = [];
    for (let time = from; time <= to; time += res) if (time >= since) out.push({ time, open: tag, high: tag, low: tag, close: time });
    return out;
  };
  /** `answer()` now, or once `release` lets a hanging call go. */
  const answer = <T>(call: Call, value: () => T): Promise<T> => (hanging(call)
    ? new Promise<T>((resolve, reject) => pending.push((ok) => (ok ? resolve(value()) : reject(new Error('candle service down')))))
    : Promise.resolve(value()));
  const gm: MarketDataOptions['gm'] = {
    fetchPairs: async () => [],
    fetchCandles: (token, res, from, to) => {
      const call = { batch: false, tokens: [token], res, from, to };
      calls.push(call);
      const tag = calls.length;
      return answer(call, () => bars(from, to, res, tag));
    },
    fetchCandlesBatch: async (tokens, res, from, to) => {
      const call = { batch: true, tokens, res, from, to };
      calls.push(call);
      const tag = calls.length;
      if (failing(call)) throw new Error('candle service down');
      return answer(call, () => new Map(tokens.filter((t) => t !== omitted).map((t) => [t, bars(from, to, res, tag)])));
    },
  };
  return {
    gm, calls,
    single: () => calls.filter((c) => !c.batch),
    /** The backfill's calls: single-token pages aligned to multiples of their span. */
    pages: () => calls.filter((c) => !c.batch && c.from % (300 * c.res) === 0 && c.to - c.from === 299 * c.res),
    since: (time: number) => { since = time; },
    hang: (when: boolean | ((call: Call) => boolean)) => { hanging = typeof when === 'boolean' ? (c) => when && !c.batch : when; },
    fail: (when: (call: Call) => boolean) => { failing = when; },
    omit: (token: string) => { omitted = token; },
    pendingCount: () => pending.length,
    release: (ok: boolean) => {
      const list = pending;
      pending = [];
      for (const settle of list) settle(ok);
    },
  };
}

/** A logger that keeps the warnings' messages, for what the module logs once per outage. */
function recordingLog(warnings: string[]): ModuleContext['log'] {
  const noop = () => {};
  const log = { level: 'warn', silent: noop, fatal: noop, error: noop, info: noop, debug: noop, trace: noop, child: () => log, warn: (obj: unknown, msg?: string) => { warnings.push(msg ?? String(obj)); } };
  return log as unknown as ModuleContext['log'];
}

/** The module on the mock clock as it stands, the stand-in feed and candle service, the RPC stub, and the candle
 *  history table when `sql` is a real database (else its writes fail quietly, as they would with the database down;
 *  `warnings` collects what is logged). */
async function stubbedModule(t: TestContext, opts: { sql?: Sql; warnings?: string[] } = {}) {
  const { url, server } = await rpcStub(await allowlistAccounts());
  const app = Fastify({ logger: false });
  const abort = new AbortController();
  const candles = stubCandles();
  const events: StreamEvent[] = [];
  const ctx: ModuleContext = {
    app, log: opts.warnings ? recordingLog(opts.warnings) : app.log, env: { PROGRAM_ID, RPC_URL: url }, services: {}, signal: abort.signal,
    publish: (event) => events.push(event),
    config: {} as never, db: {} as never, sql: opts.sql ?? ({} as never), rpc: {} as never, notify: async () => {},
  };
  const { feed, tick } = stubFeed(Math.floor(Date.now() / 1000));
  const service = await createMarketData(ctx, { feed, gm: candles.gm });
  await app.ready();
  await service.ready();
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; abort.abort(); await app.close(); server.close(); };
  t.after(stop);
  const get = async <T>(path: string) => {
    const res = await app.inject({ method: 'GET', url: path });
    return { status: res.statusCode, body: res.json() as T, headers: res.headers };
  };
  const settle = () => new Promise((r) => setImmediate(r));
  /** Moves the clock ahead a second at a time, letting each timer's asynchronous work finish before the next second
   *  (with a database, its I/O too). */
  const advance = async (seconds: number) => { for (let i = 0; i < seconds; i++) { t.mock.timers.tick(1_000); await settle(); if (opts.sql) await io(); } };
  return { service, get, candles, events, feed, tick, advance, settle, stop, jump: (sec: number) => t.mock.timers.setTime(sec * 1000) };
}

/** The module on mock timers (the clock starts at `nowSec`). */
async function stubbedStart(t: TestContext, nowSec: number, opts: { sql?: Sql; warnings?: string[] } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: nowSec * 1000 });
  return stubbedModule(t, opts);
}

// ---- the candle history table: this suite's own database, migrated once, its candle tables emptied for each test ----
let historyDb: Sql | undefined;
async function freshTables(): Promise<Sql> {
  if (!historyDb) {
    const url = new URL(testDatabaseUrl());
    url.pathname += '_marketdata';
    await recreateDatabase(url.toString());
    await runMigrations(url.toString());
    historyDb = createDb(url.toString()).sql;
  }
  await historyDb`truncate candle_windows, price_bars`;
  return historyDb;
}
after(async () => { await historyDb?.end(); });

test('allowlist: MarketConfig PDAs are read and decoded with the IDL bundled in @props/sdk', async () => {
  const { url, server } = await rpcStub(await allowlistAccounts());
  try {
    const list = await fetchAllowlist(url, PROGRAM_ID, [SOL_POOL, BTC_POOL, 'DAY6Qr1FKgJQFvjJAhFUZUWHzx8UbbbkRmt6G6AYswWG', '11111111111111111111111111111111']);
    assert.deepEqual(Object.fromEntries(list), {
      [SOL_POOL]: { enabled: true, maxLeverage: 20, closedMaxLeverage: 8 },
      [BTC_POOL]: { enabled: false, maxLeverage: 25, closedMaxLeverage: 8 },
    });
  } finally {
    server.close();
  }
});

test('price pin hook: registered only under NODE_ENV=test on localnet, and only for the admin token', async () => {
  for (const [env, cluster, status] of [[{}, 'localnet', 404], [{ NODE_ENV: 'test' }, 'mainnet-beta', 404], [{ NODE_ENV: 'test' }, 'localnet', 401]] as const) {
    const app = Fastify({ logger: false });
    const abort = new AbortController();
    await register({
      app, log: app.log, env, services: {}, signal: abort.signal, publish: () => {}, notify: async () => {},
      config: { ADMIN_API_TOKEN: 'a'.repeat(32), SOLANA_CLUSTER: cluster } as never, db: {} as never, sql: {} as never, rpc: {} as never,
    });
    await app.ready();
    const res = await app.inject({ method: 'PUT', url: '/v1/test/prices/SOL', payload: { price: '1' } });
    abort.abort();
    await app.close();
    assert.equal(res.statusCode, status, `${JSON.stringify(env)} ${cluster}`);
  }
});

test('candle cache: a range is cached long only once its last bucket settled for a minute', () => {
  const boundary = 1_790_123_100; // a 5m bucket [boundary - 300, boundary) just closed
  assert.equal(candleCacheTtl(boundary, 300, boundary + 10), 5_000, 'current bucket');
  assert.equal(candleCacheTtl(boundary - 300, 300, boundary + 1), 5_000, 'closed 1 s ago: GMTrade still revises it');
  assert.equal(candleCacheTtl(boundary - 300, 300, boundary + 59), 5_000);
  assert.equal(candleCacheTtl(boundary - 300, 300, boundary + 60), 3_600_000);
  assert.equal(candleCacheTtl(boundary - 2 * 86_400, 86_400, boundary), 3_600_000, 'a daily candle closed a day ago');
});

const LIVE = 'public, s-maxage=5, stale-while-revalidate=55';
const SETTLED = 'public, s-maxage=3600, stale-while-revalidate=86400';

test('candle pre-warm: every market and interval after start, a resolution again 2 s after its bucket boundary, all at least every minute', async (t) => {
  const boundary = 1_800_000_300; // a 5m boundary that is not a 15m one
  const { get, candles, advance } = await stubbedStart(t, boundary - 30);
  await advance(1); // the first pass at boundary - 29: one small 24h-change request, then full windows in two batches (8 + 1 tokens) per resolution
  const chunks = [INDEX_ORDER.slice(0, 8), INDEX_ORDER.slice(8)];
  const dayAgo = boundary - 29 - 86_400;
  assert.deepEqual(candles.calls.map((c) => [c.batch, c.tokens, c.res, c.from, c.to]), [
    [true, INDEX_ORDER, 300, dayAgo - 3_600, dayAgo],
    ...PREWARM.flatMap((res) => { const w = candleWindow(res, boundary - 29); return chunks.map((tokens) => [true, tokens, res, w.start, w.end]); }),
  ]);
  for (const symbol of ['SOL', 'BTC', 'M7']) {
    for (const interval of NATIVE_INTERVALS) {
      const r = await get<CandlesResponse>(`/v1/candles?symbol=${symbol}&interval=${interval}`);
      assert.deepEqual([r.status, r.body.freshness, r.body.source, r.body.candles.length, r.headers['cache-control']], [200, 'live', 'venue', 300, LIVE], `${symbol} ${interval}`);
    }
  }
  assert.equal(candles.calls.length, 11, 'every latest window came from the cache');
  // A derived interval's latest window is its source's latest window rolled up: from the copy, no call of its own. The
  // bucket the copy starts inside of is left out (it would show as a whole bar); the bucket in progress is the last.
  for (const [interval, source] of [['30m', '15m'], ['2h', '1h'], ['6h', '1h'], ['12h', '1h'], ['1W', '1D'], ['1M', '1D']] as const) {
    const native = (await get<CandlesResponse>(`/v1/candles?symbol=SOL&interval=${source}`)).body.candles;
    const r = await get<CandlesResponse>(`/v1/candles?symbol=SOL&interval=${interval}`);
    assert.deepEqual([r.status, r.body.freshness, r.body.source, r.headers['cache-control']], [200, 'live', 'venue', LIVE], interval);
    assert.deepEqual(r.body.candles, rollup(native, interval).filter((c) => c.time >= native[0]!.time), interval);
    assert.equal(r.body.candles.at(-1)!.time, rollup(native.slice(-1), interval)[0]!.time, `${interval} ends at the bucket in progress`);
  }
  assert.deepEqual((await get<CandlesResponse>('/v1/candles?symbol=SOL&interval=30m')).body.candles.length, 150, '300 15m bars, the first inside a 30m bucket');
  assert.equal(candles.calls.length, 11, 'no GMTrade call for a derived window');
  // 24h change comes from the warm 5m copy: the close (= bucket time) of the last candle completed 24 h ago.
  await advance(1); // the catalog rebuilds once a second
  const open = Math.floor((boundary - 29 - 86_400 - 300) / 300) * 300;
  const rows = (await get<Market[]>('/v1/markets')).body;
  assert.equal(rows.length, 9);
  for (const row of rows) assert.ok(Math.abs(row.change24h! - ((Number(row.price) - open) / open) * 100) < 1e-9, `${row.symbol} change24h ${row.change24h}`);

  await advance(30); // boundary + 2: only the 5m key rotated; every copy is patched with the last three buckets, in one batch
  assert.equal(candles.calls.length, 12);
  assert.deepEqual(candles.calls[11], { batch: true, tokens: INDEX_ORDER, res: 300, from: boundary - 600, to: boundary });
  const sol = await get<CandlesResponse>('/v1/candles?symbol=SOL&interval=5m');
  assert.deepEqual([sol.body.freshness, sol.body.candles.length, sol.body.candles[0]!.time, sol.body.candles.at(-1)!.time], ['live', 300, boundary - 299 * 300, boundary]);
  assert.deepEqual(sol.body.candles.slice(-3).map((c) => c.open), [12, 12, 12], 'the patch replaced the last three buckets');
  assert.equal(sol.body.candles[296]!.open, 5, "the rest is the first pass (SOL was in the 5m fill's second batch, the fifth call)");
  assert.equal(candles.calls.length, 12);

  await advance(60); // boundary + 62: a minute since each resolution's last run (the other four at + 31, 5m at + 62)
  assert.deepEqual(candles.calls.slice(12).map((c) => [c.batch, c.res, c.to - c.from]), [...PREWARM.filter((r) => r !== 300), 300].map((res) => [true, res, 2 * res]));
});

test('candle pre-warm: a fill batch waits for the requests\' own candle fetches, and the app\'s default interval fills first', async (t) => {
  const boundary = 1_800_000_600;
  const { get, candles, advance, settle } = await stubbedStart(t, boundary - 61);
  candles.hang(true);
  const sol = get<CandlesResponse>('/v1/candles?symbol=SOL&interval=1h'); // nothing to show yet: waits for its own fetch
  await settle();
  assert.equal(candles.pendingCount(), 1);
  await advance(1); // the first pass: the small 24h-change request, then the 1h fill, whose first batch waits behind SOL's fetch
  assert.deepEqual(candles.calls.map((c) => [c.batch, c.res, c.to - c.from]), [[false, 3_600, 299 * 3_600], [true, 300, 3_600]]);
  candles.release(true);
  await settle();
  const r = await sol;
  assert.deepEqual([r.status, r.body.freshness, r.body.candles.length], [200, 'live', 300]);
  assert.deepEqual(candles.calls.slice(2).map((c) => [c.batch, c.res]), PREWARM.flatMap((res) => [[true, res], [true, res]]), 'then the fills, 1h first');
});

test('candles: a window with no copy waits for the pre-warm batch GMTrade is answering, then its own 4 s', async (t) => {
  const boundary = 1_800_000_600;
  const { get, candles, advance, settle } = await stubbedStart(t, boundary - 61);
  candles.hang((c) => (c.batch ? c.to - c.from > 3_600 : true)); // fills and single-token calls hang; the small 24h-change request does not
  await advance(1); // the first pass: stuck on the 1h fill's first batch (BTC and M1-M7)
  assert.deepEqual(candles.calls.slice(1).map((c) => [c.batch, c.res, c.tokens.length]), [[true, 3_600, 8]]);
  let answered = false;
  const sol = get<CandlesResponse>('/v1/candles?symbol=SOL&interval=1h').then((r) => (answered = true, r)); // no copy: its fetch queues behind the batch
  await settle();
  assert.equal(candles.single().length, 1);
  t.mock.timers.tick(4_000); // CANDLE_WAIT_MS
  await settle();
  await settle();
  assert.equal(answered, false, 'no 503 while the batch is in flight');
  candles.release(true); // the batch lands, then its own fetch
  const r = await sol;
  assert.deepEqual([r.status, r.body.freshness, r.body.candles.length], [200, 'live', 300]);
});

test('candles: a settled window nobody holds never queues behind the pre-warm batch: 503 after its own 4 s, and at once while GMTrade is down', { timeout: 20_000 }, async (t) => {
  const boundary = 1_800_000_600;
  const { get, candles, advance, settle } = await stubbedStart(t, boundary - 61);
  candles.hang((c) => (c.batch ? c.to - c.from > 3_600 : true)); // fills and single-token calls hang; the small 24h-change request does not
  await advance(1); // the first pass: stuck on the 1h fill's first batch
  const from = boundary - 20 * 86_400;
  const window = (k: number) => `/v1/candles?symbol=SOL&interval=5m&from=${from + k * 30_000}&to=${from + k * 30_000 + 99 * 300}`;
  const first = get<ApiError>(window(0));
  await settle();
  assert.equal(candles.single().length, 1, 'its own fetch runs, behind the batch');
  t.mock.timers.tick(4_000); // CANDLE_WAIT_MS, the batch still in flight
  const r = await first;
  assert.deepEqual([r.status, r.body.error.code, r.headers['retry-after']], [503, 'unavailable', '5']);
  // The batch and the fetch fail, then the next batch and another fetch: three failures, the source is down.
  candles.release(false);
  await settle();
  const second = get<ApiError>(window(1));
  await settle();
  t.mock.timers.tick(4_000);
  assert.equal((await second).status, 503);
  candles.release(false);
  await settle();
  const third = await get<ApiError>(window(2)); // no clock tick: answered at once
  assert.deepEqual([third.status, third.body.error.code, third.headers['retry-after']], [503, 'unavailable', '5']);
  assert.equal(candles.single().length, 2, 'no fetch while GMTrade is down');
});

test('candle pre-warm: a market the batch answer leaves out gets no copy, so a request fetches it', async (t) => {
  const boundary = 1_800_000_600;
  const { get, candles, advance } = await stubbedStart(t, boundary - 61);
  const m7 = STUB_MARKETS.find((m) => m.symbol === 'M7')!.index;
  candles.omit(m7);
  await advance(1);
  const r = await get<CandlesResponse>('/v1/candles?symbol=M7&interval=5m');
  assert.deepEqual([r.status, r.body.freshness, r.body.candles.length], [200, 'live', 300]);
  assert.deepEqual(candles.single().map((c) => c.tokens), [[m7]], 'one fetch of its own, not an empty copy');
});

test('24h change: a failed fill keeps every market\'s last value (on a fresh process, the small request\'s) until a copy lands', async (t) => {
  const boundary = 1_800_000_300;
  const { get, candles, advance } = await stubbedStart(t, boundary - 30);
  candles.fail((c) => c.to - c.from > 3_600); // every fill fails; the small 24h-change request (an hour's span) does not
  await advance(2); // the first pass at boundary - 29, then a catalog rebuild
  const dayAgo = boundary - 29 - 86_400;
  const change = (rows: Market[], open: number) => rows.map((row) => Math.abs(row.change24h! - ((Number(row.price) - open) / open) * 100) < 1e-9);
  const rows = (await get<Market[]>('/v1/markets')).body;
  assert.equal(rows.length, 9);
  assert.deepEqual(change(rows, dayAgo - 300), rows.map(() => true), `from the small request: ${rows.map((r) => r.change24h)}`);
  candles.fail(() => false);
  await advance(60); // the 5m fill lands at boundary + 2: the value now comes from the copy (bucket-aligned, so a bucket earlier)
  const filled = (await get<Market[]>('/v1/markets')).body;
  assert.deepEqual(change(filled, boundary - 86_700), filled.map(() => true), `from the copy: ${filled.map((r) => r.change24h)}`);
});

test('candles: a settled window a copy does not reach the end of is completed and refreshed, not served live from it', async (t) => {
  const boundary = 1_800_000_600;
  const { get, candles, advance, settle, jump } = await stubbedStart(t, boundary - 61);
  await advance(1); // the 5m copy ends at boundary - 300
  jump(boundary + 4 * 300 + 61); // four buckets later with no pre-warm since (an outage): a settled window that starts inside the copy and ends after it
  const url = `/v1/candles?symbol=SOL&interval=5m&from=${boundary - 5 * 300}&to=${boundary + 2 * 300}`;
  const r = await get<CandlesResponse>(url);
  assert.deepEqual([r.status, r.body.freshness, r.body.candles.length, r.body.candles.at(-1)!.time, r.headers['cache-control']], [200, 'delayed', 5, boundary - 300, 'no-store']);
  assert.deepEqual(candles.single().map((c) => [c.from, c.to]), [[boundary - 1_500, boundary + 600]], 'and the window is fetched');
  await settle();
  const filled = await get<CandlesResponse>(url);
  assert.deepEqual([filled.body.freshness, filled.body.candles.length, filled.headers['cache-control']], ['live', 8, SETTLED]);
});

test('candles: a miss whose series has a copy answers from it at once while the refresh fills the key', async (t) => {
  const boundary = 1_800_000_600;
  const { get, candles, advance, settle, jump } = await stubbedStart(t, boundary - 61);
  await advance(1); // warm at boundary - 60
  candles.hang(true);
  jump(boundary + 1); // the 5m key rotated and the pre-warm has not run since: a miss with the previous window's copy
  const r = await get<CandlesResponse>('/v1/candles?symbol=SOL&interval=5m');
  assert.deepEqual([r.status, r.body.freshness, r.body.candles.length, r.body.candles.at(-1)!.time, r.headers['cache-control']], [200, 'live', 299, boundary - 300, LIVE]);
  assert.deepEqual(candles.single(), [{ batch: false, tokens: [SOL_INDEX], res: 300, from: boundary - 299 * 300, to: boundary }]);
  assert.equal(candles.pendingCount(), 1, 'the refresh is still running: the answer did not wait for it');
  candles.release(true);
  await settle();
  const filled = await get<CandlesResponse>('/v1/candles?symbol=SOL&interval=5m');
  assert.deepEqual([filled.body.freshness, filled.body.candles.length, filled.body.candles.at(-1)!.time, filled.body.candles.at(-1)!.open], ['live', 300, boundary, 12]);
  assert.equal(candles.single().length, 1, 'the refreshed key is a hit');

  jump(boundary + 301); // the copy is 5 minutes old: served 'delayed', completed from the (empty) price record, not cacheable
  const old = await get<CandlesResponse>('/v1/candles?symbol=SOL&interval=5m');
  assert.deepEqual([old.status, old.body.freshness, old.body.candles.at(-1)!.time, old.headers['cache-control']], [200, 'delayed', boundary, 'no-store']);
  assert.equal(candles.single().length, 2, 'and a refresh of the new key runs');
});

test('candles: a window with no copy waits for GMTrade, then answers 503 with retry-after, and caches no failure', async (t) => {
  const boundary = 1_800_000_600;
  const { get, candles, advance, settle } = await stubbedStart(t, boundary - 61);
  await advance(1);
  candles.hang(true);
  const from = boundary - 20 * 86_400; // 20 days back: beyond every copy (the price record is empty here)
  const url = `/v1/candles?symbol=SOL&interval=5m&from=${from}&to=${from + 99 * 300}`;
  const [first, second] = [get<ApiError>(url), get<ApiError>(url)];
  await settle();
  assert.equal(candles.single().length, 1, 'one shared upstream call');
  t.mock.timers.tick(4_000); // CANDLE_WAIT_MS
  for (const r of [await first, await second]) {
    assert.deepEqual([r.status, r.body.error.code, r.headers['retry-after'], r.headers['cache-control']], [503, 'unavailable', '5', 'no-store']);
  }
  candles.release(false);
  await settle();
  candles.hang(false);
  const third = await get<CandlesResponse>(url);
  assert.deepEqual([third.status, third.body.freshness, third.body.candles.length, third.headers['cache-control']], [200, 'live', 100, SETTLED], 'a new call, not the failure');
  assert.equal(candles.single().length, 2);
  const bad = await get<ApiError>('/v1/candles?symbol=SOL&interval=7m');
  assert.deepEqual([bad.status, bad.headers['cache-control']], [400, 'no-store']);
});

// ---- the candle history table (a real Postgres) ----

/** Waits (real time, up to a second) for the database to hold what `read` looks for. */
async function untilStored<T>(read: () => Promise<T[]>): Promise<T[]> {
  let rows = await read();
  for (let i = 0; i < 50 && !rows.length; i++) { await io(20); rows = await read(); }
  return rows;
}

/** Moves `m`'s clock two seconds at a time until `check` holds, at most `maxSeconds`. */
async function advanceUntil(m: { advance: (seconds: number) => Promise<void> }, check: () => boolean, maxSeconds: number, what: string) {
  for (let s = 0; s < maxSeconds && !check(); s += 2) await m.advance(2);
  assert.ok(check(), `timed out waiting for ${what}`);
}

test('candle history: a restarted process serves every latest window live from the table before any GMTrade call, and its pre-warm only patches', { skip: dbSkip }, async (t) => {
  const sql = await freshTables();
  const boundary = 1_800_000_600;
  const first = await stubbedStart(t, boundary - 61, { sql });
  await first.advance(2); // the first pass fills every window; the history flush a second later writes the copies
  const written = await sql<{ n: number }[]>`select count(*)::int as n from candle_windows where not settled`;
  assert.equal(written[0]!.n, 45, 'one latest window per market and interval');
  assert.equal(first.service.health().candles!.history!.seriesWarmAtBoot, 0);
  await first.stop();

  first.jump(boundary - 30); // a new process 30 s later, on the same table
  const second = await stubbedModule(t, { sql });
  for (const symbol of ['SOL', 'BTC', 'M7']) {
    for (const interval of NATIVE_INTERVALS) {
      const r = await second.get<CandlesResponse>(`/v1/candles?symbol=${symbol}&interval=${interval}`);
      assert.deepEqual([r.status, r.body.freshness, r.body.source, r.body.candles.length, r.headers['cache-control']], [200, 'live', 'venue', 300, LIVE], `${symbol} ${interval}`);
    }
  }
  assert.equal(second.candles.calls.length, 0, 'no GMTrade call');
  assert.deepEqual(second.service.health().candles!.history, { seriesWarmAtBoot: 45, backfill: { seriesDone: 0, seriesTotal: 45, windowsStored: 0 } });
  await second.advance(1); // the pre-warm: one patch of the last three buckets per resolution, no full window and no 24h-change request
  assert.deepEqual(second.candles.calls.map((c) => [c.batch, c.tokens.length, c.res, c.to - c.from]), PREWARM.map((res) => [true, 9, res, 2 * res]));
  await second.advance(1); // a catalog rebuild
  const rows = (await second.get<Market[]>('/v1/markets')).body;
  assert.equal(rows.filter((row) => row.change24h !== null).length, 9, '24h change from the restored 5m copies');
});

test('candle history: a settled window the table covers answers live with the hour-long header and no GMTrade call; one fetched for a request is stored for the next process', { skip: dbSkip }, async (t) => {
  const sql = await freshTables();
  const boundary = 1_800_000_600;
  const { get, candles, advance, stop } = await stubbedStart(t, boundary - 61, { sql });
  await advance(1);
  // The third and fourth 5m pages back, as the backfill stores them, holding candles with open 77.
  const span = 300 * 300;
  const page = (k: number) => { const start = (Math.floor((boundary - 60) / span) - k) * span; return { start, end: start + 299 * 300 }; };
  const stored = (p: { start: number; end: number }) => JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ time: p.start + i * 300, open: 77, high: 77, low: 77, close: p.start + i * 300 })));
  await sql`insert into candle_windows ${sql([page(3), page(4)].map((p) => ({ symbol: 'SOL', resolution: 300, start_time: p.start, end_time: p.end, candles: stored(p), fetched_at: new Date().toISOString(), settled: true })))}`;
  const from = page(4).start + 100 * 300;
  const to = page(3).start + 49 * 300;
  const r = await get<CandlesResponse>(`/v1/candles?symbol=SOL&interval=5m&from=${from}&to=${to}`);
  assert.deepEqual([r.status, r.body.freshness, r.body.candles.length, r.body.candles[0]!.time, r.body.candles.at(-1)!.time, r.headers['cache-control']], [200, 'live', 250, from, to, SETTLED]);
  assert.ok(r.body.candles.every((c) => c.open === 77), 'from the table');
  assert.equal(candles.single().length, 0, 'no GMTrade call');
  // A window the table has a hole in (the fifth page back is missing) is fetched, and stays stored.
  const hole = { from: page(5).start + 200 * 300, to: page(4).start + 9 * 300 };
  const fetched = await get<CandlesResponse>(`/v1/candles?symbol=SOL&interval=5m&from=${hole.from}&to=${hole.to}`);
  assert.deepEqual([fetched.status, fetched.body.freshness, fetched.body.candles.length, fetched.headers['cache-control']], [200, 'live', 110, SETTLED]);
  assert.deepEqual(candles.single().map((c) => [c.from, c.to]), [[hole.from, hole.to]]);
  await advance(1); // the history flush
  const row = await untilStored(() => sql<{ settled: boolean }[]>`select settled from candle_windows where symbol = 'SOL' and resolution = 300 and start_time = ${hole.from}`);
  assert.deepEqual(row.map((x) => x.settled), [true]);
  await stop();
  const next = await stubbedModule(t, { sql });
  const again = await next.get<CandlesResponse>(`/v1/candles?symbol=SOL&interval=5m&from=${hole.from}&to=${hole.to}`);
  assert.deepEqual([again.status, again.body.freshness, again.body.candles.length, again.headers['cache-control']], [200, 'live', 110, SETTLED]);
  assert.equal(next.candles.single().length, 0, 'the next process never asks GMTrade for it');
});

test('candle history: a delayed answer (a copy completed from the price record) is never stored; the fetch that lands is', { skip: dbSkip }, async (t) => {
  const sql = await freshTables();
  const boundary = 1_800_000_600;
  const { get, candles, advance, settle, jump } = await stubbedStart(t, boundary - 61, { sql });
  await advance(1); // the 5m copy ends at boundary - 300
  candles.hang(true);
  await sql`insert into price_bars ${sql(Array.from({ length: 15 }, (_, i) => ({ symbol: 'SOL', t: boundary + i * 60, open: '1', high: '1', low: '1', close: '1' })))}`;
  jump(boundary + 4 * 300 + 61); // an outage: a settled window that starts inside the copy and ends after it
  const r = await get<CandlesResponse>(`/v1/candles?symbol=SOL&interval=5m&from=${boundary - 5 * 300}&to=${boundary + 2 * 300}`);
  assert.deepEqual([r.status, r.body.freshness, r.body.candles.length, r.headers['cache-control']], [200, 'delayed', 8, 'no-store']);
  await advance(2); // two history flushes
  const before = await sql<{ n: number }[]>`select count(*)::int as n from candle_windows where symbol = 'SOL' and resolution = 300 and settled`;
  assert.equal(before[0]!.n, 0, 'nothing stored while GMTrade has not answered');
  candles.release(true);
  await settle();
  await advance(1);
  const after = await untilStored(() => sql<{ start_time: string; end_time: string }[]>`select start_time, end_time from candle_windows where symbol = 'SOL' and resolution = 300 and settled`);
  assert.deepEqual(after.map((x) => [Number(x.start_time), Number(x.end_time)]), [[boundary - 1_500, boundary + 600]], "GMTrade's answer, once it landed");
});

test('candles: a copy the price record completes through the bucket in progress is live while the copy is under ten minutes old, delayed after', { skip: dbSkip }, async (t) => {
  const sql = await freshTables();
  const boundary = 1_800_000_600;
  const { get, candles, advance, jump } = await stubbedStart(t, boundary - 61, { sql });
  await advance(1); // the 5m copy, fetched at boundary - 60, ends at boundary - 300
  candles.hang(true); // GMTrade stops answering; the record goes on: minutes from boundary - 300 to boundary + 840
  await sql`insert into price_bars ${sql(Array.from({ length: 20 }, (_, i) => ({ symbol: 'SOL', t: boundary - 300 + i * 60, open: '1', high: '1', low: '1', close: '1' })))}`;
  jump(boundary + 240); // five minutes after the copy
  const live = await get<CandlesResponse>('/v1/candles?symbol=SOL&interval=5m');
  assert.deepEqual([live.status, live.body.freshness, live.body.candles.length, live.body.candles.at(-1)!.time, live.headers['cache-control']], [200, 'live', 300, boundary, LIVE]);
  jump(boundary + 840); // fifteen minutes after the copy: complete to the bucket in progress, still 'delayed'
  const old = await get<CandlesResponse>('/v1/candles?symbol=SOL&interval=5m');
  assert.deepEqual([old.status, old.body.freshness, old.body.candles.at(-1)!.time, old.headers['cache-control']], [200, 'delayed', boundary + 600, 'no-store']);
  assert.equal(candles.single().length, 2, 'a refresh of each key runs meanwhile');
});

test("candle history: a series' latest window is rewritten when it rotates or five minutes after its last write, not by every pre-warm", { skip: dbSkip }, async (t) => {
  const sql = await freshTables();
  const boundary = 1_800_000_600; // a 5m boundary that is not a 15m one
  const { advance } = await stubbedStart(t, boundary - 61, { sql });
  const writtenAt = async (res: number) => (await sql<{ at: string }[]>`
    select distinct extract(epoch from fetched_at)::bigint::text as at from candle_windows where not settled and resolution = ${res}`).map((r) => Number(r.at));
  await advance(2); // the first pass at boundary - 60, flushed a second later
  assert.deepEqual([await writtenAt(300), await writtenAt(3_600)], [[boundary - 60], [boundary - 60]]);
  await advance(62); // every resolution pre-warmed again at boundary (a minute later): only the 5m windows, which rotated there, are rewritten
  assert.deepEqual([await writtenAt(300), await writtenAt(3_600)], [[boundary], [boundary - 60]]);
  await advance(240); // the 1h pre-warm at boundary + 240 comes five minutes after the first write
  assert.deepEqual(await writtenAt(3_600), [boundary + 240]);
});

test('candle history: a settled window GMTrade answers empty is kept in memory only, never stored: a restarted process asks GMTrade again', { skip: dbSkip }, async (t) => {
  const sql = await freshTables();
  const boundary = 1_800_000_600;
  const { get, candles, advance, stop } = await stubbedStart(t, boundary - 61, { sql });
  await advance(1);
  const from = boundary - 20 * 86_400;
  const url = `/v1/candles?symbol=SOL&interval=5m&from=${from}&to=${from + 99 * 300}`;
  candles.since(from + 100 * 300); // GMTrade's history starts after the window (or its backend answered an empty list)
  const r = await get<CandlesResponse>(url);
  assert.deepEqual([r.status, r.body.freshness, r.body.candles.length, r.headers['cache-control']], [200, 'live', 0, SETTLED]);
  assert.deepEqual(candles.single().map((c) => [c.from, c.to]), [[from, from + 99 * 300]]);
  await advance(2); // two history flushes
  const stored = await sql<{ n: number }[]>`select count(*)::int as n from candle_windows where symbol = 'SOL' and resolution = 300 and start_time = ${from}`;
  assert.equal(stored[0]!.n, 0, 'the empty answer is stored');
  await stop();
  const next = await stubbedModule(t, { sql });
  next.candles.since(from + 100 * 300);
  const again = await next.get<CandlesResponse>(url);
  assert.deepEqual([again.status, again.body.freshness, again.body.candles.length], [200, 'live', 0]);
  assert.deepEqual(next.candles.single().map((c) => [c.from, c.to]), [[from, from + 99 * 300]], 'asked again, not answered from the table');
});

test('candle backfill: while the database is unreachable the store logs the outage once; the visits do not log it every 2 s', async (t) => {
  const warnings: string[] = [];
  const { advance } = await stubbedStart(t, 1_800_000_539, { warnings }); // no database: every table call fails
  await advance(12); // the first pre-warm pass, the flushes that make the store 'down', then five backfill visits
  assert.deepEqual(warnings.filter((m) => /candleStore|backfill/.test(m)), [
    'marketdata: candleStore is down (sql is not a function). Chart history is kept in memory only; windows fetched meanwhile are written once the database is back.',
  ]);
});

test("candle history store: a series keeps its newest-fetched windows up to the app's reach (30,000 bars); a latest window replaces the series' previous one", { skip: dbSkip }, async () => {
  const sql = await freshTables();
  const store = createHistoryStore(sql, (call) => call());
  const window = (i: number, settled: boolean, at: number) => ({ symbol: 'SOL', res: 60, start: i * 120_000, end: i * 120_000 + 1_999 * 60, candles: [], settled, at });
  for (let i = 0; i < 16; i++) store.put(window(i, true, 1_000 * (i + 1))); // sixteen 2,000-bar windows, each fetched a second after the one before
  assert.equal(await store.flush(), true);
  const kept = await sql<{ start_time: string }[]>`select start_time from candle_windows where settled order by fetched_at`;
  assert.deepEqual(kept.map((r) => Number(r.start_time)), Array.from({ length: 15 }, (_, i) => (i + 1) * 120_000), 'the first fetched is gone: the fifteen after it hold 30,000 bars');
  assert.equal(store.stored(), 15);
  store.put(window(100, false, 20_000));
  assert.equal(await store.flush(), true);
  store.put(window(101, false, 21_000));
  assert.equal(await store.flush(), true);
  const latest = await sql<{ start_time: string }[]>`select start_time from candle_windows where not settled`;
  assert.deepEqual(latest.map((r) => Number(r.start_time)), [101 * 120_000]);
  assert.equal(covers([{ start: 0, end: 240 }, { start: 300, end: 600 }], 60, 540, 60), true);
  assert.equal(covers([{ start: 0, end: 240 }, { start: 360, end: 600 }], 60, 540, 60), false, 'a hole at 300');
  assert.equal(covers([{ start: 0, end: 240 }], 0, 300, 60), false, 'short of the end');
});

test("candle history store: a flush is one transaction: a failed upsert leaves the series' rotated latest window in place", { skip: dbSkip }, async () => {
  const sql = await freshTables();
  const store = createHistoryStore(sql, (call) => call());
  const window = (start: number, end: number) => ({ symbol: 'SOL', res: 60, start, end, candles: [], settled: false, at: 1_000 });
  store.put(window(0, 59_940));
  assert.equal(await store.flush(), true);
  store.put(window(60_000, Number.NaN)); // the upsert fails (bigint rejects NaN) after the rotated row's delete
  assert.equal(await store.flush(), false);
  const latest = await sql<{ start_time: string }[]>`select start_time from candle_windows where not settled`;
  assert.deepEqual(latest.map((r) => Number(r.start_time)), [0], 'the delete was rolled back with it');
});

test("candle backfill: after the first pre-warm pass, one aligned page per visit while GMTrade is idle and quick, stopping at its history start; a restart resumes from the table", { skip: dbSkip }, async (t) => {
  const sql = await freshTables();
  const boundary = 1_800_000_600;
  const nowSec = boundary - 61;
  const first = await stubbedStart(t, nowSec, { sql });
  const pageOf = (res: number, k: number) => { const start = (Math.floor(nowSec / (300 * res)) - k) * 300 * res; return { start, end: start + 299 * res }; };
  const pages = (m: { candles: ReturnType<typeof stubCandles> }) => m.candles.pages().map((c) => [c.tokens[0], c.res, c.from, c.to]);
  const progress = (m: { service: { health(): Record<string, { history?: { backfill: { seriesDone: number; windowsStored: number } } }> } }) => m.service.health().candles!.history!.backfill;
  // GMTrade's history starts 400 hours ago: the newest 1h page back is cut short, the one before it empty, and every 4h
  // and 1D page lies before it; the 5m and 15m pages back to their targets are whole.
  first.candles.since(nowSec - 400 * 3_600);
  await first.advance(1); // the first pre-warm pass; the backfill starts a second later
  assert.equal(pages(first).length, 0);
  await first.advance(2);
  assert.deepEqual(pages(first), [[BTC_INDEX, 3_600, pageOf(3_600, 1).start, pageOf(3_600, 1).end]], 'the first visit: BTC 1h, the newest settled page');
  const short = await sql<{ n: number; last: number }[]>`select jsonb_array_length(candles) as n, (candles -> -1 ->> 'time')::bigint as last from candle_windows where settled`;
  assert.ok(short[0]!.n > 0 && short[0]!.n < 300 && Number(short[0]!.last) === pageOf(3_600, 1).end, `stored as GMTrade answered it: ${short[0]!.n} candles`);

  first.candles.hang(true); // a request whose window nobody has (10 days back: inside GMTrade's history, beyond every copy): its fetch is in flight
  const user = first.get<CandlesResponse>(`/v1/candles?symbol=SOL&interval=5m&from=${boundary - 10 * 86_400}&to=${boundary - 10 * 86_400 + 99 * 300}`);
  await io();
  await first.advance(3);
  assert.equal(pages(first).length, 1, 'no page while a request fetch is in flight');
  first.candles.release(true); // answered after 3 s on the clock: slow, not too slow for the backfill
  first.candles.hang(false);
  await first.settle();
  assert.equal((await user).status, 200);
  await first.advance(2);
  assert.deepEqual(pages(first)[1], [BTC_INDEX, 300, pageOf(300, 1).start, pageOf(300, 1).end], 'the next visit fetches the next series, BTC 5m');

  // A page answered in 4 s, then one that fails ('degraded' until a call succeeds): neither pauses the walk.
  let fetchedSoFar = pages(first).length;
  first.candles.hang(true);
  await first.advance(2);
  assert.equal(pages(first).length, fetchedSoFar + 1);
  await first.advance(4);
  first.candles.release(true); // 4 s on the clock
  await first.settle();
  await first.advance(2);
  assert.equal(pages(first).length, fetchedSoFar + 2, 'a page after a 4 s answer');
  first.candles.release(false); // that one fails
  first.candles.hang(false);
  await first.settle();
  await first.advance(2);
  assert.equal(pages(first).length, fetchedSoFar + 3, 'a page while the source is degraded');
  // Three failures in a row make the source 'down': the walk pauses until a call succeeds (the pre-warm, a minute later).
  fetchedSoFar = pages(first).length;
  first.candles.hang(true);
  for (let i = 0; i < 3; i++) {
    await first.advance(2);
    first.candles.release(false);
    await first.settle();
  }
  first.candles.hang(false);
  assert.equal(pages(first).length, fetchedSoFar + 3);
  await first.advance(4);
  assert.equal(pages(first).length, fetchedSoFar + 3, 'no page while the source is down');
  await first.advance(60);
  assert.ok(pages(first).length > fetchedSoFar + 3, 'resumed once the pre-warm succeeded');

  const secondHour = () => first.candles.pages().some((c) => c.tokens[0] === BTC_INDEX && c.res === 3_600 && c.from === pageOf(3_600, 2).start);
  await advanceUntil(first, secondHour, 300, "BTC 1h's second page");
  const marker = await sql<{ n: number }[]>`select jsonb_array_length(candles) as n from candle_windows where symbol = 'BTC' and resolution = 3600 and start_time = ${pageOf(3_600, 2).start}`;
  assert.deepEqual(marker.map((x) => x.n), [0], "GMTrade's history start, stored as an empty page");
  await advanceUntil(first, () => progress(first).seriesDone === 45, 500, 'every series complete');
  const fetched = first.candles.pages();
  assert.equal(fetched.filter((c) => c.tokens[0] === BTC_INDEX && c.res === 3_600).length, 2, 'the empty page is never asked for again');
  assert.equal(new Set(fetched.map((c) => `${c.tokens[0]}:${c.res}:${c.from}`)).size, 9 * 12, 'per market: 1h two pages, 5m and 15m four each, 4h and 1D one empty each');
  assert.equal(fetched.length, 9 * 12 + 4, 'each page once, plus the four attempts that failed');
  assert.equal(progress(first).windowsStored, 9 * 12 + 1, "the pages and the request's window");
  await first.stop();

  const next = await stubbedModule(t, { sql }); // a restart: the table tells what is stored, nothing is fetched again
  await advanceUntil(next, () => progress(next).seriesDone === 45, 200, 'every series found complete');
  assert.equal(next.candles.pages().length, 0);
  assert.equal(progress(next).windowsStored, 9 * 12 + 1);
});

test('price frames: every 100 ms, only the symbols whose price or session moved; a new timestamp alone sends nothing', async (t) => {
  const { tick, events, settle } = await stubbedStart(t, 1_800_000_539);
  const frames = () => events.flatMap((e) => (e.type === 'price' ? [e.ticks.map((x) => `${x.symbol}:${Number(x.mid)}:${x.session}`)] : []));
  tick('SOL', 201n);
  tick('BTC', 100_000n); // the price the feed started with, but never sent: it goes out
  t.mock.timers.tick(99);
  await settle();
  assert.deepEqual(frames(), [], 'nothing before the flush');
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(frames(), [['SOL:201:open', 'BTC:100000:open']]);
  t.mock.timers.tick(1_000); // the keeper repeats a price under a new timestamp about once a second
  await settle();
  tick('SOL', 201n);
  tick('BTC', 100_001n);
  t.mock.timers.tick(100);
  await settle();
  assert.deepEqual(frames().slice(1), [['BTC:100001:open']], 'only the symbol that moved');
  tick('SOL', 201n);
  t.mock.timers.tick(100);
  await settle();
  assert.equal(frames().length, 2, 'a new timestamp alone: no frame');
  tick('SOL', 201n, false); // the session closed at the same price
  t.mock.timers.tick(100);
  await settle();
  assert.deepEqual(frames().slice(2), [['SOL:201:closed']]);
  const last = events.flatMap((e) => (e.type === 'price' ? e.ticks : [])).at(-1)!;
  assert.deepEqual(Object.keys(last).sort(), ['max', 'mid', 'min', 'session', 'symbol', 'ts'], 'the tick shape is unchanged');
});

const ROW: Market = {
  symbol: 'SOL', pair: 'SOL / USD', name: 'Solana', category: 'Crypto', subcategory: 'Layer 1 & 2', marketToken: SOL_POOL,
  pools: [{ marketToken: SOL_POOL, name: 'SOL/USD[USDC-USDC]', pure: true, longToken: USDC_MINT, shortToken: USDC_MINT }],
  tradable: true, price: '200', priceDecimals: 2, indexTokenDecimals: 9, change24h: 1.23, volume24h: '1000.00',
  openInterestLong: '1000.00', openInterestShort: '1000.00', fundingRateHourlyLong: 0.001, fundingRateHourlyShort: -0.001, borrowRateHourlyLong: 0.002, borrowRateHourlyShort: 0.002,
  capacityLong: '1000.00', capacityShort: '1000.00', poolLiquidity: '1000.00', maxLeverage: 20, closedMaxLeverage: null,
  maxLeverageLong: 20, maxLeverageShort: 20, maxSizeLong: '1000.00', maxSizeShort: '1000.00', minCollateralUsd: '1',
  session: 'open', freshness: 'live', updatedAt: 1_800_000_000_000,
};

test('market rows: re-sent only when a figure the app shows moved past its display precision (1 % for USD figures), always on a flag change', async (t) => {
  const changed = (patch: Partial<Market>) => changedForDisplay(ROW, { ...ROW, ...patch });
  assert.equal(changed({}), false);
  assert.equal(changed({ price: '201', updatedAt: ROW.updatedAt! + 1 }), false, 'price and updatedAt travel in the ticks');
  assert.deepEqual([changed({ change24h: 1.239 }), changed({ change24h: 1.24 })], [false, true], '24h change: 2 decimals');
  assert.deepEqual([changed({ fundingRateHourlyLong: 0.00109 }), changed({ fundingRateHourlyLong: 0.0011 })], [false, true], 'funding: 4 decimals');
  assert.deepEqual([changed({ fundingRateHourlyShort: -0.00109 }), changed({ fundingRateHourlyShort: -0.00111 })], [false, true], 'short funding: 4 decimals');
  assert.deepEqual([changed({ borrowRateHourlyLong: 0.00209 }), changed({ borrowRateHourlyLong: 0.00211 })], [false, true], 'long borrowing: 4 decimals');
  assert.deepEqual([changed({ borrowRateHourlyShort: 0.00209 }), changed({ borrowRateHourlyShort: 0.00211 }), changed({ borrowRateHourlyShort: null })], [false, true, true], 'short borrowing: 4 decimals');
  for (const key of ['volume24h', 'openInterestLong', 'openInterestShort', 'capacityLong', 'capacityShort', 'poolLiquidity', 'maxSizeLong', 'maxSizeShort'] as const) {
    assert.deepEqual([changed({ [key]: '1009.99' }), changed({ [key]: '1010.00' }), changed({ [key]: null })], [false, true, true], key);
  }
  for (const patch of [
    { session: 'closed' }, { freshness: 'stale' }, { tradable: false, unavailableReason: 'Not available' }, { maxLeverage: 10 }, { closedMaxLeverage: 8 },
    { maxLeverageLong: 19 }, { maxLeverageShort: 19 }, { minCollateralUsd: '2' }, { minCollateralUsd: null },
  ] as const) {
    assert.equal(changed(patch), true, JSON.stringify(patch));
  }

  const { tick, events, advance } = await stubbedStart(t, 1_800_000_539);
  const rows = () => events.flatMap((e) => (e.type === 'market' ? [`${e.market.symbol}:${e.market.session}`] : []));
  assert.deepEqual(rows().slice(9), ['SOL:open'], 'every market once at start, then SOL again once the allowlist made it tradable');
  await advance(5); // the pre-warm lands the 24h change (a figure appearing): every row again at the 5 s scan
  assert.equal(rows().length, 19);
  tick('SOL', 201n); // a price move: the tick carries it; the 24h change moves far below its display precision
  await advance(5);
  assert.equal(rows().length, 19, 'no row for a price move');
  tick('SOL', 201n, false);
  await advance(5);
  assert.deepEqual(rows().slice(19), ['SOL:closed'], 'a session change sends that row');
});

test('market rows: a funding or borrowing rate moving 0.0001 pp sends the row, a smaller move does not; both sides of funding travel', async (t) => {
  const { feed, events, tick, advance } = await stubbedStart(t, 1_800_000_539);
  const status: MarketStatus = {
    fundingRatePerSecondForLong: 10n ** 12n, fundingRatePerSecondForShort: -3n * 10n ** 12n, borrowingRatePerSecondForLong: 0n, borrowingRatePerSecondForShort: 2n * 10n ** 12n,
    openInterestForLong: 3_000n * 10n ** 20n, openInterestForShort: 1_000n * 10n ** 20n, liquidityForLong: 10n ** 24n, liquidityForShort: 10n ** 24n,
    poolValueForLong: 10n ** 24n, poolValueForShort: 10n ** 24n, minCollateralFactorForLong: 0n, minCollateralFactorForShort: 0n,
  };
  t.mock.method(model, 'marketStatus', () => status);
  // SOL's pool gets a Market account image (not Closed, min_collateral_factor 5e18 = 20x) and USDC a price, so the
  // catalog runs the (mocked) model on it.
  const image = Buffer.alloc(9_168);
  image.writeBigUInt64LE(5n * 10n ** 18n, storeIdl.offsetOf('Market', 'config.min_collateral_factor'));
  feed.accounts.set(SOL_POOL, { data: image.toString('base64'), slot: 1 });
  feed.tokens.set(USDC_MINT, {
    pubkey: USDC_MINT, price: { ts: 1_800_000_539, min: '100000000000000', max: '100000000000000', isOpen: true },
    meta: { name: 'USDC', decimals: 6, precision: 4, isEnabled: true, isSynthetic: false, category: 'Other', indexName: null, uiSymbol: 'USDC', uiName: null, launchTime: null, expectedProvider: 'pyth' },
  });
  const sol = () => events.flatMap((e) => (e.type === 'market' && e.market.symbol === 'SOL' ? [e.market] : []));
  const rates = (m: Market) => [m.fundingRateHourlyLong, m.fundingRateHourlyShort, m.borrowRateHourlyLong, m.borrowRateHourlyShort];
  const scan = async () => { tick('SOL', 200n); await advance(5); }; // the same price keeps the row's freshness live through the 5 s scan
  await scan(); // SOL's row carries rates now
  assert.deepEqual([rates(sol().at(-1)!), sol().at(-1)!.maxLeverage], [[0.0036, -0.0108, 0, 0.0072], 20]); // 1e12 /s × 3600 × 100 / 1e20
  const sent = sol().length;
  status.borrowingRatePerSecondForShort += 10n ** 10n; // +0.000036 pp/h: under the display precision
  await scan();
  assert.equal(sol().length, sent, 'a move under 0.0001 pp sends nothing');
  status.borrowingRatePerSecondForShort += 2n * 10n ** 10n; // +0.000108 pp/h since the row was sent
  await scan();
  assert.deepEqual([sol().length, rates(sol().at(-1)!)[3]], [sent + 1, 0.007308], 'a borrowing move of 0.0001 pp sends the row');
  status.fundingRatePerSecondForShort -= 3n * 10n ** 10n; // −0.000108 pp/h
  await scan();
  assert.deepEqual([sol().length, rates(sol().at(-1)!)[1]], [sent + 2, -0.010908], 'a short-funding move too');
});

test('an asset without a USDC-only pool is not listed: no row, no stream event, no chart pre-warm, and every route for it answers 404 unknown_market', async (t) => {
  const nowSec = 1_800_000_539;
  const { feed, get, events, candles, advance } = await stubbedStart(t, nowSec);
  // ONDO trades on the venue only in a WGMX-USDC pool (live on 2026-09-25): Props.trade could never trade it.
  const [index, pool] = [fakeKey('index-ondo'), fakeKey('pool-ondo')];
  feed.tokens.set(index, {
    pubkey: index, price: { ts: nowSec, min: '30000000000', max: '30000000000', isOpen: true },
    meta: { name: 'ONDO', decimals: 9, precision: 4, isEnabled: true, isSynthetic: false, category: 'DeFi', indexName: null, uiSymbol: 'ONDO', uiName: null, launchTime: null, expectedProvider: 'pyth' },
  });
  feed.markets.set(pool, {
    marketToken: pool, pubkey: pool, slot: null, data: null, virtualInventoryForSwaps: NO_ACCOUNT, virtualInventoryForPositions: NO_ACCOUNT,
    meta: { name: 'ONDO/USD[WGMX-USDC]', isPure: false, isEnabled: true, indexToken: { pubkey: index }, longToken: { pubkey: fakeKey('wgmx') }, shortToken: { pubkey: USDC_MINT } },
  });
  await advance(65); // catalog rebuilds, 5 s stream scans and a full pre-warm pass after the add
  assert.deepEqual((await get<Market[]>('/v1/markets')).body.map((r) => r.symbol), ['BTC', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'SOL']);
  assert.ok(!events.some((e) => e.type === 'market' && e.market.symbol === 'ONDO'), 'never sent as a market row');
  assert.ok(candles.calls.some((c) => c.tokens.includes(SOL_INDEX)) && !candles.calls.some((c) => c.tokens.includes(index)), 'never pre-warmed or backfilled');
  for (const path of ['/v1/markets/ONDO', '/v1/markets/ONDO/trades', '/v1/candles?symbol=ONDO&interval=1h', '/v1/candles?symbol=ONDO&interval=2h', '/v1/quote?symbol=ONDO&side=Long&sizeUsd=100']) {
    const r = await get<ApiError>(path);
    assert.deepEqual([r.status, r.body.error.code, r.body.error.message], [404, 'unknown_market', 'unknown market ONDO'], path);
  }
});

test('venue limits on the real EUR pool: a side\'s leverage falls as its open interest grows, and each limit is where the venue\'s own model stops accepting', () => {
  type Recorded = { row: Market; market: string; virtualInventories: Record<string, string>; prices: Record<'index' | 'long' | 'short', { min: string; max: string }> };
  const eur = (JSON.parse(readFileSync(new URL('../../../test/sim/fixtures/gmtrade-live.json', import.meta.url), 'utf8')) as { markets: Recorded[] }).markets
    .find((m) => m.row.symbol === 'EUR')!;
  const image = Buffer.from(eur.market, 'base64');
  for (const at of [4024, 4032, 4040]) image.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 86_400), at); // no accrual: exact and repeatable
  const price = (k: 'index' | 'long' | 'short') => ({ min: BigInt(eur.prices[k].min), max: BigInt(eur.prices[k].max) });
  const input = { market: image.toString('base64'), virtualInventories: eur.virtualInventories, prices: { index: price('index'), long: price('long'), short: price('short') } };
  const limits = venueLimits(eur.market, model.marketStatus(input), input.prices.index);
  // The config's min collateral factor is 0.002 (500x); shorts held $11.93M × the 2e-10 multiplier = 0.00239 (418x).
  assert.deepEqual([limits.maxLeverageLong, limits.maxLeverageShort, limits.minCollateralUsd], [500, 418, '1']);
  const USD = 10n ** 20n;
  const open = (isLong: boolean, sizeUsd: bigint, leverage: number) => () => model.simulateIncrease({
    market: input, isLong, collateralToken: USDC_MINT, collateralAmount: (sizeUsd * 1_000_000n) / (USD * BigInt(leverage)) + 1n, sizeDeltaUsd: sizeUsd,
  });
  assert.doesNotThrow(open(true, 1_000n * USD, 450), 'a 450x long: under the config\'s 500x');
  assert.throws(open(false, 1_000n * USD, 450), /insufficient collateral/, 'a 450x short: above the 418x the shorts\' open interest leaves');
  assert.doesNotThrow(open(false, 1_000n * USD, 400));
  // The largest new short: the reserve headroom (the $40M max open interest is far off); 0.5 % more runs out of reserve.
  const short = parseFixed(limits.maxSizeShort!, 20);
  assert.doesNotThrow(open(false, short, 1));
  assert.throws(open(false, (short * 1005n) / 1000n, 1), /insufficient reserve/);
  assert.deepEqual([eur.row.maxLeverageShort, eur.row.maxSizeShort], [20, limits.maxSizeShort], 'the fixture row: the Props 20x cap is lower');
});

test('health: a failing source is reported without its URL or the venue\'s name', async () => {
  assert.equal(why(new Error('https://price-candle-mainnet.gmtrade.xyz/graphql: HTTP 502')), 'HTTP 502');
  assert.equal(why(new Error('https://keeper-prod-api.gmtrade.xyz/graphql: GMTrade is busy')), 'exchange is busy');
  assert.equal(why(new Error('RPC getMultipleAccounts: HTTP 429')), 'RPC getMultipleAccounts: HTTP 429');
  const upstreams = createUpstreams({ candles: 'fallback' }, () => {});
  await upstreams.track('candles', async () => { throw new Error('https://price-candle-mainnet.gmtrade.xyz/graphql: HTTP 503'); }).catch(() => {});
  assert.equal(upstreams.status('candles').lastError, 'HTTP 503');
});

/** An independent roll-up of `bars` into `interval` buckets, to check the server's: spans from the epoch, weeks
 *  from Monday 00:00 UTC, calendar months. */
function rollup(bars: Candle[], interval: CandleInterval): Candle[] {
  const bucket = (t: number) => {
    const d = new Date(t * 1000);
    if (interval === '1W') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7) / 1000;
    if (interval === '1M') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth()) / 1000;
    return Math.floor(t / INTERVAL_SECONDS[interval]) * INTERVAL_SECONDS[interval];
  };
  const out = new Map<number, Candle>();
  for (const c of bars) {
    const time = bucket(c.time);
    const b = out.get(time);
    if (b) { b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low); b.close = c.close; }
    else out.set(time, { time, open: c.open, high: c.high, low: c.low, close: c.close });
  }
  return [...out.values()];
}

test("derived intervals: an older window is rolled up from the source windows it spans through the native path (one fetch, then its own cache key); a window of more than 2,000 source bars answers its newest part; before the source's history it is empty", async (t) => {
  const boundary = 1_800_000_600;
  const { get, candles, advance } = await stubbedStart(t, boundary - 61);
  await advance(1); // the first pass: 11 calls
  const day = Math.floor((boundary - 61) / 86_400) * 86_400;
  // Five 2h buckets 20 days back: fetched once, as one 1h window of ten bars (the twelfth call).
  const from = day - 20 * 86_400;
  const url = `/v1/candles?symbol=SOL&interval=2h&from=${from}&to=${from + 4 * 7_200 + 3_599}`;
  const r = await get<CandlesResponse>(url);
  assert.deepEqual([r.status, r.body.freshness, r.body.source, r.body.candles.length, r.headers['cache-control']], [200, 'live', 'venue', 5, SETTLED]);
  assert.deepEqual(candles.single().map((c) => [c.res, c.from, c.to]), [[3_600, from, from + 9 * 3_600]]);
  assert.deepEqual(r.body.candles.map((c) => [c.time, c.open, c.close]), Array.from({ length: 5 }, (_, i) => [from + i * 7_200, 12, from + i * 7_200 + 3_600]), 'each bar closes on its second hour');
  await get<CandlesResponse>(url);
  assert.equal(candles.single().length, 1, 'the second request is a hit');
  // Ten years of months: the source span is capped at 2,000 days, from the first month start inside them.
  const months = await get<CandlesResponse>(`/v1/candles?symbol=SOL&interval=1M&from=${day - 3_650 * 86_400}&to=${day - 1}`);
  const fetch = candles.single()[1]!;
  assert.ok(fetch.res === 86_400 && (fetch.to - fetch.from) / 86_400 + 1 <= 2_000, `${(fetch.to - fetch.from) / 86_400 + 1} source bars`);
  assert.ok(fetch.from >= day - 2_000 * 86_400 && new Date(fetch.from * 1000).getUTCDate() === 1, `starts on the first month start within the cap (${fetch.from})`);
  assert.deepEqual([months.status, months.body.freshness, months.headers['cache-control']], [200, 'live', LIVE], 'its last month is in progress: cached for seconds');
  assert.ok(months.body.candles.length >= 64 && months.body.candles.length <= 67, `${months.body.candles.length} months`);
  assert.ok(months.body.candles.every((c) => new Date(c.time * 1000).getUTCDate() === 1 && new Date(c.time * 1000).getUTCHours() === 0), 'month starts');
  assert.deepEqual([months.body.candles[0]!.time, months.body.candles.at(-1)!.close], [fetch.from, fetch.to], 'from the first month fetched to the last day fetched');
  // Before GMTrade's history (an empty answer, for a window beyond the 300-day 1D copy): empty and final, as a native window is.
  candles.since(day);
  const none = await get<CandlesResponse>(`/v1/candles?symbol=SOL&interval=1W&from=${day - 400 * 86_400}&to=${day - 350 * 86_400}`);
  assert.deepEqual([none.status, none.body.freshness, none.body.candles, none.headers['cache-control']], [200, 'live', [], SETTLED]);
  assert.equal(candles.single().length, 3, 'fetched once');
  const bad = await get<ApiError>(`/v1/candles?symbol=SOL&interval=1W&from=${day}&to=${day - 14 * 86_400}`);
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'bad_request']);
});

test('derived intervals: 1m and 3m come from the price record with its unwritten tail from memory, bucket-aligned; before the record they answer empty', { skip: dbSkip }, async (t) => {
  const sql = await freshTables();
  const boundary = 1_800_000_600;
  const { get, candles, tick, advance } = await stubbedStart(t, boundary - 61, { sql });
  await advance(1);
  const nowMin = boundary - 60; // a multiple of 180
  // Thirty recorded minutes up to a minute ago, then two ticks in the minute in progress (not written yet).
  await sql`insert into price_bars ${sql(Array.from({ length: 30 }, (_, i) => ({ symbol: 'SOL', t: nowMin - (30 - i) * 60, open: String(100 + i), high: String(102 + i), low: String(99 + i), close: String(101 + i) })))}`;
  tick('SOL', 201n);
  tick('SOL', 199n);
  const minutes = await get<CandlesResponse>('/v1/candles?symbol=SOL&interval=1m');
  assert.deepEqual([minutes.status, minutes.body.freshness, minutes.body.source, minutes.body.candles.length, minutes.headers['cache-control']], [200, 'live', 'record', 31, LIVE]);
  assert.deepEqual(minutes.body.candles[0], { time: nowMin - 1_800, open: 100, high: 102, low: 99, close: 101 });
  assert.deepEqual(minutes.body.candles.at(-1), { time: nowMin, open: 201, high: 201, low: 199, close: 199 }, 'the minute in progress, from the ticks');
  const threes = await get<CandlesResponse>('/v1/candles?symbol=SOL&interval=3m');
  assert.deepEqual([threes.status, threes.body.freshness, threes.body.source, threes.body.candles.length], [200, 'live', 'record', 11]);
  assert.ok(threes.body.candles.every((c) => c.time % 180 === 0), 'bucket-aligned');
  assert.deepEqual(threes.body.candles[0], { time: nowMin - 1_800, open: 100, high: 104, low: 99, close: 103 }, 'three minutes to a bar');
  assert.deepEqual(threes.body.candles.at(-1), { time: nowMin, open: 201, high: 201, low: 199, close: 199 });
  const before = await get<CandlesResponse>(`/v1/candles?symbol=SOL&interval=3m&from=${nowMin - 10 * 86_400}&to=${nowMin - 9 * 86_400}`);
  assert.deepEqual([before.status, before.body.freshness, before.body.candles, before.headers['cache-control']], [200, 'live', [], SETTLED], 'history starts with the record');
  assert.equal(candles.calls.length, 11, 'no GMTrade call');
});

/** The real SOL/USD[USDC-USDC] Market account and virtual inventory (the gmsol-wasm fixture), clocks a day ahead so
 *  accrual is a no-op, put into the stub feed with the fixture's prices, so the quote runs GMTrade's model for real. */
function loadSolMarket(feed: NonNullable<MarketDataOptions['feed']>) {
  const f = JSON.parse(readFileSync(new URL('../../../../packages/gmsol-wasm/test/fixtures/sol-usdc-usdc.json', import.meta.url), 'utf8')) as {
    market: string; virtualInventories: Record<string, string>; prices: Record<'index' | 'long' | 'short', { min: string; max: string }>;
  };
  const image = Buffer.from(f.market, 'base64');
  for (const at of [4024, 4032, 4040]) image.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 86_400), at);
  feed.accounts.set(SOL_POOL, { data: image.toString('base64'), slot: 1 });
  const [vi] = Object.keys(f.virtualInventories) as [string];
  feed.accounts.set(vi, { data: f.virtualInventories[vi]!, slot: 1 });
  feed.markets.get(SOL_POOL)!.virtualInventoryForPositions = vi;
  const ts = Math.floor(Date.now() / 1000);
  feed.tokens.get(SOL_INDEX)!.price = { ts, min: f.prices.index.min, max: f.prices.index.max, isOpen: true };
  feed.tokens.set(USDC_MINT, {
    pubkey: USDC_MINT, price: { ts, min: f.prices.short.min, max: f.prices.short.max, isOpen: true },
    meta: { name: 'USDC', decimals: 6, precision: 4, isEnabled: true, isSynthetic: false, category: 'Other', indexName: null, uiSymbol: 'USDC', uiName: null, launchTime: null, expectedProvider: 'pyth' },
  });
  return { image: image.toString('base64'), virtualInventories: { [vi]: f.virtualInventories[vi]! }, prices: f.prices };
}

test('quote: the ticket\'s cost preview from GMTrade\'s model on the real SOL pool — close fee, round trip, hourly cost, liquidation price', { timeout: 30_000 }, async (t) => {
  const { feed, get, service } = await stubbedModule(t);
  const sol = loadSolMarket(feed);
  await new Promise((r) => setTimeout(r, 1_100)); // the catalog rebuilds after a second: SOL's row now carries the rates
  const row = service.market('SOL')!;
  assert.ok(row.fundingRateHourlyLong !== null && row.fundingRateHourlyShort !== null && row.borrowRateHourlyShort !== null);
  const usd = (v: bigint) => Number(v) / 1e20;
  const prices = { index: { min: BigInt(sol.prices.index.min), max: BigInt(sol.prices.index.max) }, long: { min: BigInt(sol.prices.long.min), max: BigInt(sol.prices.long.max) }, short: { min: BigInt(sol.prices.short.min), max: BigInt(sol.prices.short.max) } };
  const bare = { market: sol.image, virtualInventories: sol.virtualInventories, prices };

  // A $10,000 short at $1,000 margin. The open fee and impact come from the pool as it is; the close fee and the
  // liquidation price from the resulting position valued in the pool, as the positions table will show them.
  const q = await get<PriceImpactQuote>('/v1/quote?symbol=SOL&side=Short&sizeUsd=10000&collateralUsd=1000');
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const open = model.simulateIncrease({ market: bare, isLong: false, collateralToken: USDC_MINT, collateralAmount: 1_000_000_000n, sizeDeltaUsd: 10_000n * 10n ** 20n });
  const status = model.positionStatus({ ...bare, market: withPosition(sol.image, open.position.account) }, open.position.account);
  assert.deepEqual(
    [q.body.openFeeUsd, q.body.closeFeeUsd, q.body.roundTripFeeUsd, q.body.liquidationPrice, q.body.collateralUsd, q.body.orderValueUsd, q.body.sizeUsd, q.body.platformFeeUsd],
    [usdString(open.fees.orderFeeValue), usdString(status.closeOrderFeeValue), usdString(open.fees.orderFeeValue + status.closeOrderFeeValue),
      priceString(status.liquidationPrice!, 9, 4), '1000', '10000', '10000', '0'],
  );
  // Shorts are the larger side of this pool: opening one worsens the balance (1.2 bp), closing it improves it (1 bp).
  const [openFee, closeFee] = [Number(q.body.openFeeUsd), Number(q.body.closeFeeUsd)];
  assert.ok(Math.abs(openFee - 1.2) < 0.01 && Math.abs(closeFee - 1) < 0.01 && closeFee < openFee, `open ${openFee} close ${closeFee}`);
  assert.ok(Number(q.body.liquidationPrice) > Number(q.body.executionPrice) * 1.05 && Number(q.body.liquidationPrice) < Number(q.body.executionPrice) * 1.12,
    `a 10x short liquidates a bit under 10% above its entry (min collateral 4%), got ${q.body.liquidationPrice} vs ${q.body.executionPrice}`);
  // Rates are the side's, hourly cost = (borrowing + funding when this side pays) × size, per hour.
  assert.deepEqual([q.body.fundingRateHourlyPct, q.body.borrowRateHourlyPct], [row.fundingRateHourlyShort, row.borrowRateHourlyShort]);
  assert.ok(row.fundingRateHourlyShort! > 0 && row.borrowRateHourlyShort! > 0, 'shorts pay both here');
  assert.ok(Math.abs(Number(q.body.hourlyCostUsd) - ((row.fundingRateHourlyShort! + row.borrowRateHourlyShort!) / 100) * 10_000) < 1e-6, q.body.hourlyCostUsd!);

  // The long side receives funding (never credited here) and pays no borrowing: its hourly cost is nothing.
  const long = await get<PriceImpactQuote>('/v1/quote?symbol=SOL&side=Long&sizeUsd=10000&collateralUsd=1000');
  assert.ok(row.fundingRateHourlyLong! < 0 && row.borrowRateHourlyLong === 0, `long rates ${row.fundingRateHourlyLong} ${row.borrowRateHourlyLong}`);
  assert.deepEqual([long.body.fundingRateHourlyPct, long.body.borrowRateHourlyPct, long.body.hourlyCostUsd], [row.fundingRateHourlyLong, 0, '0']);
  assert.ok(Number(long.body.liquidationPrice) < Number(long.body.executionPrice) * 0.95, `long liquidation ${long.body.liquidationPrice}`);
  assert.ok(Math.abs(Number(long.body.closeFeeUsd) - 1.2) < 0.01, 'closing a long worsens the balance here: 1.2 bp');

  // Without collateral the quote prices at 1x (as before); the fees do not depend on the margin.
  const lever = await get<PriceImpactQuote>('/v1/quote?symbol=SOL&side=Short&sizeUsd=10000');
  assert.deepEqual([lever.body.collateralUsd, lever.body.openFeeUsd, lever.body.closeFeeUsd], [null, q.body.openFeeUsd, q.body.closeFeeUsd]);
  assert.ok(Number(lever.body.liquidationPrice) > Number(q.body.liquidationPrice), 'more margin, a farther liquidation');
  // A limit order is priced at its limit price.
  const limitPrice = (Number(q.body.executionPrice) * 0.97).toFixed(4);
  const limit = await get<PriceImpactQuote>(`/v1/quote?symbol=SOL&side=Long&sizeUsd=10000&collateralUsd=1000&limitPrice=${limitPrice}`);
  assert.equal(limit.status, 200, JSON.stringify(limit.body));
  assert.ok(Math.abs(Number(limit.body.executionPrice) / Number(limitPrice) - 1) < 0.001, `priced at the limit: ${limit.body.executionPrice} vs ${limitPrice}`);
  assert.ok(Number(limit.body.liquidationPrice) < Number(limitPrice) && Number(limit.body.liquidationPrice) < Number(long.body.liquidationPrice));
  for (const bad of ['side=Short&sizeUsd=10000&collateralUsd=0', 'side=Short&sizeUsd=10000&collateralUsd=abc', 'side=Long&sizeUsd=10000&limitPrice=0', 'side=Long&sizeUsd=10000&limitPrice=x']) {
    assert.equal((await get<ApiError>(`/v1/quote?symbol=SOL&${bad}`)).status, 400, bad);
  }
  const refused = await get<ApiError>('/v1/quote?symbol=SOL&side=Short&sizeUsd=10000&collateralUsd=1');
  assert.deepEqual([refused.status, refused.body.error.code], [422, 'rejected_by_venue'], 'the venue refuses 10,000x');
  assert.match(refused.body.error.message, /^The exchange would reject this order: /);
  // The venue's own refusals of an order within the row's limits read as the engine words them, naming the limit: a
  // long just above the long room (its reserve), and $1.00 of margin, which the fees take below the $1 minimum.
  const over = Math.ceil(Number(row.maxSizeLong) * 1.01);
  const reserve = await get<ApiError>(`/v1/quote?symbol=SOL&side=Long&sizeUsd=${over}&collateralUsd=${over / 2}`);
  assert.deepEqual([reserve.status, reserve.body.error], [422, {
    code: 'rejected_by_venue', message: `Up to $${Math.floor(Number(row.maxSizeLong)).toLocaleString('en-US')} can be opened long on SOL right now`,
  }]);
  const margin = await get<ApiError>('/v1/quote?symbol=SOL&side=Long&sizeUsd=20&collateralUsd=1');
  assert.deepEqual([margin.status, margin.body.error], [422, { code: 'rejected_by_venue', message: 'A long on SOL needs at least $1.00 of margin after fees' }]);
  // The quoted side's current limits, as the row carries them (the real pool's reserve headroom; MarketConfig's 20x).
  assert.deepEqual([q.body.maxSizeUsd, q.body.maxLeverage, long.body.maxSizeUsd, long.body.maxLeverage], [row.maxSizeShort, row.maxLeverageShort, row.maxSizeLong, row.maxLeverageLong]);
  assert.ok(Number(row.maxSizeShort) > 1_000_000 && row.maxLeverageShort === 20, `${row.maxSizeShort} ${row.maxLeverageShort}`);
});

test('live: fetchAnchorIdl reads the IDL GMTrade publishes onchain, identical to the vendored v0.10.0 IDL', { skip, timeout: 30_000 }, async () => {
  const onchain = await fetchAnchorIdl('https://api.mainnet-beta.solana.com', 'Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo');
  const vendored = JSON.parse(readFileSync(new URL('../../../../packages/gmtrade/idl/gmsol_store-0.10.0.json', import.meta.url), 'utf8')) as Idl;
  assert.deepEqual(onchain.accounts, vendored.accounts);
  assert.deepEqual(onchain.types, vendored.types);
  assert.equal(new IdlCoder(onchain).sizeOf({ defined: { name: 'Market' } }), 9168);
});

test('live: routes, stream events and service API without a deployed program', { skip, timeout: 120_000 }, async () => {
  const { service, events, get, beforeReady, stop } = await start({});
  try {
    assert.equal(beforeReady, 503, 'no empty market list while starting');
    const markets = await get<Market[]>('/v1/markets');
    assert.equal(markets.status, 200);
    const rows = markets.body;
    assert.ok(rows.length >= 55, `${rows.length} markets`);
    const by = Object.fromEntries(rows.map((r) => [r.symbol, r]));
    for (const r of rows) {
      assert.equal(r.tradable, false);
      assert.match(r.unavailableReason!, /^Not (yet enabled|available) for funded trading/);
    }
    assert.equal(by.SOL!.unavailableReason, 'Not yet enabled for funded trading');
    assert.equal(by.AAVE, undefined, 'AAVE has no USDC-only pool (2026-09-25): not listed');
    assert.ok(rows.every((r) => r.pools.find((p) => p.marketToken === r.marketToken)?.pure), 'every row trades on its pure pool');
    assert.deepEqual((await get<ApiError>('/v1/candles?symbol=AAVE&interval=1h')).body.error.code, 'unknown_market');
    assert.deepEqual([by.BTC!.maxLeverage, by.EUR!.maxLeverage, by.XAU!.maxLeverage, by.NVDA!.maxLeverage], [25, 20, 15, 8]);
    assert.deepEqual([by.BTC!.closedMaxLeverage, by.EUR!.closedMaxLeverage, by.NVDA!.closedMaxLeverage], [null, 8, 8]);
    // 24h change and volume arrive after ready, whenever GMTrade's market-info and candle services answer.
    // Out of US hours the keeper may send no stock price at all (11 of the 55 rows on 2026-09-25 07:00 UTC): a market
    // without a price has no 24h change, so the share is of the priced ones.
    const priced = rows.filter((r) => r.price !== null).length;
    const withStats = async () => (await get<Market[]>('/v1/markets')).body.filter((r) => r.change24h !== null && r.volume24h !== null).length;
    for (let waited = 0; (await withStats()) < priced * 0.8 && waited < 60_000; waited += 1_000) await new Promise((r) => setTimeout(r, 1_000));
    assert.ok((await withStats()) >= priced * 0.8, `24h change and volume: ${await withStats()} of ${priced} priced rows`);

    assert.equal((await get<Market>('/v1/markets/btc')).body.symbol, 'BTC');
    const missing = await get<ApiError>('/v1/markets/NOPE');
    assert.deepEqual([missing.status, missing.body.error.code], [404, 'unknown_market']);

    const candles = await get<CandlesResponse>('/v1/candles?symbol=SOL&interval=15m');
    assert.equal(candles.status, 200);
    assert.ok(candles.body.candles.length >= 295 && candles.body.candles.length <= 300);
    assert.ok(candles.body.candles.every((c, i, a) => i === 0 || c.time - a[i - 1]!.time === 900));
    assert.deepEqual(await get<CandlesResponse>('/v1/candles?symbol=SOL&interval=15m'), candles, 'served from cache');
    const to = Math.floor(Date.now() / 1000 / 3600) * 3600;
    const hours = await get<CandlesResponse>(`/v1/candles?symbol=SOL&interval=1h&from=${to - 23 * 3600}&to=${to}`);
    assert.equal(hours.body.candles.length, 24);
    // Derived intervals roll up the native windows just fetched: the same bars, no further wait.
    const halfHours = await get<CandlesResponse>('/v1/candles?symbol=SOL&interval=30m');
    assert.deepEqual([halfHours.status, halfHours.body.freshness, halfHours.body.source], [200, 'live', 'venue']);
    assert.deepEqual(halfHours.body.candles, rollup(candles.body.candles, '30m').filter((c) => c.time >= candles.body.candles[0]!.time));
    const twoHours = await get<CandlesResponse>(`/v1/candles?symbol=SOL&interval=2h&from=${to - 23 * 3600}&to=${to}`);
    assert.deepEqual(twoHours.body.candles, rollup(hours.body.candles, '2h'), 'the 24 hours as 12 two-hour bars');
    const weeks = await get<CandlesResponse>('/v1/candles?symbol=SOL&interval=1W');
    assert.ok(weeks.body.candles.length >= 20, `${weeks.body.candles.length} weeks (GMTrade's SOL 1D history starts 2026-04-10: 25 on 2026-09-25)`);
    assert.ok(weeks.body.candles.every((c) => new Date(c.time * 1000).getUTCDay() === 1), 'weeks start on Monday');
    for (const bad of ['symbol=SOL&interval=7m', 'symbol=SOL&interval=toString', 'interval=1h', 'symbol=SOL&interval=1h&from=7200&to=3600', 'symbol=SOL&interval=5m&from=0', 'symbol=SOL&interval=1h&from=-1']) {
      const r = await get<ApiError>(`/v1/candles?${bad}`);
      assert.deepEqual([r.status, r.body.error.code], [400, 'bad_request'], bad);
    }

    const trades = await get<MarketTrade[]>('/v1/markets/SOL/trades?limit=20');
    assert.equal(trades.status, 200);
    assert.ok(trades.body.length > 0 && trades.body.length <= 20);
    for (const t of trades.body) {
      assert.ok(t.symbol === 'SOL' && (t.side === 'Long' || t.side === 'Short') && Number(t.sizeUsd) > 0 && t.ts > 0);
      assert.match(t.price, DECIMAL);
    }

    const quote = await get<PriceImpactQuote>('/v1/quote?symbol=SOL&side=Long&sizeUsd=10000&collateralUsd=1000');
    assert.equal(quote.status, 200);
    const fee = Number(quote.body.openFeeUsd);
    assert.ok(fee >= 0.99 && fee <= 1.21, `open fee ${fee} for $10k at 0.010-0.012%`);
    assert.ok(Math.abs(quote.body.priceImpactPct) < 0.5);
    assert.ok(Math.abs(Number(quote.body.executionPrice) / Number(by.SOL!.price) - 1) < 0.01);
    const close = Number(quote.body.closeFeeUsd);
    assert.ok(close >= 0.99 && close <= 1.21 && Math.abs(Number(quote.body.roundTripFeeUsd) - fee - close) < 1e-6, `close fee ${close}`);
    assert.ok(Number(quote.body.liquidationPrice) < Number(quote.body.executionPrice) * 0.95, `liquidation ${quote.body.liquidationPrice} for a 10x long`);
    assert.deepEqual([quote.body.collateralUsd, quote.body.orderValueUsd, quote.body.platformFeeUsd], ['1000', '10000', '0']);
    const quoted = service.market('SOL')!; // the row the quote read: live rates move, and the catalog rebuilds at most once a second
    assert.deepEqual([quote.body.fundingRateHourlyPct, quote.body.borrowRateHourlyPct], [quoted.fundingRateHourlyLong, quoted.borrowRateHourlyLong]);
    assert.deepEqual([quote.body.maxSizeUsd, quote.body.maxLeverage], [quoted.maxSizeLong, quoted.maxLeverageLong]);
    for (const [bad, status] of [['side=Up&sizeUsd=1', 400], ['side=Long&sizeUsd=abc', 400], ['side=Long&sizeUsd=0', 400], ['side=Long&sizeUsd=90000000', 422]] as const) {
      const r = await get<ApiError>(`/v1/quote?symbol=SOL&${bad}`);
      assert.equal(r.status, status, bad);
    }

    const sol = service.market('SOL')!;
    const state = await service.marketState(sol.marketToken);
    const raw = state.raw as { market: string; virtualInventories: Record<string, string>; slot: number };
    assert.equal(decodeMarket(raw.market).meta.market_token_mint, sol.marketToken);
    assert.ok(raw.virtualInventories.EEcQz9yC68rztSEq8XggVtp8Sa8Dj3gWJ8ckJuQvv5xw && raw.slot > 0);
    assert.deepEqual([state.symbol, state.pure, state.isClosed, state.indexDecimals], ['SOL', true, false, 9]);
    // Collateral is USDC (unit price 1e14 = $1) and the index price is the live SOL price in unit form.
    assert.ok(state.prices.short.min > 99n * 10n ** 12n && state.prices.short.max < 101n * 10n ** 12n);
    assert.ok(Math.abs(Number(state.prices.index.min) / 1e11 / Number(sol.price) - 1) < 0.01, `SOL unit price ${state.prices.index.min} vs ${sol.price}`);
    assert.ok(state.prices.index.min <= state.prices.index.max);

    const heard: string[] = [];
    const off = service.onTick((t) => heard.push(t.symbol));
    const since = Date.now();
    await new Promise((r) => setTimeout(r, 6_000)); // the keeper pushes prices in bursts about once a second
    off();
    assert.ok(heard.length > 0, 'onTick listeners hear ticks');
    assert.match(service.price('sol')!.mid, DECIMAL);
    const priceEvents = events.filter((e) => e.at >= since && e.event.type === 'price');
    assert.ok(priceEvents.length >= 2 && priceEvents.length <= 61, `${priceEvents.length} price events in 6 s (max 10/s)`);
    // A symbol is in a frame only with a price or session it was not sent with before (a new timestamp alone is not).
    const sent = new Map<string, PriceTick>();
    for (const { event } of priceEvents) {
      if (event.type !== 'price') continue;
      assert.ok(event.ticks.length > 0, 'no empty frames');
      for (const tick of event.ticks) {
        const last = sent.get(tick.symbol);
        assert.ok(!last || last.min !== tick.min || last.max !== tick.max || last.session !== tick.session, `${tick.symbol} re-sent unchanged`);
        sent.set(tick.symbol, tick);
      }
    }
    const marketEvents = events.filter((e) => e.event.type === 'market');
    assert.ok(marketEvents.length >= rows.length, 'every market published once at start');
  } finally {
    await stop();
  }
});

test('live: allowlisted markets become tradable with MarketConfig leverage', { skip, timeout: 60_000 }, async () => {
  const { url, server } = await rpcStub(await allowlistAccounts());
  const { get, stop } = await start({ PROGRAM_ID, RPC_URL: url });
  try {
    const by = Object.fromEntries((await get<Market[]>('/v1/markets')).body.map((r) => [r.symbol, r]));
    assert.deepEqual([by.SOL!.tradable, by.SOL!.unavailableReason, by.SOL!.maxLeverage, by.SOL!.closedMaxLeverage], [true, undefined, 20, null]);
    assert.deepEqual([by.BTC!.tradable, by.BTC!.unavailableReason], [false, 'Not available for funded trading']);
    assert.deepEqual([by.ETH!.tradable, by.ETH!.unavailableReason], [false, 'Not available for funded trading']);
  } finally {
    await stop();
    server.close();
  }
});
