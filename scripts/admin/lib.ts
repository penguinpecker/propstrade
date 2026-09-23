// Shared plumbing for the operator scripts: CLI flags, the operator keypair, and dry-run / execute.
// Every script defaults to a dry run (simulation only). Pass --execute to send.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { Connection, Keypair } from '@solana/web3.js';
import type { TransactionInstruction } from '@solana/web3.js';
import { PropsVaultClient, buildTransaction } from '@props/sdk';

export interface Context {
  cluster: string;
  connection: Connection;
  vault: PropsVaultClient;
  operator: Keypair;
  execute: boolean;
  values: Record<string, string | boolean | undefined>;
}

const CLUSTERS: Record<string, () => string> = {
  'mainnet-beta': () => process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com',
  localnet: () => 'http://127.0.0.1:8899',
};

/** Parses `--cluster <mainnet-beta|localnet|url>`, `--execute` and the script's own options. */
export function setUp(usage: string, options: ParseArgsConfig['options'] = {}): Context {
  const { values } = parseArgs({
    options: { cluster: { type: 'string', default: 'mainnet-beta' }, execute: { type: 'boolean', default: false }, help: { type: 'boolean' }, ...options },
    strict: true,
  });
  if (values.help) {
    console.log(`${usage}\n\n  --cluster <mainnet-beta|localnet|url>  default mainnet-beta (RPC_URL overrides the public endpoint)\n  --execute                              send the transaction (default: simulate only)`);
    process.exit(0);
  }
  const cluster = String(values.cluster);
  const url = CLUSTERS[cluster]?.() ?? (cluster.startsWith('http') ? cluster : undefined);
  if (!url) throw new Error(`unknown cluster "${cluster}"`);
  const path = process.env.OPERATOR_KEYPAIR;
  if (!path) throw new Error('set OPERATOR_KEYPAIR to the path of the operator keypair file');
  const operator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  const connection = new Connection(url, 'confirmed');
  return { cluster, connection, vault: new PropsVaultClient(connection), operator, execute: Boolean(values.execute), values };
}

/** Simulates (dry run) or sends one transaction signed by the operator. */
export async function submit(ctx: Context, label: string, instructions: TransactionInstruction[]): Promise<void> {
  const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash();
  const tx = buildTransaction({ payer: ctx.operator.publicKey, instructions, recentBlockhash: blockhash });
  const names = instructions.map(
    (ix) =>
      ctx.vault.program.idl.instructions.find((d) => ix.programId.equals(ctx.vault.program.programId) && Buffer.from(d.discriminator).equals(ix.data.subarray(0, 8)))
        ?.name ?? ix.programId.toBase58(),
  );
  console.log(`${label} on ${ctx.cluster} as ${ctx.operator.publicKey.toBase58()}: ${names.join(', ')}`);

  if (!ctx.execute) {
    const sim = await ctx.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    console.log(`dry run: ${sim.value.err ? `FAILS ${JSON.stringify(sim.value.err)}` : 'ok'}, ${sim.value.unitsConsumed ?? '?'} CU`);
    if (sim.value.err) console.log((sim.value.logs ?? []).slice(-8).join('\n'));
    console.log('nothing sent; re-run with --execute to send');
    return;
  }

  tx.sign([ctx.operator]);
  const signature = await ctx.connection.sendRawTransaction(tx.serialize());
  const result = await ctx.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (result.value.err) throw new Error(`${label} failed: ${JSON.stringify(result.value.err)} (${signature})`);
  console.log(`sent: ${signature}`);
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
