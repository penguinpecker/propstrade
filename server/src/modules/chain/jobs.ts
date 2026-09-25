// Chain-job executor (leader only): sends set_identity with the KYC authority and record_evaluation_result /
// approve_payout / reject_payout / restrict(false) / close_funded with a risk authority. Every attempt first re-reads the onchain
// state (already done → confirmed with the signature of the transaction that did it, from the indexer), simulates,
// stores the signature before sending, confirms, and retries with backoff: RPC trouble for as long as it lasts, the
// chain's own refusal 10 times.
import { setTimeout as sleep } from 'node:timers/promises';
import { PublicKey, type Connection, type Keypair, type TransactionInstruction } from '@solana/web3.js';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { enumName, identityLockPda, traderProfilePda, type PropsVaultClient } from '@props/sdk';
import { parseFixed } from '@props/gmtrade';
import type { Db } from '../../db/client.ts';
import { chainJobs, programEvents } from '../../db/schema.ts';
import type { Sealer } from '../../lib/integrity.ts';
import type { EvaluationResult, SimService } from '../types.ts';
import { hex } from './reader.ts';
import type { VaultEventName } from './events.ts';
import { Expired, Rejected, sendTransaction, type SendRpc } from './send.ts';

type Job = typeof chainJobs.$inferSelect;
export type JobKind = Job['kind'];

export type JobPayload = {
  set_identity: { wallet: string; identityHash: string };
  record_evaluation_result: EvaluationResult;
  approve_payout: { payout: string };
  reject_payout: { payout: string; reasonCode: number };
  lift_restriction: { funded: string };
  close_funded: { funded: string };
};

/** What an attempt must do after re-reading the chain. */
type Plan =
  | { done: true }
  | { permanent: string }
  | { instructions: TransactionInstruction[]; signer: Keypair };

/** A job the chain refuses (Rejected) this many times fails for good; any other failure is retried until it passes. */
const MAX_REJECTIONS = 10;
/** A sent transaction that is still unknown this long after sending may yet land; wait before re-planning. */
const LANDING_WINDOW_MS = 90_000;

const payload = <K extends JobKind>(job: Job, _kind: K) => job.payload as JobPayload[K];

/** The event that shows each kind's work done onchain, and the event fields that identify the job's (latest) one. */
const DONE_BY: { [K in JobKind]: { event: VaultEventName; fields(job: Job): Record<string, string> } } = {
  set_identity: { event: 'identitySet', fields: (job) => ({ wallet: payload(job, 'set_identity').wallet }) },
  record_evaluation_result: { event: 'evaluationResolved', fields: (job) => ({ evaluation: payload(job, 'record_evaluation_result').evaluation }) },
  approve_payout: { event: 'payoutPaid', fields: (job) => ({ request: payload(job, 'approve_payout').payout }) },
  reject_payout: { event: 'payoutRejected', fields: (job) => ({ request: payload(job, 'reject_payout').payout }) },
  lift_restriction: { event: 'accountRestricted', fields: (job) => ({ funded: payload(job, 'lift_restriction').funded, restricted: 'false' }) },
  close_funded: { event: 'accountClosed', fields: (job) => ({ funded: payload(job, 'close_funded').funded }) },
};

