// Smoke suite on a real solana-test-validator: the mainnet GMTrade binary at its address, cloned mainnet
// accounts, props_vault deployed through the upgradeable loader, everything driven through @props/sdk over
// JSON-RPC with v0 transactions (one through a lookup table). Nothing here talks to mainnet except the
// optional read-only --clone-feature-set (disable with CLONE_FEATURES=0).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AccountLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import type { AddressLookupTableAccount, TransactionInstruction } from '@solana/web3.js';
import {
  GMTRADE_PROGRAM_ID,
  GMTRADE_STORE,
  PROPS_VAULT_PROGRAM_ID,
  PropsVaultClient,
  USDC_MINT,
  buildTransaction,
  capitalVaultAddress,
  createLookupTableInstructions,
  enumName,
  evaluationPda,
  fetchLookupTables,
  fundedPda,
  gmPositionPda,
  isPendingGmOrder,
  ownerPda,
  ownerUsdcAddress,
  sharedLookupAddresses,
  solTreasuryPda,
} from '@props/sdk';
import { CONFIG_PARAMS, LEVERAGE, MARKETS, TIERS, USD, hash32, marketParams, tierParams, usdc } from './env.ts';

const FIXTURES = new URL('../fixtures/', import.meta.url);
const PROGRAM_SO = new URL('../../../target/deploy/props_vault.so', import.meta.url).pathname;
const RPC_PORT = 18899;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const STORE_LAST_RESTART_OFFSET = 4800;
const LAST_RESTART_SLOT_SYSVAR = new PublicKey('SysvarLastRestartS1ot1111111111111111111111');

const admin = Keypair.generate();
const risk = Keypair.generate();
const kyc = Keypair.generate();
const trader = Keypair.generate();

/** Account fixtures for --account-dir: mainnet snapshots (Store restart slot patched to the local 0) + USDC balances. */
function writeAccountDir(dir: string): void {
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
  for (const [owner, amount] of [[admin.publicKey, usdc('1000')], [trader.publicKey, usdc('200')]] as const) {
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint: USDC_MINT, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0,
        isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
      },
      data,
    );
    const address = getAssociatedTokenAddressSync(USDC_MINT, owner);
    const account = { lamports: 2_039_280, data: [data.toString('base64'), 'base64'], owner: TOKEN_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0, space: data.length };
    writeFileSync(join(dir, `${address.toBase58()}.json`), JSON.stringify({ pubkey: address.toBase58(), account }));
  }
}

