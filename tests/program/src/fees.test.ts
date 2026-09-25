// Props.trade's order fee (docs/design/order-fee.md): assessed when an order is placed or updated, held for increases,
// released by cancel_order (and by close_completed_order for an order the exchange cancelled), due once the order leaves
// the book any other way, charged or waived by a risk authority (settle_order_fees, once per settlement count), and
// settled before a payout or closure. Both builds (PROPS_VAULT_SO).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import {
  CLOSE_ALL,
  USDC_MINT,
  capitalVaultAddress,
  configPda,
  enumName,
  feeVaultPda,
  fundedReservedFees,
  gmOrderEscrow,
  gmPositionPda,
  orderFee,
  payoutPda,
} from '@props/sdk';
import { Env, LEVERAGE, MARKETS, TIERS, USD, marketParams, swapKey, usdc } from './env.ts';
import type { MarketName } from './env.ts';

type Funded = Awaited<ReturnType<Env['activeFunded']>>;

const HIGH = 10n ** 30n;
const LOW = 1n;
/** $0.50 + 7 bps. */
const RATE = { feeUsdc: 500_000n, feeBps: 7 };
/** The 10K tier's exposure cap (size × 100 %, env.ts `tierParams`): the base of a decrease fee. */
const CAP = 10_000n * USD;
const n = (v: { toString(): string }) => BigInt(v.toString());

async function setUp(rate = RATE) {
  const env = new Env();
  await env.setUpVault();
  for (const m of Object.values(MARKETS)) {
    const a = env.svm.getAccount(m.gm)!;
    const data = Buffer.from(a.data);
    data[10] = data[10]! & ~(1 << 5); // fixture markets are flagged closed
    env.svm.setAccount(m.gm, { ...a, data });
  }
  if (rate.feeUsdc || rate.feeBps) env.ok(await env.vault.setOrderFee({ admin: env.admin.publicKey, ...rate }), [env.admin]);
  const f = await env.activeFunded();
  env.svm.airdrop(f.owner, 1_000_000_000n); // GMTrade rents for more than four orders
  return { env, f };
}

const fees = (env: Env, f: Funded) => {
  const a = env.account('fundedAccount', f.funded);
  return { orders: a.orderFees.map(n), due: n(a.orderFeesDue), paid: n(a.orderFeesPaid), held: fundedReservedFees(a) };
};
const settlements = (env: Env, f: Funded) => n(env.account('fundedAccount', f.funded).orderFeeSettlements);
const feeOf = (env: Env, f: Funded, order: PublicKey) => {
  const a = env.account('fundedAccount', f.funded);
  const j = a.orders.findIndex((o) => o.order.equals(order));
  assert.ok(j >= 0, 'order not tracked');
  return n(a.orderFees[j]!);
};

function open(env: Env, f: Funded, market: MarketName, p: { collateral: bigint; size: bigint; isLong?: boolean; limit?: bigint; maxFee?: bigint; ordersBefore?: number }) {
  const isLong = p.isLong ?? true;
  return env.vault.openPosition({
    trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS[market].token, isLong, orderType: p.limit ? 'limit' : 'market',
    collateral: p.collateral, sizeDeltaUsd: p.size, triggerPrice: p.limit, acceptablePrice: isLong ? HIGH : LOW, maxFee: p.maxFee, ordersBefore: p.ordersBefore,
  });
}
function close(env: Env, f: Funded, market: MarketName, p: { size: bigint; authority?: PublicKey; maxFee?: bigint }) {
  return env.vault.closePosition({
    authority: p.authority ?? f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS[market].token, isLong: true,
    sizeDeltaUsd: p.size, acceptablePrice: LOW, maxFee: p.maxFee,
  });
}
function protect(env: Env, f: Funded, market: MarketName, p: { size: bigint; type?: 'takeProfit' | 'stopLoss'; trigger?: bigint; maxFee?: bigint; ordersBefore?: number }) {
  return env.vault.setProtection({
    trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS[market].token, isLong: true, orderType: p.type ?? 'takeProfit',
    triggerPrice: p.trigger ?? 150n * 10n ** 11n, sizeDeltaUsd: p.size, maxFee: p.maxFee, ordersBefore: p.ordersBefore,
  });
}
const sync = async (env: Env, f: Funded) => env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [env.risk]);
const settle = (env: Env, f: Funded, charge: bigint, waive: bigint, expectedDue = fees(env, f).due, signer = env.risk.publicKey, expectedSettlements = settlements(env, f)) =>
  env.vault.settleOrderFees({ riskAuthority: signer, funded: f.funded, charge, waive, expectedDue, expectedSettlements });

/** A market long on `market` the keeper filled: its fee is due after the sync. */
async function filled(env: Env, f: Funded, market: MarketName, size: bigint, collateral: bigint) {
  const o = await open(env, f, market, { collateral, size });
  env.ok(o.instruction, [f.trader]);
  const position = gmPositionPda(f.owner, MARKETS[market].token, true);
  env.executeOrder(o.order, gmOrderEscrow(o.order));
  env.setPosition(position, size, collateral);
  await sync(env, f);
  return { order: o.order, position };
}

