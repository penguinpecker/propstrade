// Props order fees end to end on the program itself (docs/design/order-fee.md §9): the props_vault binary under test
// (PROPS_VAULT_SO) and the mainnet GMTrade binary in LiteSVM (tests/program/src/env.ts), served to the real chain
// module (indexer, venue loop, job executor) and the real keeper through a node stand-in (litesvm-rpc.ts), on a real
// Postgres, at a nonzero rate ($0.50 + 2 bps). GMTrade's keepers are emulated as the program suite does (an order they
// execute or cancel is gone; a fill writes the Position), and GMTrade's indexer is scripted with what they did. A local
// validator cannot make an order leave the book at all (only GMTrade's keepers can), so fees never become due there.
//
// Covered: an executed open is charged its fee; a take profit that executed is charged on what it closed and the stop
// loss the exchange cancelled is waived; a payout request fails while fees are due and is approved and paid once they
// are settled (its review counting the fees charged); a breached account with fees due and no USDC is closed with its
// settlement in the same transaction. Runs where litesvm 1.4 is installed (`npm ci`; this checkout: the scratch hook).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { eq, sql } from 'drizzle-orm';
import type { OrderRemoval, TradeEvent } from '@props/gmtrade';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  CLOSE_ALL, POSITION_LAYOUT, PROPS_VAULT_IDL, PROPS_VAULT_PROGRAM_ID, PropsVaultClient, USDC_MINT, buildTransaction, capitalVaultAddress, enumName,
  feeVaultPda, fromMicro, gmOrderEscrow, gmPositionPda, orderFee,
} from '@props/sdk';
import {
  fundedAccounts, gmOrders, indexerCursors, orderFeeSettlements, orderFees, payouts, programEvents, referralRewards, users,
} from '../../../db/schema.ts';
import { createSealer } from '../../../lib/integrity.ts';
import { recordSettlement } from '../../chain/fees.ts';
import { createFundedProvider } from '../../chain/funded.ts';
import { createIndexer } from '../../chain/indexer.ts';
import { createJobs } from '../../chain/jobs.ts';
import { createProgramReader } from '../../chain/program.ts';
import { project } from '../../chain/projector.ts';
import { createReader, type ChainReader } from '../../chain/reader.ts';
import { createVenue, type GmIndexer } from '../../chain/venue.ts';
import { freshDb, silentLog, until } from '../../chain/test/support.ts';
import type { Alerts } from '../alerts.ts';
import { createKeeper } from '../keeper.ts';
import { liteSvmRpc } from './litesvm-rpc.ts';

/** litesvm 1.4 (the version tests/program pins): 0.8 lacks the runtime features env.ts requires. */
const litesvm = (createRequire(import.meta.url)('litesvm/package.json') as { version: string }).version;
const skip = litesvm.startsWith('0.') ? `litesvm ${litesvm} is installed, not the pinned 1.4 (npm ci installs it)` : false;

const USD = 10n ** 20n;
const RATE = { feeUsdc: 500_000n, feeBps: 2 };
const CAP = 10_000n * USD; // the 10K tier's exposure cap
const SOL_PRICE = 150n * 10n ** 11n; // SOL unit price (9 decimals)
const HIGH = 10n ** 30n;

let t: Awaited<ReturnType<typeof freshDb>>;
before(async () => {
  if (skip) return;
  t = await freshDb('keeper_fees_e2e');
});
after(async () => {
  await t?.sql.end();
});

