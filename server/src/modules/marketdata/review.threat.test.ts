// Threat-model review: the price pin (PUT /v1/test/prices/:symbol) decides simulated fills, and so evaluation results
// that the risk authority records onchain and that unlock funded capital. It must not exist on a mainnet server,
// whatever NODE_ENV says: one mis-set variable would hand evaluation outcomes to whoever holds the admin token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import register from './index.ts';

test('price pin hook: absent on a mainnet-beta server even with NODE_ENV=test', async () => {
  const app = Fastify({ logger: false });
  const abort = new AbortController();
  await register({
    app, log: app.log, env: { NODE_ENV: 'test' }, services: {}, signal: abort.signal, publish: () => {}, notify: async () => {},
    config: { ADMIN_API_TOKEN: 'a'.repeat(32), SOLANA_CLUSTER: 'mainnet-beta' } as never, db: {} as never, sql: {} as never, rpc: {} as never,
  });
  await app.ready();
  const registered = app.hasRoute({ method: 'PUT', url: '/v1/test/prices/:symbol' });
  abort.abort();
  await app.close();
  assert.equal(registered, false, 'PUT /v1/test/prices/:symbol is registered on a mainnet-beta server');
});
