// An unreadable operator key file is refused without echoing any of the secret it holds. --print-for prints a transaction
// Squads can import, and only when the dry run passes; a failing dry run exits non-zero.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Keypair, SystemInstruction, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { solTreasuryPda } from '@props/sdk';

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