test('Props order fees on the program: charged when executed, waived when not, settled before a payout and with a closure', { skip, timeout: 300_000 }, async () => {
  const { Env, MARKETS, usdc } = await import('../../../../../tests/program/src/env.ts');
  const env = new Env();
  const rpc = liteSvmRpc(env);
  await env.setUpVault();
  env.ok(await env.vault.setOrderFee({ admin: env.admin.publicKey, feeUsdc: RATE.feeUsdc, feeBps: RATE.feeBps }), [env.admin]);
  const alice = await env.activeFunded();
  const bob = await env.activeFunded();
  const sol = { marketToken: MARKETS.SOL.token.toBase58(), symbol: 'SOL', indexToken: 'So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH', decimals: 9 };

  // ---- the server: indexer, venue loop, job executor and keeper over the same node, GMTrade's indexer scripted
  const client = new PropsVaultClient(rpc as never);
  const chainReader = createReader(client, rpc as never);
  const reader: ChainReader = { evaluation: chainReader.evaluation, market: async () => sol };
  const program = createProgramReader({ db: t.db, rpc: rpc as never, client, programId: PROPS_VAULT_PROGRAM_ID, cluster: 'localnet', serverRate: { feeUsdc: 0n, feeBps: 0, source: 'server' } });
  const indexer = createIndexer({
    db: t.db, rpc: rpc as never, client, programId: PROPS_VAULT_PROGRAM_ID, log: silentLog, reader, notify: async () => {}, onApplied: (events) => program.changed(events),
  });
  const fills = new Map<string, TradeEvent[]>();
  const removals: OrderRemoval[] = [];
  const gm: GmIndexer = {
    trades: async (owner, afterId) => (fills.get(owner) ?? []).filter((e) => !afterId || e.id > afterId),
    signatures: async (ids) => new Map(ids.map((id) => [id, `fill-${id}`])),
    removals: async (orders) => removals.filter((r) => orders.includes(r.order)),
  };
  const venue = createVenue({ db: t.db, rpc: rpc as never, client, reader, gm, log: silentLog, notify: async () => {} });
  const sealer = createSealer(randomBytes(32).toString('hex'));
  const jobs = createJobs({ db: t.db, rpc: rpc as never, client, keys: { risk: env.risk }, sealer, log: silentLog });
  const raised: string[] = [];
  let tickEnded = () => {};
  const alerts: Alerts = {
    send: (key, level) => void raised.push(`${level} ${key}`),
    heartbeat: () => tickEnded(),
  };
  const keeper = createKeeper({ db: t.db, rpc: rpc as never, client, reader, risk: env.risk, sealer, log: silentLog, notify: async () => {}, alerts });
  const tick = async () => {
    const stop = new AbortController();
    tickEnded = () => stop.abort();
    await keeper.run(stop.signal, async () => true, 10);
  };
  const traders = [alice, bob];
  /** The indexer, then the venue loop for every account (GMTrade's outcomes and fills), then the indexer again. */
  const serve = async () => {
    await indexer.catchUp();
    for (const f of traders) await venue.tick(f.funded.toBase58(), f.owner.toBase58(), f.trader.publicKey.toBase58(), true);
    await indexer.catchUp();
  };
  const round = async () => {
    await tick();
    await serve();
  };
  const onchain = (f: typeof alice) => env.account('fundedAccount', f.funded);
  const fees = (f: typeof alice) => ({ due: fromMicro(BigInt(onchain(f).orderFeesDue.toString())), paid: fromMicro(BigInt(onchain(f).orderFeesPaid.toString())), settlements: Number(onchain(f).orderFeeSettlements.toString()) });
  const rowsOf = async (f: typeof alice) => Object.fromEntries((await t.db.select().from(orderFees).where(eq(orderFees.fundedAccount, f.funded.toBase58()))).map((r) => [r.order, r]));
  await serve();
  assert.deepEqual((await program.appConfig()).orderFeeUsd, '0.5');
  assert.deepEqual(await program.orderFeeRate(), { ...RATE, source: 'program' }, 'every stage reads the program\'s rate once it is live');

  // ---- GMTrade's side: the fills its indexer reports, by the owner PDA
  let fillSeq = 0;
  const fill = (f: typeof alice, p: { order: PublicKey; before: bigint; after: bigint; collateral: bigint; pnl?: bigint; liquidation?: boolean }) => {
    const owner = f.owner.toBase58();
    const id = `${String(900_000_000 + ++fillSeq).padStart(12, '0')}-FEEZZ-000001-000000-000001`;
    const price = { min: SOL_PRICE, max: SOL_PRICE };
    const usdcPrice = { min: 10n ** 14n, max: 10n ** 14n };
    const e: TradeEvent = {
      id, ts: Date.now(), slot: 1, marketToken: sol.marketToken, user: owner, position: gmPositionPda(f.owner, MARKETS.SOL.token, true).toBase58(),
      order: p.order.toBase58(), isLong: true, isCollateralLong: false, isIncrease: p.after > p.before, isLiquidation: !!p.liquidation,
      executionPrice: SOL_PRICE, priceImpactValue: 0n,
      before: { sizeInUsd: p.before, sizeInTokens: 0n, collateralAmount: 0n }, after: { sizeInUsd: p.after, sizeInTokens: p.after / SOL_PRICE, collateralAmount: p.collateral },
      pnl: p.pnl ?? 0n, fees: { order: 0n, liquidation: p.liquidation ? 1n : 0n, borrowing: 0n, funding: 0n }, prices: { index: price, long: usdcPrice, short: usdcPrice },
      outputAmount: 0n, secondaryOutputAmount: 0n,
    };
    fills.set(owner, [...(fills.get(owner) ?? []), e]);
  };
  /** A fill as GMTrade's keeper leaves the Position: size, collateral and the tokens at the SOL price. */
  const filled = (p: PublicKey, sizeUsd: bigint, collateral: bigint) => {
    env.setPosition(p, sizeUsd, collateral);
    const a = env.svm.getAccount(p)!;
    const data = Buffer.from(a.data);
    const tokens = sizeUsd / SOL_PRICE;
    data.writeBigUInt64LE(tokens & ((1n << 64n) - 1n), POSITION_LAYOUT.sizeInTokens);
    data.writeBigUInt64LE(tokens >> 64n, POSITION_LAYOUT.sizeInTokens + 8);
    env.svm.setAccount(p, { ...a, data });
  };
  const removed = (order: PublicKey, state: 'Completed' | 'Cancelled') =>
    removals.push({ id: String(removals.length), order: order.toBase58(), kind: 'MarketIncrease', state, reason: state === 'Completed' ? 'executed' : 'price', ts: Date.now(), slot: 1 });

  // ---- Alice: a $10,000 long with a close-all take profit and stop loss, each passing the fee it will be assessed
  const fundedRef = (f: typeof alice) => env.funded(f.funded);
  const open = await env.vault.openPosition({
    trader: alice.trader.publicKey, funded: fundedRef(alice), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'market',
    collateral: usdc('400'), sizeDeltaUsd: 10_000n * USD, acceptablePrice: HIGH, maxFee: orderFee(RATE, 10_000n * USD),
  });
  env.ok(open.instruction, [alice.trader]);
  const protect = async (orderType: 'takeProfit' | 'stopLoss', trigger: bigint) => {
    const p = await env.vault.setProtection({
      trader: alice.trader.publicKey, funded: fundedRef(alice), marketToken: MARKETS.SOL.token, isLong: true, orderType, triggerPrice: trigger,
      sizeDeltaUsd: CLOSE_ALL, maxFee: orderFee(RATE, CLOSE_ALL, CAP),
    });
    env.ok(p.instruction, [alice.trader]);
    return p.order;
  };
  const tp = await protect('takeProfit', 160n * 10n ** 11n);
  const sl = await protect('stopLoss', 140n * 10n ** 11n);
  await serve();
  let rows = await rowsOf(alice);
  assert.deepEqual([open.order, tp, sl].map((o) => [rows[o.toBase58()]!.assessedUsd, rows[o.toBase58()]!.state]), [['2.500000', 'assessed'], ['2.500000', 'assessed'], ['2.500000', 'assessed']]);
  const provider = createFundedProvider({ db: t.db, venue, program });
  const summary = async (f: typeof alice) => (await provider.detail(f.trader.publicKey.toBase58(), f.funded.toBase58()))!;
  let s = await summary(alice);
  assert.deepEqual([s.availableMargin, s.platformFees], ['97.5', { dueUsd: '0', paidUsd: '0', heldUsd: '2.5' }], '100 USDC left, the open\'s fee held');
  assert.deepEqual(s.orders.map((o) => o.platformFeeUsd), ['2.5', '2.5', '2.5']);

  // ---- the exchange executes the open: the keeper syncs, and charges its fee once its outcome is known
  const position = gmPositionPda(alice.owner, MARKETS.SOL.token, true);
  env.executeOrder(open.order, gmOrderEscrow(open.order));
  filled(position, 10_000n * USD, usdc('400'));
  removed(open.order, 'Completed');
  fill(alice, { order: open.order, before: 0n, after: 10_000n * USD, collateral: usdc('400') });
  const feeVault = () => env.usdcBalance(feeVaultPda());
  const vaultBefore = feeVault();
  for (let i = 0; i < 4 && fees(alice).paid !== '2.5'; i++) await round();
  assert.deepEqual(fees(alice), { due: '0', paid: '2.5', settlements: 1 });
  assert.equal(feeVault() - vaultBefore, usdc('2.5'), 'the fee vault received it');
  assert.equal(env.usdcBalance(alice.ownerUsdc), usdc('97.5'));
  rows = await rowsOf(alice);
  assert.deepEqual([rows[open.order.toBase58()]!.state, rows[open.order.toBase58()]!.chargedUsd], ['due', '2.500000']);
  const [first] = await t.db.select().from(orderFeeSettlements).where(eq(orderFeeSettlements.fundedAccount, alice.funded.toBase58()));
  assert.deepEqual([first!.status, first!.sentBy, first!.chargeUsd, first!.waiveUsd], ['confirmed', 'keeper', '2.500000', '0.000000']);

  // ---- the take profit closes the whole $10,000 in profit; the exchange cancels the stop loss
  env.executeOrder(tp, gmOrderEscrow(tp));
  env.executeOrder(sl, gmOrderEscrow(sl));
  filled(position, 0n, 0n);
  env.setUsdcBalance(alice.ownerUsdc, env.usdcBalance(alice.ownerUsdc) + usdc('500')); // 400 collateral back + 100 profit
  removed(tp, 'Completed');
  removed(sl, 'Cancelled');
  fill(alice, { order: tp, before: 10_000n * USD, after: 0n, collateral: 0n, pnl: 100n * USD });
  await tick(); // the sync makes both fees due; the ledger has not seen it yet, so nothing is settled
  assert.deepEqual(fees(alice), { due: '5', paid: '2.5', settlements: 1 });
  const request = async () => env.send([await env.vault.requestPayout({ trader: alice.trader.publicKey, funded: alice.funded, payoutSeq: 0 })], [alice.trader]);
  const refused = await request();
  assert.equal(refused.error, 'FeesDue', 'no payout request while order fees are due');
  await serve(); // the venue loop reads the account again (its valuation is cached for up to 10 s)
  s = await summary(alice);
  assert.deepEqual([s.platformFees.dueUsd, s.availableMargin], ['5', '592.5'], 'the fees due are held: 597.5 USDC less 5');
  for (let i = 0; i < 4 && fees(alice).due !== '0'; i++) await round();
  // The take profit is charged the rate on the $10,000 it closed (its $2.50 assessment); the stop loss waived.
  assert.deepEqual(fees(alice), { due: '0', paid: '5', settlements: 2 });
  rows = await rowsOf(alice);
  assert.deepEqual([tp, sl].map((o) => [rows[o.toBase58()]!.chargedUsd, rows[o.toBase58()]!.waivedUsd]), [['2.500000', '0.000000'], ['0.000000', '2.500000']]);
  assert.equal(env.usdcBalance(alice.ownerUsdc), usdc('595'));

  // ---- the payout: requested now, reviewed against the fills less the fees charged (100 − 5 = 95), approved, paid
  const accepted = await request();
  assert.ok(!accepted.error, accepted.error);
  const traderUsdc = () => env.usdcBalance(getAssociatedTokenAddressSync(USDC_MINT, alice.trader.publicKey));
  const before = traderUsdc();
  await serve();
  await until(async () => {
    await tick();
    await jobs.runDue();
    await serve();
    return (await t.db.select().from(payouts))[0]?.status === 'paid';
  }, 60_000, 'the payout reviewed, approved and paid');
  const [paid] = await t.db.select().from(payouts);
  assert.deepEqual([paid!.profit, paid!.traderAmount], ['95.000000', '76.000000']);
  assert.equal(traderUsdc() - before, usdc('76'));
  assert.equal(enumName(onchain(alice).status), 'active');

  // ---- Bob: all his USDC in positions (a collateral-only top-up takes the rest: it ignores held fees), liquidated
  const bobOpen = await env.vault.openPosition({
    trader: bob.trader.publicKey, funded: fundedRef(bob), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'market',
    collateral: usdc('497.5'), sizeDeltaUsd: 10_000n * USD, acceptablePrice: HIGH, maxFee: orderFee(RATE, 10_000n * USD),
  });
  env.ok(bobOpen.instruction, [bob.trader]);
  const topUp = await env.vault.openPosition({
    trader: bob.trader.publicKey, funded: fundedRef(bob), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'market',
    collateral: usdc('2.5'), sizeDeltaUsd: 0n, acceptablePrice: HIGH, maxFee: 0n,
  });
  env.ok(topUp.instruction, [bob.trader]);
  assert.equal(env.usdcBalance(bob.ownerUsdc), 0n);
  await serve();
  const bobPosition = gmPositionPda(bob.owner, MARKETS.SOL.token, true);
  for (const o of [bobOpen.order, topUp.order]) {
    env.executeOrder(o, gmOrderEscrow(o));
    removed(o, 'Completed');
  }
  fill(bob, { order: bobOpen.order, before: 0n, after: 10_000n * USD, collateral: usdc('500') });
  filled(bobPosition, 0n, 0n); // liquidated: nothing comes back
  fill(bob, { order: Keypair.generate().publicKey, before: 10_000n * USD, after: 0n, collateral: 0n, pnl: -500n * USD, liquidation: true });
  // The keeper marks the account breached, syncs it (the open's fee is due: 2.5 with no USDC to pay it) and closes it:
  // close_funded refuses fees due, so they are settled (all waived) in the same transaction.
  for (let i = 0; i < 6 && enumName(onchain(bob).status) !== 'closed'; i++) await round();
  assert.equal(enumName(onchain(bob).status), 'closed');
  const [closure] = [...rpc.landed.values()].filter((l) => !l.err && l.tx.message.compiledInstructions.some((ix) => {
    const data = Buffer.from(ix.data);
    return l.tx.message.staticAccountKeys[ix.programIdIndex]!.equals(PROPS_VAULT_PROGRAM_ID) && data.subarray(0, 8).equals(Buffer.from(disc('close_funded')));
  }));
  assert.ok(closure, 'close_funded landed');
  const names = closure!.tx.message.compiledInstructions
    .filter((ix) => closure!.tx.message.staticAccountKeys[ix.programIdIndex]!.equals(PROPS_VAULT_PROGRAM_ID))
    .map((ix) => PROPS_VAULT_IDL.instructions.find((d) => Buffer.from(d.discriminator).equals(Buffer.from(ix.data).subarray(0, 8)))!.name);
  assert.deepEqual(names, ['settle_order_fees', 'close_funded'], 'the settlement and the closure in one transaction');
  const [bobSettlement] = await t.db.select().from(orderFeeSettlements).where(eq(orderFeeSettlements.signature, closure!.signature));
  assert.deepEqual([bobSettlement!.status, bobSettlement!.chargeUsd, bobSettlement!.waiveUsd], ['confirmed', '0.000000', '2.500000']);
  const [bobRow] = await t.db.select().from(fundedAccounts).where(eq(fundedAccounts.address, bob.funded.toBase58()));
  assert.equal(bobRow!.status, 'closed');

  // Nothing out of step: no fee ledger alert, no failed settlement.
  assert.deepEqual(raised.filter((r) => /fee-ledger|failed:.*:settle|failed:.*:closure/.test(r)), []);
});

