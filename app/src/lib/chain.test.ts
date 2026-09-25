import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { CLOSE_ALL, PROPS_VAULT_IDL, PROPS_VAULT_PROGRAM_ID, PropsVaultClient, gmOrderPda, gmPositionPda, orderNonce, ownerPda, toUnitPrice, usdToGm } from '@props/sdk';
// @ts-expect-error test-only JavaScript module
import { TIERS, marketRef, startStub } from '../../tests/stub.mjs';
import { TxError, confirm, describeFailure, prepareCancel, prepareClose, prepareEvaluation, prepareOpen, prepareProtection, signAndSend, unitPrice, watchExecution } from './chain';

interface Stub { url: string; close(): void; walletData(wallet: string): { wallet: string; funded: string; orderSeq: number; slots?: unknown[]; tracked?: unknown[] }; state: { sent: { name: string; data: any }[]; blockHeight: number; simulationLogs: string[] | null; statuses: Map<string, unknown> } }
let stub: Stub;
let connection: Connection;
beforeAll(async () => { stub = await startStub(); connection = new Connection(`${stub.url}/rpc`, 'confirmed'); });
afterAll(() => stub.close());

// Anchor's Borsh instruction coder decodes; its declared interface only encodes.
const coder = new PropsVaultClient(new Connection('http://127.0.0.1:1')).program.coder as unknown as { instruction: { decode(data: Buffer): { name: string; data: any } | null } };
const decode = (tx: VersionedTransaction) => tx.message.compiledInstructions
  .filter(ix => tx.message.staticAccountKeys[ix.programIdIndex]!.equals(PROPS_VAULT_PROGRAM_ID))
  .map(ix => coder.instruction.decode(Buffer.from(ix.data))!);
const btc = marketRef('BTC'); // index token decimals 8 onchain
const signer = (key: Keypair) => async (tx: VersionedTransaction) => { tx.sign([key]); return tx; };
const computeLimit = (tx: VersionedTransaction) => {
  const ix = tx.message.compiledInstructions.find(i => tx.message.staticAccountKeys[i.programIdIndex]!.equals(ComputeBudgetProgram.programId) && i.data[0] === 2)!;
  return Buffer.from(ix.data).readUInt32LE(1);
};
const fake = (methods: Record<string, unknown>) => methods as unknown as Connection;

