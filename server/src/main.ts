import { buildApp, loggerOptions } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createConnection } from './lib/solana.js';
import { registerModules, type ModuleStatus } from './modules/index.js';
import type { Services } from './modules/types.js';
import { createStreamHub } from './stream.js';

const config = loadConfig();
const { sql, db } = createDb(config.DATABASE_URL);
const hub = createStreamHub();
const modules: ModuleStatus = new Map();
const rpc = createConnection(config);
const app = await buildApp({
  config, db, sql, hub, modules, rpc, logger: loggerOptions(config.LOG_LEVEL),
});

const shutdown = new AbortController();
const services: Services = {};
await registerModules({
  app, log: app.log, env: process.env, publish: hub.publish, services, signal: shutdown.signal, config, db, sql, rpc,
}, modules);

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => {
    app.log.error('shutdown timed out');
    process.exit(1);
  }, 10_000);
  force.unref();
  shutdown.abort();
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.once('SIGTERM', () => void stop('SIGTERM'));
process.once('SIGINT', () => void stop('SIGINT'));

await app.listen({ port: config.PORT, host: config.HOST });