async function startValidator(workDir: string): Promise<ChildProcess> {
  const accounts = join(workDir, 'accounts');
  mkdirSync(accounts);
  writeAccountDir(accounts);
  const args = [
    '--reset', '--quiet', '--ledger', join(workDir, 'ledger'),
    '--rpc-port', String(RPC_PORT), '--faucet-port', '19900', '--gossip-port', '18001', '--dynamic-port-range', '18002-18040',
    '--upgradeable-program', GMTRADE_PROGRAM_ID.toBase58(), new URL('gmsol_store.so', FIXTURES).pathname, 'none',
    '--upgradeable-program', PROPS_VAULT_PROGRAM_ID.toBase58(), PROGRAM_SO, admin.publicKey.toBase58(),
    '--account-dir', accounts,
  ];
  if (process.env.CLONE_FEATURES !== '0') args.push('--clone-feature-set', '--url', 'https://api.mainnet-beta.solana.com');
  const validator = spawn('solana-test-validator', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  const connection = new Connection(RPC, 'confirmed');
  for (let i = 0; i < 120; i++) {
    if (validator.exitCode !== null) break;
    try {
      await connection.getSlot();
      return validator;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  validator.kill('SIGKILL');
  throw new Error('solana-test-validator did not start');
}

/** Sends a v0 transaction and polls for confirmation (no websocket, so nothing keeps the process alive). */
async function send(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  lookupTables: AddressLookupTableAccount[] = [],
): Promise<{ cu: number; size: number; logs: string[] }> {
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
  return { cu: t.meta.computeUnitsConsumed ?? 0, size: raw.length, logs: t.meta.logMessages ?? [] };
}

describe('solana-test-validator smoke (real CPIs through @props/sdk)', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'props-vault-validator-'));
  const connection = new Connection(RPC, 'confirmed');
  const vault = new PropsVaultClient(connection);
  let validator: ChildProcess;

  before(async () => {
    validator = await startValidator(workDir);
    for (const k of [admin, risk, kyc, trader]) {
      await connection.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL);
    }
    await connection.requestAirdrop(solTreasuryPda(), 5 * LAMPORTS_PER_SOL);
    await new Promise((r) => setTimeout(r, 1500));
  });

  after(() => {
    validator?.kill('SIGINT');
    rmSync(workDir, { recursive: true, force: true });
  });

  it('runs the funded lifecycle against the mainnet GMTrade binary', async () => {
    const restart = await connection.getAccountInfo(LAST_RESTART_SLOT_SYSVAR);
    assert.equal(restart?.data.readBigUInt64LE(0), 0n, 'the Store fixture was patched to the local LastRestartSlot');

    const stranger = Keypair.generate();
    await connection.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL);
    await new Promise((r) => setTimeout(r, 800));
    await assert.rejects(send(connection, [await vault.initialize({ admin: stranger.publicKey, params: CONFIG_PARAMS })], [stranger]), /NotUpgradeAuthority/);

    await send(connection, [await vault.initialize({ admin: admin.publicKey, params: CONFIG_PARAMS })], [admin]);
    await send(
      connection,
      [
        await vault.setAuthorities({ admin: admin.publicKey, riskAuthorities: [risk.publicKey], kycAuthority: kyc.publicKey }),
        await vault.upsertTier({ admin: admin.publicKey, id: TIERS.t10k.id, params: tierParams(TIERS.t10k) }),
        await vault.upsertMarket({ admin: admin.publicKey, marketToken: MARKETS.SOL.token, params: marketParams('SOL', LEVERAGE.crypto) }),
        await vault.depositCapital({ admin: admin.publicKey, amount: usdc('1000') }),
        await vault.setPauses({ admin: admin.publicKey, paused: { newEvaluations: false, trading: false, payouts: false } }),
      ],
      [admin],
    );
    const config = await vault.fetchConfig();
    assert.ok(config?.admin.equals(admin.publicKey));

    await send(connection, [await vault.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t10k.id, index: 0 })], [trader]);
    const evaluation = evaluationPda(trader.publicKey, 0);
    await send(connection, [await vault.setIdentity({ kycAuthority: kyc.publicKey, wallet: trader.publicKey, identityHash: hash32('smoke') })], [kyc]);
    await send(
      connection,
      [await vault.recordEvaluationResult({ riskAuthority: risk.publicKey, evaluation, passed: true, finalEquity: usdc('10800'), tradesRoot: hash32('fills') })],
      [risk],
    );
    await send(connection, [await vault.activateFunded({ trader: trader.publicKey, evaluation })], [trader]);
    const funded = fundedPda(evaluation);
    const owner = ownerPda(funded);
    assert.equal((await connection.getTokenAccountBalance(ownerUsdcAddress(funded))).value.amount, usdc('500').toString());

    // A Props lookup table, then an open + stop-loss in one v0 transaction that uses it.
    const slot = await connection.getSlot('finalized');
    const lut = createLookupTableInstructions({ authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot, addresses: sharedLookupAddresses() });
    await send(connection, lut.instructions, [admin]);
    await new Promise((r) => setTimeout(r, 1200)); // a table is usable from the slot after its last extension
    const tables = await fetchLookupTables(connection, [lut.address]);

    const current = { address: funded, account: (await vault.fetchFunded(funded))! };
    const open = await vault.openPosition({
      trader: trader.publicKey, funded: current, marketToken: MARKETS.SOL.token, isLong: true, orderType: 'market',
      collateral: usdc('50'), sizeDeltaUsd: 500n * USD, acceptablePrice: 10n ** 30n,
    });
    const sl = await vault.setProtection({
      trader: trader.publicKey, funded: current, marketToken: MARKETS.SOL.token, isLong: true, orderType: 'stopLoss',
      triggerPrice: 100n * 10n ** 11n, sizeDeltaUsd: 500n * USD, ordersBefore: 1,
    });
    const withTable = await send(connection, [open.instruction, sl.instruction], [trader], tables);
    assert.ok(withTable.cu < 400_000, `open + stop-loss used ${withTable.cu} CU`);
    assert.ok(withTable.size <= 1232, `transaction is ${withTable.size} bytes`);
    for (const order of [open.order, sl.order]) {
      const info = await connection.getAccountInfo(order);
      assert.ok(info?.owner.equals(GMTRADE_PROGRAM_ID) && isPendingGmOrder(info.data), 'GMTrade holds the order as pending');
    }
    assert.deepEqual((await vault.fetchOwnerPositions(funded)).map(String), [gmPositionPda(owner, MARKETS.SOL.token, true).toBase58()]);
    const state = await vault.fetchFunded(funded);
    assert.equal(state?.orders.filter((o) => !o.order.equals(PublicKey.default)).length, 2);

    // Cancel both through the owner PDA; collateral and order rent come back.
    for (const order of [open.order, sl.order]) {
      const fresh = { address: funded, account: (await vault.fetchFunded(funded))! };
      await send(connection, [await vault.cancelOrder({ authority: trader.publicKey, funded: fresh, order })], [trader]);
    }
    assert.equal((await connection.getTokenAccountBalance(ownerUsdcAddress(funded))).value.amount, usdc('500').toString());
    await send(connection, [await vault.sync({ funded: { address: funded, account: (await vault.fetchFunded(funded))! } })], [risk]);

    // Close the account: the principal returns to the capital vault.
    const capitalBefore = BigInt((await connection.getTokenAccountBalance(capitalVaultAddress())).value.amount);
    await send(connection, [await vault.markBreached({ riskAuthority: risk.publicKey, funded })], [risk]);
    const positions = await vault.fetchOwnerPositions(funded);
    await send(connection, [await vault.closeFunded({ riskAuthority: risk.publicKey, funded: { address: funded, account: (await vault.fetchFunded(funded))! }, positions })], [risk]);
    const capitalAfter = BigInt((await connection.getTokenAccountBalance(capitalVaultAddress())).value.amount);
    assert.equal(capitalAfter - capitalBefore, usdc('500'));
    assert.equal(enumName((await vault.fetchFunded(funded))!.status), 'closed');
    const perInstruction = withTable.logs
      .map((l) => new RegExp(`^Program ${PROPS_VAULT_PROGRAM_ID.toBase58()} consumed (\\d+)`).exec(l)?.[1])
      .filter(Boolean)
      .map(Number);
    console.log(JSON.stringify({ openCu: perInstruction[0], stopLossCu: perInstruction[1], txCu: withTable.cu, txBytes: withTable.size }));
  });
});
