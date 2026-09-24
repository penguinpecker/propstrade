// marketdata module through Fastify inject against live GMTrade services (PROPS_OFFLINE=1 skips the
// live tests). The Props allowlist is served by a local JSON-RPC stub holding MarketConfig accounts encoded by the
// props_vault client in @props/sdk. The candle cache and pre-warm run against a stand-in feed and candle service on
// node's mock timers, which move the clock across bucket boundaries.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { inflateSync } from 'node:zlib';
import BN from 'bn.js';
import Fastify from 'fastify';
import { Connection, PublicKey } from '@solana/web3.js';
import type { ApiError, Candle, CandlesResponse, Market, MarketTrade, PriceImpactQuote, PriceTick, StreamEvent } from '@props/shared';
import {
  IdlCoder, INTERVAL_SECONDS, NO_ACCOUNT, USDC_MINT, base58Encode, decodeMarket, findProgramAddress, getMultipleAccounts, pubkeyBytes,
  type Idl, type KeeperMarket, type KeeperToken,
} from '@props/gmtrade';
import { PropsVaultClient } from '@props/sdk';
import type { ModuleContext } from '../types.ts';
import register, { candleCacheTtl, candleWindow, changedForDisplay, createMarketData, type MarketDataOptions } from './index.ts';
import { fetchAllowlist, marketConfigAddress } from './allowlist.ts';

const skip = process.env.PROPS_OFFLINE === '1';
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
 *  response says which call it came from) and whose `close` is the bucket time. The calls `hang` matches (single-token
 *  ones, for `true`) wait until `release` resolves or rejects them; a batch call `fail` matches is rejected, and a batch
 *  answer leaves the `omit`ted token out. */
function stubCandles() {
  type Call = { batch: boolean; tokens: string[]; res: number; from: number; to: number };
  const calls: Call[] = [];
  let hanging: (call: Call) => boolean = () => false;
  let failing: (call: Call) => boolean = () => false;
  let omitted = '';
  let pending: ((ok: boolean) => void)[] = [];
  const bars = (from: number, to: number, res: number, tag: number): Candle[] => {
    const out: Candle[] = [];
    for (let time = from; time <= to; time += res) out.push({ time, open: tag, high: tag, low: tag, close: time });
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

/** The module on mock timers (the clock starts at `nowSec`), the stand-in feed and candle service, the RPC stub. */
async function stubbedStart(t: TestContext, nowSec: number) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: nowSec * 1000 });
  const { url, server } = await rpcStub(await allowlistAccounts());
  const app = Fastify({ logger: false });
  const abort = new AbortController();
  const candles = stubCandles();
  const events: StreamEvent[] = [];
  const ctx: ModuleContext = {
    app, log: app.log, env: { PROGRAM_ID, RPC_URL: url }, services: {}, signal: abort.signal, publish: (event) => events.push(event),
    config: {} as never, db: {} as never, sql: {} as never, rpc: {} as never, notify: async () => {},
  };
  const { feed, tick } = stubFeed(nowSec);
  const service = await createMarketData(ctx, { feed, gm: candles.gm });
  await app.ready();
  await service.ready();
  t.after(async () => { abort.abort(); await app.close(); server.close(); });
  const get = async <T>(path: string) => {
    const res = await app.inject({ method: 'GET', url: path });
    return { status: res.statusCode, body: res.json() as T, headers: res.headers };
  };
  const settle = () => new Promise((r) => setImmediate(r));
  /** Moves the clock ahead a second at a time, letting each timer's asynchronous work finish before the next second. */
  const advance = async (seconds: number) => { for (let i = 0; i < seconds; i++) { t.mock.timers.tick(1_000); await settle(); } };
  return { get, candles, events, tick, advance, settle, jump: (sec: number) => t.mock.timers.setTime(sec * 1000) };
}

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
    for (const interval of Object.keys(INTERVAL_SECONDS)) {
      const r = await get<CandlesResponse>(`/v1/candles?symbol=${symbol}&interval=${interval}`);
      assert.deepEqual([r.status, r.body.freshness, r.body.candles.length, r.headers['cache-control']], [200, 'live', 300, LIVE], `${symbol} ${interval}`);
    }
  }
  assert.equal(candles.calls.length, 11, 'every latest window came from the cache');
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
  const bad = await get<ApiError>('/v1/candles?symbol=SOL&interval=2h');
  assert.deepEqual([bad.status, bad.headers['cache-control']], [400, 'no-store']);
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
  openInterestLong: '1000.00', openInterestShort: '1000.00', fundingRateHourlyLong: 0.001, borrowRateHourlyLong: 0.002, borrowRateHourlyShort: 0.002,
  capacityLong: '1000.00', capacityShort: '1000.00', poolLiquidity: '1000.00', maxLeverage: 20, closedMaxLeverage: null,
  session: 'open', freshness: 'live', updatedAt: 1_800_000_000_000,
};

