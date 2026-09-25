// sim: the practice + evaluation engine (ARCHITECTURE.md §4.3). Routes /v1/sim/* and /v1/practice/*; implements
// SimService. Fills, liquidations and the rules loop run while this process holds the sim leader lock.
import { z } from 'zod';
import { createSealer } from '../../lib/integrity.ts';
import { LOCK_KEYS, runAsLeader } from '../../lib/leader.ts';
import type { ModuleContext, SimService } from '../types.ts';
import { createEngine } from './engine.ts';
import { createReader } from './read.ts';
import { registerRoutes } from './routes.ts';

/**
 * SIM_FILL_DELAY_MS: how long after an evaluation order (or its last change) the first fill-eligible tick may be;
 * GMTrade keepers take ~2 s, and an evaluation keeps that so its fills predict funded ones. Practice orders ignore it:
 * they fill on the first tick published after the request.
 */
const Env = z.object({ SIM_FILL_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(2_000) });

export default async function register(ctx: ModuleContext) {
  const marketdata = ctx.services.marketdata;
  if (!marketdata) throw new Error('sim needs the marketdata module');
  const { SIM_FILL_DELAY_MS } = Env.parse({ SIM_FILL_DELAY_MS: ctx.env.SIM_FILL_DELAY_MS || undefined });
  const engine = createEngine({
    db: ctx.db, log: ctx.log, marketdata, publish: ctx.publish, notify: ctx.notify, fillDelayMs: SIM_FILL_DELAY_MS,
    sealer: createSealer(ctx.config.SESSION_SECRET),
  });
  const reader = createReader(ctx.db, marketdata, engine.ensurePractice);
  registerRoutes(ctx.app, engine, reader);
  const leader = runAsLeader({ databaseUrl: ctx.config.DATABASE_URL, key: LOCK_KEYS.sim, signal: ctx.signal, log: ctx.log, run: engine.lead });

  const service: SimService & { engine: typeof engine; stopped: Promise<void> } = {
    ...reader,
    createEvaluation: engine.createEvaluation,
    onResolved: engine.onResolved,
    markRecorded: engine.markRecorded,
    engine,
    stopped: leader,
  };
  return service;
}
