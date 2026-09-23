// keeper: leader-only risk loops (ARCHITECTURE.md §4.5) — sync cranks, equity-floor stop-outs, the session guard,
// order cleanup, owner SOL top-ups, payout review and the GMTrade upgrade watch — plus operator alerts and the admin
// route that acknowledges a GMTrade deploy. Every transaction is signed by RISK_AUTHORITY_KEYPAIR and sent only after
// the leader lock is confirmed still held.
import { PropsVaultClient } from '@props/sdk';
import { createSealer } from '../../lib/integrity.ts';
import { LOCK_KEYS, runAsLeader } from '../../lib/leader.ts';
import { loadKeypair } from '../../lib/solana.ts';
import { createReader } from '../chain/reader.ts';
import type { KeeperStatus, ModuleContext } from '../types.ts';
import { createAlerts } from './alerts.ts';
import { createKeeper } from './keeper.ts';
import { registerKeeperRoutes } from './routes.ts';

export interface KeeperOptions {
  /** Tick period and leader-lock check period, ms (tests shorten or lengthen them). */
  intervals?: { tick?: number; leader?: number };
  now?: () => number;
}

/** GMTRADE_DEPLOY_SLOT: the last-deploy slot of the GMTrade program release that was reviewed (optional). */
function reviewedDeploySlot(env: Record<string, string | undefined>): number | undefined {
  const value = env.GMTRADE_DEPLOY_SLOT;
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw new Error('GMTRADE_DEPLOY_SLOT must be a slot number');
  return Number(value);
}

export function createKeeperModule(ctx: ModuleContext, opts: KeeperOptions = {}) {
  const client = new PropsVaultClient(ctx.rpc);
  const keeper = createKeeper({
    db: ctx.db, rpc: ctx.rpc, client, reader: createReader(client, ctx.rpc), marketdata: ctx.services.marketdata,
    risk: loadKeypair(ctx.env, 'RISK_AUTHORITY_KEYPAIR'), reviewedDeploySlot: reviewedDeploySlot(ctx.env), log: ctx.log, notify: ctx.notify,
    alerts: createAlerts({ env: ctx.env, log: ctx.log }), now: opts.now, sealer: createSealer(ctx.config.SESSION_SECRET),
  });
  const leader = runAsLeader({
    databaseUrl: ctx.config.DATABASE_URL, key: LOCK_KEYS.keeper, signal: ctx.signal, log: ctx.log, intervalMs: opts.intervals?.leader,
    run: (lost, held) => keeper.run(lost, held, opts.intervals?.tick),
  });
  leader.catch((err: unknown) => ctx.log.error({ err }, 'keeper leader loop stopped'));
  return { service: { status: keeper.status }, keeper, leader };
}

export default async function register(ctx: ModuleContext): Promise<{ status(): KeeperStatus }> {
  registerKeeperRoutes(ctx.app, { db: ctx.db, adminToken: ctx.config.ADMIN_API_TOKEN });
  return createKeeperModule(ctx).service;
}
