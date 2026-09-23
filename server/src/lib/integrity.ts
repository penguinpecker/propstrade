// Seals for the rows the server later signs onchain from: chain jobs (set_identity, record_evaluation_result, payout
// decisions, restriction lifts) and the sim engine's evaluation results. The key is derived from SESSION_SECRET, which
// lives only in the server's environment, so write access to the database alone cannot create or change a row that
// gets signed: the job executor and the result redelivery check the seal right before use (ARCHITECTURE.md §8, trust).
import { createHmac, timingSafeEqual } from 'node:crypto';

/** JSON with object keys sorted, so a value read back from jsonb (which reorders keys) gives the same text. */
const canonical = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  : v));

export type RowKind = 'chain_job' | 'sim_result';
export type Sealer = ReturnType<typeof createSealer>;

type ChainJobFields = { kind: string; subject: string | null; payload: unknown };
const jobFields = (job: ChainJobFields) => ({ kind: job.kind, subject: job.subject, payload: job.payload });

export function createSealer(secret: string) {
  const key = createHmac('sha256', secret).update('props.trade row seal v1').digest();
  const seal = (kind: RowKind, value: unknown) => createHmac('sha256', key).update(`${kind}\n${canonical(value)}`).digest('hex');
  const verify = (kind: RowKind, value: unknown, mac: string | null) =>
    !!mac && /^[0-9a-f]{64}$/.test(mac) && timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(seal(kind, value), 'hex'));
  return {
    seal,
    verify,
    /** The seal of a chain_jobs row: its kind, subject and payload. */
    job: (job: ChainJobFields) => seal('chain_job', jobFields(job)),
    verifyJob: (job: ChainJobFields & { mac: string | null }) => verify('chain_job', jobFields(job), job.mac),
  };
}
