// KeeperFeed offline: HTTP snapshot, HTTP polling while the WebSocket is down, monotonic ticks and
// newest-slot-wins account refresh, against local stubs serving the snapshot fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { KeeperFeed, type KeeperToken } from '../src/index.ts';

const snapshot = JSON.parse(readFileSync(new URL('fixtures/snapshot.json', import.meta.url), 'utf8'));
const SOL = 'So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH';
const SOL_MARKET = 'CJg17Dn4xgUyEW3gKSSyteNw7LhP1o9pzm9eLtvuNjkQ';

async function stub(handle: (body: { query?: string; params?: [string[]] }) => unknown) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(handle(JSON.parse(body))));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
}

test('polls HTTP while the stream is down, keeps ticks monotonic and the newest account slot', { timeout: 20_000 }, async () => {
  const solTs = snapshot.tokens.find((t: KeeperToken) => t.pubkey === SOL).price.ts as number;
  const pollTs = [solTs + 1, solTs - 5, solTs + 2];
  let polls = 0;
  const keeper = await stub(({ query = '' }) => {
    if (query.includes('virtualInventories')) return { data: { virtualInventories: snapshot.virtualInventories } };
    if (query.includes('markets')) return { data: { markets: snapshot.markets } };
    if (query.includes('meta')) return { data: { tokens: snapshot.tokens } };
    const ts = pollTs[Math.min(polls++, pollTs.length - 1)]!;
    return { data: { tokens: [{ pubkey: SOL, price: { ts, min: String(ts), max: String(ts), isOpen: true } }] } };
  });
  let rpcSlot = 1;
  const rpc = await stub(({ params }) => ({
    jsonrpc: '2.0', id: 1,
    result: { context: { slot: rpcSlot }, value: params![0].map((k) => (k === SOL_MARKET ? { data: [`slot-${rpcSlot}`, 'base64'] } : null)) },
  }));
  // Nothing listens on port 9: the socket keeps failing and reconnecting with backoff.
  const feed = new KeeperFeed({ httpUrl: keeper.url, rpcUrl: rpc.url, wsUrl: 'ws://127.0.0.1:9/graphql-ws' });
  const ticks: number[] = [];
  feed.onTick((t) => t.pubkey === SOL && ticks.push(t.price!.ts));
  try {
    await feed.start();
    assert.deepEqual([feed.tokens.size, feed.markets.size, feed.accounts.size], [4, 3, 5]);
    assert.equal(feed.tokens.get(SOL)!.meta!.name, 'SOL');

    await new Promise((r) => setTimeout(r, 6_500));
    assert.equal(feed.mode, 'poll');
    assert.ok(polls >= 3, `${polls} polls`);
    assert.deepEqual(ticks, [solTs, solTs + 1, solTs + 2], 'snapshot, then polls; the older polled tick is dropped');
    assert.equal(feed.tokens.get(SOL)!.price!.ts, solTs + 2);
    assert.equal(feed.tokens.get(SOL)!.meta!.name, 'SOL', 'price-only updates keep the metadata');

    const keeperSlot = feed.accounts.get(SOL_MARKET)!.slot;
    await feed.refreshAccounts();
    assert.equal(feed.accounts.get(SOL_MARKET)!.slot, keeperSlot, 'an older RPC read does not replace newer data');
    rpcSlot = keeperSlot + 10;
    await feed.refreshAccounts();
    assert.deepEqual(feed.accounts.get(SOL_MARKET), { data: `slot-${rpcSlot}`, slot: rpcSlot });
  } finally {
    feed.stop();
    keeper.close();
    rpc.close();
  }
});
