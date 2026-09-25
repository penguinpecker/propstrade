// sendTransaction (chain/send.ts) as the keeper and the job executor use it through a black swan's congestion: the
// priority fee follows what landed lately on the accounts the transaction writes and doubles after each expiry, a
// status poll the RPC does not answer is polled again, and a simulation that fails for lack of SOL says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { Expired, NotEnoughSol, Rejected, sendTransaction } from '../send.ts';

const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');
const signer = Keypair.generate();
const writable = Keypair.generate().publicKey;
const instructions = [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: writable, lamports: 1 })];

/** µlamports per CU a transaction offers (its SetComputeUnitPrice). */
function priceOf(tx: VersionedTransaction): number {
  const keys = tx.message.staticAccountKeys;
  const ix = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex]!.equals(COMPUTE_BUDGET) && i.data[0] === 3)!;
  return Number(Buffer.from(ix.data).readBigUInt64LE(1));
}

/** An RPC where each status poll is a block; `lands` decides whether a sent transaction is confirmed. */
function chain(o: { fees?: number[]; lands?: boolean; statusThrows?: number; simulation?: { err: unknown; logs: string[] } } = {}) {
  const prices: number[] = [];
  let height = 0;
  let statusThrows = o.statusThrows ?? 0;
  const rpc = {
    lands: o.lands ?? true,
    async getRecentPrioritizationFees(config?: { lockedWritableAccounts?: PublicKey[] }) {
      assert.ok(config?.lockedWritableAccounts?.some((k) => k.equals(writable)), 'asks about the accounts the transaction writes');
      return (o.fees ?? []).map((prioritizationFee, slot) => ({ slot, prioritizationFee }));
    },
    async getLatestBlockhash() {
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: height }; // valid until the next block
    },
    async simulateTransaction() {
      return { context: { slot: 1 }, value: { err: o.simulation?.err ?? null, logs: o.simulation?.logs ?? [], unitsConsumed: 1_000 } };
    },
    async sendRawTransaction(raw: Uint8Array) {
      const tx = VersionedTransaction.deserialize(raw);
      prices.push(priceOf(tx));
      return bs58.encode(tx.signatures[0]!);
    },
    async getSignatureStatuses() {
      if (statusThrows > 0) {
        statusThrows--;
        throw new Error('fetch failed');
      }
      height++;
      return { context: { slot: 1 }, value: [rpc.lands ? { slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' as const } : null] };
    },
    async getBlockHeight() {
      return height;
    },
  };
  return { rpc, prices, send: () => sendTransaction(rpc as never, { instructions, signer }) };
}

test('the priority fee is the 90th percentile of what landed lately on the accounts the transaction writes, within the floor and the cap', async () => {
  const recent = chain({ fees: Array.from({ length: 150 }, (_, i) => i * 10_000) });
  await recent.send();
  assert.deepEqual(recent.prices, [1_350_000]);
  const quiet = chain({ fees: [] });
  await quiet.send();
  assert.deepEqual(quiet.prices, [100_000], 'the floor when nothing competes');
  const frantic = chain({ fees: [5_000_000_000] });
  await frantic.send();
  assert.deepEqual(frantic.prices, [10_000_000], 'the cap');
});

test('a transaction that expired unlanded makes the next one pay twice as much; one that lands halves it', async () => {
  const c = chain({ lands: false });
  await assert.rejects(c.send(), Expired);
  await assert.rejects(c.send(), Expired);
  c.rpc.lands = true;
  await c.send();
  await c.send();
  assert.deepEqual(c.prices, [100_000, 200_000, 400_000, 200_000]);
});

test('a status poll the RPC does not answer is polled again: a transaction that landed is not reported as failed', async () => {
  const c = chain({ statusThrows: 2 });
  assert.match(await c.send(), /^\w{80,90}$/);
});

test('a simulation that fails for lack of SOL says so (the system program gives no error name), and names an account it would leave below rent', async () => {
  const short = chain({ simulation: { err: { InstructionError: [2, { Custom: 1 }] }, logs: ['Transfer: insufficient lamports 6009780, need 13208000', 'Program 11111111111111111111111111111111 failed: custom program error: 0x1'] } });
  await assert.rejects(short.send(), (err: unknown) => err instanceof NotEnoughSol && err.code === 'sol' && /not enough SOL \(Transfer: insufficient lamports 6009780, need 13208000\)/.test(err.message));
  const rent = chain({ simulation: { err: { InsufficientFundsForRent: { account_index: 1 } }, logs: [] } });
  await assert.rejects(rent.send(), (err: unknown) => err instanceof NotEnoughSol && !!err.account?.equals(writable) && err.message.includes(`${writable.toBase58()} would be left below rent`));
  const program = chain({ simulation: { err: { InstructionError: [2, { Custom: 6006 }] }, logs: ['Program log: AnchorError occurred. Error Code: NotFlat. Error Number: 6006. Error Message: NotFlat.'] } });
  await assert.rejects(program.send(), (err: unknown) => err instanceof Rejected && !(err instanceof NotEnoughSol) && err.code === 'NotFlat' && err.message === 'simulation failed: NotFlat');
  assert.deepEqual([...short.prices, ...rent.prices, ...program.prices], [], 'nothing is sent');
});
