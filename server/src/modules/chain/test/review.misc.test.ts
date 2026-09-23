// Review findings: regression tests for each (they failed before the fixes).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import { eq, sql } from 'drizzle-orm';
import type { VaultStats } from '@props/shared';
import { PROPS_VAULT_PROGRAM_ID, PropsVaultClient, USDC_MINT, capitalVaultAddress, configPda, feeVaultPda } from '@props/sdk';
import type { OrderRemoval } from '@props/gmtrade';
import { accountEvents, accounts, chainJobs, evaluations, fundedAccounts, gmOrders, programEvents } from '../../../db/schema.ts';
import { createJobs, enqueue } from '../jobs.ts';
import { createProgramReader } from '../program.ts';
import type { VaultEvent } from '../events.ts';
import type { Notice } from '../projector.ts';
import { createVenue } from '../venue.ts';
import { createVerify } from '../verify.ts';
import { encodeAccount, freshDb, offlineClient, programTx, silentLog, simStub, sealer } from './support.ts';

let t: Awaited<ReturnType<typeof freshDb>>;
before(async () => {
  t = await freshDb('chain_review_misc');
});
after(async () => {
  await t.sql.end();
});

test('an evaluation result is not stranded by an RPC outage, and one that failed for good can be queued again', async () => {
  const client = offlineClient();
  const evaluation = Keypair.generate().publicKey;
  let rpcDown = true;
  let onchain: 'missing' | 'passed' = 'passed';
  const rpc = {
    async getAccountInfo(k: PublicKey) {
      if (rpcDown) throw new Error('fetch failed');
      if (!k.equals(evaluation) || onchain === 'missing') return null;
      return { owner: PROPS_VAULT_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0, data: evaluationData(client, 'passed') };
    },
  };
  const { sim, recorded } = simStub();
  const jobs = createJobs({ db: t.db, rpc: rpc as never, client: new PropsVaultClient(rpc as never), sim, log: silentLog, sealer, keys: { risk: Keypair.generate() } });
  const result = { evaluation: evaluation.toBase58(), wallet: Keypair.generate().publicKey.toBase58(), passed: true, finalEquityUsd: '10800', tradesRoot: '07'.repeat(32), resolvedAt: Date.now() };
  await enqueue(t.db, sealer, 'record_evaluation_result', result.evaluation, result);
  const runAll = async (times: number) => {
    for (let i = 0; i < times; i++) {
      await jobs.runDue();
      await t.db.update(chainJobs).set({ updatedAt: sql`now() - interval '1 hour'` }); // skip the retry backoff
    }
  };
  const job = async () => (await t.db.select().from(chainJobs).where(eq(chainJobs.subject, result.evaluation)))[0]!;

  // Fifteen attempts span well over the ~13 minutes that used to fail the job for good.
  await runAll(15);
  const during = await job();
  console.log(JSON.stringify({ status: during.status, attempts: during.attempts, lastError: during.lastError }));
  assert.deepEqual([during.status, during.attempts, during.rejections, during.lastError], ['queued', 15, 0, 'fetch failed'], 'an outage never fails the job');

  // The RPC is back; the result was recorded onchain meanwhile (and indexed): confirmed with that transaction.
  rpcDown = false;
  await t.db.insert(programEvents).values({ signature: 'recordedSig', eventIndex: 0, slot: 5, name: 'evaluationResolved', data: { evaluation: result.evaluation, passed: true } });
  await runAll(1);
  assert.deepEqual([(await job()).status, (await job()).signature, recorded], ['confirmed', 'recordedSig', [[result.evaluation, 'recordedSig']]]);

  // A result the chain keeps refusing (here: its evaluation cannot be found) fails for good after 10 refusals ...
  const other = { ...result, evaluation: Keypair.generate().publicKey.toBase58() };
  onchain = 'missing';
  await enqueue(t.db, sealer, 'record_evaluation_result', other.evaluation, other);
  const refused = async () => (await t.db.select().from(chainJobs).where(eq(chainJobs.subject, other.evaluation)))[0]!;
  await runAll(9);
  assert.equal((await refused()).status, 'queued', 'refused 9 times: still retried');
  await runAll(1);
  assert.deepEqual([(await refused()).status, (await refused()).lastError], ['failed', 'Evaluation account not found']);
  // ... and the same result delivered again puts it back in the queue.
  assert.equal(await enqueue(t.db, sealer, 'record_evaluation_result', other.evaluation, other), true);
  assert.deepEqual([(await refused()).status, (await refused()).attempts, (await refused()).rejections], ['queued', 0, 0]);
  assert.equal(await enqueue(t.db, sealer, 'record_evaluation_result', other.evaluation, other), false, 'a pending job is not queued twice');
});

