import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Connection, Keypair, PublicKey, TransactionMessage } from '@solana/web3.js';
import BN from 'bn.js';
import { utils } from '@coral-xyz/anchor';
import {
  CLOSE_ALL,
  PROPS_VAULT_IDL,
  PROPS_VAULT_PROGRAM_ID,
  PropsVaultClient,
  acceptablePrice,
  buildTransaction,
  formatUnits,
  fromUnitPrice,
  gmEventAuthority,
  gmStoreWallet,
  gmToUsd,
  innerInstructionsOf,
  orderNonce,
  parseUnits,
  toMicro,
  toUnitPrice,
  usdToGm,
} from '../src/index.ts';

const bs58 = (b: Buffer) => utils.bytes.bs58.encode(b);

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

  it('reads events from the self-CPIs the program records as inner instructions, and only from the program', () => {
    const vault = new PropsVaultClient(new Connection('http://127.0.0.1:1'));
    const funded = Keypair.generate().publicKey;
    const body = vault.program.coder.types.encode('ownerToppedUp', { funded, lamports: new BN(250_000_000), ts: new BN(1_790_000_000) });
    const discriminator = PROPS_VAULT_IDL.events.find((e) => e.name === 'OwnerToppedUp')!.discriminator;
    const eventData = Buffer.concat([Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]), Buffer.from(discriminator), body]);
    const impostor = Keypair.generate().publicKey;
    const message = new TransactionMessage({ payerKey: funded, recentBlockhash: PublicKey.default.toBase58(), instructions: [
      { programId: PROPS_VAULT_PROGRAM_ID, keys: [], data: Buffer.alloc(8) },
      { programId: impostor, keys: [], data: Buffer.alloc(8) },
    ] }).compileToV0Message();
    const index = (key: PublicKey) => message.staticAccountKeys.findIndex((k) => k.equals(key));
    const tx = {
      transaction: { message, signatures: [] },
      meta: {
        innerInstructions: [
          { index: 1, instructions: [{ programIdIndex: index(impostor), accounts: [], data: bs58(eventData) }] }, // same bytes, another program
          { index: 0, instructions: [{ programIdIndex: index(PROPS_VAULT_PROGRAM_ID), accounts: [], data: bs58(eventData) }] },
        ],
        loadedAddresses: { writable: [], readonly: [] },
      },
    } as unknown as Parameters<typeof innerInstructionsOf>[0];
    const inner = innerInstructionsOf(tx);
    assert.deepEqual(inner.map((i) => i.programId.toBase58()), [PROPS_VAULT_PROGRAM_ID.toBase58(), impostor.toBase58()], 'execution order');
    const events = vault.parseEvents(inner);
    assert.deepEqual(events.map((e) => [e.name, String(e.data.funded), String(e.data.lamports)]), [['ownerToppedUp', funded.toBase58(), '250000000']]);
  });

  it('ships the IDL of the program built in this repo', () => {
    const built = new URL('../../../target/idl/props_vault.json', import.meta.url);
    if (!existsSync(built)) return; // no local build: nothing to compare
    assert.deepEqual(PROPS_VAULT_IDL, JSON.parse(readFileSync(built, 'utf8')), 'run: cp target/idl/props_vault.json packages/sdk/src/idl/');
  });
});

describe('owner positions', () => {
  it('with `open`, lists only the owner PDA\'s GMTrade positions with a size, reading just their 16-byte size', async () => {
    const [empty, open] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const asked: { dataSlice?: { offset: number; length: number } }[] = [];
    const connection = {
      async getProgramAccounts(_program: PublicKey, config: { dataSlice: { offset: number; length: number } }) {
        asked.push(config);
        const size = (n: number) => Buffer.alloc(16, n).subarray(0, config.dataSlice.length);
        return [{ pubkey: empty, account: { data: size(0) } }, { pubkey: open, account: { data: size(1) } }];
      },
    };
    const vault = new PropsVaultClient(connection as never);
    const funded = Keypair.generate().publicKey;
    assert.deepEqual((await vault.fetchOwnerPositions(funded)).map(String), [empty, open].map(String));
    assert.deepEqual((await vault.fetchOwnerPositions(funded, { open: true })).map(String), [open.toBase58()]);
    assert.deepEqual(asked.map((c) => c.dataSlice), [{ offset: 216, length: 0 }, { offset: 216, length: 16 }]);
  });
});