describe('funded transactions', () => {
  it('opens a position with a stop-loss for the whole position in one transaction, at the account\'s next order addresses', async () => {
    const key = Keypair.generate();
    const w = stub.walletData(key.publicKey.toBase58());
    const p = await prepareOpen(connection, key.publicKey, { funded: w.funded, market: btc, isLong: true, kind: 'Market', price: '64482.123456789', sizeUsd: 5000, collateralUsd: 1000, slippageBps: 50, stopLoss: '62000' });
    const [open, stop] = decode(p.tx) as { name: string; data: { args: Record<string, any> } }[];
    expect([open!.name, stop!.name]).toEqual(['openPosition', 'setProtection']);
    expect(open!.data.args.orderType).toEqual({ market: {} });
    expect(BigInt(open!.data.args.collateral.toString())).toBe(1_000_000_000n);
    expect(BigInt(open!.data.args.sizeDeltaUsd.toString())).toBe(usdToGm('5000'));
    // 0.5% above the live price, which is cut to the unit price's 12 decimals first.
    expect(BigInt(open!.data.args.acceptablePrice.toString())).toBe((toUnitPrice('64482.123456789', 8) * 10_050n + 9_999n) / 10_000n);
    expect(stop!.data.args.orderType).toEqual({ stopLoss: {} });
    expect(BigInt(stop!.data.args.sizeDeltaUsd.toString())).toBe(CLOSE_ALL);
    const owner = ownerPda(new PublicKey(w.funded));
    expect(p.follows).toEqual([{
      order: gmOrderPda(owner, orderNonce(BigInt(w.orderSeq))).toBase58(), position: gmPositionPda(owner, new PublicKey(btc.marketToken), true).toBase58(), sizeBefore: 0n, increase: true,
    }]);
    expect([p.feeLamports, p.rentLamports]).toEqual([5000, 0]);
  });

  it('signs, sends and follows the order until the keeper executes it', async () => {
    const key = Keypair.generate();
    const w = stub.walletData(key.publicKey.toBase58());
    const p = await prepareOpen(connection, key.publicKey, { funded: w.funded, market: btc, isLong: false, kind: 'Market', price: '64482', sizeUsd: 2000, collateralUsd: 400, slippageBps: 50 });
    const signature = await signAndSend(connection, p, signer(key));
    expect(stub.state.sent.at(-1)).toMatchObject({ name: 'openPosition', data: { args: { isLong: false } } });
    await confirm(connection, signature, p.lastValidBlockHeight, 10);
    expect(await watchExecution(connection, p.follows[0]!, { pollMs: 100 })).toBe('executed');
  });

  it('reports a keeper cancellation when the position did not change', async () => {
    const key = Keypair.generate();
    const w = stub.walletData(key.publicKey.toBase58());
    const p = await prepareClose(connection, key.publicKey, { funded: w.funded, slippageBps: 50, positions: [{ market: btc, isLong: true, markPrice: '64482', sizeUsd: 5000, percent: 100 }] });
    expect(await watchExecution(connection, p.follows[0]!, { pollMs: 50, timeoutMs: 200 })).toBe('cancelled');
  });

  it('follows every close of a transaction, each against its own position', async () => {
    const key = Keypair.generate();
    const w = stub.walletData(key.publicKey.toBase58());
    const eth = marketRef('ETH');
    const p = await prepareClose(connection, key.publicKey, { funded: w.funded, slippageBps: 50, positions: [btc, eth].map(market => ({ market, isLong: false, markPrice: '100', sizeUsd: 100, percent: 100 })) });
    const owner = ownerPda(new PublicKey(w.funded));
    expect(p.follows.map(f => [f.position, f.increase])).toEqual([btc, eth].map(m => [gmPositionPda(owner, new PublicKey(m.marketToken), false).toBase58(), false]));
    expect(new Set(p.follows.map(f => f.order)).size).toBe(2);
  });

  it('sizes the compute limit from the simulation, so an open with take-profit and stop-loss is not cut off', async () => {
    const key = Keypair.generate();
    const w = stub.walletData(key.publicKey.toBase58());
    const p = await prepareOpen(connection, key.publicKey, { funded: w.funded, market: btc, isLong: true, kind: 'Market', price: '64482', sizeUsd: 500, collateralUsd: 50, slippageBps: 50, takeProfit: '90000', stopLoss: '40000' });
    // The stub meters 150k CU per props_vault instruction: 450k here, more than the SDK's 400k default.
    const fixed = TransactionMessage.decompile(p.tx.message);
    fixed.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    const simulation = await connection.simulateTransaction(new VersionedTransaction(fixed.compileToV0Message()), { sigVerify: false });
    expect(describeFailure(simulation.value.err, simulation.value.logs)).toMatch(/ran out of compute/);
    let signed: VersionedTransaction | undefined;
    await signAndSend(connection, p, async tx => { signed = await signer(key)(tx); return signed; });
    expect(computeLimit(signed!)).toBe(540_000); // 450k used + 20%
    expect(stub.state.sent.at(-1)).toMatchObject({ name: 'setProtection' });
  });

  it('fits an open with take-profit and stop-loss, and two closes, in one transaction', async () => {
    const key = Keypair.generate();
    const w = stub.walletData(key.publicKey.toBase58());
    const other = marketRef('SOL');
    const open = await prepareOpen(connection, key.publicKey, { funded: w.funded, market: btc, isLong: true, kind: 'Limit', price: '60000', sizeUsd: 1000, collateralUsd: 100, slippageBps: 50, takeProfit: '70000', stopLoss: '58000' });
    const close = await prepareClose(connection, key.publicKey, { funded: w.funded, slippageBps: 50, positions: [btc, other].map(market => ({ market, isLong: true, markPrice: '100', sizeUsd: 100, percent: 100 })) });
    for (const p of [open, close]) expect(p.tx.serialize().length).toBeLessThanOrEqual(1232 - 100); // room for a wallet's own instructions
  });

  it('moves an existing take-profit, cancels a stop-loss and places a new one, each against the tracked order', async () => {
    const key = Keypair.generate();
    const w = stub.walletData(key.publicKey.toBase58());
    const [tp, sl] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const market = new PublicKey(btc.marketToken);
    w.slots = [{ marketToken: market, gmPosition: gmPositionPda(ownerPda(new PublicKey(w.funded)), market, true), isLong: true, collateral: new BN(1), sizeUsd: new BN(1), pendingUsd: new BN(0), lastSync: new BN(0) }];
    w.tracked = [tp, sl].map((order, i) => ({ order, slot: 0, orderType: i ? { stopLoss: {} } : { takeProfit: {} }, sizeUsd: new BN(1), collateral: new BN(0), placedByRisk: false }));
    const change = await prepareProtection(connection, key.publicKey, { funded: w.funded, market: btc, isLong: true, takeProfit: { order: tp.toBase58(), price: '70000' }, stopLoss: { order: sl.toBase58(), price: null } });
    const [update, cancel] = decode(change.tx);
    expect([update!.name, cancel!.name]).toEqual(['updateOrder', 'cancelOrder']);
    expect(BigInt(update!.data.args.triggerPrice.toString())).toBe(toUnitPrice('70000', 8));
    const add = await prepareProtection(connection, key.publicKey, { funded: w.funded, market: btc, isLong: true, takeProfit: { order: tp.toBase58(), price: null }, stopLoss: { order: null, price: '60000' } });
    expect(decode(add.tx).map(ix => ix.name)).toEqual(['cancelOrder', 'setProtection']);
    expect(decode((await prepareCancel(connection, key.publicKey, w.funded, sl.toBase58())).tx).map(ix => ix.name)).toEqual(['cancelOrder']);
    await expect(prepareProtection(connection, key.publicKey, { funded: w.funded, market: btc, isLong: true, takeProfit: { order: null, price: null }, stopLoss: { order: null, price: null } })).rejects.toThrow('Nothing changed.');
    w.slots = w.tracked = undefined;
  });

  it('refuses a partial close below GMTrade\'s $1 minimum', async () => {
    const key = Keypair.generate();
    const w = stub.walletData(key.publicKey.toBase58());
    await expect(prepareClose(connection, key.publicKey, { funded: w.funded, slippageBps: 50, positions: [{ market: btc, isLong: true, markPrice: '64482', sizeUsd: 5, percent: 10 }] })).rejects.toThrow('at least $1');
  });

  it('does not ask the wallet to sign a transaction that fails simulation, and names the rule', async () => {
    const key = Keypair.generate();
    const w = stub.walletData(key.publicKey.toBase58());
    const p = await prepareOpen(connection, key.publicKey, { funded: w.funded, market: btc, isLong: true, kind: 'Market', price: '64482', sizeUsd: 30_000, collateralUsd: 1500, slippageBps: 50 });
    stub.state.simulationLogs = [`Program ${PROPS_VAULT_PROGRAM_ID.toBase58()} invoke [1]`, `Program ${PROPS_VAULT_PROGRAM_ID.toBase58()} failed: custom program error: 0x1786`];
    let asked = false;
    await expect(signAndSend(connection, p, async tx => { asked = true; return tx; })).rejects.toThrow('Total exposure above the account limit.');
    expect(asked).toBe(false);
  });
});

