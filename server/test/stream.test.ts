import { once } from 'node:events';
import { get, request, type IncomingMessage } from 'node:http';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PriceTick, StreamEvent } from '@props/shared';
import type { Session } from '../src/auth/routes.js';
import type { Services } from '../src/modules/types.js';
import { createStreamHub } from '../src/stream.js';
import { makeApp, signIn } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let base: string;
beforeAll(async () => {
  t = await makeApp();
  base = await t.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => { await t.close(); });

/** Opens GET /v1/stream on its own socket and collects parsed events until the server ends it. */
async function openStream(cookie?: string, from = base) {
  const req = get(`${from}/v1/stream`, { agent: false, headers: cookie ? { cookie } : {} });
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
  res.on('error', () => {}); // "aborted" when we hang up ourselves
  const ended = new Promise((resolve) => res.on('close', resolve));
  return { res, events, ended, close: async () => { req.destroy(); await ended; } };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

const session = (wallet: string, ttlMs = 60_000): Session => ({ id: wallet, wallet, expiresAt: new Date(Date.now() + ttlMs) });

describe('GET /v1/stream', () => {
  it('delivers broadcasts to everyone and wallet events only to that wallet', async () => {
    const alice = await signIn(t.app);
    const bob = await signIn(t.app);
    const a = await openStream(alice.cookie);
    const b = await openStream(bob.cookie);
    const anon = await openStream();
    expect(a.res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(a.res.headers['cache-control']).toBe('no-cache, no-transform');
    await until(() => t.hub.size === 3);

    t.hub.publish({ type: 'heartbeat', ts: 1 });
    t.hub.publish({ type: 'heartbeat', ts: 2 }, { wallet: alice.wallet });
    t.hub.publish({ type: 'heartbeat', ts: 3 }, { wallet: bob.wallet });
    t.hub.publish({ type: 'heartbeat', ts: 4 }, { wallet: undefined });
    t.hub.publish({ type: 'heartbeat', ts: 5 }); // per-connection order: seeing 5 means 4 would have arrived first
    const last = (s: { events: StreamEvent[] }) => s.events.at(-1);
    await until(() => [a, b, anon].every((s) => last(s)?.type === 'heartbeat' && (last(s) as { ts: number }).ts === 5));

    // Every connection starts with a heartbeat carrying the current time; then only what its audience allows.
    const published = (s: { events: StreamEvent[] }) => s.events.slice(1).map((e) => (e.type === 'heartbeat' ? e.ts : null));
    expect(published(a)).toEqual([1, 2, 5]);
    expect(published(b)).toEqual([1, 3, 5]);
    expect(published(anon)).toEqual([1, 5]);

    await Promise.all([a.close(), b.close(), anon.close()]);
    await until(() => t.hub.size === 0);
    expect(t.hub.size).toBe(0);
  });

  it('starts every stream with a heartbeat, then a frame with every market\'s latest price', async () => {
    const tick = (symbol: string): PriceTick => ({ symbol, min: '1', max: '3', mid: '2', ts: 1, session: 'open' });
    const marketdata = {
      markets: () => [{ symbol: 'SOL' }, { symbol: 'NEW' }, { symbol: 'BTC' }],
      price: (symbol: string) => (symbol === 'NEW' ? undefined : tick(symbol)), // no price yet: left out, not null
    } as unknown as Services['marketdata'];
    const own = await makeApp({ services: { marketdata } });
    const url = await own.app.listen({ port: 0, host: '127.0.0.1' });
    const stream = await openStream(undefined, url);
    await until(() => stream.events.length >= 2);
    expect(stream.events[0]!.type).toBe('heartbeat');
    expect(stream.events[1]).toEqual({ type: 'price', ticks: [tick('SOL'), tick('BTC')] });
    await stream.close();
    await own.close();
  });

  it('ends open streams when the server shuts down', async () => {
    const own = await makeApp();
    const url = await own.app.listen({ port: 0, host: '127.0.0.1' });
    const req = get(`${url}/v1/stream`, { agent: false });
    const [res] = (await once(req, 'response')) as [IncomingMessage];
    res.resume();
    await own.close();
    await once(res, 'close');
    expect(own.hub.size).toBe(0);
  });

  it('refuses a stream above the per-address cap with 429 and frees the slot on close', async () => {
    const streams = await Promise.all(Array.from({ length: 10 }, () => openStream()));
    const refused = await t.app.inject({ method: 'GET', url: '/v1/stream' });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('too_many_streams');
    await streams[0]!.close();
    await until(() => t.hub.size === 9);
    const again = await openStream();
    expect(again.res.statusCode).toBe(200);
    await Promise.all([again, ...streams.slice(1)].map((s) => s.close()));
  });

  it('ends a signed-in stream when its session is logged out', async () => {
    const alice = await signIn(t.app);
    const stream = await openStream(alice.cookie);
    await until(() => t.hub.size === 1);
    await t.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: alice.cookie } });
    await stream.ended;
    expect(t.hub.size).toBe(0);
  });

  it('never keeps a subscriber whose client left before the stream was attached (GET or HEAD)', async () => {
    const own = await makeApp();
    own.app.addHook('preHandler', () => sleep(100)); // the client is gone before the handler attaches the stream
    const url = await own.app.listen({ port: 0, host: '127.0.0.1' });
    for (const method of ['GET', 'HEAD']) {
      const req = request(`${url}/v1/stream`, { method, agent: false }).on('error', () => {});
      req.end();
      await sleep(20);
      req.destroy();
    }
    await sleep(300);
    expect(own.hub.size).toBe(0);
    await own.close();
  });
});

