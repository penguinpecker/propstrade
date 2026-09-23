import { randomUUID } from 'node:crypto';
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
import { registerStream, type StreamHub } from './stream.js';

export interface AppDeps {
  config: Config;
  db: Db;
  sql: Sql;
  rpc: BalanceRpc;
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
  registerStream(app, deps.hub);
  registerAccountRoutes(app, { db, config, rpc: deps.rpc });
  registerAdminRoutes(app, { db, adminToken: config.ADMIN_API_TOKEN, sealer: createSealer(config.SESSION_SECRET) });

  app.get('/v1/health', async (_req, reply) => {
    const dbOk = await sql`select 1`.then(() => true, () => false);
    return reply.status(dbOk ? 200 : 503).send({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'down',
      modules: Object.fromEntries(deps.modules),
      time: Date.now(),
      keeper: deps.services?.keeper?.status(),
    });
  });

  return app;
}