describe('the market an order goes to', () => {
  it('is checked onchain: the MarketConfig must name the market shown, and prices scale by the index mint\'s decimals', async () => {
    const key = Keypair.generate();
    const w = stub.walletData(key.publicKey.toBase58());
    const order = (market: { marketToken: string; symbol: string }) =>
      prepareOpen(connection, key.publicKey, { funded: w.funded, market, isLong: true, kind: 'Limit', price: '150', sizeUsd: 100, collateralUsd: 10, slippageBps: 50, stopLoss: '140' });
    // An API that shows SOL but sends the order to BTC's market, or to a market the program does not know: nothing is built.
    await expect(order({ ...marketRef('BTC'), symbol: 'SOL' })).rejects.toThrow('The SOL market could not be confirmed onchain');
    await expect(order({ marketToken: Keypair.generate().publicKey.toBase58(), symbol: 'SOL' })).rejects.toThrow('could not be confirmed onchain');
    // SOL's index token has 9 decimals onchain, whatever the API says: trigger prices are USD × 10^(20 − 9).
    const [open, stop] = decode((await order(marketRef('SOL'))).tx) as { data: { args: Record<string, any> } }[];
    expect(BigInt(open!.data.args.triggerPrice.toString())).toBe(toUnitPrice('150', 9));
    expect(BigInt(stop!.data.args.triggerPrice.toString())).toBe(toUnitPrice('140', 9));
  });
});