describe('stream hub', () => {
  it('sends a heartbeat on its interval', async () => {
    const hub = createStreamHub({ heartbeatMs: 20 });
    const out = hub.connect('10.0.0.1', null)!;
    const frames: string[] = [];
    out.on('data', (chunk: Buffer) => frames.push(chunk.toString()));
    await until(() => frames.length >= 3);
    expect(frames.every((f) => f.startsWith('data: {"type":"heartbeat"'))).toBe(true);
    hub.close();
  });

  it('drops a client that stops reading instead of buffering without bound', async () => {
    const hub = createStreamHub({ maxBufferedBytes: 64 * 1024 });
    const slow = hub.connect('10.0.0.1', session('wallet-a'))!; // never read
    const fast = hub.connect('10.0.0.2', session('wallet-b'))!;
    fast.resume();
    const title = 'x'.repeat(8 * 1024);
    for (let i = 0; i < 40 && !slow.destroyed; i++) {
      hub.publish({ type: 'notification', notification: { id: String(i), title, body: '', href: '', ts: i, read: false, kind: 'account' } });
      await tick();
    }
    expect(slow.destroyed).toBe(true);
    expect(fast.destroyed).toBe(false);
    expect(hub.size).toBe(1);
    hub.close();
  });

  it('caps streams per address and in total', async () => {
    const hub = createStreamHub({ maxPerAddress: 2, maxClients: 3 });
    const first = hub.connect('10.0.0.1', null)!;
    expect(hub.connect('10.0.0.1', null)).not.toBeNull();
    expect(hub.connect('10.0.0.1', null)).toBeNull(); // address full
    expect(hub.connect('10.0.0.2', null)).not.toBeNull();
    expect(hub.connect('10.0.0.3', null)).toBeNull(); // hub full
    first.destroy();
    await until(() => hub.size === 2);
    expect(hub.connect('10.0.0.3', null)).not.toBeNull();
    hub.close();
  });

  it('builds the first frame only for a stream it accepts', () => {
    const hub = createStreamHub({ maxPerAddress: 1 });
    let built = 0;
    const snapshot = () => { built += 1; return null; };
    expect(hub.connect('10.0.0.1', null, snapshot)).not.toBeNull();
    expect(hub.connect('10.0.0.1', null, snapshot)).toBeNull();
    expect(built).toBe(1);
    hub.close();
  });

  it('stops a session\'s stream at the session expiry', async () => {
    const hub = createStreamHub();
    const expiring = hub.connect('10.0.0.1', session('wallet-a', 50))!;
    const lasting = hub.connect('10.0.0.1', session('wallet-a'))!;
    await until(() => expiring.destroyed);
    expect(expiring.destroyed).toBe(true);
    expect(lasting.destroyed).toBe(false);
    expect(hub.size).toBe(1);
    hub.close();
  });
});