describe('order fee: set_order_fee', () => {
  it('is admin only, bounded by $2 and 10 bps, evented and never paused; initialize leaves it off', async () => {
    const env = new Env();
    await env.setUpVault();
    const rate = () => {
      const c = env.account('config', configPda());
      return { feeUsdc: n(c.orderFeeUsdc), feeBps: c.orderFeeBps };
    };
    assert.deepEqual(rate(), { feeUsdc: 0n, feeBps: 0 });
    const set = (feeUsdc: bigint, feeBps: number, admin = env.admin.publicKey) => env.vault.setOrderFee({ admin, feeUsdc, feeBps });
    const stranger = env.wallet();
    env.fails(await set(1n, 1, stranger.publicKey), [stranger], 'Unauthorized');
    env.fails(await set(1n, 1, env.risk.publicKey), [env.risk], 'Unauthorized');
    env.fails(await set(2_000_001n, 0), [env.admin], 'InvalidParams');
    env.fails(await set(0n, 11), [env.admin], 'InvalidParams');
    env.ok(await env.vault.setPauses({ admin: env.admin.publicKey, paused: { newEvaluations: true, trading: true, payouts: true } }), [env.admin]);
    const r = env.ok(await set(2_000_000n, 10), [env.admin]);
    assert.equal(r.events[0]?.name, 'configChanged');
    assert.equal(enumName(r.events[0]!.data.change as object), 'orderFee');
    assert.ok((r.events[0]!.data.subject as PublicKey).equals(env.admin.publicKey));
    assert.deepEqual(rate(), { feeUsdc: 2_000_000n, feeBps: 10 });
    env.ok(await set(0n, 0), [env.admin]);
    assert.deepEqual(rate(), { feeUsdc: 0n, feeBps: 0 });
  });
});

