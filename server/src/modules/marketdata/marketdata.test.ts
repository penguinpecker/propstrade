// marketdata module through Fastify inject against live GMTrade services (PROPS_OFFLINE=1 skips the
// live tests). The Props allowlist is served by a local JSON-RPC stub holding a test IDL and
// MarketConfig accounts, since props_vault is not deployed yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { deflateSync } from 'node:zlib';
import Fastify from 'fastify';
import type { ApiError, CandlesResponse, Market, MarketTrade, PriceImpactQuote, StreamEvent } from '@props/shared';
import { IdlCoder, base58Encode, decodeMarket, findProgramAddress, pubkeyBytes, type Idl } from '@props/gmtrade';
import type { ModuleContext } from '../types.ts';
import register, { candleCacheTtl } from './index.ts';
import { fetchAllowlist, fetchAnchorIdl, marketConfigAddress } from './allowlist.ts';

const skip = process.env.PROPS_OFFLINE === '1';
const PROGRAM_ID = base58Encode(createHash('sha256').update('props-vault-test-program').digest());
const SOL_POOL = '6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc';
const BTC_POOL = 'Dqq58gS1TgRMDouUbdvhhzc51XXTNHG921WLxH9X2eB8';
const DECIMAL = /^-?\d+(\.\d+)?$/;

// ---- local RPC stub with an Anchor IDL account and MarketConfig accounts ----
const disc = (name: string) => [...createHash('sha256').update(`account:${name}`).digest().subarray(0, 8)];
const TEST_IDL: Idl = {
  accounts: [{ name: 'MarketConfig', discriminator: disc('MarketConfig') }],
  types: [{
    name: 'MarketConfig',
    type: {
      kind: 'struct',
      fields: [
        { name: 'enabled', type: 'bool' }, { name: 'index_symbol', type: { array: ['u8', 16] } },
        { name: 'max_leverage_bps', type: 'u32' }, { name: 'closed_max_leverage_bps', type: 'u32' }, { name: 'bump', type: 'u8' },
      ],
    },
  }],
};

function marketConfig(enabled: boolean, symbol: string, maxBps: number, closedBps: number): Buffer {
  const b = Buffer.alloc(8 + 1 + 16 + 4 + 4 + 1);
  Buffer.from(disc('MarketConfig')).copy(b);
  b.writeUInt8(enabled ? 1 : 0, 8);
  b.write(symbol, 9);
  b.writeUInt32LE(maxBps, 25);
  b.writeUInt32LE(closedBps, 29);
  return b;
}

function idlAccount(idl: Idl): { address: string; data: Buffer } {
  const base = pubkeyBytes(findProgramAddress([], PROGRAM_ID));
  const address = base58Encode(createHash('sha256').update(base).update('anchor:idl').update(pubkeyBytes(PROGRAM_ID)).digest());
  const json = deflateSync(JSON.stringify(idl));
  const header = Buffer.alloc(44);
  header.writeUInt32LE(json.length, 40);
  return { address, data: Buffer.concat([header, json]) };
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

function allowlistAccounts(): Map<string, Buffer> {
  const idl = idlAccount(TEST_IDL);
  return new Map([
    [idl.address, idl.data],
    [marketConfigAddress(PROGRAM_ID, SOL_POOL), marketConfig(true, 'SOL', 200_000, 80_000)],
    [marketConfigAddress(PROGRAM_ID, BTC_POOL), marketConfig(false, 'BTC', 250_000, 80_000)],
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

test('allowlist: Anchor IDL account and MarketConfig PDAs are read and decoded', async () => {
  const { url, server } = await rpcStub(allowlistAccounts());
  try {
    const idl = await fetchAnchorIdl(url, PROGRAM_ID);
    assert.deepEqual(idl, TEST_IDL);
    const list = await fetchAllowlist(url, PROGRAM_ID, idl, [SOL_POOL, BTC_POOL, '11111111111111111111111111111111']);
    assert.deepEqual(Object.fromEntries(list), {
      [SOL_POOL]: { enabled: true, maxLeverage: 20, closedMaxLeverage: 8 },
      [BTC_POOL]: { enabled: false, maxLeverage: 25, closedMaxLeverage: 8 },
    });
  } finally {
    server.close();
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
    assert.ok(rows.filter((r) => r.change24h !== null && r.volume24h !== null).length >= rows.length * 0.8, '24h change and volume');

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
    assert.deepEqual([state.symbol, state.pure, state.isClosed], ['SOL', true, false]);

    const heard: string[] = [];
    const off = service.onTick((t) => heard.push(t.symbol));
    const since = Date.now();
    await new Promise((r) => setTimeout(r, 6_000)); // the keeper pushes prices in bursts about once a second
    off();
    assert.ok(heard.length > 0, 'onTick listeners hear ticks');
    assert.match(service.price('sol')!.mid, DECIMAL);
    const priceEvents = events.filter((e) => e.at >= since && e.event.type === 'price');
    assert.ok(priceEvents.length >= 2 && priceEvents.length <= 25, `${priceEvents.length} price events in 6 s (max 4/s)`);
    for (let i = 1; i < priceEvents.length; i++) assert.ok(priceEvents[i]!.at - priceEvents[i - 1]!.at >= 200);
    const marketEvents = events.filter((e) => e.event.type === 'market');
    assert.ok(marketEvents.length >= rows.length, 'every market published once at start');
  } finally {
    await stop();
  }
});

test('live: allowlisted markets become tradable with MarketConfig leverage', { skip, timeout: 60_000 }, async () => {
  const { url, server } = await rpcStub(allowlistAccounts());
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
