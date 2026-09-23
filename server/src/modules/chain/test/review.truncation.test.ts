// Review finding (regression test): props_vault events were plain `emit!` log lines, and Solana keeps only the first
// 10,000 bytes of a transaction's logs. A trader who put cheap log-writing instructions (SPL Memo) in front of their
// own props_vault instruction made its event vanish; the indexer advanced past it, then threw on the next event for
// that account ("unknown funded account") and never got past it: every later transaction, anyone's, stopped indexing.
// Events are now self-CPIs (emit_cpi!), which the truncation cannot touch.
// Real solana-test-validator (ports 38899/38900, clear of the other suites) + real Postgres.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction, type Connection } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import {
  PROPS_VAULT_PROGRAM_ID, PropsVaultClient, buildTransaction, createLookupTableInstructions, evaluationPda, fetchLookupTables, fundedPda,
  sharedLookupAddresses, solTreasuryPda,
} from '@props/sdk';
import { fundedAccounts } from '../../../db/schema.ts';
import { CONFIG_PARAMS, LEVERAGE, MARKETS, TIERS, USD, hash32, marketParams, tierParams, usdc } from '../../../../../tests/program/src/env.ts';
import { sendTx, startValidator, type Validator } from '../../../../../tests/program/src/validator.ts';
import { parseVaultEvents } from '../events.ts';
import { createIndexer } from '../indexer.ts';
import { createReader } from '../reader.ts';
import { freshDb, silentLog, simStub } from './support.ts';

const hasValidator = (() => {
  try {
    execFileSync('solana-test-validator', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const skip = hasValidator ? false : 'solana-test-validator is not on PATH';

const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'); // in every solana-test-validator genesis
const SOL_INDEX_MINT = new PublicKey('So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH');
const admin = Keypair.generate();
const risk = Keypair.generate();
const kyc = Keypair.generate();
const attacker = Keypair.generate();
const honest = Keypair.generate();
const victim = Keypair.generate();

let validator: Validator;
let connection: Connection;
let vault: PropsVaultClient;
let t: Awaited<ReturnType<typeof freshDb>>;
const send = (ixs: TransactionInstruction[], signers: Keypair[], tables: Parameters<typeof sendTx>[3] = []) => sendTx(connection, ixs, signers, tables);
/** sendTx with the full 1.4M compute budget (the shared helper fixes 400k). */
async function sendBig(ixs: TransactionInstruction[], signers: Keypair[], tables: Parameters<typeof sendTx>[3] = []) {
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = buildTransaction({ payer: signers[0]!.publicKey, instructions: ixs, recentBlockhash: blockhash, lookupTables: tables, computeUnits: 1_400_000 });
  tx.sign(signers);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (let i = 0; i < 60; i++) {
    const { value } = await connection.getSignatureStatuses([signature]);
    if (value[0]?.confirmationStatus === 'confirmed' || value[0]?.confirmationStatus === 'finalized') break;
    await new Promise((r) => setTimeout(r, 400));
  }
  const got = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  assert.equal(got?.meta?.err, null, `transaction failed: ${got?.meta?.logMessages?.slice(-5).join('\n')}`);
  return { signature, tx: got!, logs: got!.meta!.logMessages ?? [] };
}
const logBytes = (logs: string[]) => logs.reduce((s, l) => s + l.length, 0);
/** 50 one-byte memos: ~200 bytes of transaction, ~12 KB of logs. */
const memoSpam = () => Array.from({ length: 50 }, () => new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from('x') }));

before(async () => {
  if (skip) return;
  t = await freshDb('chain_review_trunc');
  validator = await startValidator({
    rpcPort: 38899, faucetPort: 39900, gossipPort: 38001, dynamicPortRange: '38002-38040', upgradeAuthority: admin.publicKey,
    usdc: [[admin.publicKey, usdc('3000')], [attacker.publicKey, usdc('300')], [honest.publicKey, usdc('300')], [victim.publicKey, usdc('300')]],
    mints: [[SOL_INDEX_MINT, 9]],
  });
  connection = validator.connection;
  vault = new PropsVaultClient(connection);
  for (const k of [admin, risk, kyc, attacker, honest, victim]) await connection.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL);
  await connection.requestAirdrop(solTreasuryPda(), 5 * LAMPORTS_PER_SOL);
  await new Promise((r) => setTimeout(r, 1500));
  await send([await vault.initialize({ admin: admin.publicKey, params: CONFIG_PARAMS })], [admin]);
  await send([
    await vault.setAuthorities({ admin: admin.publicKey, riskAuthorities: [risk.publicKey], kycAuthority: kyc.publicKey }),
    await vault.upsertTier({ admin: admin.publicKey, id: TIERS.t10k.id, params: tierParams(TIERS.t10k) }),
    await vault.upsertMarket({ admin: admin.publicKey, marketToken: MARKETS.SOL.token, params: marketParams('SOL', LEVERAGE.crypto) }),
    await vault.depositCapital({ admin: admin.publicKey, amount: usdc('2000') }),
    await vault.setPauses({ admin: admin.publicKey, paused: { newEvaluations: false, trading: false, payouts: false } }),
  ], [admin]);
});

after(async () => {
  validator?.stop();
  await t?.sql.end();
});

/** Evaluation bought, identity set, passed: ready for activate_funded. */
async function passedEvaluation(trader: Keypair, person: string) {
  await send([await vault.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t10k.id, index: 0 })], [trader]);
  const evaluation = evaluationPda(trader.publicKey, 0);
  await send([await vault.setIdentity({ kycAuthority: kyc.publicKey, wallet: trader.publicKey, identityHash: hash32(person) })], [kyc]);
  await send([await vault.recordEvaluationResult({ riskAuthority: risk.publicKey, evaluation, passed: true, finalEquity: usdc('10800'), tradesRoot: hash32('fills') })], [risk]);
  return evaluation;
}

