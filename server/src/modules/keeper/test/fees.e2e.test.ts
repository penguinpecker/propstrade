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
import { eq } from 'drizzle-orm';
import type { OrderRemoval, TradeEvent } from '@props/gmtrade';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  CLOSE_ALL, POSITION_LAYOUT, PROPS_VAULT_IDL, PROPS_VAULT_PROGRAM_ID, PropsVaultClient, USDC_MINT, enumName, feeVaultPda, fromMicro, gmOrderEscrow,
  gmPositionPda, orderFee,
} from '@props/sdk';
import { fundedAccounts, orderFeeSettlements, orderFees, payouts } from '../../../db/schema.ts';
import { createSealer } from '../../../lib/integrity.ts';
import { createFundedProvider } from '../../chain/funded.ts';
import { createIndexer } from '../../chain/indexer.ts';
import { createJobs } from '../../chain/jobs.ts';
import { createProgramReader } from '../../chain/program.ts';
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