describe('order fee: placement', () => {
  it('open_position assesses flat + bps of the size rounded down, refuses a fee above max_fee and holds pending increase fees', async () => {
    const { env, f } = await setUp();
    // $1,234.567891234 = 1,234,567,891 micro-USD; 7 bps of it = 864,197.52 -> 864,197.
    const size = 1_234_567_891_234n * 10n ** 11n;
    const f1 = 500_000n + 864_197n;
    assert.equal(orderFee(RATE, size), f1, 'the SDK formula');
    env.fails((await open(env, f, 'ETH', { collateral: usdc('100'), size, maxFee: f1 - 1n })).instruction, [f.trader], 'OrderFeeChanged');
    const first = await open(env, f, 'ETH', { collateral: usdc('100'), size, maxFee: f1 });
    const r = env.ok(first.instruction, [f.trader]);
    assert.deepEqual([r.events[0]?.name, n(r.events[0]!.data.fee as object), n(r.events[0]!.data.orderFeeUsdc as object), r.events[0]!.data.orderFeeBps], ['orderRequested', f1, RATE.feeUsdc, RATE.feeBps]);
    assert.equal(feeOf(env, f, first.order), f1);
    assert.equal(env.usdcBalance(f.ownerUsdc), usdc('400'), 'the fee stays in the account: nothing moves at placement');

    // $1,000 more: fee 500,000 + 700,000. Collateral + its fee + the held 1,364,197 must fit in the 400 USDC left.
    const f2 = 1_200_000n;
    const exact = usdc('400') - f2 - f1;
    env.fails((await open(env, f, 'BTC', { collateral: exact + 1n, size: 1_000n * USD })).instruction, [f.trader], 'CollateralExceedsBalance');
    const second = await open(env, f, 'BTC', { collateral: exact, size: 1_000n * USD });
    env.ok(second.instruction, [f.trader]);
    assert.equal(env.usdcBalance(f.ownerUsdc), f1 + f2);
    assert.deepEqual([fees(env, f).held, fees(env, f).due], [f1 + f2, 0n]);

    // Adding margin (size 0) is free and not limited by held fees.
    const margin = await open(env, f, 'ETH', { collateral: f1 + f2, size: 0n, maxFee: 0n });
    const rm = env.ok(margin.instruction, [f.trader]);
    assert.equal(n(rm.events[0]!.data.fee as object), 0n);
    assert.equal(feeOf(env, f, margin.order), 0n);
    assert.equal(env.usdcBalance(f.ownerUsdc), 0n);
    assert.equal(env.usdcBalance(feeVaultPda()), usdc('79'), 'only the evaluation fee is in the fee vault');
  });

  it("a close, take profit and stop loss pay flat + bps up to the account's exposure cap and hold nothing, a risk close on an active account too", async () => {
    const { env, f } = await setUp();
    await filled(env, f, 'SOL', 1_000n * USD, usdc('100'));
    const openFee = 1_200_000n;
    assert.deepEqual([fees(env, f).due, fees(env, f).held], [openFee, openFee], 'the executed open is due at sync');
    env.setUsdcBalance(f.ownerUsdc, 0n); // no free USDC: decreases never need any

    const closeFee = 500_000n + 280_000n; // $400
    env.fails((await close(env, f, 'SOL', { size: 400n * USD, maxFee: closeFee - 1n })).instruction, [f.trader], 'OrderFeeChanged');
    const c = await close(env, f, 'SOL', { size: 400n * USD, maxFee: closeFee });
    const rc = env.ok(c.instruction, [f.trader]);
    assert.deepEqual([rc.events[0]?.name, n(rc.events[0]!.data.fee as object)], ['orderRequested', closeFee]);

    const allFee = 500_000n + 7_000_000n; // CLOSE_ALL counts the account's $10,000 exposure cap
    assert.equal(orderFee(RATE, CLOSE_ALL, CAP), allFee);
    const tp = await protect(env, f, 'SOL', { size: CLOSE_ALL, maxFee: allFee });
    const rt = env.ok(tp.instruction, [f.trader]);
    assert.deepEqual([rt.events[0]?.name, n(rt.events[0]!.data.fee as object), n(rt.events[0]!.data.orderFeeUsdc as object), rt.events[0]!.data.orderFeeBps], ['protectionSet', allFee, RATE.feeUsdc, RATE.feeBps]);
    const sl = await protect(env, f, 'SOL', { size: 300n * USD, type: 'stopLoss', trigger: 90n * 10n ** 11n });
    env.ok(sl.instruction, [f.trader]);
    env.fails((await protect(env, f, 'SOL', { size: 300n * USD, type: 'stopLoss', maxFee: 710_000n - 1n })).instruction, [f.trader], 'OrderFeeChanged');

    const forced = await close(env, f, 'SOL', { size: CLOSE_ALL, authority: env.risk.publicKey });
    const rf = env.ok(forced.instruction, [env.risk]);
    assert.equal(n(rf.events[0]!.data.fee as object), allFee, "a risk authority's close of an active account is assessed like the trader's");
    assert.deepEqual([feeOf(env, f, c.order), feeOf(env, f, tp.order), feeOf(env, f, sl.order), feeOf(env, f, forced.order)], [closeFee, allFee, 710_000n, allFee]);
    assert.deepEqual([fees(env, f).held, fees(env, f).due], [openFee, openFee], 'decrease fees are not held');
  });

  it('closes the free close-all paths (review probes): a take profit on an empty slot pays the flat part and covers growth', async () => {
    const { env, f } = await setUp();
    // Probe 2: a collateral-only open (free) creates the slot with nothing committed; a close-all take profit in the
    // same transaction is still assessed on the position limit, not on the empty slot.
    const margin = await open(env, f, 'SOL', { collateral: usdc('100'), size: 0n });
    const tp = await protect(env, f, 'SOL', { size: CLOSE_ALL, ordersBefore: 1 });
    const r = env.ok([margin.instruction, tp.instruction], [f.trader]);
    const allFee = orderFee(RATE, CLOSE_ALL, CAP);
    assert.deepEqual(r.events.map((e) => [e.name, n(e.data.fee as object)]), [['orderRequested', 0n], ['protectionSet', allFee]]);
    // The trader opens $2,000 on the slot and moves the trigger: the update re-assesses at the current rate.
    env.ok((await open(env, f, 'SOL', { collateral: usdc('100'), size: 2_000n * USD })).instruction, [f.trader]);
    const move = await env.vault.updateOrder({ trader: f.trader.publicKey, funded: env.funded(f.funded), order: tp.order, triggerPrice: 101n * 10n ** 11n, maxFee: allFee });
    const ru = env.ok(move, [f.trader]);
    assert.deepEqual([ru.events[0]?.name, n(ru.events[0]!.data.fee as object)], ['orderUpdated', allFee]);
    assert.ok(orderFee(RATE, 2_000n * USD) <= feeOf(env, f, tp.order), 'the fee held on the order covers what it can close');

    // Probe 1: a close-all take profit placed on a $10 position that then grows to $2,010 still carries a fee that
    // covers the grown position; the keeper charges the rate on what it closed, the rest is waived.
    const g = await env.activeFunded();
    env.svm.airdrop(g.owner, 1_000_000_000n);
    const small = await filled(env, g, 'SOL', 10n * USD, usdc('10'));
    const tp2 = await protect(env, g, 'SOL', { size: CLOSE_ALL });
    env.ok(tp2.instruction, [g.trader]);
    assert.equal(feeOf(env, g, tp2.order), allFee);
    const grow = await open(env, g, 'SOL', { collateral: usdc('100'), size: 2_000n * USD });
    env.ok(grow.instruction, [g.trader]);
    env.executeOrder(grow.order, gmOrderEscrow(grow.order));
    env.executeOrder(tp2.order, gmOrderEscrow(tp2.order)); // the take profit fired on the whole $2,010
    env.setPosition(small.position, 0n, 0n);
    await sync(env, g);
    const owed = orderFee(RATE, 10n * USD) + orderFee(RATE, 2_000n * USD) + orderFee(RATE, 2_010n * USD);
    const due = fees(env, g).due;
    assert.equal(due, orderFee(RATE, 10n * USD) + orderFee(RATE, 2_000n * USD) + allFee);
    const rs = env.ok(await settle(env, g, owed, due - owed), [env.risk]);
    assert.deepEqual([n(rs.events[0]!.data.charged as object), fees(env, g).due, fees(env, g).paid], [owed, 0n, owed]);
  });

  it('update_order re-assesses every update at the current rate; a limit increase must fit a higher fee', async () => {
    const { env, f } = await setUp();
    const limit = await open(env, f, 'ETH', { collateral: usdc('100'), size: 1_000n * USD, limit: 2_000n * 10n ** 11n });
    env.ok(limit.instruction, [f.trader]);
    assert.equal(feeOf(env, f, limit.order), 1_200_000n);
    const update = (order: PublicKey, p: { triggerPrice?: bigint; sizeDeltaUsd?: bigint; maxFee?: bigint }) =>
      env.vault.updateOrder({ trader: f.trader.publicKey, funded: env.funded(f.funded), order, ...p });

    // To $2,000: fee 1,900,000; held after = 1,900,000 (this order is the only fee held).
    env.setUsdcBalance(f.ownerUsdc, 1_899_999n);
    env.fails(await update(limit.order, { sizeDeltaUsd: 2_000n * USD }), [f.trader], 'CollateralExceedsBalance');
    env.setUsdcBalance(f.ownerUsdc, 1_900_000n);
    env.fails(await update(limit.order, { sizeDeltaUsd: 2_000n * USD, maxFee: 1_899_999n }), [f.trader], 'OrderFeeChanged');
    const r = env.ok(await update(limit.order, { sizeDeltaUsd: 2_000n * USD, maxFee: 1_900_000n }), [f.trader]);
    assert.deepEqual([n(r.events[0]!.data.fee as object), n(r.events[0]!.data.orderFeeUsdc as object), r.events[0]!.data.orderFeeBps], [1_900_000n, RATE.feeUsdc, RATE.feeBps]);
    env.setUsdcBalance(f.ownerUsdc, 0n);
    env.ok(await update(limit.order, { sizeDeltaUsd: 500n * USD }), [f.trader]); // a lower fee needs no USDC
    assert.equal(feeOf(env, f, limit.order), 850_000n);

    // A take profit resized with no USDC at all; then the rate changes and a trigger-only update re-assesses it.
    env.setUsdcBalance(f.ownerUsdc, usdc('400'));
    await filled(env, f, 'SOL', 1_000n * USD, usdc('100'));
    env.setUsdcBalance(f.ownerUsdc, 0n);
    const tp = await protect(env, f, 'SOL', { size: 300n * USD });
    env.ok(tp.instruction, [f.trader]);
    env.ok(await update(tp.order, { sizeDeltaUsd: 500n * USD }), [f.trader]);
    assert.equal(feeOf(env, f, tp.order), 850_000n);
    env.ok(await env.vault.setOrderFee({ admin: env.admin.publicKey, feeUsdc: 1_000_000n, feeBps: 10 }), [env.admin]);
    env.fails(await update(tp.order, { triggerPrice: 160n * 10n ** 11n, maxFee: 850_000n }), [f.trader], 'OrderFeeChanged');
    const rt = env.ok(await update(tp.order, { triggerPrice: 160n * 10n ** 11n, maxFee: 1_500_000n }), [f.trader]);
    assert.deepEqual([n(rt.events[0]!.data.fee as object), n(rt.events[0]!.data.orderFeeUsdc as object), rt.events[0]!.data.orderFeeBps], [1_500_000n, 1_000_000n, 10]);
    assert.equal(feeOf(env, f, tp.order), 1_500_000n);
  });

  it("a decrease is assessed on the account's exposure cap, whatever the market limit was, is or becomes (audit fixes)", async () => {
    const caps = { feeUsdc: 2_000_000n, feeBps: 10 };
    const { env, f } = await setUp(caps);
    const setLimit = async (usd: string) =>
      env.ok(await env.vault.upsertMarket({ admin: env.admin.publicKey, marketToken: MARKETS.SOL.token, params: marketParams('SOL', LEVERAGE.crypto, { maxPositionUsd: usdc(usd), maxTotalOiUsd: usdc('100000') }) }), [env.admin]);
    const capFee = orderFee(caps, CLOSE_ALL, CAP); // $2 + 10 bps of the 10K account's $10,000 cap = 12 USDC
    await setLimit('2000');
    const { position } = await filled(env, f, 'SOL', 1_000n * USD, usdc('100'));
    // Placed under a $2,000 limit, a close-all take profit still counts the $10,000 the position may reach.
    const tp = await protect(env, f, 'SOL', { size: CLOSE_ALL, maxFee: capFee });
    env.ok(tp.instruction, [f.trader]);
    assert.equal(feeOf(env, f, tp.order), capFee);
    // A limit lowered below the position: a close of all of it counts all of it, not the $500 limit.
    await setLimit('500');
    const c = await close(env, f, 'SOL', { size: 1_000n * USD, maxFee: orderFee(caps, 1_000n * USD) });
    env.ok(c.instruction, [f.trader]);
    assert.equal(feeOf(env, f, c.order), orderFee(caps, 1_000n * USD));
    env.ok(await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order: c.order }), [f.trader]);
    // A limit raised above what the account can hold ($10,001 fails): the position grows to its $10,000 cap and the
    // resting take profit's fee covers the rate on all of it; a new one counts the cap, not the $50,000 limit.
    await setLimit('50000');
    env.fails((await open(env, f, 'SOL', { collateral: usdc('380'), size: 9_001n * USD })).instruction, [f.trader], 'ExposureTooHigh');
    const grow = await open(env, f, 'SOL', { collateral: usdc('380'), size: 9_000n * USD });
    env.ok(grow.instruction, [f.trader]);
    env.executeOrder(grow.order, gmOrderEscrow(grow.order));
    env.setPosition(position, 10_000n * USD, usdc('480'));
    await sync(env, f);
    assert.equal(feeOf(env, f, tp.order), orderFee(caps, 10_000n * USD), 'the assessed fee covers the $10,000 it can close');
    const sl = await protect(env, f, 'SOL', { size: CLOSE_ALL, type: 'stopLoss', trigger: 90n * 10n ** 11n });
    env.ok(sl.instruction, [f.trader]);
    assert.equal(feeOf(env, f, sl.order), capFee);

    // A 25K account (cap $25,000) counts its own cap, also above a $10,000 market limit.
    await setLimit('10000');
    const g = await env.activeFunded(env.wallet(), TIERS.t25k.id);
    env.svm.airdrop(g.owner, 1_000_000_000n);
    await filled(env, g, 'SOL', 1_000n * USD, usdc('100'));
    const gtp = await protect(env, g, 'SOL', { size: CLOSE_ALL });
    env.ok(gtp.instruction, [g.trader]);
    assert.equal(feeOf(env, g, gtp.order), orderFee(caps, CLOSE_ALL, 25_000n * USD));
  });

  it('a risk authority close is assessed like the trader\'s own close unless the account is breached (the session guard is not free)', async () => {
    const { env, f } = await setUp();
    // A session-restricted market (NVDA): the keeper's session guard closes an over-levered position of an active account.
    await filled(env, f, 'NVDA', 1_000n * USD, usdc('200'));
    const allFee = orderFee(RATE, CLOSE_ALL, CAP);
    const guard = await close(env, f, 'NVDA', { size: CLOSE_ALL, authority: env.risk.publicKey });
    const r = env.ok(guard.instruction, [env.risk]);
    assert.deepEqual([r.events[0]?.name, n(r.events[0]!.data.fee as object), feeOf(env, f, guard.order)], ['orderRequested', allFee, allFee]);
    env.fails(await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order: guard.order }), [f.trader], 'Unauthorized');
    env.fails((await close(env, f, 'NVDA', { size: CLOSE_ALL, authority: env.risk.publicKey, maxFee: allFee - 1n })).instruction, [env.risk], 'OrderFeeChanged');
    // Restricted (a GMTrade upgrade): still assessed. Breached: free, since the account's USDC all returns to the vault.
    env.ok(await env.vault.restrict({ riskAuthority: env.risk.publicKey, funded: f.funded, restricted: true }), [env.risk]);
    const sized = await close(env, f, 'NVDA', { size: 100n * USD, authority: env.risk.publicKey });
    env.ok(sized.instruction, [env.risk]);
    assert.equal(feeOf(env, f, sized.order), orderFee(RATE, 100n * USD));
    env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: f.funded }), [env.risk]);
    const breach = await close(env, f, 'NVDA', { size: CLOSE_ALL, authority: env.risk.publicKey, maxFee: 0n });
    const rb = env.ok(breach.instruction, [env.risk]);
    assert.deepEqual([n(rb.events[0]!.data.fee as object), feeOf(env, f, breach.order)], [0n, 0n]);
    // The guard's close executes: its fee is due like any decrease, for the keeper to charge on the size it closed.
    env.executeOrder(guard.order, gmOrderEscrow(guard.order));
    await sync(env, f);
    assert.equal(fees(env, f).due, 1_200_000n + allFee);
  });
});