/** An instruction's discriminator from the IDL. */
function disc(name: string): number[] {
  return PROPS_VAULT_IDL.instructions.find((i) => i.name === name)!.discriminator;
}

// ---------- at the owner's rate, with referred traders ----------
// The owner's rate ($2 + 10 bps per order, docs/design/order-fee.md §10 Q1) and REFERRAL_REWARD_BPS 1000: every number
// below is that arithmetic. A $1,000 order is assessed and charged $3.00; a close-all take profit or stop loss on a 10K
// account is assessed up to $12.00 (the rate on its $10,000 exposure cap) and charged on what it closes.

const OWNER = { feeUsdc: 2_000_000n, feeBps: 10 };

/**
 * The real program at the owner's rate, served on a database of its own to the chain module (indexer with referral
 * rewards, venue loop, job executor) and the keeper; `traders` active 10K funded accounts, all referred by `referrer`.
 * The node's confirmed block height is `height` (a settlement's blockhash expires once it passes the recorded one).
 */
async function ownerRate(name: string, traders: number) {
  const { Env, MARKETS, usdc } = await import('../../../../../tests/program/src/env.ts');
  const db = await freshDb(name);
  const env = new Env();
  const chain = { height: 1 };
  const rpc = Object.assign(liteSvmRpc(env), { getBlockHeight: async () => chain.height });
  await env.setUpVault();
  env.ok(await env.vault.setOrderFee({ admin: env.admin.publicKey, feeUsdc: OWNER.feeUsdc, feeBps: OWNER.feeBps }), [env.admin]);
  const funded: Awaited<ReturnType<typeof env.activeFunded>>[] = [];
  for (let i = 0; i < traders; i++) funded.push(await env.activeFunded());
  const referrer = Keypair.generate().publicKey.toBase58();
  const code = (wallet: string) => wallet.slice(0, 8).toUpperCase();
  await db.db.insert(users).values([
    { wallet: referrer, referralCode: code(referrer) },
    ...funded.map((f) => ({ wallet: f.trader.publicKey.toBase58(), referralCode: code(f.trader.publicKey.toBase58()), referredBy: referrer })),
  ]);
  const sol = { marketToken: MARKETS.SOL.token.toBase58(), symbol: 'SOL', indexToken: 'So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH', decimals: 9 };
  const client = new PropsVaultClient(rpc as never);
  const chainReader = createReader(client, rpc as never);
  const reader: ChainReader = { evaluation: chainReader.evaluation, market: async () => sol };
  const program = createProgramReader({ db: db.db, rpc: rpc as never, client, programId: PROPS_VAULT_PROGRAM_ID, cluster: 'localnet', serverRate: { feeUsdc: 0n, feeBps: 0, source: 'server' } });
  const indexer = createIndexer({
    db: db.db, rpc: rpc as never, client, programId: PROPS_VAULT_PROGRAM_ID, log: silentLog, reader, notify: async () => {},
    onApplied: (events) => program.changed(events), referralRewardBps: 1000,
  });
  const trades = new Map<string, TradeEvent[]>();
  const removals: OrderRemoval[] = [];
  const gm: GmIndexer = {
    trades: async (owner, afterId) => (trades.get(owner) ?? []).filter((e) => !afterId || e.id > afterId),
    signatures: async (ids) => new Map(ids.map((id) => [id, `fill-${id}`])),
    removals: async (orders) => removals.filter((r) => orders.includes(r.order)),
  };
  const venue = createVenue({ db: db.db, rpc: rpc as never, client, reader, gm, log: silentLog, notify: async () => {} });
  const sealer = createSealer(randomBytes(32).toString('hex'));
  const jobs = createJobs({ db: db.db, rpc: rpc as never, client, keys: { risk: env.risk }, sealer, log: silentLog });
  const raised: string[] = [];
  /** A keeper process: each call runs one tick. Two of them at once are two leaders during a handover. */
  const keeper = () => {
    let ended = () => {};
    const alerts: Alerts = { send: (key, level) => void raised.push(`${level} ${key}`), heartbeat: () => ended() };
    const k = createKeeper({ db: db.db, rpc: rpc as never, client, reader, risk: env.risk, sealer, log: silentLog, notify: async () => {}, alerts });
    return async () => {
      const stop = new AbortController();
      ended = () => stop.abort();
      await k.run(stop.signal, async () => true, 10);
    };
  };
  const serve = async () => {
    await indexer.catchUp();
    for (const f of funded) await venue.tick(f.funded.toBase58(), f.owner.toBase58(), f.trader.publicKey.toBase58(), true);
    await indexer.catchUp();
  };
  type Funded = (typeof funded)[number];
  const position = (f: Funded) => gmPositionPda(f.owner, MARKETS.SOL.token, true);
  let seq = 0;
  /** GMTrade's keeper executes (or cancels) an order: the Position it leaves, its removal record, and its fill. */
  const execute = (f: Funded, order: PublicKey, p: { before: bigint; after: bigint; collateral: bigint; pnl?: bigint; cancelled?: boolean }) => {
    env.executeOrder(order, gmOrderEscrow(order));
    removals.push({ id: String(removals.length), order: order.toBase58(), kind: 'MarketIncrease', state: p.cancelled ? 'Cancelled' : 'Completed', reason: p.cancelled ? 'price' : 'executed', ts: Date.now(), slot: 1 });
    if (p.cancelled) return;
    env.setPosition(position(f), p.after, p.collateral);
    const a = env.svm.getAccount(position(f))!;
    const data = Buffer.from(a.data);
    const tokens = p.after / SOL_PRICE;
    data.writeBigUInt64LE(tokens & ((1n << 64n) - 1n), POSITION_LAYOUT.sizeInTokens);
    data.writeBigUInt64LE(tokens >> 64n, POSITION_LAYOUT.sizeInTokens + 8);
    env.svm.setAccount(position(f), { ...a, data });
    const owner = f.owner.toBase58();
    const price = { min: SOL_PRICE, max: SOL_PRICE };
    const usdcPrice = { min: 10n ** 14n, max: 10n ** 14n };
    trades.set(owner, [...(trades.get(owner) ?? []), {
      id: `${String(900_000_000 + ++seq).padStart(12, '0')}-OWNER-000001-000000-000001`, ts: Date.now(), slot: 1, marketToken: sol.marketToken, user: owner,
      position: position(f).toBase58(), order: order.toBase58(), isLong: true, isCollateralLong: false, isIncrease: p.after > p.before, isLiquidation: false,
      executionPrice: SOL_PRICE, priceImpactValue: 0n, before: { sizeInUsd: p.before, sizeInTokens: 0n, collateralAmount: 0n },
      after: { sizeInUsd: p.after, sizeInTokens: tokens, collateralAmount: p.collateral }, pnl: p.pnl ?? 0n,
      fees: { order: 0n, liquidation: 0n, borrowing: 0n, funding: 0n }, prices: { index: price, long: usdcPrice, short: usdcPrice }, outputAmount: 0n, secondaryOutputAmount: 0n,
    }]);
  };
  const open = async (f: Funded, size: bigint, o: { orderType?: 'market' | 'limit'; maxFee?: bigint } = {}) => {
    const placed = await env.vault.openPosition({
      trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true, orderType: o.orderType ?? 'market',
      collateral: usdc('100'), sizeDeltaUsd: size, acceptablePrice: HIGH, maxFee: o.maxFee ?? orderFee(OWNER, size),
      ...(o.orderType === 'limit' && { triggerPrice: 140n * 10n ** 11n }),
    });
    return placed;
  };
  const onchain = (f: Funded) => env.account('fundedAccount', f.funded);
  const fees = (f: Funded) => ({ due: fromMicro(big(onchain(f).orderFeesDue)), paid: fromMicro(big(onchain(f).orderFeesPaid)), settlements: Number(onchain(f).orderFeeSettlements.toString()) });
  const row = async (order: PublicKey) => (await db.db.select().from(orderFees).where(eq(orderFees.order, order.toBase58())))[0]!;
  const charged = async (order: PublicKey) => [(await row(order)).chargedUsd, (await row(order)).waivedUsd];
  const rewards = async (f?: Funded) => (await db.db.select().from(referralRewards).orderBy(referralRewards.id))
    .filter((r) => !f || r.referee === f.trader.publicKey.toBase58())
    .map((r) => ({ order: r.order, fee: r.feeUsd, reward: r.rewardUsd, bps: r.rateBps, referrer: r.referrer, signature: r.settlementSignature }));
  return { env, db, rpc, chain, client, program, indexer, venue, jobs, keeper, serve, raised, funded, referrer, MARKETS, usdc, execute, open, onchain, fees, row, charged, rewards };
}
const big = (v: { toString(): string }) => BigInt(v.toString());

