// Sends a transaction signed by one server key: simulates it first (a failing instruction never lands, and the
// compute budget is sized from the simulation), hands the signature to `beforeSend`, then sends and polls until
// confirmed. The priority fee follows what landed lately on the same accounts and rises after each expiry; a status
// poll the RPC does not answer is polled again. Used by the chain-job executor and the keeper.
import { setTimeout as sleep } from 'node:timers/promises';
import { PublicKey, type Connection, type Keypair, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { buildTransaction } from '@props/sdk';

/** The blockhash lapsed before the transaction landed: it never will, so the same work can be planned again. */
export class Expired extends Error {}
/** The chain refuses the work as things stand: the simulation failed, or the transaction failed onchain. */
export class Rejected extends Error {
  /** `code`: the program's error name when it gave one ('sol' for a lack of SOL), else 'refused'. */
  constructor(message: string, readonly code = 'refused') {
    super(message);
  }
}
/**
 * The simulation failed for lack of SOL: a transfer short of lamports, or an account it would leave below rent
 * (`account`, when the error names it).
 */
export class NotEnoughSol extends Rejected {
  constructor(message: string, readonly account?: PublicKey) {
    super(message, 'sol');
  }
}

export type SendRpc = Pick<Connection, 'getLatestBlockhash' | 'simulateTransaction' | 'sendRawTransaction' | 'getSignatureStatuses' | 'getBlockHeight'>
  & Partial<Pick<Connection, 'getRecentPrioritizationFees'>>;

/** Priority fee bounds, µlamports per CU: 10,000,000 on a ~120k-CU forced close is ≈ 0.0012 SOL. */
const PRIORITY_FLOOR = 100_000;
const PRIORITY_CAP = 10_000_000;
/**
 * Fee multiplier per RPC connection: a transaction that expired unlanded leaves it at twice what that transaction paid
 * (so each re-plan pays more), one that landed at half.
 */
const MAX_BOOST = 64;
const boosts = new WeakMap<object, number>();
const MAX_COMPUTE_UNITS = 1_400_000;
const PACKET_DATA_SIZE = 1_232;
const CONFIRM_POLL_MS = 1_000;
/** Status polls in a row the RPC may leave unanswered (≈ a blockhash lifetime) before the send gives up. */
const MAX_UNANSWERED_POLLS = 60;

const build = (payer: PublicKey, instructions: TransactionInstruction[], recentBlockhash: string, computeUnits: number, microLamportsPerUnit = PRIORITY_FLOOR) =>
  buildTransaction({ payer, instructions, recentBlockhash, computeUnits, microLamportsPerUnit });

/** True when the instructions fit in one transaction paid and signed by `payer` alone. */
export function fitsInTransaction(payer: PublicKey, instructions: TransactionInstruction[]): boolean {
  try {
    return build(payer, instructions, PublicKey.default.toBase58(), MAX_COMPUTE_UNITS).serialize().length <= PACKET_DATA_SIZE;
  } catch {
    return false; // the message itself overruns the packet
  }
}

/**
 * µlamports per CU: the 90th percentile of what transactions writing the same accounts paid to land over the last 150
 * slots (a crash congests GMTrade's accounts first), doubled per recent expiry, within the floor and the cap.
 */
async function priorityFee(rpc: SendRpc, instructions: TransactionInstruction[], boost: number): Promise<number> {
  const writable = [...new Set(instructions.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58())))];
  const recent = await rpc.getRecentPrioritizationFees?.({ lockedWritableAccounts: writable.slice(0, 128).map((k) => new PublicKey(k)) }).catch(() => []) ?? [];
  const fees = recent.map((r) => r.prioritizationFee).sort((a, b) => a - b);
  return Math.min(PRIORITY_CAP, Math.max(PRIORITY_FLOOR, fees[Math.floor(fees.length * 0.9)] ?? 0) * boost);
}

/** Why a simulation failed: a lack of SOL named as such (the system program gives no error name), else the program's error. */
function refusal(err: unknown, logs: string[], keys: PublicKey[]): Rejected {
  const short = logs.find((l) => l.includes('insufficient lamports'));
  if (short) return new NotEnoughSol(`simulation failed: not enough SOL (${short})`);
  const rent = (err as { InsufficientFundsForRent?: { account_index: number } } | null)?.InsufficientFundsForRent;
  const account = rent && keys[rent.account_index];
  if (rent) return new NotEnoughSol(`simulation failed: not enough SOL (${account?.toBase58() ?? 'an account'} would be left below rent)`, account);
  const code = logs.map((l) => /Error Code: (\w+)/.exec(l)?.[1]).find(Boolean);
  return new Rejected(`simulation failed: ${code ?? JSON.stringify(err)}`, code);
}

export async function sendTransaction(rpc: SendRpc, p: {
  instructions: TransactionInstruction[];
  signer: Keypair;
  /** Runs with the final signature before anything is sent; throwing here sends nothing. */
  beforeSend?: (signature: string) => Promise<void>;
  /** Wraps `beforeSend` and the first send (the keeper serializes them across the accounts it works on at once). */
  gate?: (checkAndSend: () => Promise<void>) => Promise<void>;
}): Promise<string> {
  const boost = boosts.get(rpc) ?? 1;
  const fee = await priorityFee(rpc, p.instructions, boost);
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash('confirmed');
  const signed = (units: number) => {
    const tx = build(p.signer.publicKey, p.instructions, blockhash, units, fee);
    tx.sign([p.signer]);
    return tx;
  };
  const probe = signed(MAX_COMPUTE_UNITS);
  const simulation = await rpc.simulateTransaction(probe, { commitment: 'confirmed' });
  if (simulation.value.err) throw refusal(simulation.value.err, simulation.value.logs ?? [], probe.message.staticAccountKeys);
  const tx = signed(Math.min(MAX_COMPUTE_UNITS, Math.ceil((simulation.value.unitsConsumed ?? 200_000) * 1.2) + 5_000));
  const signature = bs58.encode(tx.signatures[0]!);
  const raw = tx.serialize();
  const send = () => rpc.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  const first = async () => {
    await p.beforeSend?.(signature);
    await send();
  };
  await (p.gate ? p.gate(first) : first());
  const check = async () => {
    const status = (await rpc.getSignatureStatuses([signature])).value[0];
    if (status?.err) return { failed: status.err };
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return 'landed' as const;
    return (await rpc.getBlockHeight('confirmed')) > lastValidBlockHeight ? 'expired' as const : 'pending' as const;
  };
  for (let i = 1, unanswered = 0; ; i++) {
    await sleep(CONFIRM_POLL_MS);
    let outcome: Awaited<ReturnType<typeof check>>;
    try {
      outcome = await check();
      unanswered = 0;
    } catch (err) {
      // A poll the RPC did not answer says nothing about the transaction (it may have landed): poll again.
      if (++unanswered >= MAX_UNANSWERED_POLLS) throw err;
      continue;
    }
    if (outcome === 'landed') {
      boosts.set(rpc, Math.max(1, boost / 2));
      return signature;
    }
    if (outcome === 'expired') {
      boosts.set(rpc, Math.min(MAX_BOOST, boost * 2));
      throw new Expired(`transaction expired before it landed (priority fee ${fee} µlamports/CU)`);
    }
    if (outcome !== 'pending') throw new Rejected(`transaction failed: ${JSON.stringify(outcome.failed)}`);
    if (i % 2 === 0) await send().catch(() => undefined); // a resend the RPC refuses changes nothing: the first went out
  }
}