export interface JobDeps {
  db: Db;
  rpc: SendRpc & Pick<Connection, 'getAccountInfo'>;
  client: PropsVaultClient;
  keys: { risk?: Keypair; kyc?: Keypair };
  /** Checks every job's seal before its plan: a job this server did not write is never signed. */
  sealer: Sealer;
  sim?: Pick<SimService, 'markRecorded'>;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

export function createJobs(d: JobDeps) {
  const { db, rpc, client } = d;

  const plans: { [K in JobKind]: (job: Job, signer: Keypair) => Promise<Plan> } = {
    async set_identity(job, kyc) {
      const { wallet, identityHash } = payload(job, 'set_identity');
      const hash = Buffer.from(identityHash, 'hex');
      const profile = await client.fetch('traderProfile', traderProfilePda(new PublicKey(wallet)));
      const current = profile ? hex(profile.identityHash) : null;
      if (current === identityHash) return { done: true };
      if (current && /[^0]/.test(current)) return { permanent: 'The wallet is already verified with a different identity' };
      if (await rpc.getAccountInfo(identityLockPda(hash))) return { permanent: 'This identity is already bound to another wallet' };
      return { instructions: [await client.setIdentity({ kycAuthority: kyc.publicKey, wallet: new PublicKey(wallet), identityHash: hash })], signer: kyc };
    },
    async record_evaluation_result(job, risk) {
      const r = payload(job, 'record_evaluation_result');
      const evaluation = await client.fetch('evaluation', new PublicKey(r.evaluation));
      if (!evaluation) throw new Rejected('Evaluation account not found');
      const status = enumName<string>(evaluation.status);
      if (status !== 'active') {
        const recordedPassed = status === 'passed' || status === 'funded';
        return recordedPassed === r.passed ? { done: true } : { permanent: `Evaluation is already recorded as ${status}` };
      }
      return {
        instructions: [await client.recordEvaluationResult({
          riskAuthority: risk.publicKey, evaluation: new PublicKey(r.evaluation), passed: r.passed,
          finalEquity: parseFixed(r.finalEquityUsd, 6), tradesRoot: Buffer.from(r.tradesRoot, 'hex'),
        })],
        signer: risk,
      };
    },
    async approve_payout(job, risk) {
      const address = new PublicKey(payload(job, 'approve_payout').payout);
      const request = await client.fetch('payoutRequest', address);
      if (!request) throw new Rejected('Payout request not found');
      const status = enumName<string>(request.status);
      if (status === 'paid') return { done: true };
      if (status !== 'requested') return { permanent: `Payout is ${status}` };
      const account = await client.fetchFunded(request.funded);
      if (!account) return { permanent: 'Funded account not found' };
      const positions = await client.fetchOwnerPositions(request.funded, { open: true });
      return {
        instructions: [await client.approvePayout({ riskAuthority: risk.publicKey, funded: { address: request.funded, account }, payout: address, positions })],
        signer: risk,
      };
    },
    async reject_payout(job, risk) {
      const { payout, reasonCode } = payload(job, 'reject_payout');
      const address = new PublicKey(payout);
      const request = await client.fetch('payoutRequest', address);
      if (!request) throw new Rejected('Payout request not found');
      const status = enumName<string>(request.status);
      if (status === 'rejected') return { done: true };
      if (status !== 'requested') return { permanent: `Payout is ${status}` };
      return { instructions: [await client.rejectPayout({ riskAuthority: risk.publicKey, funded: request.funded, payout: address, reasonCode })], signer: risk };
    },
    async lift_restriction(job, risk) {
      const funded = new PublicKey(payload(job, 'lift_restriction').funded);
      const account = await client.fetchFunded(funded);
      if (!account) throw new Rejected('Funded account not found');
      const status = enumName<string>(account.status);
      if (status === 'active') return { done: true };
      if (status !== 'restricted') return { permanent: `Account is ${status}` };
      return { instructions: [await client.restrict({ riskAuthority: risk.publicKey, funded, restricted: false })], signer: risk };
    },
    async close_funded(job, risk) {
      const address = new PublicKey(payload(job, 'close_funded').funded);
      const account = await client.fetchFunded(address);
      if (!account) throw new Rejected('Funded account not found');
      const status = enumName<string>(account.status);
      if (status === 'closed') return { done: true };
      if (status === 'payoutPending') return { permanent: 'A payout request is pending: approve, reject or cancel it first' };
      if (account.slots.some((s) => !s.marketToken.equals(PublicKey.default)) || account.orders.some((o) => !o.order.equals(PublicKey.default))) {
        return { permanent: 'The account still has positions or orders: close and cancel them (and sync) first' };
      }
      // The program re-checks every GMTrade position of the owner PDA passed as flat; an empty one proves nothing.
      const positions = await client.fetchOwnerPositions(address, { open: true });
      return { instructions: [await client.closeFunded({ riskAuthority: risk.publicKey, funded: { address, account }, positions })], signer: risk };
    },
  };

  const signerFor = (kind: JobKind) => (kind === 'set_identity' ? d.keys.kyc : d.keys.risk);

  /** Records the signature before sending, so a restart finds the transaction instead of sending the work twice. */
  function send(job: Job, instructions: TransactionInstruction[], signer: Keypair): Promise<string> {
    return sendTransaction(rpc, {
      instructions, signer,
      beforeSend: async (signature) => {
        await db.update(chainJobs).set({ status: 'sent', signature, updatedAt: sql`now()` }).where(eq(chainJobs.id, job.id));
      },
    });
  }

  /** The indexed transaction that did the job's work (this job's or anyone else's). */
  async function doneBy(job: Job): Promise<string> {
    const { event, fields } = DONE_BY[job.kind];
    const [row] = await db.select({ signature: programEvents.signature }).from(programEvents)
      .where(and(eq(programEvents.name, event), ...Object.entries(fields(job)).map(([k, v]) => sql`${programEvents.data}->>${k} = ${v}`)))
      .orderBy(desc(programEvents.slot)).limit(1);
    if (!row) throw new Error('done onchain; waiting for the indexer to see the transaction that did it');
    return row.signature;
  }

  /** `signature`: this job's transaction, confirmed without an error; null when the chain shows the work already done. */
  async function complete(job: Job, signature: string | null) {
    const recorded = signature ?? (await doneBy(job));
    if (job.kind === 'record_evaluation_result') {
      const { evaluation } = payload(job, 'record_evaluation_result');
      if (d.sim) await d.sim.markRecorded(evaluation, recorded);
      else d.log.warn({ evaluation }, 'sim module absent: result recorded onchain but not marked in the engine');
    }
    await db.update(chainJobs).set({ status: 'confirmed', signature: recorded, lastError: null, updatedAt: sql`now()` }).where(eq(chainJobs.id, job.id));
    d.log.info({ job: job.id, kind: job.kind, signature: recorded }, 'chain job confirmed');
  }

  async function attempt(job: Job) {
    const signer = signerFor(job.kind)!;
    if (!d.sealer.verifyJob(job)) {
      // Written to the database by something other than this server (or with another SESSION_SECRET): never signed.
      const lastError = 'The job failed its integrity check (not written by this server); nothing was signed';
      await db.update(chainJobs).set({ status: 'failed', lastError, updatedAt: sql`now()` }).where(eq(chainJobs.id, job.id));
      d.log.error({ job: job.id, kind: job.kind, subject: job.subject }, 'chain job failed its integrity check');
      return;
    }
    try {
      if (job.status === 'sent' && job.signature) {
        const status = (await rpc.getSignatureStatuses([job.signature], { searchTransactionHistory: true })).value[0];
        if (status && !status.err) {
          if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return await complete(job, job.signature);
          return; // processed: it is landing; the chain read by a new plan would not show it yet
        }
        if (!status && Date.now() - job.updatedAt.getTime() < LANDING_WINDOW_MS) return; // may still land
      }
      const plan = await plans[job.kind](job, signer);
      if ('permanent' in plan) {
        await db.update(chainJobs).set({ status: 'failed', lastError: plan.permanent, updatedAt: sql`now()` }).where(eq(chainJobs.id, job.id));
        d.log.error({ job: job.id, kind: job.kind, reason: plan.permanent }, 'chain job cannot be applied');
        return;
      }
      await complete(job, 'done' in plan ? null : await send(job, plan.instructions, plan.signer));
    } catch (err) {
      const attempts = job.attempts + 1;
      // RPC and indexer trouble is retried for as long as it lasts (backoff capped at 5 min); only the chain's own
      // refusal, repeated, fails a job for good.
      const rejections = job.rejections + (err instanceof Rejected ? 1 : 0);
      const failed = rejections >= MAX_REJECTIONS;
      await db.update(chainJobs).set({
        attempts, rejections, lastError: (err as Error).message.slice(0, 500), updatedAt: sql`now()`,
        ...(failed ? { status: 'failed' as const } : err instanceof Expired ? { status: 'queued' as const } : {}),
      }).where(eq(chainJobs.id, job.id));
      (failed ? d.log.error : d.log.warn).call(d.log, { err, job: job.id, kind: job.kind, attempts }, failed ? 'chain job failed for good' : 'chain job attempt failed');
    }
  }

  /** Runs every due job once; a job is due immediately, then after 1, 3, 7 … s (capped at 5 min) following each failure. */
  async function runDue(): Promise<number> {
    const kinds = (Object.keys(plans) as JobKind[]).filter((k) => signerFor(k));
    if (!kinds.length) return 0;
    const due = await db.select().from(chainJobs).where(and(
      inArray(chainJobs.status, ['queued', 'sent']), inArray(chainJobs.kind, kinds),
      sql`${chainJobs.updatedAt} + (least(power(2, least(${chainJobs.attempts}, 9)), 300) - 1) * interval '1 second' <= now()`,
    )).orderBy(asc(chainJobs.createdAt)).limit(20);
    for (const job of due) await attempt(job);
    return due.length;
  }

  async function run(signal: AbortSignal, intervalMs = 2_000) {
    for (const [name, key] of [['KYC_AUTHORITY_KEYPAIR', d.keys.kyc], ['RISK_AUTHORITY_KEYPAIR', d.keys.risk]] as const) {
      if (!key) d.log.warn(`${name} is not set: its chain jobs stay queued`);
    }
    while (!signal.aborted) {
      try {
        await runDue();
      } catch (err) {
        d.log.error({ err }, 'chain job loop failed');
      }
      await sleep(intervalMs, undefined, { signal }).catch(() => {});
    }
  }

  return { runDue, run };
}

/** A new chain_jobs row, sealed. */
export const jobRow = <K extends JobKind>(sealer: Sealer, kind: K, subject: string | null, payload: JobPayload[K]) =>
  ({ kind, subject, payload, mac: sealer.job({ kind, subject, payload }) });

/** Queues a job once per subject (again when the subject's job failed); false when one is pending or done. */
export async function enqueue<K extends JobKind>(db: Db, sealer: Sealer, kind: K, subject: string, body: JobPayload[K]): Promise<boolean> {
  const row = jobRow(sealer, kind, subject, body);
  const rows = await db.insert(chainJobs).values(row)
    .onConflictDoUpdate({ target: chainJobs.subject, set: requeue(row), setWhere: eq(chainJobs.status, 'failed') })
    .returning({ id: chainJobs.id });
  return rows.length > 0;
}

/** Column values that put a failed job back in the queue as new (optionally as a new sealed row: kind, payload, mac). */
export const requeue = (over: Partial<Pick<Job, 'kind' | 'payload' | 'mac'>> = {}) =>
  ({ ...over, status: 'queued' as const, attempts: 0, rejections: 0, lastError: null, signature: null, updatedAt: sql`now()` });