describe('order fee: leaving the book', () => {
  it('cancel_order (trader or risk authority) releases the fee: nothing due, nothing moved', async () => {
    const { env, f } = await setUp();
    const a = await open(env, f, 'ETH', { collateral: usdc('100'), size: 1_000n * USD });
    env.ok(a.instruction, [f.trader]);
    const b = await open(env, f, 'BTC', { collateral: usdc('50'), size: 500n * USD });
    env.ok(b.instruction, [f.trader]);
    assert.equal(fees(env, f).held, 1_200_000n + 850_000n);
    const vault = env.usdcBalance(feeVaultPda());
    const r = env.ok(await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order: a.order }), [f.trader]);
    assert.equal(r.events[0]?.name, 'orderCancelled');
    env.ok(await env.vault.cancelOrder({ authority: env.risk.publicKey, funded: env.funded(f.funded), order: b.order }), [env.risk]);
    assert.deepEqual(fees(env, f), { orders: Array(8).fill(0n), due: 0n, paid: 0n, held: 0n });
    assert.equal(env.usdcBalance(f.ownerUsdc), usdc('500'), 'collateral back, no fee taken');
    assert.equal(env.usdcBalance(feeVaultPda()), vault);
  });

  it('sync makes the fee of an order that left the book due; a finished order keeps it until close_completed_order', async () => {
    const { env, f } = await setUp();
    const a = await open(env, f, 'ETH', { collateral: usdc('100'), size: 1_000n * USD });
    env.ok(a.instruction, [f.trader]);
    const b = await open(env, f, 'ETH', { collateral: usdc('100'), size: 2_000n * USD });
    env.ok(b.instruction, [f.trader]);
    const c = await open(env, f, 'ETH', { collateral: usdc('50'), size: 500n * USD });
    env.ok(c.instruction, [f.trader]);
    env.executeOrder(a.order, gmOrderEscrow(a.order)); // executed (or cancelled by the exchange): the account is gone
    const leaveOpen = (order: PublicKey, state: number) => {
      const acc = env.svm.getAccount(order)!;
      const data = Buffer.from(acc.data);
      data[9] = state; // GMTrade ActionState: 1 completed, 2 cancelled; the account left open
      env.svm.setAccount(order, { ...acc, data });
    };
    leaveOpen(b.order, 1);
    leaveOpen(c.order, 2);
    env.setPosition(gmPositionPda(f.owner, MARKETS.ETH.token, true), 3_000n * USD, usdc('200'));
    await sync(env, f);
    const fb = 500_000n + 1_400_000n;
    const fc = 500_000n + 350_000n;
    assert.deepEqual([fees(env, f).due, feeOf(env, f, b.order), feeOf(env, f, c.order)], [1_200_000n, fb, fc]);
    const r = env.ok(await env.vault.closeCompletedOrder({ funded: f.funded, order: b.order }), [env.risk]);
    assert.deepEqual([r.events[0]?.name, r.events[0]!.data.cancelled], ['completedOrderClosed', false]);
    assert.deepEqual([fees(env, f).due, feeOf(env, f, c.order)], [1_200_000n + fb, fc]);
    // The exchange cancelled c (it never executed): its fee is released, as by cancel_order, not made due.
    const rc = env.ok(await env.vault.closeCompletedOrder({ funded: f.funded, order: c.order }), [env.risk]);
    assert.deepEqual([rc.events[0]?.name, rc.events[0]!.data.cancelled], ['completedOrderClosed', true]);
    assert.deepEqual([fees(env, f).due, fees(env, f).orders], [1_200_000n + fb, Array(8).fill(0n)]);
  });

  it('a liquidation charges nothing: the take profit and stop loss the exchange cancels with it are waived', async () => {
    const { env, f } = await setUp();
    const { position } = await filled(env, f, 'SOL', 1_000n * USD, usdc('100'));
    const tp = await protect(env, f, 'SOL', { size: CLOSE_ALL });
    const sl = await protect(env, f, 'SOL', { size: CLOSE_ALL, type: 'stopLoss', trigger: 90n * 10n ** 11n, ordersBefore: 1 });
    env.ok([tp.instruction, sl.instruction], [f.trader]);
    env.remove(position); // liquidated
    for (const o of [tp, sl]) env.executeOrder(o.order, gmOrderEscrow(o.order)); // the exchange cancels both
    await sync(env, f);
    const allFee = orderFee(RATE, CLOSE_ALL, CAP);
    assert.equal(fees(env, f).due, 1_200_000n + 2n * allFee);
    const balance = env.usdcBalance(f.ownerUsdc);
    const r = env.ok(await settle(env, f, 1_200_000n, 2n * allFee), [env.risk]);
    assert.deepEqual([r.events[0]?.name, n(r.events[0]!.data.charged as object), n(r.events[0]!.data.waived as object)], ['orderFeesSettled', 1_200_000n, 2n * allFee]);
    assert.equal(env.usdcBalance(f.ownerUsdc), balance - 1_200_000n, 'only the executed open was charged');
  });
});

