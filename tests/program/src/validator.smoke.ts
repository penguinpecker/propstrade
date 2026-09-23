// Smoke suite on a real solana-test-validator: the mainnet GMTrade binary at its address, cloned mainnet
// accounts, props_vault deployed through the upgradeable loader, everything driven through @props/sdk over
// JSON-RPC with v0 transactions (one through a lookup table). Nothing here talks to mainnet except the
// optional read-only --clone-feature-set (disable with CLONE_FEATURES=0).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import {
  GMTRADE_PROGRAM_ID,
  PROPS_VAULT_PROGRAM_ID,
  PropsVaultClient,
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
import { sendTx as send, startValidator, type Validator } from './validator.ts';

const LAST_RESTART_SLOT_SYSVAR = new PublicKey('SysvarLastRestartS1ot1111111111111111111111');

const admin = Keypair.generate();
const risk = Keypair.generate();
const kyc = Keypair.generate();
const trader = Keypair.generate();

describe('solana-test-validator smoke (real CPIs through @props/sdk)', () => {
  let validator: Validator;
  let connection: Connection;
  let vault: PropsVaultClient;

  before(async () => {
    validator = await startValidator({
      rpcPort: 18899, faucetPort: 19900, gossipPort: 18001, dynamicPortRange: '18002-18040', upgradeAuthority: admin.publicKey,
      usdc: [[admin.publicKey, usdc('1000')], [trader.publicKey, usdc('200')]],
    });
    connection = validator.connection;
    vault = new PropsVaultClient(connection);
    for (const k of [admin, risk, kyc, trader]) {
      await connection.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL);
    }
    await connection.requestAirdrop(solTreasuryPda(), 5 * LAMPORTS_PER_SOL);
    await new Promise((r) => setTimeout(r, 1500));
  });

  after(() => validator?.stop());

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
    // Top-level props_vault instructions only (each also self-invokes once per event it emits).
    const perInstruction: number[] = [];
    let depth = 0;
    for (const l of withTable.logs) {
      if (/^Program \w+ invoke \[\d+\]$/.test(l)) depth++;
      else if (/^Program \w+ (success|failed)/.test(l)) depth--;
      const cu = new RegExp(`^Program ${PROPS_VAULT_PROGRAM_ID.toBase58()} consumed (\\d+)`).exec(l)?.[1];
      if (cu && depth === 1) perInstruction.push(Number(cu));
    }
    console.log(JSON.stringify({ openCu: perInstruction[0], stopLossCu: perInstruction[1], txCu: withTable.cu, txBytes: withTable.size }));
  });
});
