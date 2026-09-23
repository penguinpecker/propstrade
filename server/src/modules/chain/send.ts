// Sends a transaction signed by one server key: simulates it first (a failing instruction never lands, and the
// compute budget is sized from the simulation), hands the signature to `beforeSend`, then sends and polls until
// confirmed. Used by the chain-job executor and the keeper.
import { setTimeout as sleep } from 'node:timers/promises';
import { PublicKey, type Connection, type Keypair, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { buildTransaction } from '@props/sdk';

/** The blockhash lapsed before the transaction landed: it never will, so the same work can be planned again. */
export class Expired extends Error {}
/** The chain refuses the work as things stand: the simulation failed, or the transaction failed onchain. */
export class Rejected extends Error {}

export type SendRpc = Pick<Connection, 'getLatestBlockhash' | 'simulateTransaction' | 'sendRawTransaction' | 'getSignatureStatuses' | 'getBlockHeight'>;

// ponytail: fixed priority fee; switch to getRecentPrioritizationFees if transactions stop landing under load.
const PRIORITY_MICROLAMPORTS = 100_000;
const MAX_COMPUTE_UNITS = 1_400_000;
const PACKET_DATA_SIZE = 1_232;
const CONFIRM_POLL_MS = 1_000;

const build = (payer: PublicKey, instructions: TransactionInstruction[], recentBlockhash: string, computeUnits: number) =>
  buildTransaction({ payer, instructions, recentBlockhash, computeUnits, microLamportsPerUnit: PRIORITY_MICROLAMPORTS });

/** True when the instructions fit in one transaction paid and signed by `payer` alone. */
export function fitsInTransaction(payer: PublicKey, instructions: TransactionInstruction[]): boolean {
  try {
    return build(payer, instructions, PublicKey.default.toBase58(), MAX_COMPUTE_UNITS).serialize().length <= PACKET_DATA_SIZE;
  } catch {
    return false; // the message itself overruns the packet
  }
}

export async function sendTransaction(rpc: SendRpc, p: {
  instructions: TransactionInstruction[];
  signer: Keypair;
  /** Runs with the final signature before anything is sent; throwing here sends nothing. */
  beforeSend?: (signature: string) => Promise<void>;
}): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash('confirmed');
  const signed = (units: number) => {
    const tx = build(p.signer.publicKey, p.instructions, blockhash, units);
    tx.sign([p.signer]);
    return tx;
  };
  const simulation = await rpc.simulateTransaction(signed(MAX_COMPUTE_UNITS), { commitment: 'confirmed' });
  if (simulation.value.err) {
    const code = simulation.value.logs?.map((l) => /Error Code: (\w+)/.exec(l)?.[1]).find(Boolean);
    throw new Rejected(`simulation failed: ${code ?? JSON.stringify(simulation.value.err)}`);
  }
  const tx = signed(Math.min(MAX_COMPUTE_UNITS, Math.ceil((simulation.value.unitsConsumed ?? 200_000) * 1.2) + 5_000));
  const signature = bs58.encode(tx.signatures[0]!);
  await p.beforeSend?.(signature);
  const raw = tx.serialize();
  for (let i = 0; ; i++) {
    if (i % 2 === 0) await rpc.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
    await sleep(CONFIRM_POLL_MS);
    const status = (await rpc.getSignatureStatuses([signature])).value[0];
    if (status?.err) throw new Rejected(`transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature;
    if ((await rpc.getBlockHeight('confirmed')) > lastValidBlockHeight) throw new Expired('transaction expired before it landed');
  }
}