describe('evaluation purchase', () => {
  const [tier10k, tier25k] = TIERS;
  it('uses the profile\'s next evaluation index and counts only the new evaluation\'s rent when the profile exists', async () => {
    const key = Keypair.generate();
    stub.walletData(key.publicKey.toBase58()); // fixture profile with evaluationCount 2
    const p = await prepareEvaluation(connection, key.publicKey, tier10k);
    const [buy] = decode(p.tx);
    expect(buy!.name).toBe('buyEvaluation');
    expect({ ...buy!.data, expectedFeeUsdc: BigInt(buy!.data.expectedFeeUsdc.toString()) }).toEqual({ tierId: 1, index: 2, expectedFeeUsdc: 79_000_000n, expectedTierVersion: 1 });
    expect(p.rentLamports).toBe((128 + 164) * 6960);
  });

  it('adds the trader profile\'s rent for a first purchase', async () => {
    const p = await prepareEvaluation(connection, Keypair.generate().publicKey, tier25k);
    expect(decode(p.tx)[0]!.data).toMatchObject({ tierId: 2, index: 0, expectedTierVersion: 1 });
    expect(p.rentLamports).toBe((128 + 164) * 6960 + (128 + 86) * 6960);
  });

  it('builds nothing when the fee or terms the trader reviewed differ from the tier account the program charges', async () => {
    const trader = Keypair.generate().publicKey;
    for (const reviewed of [{ ...tier10k, feeUsdc: '49' }, { ...tier10k, version: 2 }, { ...tier10k, termsHash: 'ff'.repeat(32) }])
      await expect(prepareEvaluation(connection, trader, reviewed)).rejects.toThrow('changed since the page loaded');
    await expect(prepareEvaluation(connection, trader, { ...tier10k, id: 9 })).rejects.toThrow('not available onchain');
  });
});

describe('confirmation', () => {
  it('gives up once the network passes the last valid block height without the signature', async () => {
    await expect(confirm(connection, '1'.repeat(64), stub.state.blockHeight - 1, 10)).rejects.toThrow(TxError);
    await expect(confirm(connection, '1'.repeat(64), stub.state.blockHeight - 1, 10)).rejects.toThrow('expired');
  });

  it('reports an unknown outcome, with the signature, only when the connection stays down', async () => {
    const connection = fake({ getSignatureStatuses: async () => { throw new Error('fetch failed'); }, getBlockHeight: async () => 1 });
    const error = await confirm(connection, '2'.repeat(64), 160, 1).catch(e => e);
    expect(error).toBeInstanceOf(TxError);
    expect([error.uncertain, error.signature]).toEqual([true, '2'.repeat(64)]);
    expect(error.message).toMatch(/may still go through/);
  });

  it('keeps following an order through a failed read', async () => {
    let reads = 0;
    const connection = fake({ getMultipleAccountsInfo: async () => { if (++reads === 1) throw new Error('429 Too Many Requests'); return [null, null]; } });
    const follow = { order: Keypair.generate().publicKey.toBase58(), position: Keypair.generate().publicKey.toBase58(), sizeBefore: 5n, increase: false };
    expect(await watchExecution(connection, follow, { pollMs: 1 })).toBe('executed');
    expect(reads).toBe(2);
  });

  it('reads a position address GMTrade does not own (lamports sent to a closed position) as no position', async () => {
    const sent = { owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: 1_000_000, executable: false };
    const connection = fake({ getMultipleAccountsInfo: async () => [null, sent] });
    const follow = { order: Keypair.generate().publicKey.toBase58(), position: Keypair.generate().publicKey.toBase58(), sizeBefore: 5n, increase: false };
    expect(await watchExecution(connection, follow, { pollMs: 1 })).toBe('executed');
  });
});