describe('order fee: settle_order_fees', () => {
  it('moves exactly the charge to the fee vault within the fees due and the USDC, once, signed by a risk authority', async () => {
    const { env, f } = await setUp();
    await filled(env, f, 'SOL', 1_000n * USD, usdc('100'));
    await filled(env, f, 'ETH', 2_000n * USD, usdc('100'));
    const due = 1_200_000n + 1_900_000n;
    assert.equal(fees(env, f).due, due);
    const stranger = env.wallet();
    env.fails(await settle(env, f, 1n, 0n, due, f.trader.publicKey), [f.trader], 'Unauthorized');
    env.fails(await settle(env, f, 1n, 0n, due, stranger.publicKey), [stranger], 'Unauthorized');
    env.fails(await settle(env, f, 1n, 0n, due, env.admin.publicKey), [env.admin], 'Unauthorized');
    env.fails(await settle(env, f, 0n, 0n), [env.risk], 'InvalidAmount');
    env.fails(await settle(env, f, due, 1n), [env.risk], 'InvalidFeeSettlement');
    env.fails(await settle(env, f, 1n, 0n, due - 1n), [env.risk], 'InvalidFeeSettlement');
    const balance = env.usdcBalance(f.ownerUsdc);
    env.setUsdcBalance(f.ownerUsdc, 1_199_999n);
    env.fails(await settle(env, f, 1_200_000n, 0n), [env.risk], 'InvalidFeeSettlement');
    env.setUsdcBalance(f.ownerUsdc, balance);

    const vault = env.usdcBalance(feeVaultPda());
    env.fails(await settle(env, f, 1_200_000n, 0n, due, env.risk.publicKey, 1n), [env.risk], 'InvalidFeeSettlement'); // another count
    const first = await settle(env, f, 1_200_000n, 0n);
    const r = env.ok(first, [env.risk]);
    assert.deepEqual(r.events.map((e) => e.name), ['orderFeesSettled']);
    const e = r.events[0]!.data;
    assert.ok((e.funded as PublicKey).equals(f.funded) && (e.by as PublicKey).equals(env.risk.publicKey));
    assert.deepEqual([e.charged, e.waived, e.orderFeesDue, e.orderFeesPaid].map((v) => n(v as object)), [1_200_000n, 0n, 1_900_000n, 1_200_000n]);
    assert.equal(env.usdcBalance(f.ownerUsdc), balance - 1_200_000n);
    assert.equal(env.usdcBalance(feeVaultPda()), vault + 1_200_000n);
    assert.equal(settlements(env, f), 1n);
    env.fails(first, [env.risk], 'InvalidFeeSettlement'); // replayed: the fees due and the count moved on

    // A waive-only settlement moves nothing and calls no token program.
    const w = env.ok(await settle(env, f, 0n, 1_900_000n), [env.risk]);
    assert.ok(!w.logs.some((l) => l.includes(TOKEN_PROGRAM_ID.toBase58())), 'no token CPI');
    assert.deepEqual([fees(env, f).due, fees(env, f).paid, env.usdcBalance(f.ownerUsdc), env.usdcBalance(feeVaultPda())], [0n, 1_200_000n, balance - 1_200_000n, vault + 1_200_000n]);
    assert.equal(settlements(env, f), 2n);
    env.fails(await settle(env, f, 0n, 1n), [env.risk], 'InvalidFeeSettlement');
  });

  it('lands once: re-sent after the fees due return to the value it was computed from, it fails (audit fix)', async () => {
    const { env, f } = await setUp();
    await filled(env, f, 'SOL', 1_000n * USD, usdc('100'));
    const due = fees(env, f).due;
    const first = await settle(env, f, due, 0n);
    env.ok(first, [env.risk]);
    assert.deepEqual([fees(env, f).due, fees(env, f).paid, settlements(env, f)], [0n, due, 1n]);
    // The next order of the same size is cancelled by the exchange: its collateral comes back and the same fee is due.
    const again = await open(env, f, 'ETH', { collateral: usdc('100'), size: 1_000n * USD });
    env.ok(again.instruction, [f.trader]);
    env.executeOrder(again.order, gmOrderEscrow(again.order));
    env.setUsdcBalance(f.ownerUsdc, env.usdcBalance(f.ownerUsdc) + usdc('100'));
    await sync(env, f);
    assert.equal(fees(env, f).due, due, 'order_fees_due is back to the value the first settlement was computed from');
    const balance = env.usdcBalance(f.ownerUsdc);
    env.fails(first, [env.risk], 'InvalidFeeSettlement'); // the keeper re-sends it (fresh blockhash)
    env.fails(await settle(env, f, 0n, due, due, env.risk.publicKey, 0n), [env.risk], 'InvalidFeeSettlement'); // a waive from the old read
    assert.deepEqual([env.usdcBalance(f.ownerUsdc), fees(env, f).paid, settlements(env, f)], [balance, due, 1n], 'nothing charged twice');
    env.ok(await settle(env, f, 0n, due), [env.risk]); // the cancelled order's fee, waived against the current count
    assert.deepEqual([fees(env, f).due, fees(env, f).paid, settlements(env, f)], [0n, due, 2n]);
  });

  it('pays only the fee vault from only this account, and works restricted, breached and paused, not once closed', async () => {
    const { env, f } = await setUp();
    const g = await env.activeFunded();
    await filled(env, f, 'SOL', 1_000n * USD, usdc('100'));
    const ix = await settle(env, f, 100n, 0n);
    const stranger = env.wallet();
    const strangerUsdc = env.setUsdc(stranger.publicKey, 0n);
    env.fails(swapKey(ix, feeVaultPda(), capitalVaultAddress()), [env.risk], 'ConstraintSeeds');
    env.fails(swapKey(ix, feeVaultPda(), strangerUsdc), [env.risk], 'ConstraintSeeds');
    env.fails(swapKey(ix, f.ownerUsdc, g.ownerUsdc), [env.risk], 'ConstraintTokenOwner');
    env.fails(swapKey(swapKey(ix, f.ownerUsdc, g.ownerUsdc), f.owner, g.owner), [env.risk], 'ConstraintSeeds');
    env.fails(swapKey(ix, f.funded, g.funded), [env.risk], 'ConstraintSeeds');
    env.fails(swapKey(ix, TOKEN_PROGRAM_ID, SystemProgram.programId), [env.risk], 'InvalidProgramId');
    env.fails(swapKey(ix, USDC_MINT, Keypair.generate().publicKey), [env.risk], 'AccountNotInitialized');
    assert.equal(env.usdcBalance(strangerUsdc), 0n);

    env.ok(await env.vault.restrict({ riskAuthority: env.risk.publicKey, funded: f.funded, restricted: true }), [env.risk]);
    env.ok(await settle(env, f, 100n, 0n), [env.risk]);
    env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: f.funded }), [env.risk]);
    env.ok(await env.vault.setPauses({ admin: env.admin.publicKey, paused: { newEvaluations: true, trading: true, payouts: true } }), [env.admin]);
    env.ok(await settle(env, f, 100n, 0n), [env.risk]);
    env.ok(await env.vault.setPauses({ admin: env.admin.publicKey, paused: { newEvaluations: false, trading: false, payouts: false } }), [env.admin]);

    // Closed: the account's USDC is gone, and a USDC account a stranger re-creates for the owner does not reopen it.
    env.remove(gmPositionPda(f.owner, MARKETS.SOL.token, true));
    await sync(env, f);
    const rest = fees(env, f).due;
    env.ok([await settle(env, f, 0n, rest), await env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded) })], [env.risk]);
    assert.equal(env.status(f.funded), 'closed');
    env.fails(await settle(env, f, 0n, 1n, 0n), [env.risk], 'AccountNotInitialized');
    env.ok(createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, f.ownerUsdc, f.owner, USDC_MINT), [stranger]);
    env.fails(await settle(env, f, 0n, 1n, 0n), [env.risk], 'InvalidAccountStatus');
  });
});

