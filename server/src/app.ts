import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { registerAuth } from './auth/routes.js';
import type { Config } from './config.js';
import type { Db, Sql } from './db/client.js';
import { errorHandler, notFoundHandler } from './errors.js';
import type { ModuleStatus } from './modules/index.js';
import type { Services } from './modules/types.js';
import { type BalanceRpc, registerAccountRoutes } from './routes/account.js';
import { createSealer } from './lib/integrity.js';
import { registerAdminRoutes } from './routes/admin.js';
import { type PayoutRpc, registerReferralRoutes } from './routes/referrals.js';
import { registerRpcRelay } from './routes/rpc.js';
import { registerStream, type StreamHub } from './stream.js';

export interface AppDeps {
  config: Config;
  db: Db;
  sql: Sql;
  rpc: BalanceRpc & PayoutRpc;
  hub: StreamHub;
  modules: ModuleStatus;
  /** Module services, filled as modules register (health reads the keeper's status). */
  services?: Services;
  logger: FastifyServerOptions['logger'];
}

/** Pino options: never let credentials reach the log, whatever object a module logs. */
export function loggerOptions(level: string) {
  return {
    level,
    redact: {
      paths: [
        'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
        'headers.authorization', 'headers.cookie', '*.headers.authorization', '*.headers.cookie',
        'secretKey', '*.secretKey', 'privateKey', '*.privateKey', 'token', '*.token',
      ],
      censor: '[redacted]',
    },
  };
}

export async function buildApp(deps: AppDeps) {
  const { config, db, sql } = deps;
  const app = Fastify({
    logger: deps.logger,
    // Trust exactly the proxies in front of us (Railway's edge = 1), so X-Forwarded-For cannot be spoofed past them.
    trustProxy: (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
    bodyLimit: 64 * 1024,
    genReqId: () => randomUUID(),
  });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } });
  await app.register(cors, { origin: [config.APP_ORIGIN], credentials: true, methods: ['GET', 'POST', 'PUT', 'DELETE'] });
  // ponytail: in-memory counters are right for the single Railway replica; use a Redis store if it ever scales out.
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(cookie);

  registerAuth(app, { db, config, hub: deps.hub });
  registerStream(app, deps.hub, deps.services);
  registerAccountRoutes(app, { db, config, rpc: deps.rpc });
  registerAdminRoutes(app, { db, adminToken: config.ADMIN_API_TOKEN, sealer: createSealer(config.SESSION_SECRET) });
  registerReferralRoutes(app, { db, config, rpc: deps.rpc });
  registerRpcRelay(app, { rpcUrl: config.RPC_URL });

  // How long the process was busy (p99 over the last minute): high means this server is overloaded, not its sources.
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let loopDelayMs = 0;
  const loopTimer = setInterval(() => { loopDelayMs = Math.round(loopDelay.percentile(99) / 1e6); loopDelay.reset(); }, 60_000);
  loopTimer.unref();
  app.addHook('onClose', async () => { clearInterval(loopTimer); loopDelay.disable(); });

  app.get('/v1/health', async (_req, reply) => {
    const dbOk = await sql`select 1`.then(() => true, () => false);
    // Outside sources that fail degrade the service (it serves fallbacks) without making it unhealthy.
    const upstreams = deps.services?.marketdata?.health();
    const sourceDown = Object.values(upstreams ?? {}).some((u) => u.state === 'down');
    return reply.status(dbOk ? 200 : 503).send({
      status: dbOk && !sourceDown ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'down',
      modules: Object.fromEntries(deps.modules),
      time: Date.now(),
      eventLoopDelayMs: loopDelayMs,
      keeper: deps.services?.keeper?.status(),
      upstreams,
    });
  });

  return app;
}
