import { buildApp, loggerOptions } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createConnection } from './lib/solana.js';
import { registerModules, type ModuleStatus } from './modules/index.js';
import type { Services } from './modules/types.js';
import { createStreamHub } from './stream.js';
import { notifications } from './db/schema.js';
import { backfillReferralCodes } from './routes/referrals.js';

const config = loadConfig();
const { sql, db } = createDb(config.DATABASE_URL);
const hub = createStreamHub();
const modules: ModuleStatus = new Map();
const rpc = createConnection(config);
const services: Services = {};
const app = await buildApp({
  config, db, sql, hub, modules, services, rpc, logger: loggerOptions(config.LOG_LEVEL),
});

// Users from before the referral program get their codes, oldest first; sign-ins give new users theirs.
backfillReferralCodes(db).then(
  (given) => { if (given) app.log.info({ given }, 'referral codes given'); },
  (err: unknown) => app.log.error({ err }, 'referral code backfill failed'),
);

const shutdown = new AbortController();
await registerModules({
  app, log: app.log, env: process.env, publish: hub.publish, services, signal: shutdown.signal, config, db, sql, rpc,
  async notify(wallet, n) {
    const [row] = await db.insert(notifications).values({ wallet, ...n }).returning();
    if (!row) return;
    hub.publish({ type: 'notification', notification: {
      id: String(row.id), title: row.title, body: row.body, href: row.href, kind: row.kind, ts: row.createdAt.getTime(), read: false,
    } }, { wallet });
  },
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