test('verify: a failed props_vault transaction is not shown as "confirmed, waiting for the indexer"', async () => {
  const id = PROPS_VAULT_PROGRAM_ID.toBase58();
  const verify = createVerify({
    db: t.db, programId: PROPS_VAULT_PROGRAM_ID, cluster: 'localnet',
    rpc: {
      async getTransaction() {
        const { transaction, meta } = programTx(offlineClient(), []);
        return {
          slot: 7, blockTime: Math.floor(Date.now() / 1000), transaction,
          meta: { ...meta, err: { InstructionError: [0, { Custom: 6003 }] }, logMessages: [`Program ${id} invoke [1]`, `Program ${id} failed: custom program error: 0x1773`] },
        } as never;
      },
      async getAccountInfo() {
        return null;
      },
    },
  });
  const r = await verify(bs58.encode(Buffer.alloc(64, 9)));
  console.log(JSON.stringify(r.items.map((i) => [i.state, i.description])));
  assert.ok(r.items.every((i) => i.state !== 'indexing' && !/^Confirmed/.test(i.description)), 'a failed transaction is reported as failed');
});

test('vault: total capital right after an activation matches the chain (balance and allocated principal read together)', async () => {
  const client = offlineClient();
  const chain = { capital: 1_000_000_000n, allocated: 0n };
  const configData = () => encodeAccount(client, 'config', {
    admin: PublicKey.default, pendingAdmin: null, riskAuthorities: [], kycAuthority: PublicKey.default, usdcMint: USDC_MINT,
    gmtradeProgram: PublicKey.default, gmtradeStore: PublicKey.default, capitalVault: capitalVaultAddress(), traderShareBps: 8000,
    minPayout: new BN(50_000_000), ownerSolTarget: new BN(1), ownerSolMin: new BN(1), maxDailyPrincipal: new BN(1), principalWindowStart: new BN(0), principalInWindow: new BN(0), paused: { newEvaluations: false, trading: false, payouts: false },
    feesCollected: new BN(0), allocatedPrincipal: new BN(chain.allocated.toString()), payoutsPaid: new BN(0), profitToVault: new BN(0),
    evaluationsSold: new BN(1), fundedActivated: new BN(chain.allocated ? 1 : 0), fundedActive: chain.allocated ? 1 : 0,
    bump: 255, vaultBump: 255, feeVaultBump: 255, solTreasuryBump: 255,
  });
  const token = (amount: bigint) => {
    const data = Buffer.alloc(165);
    data.writeBigUInt64LE(amount, 64);
    return { owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data, lamports: 1, executable: false, rentEpoch: 0 };
  };
  const rpc = {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      return keys.map((k) => (k.equals(configPda()) ? { owner: PROPS_VAULT_PROGRAM_ID, data: configData(), lamports: 1, executable: false, rentEpoch: 0 }
        : k.equals(capitalVaultAddress()) ? token(chain.capital) : k.equals(feeVaultPda()) ? token(0n) : null));
    },
  };
  (client.program.account.tier as unknown as { all: () => Promise<[]> }).all = async () => [];
  let configReads = 0;
  client.fetchConfig = async () => {
    configReads++;
    return client.decode('config', configData());
  };
  const reader = createProgramReader({ db: t.db, rpc: rpc as never, client, programId: PROPS_VAULT_PROGRAM_ID, cluster: 'localnet' });
  await reader.state(); // the /v1/config cache is warm, as it is under traffic

  assert.equal((await reader.vault()).capitalUsdc, '1000');
  // activate_funded: 500 USDC principal moves capital vault → owner ATA and Config.allocated_principal += 500, atomically.
  chain.capital = 500_000_000n;
  chain.allocated = 500_000_000n;
  const v: VaultStats = await reader.vault();
  console.log(JSON.stringify({ capitalUsdc: v.capitalUsdc, allocatedPrincipal: v.allocatedPrincipal, unallocated: v.unallocated }));
  assert.deepEqual([v.capitalUsdc, v.allocatedPrincipal, v.unallocated, v.fundedAccounts], ['1000', '500', '500', 1]);
  assert.equal(configReads, 1, '/v1/vault does not go through the cached Config');
});