test('a trader-induced log truncation must not lose events or stall the indexer for everyone', { skip, timeout: 300_000 }, async () => {
  // Normal use, for scale: an open + stop-loss + take-profit in one v0 transaction (as the order ticket offers).
  const honestEval = await passedEvaluation(honest, 'honest');
  await send([await vault.activateFunded({ trader: honest.publicKey, evaluation: honestEval })], [honest]);
  const lut = createLookupTableInstructions({ authority: admin.publicKey, payer: admin.publicKey, recentSlot: await connection.getSlot('finalized'), addresses: sharedLookupAddresses() });
  await send(lut.instructions, [admin]);
  await new Promise((r) => setTimeout(r, 1200));
  const tables = await fetchLookupTables(connection, [lut.address]);
  const honestFunded = fundedPda(honestEval);
  const current = { address: honestFunded, account: (await vault.fetchFunded(honestFunded))! };
  const open = await vault.openPosition({
    trader: honest.publicKey, funded: current, marketToken: MARKETS.SOL.token, isLong: true, orderType: 'market',
    collateral: usdc('50'), sizeDeltaUsd: 500n * USD, acceptablePrice: 10n ** 30n,
  });
  const sl = await vault.setProtection({
    trader: honest.publicKey, funded: current, marketToken: MARKETS.SOL.token, isLong: true, orderType: 'stopLoss',
    triggerPrice: 100n * 10n ** 11n, sizeDeltaUsd: 500n * USD, ordersBefore: 1,
  });
  const tp = await vault.setProtection({
    trader: honest.publicKey, funded: current, marketToken: MARKETS.SOL.token, isLong: true, orderType: 'takeProfit',
    triggerPrice: 300n * 10n ** 11n, sizeDeltaUsd: 500n * USD, ordersBefore: 2,
  });
  const ticket = await sendBig([open.instruction, sl.instruction, tp.instruction], [honest], tables);
  console.log(JSON.stringify({
    openSlTpLogBytes: logBytes(ticket.logs), truncated: ticket.logs.includes('Log truncated'), events: parseVaultEvents(vault, ticket.tx).map((e) => e.name),
    perTopLevelInstruction: ticket.logs.reduce<number[]>((acc, l) => (l.endsWith(' invoke [1]') ? [...acc, l.length] : [...acc.slice(0, -1), (acc.at(-1) ?? 0) + l.length]), []),
  }));

  // The attack: 50 memos in front of the attacker's own activate_funded. The transaction succeeds; its event does not survive.
  const attackEval = await passedEvaluation(attacker, 'attacker');
  const activation = await sendBig([...memoSpam(), await vault.activateFunded({ trader: attacker.publicKey, evaluation: attackEval })], [attacker]);
  const attackFunded = fundedPda(attackEval);
  assert.ok(await vault.fetchFunded(attackFunded), 'the funded account exists onchain');
  console.log(JSON.stringify({
    activationLogBytes: logBytes(activation.logs), truncated: activation.logs.includes('Log truncated'),
    eventsSeen: parseVaultEvents(vault, activation.tx).map((e) => e.name),
  }));
  // Then any ordinary instruction on that account.
  const attackOpen = await vault.openPosition({
    trader: attacker.publicKey, funded: { address: attackFunded, account: (await vault.fetchFunded(attackFunded))! }, marketToken: MARKETS.SOL.token,
    isLong: true, orderType: 'market', collateral: usdc('10'), sizeDeltaUsd: 50n * USD, acceptablePrice: 10n ** 30n,
  });
  await send([attackOpen.instruction], [attacker]);

  // An unrelated trader buys an evaluation afterwards.
  await send([await vault.buyEvaluation({ trader: victim.publicKey, tierId: TIERS.t10k.id, index: 0 })], [victim]);

  const { sim, created } = simStub();
  const indexer = createIndexer({
    db: t.db, rpc: connection, client: vault, programId: PROPS_VAULT_PROGRAM_ID, log: silentLog, reader: createReader(vault, connection), sim,
    notify: async () => {}, onApplied() {},
  });
  let stalled: unknown;
  for (let pass = 0; pass < 3; pass++) {
    try {
      await indexer.catchUp();
      stalled = undefined;
      break;
    } catch (err) {
      stalled = err;
    }
  }
  console.log(JSON.stringify({ indexerError: stalled instanceof Error ? stalled.message : null }));

  assert.ok(created.some((c) => c.wallet === victim.publicKey.toBase58()), 'the victim\'s paid evaluation reaches the engine');
  assert.equal(stalled, undefined, 'the indexer keeps going');
  assert.equal((await t.db.select().from(fundedAccounts).where(eq(fundedAccounts.address, attackFunded.toBase58()))).length, 1, 'the attacker\'s funded account is indexed');
});
