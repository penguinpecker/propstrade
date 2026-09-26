// chain: props_vault indexer, funded accounts on GMTrade, payouts, verify, vault, config and the chain-job executor
// (ARCHITECTURE.md §4.4, §8). The indexer, the funded-account loop and the job executor run only on the leader.
import { eq } from 'drizzle-orm';
import type { StreamEvent } from '@props/shared';
import { PROPS_VAULT_PROGRAM_ID, PropsVaultClient } from '@props/sdk';
import { accounts, equitySnapshots, fundedAccounts } from '../../db/schema.ts';
import { createSealer } from '../../lib/integrity.ts';
import { LOCK_KEYS, runAsLeader } from '../../lib/leader.ts';
import { serverOrderFeeRate } from '../../lib/order-fee.ts';
import { loadKeypair } from '../../lib/solana.ts';
import type { ChainService, ModuleContext } from '../types.ts';
import { createFundedProvider } from './funded.ts';
import { createIndexer } from './indexer.ts';
import { createJobs, enqueue } from './jobs.ts';
import { createProgramReader } from './program.ts';
import type { Notice } from './projector.ts';
import { createReader } from './reader.ts';
import { registerRoutes } from './routes.ts';
import { createVenue, subsquid, type GmIndexer, type Valuation } from './venue.ts';
import { createVerify } from './verify.ts';

export interface ChainOptions {
  gm?: GmIndexer;
  /** Loop periods in ms (tests shorten them). */
  intervals?: { indexer?: number; venue?: number; jobs?: number };
}

export async function createChain(ctx: ModuleContext, opts: ChainOptions = {}) {
  const programId = PROPS_VAULT_PROGRAM_ID;
  if (ctx.config.PROGRAM_ID && ctx.config.PROGRAM_ID !== programId.toBase58()) {
    throw new Error(`PROGRAM_ID ${ctx.config.PROGRAM_ID} is not the props_vault program @props/sdk is built for (${programId.toBase58()})`);
  }
  const { db, rpc, log, services } = ctx;
  const client = new PropsVaultClient(rpc);
  const reader = createReader(client, rpc);
  const notify = (n: Notice) => ctx.notify(n.wallet, n);
  const program = createProgramReader({ db, rpc, client, programId, cluster: ctx.config.SOLANA_CLUSTER, serverRate: serverOrderFeeRate(ctx.config) });
  const venue = createVenue({
    db, rpc, client, reader, marketdata: services.marketdata, gm: opts.gm ?? subsquid, log, notify, referralRewardBps: ctx.config.REFERRAL_REWARD_BPS,
  });
  const funded = createFundedProvider({ db, venue, program });
  const indexer = createIndexer({
    db, rpc, client, programId, log, reader, sim: services.sim, notify,
    onApplied(events) {
      venue.changed([...new Set(events.flatMap((e) => ('funded' in e.data ? [e.data.funded] : [])))]);
      program.changed(events);
    },
  });
  const sealer = createSealer(ctx.config.SESSION_SECRET);
  const jobs = createJobs({
    db, rpc, client, sim: services.sim, log, sealer,
    keys: { risk: loadKeypair(ctx.env, 'RISK_AUTHORITY_KEYPAIR'), kyc: loadKeypair(ctx.env, 'KYC_AUTHORITY_KEYPAIR') },
  });

  services.sim?.onResolved((result) => {
    enqueue(db, sealer, 'record_evaluation_result', result.evaluation, result)
      .catch((err: unknown) => log.error({ err, evaluation: result.evaluation }, 'could not queue the evaluation result'));
  });

  // Live account updates for the owner's open sessions, and the equity series behind /performance.
  const published = new Map<string, string>();
  const publishOnce = (key: string, event: StreamEvent, wallet: string) => {
    const body = JSON.stringify(event);
    if (published.get(key) === body) return;
    published.set(key, body);
    ctx.publish(event, { wallet });
  };
  venue.onValued((v: Valuation, trader: string) => {
    void (async () => {
      const [row] = await db.select().from(accounts).innerJoin(fundedAccounts, eq(fundedAccounts.address, accounts.id)).where(eq(accounts.id, v.funded));
      if (!row) return;
      const summary = await funded.summaryOf(row.accounts, row.funded_accounts, v);
      if (published.get(`${v.funded}:equity`) !== summary.equity && venue.shouldSnapshot(v.funded)) {
        published.set(`${v.funded}:equity`, summary.equity);
        await db.insert(equitySnapshots).values({
          accountId: v.funded, ts: new Date(v.at), equity: summary.equity, realizedPnl: summary.realizedPnl, unrealizedPnl: summary.unrealizedPnl,
        }).onConflictDoNothing();
      }
      publishOnce(`${v.funded}:account`, { type: 'account', account: summary }, trader);
      publishOnce(`${v.funded}:positions`, { type: 'positions', accountId: v.funded, positions: await funded.positionsOf(v, v.funded) }, trader);
      const orders = await funded.orders(trader, v.funded);
      if (orders) publishOnce(`${v.funded}:orders`, { type: 'orders', accountId: v.funded, orders }, trader);
    })().catch((err: unknown) => log.warn({ err, funded: v.funded }, 'account update not published'));
  });

  registerRoutes(ctx.app, {
    db, sim: services.sim, funded, program, verify: createVerify({ db, rpc, programId, cluster: ctx.config.SOLANA_CLUSTER }),
    adminToken: ctx.config.ADMIN_API_TOKEN, sealer,
  });

  const leader = runAsLeader({
    databaseUrl: ctx.config.DATABASE_URL, key: LOCK_KEYS.chain, signal: ctx.signal, log,
    run: async (lost) => {
      await Promise.all([
        indexer.run(lost, opts.intervals?.indexer),
        venue.run(lost, opts.intervals?.venue),
        jobs.run(lost, opts.intervals?.jobs),
      ]);
    },
  });
  leader.catch((err: unknown) => log.error({ err }, 'chain leader loop stopped'));

  const service: ChainService = {
    list: funded.list, detail: funded.detail, positions: funded.positions, orders: funded.orders, history: funded.history,
    activity: funded.activity, performance: funded.performance, config: () => program.appConfig(), orderFeeRate: program.orderFeeRate,
  };
  return { service, indexer, venue, jobs, funded, program, leader };
}

export default async function register(ctx: ModuleContext): Promise<ChainService> {
  return (await createChain(ctx)).service;
}
