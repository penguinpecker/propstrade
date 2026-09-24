// An unreadable operator key file is refused without echoing any of the secret it holds. --print-for prints a transaction
// Squads can import, and only when the dry run passes; a failing dry run exits non-zero. With --print-for, set-pauses
// and set-params need every flag / parameter named, so no proposal carries a value read from the chain.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Connection, Keypair, SystemInstruction, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import { GMTRADE_PROGRAM_ID, PROPS_VAULT_PROGRAM_ID, PropsVaultClient, USDC_MINT, solTreasuryPda } from '@props/sdk';

const script = new URL('./set-pauses.ts', import.meta.url).pathname;

test('a malformed OPERATOR_KEYPAIR file never reaches the output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'operator-key-'));
  try {
    let secret: string;
    do secret = bs58.encode(Keypair.generate().secretKey); while (!/^[A-Za-z]/.test(secret));
    const bytes = JSON.stringify(Array.from(Keypair.generate().secretKey));
    // A base58 export (the format wallets and the server accept) and a JSON array with one stray character.
    for (const content of [secret, `${bytes.slice(0, 40)}x${bytes.slice(40)}`]) {
      const path = join(dir, 'operator.json');
      writeFileSync(path, `${content}\n`, { mode: 0o600 });
      const result = spawnSync(process.execPath, [script, '--trading', 'on', '--cluster', 'http://127.0.0.1:1'], {
        encoding: 'utf8', env: { ...process.env, OPERATOR_KEYPAIR: path },
      });
      assert.notEqual(result.status, 0);
      const printed = result.stdout + result.stderr;
      for (let i = 0; i + 6 <= content.length; i++)
        assert.ok(!printed.includes(content.slice(i, i + 6)), `the key file's contents appear in the output: ${printed.trim()}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--print-for prints an importable transaction for the vault, and nothing when the dry run fails', async () => {
  let simulationError: object | null = null;
  // Just enough JSON-RPC for fund-sol-treasury: the treasury balance, a blockhash, and the simulation result.
  const rpc = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { id, method } = JSON.parse(body) as { id: string; method: string };
      const value = {
        getBalance: 0,
        getLatestBlockhash: { blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', lastValidBlockHeight: 1000 },
        simulateTransaction: { err: simulationError, logs: ['Program log: stub'], accounts: null, unitsConsumed: 150 },
      }[method];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value === undefined ? { jsonrpc: '2.0', id, error: { code: -32601, message: method } } : { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value } }));
    });
  });
  await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
  const cluster = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  const vault = Keypair.generate().publicKey;
  const fund = () => promisify(execFile)(process.execPath, [new URL('./fund-sol-treasury.ts', import.meta.url).pathname,
    '--sol', '0.000000001', '--print-for', vault.toBase58(), '--cluster', cluster], { encoding: 'utf8' });
  try {
    const { stdout } = await fund();
    const encoded = stdout.trim().split('\n').at(-1)!;
    assert.match(stdout, /dry run: ok, 150 CU[\s\S]*Import base58 encoded tx/);
    // A legacy transaction, unsigned, paid by the vault, holding exactly the script's instructions.
    const tx = Transaction.from(bs58.decode(encoded));
    assert.equal(VersionedTransaction.deserialize(bs58.decode(encoded)).version, 'legacy');
    assert.ok(tx.feePayer?.equals(vault));
    assert.deepEqual(tx.signatures.map((s) => s.signature), [null]);
    assert.equal(tx.instructions.length, 1);
    assert.ok(tx.instructions[0]!.programId.equals(SystemProgram.programId));
    const transfer = SystemInstruction.decodeTransfer(tx.instructions[0]!);
    assert.ok(transfer.fromPubkey.equals(vault) && transfer.toPubkey.equals(solTreasuryPda()));
    assert.equal(transfer.lamports, 1n);

    simulationError = { InstructionError: [1, { Custom: 1 }] };
    const failed = await fund().then(() => assert.fail('a failing dry run exited 0'), (e: { code: number; stdout: string; stderr: string }) => e);
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /dry run: FAILS/);
    assert.match(failed.stderr, /the dry run fails, so nothing was printed for signing/);
    assert.doesNotMatch(failed.stdout, /Import base58|dataBase58/);
  } finally {
    rpc.close();
  }
});

test('--print-for: set-pauses and set-params refuse to copy an unnamed flag or parameter from the chain into a proposal', async () => {
  // set_pauses / set_params overwrite every flag / parameter when they execute, and Squads executes an approved older
  // proposal after a newer one: a value read from the chain at print time would undo whatever landed in between.
  const client = new PropsVaultClient(new Connection('http://127.0.0.1:1'));
  const n = (v: number) => new BN(v);
  const key = () => Keypair.generate().publicKey;
  // The chain now: payouts paused and principal cut to 1 USDC a day.
  const config = await client.program.coder.accounts.encode('config', {
    admin: key(), pendingAdmin: null, riskAuthorities: [], kycAuthority: key(), usdcMint: USDC_MINT, gmtradeProgram: GMTRADE_PROGRAM_ID,
    gmtradeStore: key(), capitalVault: key(), traderShareBps: 8000, minPayout: n(50_000_000), ownerSolTarget: n(250_000_000),
    ownerSolMin: n(100_000_000), maxDailyPrincipal: n(1_000_000), principalWindowStart: n(0), principalInWindow: n(0),
    paused: { newEvaluations: false, trading: false, payouts: true }, feesCollected: n(0), allocatedPrincipal: n(0), payoutsPaid: n(0),
    profitToVault: n(0), evaluationsSold: n(0), fundedActivated: n(0), fundedActive: 0, bump: 255, vaultBump: 255, feeVaultBump: 255, solTreasuryBump: 255,
  });
  const rpc = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { id, method } = JSON.parse(body) as { id: string; method: string };
      const value = {
        getAccountInfo: { data: [config.toString('base64'), 'base64'], executable: false, lamports: 1, owner: PROPS_VAULT_PROGRAM_ID.toBase58(), rentEpoch: 0, space: config.length },
        getLatestBlockhash: { blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', lastValidBlockHeight: 1000 },
        simulateTransaction: { err: null, logs: [], accounts: null, unitsConsumed: 150 },
      }[method];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value === undefined ? { jsonrpc: '2.0', id, error: { code: -32601, message: method } } : { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value } }));
    });
  });
  await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
  const cluster = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  const run = (name: string, args: string[]) => promisify(execFile)(process.execPath, [new URL(name, import.meta.url).pathname, ...args,
    '--print-for', Keypair.generate().publicKey.toBase58(), '--cluster', cluster], { encoding: 'utf8' });
  const refused = (name: string, args: string[]) =>
    run(name, args).then(() => assert.fail(`${name} ${args.join(' ')} printed a proposal`), (e: { code: number; stdout: string; stderr: string }) => e);
  /** The data of the one instruction in the printed Squads transaction. */
  const printed = (stdout: string) => Transaction.from(bs58.decode(stdout.trim().split('\n').at(-1)!)).instructions[0]!.data;
  try {
    const pauses = await refused('./set-pauses.ts', ['--trading', 'on']);
    assert.equal(pauses.code, 1);
    assert.match(pauses.stderr, /--print-for needs every flag: add --new-evaluations on\|off, --payouts on\|off/);
    assert.doesNotMatch(pauses.stdout, /Import base58|dataBase58/);
    const allPauses = await run('./set-pauses.ts', ['--new-evaluations', 'off', '--trading', 'on', '--payouts', 'off']);
    assert.deepEqual(printed(allPauses.stdout),
      client.program.coder.instruction.encode('setPauses', { paused: { newEvaluations: false, trading: true, payouts: false } }));

    const params = await refused('./set-params.ts', ['--min-payout', '60']);
    assert.equal(params.code, 1);
    assert.match(params.stderr, /--print-for needs every parameter: add --trader-share-bps, --owner-sol-target, --owner-sol-min, --max-daily-principal/);
    assert.doesNotMatch(params.stdout, /Import base58|dataBase58/);
    const allParams = await run('./set-params.ts', ['--trader-share-bps', '8000', '--min-payout', '60', '--owner-sol-target', '0.25', '--owner-sol-min', '0.1', '--max-daily-principal', '1']);
    assert.deepEqual(printed(allParams.stdout), client.program.coder.instruction.encode('setParams', {
      params: { traderShareBps: 8000, minPayout: n(60_000_000), ownerSolTarget: n(250_000_000), ownerSolMin: n(100_000_000), maxDailyPrincipal: n(1_000_000) },
    }));
  } finally {
    rpc.close();
  }
});