describe('order fee: payout and closure', () => {
  it('request_payout waits for the fees due; the profit is net of the fees charged', async () => {
    const { env, f } = await setUp();
    const { position } = await filled(env, f, 'SOL', 1_000n * USD, usdc('100'));
    const c = await close(env, f, 'SOL', { size: CLOSE_ALL });
    env.ok(c.instruction, [f.trader]);
    env.executeOrder(c.order, gmOrderEscrow(c.order));
    env.remove(position);
    env.setUsdcBalance(f.ownerUsdc, usdc('700')); // +200 realized
    await sync(env, f);
    const allFee = orderFee(RATE, CLOSE_ALL, CAP);
    assert.equal(fees(env, f).due, 1_200_000n + allFee);
    const request = async () => env.vault.requestPayout({ trader: f.trader.publicKey, funded: f.funded, payoutSeq: env.account('fundedAccount', f.funded).payoutSeq });
    env.fails(await request(), [f.trader], 'FeesDue');
    // Switching the rate off does not clear fees already due: only a settlement does (design §9, the rate gate).
    env.ok(await env.vault.setOrderFee({ admin: env.admin.publicKey, feeUsdc: 0n, feeBps: 0 }), [env.admin]);
    env.fails(await request(), [f.trader], 'FeesDue');

    // The keeper charges the open and the close on the $1,000 it closed, and waives the rest of the close's fee.
    const charged = 1_200_000n + orderFee(RATE, 1_000n * USD);
    env.ok(await settle(env, f, charged, allFee - orderFee(RATE, 1_000n * USD)), [env.risk]);
    env.ok(await request(), [f.trader]);
    const p = env.account('payoutRequest', payoutPda(f.funded, 0));
    assert.deepEqual([n(p.balanceAtRequest), n(p.profit), n(p.traderAmount)], [usdc('700') - charged, usdc('200') - charged, ((usdc('200') - charged) * 8000n) / 10_000n]);
  });

  it('close_funded waits for the fees due; settle + close in one transaction moves exact amounts', async () => {
    const { env, f } = await setUp();
    const { position } = await filled(env, f, 'SOL', 1_000n * USD, usdc('100'));
    env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: f.funded }), [env.risk]);
    const forced = await close(env, f, 'SOL', { size: CLOSE_ALL, authority: env.risk.publicKey });
    env.ok(forced.instruction, [env.risk]);
    env.executeOrder(forced.order, gmOrderEscrow(forced.order));
    env.remove(position);
    env.setUsdcBalance(f.ownerUsdc, usdc('450'));
    await sync(env, f);
    assert.equal(fees(env, f).due, 1_200_000n, 'the forced close added nothing');
    const closeFunded = async () => env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded) });
    env.fails(await closeFunded(), [env.risk], 'FeesDue');
    const [vault, capital] = [env.usdcBalance(feeVaultPda()), env.usdcBalance(capitalVaultAddress())];
    const r = env.ok([await settle(env, f, 1_200_000n, 0n), await closeFunded()], [env.risk]);
    assert.deepEqual(r.events.map((e) => e.name), ['orderFeesSettled', 'accountClosed']);
    assert.equal(env.usdcBalance(feeVaultPda()), vault + 1_200_000n);
    assert.equal(env.usdcBalance(capitalVaultAddress()), capital + usdc('450') - 1_200_000n);
    assert.deepEqual([fees(env, f).due, fees(env, f).paid], [0n, 1_200_000n]);
  });
});

