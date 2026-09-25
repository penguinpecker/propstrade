// End to end on a real solana-test-validator (the mainnet GMTrade binary + cloned mainnet accounts, props_vault
// deployed; ports 28899/28900) and a real Postgres: the chain module indexes every transaction through the logs
// subscription, the job executor sends set_identity / record_evaluation_result / approve_payout / reject_payout with
// throwaway authority keys, and a restart backfills without gaps or duplicates. GMTrade keepers do not run locally, so
// orders are placed and cancelled but never filled; GMTrade's indexer is stubbed empty.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, type Connection } from '@solana/web3.js';
import { count, eq, sql } from 'drizzle-orm';
import type { AccountSummary, AppConfig, Order, Payout, PayoutEligibility, VaultStats, VerifyResult } from '@props/shared';
import {
  PROPS_VAULT_PROGRAM_ID, PropsVaultClient, USDC_MINT, capitalVaultAddress, enumName, evaluationPda, fundedPda, ownerUsdcAddress, payoutPda,
  solTreasuryPda, traderProfilePda,
} from '@props/sdk';
import { buildApp } from '../../../app.ts';
import { loadConfig } from '../../../config.ts';
import { chainJobs, evaluations, fundedAccounts, gmOrders, indexerCursors, payouts, programEvents, vaultLedger } from '../../../db/schema.ts';
import { createSealer } from '../../../lib/integrity.ts';
import { createConnection } from '../../../lib/solana.ts';
import { createStreamHub } from '../../../stream.ts';
import { APP_ORIGIN, signIn } from '../../../../test/helpers.ts';
import { CONFIG_PARAMS, LEVERAGE, MARKETS, TIERS, USD, hash32, marketParams, tierParams, usdc } from '../../../../../tests/program/src/env.ts';
import { sendTx, startValidator, type Validator } from '../../../../../tests/program/src/validator.ts';
import type { ModuleContext } from '../../types.ts';
import { parseVaultEvents } from '../events.ts';
import { createChain } from '../index.ts';
import { jobRow } from '../jobs.ts';
import type { GmIndexer } from '../venue.ts';
import { freshDb, simStub, until, TEST_SESSION_SECRET, sealer } from './support.ts';

