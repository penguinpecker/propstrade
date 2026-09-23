// Indexer + projections on a real Postgres, fed props_vault events encoded exactly as the program emits them, through
// a stand-in RPC that pages getSignaturesForAddress like a Solana node (newest first, `before` / `until`, 1,000 max).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, type ConfirmedSignatureInfo } from '@solana/web3.js';
import BN from 'bn.js';
import { eq, sql } from 'drizzle-orm';
import { PROPS_VAULT_PROGRAM_ID } from '@props/sdk';
import {
  accountEvents, accounts, equitySnapshots, evaluations, fundedAccounts, gmOrders, indexerCursors, payouts, programEvents, vaultLedger,
} from '../../../db/schema.ts';
import { createIndexer } from '../indexer.ts';
import { capitalSeries } from '../program.ts';
import type { Notice } from '../projector.ts';
import type { ChainReader } from '../reader.ts';
import { freshDb, offlineClient, programTx, silentLog, simStub } from './support.ts';

const client = offlineClient();
const key = () => Keypair.generate().publicKey;
const SOL_MARKET = new PublicKey('6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc');
const trader = key();
const evaluation = key();
const funded = key();
const owner = key();
const order = key();
const stopLoss = key();
const payout1 = key();
const payout2 = key();
const closeAll = key();
let clock = Math.floor(Date.now() / 1000) - 600;
const ts = () => new BN(clock++); // onchain clock: one second per event
const USD = new BN(10).pow(new BN(20));
const unitPrice = (usd: number) => new BN(usd).mul(new BN(10).pow(new BN(11))); // SOL index token: 9 decimals
const pauses = { newEvaluations: false, trading: false, payouts: false };

interface FakeTx { signature: string; slot: number; err: object | null; tx: ReturnType<typeof programTx>; fee: number }

/** A Solana node's view of the program's transactions, oldest first. */
function fakeRpc(txs: FakeTx[]) {
  const listeners: (() => void)[] = [];
  return {
    listeners,
    async getSignaturesForAddress(_a: PublicKey, o: { before?: string; until?: string; limit?: number }): Promise<ConfirmedSignatureInfo[]> {
      const newestFirst = [...txs].reverse();
      let start = o.before ? newestFirst.findIndex((t) => t.signature === o.before) + 1 : 0;
      const stop = o.until ? newestFirst.findIndex((t) => t.signature === o.until) : -1;
      const end = stop === -1 ? newestFirst.length : stop;
      start = Math.min(start, end);
      return newestFirst.slice(start, Math.min(end, start + (o.limit ?? 1000))).map((t) => ({
        signature: t.signature, slot: t.slot, err: t.err, memo: null, blockTime: Math.floor(Date.now() / 1000),
      }));
    },
    async getTransaction(signature: string) {
      const t = txs.find((x) => x.signature === signature)!;
      return { slot: t.slot, blockTime: Math.floor(Date.now() / 1000), transaction: t.tx.transaction, meta: { ...t.tx.meta, err: t.err, fee: t.fee } } as never;
    },
    onLogs(_p: PublicKey, cb: () => void) {
      listeners.push(cb);
      return listeners.length;
    },
    async removeOnLogsListener() {},
  };
}