test('at the owner\'s rate, a referred trader\'s funded orders: each assessed, charged only when executed, 10 % of each charge to the referrer, once whatever is replayed or raced, nothing on a breached account', { skip, timeout: 300_000 }, async () => {
  const s = await ownerRate('keeper_fees_owner', 2);
  const { env, db, MARKETS, usdc } = s;
  const [alice, carol] = [s.funded[0]!, s.funded[1]!];
  const tick = s.keeper();
  const settled = async (f: typeof alice, paid: string) => { for (let i = 0; i < 6 && s.fees(f).paid !== paid; i++) { await tick(); await s.serve(); } };
  const feeVault = () => env.usdcBalance(feeVaultPda());
  const provider = createFundedProvider({ db: db.db, venue: s.venue, program: s.program });
  const summary = async (f: typeof alice) => (await provider.detail(f.trader.publicKey.toBase58(), f.funded.toBase58()))!;
  try {
    assert.deepEqual(await s.program.orderFeeRate(), { ...OWNER, source: 'program' });
    assert.equal(orderFee(OWNER, 1_000n * USD), 3_000_000n, '$2 + 10 bps of $1,000');
    assert.equal(orderFee(OWNER, CLOSE_ALL, CAP), 12_000_000n, '$2 + 10 bps of the $10,000 cap');

    // ---- An open signed at a stale rate (max_fee 0) is refused; at the owner's, it is assessed $3.00 and held, its
    // close-all take profit and stop loss $12.00 each (not held).
    env.fails((await s.open(alice, 1_000n * USD, { maxFee: 0n })).instruction, [alice.trader], 'OrderFeeChanged');
    const opened = await s.open(alice, 1_000n * USD);
    env.ok(opened.instruction, [alice.trader]);
    const protect = async (orderType: 'takeProfit' | 'stopLoss', trigger: bigint) => {
      const p = await env.vault.setProtection({
        trader: alice.trader.publicKey, funded: env.funded(alice.funded), marketToken: MARKETS.SOL.token, isLong: true, orderType, triggerPrice: trigger,
        sizeDeltaUsd: CLOSE_ALL, maxFee: orderFee(OWNER, CLOSE_ALL, CAP),
      });
      env.ok(p.instruction, [alice.trader]);
      return p.order;
    };
    const [tp, sl] = [await protect('takeProfit', 160n * 10n ** 11n), await protect('stopLoss', 140n * 10n ** 11n)];
    await s.serve();
    const first = await s.row(opened.order);
    assert.deepEqual([first.assessedUsd, first.rateUsd, first.rateBps, first.state, first.isIncrease], ['3.000000', '2.000000', 10, 'assessed', true]);
    assert.deepEqual([(await s.row(tp)).assessedUsd, (await s.row(sl)).assessedUsd], ['12.000000', '12.000000']);
    let a = await summary(alice);
    assert.deepEqual([a.availableMargin, a.platformFees], ['397', { dueUsd: '0', paidUsd: '0', heldUsd: '3' }], '500 USDC − 100 collateral − the open\'s $3 held');

    // ---- It executes: owed at once (the valuation takes it off before any sync), charged by the keeper, 10 % earned.
    const vault0 = feeVault();
    s.execute(alice, opened.order, { before: 0n, after: 1_000n * USD, collateral: usdc('100') });
    await s.serve();
    a = await summary(alice);
    assert.deepEqual([a.equity, a.availableMargin], ['9997', '397']);
    await settled(alice, '3');
    assert.deepEqual(s.fees(alice), { due: '0', paid: '3', settlements: 1 });
    assert.deepEqual([feeVault() - vault0, env.usdcBalance(alice.ownerUsdc)], [3_000_000n, usdc('397')]);
    assert.deepEqual(await s.charged(opened.order), ['3.000000', '0.000000']);
    const [reward] = await s.rewards(alice);
    assert.deepEqual([reward!.order, reward!.fee, reward!.reward, reward!.bps, reward!.referrer], [opened.order.toBase58(), '3.000000', '0.300000', 1000, s.referrer]);
    const [settlement] = await db.db.select().from(orderFeeSettlements).where(eq(orderFeeSettlements.signature, reward!.signature));
    assert.deepEqual([settlement!.status, settlement!.chargeUsd, settlement!.sentBy], ['confirmed', '3.000000', 'keeper']);

    // ---- A $1,000 increase ($3.00), then a $1,000 sized close ($3.00: below the cap, it is assessed on its size).
    const increase = await s.open(alice, 1_000n * USD);
    env.ok(increase.instruction, [alice.trader]);
    await s.serve();
    s.execute(alice, increase.order, { before: 1_000n * USD, after: 2_000n * USD, collateral: usdc('200') });
    await s.serve();
    await settled(alice, '6');
    const close = await env.vault.closePosition({
      authority: alice.trader.publicKey, funded: env.funded(alice.funded), marketToken: MARKETS.SOL.token, isLong: true, sizeDeltaUsd: 1_000n * USD,
      acceptablePrice: 1n, maxFee: orderFee(OWNER, 1_000n * USD, CAP),
    });
    env.ok(close.instruction, [alice.trader]);
    await s.serve();
    assert.deepEqual([(await s.row(close.order)).assessedUsd, (await s.row(close.order)).isIncrease], ['3.000000', false]);
    s.execute(alice, close.order, { before: 2_000n * USD, after: 1_000n * USD, collateral: usdc('100') });
    env.setUsdcBalance(alice.ownerUsdc, env.usdcBalance(alice.ownerUsdc) + usdc('100'));
    await s.serve();
    await settled(alice, '9');
    assert.deepEqual([s.fees(alice), await s.charged(close.order)], [{ due: '0', paid: '9', settlements: 3 }, ['3.000000', '0.000000']]);

    // ---- The take profit closes the last $1,000 in profit ($12 assessed: $3 charged, $9 waived); the exchange cancels
    // the stop loss ($12 waived). A payout request fails while the fees are due, and is paid once they are settled.
    s.execute(alice, tp, { before: 1_000n * USD, after: 0n, collateral: 0n, pnl: 100n * USD });
    s.execute(alice, sl, { before: 0n, after: 0n, collateral: 0n, cancelled: true });
    env.setUsdcBalance(alice.ownerUsdc, env.usdcBalance(alice.ownerUsdc) + usdc('200')); // 100 collateral + 100 profit
    await tick(); // the sync makes both legs' $24 due; the ledger has not seen it yet
    assert.deepEqual(s.fees(alice), { due: '24', paid: '9', settlements: 3 });
    const request = async () => env.send([await env.vault.requestPayout({ trader: alice.trader.publicKey, funded: alice.funded, payoutSeq: 0 })], [alice.trader]);
    assert.equal((await request()).error, 'FeesDue');
    await s.serve();
    await settled(alice, '12');
    assert.deepEqual([s.fees(alice), await s.charged(tp), await s.charged(sl)], [{ due: '0', paid: '12', settlements: 4 }, ['3.000000', '9.000000'], ['0.000000', '12.000000']]);
    assert.deepEqual([feeVault() - vault0, env.usdcBalance(alice.ownerUsdc)], [12_000_000n, usdc('588')], '500 − 200 collateral − $12 of fees + 300 back');
    assert.deepEqual((await s.rewards(alice)).map((r) => [r.fee, r.reward]), Array(4).fill(['3.000000', '0.300000']), '$1.20 on $12 charged, nothing on $21 waived');
    assert.ok(!(await request()).error);
    await s.serve();
    await until(async () => {
      await tick();
      await s.jobs.runDue();
      await s.serve();
      return (await db.db.select().from(payouts))[0]?.status === 'paid';
    }, 60_000, 'the payout reviewed, approved and paid');
    const [paid] = await db.db.select().from(payouts);
    assert.deepEqual([paid!.profit, paid!.traderAmount], ['88.000000', '70.400000'], '588 − 500, net of the $12 of Props fees; 80 %');

    // ---- Read again from nothing (a restart without a cursor): no reward and no ledger row changes. A settlement event
    // projected once more past program_events (a bug) is refused whole: its vault ledger entry exists.
    const ledger = await db.db.select().from(orderFees).where(eq(orderFees.fundedAccount, alice.funded.toBase58()));
    const earned = (await s.rewards()).length;
    await db.db.delete(indexerCursors);
    await s.indexer.catchUp();
    assert.deepEqual([(await s.rewards()).length, await db.db.select().from(orderFees).where(eq(orderFees.fundedAccount, alice.funded.toBase58()))], [earned, ledger]);
    const [ev] = await db.db.select().from(programEvents).where(eq(programEvents.name, 'orderFeesSettled')).limit(1);
    await assert.rejects(db.db.transaction((tx) => project(tx, { name: 'orderFeesSettled', data: ev!.data } as never, ev!.eventIndex, { signature: ev!.signature, slot: ev!.slot, fee: 5_000n }, { reader: {} as never, referralRewardBps: 1000 })));
    assert.equal((await s.rewards()).length, earned);

    // ---- Two keepers at once (a leadership handover) plan the same settlement of Carol's executed open: it lands once.
    const tickB = s.keeper();
    const carols = await s.open(carol, 1_000n * USD);
    env.ok(carols.instruction, [carol.trader]);
    await s.serve();
    s.execute(carol, carols.order, { before: 0n, after: 1_000n * USD, collateral: usdc('100') });
    await s.serve();
    const vaultC = feeVault();
    for (let i = 0; i < 6 && s.fees(carol).paid !== '3'; i++) {
      await Promise.all([tick(), tickB()]);
      await s.serve();
    }
    assert.deepEqual([s.fees(carol), feeVault() - vaultC], [{ due: '0', paid: '3', settlements: 1 }, 3_000_000n]);
    const races = await db.db.select().from(orderFeeSettlements).where(eq(orderFeeSettlements.fundedAccount, carol.funded.toBase58()));
    assert.equal(races.filter((r) => r.status === 'confirmed').length, 1);
    assert.deepEqual((await s.rewards(carol)).map((r) => r.reward), ['0.300000']);

    // ---- Nothing charged, nothing earned: a limit order the trader cancels (released), an open the exchange cancels
    // (waived). The session guard's close of an active account is charged like the trader's own ($12 assessed on the
    // cap, $3 charged on the $1,000 it closed) and earns like it. An order whose outcome stays unknown waits, and is
    // waived after 24 h.
    const limit = await s.open(carol, 1_000n * USD, { orderType: 'limit' });
    env.ok(limit.instruction, [carol.trader]);
    env.ok(await env.vault.cancelOrder({ authority: carol.trader.publicKey, funded: env.funded(carol.funded), order: limit.order }), [carol.trader]);
    const slipped = await s.open(carol, 1_000n * USD);
    env.ok(slipped.instruction, [carol.trader]);
    await s.serve();
    s.execute(carol, slipped.order, { before: 1_000n * USD, after: 1_000n * USD, collateral: 0n, cancelled: true });
    env.setUsdcBalance(carol.ownerUsdc, env.usdcBalance(carol.ownerUsdc) + usdc('100')); // its collateral back
    for (let i = 0; i < 6 && (await s.row(slipped.order)).waivedUsd !== '3.000000'; i++) { await tick(); await s.serve(); }
    assert.deepEqual([(await s.row(limit.order)).state, await s.charged(limit.order), await s.charged(slipped.order)], ['released', ['0.000000', '0.000000'], ['0.000000', '3.000000']]);
    const guard = await env.vault.closePosition({
      authority: env.risk.publicKey, funded: env.funded(carol.funded), marketToken: MARKETS.SOL.token, isLong: true, sizeDeltaUsd: CLOSE_ALL, acceptablePrice: 1n,
    });
    env.ok(guard.instruction, [env.risk]);
    await s.serve();
    assert.equal((await s.row(guard.order)).assessedUsd, '12.000000');
    s.execute(carol, guard.order, { before: 1_000n * USD, after: 0n, collateral: 0n });
    env.setUsdcBalance(carol.ownerUsdc, env.usdcBalance(carol.ownerUsdc) + usdc('100'));
    for (let i = 0; i < 6 && (await s.row(guard.order)).chargedUsd === '0.000000'; i++) { await tick(); await s.serve(); }
    assert.deepEqual(await s.charged(guard.order), ['3.000000', '9.000000']);
    assert.deepEqual((await s.rewards(carol)).filter((r) => r.order === guard.order.toBase58()).map((r) => r.reward), ['0.300000']);
    const unknown = await s.open(carol, 1_000n * USD);
    env.ok(unknown.instruction, [carol.trader]);
    await s.serve();
    env.executeOrder(unknown.order, gmOrderEscrow(unknown.order)); // gone, with no removal record and no fill
    env.setUsdcBalance(carol.ownerUsdc, env.usdcBalance(carol.ownerUsdc) + usdc('100'));
    for (let i = 0; i < 3; i++) { await tick(); await s.serve(); }
    const [outcome] = await db.db.select({ status: gmOrders.status }).from(gmOrders).where(eq(gmOrders.address, unknown.order.toBase58()));
    assert.deepEqual([(await s.row(unknown.order)).state, await s.charged(unknown.order), outcome!.status], ['due', ['0.000000', '0.000000'], 'unknown']);
    await db.db.update(orderFees).set({ dueAt: sql`${orderFees.dueAt} - interval '24 hours 1 minute'` }).where(eq(orderFees.order, unknown.order.toBase58()));
    for (let i = 0; i < 3 && (await s.row(unknown.order)).waivedUsd === '0.000000'; i++) { await tick(); await s.serve(); }
    assert.deepEqual([await s.charged(unknown.order), s.fees(carol).due], [['0.000000', '3.000000'], '0']);

    // ---- The account breaches: the trader's close placed before is still charged ($500: $2.50), the risk authority's
    // breach close is free, and the account closes. Its USDC all returns to the capital vault, so the charge only moved
    // Props' capital into the fee vault: it earns the referrer nothing.
    const reopened = await s.open(carol, 1_000n * USD);
    env.ok(reopened.instruction, [carol.trader]);
    await s.serve();
    s.execute(carol, reopened.order, { before: 0n, after: 1_000n * USD, collateral: usdc('100') });
    await s.serve();
    for (let i = 0; i < 6 && (await s.row(reopened.order)).chargedUsd === '0.000000'; i++) { await tick(); await s.serve(); }
    const earnedBefore = (await s.rewards(carol)).length;
    const traderClose = await env.vault.closePosition({
      authority: carol.trader.publicKey, funded: env.funded(carol.funded), marketToken: MARKETS.SOL.token, isLong: true, sizeDeltaUsd: 500n * USD,
      acceptablePrice: 1n, maxFee: orderFee(OWNER, 500n * USD, CAP),
    });
    env.ok(traderClose.instruction, [carol.trader]);
    env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: carol.funded }), [env.risk]);
    const breachClose = await env.vault.closePosition({
      authority: env.risk.publicKey, funded: env.funded(carol.funded), marketToken: MARKETS.SOL.token, isLong: true, sizeDeltaUsd: CLOSE_ALL, acceptablePrice: 1n,
    });
    env.ok(breachClose.instruction, [env.risk]);
    await s.serve();
    assert.deepEqual([(await s.row(traderClose.order)).assessedUsd, (await s.row(breachClose.order)).assessedUsd], ['2.500000', '0.000000']);
    s.execute(carol, traderClose.order, { before: 1_000n * USD, after: 500n * USD, collateral: usdc('50'), pnl: -20n * USD });
    s.execute(carol, breachClose.order, { before: 500n * USD, after: 0n, collateral: 0n, pnl: -20n * USD });
    env.setUsdcBalance(carol.ownerUsdc, env.usdcBalance(carol.ownerUsdc) + usdc('60')); // 40 of the 100 collateral lost
    const [vaultB, capitalB] = [feeVault(), env.usdcBalance(capitalVaultAddress())];
    const usdcB = env.usdcBalance(carol.ownerUsdc);
    for (let i = 0; i < 10 && enumName(s.onchain(carol).status) !== 'closed'; i++) { await tick(); await s.serve(); }
    assert.equal(enumName(s.onchain(carol).status), 'closed');
    assert.deepEqual([await s.charged(traderClose.order), await s.charged(breachClose.order)], [['2.500000', '0.000000'], ['0.000000', '0.000000']]);
    assert.deepEqual([feeVault() - vaultB, env.usdcBalance(capitalVaultAddress()) - capitalB], [usdc('2.5'), usdcB - usdc('2.5')], 'all of it back to Props, $2.50 through the fee vault');
    assert.equal((await s.rewards(carol)).length, earnedBefore, 'no reward on a charge settled after the breach');
  } finally {
    await db.sql.end();
  }
});