describe('order fee: off', () => {
  it('at rate 0 a whole round assesses nothing, makes nothing due and moves nothing to the fee vault', async () => {
    const { env, f } = await setUp({ feeUsdc: 0n, feeBps: 0 });
    const { position } = await filled(env, f, 'SOL', 1_000n * USD, usdc('100'));
    const tp = await protect(env, f, 'SOL', { size: CLOSE_ALL, maxFee: 0n });
    const sl = await protect(env, f, 'SOL', { size: CLOSE_ALL, type: 'stopLoss', trigger: 90n * 10n ** 11n, maxFee: 0n, ordersBefore: 1 });
    const r = env.ok([tp.instruction, sl.instruction], [f.trader]);
    const limit = await open(env, f, 'ETH', { collateral: usdc('50'), size: 500n * USD, limit: 2_000n * 10n ** 11n, maxFee: 0n });
    r.events.push(...env.ok(limit.instruction, [f.trader]).events);
    assert.deepEqual(r.events.map((e) => n(e.data.fee as object)), [0n, 0n, 0n]);
    env.ok(await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order: limit.order }), [f.trader]);
    env.executeOrder(tp.order, gmOrderEscrow(tp.order));
    env.executeOrder(sl.order, gmOrderEscrow(sl.order));
    env.remove(position);
    await sync(env, f);
    assert.deepEqual(fees(env, f), { orders: Array(8).fill(0n), due: 0n, paid: 0n, held: 0n });
    assert.equal(env.usdcBalance(feeVaultPda()), usdc('79'));
    env.ok(await env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded) }), [env.risk]);
  });
});
