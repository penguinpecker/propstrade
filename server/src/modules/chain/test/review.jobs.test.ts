// Review finding: the job executor treated a transaction the RPC already reports as `processed` as if it were not
// landing. After one transient RPC error while confirming (e.g. a 429 on getSignatureStatuses), the next attempt
// re-planned against `confirmed` state, which does not show the processed transaction yet, and sent the same work
// again. The duplicate failed onchain, and the "already done" path then completed the job with the FAILED duplicate's
// signature and handed that to sim.markRecorded as the proof of the recorded result.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import { eq, sql } from 'drizzle-orm';
import { PROPS_VAULT_PROGRAM_ID, PropsVaultClient } from '@props/sdk';
import { chainJobs, programEvents } from '../../../db/schema.ts';
import { createJobs, enqueue } from '../jobs.ts';
import { encodeAccount, freshDb, silentLog, simStub, sealer } from './support.ts';

const evaluation = Keypair.generate().publicKey;
const trader = Keypair.generate().publicKey;
let status: 'active' | 'passed' = 'active';

let t: Awaited<ReturnType<typeof freshDb>>;
before(async () => {
  t = await freshDb('chain_review_jobs');
});
after(async () => {
  await t.sql.end();
});

test('a processed (not yet confirmed) transaction is waited for, not sent again; the job keeps the signature that landed', async () => {
  const sent: string[] = [];
  let statusCalls = 0;
  const rpc = {
    async getAccountInfo(k: PublicKey) {
      if (!k.equals(evaluation)) return null;
      return { owner: PROPS_VAULT_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0, data: evaluationData() };
    },
    async getLatestBlockhash() {
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 };
    },
    async simulateTransaction() {
      return { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 5_000 } };
    },
    async sendRawTransaction(raw: Uint8Array) {
      const signature = bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]!);
      if (!sent.includes(signature)) sent.push(signature);
      return signature;
    },
    async getSignatureStatuses([signature]: string[]) {
      statusCalls++;
      if (signature === sent[0]) {
        if (statusCalls === 1) throw new Error('429 Too Many Requests'); // one transient RPC error while confirming
        if (statusCalls === 2) return { context: { slot: 2 }, value: [{ slot: 2, confirmations: 0, err: null, confirmationStatus: 'processed' as const }] };
        status = 'passed'; // then it confirms, as a processed transaction does
        return { context: { slot: 3 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: 'confirmed' as const }] };
      }
      // The duplicate lands after the original recorded the result: the program refuses it.
      return { context: { slot: 3 }, value: [{ slot: 3, confirmations: 0, err: { InstructionError: [2, { Custom: 6012 }] }, confirmationStatus: 'confirmed' as const }] };
    },
    async getBlockHeight() {
      return 10;
    },
  };
  const client = new PropsVaultClient(rpc as never);
  const { sim, recorded } = simStub();
  const jobs = createJobs({ db: t.db, rpc: rpc as never, client, sim, log: silentLog, sealer, keys: { risk: Keypair.generate() } });
  const result = { evaluation: evaluation.toBase58(), wallet: trader.toBase58(), passed: true, finalEquityUsd: '10800', tradesRoot: '07'.repeat(32), resolvedAt: Date.now() };
  await enqueue(t.db, sealer, 'record_evaluation_result', result.evaluation, result);

  for (let i = 0; i < 4; i++) {
    await jobs.runDue();
    await t.db.update(chainJobs).set({ updatedAt: sql`now() - interval '1 hour'` }); // skip the retry backoff
  }
  const [job] = await t.db.select().from(chainJobs).where(eq(chainJobs.subject, result.evaluation));
  console.log(JSON.stringify({ sent: sent.length, jobStatus: job!.status, jobSignature: job!.signature, firstSent: sent[0], recorded }));

  assert.equal(sent.length, 1, 'one record_evaluation_result transaction for one result');
  assert.deepEqual(recorded, [[result.evaluation, sent[0]]], 'the engine is told the signature that recorded the result');
});

test('a job whose own transaction failed completes with the transaction that did the work, never its failed one', async () => {
  const evaluationKey = Keypair.generate().publicKey;
  const rpc = {
    async getAccountInfo(k: PublicKey) {
      if (!k.equals(evaluationKey)) return null;
      status = 'passed'; // recorded onchain by another transaction
      return { owner: PROPS_VAULT_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0, data: evaluationData() };
    },
    async getSignatureStatuses() {
      return { context: { slot: 3 }, value: [{ slot: 3, confirmations: 1, err: { InstructionError: [2, { Custom: 6012 }] }, confirmationStatus: 'confirmed' as const }] };
    },
  };
  const { sim, recorded } = simStub();
  const jobs = createJobs({ db: t.db, rpc: rpc as never, client: new PropsVaultClient(rpc as never), sim, log: silentLog, sealer, keys: { risk: Keypair.generate() } });
  const result = { evaluation: evaluationKey.toBase58(), wallet: trader.toBase58(), passed: true, finalEquityUsd: '10800', tradesRoot: '07'.repeat(32), resolvedAt: Date.now() };
  await enqueue(t.db, sealer, 'record_evaluation_result', result.evaluation, result);
  await t.db.update(chainJobs).set({ status: 'sent', signature: 'failedSig', updatedAt: sql`now() - interval '1 hour'` }).where(eq(chainJobs.subject, result.evaluation));

  await jobs.runDue(); // done onchain, but the indexer has not seen the transaction that did it yet: wait for it
  const [waiting] = await t.db.select().from(chainJobs).where(eq(chainJobs.subject, result.evaluation));
  assert.deepEqual([waiting!.status, recorded], ['sent', []]);
  await t.db.insert(programEvents).values({ signature: 'recordedSig', eventIndex: 0, slot: 9, name: 'evaluationResolved', data: { evaluation: result.evaluation, passed: true } });
  await t.db.update(chainJobs).set({ updatedAt: sql`now() - interval '1 hour'` });
  await jobs.runDue();
  const [job] = await t.db.select().from(chainJobs).where(eq(chainJobs.subject, result.evaluation));
  assert.deepEqual([job!.status, job!.signature, recorded], ['confirmed', 'recordedSig', [[result.evaluation, 'recordedSig']]]);
});

function evaluationData(): Buffer {
  const client = new PropsVaultClient({} as never);
  return encodeAccount(client, 'evaluation', {
    trader, index: 0, tierId: 1,
    terms: { sizeUsd: new BN(10_000_000_000), profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000, termsHash: Array(32).fill(1), tierVersion: 1 },
    feePaid: new BN(79_000_000), status: { [status]: {} }, createdAt: new BN(0), resolvedAt: new BN(0), finalEquity: new BN(0),
    tradesRoot: Array(32).fill(0), bump: 255,
  });
}
