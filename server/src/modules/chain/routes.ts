// HTTP routes owned by the chain module: /v1/config, /v1/accounts* (practice + evaluation from the sim module, funded
// from here, dispatched by id), payouts, verify, vault, the public trader lookup (./traders.ts), and under /v1/admin
// the operator payout review, lifting a funded account's restriction and retrying a chain job that failed for good.
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Payout } from '@props/shared';
import type { Db } from '../../db/client.ts';
import { accounts, adminAuditLog, chainJobs, fundedAccounts, payouts } from '../../db/schema.ts';
import { ApiError, parse } from '../../errors.ts';
import type { Sealer } from '../../lib/integrity.ts';
import { walletSchema } from '../../lib/solana.ts';
import { adminAuth, audit } from '../../routes/admin.ts';
import type { AccountsProvider, SimService } from '../types.ts';
import type { FundedProvider } from './funded.ts';
import { jobRow, requeue, type JobPayload } from './jobs.ts';
import { ProgramNotInitialized, type ProgramReader } from './program.ts';
import { PAYOUT_REJECTION_REASONS, rejectionReason } from './projector.ts';
import { dec } from './reader.ts';
import { registerTraderRoutes } from './traders.ts';

const AccountParams = z.object({ id: z.string().min(1).max(64) });
const PayoutParams = z.object({ id: walletSchema });
const FundedParams = z.object({ id: walletSchema });
const PerformanceQuery = z.object({ period: z.enum(['1W', '1M', 'All']).default('All') });
const VerifyQuery = z.object({ q: z.string().trim().min(1).max(100) });
const AdminPayoutsQuery = z.object({
  status: z.enum(['requested', 'reviewing', 'paid', 'rejected', 'cancelled', 'uncertain']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const JobParams = z.object({ id: z.uuid() });
const RejectBody = z.object({
  reasonCode: z.number().int().refine((c) => c in PAYOUT_REJECTION_REASONS, `one of ${Object.keys(PAYOUT_REJECTION_REASONS).join(', ')}`),
});

const notFound = () => new ApiError(404, 'not_found', 'Account not found');

export function registerRoutes(app: FastifyInstance, d: {
  db: Db; sim?: SimService; funded: FundedProvider; program: ProgramReader; verify(q: string): Promise<unknown>; adminToken: string; sealer: Sealer;
}) {
  const { db, funded } = d;
  const auth = { preHandler: app.requireWallet };
  const walletOf = (req: FastifyRequest) => req.wallet!;

  /** Program state from chain; an uninitialized program or an unreachable RPC is a clear 503/502, never a guess. */
  async function fromChain<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (err) {
      if (err instanceof ProgramNotInitialized) throw new ApiError(503, 'not_initialized', 'The Props.trade program is not live on Solana yet');
      throw new ApiError(502, 'upstream_unavailable', 'Solana is not reachable right now, try again shortly');
    }
  }

  async function providerFor(id: string): Promise<AccountsProvider> {
    if (await funded.isFunded(id)) return funded;
    if (!d.sim) throw notFound();
    return d.sim;
  }

  const found = <T>(v: T | undefined): T => {
    if (v === undefined) throw notFound();
    return v;
  };

  app.get('/v1/config', async () => fromChain(() => d.program.appConfig()));
  app.get('/v1/vault', async () => fromChain(() => d.program.vault()));
  app.get('/v1/verify', async (req) => d.verify(parse(VerifyQuery, req.query).q));
  registerTraderRoutes(app, { db, sim: d.sim, funded });

  app.get('/v1/accounts', auth, async (req) => {
    const wallet = walletOf(req);
    const [simulated, real] = await Promise.all([d.sim?.list(wallet) ?? [], funded.list(wallet)]);
    return [...simulated, ...real];
  });
  app.get('/v1/accounts/:id', auth, async (req) => {
    const { id } = parse(AccountParams, req.params);
    return found(await (await providerFor(id)).detail(walletOf(req), id));
  });
  for (const part of ['positions', 'orders', 'history', 'activity'] as const) {
    app.get(`/v1/accounts/:id/${part}`, auth, async (req) => {
      const { id } = parse(AccountParams, req.params);
      return found(await (await providerFor(id))[part](walletOf(req), id));
    });
  }
  app.get('/v1/accounts/:id/performance', auth, async (req) => {
    const { id } = parse(AccountParams, req.params);
    const { period } = parse(PerformanceQuery, req.query);
    return found(await (await providerFor(id)).performance(walletOf(req), id, period));
  });
  app.get('/v1/accounts/:id/payout-eligibility', auth, async (req) => {
    const { id } = parse(AccountParams, req.params);
    return found(await fromChain(() => funded.eligibility(walletOf(req), id)));
  });

  app.get('/v1/payouts', auth, async (req): Promise<Payout[]> => funded.payouts(walletOf(req)));
  app.get('/v1/payouts/:id', auth, async (req) => {
    const { id } = parse(PayoutParams, req.params);
    const payout = await funded.payout(walletOf(req), id);
    if (!payout) throw new ApiError(404, 'not_found', 'Payout not found');
    return payout;
  });

  // ---------- operator payout review ----------
  app.register(async (admin) => {
    admin.addHook('onRequest', adminAuth(d.adminToken));

    /** Payouts awaiting a decision (requested or held for review) by default, with the state of any decision job. */
    admin.get('/payouts', async (req) => {
      const { status, limit } = parse(AdminPayoutsQuery, req.query);
      const rows = await db.select({ payout: payouts, label: accounts.label, trader: fundedAccounts.trader, principal: fundedAccounts.principal, job: chainJobs })
        .from(payouts).innerJoin(fundedAccounts, eq(fundedAccounts.address, payouts.fundedAccount))
        .innerJoin(accounts, eq(accounts.id, payouts.fundedAccount)).leftJoin(chainJobs, eq(chainJobs.subject, payouts.address))
        .where(inArray(payouts.status, status ? [status] : ['requested', 'reviewing'])).orderBy(desc(payouts.requestedAt)).limit(limit);
      return rows.map(({ payout: p, label, trader, principal, job }) => ({
        id: p.address, account: p.fundedAccount, accountLabel: label, trader, seq: p.seq, status: p.status,
        principal: dec(principal), balanceAtRequest: dec(p.balanceAtRequest), profit: dec(p.profit), traderAmount: dec(p.traderAmount),
        vaultAmount: dec(p.vaultAmount), requestedAt: p.requestedAt.getTime(), requestSignature: p.requestSignature,
        reason: p.reasonCode === null ? null : rejectionReason(p.reasonCode), reviewNote: p.reviewNote,
        decision: job && { kind: job.kind, status: job.status, attempts: job.attempts, lastError: job.lastError, signature: job.signature },
      }));
    });

    /** Queues the decision for the job executor. One decision per payout; a failed one can be replaced. */
    async function decide<K extends 'approve_payout' | 'reject_payout'>(req: FastifyRequest, id: string, kind: K, payload: JobPayload[K]) {
      return db.transaction(async (tx) => {
        const [payout] = await tx.select().from(payouts).where(eq(payouts.address, id)).for('update');
        if (!payout) throw new ApiError(404, 'not_found', 'Payout not found');
        if (payout.status !== 'requested' && payout.status !== 'reviewing') throw new ApiError(409, 'not_pending', `Payout is already ${payout.status}`);
        const row = jobRow(d.sealer, kind, id, payload);
        const [job] = await tx.insert(chainJobs).values(row)
          .onConflictDoUpdate({ target: chainJobs.subject, set: requeue(row), setWhere: eq(chainJobs.status, 'failed') })
          .returning({ id: chainJobs.id });
        if (!job) throw new ApiError(409, 'decision_exists', 'A decision for this payout is already being processed');
        await tx.insert(adminAuditLog).values(audit(req, `payout.${kind === 'approve_payout' ? 'approve' : 'reject'}`, id, { job: job.id, ...payload }));
        return { id, decision: kind === 'approve_payout' ? 'approve' : 'reject', job: job.id };
      });
    }

    admin.post('/payouts/:id/approve', async (req) => {
      const { id } = parse(PayoutParams, req.params);
      return decide(req, id, 'approve_payout', { payout: id });
    });
    admin.post('/payouts/:id/reject', async (req) => {
      const { id } = parse(PayoutParams, req.params);
      const { reasonCode } = parse(RejectBody, req.body);
      return decide(req, id, 'reject_payout', { payout: id, reasonCode });
    });

    /**
     * Queues restrict(false) for a restricted funded account, e.g. once a GMTrade upgrade has been reviewed. The keeper
     * restricts it again while its reason stands (an unacknowledged GMTrade upgrade, equity at the floor).
     */
    admin.post('/funded/:id/lift-restriction', async (req) => {
      const { id } = parse(FundedParams, req.params);
      return db.transaction(async (tx) => {
        const [funded] = await tx.select({ status: fundedAccounts.status }).from(fundedAccounts).where(eq(fundedAccounts.address, id));
        if (!funded) throw new ApiError(404, 'not_found', 'Funded account not found');
        if (funded.status !== 'restricted') throw new ApiError(409, 'not_restricted', `Account is ${funded.status.replace('_', ' ')}`);
        const row = jobRow(d.sealer, 'lift_restriction', `lift:${id}`, { funded: id });
        const [job] = await tx.insert(chainJobs).values(row)
          .onConflictDoUpdate({ target: chainJobs.subject, set: requeue(row), setWhere: inArray(chainJobs.status, ['failed', 'confirmed']) })
          .returning({ id: chainJobs.id });
        if (!job) throw new ApiError(409, 'in_progress', 'Lifting this restriction is already in progress');
        await tx.insert(adminAuditLog).values(audit(req, 'funded.lift_restriction', id, { job: job.id }));
        return { id, job: job.id };
      });
    });

    /**
     * Queues close_funded for a flat funded account (not awaiting a payout): its USDC and SOL go back to the vault and its
     * principal and the trader's funded slot are released, e.g. the runbook's small-money test account. Breached accounts
     * are closed by the keeper.
     */
    admin.post('/funded/:id/close', async (req) => {
      const { id } = parse(FundedParams, req.params);
      return db.transaction(async (tx) => {
        const [funded] = await tx.select({ status: fundedAccounts.status }).from(fundedAccounts).where(eq(fundedAccounts.address, id));
        if (!funded) throw new ApiError(404, 'not_found', 'Funded account not found');
        if (!['active', 'restricted', 'breached'].includes(funded.status)) throw new ApiError(409, 'not_closable', `Account is ${funded.status.replace('_', ' ')}`);
        const row = jobRow(d.sealer, 'close_funded', `close:${id}`, { funded: id });
        const [job] = await tx.insert(chainJobs).values(row)
          .onConflictDoUpdate({ target: chainJobs.subject, set: requeue(row), setWhere: eq(chainJobs.status, 'failed') })
          .returning({ id: chainJobs.id });
        if (!job) throw new ApiError(409, 'in_progress', 'Closing this account is already in progress');
        await tx.insert(adminAuditLog).values(audit(req, 'funded.close', id, { job: job.id }));
        return { id, job: job.id };
      });
    });

    /** Puts a chain job that failed for good back in the queue, e.g. once the outage or refusal behind it is over. */
    admin.post('/jobs/:id/retry', async (req) => {
      const { id } = parse(JobParams, req.params);
      return db.transaction(async (tx) => {
        const [job] = await tx.update(chainJobs).set(requeue()).where(and(eq(chainJobs.id, id), eq(chainJobs.status, 'failed')))
          .returning({ kind: chainJobs.kind, subject: chainJobs.subject });
        if (!job) throw new ApiError(409, 'not_failed', 'No failed chain job with this id');
        await tx.insert(adminAuditLog).values(audit(req, 'job.retry', id, job));
        return { id, status: 'queued' as const };
      });
    });
  }, { prefix: '/v1/admin' });
}
