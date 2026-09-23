// A real solana-test-validator for smoke and end-to-end suites: the mainnet GMTrade binary at its address, cloned
// mainnet accounts (Store restart slot patched to the local 0), props_vault deployed through the upgradeable loader,
// and funded USDC token accounts. Nothing talks to mainnet except the optional read-only --clone-feature-set
// (disable with CLONE_FEATURES=0).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, PublicKey } from '@solana/web3.js';
import type { AddressLookupTableAccount, Keypair, TransactionInstruction } from '@solana/web3.js';
import { GMTRADE_PROGRAM_ID, GMTRADE_STORE, PROPS_VAULT_PROGRAM_ID, USDC_MINT, buildTransaction } from '@props/sdk';

const FIXTURES = new URL('../fixtures/', import.meta.url);
const PROGRAM_SO = new URL('../../../target/deploy/props_vault.so', import.meta.url).pathname;
const STORE_LAST_RESTART_OFFSET = 4800;

export interface ValidatorOptions {
  /** JSON-RPC port; the websocket is rpcPort + 1. */
  rpcPort: number;
  faucetPort: number;
  gossipPort: number;
  /** e.g. "18002-18040" */
  dynamicPortRange: string;
  /** props_vault upgrade authority (the only key allowed to initialize). */
  upgradeAuthority: PublicKey;
  /** USDC ATAs to create, with balances in base units. */
  usdc: [owner: PublicKey, amount: bigint][];
  /** SPL mints to create (mainnet index tokens are mints with no supply; the indexer reads their decimals). */
  mints?: [mint: PublicKey, decimals: number][];
  /** Any other accounts to exist at genesis (e.g. a GMTrade Position as a keeper fill would leave it). */
  accounts?: { address: PublicKey; owner: PublicKey; data: Buffer; lamports: number }[];
}

export interface Validator {
  rpcUrl: string;
  wsUrl: string;
  connection: Connection;
  stop(): void;
}

function accountJson(address: PublicKey, owner: PublicKey, data: Buffer, lamports: number) {
  const account = { lamports, data: [data.toString('base64'), 'base64'], owner: owner.toBase58(), executable: false, rentEpoch: 0, space: data.length };
  return JSON.stringify({ pubkey: address.toBase58(), account });
}
const tokenAccountJson = (address: PublicKey, data: Buffer, lamports: number) => accountJson(address, TOKEN_PROGRAM_ID, data, lamports);

/** Account fixtures for --account-dir: mainnet snapshots (Store restart slot patched to the local 0) + test accounts. */
function writeAccountDir(dir: string, o: ValidatorOptions): void {
  for (const file of readdirSync(new URL('accounts/', FIXTURES))) {
    // Keep the raw text: rentEpoch is u64::MAX and must not pass through a JS number.
    let raw = readFileSync(new URL(`accounts/${file}`, FIXTURES), 'utf8');
    const { pubkey, account } = JSON.parse(raw);
    if (pubkey === GMTRADE_STORE.toBase58()) {
      const data = Buffer.from(account.data[0], 'base64');
      data.writeBigUInt64LE(0n, STORE_LAST_RESTART_OFFSET);
      raw = raw.replace(account.data[0], data.toString('base64'));
    }
    writeFileSync(join(dir, file), raw);
  }
  for (const [owner, amount] of o.usdc) {
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint: USDC_MINT, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0,
        isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
      },
      data,
    );
    const address = getAssociatedTokenAddressSync(USDC_MINT, owner);
    writeFileSync(join(dir, `${address.toBase58()}.json`), tokenAccountJson(address, data, 2_039_280));
  }
  for (const [mint, decimals] of o.mints ?? []) {
    const data = Buffer.alloc(MintLayout.span);
    MintLayout.encode(
      { mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default },
      data,
    );
    writeFileSync(join(dir, `${mint.toBase58()}.json`), tokenAccountJson(mint, data, 1_461_600));
  }
  for (const a of o.accounts ?? []) writeFileSync(join(dir, `${a.address.toBase58()}.json`), accountJson(a.address, a.owner, a.data, a.lamports));
}

export async function startValidator(o: ValidatorOptions): Promise<Validator> {
  const workDir = mkdtempSync(join(tmpdir(), 'props-vault-validator-'));
  const accounts = join(workDir, 'accounts');
  mkdirSync(accounts);
  writeAccountDir(accounts, o);
  const args = [
    '--reset', '--quiet', '--ledger', join(workDir, 'ledger'),
    '--rpc-port', String(o.rpcPort), '--faucet-port', String(o.faucetPort), '--gossip-port', String(o.gossipPort),
    '--dynamic-port-range', o.dynamicPortRange,
    '--upgradeable-program', GMTRADE_PROGRAM_ID.toBase58(), new URL('gmsol_store.so', FIXTURES).pathname, 'none',
    '--upgradeable-program', PROPS_VAULT_PROGRAM_ID.toBase58(), PROGRAM_SO, o.upgradeAuthority.toBase58(),
    '--account-dir', accounts,
  ];
  if (process.env.CLONE_FEATURES !== '0') args.push('--clone-feature-set', '--url', 'https://api.mainnet-beta.solana.com');
  const child: ChildProcess = spawn('solana-test-validator', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  const rpcUrl = `http://127.0.0.1:${o.rpcPort}`;
  const connection = new Connection(rpcUrl, 'confirmed');
  const stop = () => {
    child.kill('SIGINT');
    rmSync(workDir, { recursive: true, force: true });
  };
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) break;
    try {
      await connection.getSlot();
      return { rpcUrl, wsUrl: `ws://127.0.0.1:${o.rpcPort + 1}`, connection, stop };
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  child.kill('SIGKILL');
  throw new Error('solana-test-validator did not start');
}

/** Sends a v0 transaction and polls for confirmation (no websocket, so nothing keeps the process alive). */
export async function sendTx(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  lookupTables: AddressLookupTableAccount[] = [],
): Promise<{ signature: string; cu: number; size: number; logs: string[] }> {
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = buildTransaction({ payer: signers[0]!.publicKey, instructions, recentBlockhash: blockhash, lookupTables, computeUnits: 400_000 });
  tx.sign(signers);
  const raw = tx.serialize();
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: true });
  for (let i = 0; i < 60; i++) {
    const { value } = await connection.getSignatureStatuses([signature]);
    if (value[0]?.confirmationStatus === 'confirmed' || value[0]?.confirmationStatus === 'finalized') break;
    await new Promise((r) => setTimeout(r, 400));
  }
  const t = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  assert.ok(t?.meta, `transaction ${signature} not found`);
  assert.equal(t.meta.err, null, `transaction failed: ${JSON.stringify(t.meta.err)}\n${t.meta.logMessages?.join('\n')}`);
  return { signature, cu: t.meta.computeUnitsConsumed ?? 0, size: raw.length, logs: t.meta.logMessages ?? [] };
}