const hasValidator = (() => {
  try {
    execFileSync('solana-test-validator', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const skip = hasValidator ? false : 'solana-test-validator is not on PATH';

const SOL_INDEX_MINT = new PublicKey('So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH'); // index token of SOL/USD[USDC-USDC], 9 decimals
const admin = Keypair.generate();
const risk = Keypair.generate();
const kyc = Keypair.generate();
const trader = Keypair.generate();
const latecomer = Keypair.generate();
const noVenueFills: GmIndexer = { trades: async () => [], signatures: async () => new Map(), removals: async () => [] };
const hex = (b: Uint8Array | number[]) => Buffer.from(b).toString('hex');

let validator: Validator;
let connection: Connection;
let vault: PropsVaultClient;
let t: Awaited<ReturnType<typeof freshDb>>;
const adminToken = randomBytes(32).toString('hex');

/** The server as deployed: core app + the chain module with the throwaway authority keys. */
async function startServer() {
  const config = loadConfig({
    DATABASE_URL: t.url, APP_ORIGIN, SESSION_SECRET: TEST_SESSION_SECRET, ADMIN_API_TOKEN: adminToken,
    RPC_URL: validator.rpcUrl, RPC_WS_URL: validator.wsUrl, SOLANA_CLUSTER: 'localnet', PROGRAM_ID: PROPS_VAULT_PROGRAM_ID.toBase58(), TRUST_PROXY_HOPS: '0',
  });
  const rpc = createConnection(config);
  const hub = createStreamHub();
  const app = await buildApp({ config, db: t.db, sql: t.sql, hub, modules: new Map(), rpc, logger: false });
  const shutdown = new AbortController();
  const stub = simStub();
  const ctx: ModuleContext = {
    app, log: app.log, publish: hub.publish, services: { sim: stub.sim }, signal: shutdown.signal, config, db: t.db, sql: t.sql, rpc,
    env: { RISK_AUTHORITY_KEYPAIR: JSON.stringify([...risk.secretKey]), KYC_AUTHORITY_KEYPAIR: JSON.stringify([...kyc.secretKey]) },
    notify: async () => {},
  };
  // The indexer's fallback poll is 60 s here: anything indexed sooner arrived through the logs subscription.
  const chain = await createChain(ctx, { gm: noVenueFills, intervals: { indexer: 60_000, venue: 1_000, jobs: 500 } });
  await app.ready();
  return {
    app, stub, chain,
    async stop() {
      shutdown.abort();
      await chain.leader;
      await app.close();
      // web3.js closes an idle websocket 500 ms after the last unsubscribe; a validator stopped before then leaves it
      // reconnecting forever and the test process never exits.
      await new Promise((r) => setTimeout(r, 1_500));
    },
  };
}
type Server = Awaited<ReturnType<typeof startServer>>;

const send = (ixs: Parameters<typeof sendTx>[1], signers: Keypair[]) => sendTx(connection, ixs, signers);
async function fresh() {
  const address = fundedPda(evaluationPda(trader.publicKey, 0));
  return { address, account: (await vault.fetchFunded(address))! };
}

before(async () => {
  if (skip) return;
  t = await freshDb('chain_e2e');
  validator = await startValidator({
    rpcPort: 28899, faucetPort: 29900, gossipPort: 28001, dynamicPortRange: '28002-28040', upgradeAuthority: admin.publicKey,
    usdc: [[admin.publicKey, usdc('2000')], [trader.publicKey, usdc('300')], [latecomer.publicKey, usdc('100')]],
    mints: [[SOL_INDEX_MINT, 9]],
  });
  connection = validator.connection;
  vault = new PropsVaultClient(connection);
  for (const k of [admin, risk, kyc, trader, latecomer]) await connection.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL);
  await connection.requestAirdrop(solTreasuryPda(), 5 * LAMPORTS_PER_SOL);
  await new Promise((r) => setTimeout(r, 1500));
  await send([await vault.initialize({ admin: admin.publicKey, params: CONFIG_PARAMS })], [admin]);
  await send([
    await vault.setAuthorities({ admin: admin.publicKey, riskAuthorities: [risk.publicKey], kycAuthority: kyc.publicKey }),
    await vault.upsertTier({ admin: admin.publicKey, id: TIERS.t10k.id, params: tierParams(TIERS.t10k) }),
    await vault.upsertMarket({ admin: admin.publicKey, marketToken: MARKETS.SOL.token, params: marketParams('SOL', LEVERAGE.crypto) }),
    await vault.depositCapital({ admin: admin.publicKey, amount: usdc('1000') }),
    await vault.setPauses({ admin: admin.publicKey, paused: { newEvaluations: false, trading: false, payouts: false } }),
  ], [admin]);
});

after(async () => {
  validator?.stop();
  await t?.sql.end();
});

test('chain module against solana-test-validator: index, jobs, funded lifecycle, payouts, restart backfill', { skip, timeout: 300_000 }, async () => {
  let server: Server = await startServer();
  const { app } = server;
  const get = async <T>(url: string, cookie?: string) => {
    const r = await app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
    return { status: r.statusCode, body: r.json() as T };
  };
  const adminCall = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${adminToken}` } }).then((r) => ({ status: r.statusCode, body: r.json() }));
  const job = async (subject: string) => (await t.db.select().from(chainJobs).where(eq(chainJobs.subject, subject)))[0];

  await until(async () => (await t.db.select().from(vaultLedger)).length === 1, 30_000, 'the setup transactions to be indexed');
  const config = await get<AppConfig>('/v1/config');
  assert.deepEqual([config.status, config.body.cluster, config.body.paused, config.body.tiers.map((x) => [x.name, x.sizeUsd, x.feeUsdc, x.enabled])],
    [200, 'localnet', { newEvaluations: false, trading: false, payouts: false }, [['10K', '10000', '79', true]]]);

  // ---- purchase → indexer (through the subscription) → sim.createEvaluation with the onchain terms
  const evaluation = evaluationPda(trader.publicKey, 0);
  const sentAt = Date.now();
  const purchase = await send([await vault.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t10k.id, index: 0, feeUsdc: usdc(TIERS.t10k.fee), tierVersion: 1 })], [trader]);
  const created = await until(async () => server.stub.created[0], 20_000, 'createEvaluation');
  assert.ok(Date.now() - sentAt < 20_000, 'indexed long before the 60 s fallback poll');
  assert.deepEqual(created, {
    evaluation: evaluation.toBase58(), wallet: trader.publicKey.toBase58(), signature: purchase.signature, purchasedAt: created.purchasedAt,
    terms: { tierId: 1, sizeUsd: '10000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000, termsHash: hex(hash32('terms:10000')) },
  });

  // ---- KYC approval → set_identity job signed by the KYC authority
  const session = await signIn(app, trader);
  const kycStart = await app.inject({ method: 'POST', url: '/v1/kyc/start', payload: { country: 'DE' }, headers: { cookie: session.cookie, origin: APP_ORIGIN } });
  assert.equal(kycStart.statusCode, 200);
  const [request] = (await adminCall('GET', '/v1/admin/kyc')).body as { id: string }[];
  const identityHash = hex(hash32('person-1'));
  assert.equal((await adminCall('POST', `/v1/admin/kyc/${request!.id}/approve`, { identityHash, country: 'DE' })).status, 200);
  await until(async () => (await t.db.select().from(chainJobs).where(eq(chainJobs.kind, 'set_identity')))[0]?.status === 'confirmed', 30_000, 'set_identity');
  assert.equal(hex((await vault.fetch('traderProfile', traderProfilePda(trader.publicKey)))!.identityHash), identityHash);
  assert.equal((await get<{ kyc: string }>('/v1/me', session.cookie)).body.kyc, 'verified');

  // ---- the engine resolves the evaluation → record_evaluation_result job signed by the risk authority → markRecorded
  const tradesRoot = hex(hash32('fills'));
  const result = { evaluation: evaluation.toBase58(), wallet: trader.publicKey.toBase58(), passed: true, finalEquityUsd: '10800', tradesRoot, resolvedAt: Date.now() };
  server.stub.resolve(result);
  server.stub.resolve(result); // delivered twice: still one job
  await until(async () => (await job(evaluation.toBase58()))?.status === 'confirmed', 30_000, 'record_evaluation_result');
  const recordJob = (await job(evaluation.toBase58()))!;
  assert.deepEqual(server.stub.recorded, [[evaluation.toBase58(), recordJob.signature]]);
  assert.equal((await t.db.select({ n: count() }).from(chainJobs).where(eq(chainJobs.kind, 'record_evaluation_result')))[0]!.n, 1);
  const onchain = (await vault.fetch('evaluation', evaluation))!;
  assert.deepEqual([enumName(onchain.status), onchain.finalEquity.toString(), hex(onchain.tradesRoot)], ['passed', '10800000000', tradesRoot]);
  await until(async () => (await t.db.select().from(evaluations).where(eq(evaluations.address, evaluation.toBase58())))[0]?.resultSignature === recordJob.signature, 20_000, 'result indexed');

  // Idempotency against chain state: an already-recorded result is confirmed without a transaction; a conflicting one fails.
  const [again] = await t.db.insert(chainJobs).values(jobRow(sealer, 'record_evaluation_result', null, result)).returning();
  const [conflict] = await t.db.insert(chainJobs).values(jobRow(sealer, 'record_evaluation_result', null, { ...result, passed: false })).returning();
  // Someone with write access to the database but not the server's environment: a set_identity for a wallet of theirs.
  const intruder = Keypair.generate().publicKey;
  const forgedPayload = { wallet: intruder.toBase58(), identityHash: hex(hash32('forged')) };
  const [forged] = await t.db.insert(chainJobs).values({
    kind: 'set_identity', payload: forgedPayload, mac: createSealer('not the server secret').job({ kind: 'set_identity', subject: null, payload: forgedPayload }),
  }).returning();
  const signaturesBefore = (await connection.getSignaturesForAddress(PROPS_VAULT_PROGRAM_ID)).length;
  await until(async () => {
    const rows = await t.db.select().from(chainJobs).where(sql`${chainJobs.id} in (${again!.id}, ${conflict!.id}, ${forged!.id})`);
    return rows.every((r) => r.status === 'confirmed' || r.status === 'failed') && rows;
  }, 20_000, 'replayed jobs');
  const [replayed] = await t.db.select().from(chainJobs).where(eq(chainJobs.id, again!.id));
  const [refused] = await t.db.select().from(chainJobs).where(eq(chainJobs.id, conflict!.id));
  const [unsealed] = await t.db.select().from(chainJobs).where(eq(chainJobs.id, forged!.id));
  assert.deepEqual([replayed!.status, replayed!.signature], ['confirmed', recordJob.signature]);
  assert.deepEqual([refused!.status, refused!.lastError], ['failed', 'Evaluation is already recorded as passed']);
  assert.deepEqual([unsealed!.status, unsealed!.signature], ['failed', null]);
  assert.match(unsealed!.lastError!, /integrity check/);
  assert.equal(await vault.fetch('traderProfile', traderProfilePda(intruder)), null, 'no identity was set for the forged job');
  assert.equal((await connection.getSignaturesForAddress(PROPS_VAULT_PROGRAM_ID)).length, signaturesBefore, 'nothing was sent');

  // ---- activation → funded account in the accounts API
  const fundedAddress = fundedPda(evaluation);
  await send([await vault.activateFunded({ trader: trader.publicKey, evaluation })], [trader]);
  await until(async () => (await t.db.select().from(fundedAccounts)).length === 1, 20_000, 'activation indexed');
  const summaryOf = async () => (await get<AccountSummary[]>('/v1/accounts', session.cookie)).body.find((a) => a.id === fundedAddress.toBase58())!;
  let summary = await summaryOf();
  assert.deepEqual([summary.stage, summary.status, summary.equity, summary.allowanceRemaining, summary.availableMargin, summary.label, summary.freshness],
    ['funded', 'active', '10000', '500', '500', 'Funded 10K', 'live']);

  // ---- a real GMTrade order through the program's CPI, tracked by the indexer, then cancelled
  const open = await vault.openPosition({
    trader: trader.publicKey, funded: await fresh(), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'market',
    collateral: usdc('50'), sizeDeltaUsd: 500n * USD, acceptablePrice: 10n ** 30n,
  });
  await send([open.instruction], [trader]);
  const orders = await until(async () => {
    const list = (await get<Order[]>(`/v1/accounts/${fundedAddress.toBase58()}/orders`, session.cookie)).body;
    return list.length === 1 && list;
  }, 20_000, 'order indexed');
  assert.deepEqual([orders[0]!.id, orders[0]!.symbol, orders[0]!.kind, orders[0]!.side, orders[0]!.status, orders[0]!.collateralUsd, orders[0]!.sizeUsd],
    [open.order.toBase58(), 'SOL', 'Market', 'Long', 'awaiting_execution', '50', '500']);
  summary = await until(async () => {
    const s = await summaryOf();
    return s.availableMargin === '450' && s;
  }, 20_000, 'escrowed collateral in the valuation');
  assert.equal(summary.equity, '10000', 'collateral escrowed in a pending order still counts');

  await send([await vault.cancelOrder({ authority: trader.publicKey, funded: await fresh(), order: open.order })], [trader]);
  await until(async () => (await t.db.select().from(gmOrders).where(eq(gmOrders.address, open.order.toBase58())))[0]?.status === 'canceled', 20_000, 'cancel indexed');
  assert.deepEqual((await get<Order[]>(`/v1/accounts/${fundedAddress.toBase58()}/orders`, session.cookie)).body, []);
  await send([await vault.sync({ funded: await fresh() })], [trader]);
  await until(async () => (await t.db.select().from(fundedAccounts))[0]?.lastSyncAt, 20_000, 'sync indexed');

  // ---- payout approved by the operator → approve_payout job → paid onchain
  const traderUsdc = getAssociatedTokenAddressSync(USDC_MINT, trader.publicKey);
  const fund = async (amount: string) => send([createTransferCheckedInstruction(traderUsdc, USDC_MINT, ownerUsdcAddress(fundedAddress), trader.publicKey, usdc(amount), 6)], [trader]);
  await fund('100');
  const eligibility = await until(async () => {
    const e = (await get<PayoutEligibility>(`/v1/accounts/${fundedAddress.toBase58()}/payout-eligibility`, session.cookie)).body;
    return e.eligible && e;
  }, 20_000, 'payout eligibility');
  assert.deepEqual([eligibility.realizedProfit, eligibility.traderShare, eligibility.vaultShare, eligibility.flat], ['100', '80', '20', true]);
  const payout1 = payoutPda(fundedAddress, 0);
  await send([await vault.requestPayout({ trader: trader.publicKey, funded: fundedAddress, payoutSeq: 0 })], [trader]);
  await until(async () => (await t.db.select().from(payouts)).length === 1, 20_000, 'payout request indexed');
  assert.deepEqual((await adminCall('GET', '/v1/admin/payouts')).body.map((p: { id: string }) => p.id), [payout1.toBase58()]);
  const usdcBefore = BigInt((await connection.getTokenAccountBalance(traderUsdc)).value.amount);
  assert.equal((await adminCall('POST', `/v1/admin/payouts/${payout1.toBase58()}/approve`)).status, 200);
  const paid = await until(async () => {
    const p = (await get<Payout>(`/v1/payouts/${payout1.toBase58()}`, session.cookie)).body;
    return p.status === 'paid' && p;
  }, 30_000, 'payout paid');
  assert.equal(paid.paySignature, (await job(payout1.toBase58()))!.signature);
  assert.ok(Number(paid.networkFeeSol) > 0);
  assert.equal(BigInt((await connection.getTokenAccountBalance(traderUsdc)).value.amount) - usdcBefore, usdc('80'));

  // ---- payout rejected by the operator → reject_payout job
  await fund('100');
  const payout2 = payoutPda(fundedAddress, 1);
  await until(async () => (await get<PayoutEligibility>(`/v1/accounts/${fundedAddress.toBase58()}/payout-eligibility`, session.cookie)).body.eligible, 20_000, 'eligible again');
  await send([await vault.requestPayout({ trader: trader.publicKey, funded: fundedAddress, payoutSeq: 1 })], [trader]);
  await until(async () => (await t.db.select().from(payouts)).length === 2, 20_000, 'second request indexed');
  assert.equal((await adminCall('POST', `/v1/admin/payouts/${payout2.toBase58()}/reject`, { reasonCode: 2 })).status, 200);
  const rejected = await until(async () => {
    const p = (await get<Payout>(`/v1/payouts/${payout2.toBase58()}`, session.cookie)).body;
    return p.status === 'rejected' && p;
  }, 30_000, 'payout rejected');
  assert.deepEqual([rejected.reasonCode, rejected.reason], [2, 'Requested profit does not match the account\'s exchange trade history']);
  assert.equal(enumName((await vault.fetch('payoutRequest', payout2))!.status), 'rejected');

  // ---- closure by an operator (admin API → sealed close_funded job) → closed account, principal back in the vault ledger
  const positions = await vault.fetchOwnerPositions(fundedAddress);
  assert.equal(positions.length, 1, 'the cancelled order left a flat Position account');
  assert.equal((await adminCall('POST', `/v1/admin/funded/${fundedAddress.toBase58()}/close`)).status, 200);
  await until(async () => (await t.db.select().from(fundedAccounts))[0]?.status === 'closed', 30_000, 'closure indexed');
  assert.equal(enumName((await vault.fetchFunded(fundedAddress))!.status), 'closed');
  const [closeJob] = await t.db.select().from(chainJobs).where(eq(chainJobs.subject, `close:${fundedAddress.toBase58()}`));
  await until(async () => (await t.db.select().from(chainJobs).where(eq(chainJobs.id, closeJob!.id)))[0]?.status === 'confirmed', 20_000, 'close job confirmed');
  summary = await summaryOf();
  assert.deepEqual([summary.status, summary.equity, summary.realizedPnl], ['closed', '10100', '100']);
  const stats = (await get<VaultStats>('/v1/vault')).body;
  const capitalBalance = (await connection.getTokenAccountBalance(capitalVaultAddress())).value.uiAmountString;
  assert.deepEqual([stats.unallocated, stats.allocatedPrincipal, stats.capitalUsdc, stats.fundedAccounts, stats.totals.payoutsPaid, stats.totals.profitToVault],
    [capitalBalance, '0', capitalBalance, 0, '80', '20']);
  assert.deepEqual(stats.ledger.map((l) => [l.event, l.amountUsd]).reverse(), [
    ['Capital deposited', '1000'], ['Evaluation fee', '79'], ['Principal allocated', '500'], ['Profit share received', '20'], ['Principal returned', '600'],
  ]);
  assert.equal(stats.series.at(-1)!.capitalUsdc, capitalBalance, 'the ledger walk ends at the real balance');

  // ---- verify
  const verify = async (q: string) => (await get<VerifyResult>(`/v1/verify?q=${q}`)).body;
  const f = await verify(fundedAddress.toBase58());
  assert.equal(f.kind, 'funded');
  assert.ok(f.items.some((i) => i.title === 'Payout paid' && i.signature === paid.paySignature));
  assert.ok(f.items.some((i) => i.title === 'Funded account closed'));
  assert.ok(f.items.every((i) => i.explorerUrl === undefined), 'no explorer links for a local cluster');
  const e = await verify(evaluation.toBase58());
  assert.deepEqual(e.items.map((i) => i.title).slice(0, 3), ['Evaluation purchased', 'Evaluation account', 'Evaluation passed']);
  assert.match(e.items[2]!.description, new RegExp(tradesRoot));
  assert.deepEqual(e.items[2]!.tradesRoot, { root: tradesRoot, evaluation: evaluation.toBase58() }, 'the app recomputes the root from the linked fill list');
  assert.deepEqual((await verify(paid.paySignature!)).items.map((i) => i.title), ['Payout paid']);

  // ---- restart: transactions while the server is down are backfilled, none twice
  await server.stop();
  await send([await vault.buyEvaluation({ trader: latecomer.publicKey, tierId: TIERS.t10k.id, index: 0, feeUsdc: usdc(TIERS.t10k.fee), tierVersion: 1 })], [latecomer]);
  await send([await vault.depositCapital({ admin: admin.publicKey, amount: usdc('50') })], [admin]);
  server = await startServer();
  await until(async () => server.stub.created.find((c) => c.wallet === latecomer.publicKey.toBase58()), 30_000, 'backfilled purchase');
  const everything = (await connection.getSignaturesForAddress(PROPS_VAULT_PROGRAM_ID, { limit: 1000 }, 'confirmed'));
  await until(async () => (await t.db.select().from(indexerCursors))[0]?.signature === everything[0]!.signature, 30_000, 'cursor at the newest transaction');
  let expected = 0;
  for (const s of everything) {
    if (s.err) continue;
    const tx = await connection.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    expected += parseVaultEvents(vault, tx!).length;
  }
  const [{ n }] = await t.db.select({ n: count() }).from(programEvents) as [{ n: number }];
  assert.equal(n, expected, 'every event of every program transaction, exactly once');
  assert.equal((await t.db.select().from(vaultLedger)).length, 7);
  await server.stop();
});
