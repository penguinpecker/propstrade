// Shared plumbing for the operator scripts: CLI flags, the operator keypair, and dry-run / execute.
// Every script defaults to a dry run (simulation only). Pass --execute to send. Once the admin is a multisig, pass
// --print-for <ADMIN_PUBKEY> instead: the instructions are built for that admin, simulated, and printed for import.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import type { TransactionInstruction } from '@solana/web3.js';
import { utils } from '@coral-xyz/anchor';
import { PropsVaultClient, buildTransaction } from '@props/sdk';

export interface Reader {
  cluster: string;
  connection: Connection;
  vault: PropsVaultClient;
  values: Record<string, string | boolean | undefined>;
}

export interface Context extends Reader {
  /** The admin the instructions name and the fee payer: the operator key, or the --print-for public key. */
  admin: PublicKey;
  /** null with --print-for: nothing is signed or sent. */
  operator: Keypair | null;
  execute: boolean;
}

const CLUSTERS: Record<string, () => string> = {
  'mainnet-beta': () => process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com',
  localnet: () => 'http://127.0.0.1:8899',
};

/** Parses `--cluster <mainnet-beta|localnet|url>`, `--execute` (sending scripts only) and the script's own options. */
function parse(usage: string, options: ParseArgsConfig['options'], sends: boolean): Reader {
  const { values } = parseArgs({
    options: {
      cluster: { type: 'string', default: 'mainnet-beta' },
      help: { type: 'boolean' },
      ...(sends && { execute: { type: 'boolean', default: false }, 'print-for': { type: 'string' } }),
      ...options,
    },
    strict: true,
  });
  if (values.help) {
    console.log(`${usage}\n\n  --cluster <mainnet-beta|localnet|url>  default mainnet-beta (RPC_URL overrides the public endpoint)${
      sends ? '\n  --execute                              send the transaction (default: simulate only)' +
        '\n  --print-for <ADMIN_PUBKEY>             build for that admin (e.g. the Squads vault), simulate, print it for Squads import' : ''}`);
    process.exit(0);
  }
  const cluster = String(values.cluster);
  const url = CLUSTERS[cluster]?.() ?? (cluster.startsWith('http') ? cluster : undefined);
  if (!url) throw new Error(`unknown cluster "${cluster}"`);
  const connection = new Connection(url, 'confirmed');
  return { cluster, connection, vault: new PropsVaultClient(connection), values };
}

/** For read-only scripts: no key is loaded and nothing can be sent. */
export function connect(usage: string, options: ParseArgsConfig['options'] = {}): Reader {
  return parse(usage, options, false);
}

/** For scripts that send: also loads the operator keypair (OPERATOR_KEYPAIR = path to the key file), unless --print-for. */
export function setUp(usage: string, options: ParseArgsConfig['options'] = {}): Context {
  const reader = parse(usage, options, true);
  const execute = Boolean(reader.values.execute);
  if (reader.values['print-for'] !== undefined) {
    if (execute) throw new Error('--print-for prints the instructions for another signer; it cannot be combined with --execute');
    return { ...reader, admin: new PublicKey(String(reader.values['print-for'])), operator: null, execute };
  }
  const path = process.env.OPERATOR_KEYPAIR;
  if (!path) throw new Error('set OPERATOR_KEYPAIR to the path of the operator keypair file');
  const raw = readFileSync(path, 'utf8');
  let operator: Keypair;
  try {
    operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    // Never pass the parser's message on: it quotes the start of the file, which is the secret key.
    throw new Error(`OPERATOR_KEYPAIR (${path}) is not a solana-keygen key file (a JSON array of 64 numbers)`);
  }
  return { ...reader, admin: operator.publicKey, operator, execute };
}

/** Simulates (dry run) or sends one transaction signed by the operator; with --print-for, simulates and prints it. */
export async function submit(ctx: Context, label: string, instructions: TransactionInstruction[]): Promise<void> {
  const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash();
  const tx = buildTransaction({ payer: ctx.admin, instructions, recentBlockhash: blockhash });
  const names = instructions.map(
    (ix) =>
      ctx.vault.program.idl.instructions.find((d) => ix.programId.equals(ctx.vault.program.programId) && Buffer.from(d.discriminator).equals(ix.data.subarray(0, 8)))
        ?.name ?? (ix.programId.equals(SystemProgram.programId) ? 'system transfer' : ix.programId.toBase58()),
  );
  console.log(`${label} on ${ctx.cluster} as ${ctx.admin.toBase58()}: ${names.join(', ')}`);

  if (!ctx.execute || !ctx.operator) {
    const sim = await ctx.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    console.log(`dry run: ${sim.value.err ? `FAILS ${JSON.stringify(sim.value.err)}` : 'ok'}, ${sim.value.unitsConsumed ?? '?'} CU`);
    if (sim.value.err) {
      console.log((sim.value.logs ?? []).slice(-8).join('\n'));
      throw new Error(`${label}: the dry run fails, so nothing was ${ctx.operator ? 'sent' : 'printed for signing'}`);
    }
    if (ctx.operator) console.log('nothing sent; re-run with --execute to send');
    else console.log(`instructions for ${ctx.admin.toBase58()} to sign (program id, accounts, base58 data), for review:\n${JSON.stringify(instructions.map((ix) => ({
      programId: ix.programId.toBase58(),
      accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
      dataBase58: utils.bytes.bs58.encode(ix.data),
    })), null, 2)}\ntransaction for Squads (Transaction Builder → Add instruction → Import base58 encoded tx):\n${squadsImport(ctx.admin, instructions, blockhash)}`);
    return;
  }

  tx.sign([ctx.operator]);
  const signature = await ctx.connection.sendRawTransaction(tx.serialize());
  const result = await ctx.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (result.value.err) throw new Error(`${label} failed: ${JSON.stringify(result.value.err)} (${signature})`);
  console.log(`sent: ${signature}`);
}

/**
 * The instructions as an unsigned legacy transaction paid by `payer` (the Squads vault), base58: what Squads' Transaction
 * Builder imports ("Import base58 encoded tx"), in the shape `solana-verify export-pda-tx` prints for it. Squads runs the
 * instructions from its own transaction, so no compute budget instruction is added.
 */
export function squadsImport(payer: PublicKey, instructions: TransactionInstruction[], recentBlockhash: string): string {
  const tx = new Transaction().add(...instructions);
  tx.feePayer = payer;
  tx.recentBlockhash = recentBlockhash;
  return utils.bytes.bs58.encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

/** Runs a script's main, printing a clean error and exiting non-zero on failure. */
export function main(fn: () => Promise<void>): void {
  fn().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
