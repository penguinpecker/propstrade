// The generated key file is owner-only, never overwritten, and its secret never reaches the output.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const script = new URL('./gen-authority-key.ts', import.meta.url).pathname;
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('writes an owner-only key file and prints only its public key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'authority-key-'));
  try {
    const out = join(dir, 'risk.json');
    const result = run('--role', 'risk', '--out', out);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    const secret = Uint8Array.from(JSON.parse(readFileSync(out, 'utf8')) as number[]);
    const key = Keypair.fromSecretKey(secret);
    const printed = result.stdout + result.stderr;
    assert.match(printed, new RegExp(`Public key: ${key.publicKey.toBase58()}`));
    assert.match(printed, /railway variable set RISK_AUTHORITY_KEYPAIR --stdin/);
    for (const leak of [bs58.encode(secret), bs58.encode(secret.subarray(0, 32)), Array.from(secret.subarray(0, 8)).join(',')])
      assert.ok(!printed.includes(leak), 'the secret key appears in the output');

    const again = run('--role', 'kyc', '--out', out);
    assert.notEqual(again.status, 0, 'an existing key file was overwritten');
    assert.deepEqual(Uint8Array.from(JSON.parse(readFileSync(out, 'utf8')) as number[]), secret);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses an unknown role', () => {
  const result = run('--role', 'admin', '--out', join(tmpdir(), 'never-written.json'));
  assert.notEqual(result.status, 0);
});