test('market rows: re-sent only when a figure the app shows moved past its display precision (1 % for USD figures), always on a flag change', async (t) => {
  const changed = (patch: Partial<Market>) => changedForDisplay(ROW, { ...ROW, ...patch });
  assert.equal(changed({}), false);
  assert.equal(changed({ price: '201', updatedAt: ROW.updatedAt! + 1 }), false, 'price and updatedAt travel in the ticks');
  assert.equal(changed({ borrowRateHourlyLong: 0.9, borrowRateHourlyShort: 0.9 }), false, 'borrow rates are not shown');
  assert.deepEqual([changed({ change24h: 1.239 }), changed({ change24h: 1.24 })], [false, true], '24h change: 2 decimals');
  assert.deepEqual([changed({ fundingRateHourlyLong: 0.00109 }), changed({ fundingRateHourlyLong: 0.0011 })], [false, true], 'funding: 4 decimals');
  for (const key of ['volume24h', 'openInterestLong', 'openInterestShort', 'capacityLong', 'capacityShort', 'poolLiquidity'] as const) {
    assert.deepEqual([changed({ [key]: '1009.99' }), changed({ [key]: '1010.00' }), changed({ [key]: null })], [false, true, true], key);
  }
  for (const patch of [{ session: 'closed' }, { freshness: 'stale' }, { tradable: false, unavailableReason: 'Not available' }, { maxLeverage: 10 }, { closedMaxLeverage: 8 }] as const) {
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
    assert.match(by.AAVE!.unavailableReason!, /no USDC-only pool/);
    assert.deepEqual([by.BTC!.maxLeverage, by.EUR!.maxLeverage, by.XAU!.maxLeverage, by.NVDA!.maxLeverage], [25, 20, 15, 8]);
    assert.deepEqual([by.BTC!.closedMaxLeverage, by.EUR!.closedMaxLeverage, by.NVDA!.closedMaxLeverage], [null, 8, 8]);
    // 24h change and volume arrive after ready, whenever GMTrade's market-info and candle services answer.
    const withStats = async () => (await get<Market[]>('/v1/markets')).body.filter((r) => r.change24h !== null && r.volume24h !== null).length;
    for (let waited = 0; (await withStats()) < rows.length * 0.8 && waited < 60_000; waited += 1_000) await new Promise((r) => setTimeout(r, 1_000));
    assert.ok((await withStats()) >= rows.length * 0.8, '24h change and volume');

    assert.equal((await get<Market>('/v1/markets/btc')).body.symbol, 'BTC');
    const missing = await get<ApiError>('/v1/markets/NOPE');
    assert.deepEqual([missing.status, missing.body.error.code], [404, 'not_found']);

    const candles = await get<CandlesResponse>('/v1/candles?symbol=SOL&interval=15m');
    assert.equal(candles.status, 200);
    assert.ok(candles.body.candles.length >= 295 && candles.body.candles.length <= 300);
    assert.ok(candles.body.candles.every((c, i, a) => i === 0 || c.time - a[i - 1]!.time === 900));
    assert.deepEqual(await get<CandlesResponse>('/v1/candles?symbol=SOL&interval=15m'), candles, 'served from cache');
    const to = Math.floor(Date.now() / 1000 / 3600) * 3600;
    const hours = await get<CandlesResponse>(`/v1/candles?symbol=SOL&interval=1h&from=${to - 23 * 3600}&to=${to}`);
    assert.equal(hours.body.candles.length, 24);
    for (const bad of ['symbol=SOL&interval=2h', 'symbol=SOL&interval=toString', 'interval=1h', 'symbol=SOL&interval=1h&from=7200&to=3600', 'symbol=SOL&interval=5m&from=0', 'symbol=SOL&interval=1h&from=-1']) {
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

    const quote = await get<PriceImpactQuote>('/v1/quote?symbol=SOL&side=Long&sizeUsd=10000');
    assert.equal(quote.status, 200);
    const fee = Number(quote.body.openFeeUsd);
    assert.ok(fee >= 0.99 && fee <= 1.21, `open fee ${fee} for $10k at 0.010-0.012%`);
    assert.ok(Math.abs(quote.body.priceImpactPct) < 0.5);
    assert.ok(Math.abs(Number(quote.body.executionPrice) / Number(by.SOL!.price) - 1) < 0.01);
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
