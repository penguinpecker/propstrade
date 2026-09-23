// Security review findings for the server core. Each test states the behaviour the code should have; they fail
// against the reviewed code and pass once the matching finding is fixed.
import { once } from 'node:events';
import { get, request, type IncomingMessage } from 'node:http';
import { randomInt } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@props/shared';
import { runAsLeader } from '../src/lib/leader.js';
import { APP_ORIGIN, makeApp, signIn } from './helpers.js';
import { testDatabaseUrl } from './db.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let base: string;
beforeAll(async () => {
  t = await makeApp();
  base = await t.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => { await t.close(); });

const until = async (check: () => boolean, tries = 100) => {
  for (let i = 0; i < tries && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

function head(url: string) {
  return new Promise<number>((resolve, reject) => {
    const req = request(url, { method: 'HEAD', agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
}

async function openStream(cookie?: string) {
  const req = get(`${base}/v1/stream`, { agent: false, headers: cookie ? { cookie } : {} });
  const [res] = (await once(req, 'response')) as [IncomingMessage];
  const events: StreamEvent[] = [];
  let buffer = '';
  res.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      events.push(JSON.parse(buffer.slice(0, end).replace(/^data: /, '')));
      buffer = buffer.slice(end + 2);
    }
  });
  res.on('error', () => {});
  const ended = new Promise((resolve) => res.on('close', resolve));
  return { events, close: async () => { req.destroy(); await ended; } };
}

describe('review: SSE hub', () => {
  it('HEAD /v1/stream does not leave a subscriber behind once the response is finished', async () => {
    const before = t.hub.size;
    for (let i = 0; i < 5; i++) await head(`${base}/v1/stream`);
    await new Promise((r) => setTimeout(r, 200));
    // Reviewed code: 5 subscribers stay in the hub forever, each written on every publish (unauthenticated leak).
    expect(t.hub.size).toBe(before);
  });

  it('stops delivering a wallet’s events to a stream once that session is logged out', async () => {
    const alice = await signIn(t.app);
    const stream = await openStream(alice.cookie);
    await until(() => stream.events.length >= 1);
    const out = await t.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: alice.cookie, origin: APP_ORIGIN } });
    expect(out.statusCode).toBe(204);
    t.hub.publish({ type: 'heartbeat', ts: 42 }, { wallet: alice.wallet });
    t.hub.publish({ type: 'heartbeat', ts: 43 });
    await until(() => stream.events.some((e) => e.type === 'heartbeat' && e.ts === 43));
    await stream.close();
    // Reviewed code: the revoked session's stream still receives the wallet-scoped event (ts 42).
    expect(stream.events.some((e) => e.type === 'heartbeat' && e.ts === 42)).toBe(false);
  });

  it('caps concurrent streams per client address', async () => {
    const streams = await Promise.all(Array.from({ length: 50 }, () => openStream()));
    await until(() => streams.every((s) => s.events.length >= 1));
    const accepted = streams.filter((s) => s.events.length >= 1).length;
    await Promise.all(streams.map((s) => s.close()));
    // Reviewed code: all 50 are held open (up to 300 new ones per minute per address, each allowed 1 MiB of backlog).
    expect(accepted).toBeLessThanOrEqual(20);
  });
});

describe('review: sessions', () => {
  it('logout refuses a foreign Origin like every other cookie-authenticated write', async () => {
    const { cookie } = await signIn(t.app);
    const res = await t.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie, origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('review: KYC country block', () => {
  it('refuses US territories (residents are US persons)', async () => {
    const user = await signIn(t.app);
    const res = await t.app.inject({
      method: 'POST', url: '/v1/kyc/start', headers: { cookie: user.cookie, origin: APP_ORIGIN }, payload: { country: 'PR' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('review: leader election', () => {
  const log = { info() {}, warn() {}, error() {} };
  // postgres-js recycles every connection after max_lifetime (default: random 30–60 minutes). Shortened to 1 s through
  // the URL here so the test runs in seconds; leader.ts sets no max_lifetime, so production gets the default.
  const shortLived = `${testDatabaseUrl()}?max_lifetime=1`;

  function contender(databaseUrl: string, key: number, intervalMs: number) {
    const stop = new AbortController();
    const state = { leading: false, terms: 0 };
    const done = runAsLeader({
      databaseUrl, key, signal: stop.signal, log, intervalMs,
      run: (lost) => new Promise<void>((resolve) => {
        state.leading = true;
        state.terms++;
        lost.addEventListener('abort', () => { state.leading = false; resolve(); }, { once: true });
      }),
    });
    return { state, stop: async () => { stop.abort(); await done; } };
  }

  it('keeps its lock (one term) while nothing fails', async () => {
    const c = contender(shortLived, randomInt(1, 2 ** 31 - 1), 100);
    await new Promise((r) => setTimeout(r, 2_500));
    await c.stop();
    // Reviewed code: the recycled connection silently releases the session lock and the term ends by itself.
    expect(c.state.terms).toBe(1);
  });

  it('never has two leaders at once when the leader’s connection is recycled', async () => {
    const key = randomInt(1, 2 ** 31 - 1);
    const a = contender(shortLived, key, 1_500); // lock drops at ~1 s, A notices at its 1.5 s check
    await until(() => a.state.leading);
    const b = contender(testDatabaseUrl(), key, 50);
    let overlap = false;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (a.state.leading && b.state.leading) overlap = true;
      await new Promise((r) => setTimeout(r, 10));
    }
    await Promise.all([a.stop(), b.stop()]);
    expect(overlap).toBe(false);
  });
});

describe('review: schema ranges', () => {
  const sql = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {} });
  afterAll(async () => { await sql.end(); });

  // Spec §3.1: Tier id is u16; Evaluation index and PayoutRequest seq are u32.
  it('tier_id holds every u16 and eval_index / seq hold every u32', async () => {
    const cols = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public' and (column_name in ('tier_id', 'eval_index', 'seq', 'payout_seq'))
      order by table_name, column_name`;
    const bits = { smallint: 15, integer: 31, bigint: 63 } as Record<string, number>;
    const need = { tier_id: 16, eval_index: 32, seq: 32, payout_seq: 32 } as Record<string, number>;
    const short = cols.filter((c) => bits[c.data_type]! < need[c.column_name]!).map((c) => `${c.table_name}.${c.column_name} ${c.data_type}`);
    expect(short).toEqual([]);
  });
});