const reader: ChainReader = {
  async evaluation() {
    return {
      index: 0, tierVersion: 3,
      terms: { tierId: 1, sizeUsd: '10000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000, termsHash: 'ab'.repeat(32) },
    };
  },
  async market(marketToken) {
    return { marketToken, symbol: 'SOL', indexToken: 'So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH', decimals: 9 };
  },
};

let t: Awaited<ReturnType<typeof freshDb>>;
before(async () => {
  t = await freshDb('chain_indexer');
});
after(async () => {
  await t.sql.end();
});

test('indexes every props_vault event once, in chain order, into the chain tables', async () => {
  const txs: FakeTx[] = [];
  let slot = 1000;
  const tx = (events: [string, Record<string, unknown>][], fee = 5000) => {
    const signature = Keypair.generate().publicKey.toBase58() + 'x'; // unique, signature-shaped
    txs.push({ signature, slot: slot++, err: null, tx: programTx(client, events), fee });
    return signature;
  };
  tx([['configChanged', { change: { initialized: {} }, subject: key(), paused: pauses, ts: ts() }], ['capitalDeposited', { amount: new BN(1_000_000_000), capitalVaultBalance: new BN(1_000_000_000), ts: ts() }]]);
  // 2,500 failed transactions: they carry no events but must be paged through and passed.
  for (let i = 0; i < 2_500; i++) txs.push({ signature: `failed${i}`, slot: slot++, err: { InstructionError: [0, 'Custom'] }, tx: programTx(client, []), fee: 5000 });
  const purchase = tx([['evaluationPurchased', { evaluation, trader, tierId: 1, tierVersion: 3, feePaid: new BN(79_000_000), ts: ts() }]]);
  const result = tx([['evaluationResolved', { evaluation, trader, passed: true, finalEquity: new BN(10_800_000_000), tradesRoot: Array(32).fill(7), ts: ts() }]]);
  const activation = tx([['fundedActivated', { funded, evaluation, trader, owner, principal: new BN(500_000_000), ownerLamports: new BN(250_000_000), ts: ts() }]]);
  tx([['orderRequested', {
    funded, order, marketToken: SOL_MARKET, isLong: true, orderType: { market: {} }, sizeDeltaUsd: USD.muln(500), collateral: new BN(50_000_000),
    triggerPrice: new BN(0), acceptablePrice: unitPrice(150), by: trader, ts: ts(),
  }]]);
  const U128_MAX = new BN(2).pow(new BN(128)).subn(1);
  tx([['orderRequested', {
    funded, order: closeAll, marketToken: SOL_MARKET, isLong: true, orderType: { close: {} }, sizeDeltaUsd: U128_MAX, collateral: new BN(0),
    triggerPrice: new BN(0), acceptablePrice: U128_MAX, by: trader, ts: ts(),
  }]]);
  tx([['protectionSet', { funded, order: stopLoss, marketToken: SOL_MARKET, isLong: true, orderType: { stopLoss: {} }, sizeDeltaUsd: USD.muln(500), triggerPrice: unitPrice(100), ts: ts() }]]);
  tx([['orderUpdated', { funded, order: stopLoss, sizeDeltaUsd: null, triggerPrice: unitPrice(105), acceptablePrice: null, ts: ts() }]]);
  const cancel = tx([['orderCancelled', { funded, order, by: trader, ts: ts() }]]);
  tx([['synced', { funded, slots: [], ordersDropped: [stopLoss], ts: ts() }]]);
  tx([['payoutRequested', { funded, request: payout1, seq: 0, balance: new BN(600_000_000), profit: new BN(100_000_000), traderAmount: new BN(80_000_000), vaultAmount: new BN(20_000_000), ts: ts() }]]);
  const paid = tx([['payoutPaid', { funded, request: payout1, trader, traderAmount: new BN(80_000_000), vaultAmount: new BN(20_000_000), ts: ts() }]], 15_000);
  tx([['payoutRequested', { funded, request: payout2, seq: 1, balance: new BN(560_000_000), profit: new BN(60_000_000), traderAmount: new BN(48_000_000), vaultAmount: new BN(12_000_000), ts: ts() }]]);
  tx([['payoutRejected', { funded, request: payout2, reasonCode: 2, ts: ts() }]]);
  tx([['accountRestricted', { funded, restricted: true, ts: ts() }], ['accountClosed', { funded, principal: new BN(500_000_000), usdcReturned: new BN(480_000_000), lamportsReturned: new BN(1), ts: ts() }]]);
  const last = txs.at(-1)!.signature;

  const rpc = fakeRpc(txs);
  const { sim, created } = simStub();
  const notices: Notice[] = [];
  const changed: string[][] = [];
  const indexer = createIndexer({
    db: t.db, rpc: rpc as never, client, programId: PROPS_VAULT_PROGRAM_ID, log: silentLog, reader, sim,
    notify: async (n) => void notices.push(n), onApplied: (events) => changed.push(events.map((e) => e.name)),
  });

  assert.equal(await indexer.catchUp(), txs.length);
  assert.equal(await indexer.catchUp(), 0, 'nothing new');
  const [cursor] = await t.db.select().from(indexerCursors);
  assert.deepEqual([cursor!.program, cursor!.signature], [PROPS_VAULT_PROGRAM_ID.toBase58(), last]);
  const events = await t.db.select().from(programEvents).orderBy(programEvents.slot, programEvents.eventIndex);
  assert.equal(events.length, 17);
  assert.deepEqual(events.slice(0, 3).map((e) => e.name), ['configChanged', 'capitalDeposited', 'evaluationPurchased']);
  assert.deepEqual(events[2]!.data, { evaluation: evaluation.toBase58(), trader: trader.toBase58(), tierId: 1, tierVersion: 3, feePaid: '79000000', ts: (events[2]!.data as { ts: string }).ts });

  assert.deepEqual(created.map((c) => [c.evaluation, c.wallet, c.terms.sizeUsd, c.signature]), [[evaluation.toBase58(), trader.toBase58(), '10000', purchase]]);
  const [e] = await t.db.select().from(evaluations);
  assert.deepEqual([e!.status, e!.finalEquity, e!.tradesRoot, e!.resultSignature, e!.feePaid], ['funded', '10800.000000', '07'.repeat(32), result, '79.000000']);

  const [f] = await t.db.select().from(fundedAccounts);
  assert.deepEqual([f!.status, f!.principal, f!.payoutsPaid, f!.payoutSeq, f!.activationSignature, f!.ownerPda], ['closed', '500.000000', '80.000000', 2, activation, owner.toBase58()]);
  assert.ok(f!.lastSyncAt && f!.closedAt);
  const [a] = await t.db.select().from(accounts);
  assert.deepEqual([a!.id, a!.stage, a!.status, a!.label, a!.lossAllowanceUsd, a!.termsVersion], [funded.toBase58(), 'funded', 'closed', 'Funded 10K', '500.000000', 3]);

  const orders = Object.fromEntries((await t.db.select().from(gmOrders)).map((o) => [o.address, o]));
  const market = orders[order.toBase58()]!;
  assert.deepEqual(
    [market.symbol, market.kind, market.isIncrease, market.sizeUsd, market.collateralUsd, market.acceptablePrice, market.status, market.closeSignature],
    ['SOL', 'Market', true, '500.000000', '50.000000', '150.000000000000000000', 'canceled', cancel],
  );
  const close = orders[closeAll.toBase58()]!;
  assert.deepEqual(
    [close.kind, close.isIncrease, close.sizeUsd, close.collateralUsd, close.acceptablePrice, close.statusDetail],
    ['Market', false, '0.000000', null, null, 'Closes the whole position'],
    'close-all: no size to show before any position snapshot, and a u128::MAX bound is "no limit"',
  );
  const sl = orders[stopLoss.toBase58()]!;
  assert.deepEqual([sl.kind, sl.isIncrease, sl.triggerPrice, sl.status], ['StopLoss', false, '105.000000000000000000', 'awaiting_price']);
  assert.ok(sl.closedAt, 'a sync that dropped the order marks it finished');

  const p = Object.fromEntries((await t.db.select().from(payouts)).map((x) => [x.address, x]));
  assert.deepEqual([p[payout1.toBase58()]!.status, p[payout1.toBase58()]!.paySignature, p[payout1.toBase58()]!.networkFeeSol], ['paid', paid, '0.000015000']);
  assert.deepEqual([p[payout2.toBase58()]!.status, p[payout2.toBase58()]!.reasonCode, p[payout2.toBase58()]!.destination], ['rejected', 2, trader.toBase58()]);

  const ledger = await t.db.select().from(vaultLedger).orderBy(vaultLedger.slot);
  assert.deepEqual(ledger.map((l) => [l.event, l.direction, l.amountUsd]), [
    ['Capital deposited', 'in', '1000.000000'], ['Evaluation fee', 'in', '79.000000'], ['Principal allocated', 'out', '500.000000'],
    ['Profit share received', 'in', '20.000000'], ['Principal returned', 'in', '480.000000'],
  ]);
  // Total capital: 1000 deposited; allocating 500 moves it, the 20 share adds, closing with 480 of 500 loses 20.
  assert.deepEqual((await capitalSeries(t.db)).map((s) => s.capitalUsdc), ['1000', '1000', '1020', '1000']);
  assert.deepEqual((await t.db.select().from(equitySnapshots).orderBy(equitySnapshots.ts)).map((s) => s.equity).sort(), ['10000.000000', '9980.000000'].sort());

  const activity = await t.db.select({ type: accountEvents.type, title: accountEvents.title }).from(accountEvents);
  assert.deepEqual(activity.map((x) => x.title).sort(), [
    'Account closed', 'Account restricted', 'Funded account activated', 'Long SOL close order placed', 'Long SOL market order placed', 'Long SOL order cancelled',
    'Long SOL order updated', 'Payout paid', 'Payout rejected', 'Payout requested', 'Payout requested', 'Stop-loss set on Long SOL',
  ].sort());
  assert.deepEqual(notices.map((n) => n.title), ['Funded 10K is active', 'Payout requested', 'Payout paid', 'Payout requested', 'Payout rejected', 'Account restricted']);
  assert.ok(notices.every((n) => n.wallet === trader.toBase58()));
  assert.ok(changed.some((names) => names.includes('fundedActivated')));

  // A lost cursor (or a duplicate delivery) replays everything: nothing is applied twice.
  await t.db.delete(indexerCursors);
  const counts = async () => (await t.db.execute<{ n: string }>(sql`select
    (select count(*) from program_events) + (select count(*) from vault_ledger) * 100 + (select count(*) from account_events) * 10000 as n`))[0]!.n;
  const before = await counts();
  assert.equal(await indexer.catchUp(), txs.length);
  assert.equal(await counts(), before);
  const [again] = await t.db.select().from(fundedAccounts).where(eq(fundedAccounts.address, funded.toBase58()));
  assert.equal(again!.payoutsPaid, '80.000000');
});

test('a transaction that fails to project leaves the cursor before it, so it is retried', async () => {
  await t.db.delete(indexerCursors);
  const txs: FakeTx[] = [{
    signature: 'orphanOrder', slot: 99_999, err: null, fee: 5000,
    tx: programTx(client, [['orderCancelled', { funded: key(), order: key(), by: key(), ts: ts() }]]),
  }];
  const rpc = fakeRpc(txs);
  const indexer = createIndexer({
    db: t.db, rpc: rpc as never, client, programId: new PublicKey(key()), log: silentLog, reader, notify: async () => {}, onApplied() {},
  });
  await assert.rejects(indexer.catchUp(), /unknown funded account/);
  assert.equal((await t.db.select().from(programEvents).where(eq(programEvents.signature, 'orphanOrder'))).length, 0, 'rolled back');
  assert.equal((await t.db.select().from(indexerCursors)).length, 0);
});
