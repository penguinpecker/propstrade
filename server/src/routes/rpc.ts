// Same-origin Solana JSON-RPC relay for the app (POST /v1/rpc). The browser never sees the RPC provider's key, and a
// provider that refuses browser requests (the public mainnet RPC answers 403 to any Origin) still works. Only the calls
// the app, @props/sdk and the wallet adapter make are relayed; nothing from the client's request but the body goes on.
import type { FastifyInstance } from 'fastify';

const READS = new Set([
  'getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getTokenAccountBalance', 'getLatestBlockhash', 'getBlockHeight',
  'getSlot', 'getEpochInfo', 'getGenesisHash', 'getVersion', 'getHealth', 'getFeeForMessage', 'getSignatureStatuses',
  'getMinimumBalanceForRentExemption', 'getRecentPrioritizationFees', 'isBlockhashValid',
]);
const GMTRADE_PROGRAM = 'Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo';
const MAX_BATCH = 10;
const MAX_TX_BASE64 = 1644; // Solana's 1,232-byte transaction limit, base64-encoded

interface Call { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

/** Why a call is not relayed, or null when it is. */
export function rpcRefusal(call: Call): string | null {
  if (typeof call.method !== 'string') return 'Invalid request';
  const params = Array.isArray(call.params) ? call.params : [];
  switch (call.method) {
    case 'sendTransaction':
    case 'simulateTransaction':
      return typeof params[0] === 'string' && params[0].length <= MAX_TX_BASE64 ? null : 'Transaction too large';
    case 'getProgramAccounts': {
      // Only the SDK's owner-filtered GMTrade position lookup: an unfiltered scan is expensive for the provider.
      const filters = (params[1] as { filters?: unknown } | undefined)?.filters;
      const filtered = Array.isArray(filters) && filters.some((f) => typeof f === 'object' && f !== null && 'memcmp' in f);
      return params[0] === GMTRADE_PROGRAM && filtered ? null : 'Only filtered exchange account queries are relayed';
    }
    default:
      return READS.has(call.method) ? null : `Method ${call.method} is not relayed`;
  }
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export function registerRpcRelay(app: FastifyInstance, { rpcUrl }: { rpcUrl: string }) {
  app.post('/v1/rpc', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const body = req.body as Call | Call[] | undefined;
    const calls = Array.isArray(body) ? body : [body];
    if (!calls.length || calls.length > MAX_BATCH || calls.some((c) => typeof c !== 'object' || c === null)) {
      return reply.code(400).send(rpcError(null, -32600, 'Invalid request'));
    }
    const refusals = (calls as Call[]).map(rpcRefusal);
    if (refusals.some(Boolean)) {
      const errors = (calls as Call[]).map((c, i) => rpcError(c.id, -32601, refusals[i] ?? 'Not sent: another call in this batch was refused'));
      return reply.send(Array.isArray(body) ? errors : errors[0]);
    }
    let upstream: Response;
    try {
      upstream = await fetch(rpcUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'rpc relay: upstream unreachable');
      return reply.code(502).send(rpcError((calls[0] as Call).id, -32603, 'The Solana RPC could not be reached'));
    }
    return reply.code(upstream.status).header('content-type', 'application/json').send(await upstream.text());
  });
}
