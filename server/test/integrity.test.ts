// Row seals (src/lib/integrity.ts): what the server signs onchain from must have been written by the server itself.
import { describe, expect, it } from 'vitest';
import { createSealer } from '../src/lib/integrity.js';

describe('row seals', () => {
  const sealer = createSealer('s'.repeat(64));
  const job = { kind: 'set_identity', subject: null, payload: { wallet: 'W1', identityHash: 'ab'.repeat(32) } };

  it('verify a row read back from Postgres (jsonb reorders object keys; other columns do not count)', () => {
    const mac = sealer.job(job);
    const readBack = { id: 'uuid', status: 'queued', attempts: 3, ...job, payload: { identityHash: 'ab'.repeat(32), wallet: 'W1' }, mac };
    expect(sealer.verifyJob(readBack)).toBe(true);
  });

  it('refuse any change of kind, subject or payload, a missing or malformed seal, and a seal made with another secret', () => {
    const mac = sealer.job(job);
    for (const changed of [{ ...job, kind: 'approve_payout' }, { ...job, subject: 'x' }, { ...job, payload: { ...job.payload, wallet: 'W2' } }]) {
      expect(sealer.verifyJob({ ...changed, mac })).toBe(false);
    }
    expect(sealer.verifyJob({ ...job, mac: null })).toBe(false);
    expect(sealer.verifyJob({ ...job, mac: 'zz' })).toBe(false);
    expect(sealer.verifyJob({ ...job, mac: createSealer('t'.repeat(64)).job(job) })).toBe(false);
    expect(sealer.verify('sim_result', job.payload, sealer.seal('chain_job', job.payload)), 'a seal is bound to its row kind').toBe(false);
  });
});
