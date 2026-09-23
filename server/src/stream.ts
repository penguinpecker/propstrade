// Server-sent events hub for GET /v1/stream. Each frame is `data: <StreamEvent JSON>` (the event's `type` field
// tells kinds apart; no named SSE events). Events without an audience go to everyone; `{ wallet }` events only to
// connections opened with a live session of that wallet.
import { finished, PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { StreamEvent } from '@props/shared';
import type { Session } from './auth/routes.js';
import { ApiError } from './errors.js';

const HEARTBEAT_MS = 15_000;
/** A client that lets this much pile up unread is dropped; its EventSource reconnects and the app refetches. */
const MAX_BUFFERED_BYTES = 256 * 1024;
/** Open streams per client address and in total; each may hold MAX_BUFFERED_BYTES in the process that runs the keeper. */
const MAX_PER_ADDRESS = 10;
const MAX_CLIENTS = 2_000;

interface Client { address: string; session: Session | null; out: PassThrough }

export type StreamHub = ReturnType<typeof createStreamHub>;

export function createStreamHub({
  heartbeatMs = HEARTBEAT_MS, maxBufferedBytes = MAX_BUFFERED_BYTES, maxPerAddress = MAX_PER_ADDRESS, maxClients = MAX_CLIENTS,
} = {}) {
  const clients = new Set<Client>();

  function drop(client: Client) {
    clients.delete(client);
    client.out.destroy();
  }

  function send(client: Client, frame: string) {
    if (client.out.writableLength > maxBufferedBytes) drop(client);
    else client.out.write(frame);
  }

  function publish(event: StreamEvent, audience?: { wallet?: string }) {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      // An audience whose wallet is missing reaches nobody: a scoped event must never fall back to broadcast.
      if (!audience || (client.session !== null && client.session.wallet === audience.wallet)) send(client, frame);
    }
  }

  const heartbeat = setInterval(() => publish({ type: 'heartbeat', ts: Date.now() }), heartbeatMs);
  heartbeat.unref();

  return {
    publish,
    /** Registers a connection; the returned stream is the response body. Null when the address or the hub is full. */
    connect(address: string, session: Session | null): PassThrough | null {
      let fromAddress = 0;
      for (const client of clients) if (client.address === address) fromAddress++;
      if (fromAddress >= maxPerAddress || clients.size >= maxClients) return null;

      const client: Client = { address, session, out: new PassThrough() };
      clients.add(client);
      // A session's private events end with it: at its expiry here, at logout through endSession.
      const expiry = session ? setTimeout(() => drop(client), session.expiresAt.getTime() - Date.now()).unref() : undefined;
      client.out.on('close', () => {
        clients.delete(client);
        clearTimeout(expiry);
      });
      send(client, `data: ${JSON.stringify({ type: 'heartbeat', ts: Date.now() } satisfies StreamEvent)}\n\n`);
      return client.out;
    },
    /** Closes every stream opened with this session; the app's EventSource reconnects without it. */
    endSession(sessionId: string) {
      for (const client of clients) if (client.session?.id === sessionId) drop(client);
    },
    get size() {
      return clients.size;
    },
    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.out.end();
      clients.clear();
    },
  };
}

export function registerStream(app: FastifyInstance, hub: StreamHub) {
  app.get('/v1/stream', async (req, reply) => {
    const out = hub.connect(req.ip, await app.session(req));
    if (!out) throw new ApiError(429, 'too_many_streams', 'Too many open live connections, close another tab');
    // The subscriber lives exactly as long as its response, also when the client left during the session lookup or
    // Fastify discards the body (HEAD), where nothing else would ever close it.
    finished(reply.raw, () => out.destroy());
    reply.headers({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    return reply.send(out);
  });
  // Open streams would otherwise keep server.close() waiting forever.
  app.addHook('preClose', async () => hub.close());
}
