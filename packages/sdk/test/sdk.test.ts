import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  CLOSE_ALL,
  PROPS_VAULT_IDL,
  acceptablePrice,
  buildTransaction,
  formatUnits,
  fromUnitPrice,
  gmEventAuthority,
  gmStoreWallet,
  gmToUsd,
  orderNonce,
  parseUnits,
  toMicro,
  toUnitPrice,
  usdToGm,
} from '../src/index.ts';

describe('units', () => {
  it('parses and formats exact decimals', () => {
    assert.equal(parseUnits('1234.5', 6), 1_234_500_000n);
    assert.equal(parseUnits('0.000001', 6), 1n);
    assert.equal(parseUnits('7', 0), 7n);
    assert.equal(parseUnits('1.500000', 6), 1_500_000n, 'trailing zeros beyond precision are fine');
    assert.throws(() => parseUnits('1.0000001', 6), /more than 6 decimal places/);
    for (const bad of ['', '-1', '1e6', '0x10', '1.2.3', ' . ']) assert.throws(() => parseUnits(bad, 6), /not a non-negative decimal/);
    assert.equal(formatUnits(1_234_500_000n, 6), '1234.5');
    assert.equal(formatUnits(1n, 6), '0.000001');
    assert.equal(formatUnits(-2_500_000n, 6), '-2.5');
    assert.equal(formatUnits(0n, 6), '0');
    assert.equal(usdToGm('1'), 10n ** 20n);
    assert.equal(gmToUsd(usdToGm('98765.4321')), '98765.4321');
    assert.equal(toMicro('79'), 79_000_000n);
  });

  it('converts prices to GMTrade unit prices', () => {
    // SOL has 9 decimals: unit price = price × 10^11.
    assert.equal(toUnitPrice('118.14', 9), 11_814_000_000_000n);
    assert.equal(fromUnitPrice(11_814_000_000_000n, 9), '118.14');
    // A 6-decimals token: price × 10^14.
    assert.equal(toUnitPrice('1.0001', 6), 100_010_000_000_000n);
  });

  it('puts the acceptable price on the adverse side, rounding against the trader', () => {
    const p = 1_000_000n;
    assert.equal(acceptablePrice(p, true, true, 50), 1_005_000n, 'long open: pay up to +0.5%');
    assert.equal(acceptablePrice(p, false, false, 50), 1_005_000n, 'short close: buy back up to +0.5%');
    assert.equal(acceptablePrice(p, false, true, 50), 995_000n, 'short open: sell down to -0.5%');
    assert.equal(acceptablePrice(p, true, false, 50), 995_000n, 'long close: sell down to -0.5%');
    assert.equal(acceptablePrice(3n, true, true, 1), 4n, 'max price rounds up');
    assert.equal(acceptablePrice(3n, true, false, 1), 2n, 'min price rounds down');
    assert.throws(() => acceptablePrice(p, true, true, 10_000), /slippage/);
    assert.throws(() => acceptablePrice(p, true, true, 0.5), /slippage/);
  });
});

describe('addresses and transactions', () => {
  it('derives the mainnet GMTrade PDAs', () => {
    assert.equal(gmEventAuthority().toBase58(), '8a4wJ2bMiH6XWDZ7biTnejkss8VG7GMwd9Mg6F5fDfHF');
    assert.equal(gmStoreWallet().toBase58(), 'Hp7Eh2E815tDBpt1Ny1J4UgBLpnoKFzuh3L3uHxPaLEH');
    assert.equal(CLOSE_ALL, 2n ** 128n - 1n);
  });

  it('derives order nonces like the program: u64 little-endian counter, zero-padded to 32 bytes', () => {
    const nonce = orderNonce(0x0102n);
    assert.equal(nonce.length, 32);
    assert.deepEqual([...nonce.subarray(0, 3)], [0x02, 0x01, 0]);
    assert.ok(nonce.subarray(2).every((b) => b === 0));
    assert.deepEqual([...orderNonce(2n ** 64n - 1n).subarray(0, 9)], [255, 255, 255, 255, 255, 255, 255, 255, 0]);
  });

  it('builds v0 transactions with a compute budget prefix', () => {
    const payer = Keypair.generate().publicKey;
    const tx = buildTransaction({ payer, instructions: [], recentBlockhash: PublicKey.default.toBase58(), computeUnits: 123_000, microLamportsPerUnit: 5 });
    assert.equal(tx.version, 0);
    assert.equal(tx.message.compiledInstructions.length, 2);
    assert.equal(tx.message.staticAccountKeys[0]!.toBase58(), payer.toBase58());
  });

  it('ships the IDL of the program built in this repo', () => {
    const built = new URL('../../../target/idl/props_vault.json', import.meta.url);
    if (!existsSync(built)) return; // no local build: nothing to compare
    assert.deepEqual(PROPS_VAULT_IDL, JSON.parse(readFileSync(built, 'utf8')), 'run: cp target/idl/props_vault.json packages/sdk/src/idl/');
  });
});
