// Review findings for the wallet transaction module. Each test states the behaviour the module should have;
// every one of them fails against the current chain.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { ComputeBudgetProgram, Connection, Keypair, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { GMTRADE_PROGRAM_ID, PROPS_VAULT_PROGRAM_ID, PropsVaultClient, buildTransaction, toUnitPrice } from '@props/sdk';
// @ts-expect-error test-only JavaScript module
import { marketRef, startStub } from '../../tests/stub.mjs';
import { TxError, confirm, describeFailure, prepareOpen, signAndSend, unitPrice } from './chain';

const VAULT = PROPS_VAULT_PROGRAM_ID.toBase58();
const GM = GMTRADE_PROGRAM_ID.toBase58();
const CONFIRMED = { slot: 2, confirmations: null, err: null, confirmationStatus: 'confirmed' };
const fake = (methods: Record<string, unknown>) => methods as unknown as Connection;

describe('failure reasons for GMTrade errors raised through the vault CPI', () => {
  // Tail of the real logs of an open_position on a closed market, captured with LiteSVM and the mainnet GMTrade binary
  // (tests/program env, NVDA market flagged closed). The runtime repeats the callee's code on the caller's failure line.
  const cpi = (code: number) => [
    `Program ${VAULT} invoke [1]`,
    `Program ${GM} invoke [2]`,
    'Program log: Instruction: CreateOrderV2',
    `Program log: AnchorError thrown in programs/store/src/states/market/mod.rs:341. Error Code: MarketClosed. Error Number: ${code}. Error Message: market is closed.`,
    `Program ${GM} consumed 39632 of 503472 compute units`,
    `Program ${GM} failed: custom program error: 0x${code.toString(16)}`,
    `Program ${VAULT} consumed 136010 of 599850 compute units`,
    `Program ${VAULT} failed: custom program error: 0x${code.toString(16)}`,
  ];

  it('names GMTrade, not a generic network rejection, for GMTrade MarketClosed (6127)', () => {
    expect(describeFailure({ InstructionError: [2, { Custom: 6127 }] }, cpi(6127))).toMatch(/GMTrade/);
  });

  it('does not report GMTrade NotEnoughExecutionFee (6034) as the vault error with the same number', () => {
    expect(describeFailure({ InstructionError: [2, { Custom: 6034 }] }, cpi(6034))).not.toBe('No realized profit.');
  });
});

describe('confirmation of an already-sent transaction', () => {
  it('keeps polling through a transient RPC error instead of reporting the transaction as failed', async () => {
    let calls = 0;
    const connection = fake({
      getSignatureStatuses: async () => { calls += 1; if (calls === 1) throw new Error('failed to get signature status: 429 Too Many Requests'); return { context: { slot: 2 }, value: [CONFIRMED] }; },
      getBlockHeight: async () => 10,
    });
    await expect(confirm(connection, '1'.repeat(64), 160, 1)).resolves.toBeUndefined();
  });

  it('re-checks the signature after the block height passes, so a transaction that landed is not called expired', async () => {
    let calls = 0; // the RPC indexes the signature between the status read and the block-height read
    const connection = fake({
      getSignatureStatuses: async () => { calls += 1; return { context: { slot: 2 }, value: [calls === 1 ? null : CONFIRMED] }; },
      getBlockHeight: async () => 161,
    });
    await expect(confirm(connection, '1'.repeat(64), 160, 1)).resolves.toBeUndefined();
  });
});

describe('sending a signed transaction', () => {
  it('keeps the signature when the send request fails in transit, because the transaction may still land', async () => {
    const key = Keypair.generate();
    const tx = buildTransaction({ payer: key.publicKey, recentBlockhash: bs58.encode(Buffer.alloc(32, 7)), instructions: [SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: key.publicKey, lamports: 1 })] });
    const connection = fake({
      simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } }),
      sendRawTransaction: async () => { throw new TypeError('fetch failed'); },
    });
    let signed: VersionedTransaction | undefined;
    const error = await signAndSend(connection, { tx, lastValidBlockHeight: 160, feeLamports: 5000, rentLamports: 0 }, async t => { t.sign([key]); signed = t; return t; }).catch(e => e);
    expect(error).toBeInstanceOf(TxError);
    expect(error.message).not.toMatch(/Nothing was sent/);
    expect((error as TxError).signature).toBe(bs58.encode(signed!.signatures[0]!));
  });
});

describe('order amounts', () => {
  let stub: { url: string; close(): void; walletData(wallet: string): { funded: string } };
  let connection: Connection;
  beforeAll(async () => { stub = await startStub(); connection = new Connection(`${stub.url}/rpc`, 'confirmed'); });
  afterAll(() => stub.close());
  const coder = new PropsVaultClient(new Connection('http://127.0.0.1:1')).program.coder as unknown as { instruction: { decode(data: Buffer): { name: string; data: any } | null } };

  it('keeps an order at the market\'s maximum leverage within the program\'s leverage check (XAU 15×, $1,001)', async () => {
    const key = Keypair.generate();
    const w = stub.walletData(key.publicKey.toBase58());
    const xau = marketRef('XAU');
    // What the order ticket passes at 15× (Trading.jsx: collateralUsd: sizeNum / lev).
    const p = await prepareOpen(connection, key.publicKey, { funded: w.funded, market: xau, isLong: true, kind: 'Market', price: '2674.3', sizeUsd: 1001, collateralUsd: 1001 / 15, slippageBps: 50 });
    const ix = p.tx.message.compiledInstructions.find(i => p.tx.message.staticAccountKeys[i.programIdIndex]!.equals(PROPS_VAULT_PROGRAM_ID))!;
    const { args } = coder.instruction.decode(Buffer.from(ix.data))!.data;
    const size = BigInt(args.sizeDeltaUsd.toString()), collateralGm = BigInt(args.collateral.toString()) * 10n ** 14n;
    // programs/props_vault/src/instructions/trading.rs check_increase: size × 10_000 ≤ collateral × max_leverage_bps.
    expect(size * 10_000n <= collateralGm * 150_000n).toBe(true);
  });

  it('gives an open with take-profit and stop-loss enough compute units (measured 377k–445k CU on the GMTrade binary)', async () => {
    const key = Keypair.generate();
    const w = stub.walletData(key.publicKey.toBase58());
    const btc = marketRef('BTC');
    const p = await prepareOpen(connection, key.publicKey, { funded: w.funded, market: btc, isLong: true, kind: 'Market', price: '64482', sizeUsd: 500, collateralUsd: 50, slippageBps: 50, takeProfit: '90000', stopLoss: '40000' });
    const budget = p.tx.message.compiledInstructions.find(i => p.tx.message.staticAccountKeys[i.programIdIndex]!.equals(ComputeBudgetProgram.programId) && i.data[0] === 2)!;
    // LiteSVM, tests/program env, 16 funded accounts, open + TP + SL on BTC: 377,371–444,876 CU (11 of 16 above 400k).
    expect(Buffer.from(budget.data).readUInt32LE(1)).toBeGreaterThanOrEqual(445_000);
  });

  it('accepts the decimal forms a number input produces for a trigger price', () => {
    expect(unitPrice('.5', 9)).toBe(toUnitPrice('0.5', 9));
    expect(unitPrice('2e-5', 5)).toBe(toUnitPrice('0.00002', 5));
  });
});