test('config cache: only an indexed settings change drops it, and only a tier change refetches every tier', async () => {
  const client = offlineClient();
  const reads = { config: 0, tiers: 0 };
  client.fetchConfig = (async () => {
    reads.config++;
    return {};
  }) as never;
  (client.program.account.tier as unknown as { all: () => Promise<[]> }).all = async () => {
    reads.tiers++;
    return [];
  };
  const reader = createProgramReader({ db: t.db, rpc: {} as never, client, programId: PROPS_VAULT_PROGRAM_ID, cluster: 'localnet' });
  const event = <N extends VaultEvent['name']>(name: N, data: object) => ({ name, data }) as VaultEvent;
  await reader.state();
  reader.changed([event('orderRequested', {}), event('synced', {}), event('fundedActivated', {}), event('ownerToppedUp', {})]);
  await reader.state();
  assert.deepEqual(reads, { config: 1, tiers: 1 }, 'trading and keeper activity leave the cache alone');
  reader.changed([event('configChanged', { change: 'pauses' })]);
  await reader.state();
  assert.deepEqual(reads, { config: 2, tiers: 1 });
  reader.changed([event('configChanged', { change: 'tier' })]);
  await reader.state();
  assert.deepEqual(reads, { config: 3, tiers: 2 });
});

test('order status: an order the sync dropped before the venue tick still gets its GMTrade outcome', async () => {
  const k = () => Keypair.generate().publicKey.toBase58();
  const [evaluation, funded, order] = [k(), k(), k()];
  await t.db.insert(evaluations).values({
    address: evaluation, trader: k(), evalIndex: 0, tierId: 1, sizeUsd: '10000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000,
    traderShareBps: 8000, termsHash: 'ab'.repeat(32), feePaid: '79', status: 'funded', purchaseSignature: 'p', createdAt: new Date(), updatedSlot: 1,
  });
  const trader = k();
  await t.db.insert(fundedAccounts).values({
    address: funded, evaluation, trader, ownerPda: k(), principal: '500', traderShareBps: 8000, status: 'active', activationSignature: 'a',
    createdAt: new Date(), updatedSlot: 2,
  });
  await t.db.insert(accounts).values({
    id: funded, wallet: trader, stage: 'funded', status: 'active', label: 'Funded 10K', tierId: 1, evaluation, funded, sizeUsd: '10000',
    lossAllowanceUsd: '500', maxExposureBps: 10_000, traderShareBps: 8000, termsHash: 'ab'.repeat(32), termsVersion: 1, activatedAt: new Date(),
  });
  // GMTrade could not execute the market order and closed it; the keeper's sync landed and was indexed first
  // (projector 'synced' → closedAt set, status untouched), before the venue loop's next 5 s tick.
  await t.db.insert(gmOrders).values({
    address: order, fundedAccount: funded, marketToken: k(), symbol: 'SOL', side: 'Long', kind: 'Market', isIncrease: true, sizeUsd: '100',
    collateralUsd: '10', acceptablePrice: '200', status: 'awaiting_execution', createSignature: 'c', createdAt: new Date(), closedAt: new Date(),
  });
  const removals: OrderRemoval[] = [{ id: '1', order, kind: 'MarketIncrease', state: 'Cancelled', reason: 'acceptable price exceeded', ts: Date.now(), slot: 1 }];
  const venue = createVenue({
    db: t.db, rpc: { getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({ context: { slot: 1 }, value: keys.map(() => null) }) } as never,
    client: new PropsVaultClient({} as never), reader: { evaluation: async () => { throw new Error('unused'); }, market: async () => { throw new Error('unused'); } },
    gm: { trades: async () => [], signatures: async () => new Map(), removals: async (o) => removals.filter((r) => o.includes(r.order)) },
    log: silentLog, notify: async (n) => void notices.push(n),
  });
  const notices: Notice[] = [];
  await venue.syncOrders(funded);
  const [row] = await t.db.select().from(gmOrders).where(eq(gmOrders.address, order));
  console.log(JSON.stringify({ status: row!.status, statusDetail: row!.statusDetail }));
  assert.equal(row!.status, 'canceled');
  // The trader learns GMTrade cancelled it (it did not just vanish from open orders), once.
  await venue.syncOrders(funded);
  const activity = await t.db.select().from(accountEvents).where(eq(accountEvents.accountId, funded));
  assert.deepEqual(activity.map((a) => [a.type, a.title, a.detail]), [
    ['cancel', 'Long SOL order cancelled by GMTrade', 'GMTrade could not execute this order (acceptable price exceeded). Its collateral and deposit returned to the account.'],
  ]);
  assert.deepEqual(notices.map((n) => [n.wallet, n.title]), [[trader, 'Long SOL order cancelled by GMTrade']]);
});

function evaluationData(client: PropsVaultClient, status: 'active' | 'passed'): Buffer {
  return encodeAccount(client, 'evaluation', {
    trader: PublicKey.default, index: 0, tierId: 1,
    terms: { sizeUsd: new BN(10_000_000_000), profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000, termsHash: Array(32).fill(1), tierVersion: 1 },
    feePaid: new BN(79_000_000), status: { [status]: {} }, createdAt: new BN(0), resolvedAt: new BN(0), finalEquity: new BN(0),
    tradesRoot: Array(32).fill(0), bump: 255,
  });
}