test('at the owner\'s rate, restarts and leadership changes around a settlement, a settlement sent by hand, two in one transaction and a rate change mid-flight: each fee charged once, each charge earning once', { skip, timeout: 300_000 }, async () => {
  const s = await ownerRate('keeper_fees_restarts', 1);
  const { env, db, rpc, client, usdc } = s;
  const alice = s.funded[0]!;
  const settlements = async () => (await db.db.select().from(orderFeeSettlements).orderBy(orderFeeSettlements.createdAt)).map((r) => [r.status, r.chargeUsd, r.expectedSettlements]);
  const sendSettlements = async (...plans: { charge: bigint; waive: bigint; expectedDue: bigint; expectedSettlements: bigint }[]) => {
    const instructions = await Promise.all(plans.map((p) => client.settleOrderFees({ riskAuthority: env.risk.publicKey, funded: alice.funded, ...p })));
    const tx = buildTransaction({ payer: env.risk.publicKey, instructions, recentBlockhash: (await rpc.getLatestBlockhash()).blockhash, computeUnits: 400_000 });
    tx.sign([env.risk]);
    return { tx, signature: bs58.encode(tx.signatures[0]!) };
  };
  try {
    // ---- A $1,000 open executes and the keeper syncs it: $3 due.
    const tickA = s.keeper();
    const o1 = await s.open(alice, 1_000n * USD);
    env.ok(o1.instruction, [alice.trader]);
    await s.serve();
    s.execute(alice, o1.order, { before: 0n, after: 1_000n * USD, collateral: usdc('100') });
    await tickA();
    await s.serve();
    assert.deepEqual(s.fees(alice), { due: '3', paid: '0', settlements: 0 });

    // ---- A keeper crashed after recording its settlement and before sending it. The next one settles nothing while
    // that transaction could still land, then fails it once its blockhash expired and settles once.
    await recordSettlement(db.db, {
      signature: bs58.encode(randomBytes(64)), funded: alice.funded.toBase58(), plan: { charge: 3_000_000n, waive: 0n, allocations: [{ order: o1.order.toBase58(), charge: 3_000_000n, waive: 0n }] },
      expectedDue: 3_000_000n, expectedSettlements: 0n, sentBy: 'keeper', lastValidBlockHeight: 5,
    });
    const tickB = s.keeper();
    await tickB();
    await s.serve();
    assert.deepEqual(s.fees(alice), { due: '3', paid: '0', settlements: 0 }, 'nothing settled while the recorded one can still land');
    s.chain.height = 6;
    for (let i = 0; i < 3 && s.fees(alice).paid !== '3'; i++) { await tickB(); await s.serve(); }
    assert.deepEqual(s.fees(alice), { due: '0', paid: '3', settlements: 1 });
    assert.deepEqual(await settlements(), [['failed', '3.000000', 0], ['confirmed', '3.000000', 0]]);
    assert.equal((await s.rewards()).length, 1);

    // ---- Keeper A's settlement landed, then A died before the indexer applied it; C, the new leader, reads it as
    // landed (not failed), and the indexer confirms it: charged once.
    const o2 = await s.open(alice, 1_000n * USD);
    env.ok(o2.instruction, [alice.trader]);
    await s.serve();
    s.execute(alice, o2.order, { before: 1_000n * USD, after: 2_000n * USD, collateral: usdc('200') });
    await tickB();
    await s.serve();
    const landed = await sendSettlements({ charge: 3_000_000n, waive: 0n, expectedDue: 3_000_000n, expectedSettlements: 1n });
    await recordSettlement(db.db, {
      signature: landed.signature, funded: alice.funded.toBase58(), plan: { charge: 3_000_000n, waive: 0n, allocations: [{ order: o2.order.toBase58(), charge: 3_000_000n, waive: 0n }] },
      expectedDue: 3_000_000n, expectedSettlements: 1n, sentBy: 'keeper', lastValidBlockHeight: s.chain.height - 1, // expired: C checks its status
    });
    await rpc.sendRawTransaction(landed.tx.serialize());
    const tickC = s.keeper();
    await tickC();
    const status = async (signature: string) => (await db.db.select().from(orderFeeSettlements).where(eq(orderFeeSettlements.signature, signature)))[0]!.status;
    assert.equal(await status(landed.signature), 'sent', 'landed: not failed by the new leader');
    await s.serve();
    assert.deepEqual([await status(landed.signature), s.fees(alice), (await s.rewards()).length], ['confirmed', { due: '0', paid: '6', settlements: 2 }, 2]);

    // ---- A settlement sent by hand (the fallback script's instruction): recorded when indexed, spread over the due
    // orders, and earning like the keeper's ($4.00 on a $2,000 open: $0.40).
    const o3 = await s.open(alice, 2_000n * USD);
    env.ok(o3.instruction, [alice.trader]);
    await s.serve();
    s.execute(alice, o3.order, { before: 2_000n * USD, after: 4_000n * USD, collateral: usdc('300') });
    await tickC();
    await s.serve();
    env.ok(await client.settleOrderFees({ riskAuthority: env.risk.publicKey, funded: alice.funded, charge: 4_000_000n, waive: 0n, expectedDue: 4_000_000n, expectedSettlements: 2n }), [env.risk]);
    await s.serve();
    assert.deepEqual([await s.charged(o3.order), (await s.rewards()).filter((r) => r.order === o3.order.toBase58()).map((r) => [r.fee, r.reward])], [['4.000000', '0.000000'], [['4.000000', '0.400000']]]);

    // ---- The rate falls to $1 + 5 bps between an open's assessment and its execution: it is charged at the rate of
    // its assessment ($3.00). A take profit placed at the new rate ($6 on the cap) that closes $5,000 is charged
    // $1 + 5 bps of it ($3.50, $2.50 waived); an update signed below the new fee is refused.
    const lower = { feeUsdc: 1_000_000n, feeBps: 5 };
    const o4 = await s.open(alice, 1_000n * USD);
    env.ok(o4.instruction, [alice.trader]);
    await s.serve();
    env.ok(await env.vault.setOrderFee({ admin: env.admin.publicKey, ...lower }), [env.admin]);
    s.execute(alice, o4.order, { before: 4_000n * USD, after: 5_000n * USD, collateral: usdc('400') });
    for (let i = 0; i < 4 && (await s.row(o4.order)).chargedUsd === '0.000000'; i++) { await tickC(); await s.serve(); }
    const o4row = await s.row(o4.order);
    assert.deepEqual([o4row.assessedUsd, o4row.chargedUsd, o4row.rateUsd, o4row.rateBps], ['3.000000', '3.000000', '2.000000', 10]);
    const tp = await env.vault.setProtection({
      trader: alice.trader.publicKey, funded: env.funded(alice.funded), marketToken: s.MARKETS.SOL.token, isLong: true, orderType: 'takeProfit',
      triggerPrice: 160n * 10n ** 11n, sizeDeltaUsd: CLOSE_ALL, maxFee: orderFee(lower, CLOSE_ALL, CAP),
    });
    env.ok(tp.instruction, [alice.trader]);
    env.fails(await env.vault.updateOrder({ trader: alice.trader.publicKey, funded: env.funded(alice.funded), order: tp.order, triggerPrice: 161n * 10n ** 11n, maxFee: 5_999_999n }), [alice.trader], 'OrderFeeChanged');
    await s.serve();
    assert.equal((await s.row(tp.order)).assessedUsd, '6.000000');
    s.execute(alice, tp.order, { before: 5_000n * USD, after: 0n, collateral: 0n });
    env.setUsdcBalance(alice.ownerUsdc, env.usdcBalance(alice.ownerUsdc) + usdc('600'));
    for (let i = 0; i < 4 && (await s.row(tp.order)).chargedUsd === '0.000000'; i++) { await tickC(); await s.serve(); }
    assert.deepEqual(await s.charged(tp.order), ['3.500000', '2.500000']);

    // ---- An operator settles the account twice in one transaction ($1, then $2 of a $3 fee): both reach the ledger
    // and earn ($0.10 and $0.20), and the keeper still settles the next fee (the ledger stays in step with the chain).
    env.ok(await env.vault.setOrderFee({ admin: env.admin.publicKey, feeUsdc: OWNER.feeUsdc, feeBps: OWNER.feeBps }), [env.admin]);
    const o5 = await s.open(alice, 1_000n * USD);
    env.ok(o5.instruction, [alice.trader]);
    await s.serve();
    s.execute(alice, o5.order, { before: 0n, after: 1_000n * USD, collateral: usdc('100') });
    await tickC();
    await s.serve();
    const before = s.fees(alice);
    assert.equal(before.due, '3');
    const n = BigInt(before.settlements);
    const twice = await sendSettlements({ charge: 1_000_000n, waive: 0n, expectedDue: 3_000_000n, expectedSettlements: n }, { charge: 2_000_000n, waive: 0n, expectedDue: 2_000_000n, expectedSettlements: n + 1n });
    await rpc.sendRawTransaction(twice.tx.serialize());
    assert.equal(rpc.landed.get(twice.signature)!.err, null);
    await s.serve();
    assert.deepEqual([await s.charged(o5.order), (await s.rewards()).filter((r) => r.signature === twice.signature).map((r) => [r.fee, r.reward])], [['3.000000', '0.000000'], [['1.000000', '0.100000'], ['2.000000', '0.200000']]]);
    const o6 = await s.open(alice, 1_000n * USD);
    env.ok(o6.instruction, [alice.trader]);
    await s.serve();
    s.execute(alice, o6.order, { before: 1_000n * USD, after: 2_000n * USD, collateral: usdc('200') });
    for (let i = 0; i < 4 && (await s.row(o6.order)).chargedUsd === '0.000000'; i++) { await tickC(); await s.serve(); }
    assert.deepEqual([await s.charged(o6.order), s.fees(alice).due], [['3.000000', '0.000000'], '0']);
    assert.deepEqual(s.raised.filter((r) => /fee-ledger|failed:.*:settle/.test(r)), []);
  } finally {
    await db.sql.end();
  }
});