describe('unit prices and failure reasons', () => {
  it('drops digits beyond the unit price precision', () => {
    expect(unitPrice('1.123456789012345', 9)).toBe(toUnitPrice('1.12345678901', 9));
    expect(unitPrice('150', 9)).toBe(15_000_000_000_000n);
  });

  it('reads every form a number input produces and refuses anything else in plain words', () => {
    expect(unitPrice('1.5e3', 8)).toBe(toUnitPrice('1500', 8));
    expect(unitPrice('1.23456e2', 8)).toBe(toUnitPrice('123.456', 8));
    for (const bad of ['', '.', '-5', '1,5', 'abc']) expect(() => unitPrice(bad, 8)).toThrow(TxError);
  });

  it('rounds collateral up to the micro-USDC, and leaves exact amounts as they are', async () => {
    const key = Keypair.generate();
    const w = stub.walletData(key.publicKey.toBase58());
    const collateral = async (collateralUsd: number) => {
      const p = await prepareOpen(connection, key.publicKey, { funded: w.funded, market: btc, isLong: true, kind: 'Market', price: '64482', sizeUsd: 1000, collateralUsd, slippageBps: 50 });
      return BigInt(decode(p.tx)[0]!.data.args.collateral.toString());
    };
    expect([await collateral(1001 / 15), await collateral(1000.5 / 5), await collateral(100)]).toEqual([66_733_334n, 200_100_000n, 100_000_000n]);
  });

  it('bundles the vault IDL without its docs and description, which name the venue (vite.config.js leanVaultIdl)', () => {
    expect(JSON.stringify(PROPS_VAULT_IDL)).not.toMatch(/"docs":/);
    expect(PROPS_VAULT_IDL.metadata).not.toHaveProperty('description');
    expect(PROPS_VAULT_IDL.errors.length).toBeGreaterThan(40); // what Anchor reads is all there
  });

  it('describes program, venue and balance failures in plain words', () => {
    const vault = PROPS_VAULT_PROGRAM_ID.toBase58();
    expect(describeFailure(null, [`Program ${vault} failed: custom program error: 0x1783`])).toBe('Collateral exceeds the account\'s available USDC.');
    expect(describeFailure(null, ['Program Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo failed: custom program error: 0x1770'])).toBe('The exchange rejected the order (error 6000).');
    // Through the vault's CPI: GMTrade's line comes first, and its Anchor error carries the reason.
    expect(describeFailure({ InstructionError: [1, { Custom: 6127 }] }, [
      `Program ${vault} invoke [1]`, 'Program Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo invoke [2]',
      'Program log: AnchorError thrown in programs/store/src/states/market/mod.rs:341. Error Code: MarketClosed. Error Number: 6127. Error Message: market is closed.',
      'Program Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo failed: custom program error: 0x17ef', `Program ${vault} failed: custom program error: 0x17ef`,
    ])).toBe('The exchange rejected the order: market is closed (error 6127).');
    // The vault's own messages that name GMTrade (from its IDL) read as the exchange too.
    expect([0x179a, 0x179b].map(code => describeFailure(null, [`Program ${vault} failed: custom program error: 0x${code.toString(16)}`])))
      .toEqual(["The exchange changed the owner's USDC or SOL beyond what the call allows.", "Not an exchange claimable account delegated to this account's owner."]);
    expect(describeFailure({ InstructionError: [0, { Custom: 1 }] }, ['Program log: Error: insufficient funds', 'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1'])).toMatch(/enough USDC/);
    expect(describeFailure({ InstructionError: [0, 'InvalidAccountData'] }, [])).toBe('The network rejected the transaction. Nothing was sent.');
    expect(describeFailure('Transfer: insufficient lamports 10, need 20', [])).toMatch(/enough SOL/);
  });
});
