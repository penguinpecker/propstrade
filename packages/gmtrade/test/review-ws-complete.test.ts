// Regression: when the keeper ends the price subscription with a graphql-ws `complete` message,
// KeeperFeed must subscribe again. The watchdog restarts the socket after 20 s, but graphql-ws only
// re-sends subscriptions that are still active, so without a resubscribe the feed would stay in 2 s
// HTTP polling ('delayed') until the process restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { KeeperFeed } from '../src/index.ts';

const snapshot = JSON.parse(readFileSync(new URL('fixtures/snapshot.json', import.meta.url), 'utf8'));
const SOL = 'So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH';

const frame = (text: string) => {
  const p = Buffer.from(text);
  return Buffer.concat([p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]), p]);
};
function textFrames(buf: Buffer): string[] {
  const out: string[] = [];
  for (let i = 0; i + 2 <= buf.length;) {
    let len = buf[i + 1]! & 127;
    let o = i + 2;
    if (len === 126) (len = buf.readUInt16BE(o)), (o += 2);
    const mask = buf.subarray(o, o + 4);
    const data = Buffer.from(buf.subarray(o + 4, o + 4 + len)).map((b, k) => b ^ mask[k % 4]!);
    if ((buf[i]! & 15) === 1) out.push(Buffer.from(data).toString());
    i = o + 4 + len;
  }
  return out;
}

test('resubscribes to prices after the keeper completes the subscription', { timeout: 40_000 }, async () => {
  let priceSubscriptions = 0;
  let ts = 2_000_000_000;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const q = JSON.parse(body) as { query?: string; params?: [string[]] };
      res.setHeader('content-type', 'application/json');
      if (q.params) return res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: q.params[0].map(() => null) } }));
      if (q.query!.includes('virtualInventories')) return res.end(JSON.stringify({ data: { virtualInventories: snapshot.virtualInventories } }));
      if (q.query!.includes('markets')) return res.end(JSON.stringify({ data: { markets: snapshot.markets } }));
      res.end(JSON.stringify({ data: { tokens: q.query!.includes('meta') ? snapshot.tokens : [] } }));
    });
  });
  const sockets = new Set<Socket>();
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: graphql-transport-ws\r\n\r\n`);
    socket.on('error', () => undefined);
    socket.on('data', (buf) => {
      for (const m of textFrames(buf)) {
        const msg = JSON.parse(m) as { type: string; id?: string; payload?: { query: string } };
        if (msg.type === 'connection_init') socket.write(frame(JSON.stringify({ type: 'connection_ack' })));
        if (msg.type === 'ping') socket.write(frame(JSON.stringify({ type: 'pong' })));
        if (msg.type === 'subscribe' && msg.payload!.query.includes('tokens(')) {
          priceSubscriptions++;
          socket.write(frame(JSON.stringify({ id: msg.id, type: 'next', payload: { data: { tokens: { pubkey: SOL, price: { ts: ++ts, min: '1', max: '1', isOpen: true } } } } })));
          // The first subscription is ended by the server, as a graphql-ws server does when its source stream ends.
          if (priceSubscriptions === 1) socket.write(frame(JSON.stringify({ id: msg.id, type: 'complete' })));
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `127.0.0.1:${(server.address() as { port: number }).port}`;
  const feed = new KeeperFeed({ httpUrl: `http://${url}`, rpcUrl: `http://${url}`, wsUrl: `ws://${url}/graphql-ws` });
  try {
    await feed.start();
    const end = Date.now() + 30_000;
    while (priceSubscriptions < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
    assert.ok(priceSubscriptions >= 2, `price subscription not renewed after completion (mode=${feed.mode})`);
  } finally {
    feed.stop();
    for (const s of sockets) s.destroy();
    server.closeAllConnections();
    server.close();
  }
});
