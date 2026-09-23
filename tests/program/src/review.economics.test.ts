// Security review (economic logic, accounting, liveness). Each test asserts the invariant the program
// should hold; a failing test is a finding. Observations are printed as TAP diagnostics.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { PublicKey } from '@solana/web3.js';
import type { TransactionInstruction } from '@solana/web3.js';
import { CLOSE_ALL, gmOrderEscrow, gmPositionPda, marketConfigPda } from '@props/sdk';
import { Env, MARKETS, USD, swapKey, usdc } from './env.ts';
import type { MarketName } from './env.ts';

const HIGH = 10n ** 30n;
const LOW = 1n;
type Funded = Awaited<ReturnType<Env['activeFunded']>>;

async function setUp() {
  const env = new Env();
  await env.setUpVault();
  for (const m of Object.keys(MARKETS) as MarketName[]) {
    const a = env.svm.getAccount(MARKETS[m].gm)!;
    const data = Buffer.from(a.data);
    data[10] = data[10]! & ~(1 << 5); // market open
    env.svm.setAccount(MARKETS[m].gm, { ...a, data });
  }
  return { env, f: await env.activeFunded() };
}

const openIx = (env: Env, f: Funded, market: MarketName, p: { isLong?: boolean; limit?: bigint; collateral: string; size: bigint }) =>
  env.vault.openPosition({
    trader: f.trader.publicKey,
    funded: env.funded(f.funded),
    marketToken: MARKETS[market].token,
    isLong: p.isLong ?? true,
    orderType: p.limit ? 'limit' : 'market',
    triggerPrice: p.limit,
    collateral: usdc(p.collateral),
    sizeDeltaUsd: p.size,
    acceptablePrice: (p.isLong ?? true) ? HIGH : LOW,
  });

/** `ix` rewritten to create its order at `address` (and that address's escrow) instead of its own. */
const atAddress = (ix: { instruction: TransactionInstruction; order: PublicKey }, address: PublicKey) =>
  swapKey(swapKey(ix.instruction, ix.order, address), gmOrderEscrow(ix.order), gmOrderEscrow(address));

const sync = async (env: Env, f: Funded) => env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [f.trader]);
const slotOf = (env: Env, f: Funded, market: MarketName, isLong: boolean) =>
  env.account('fundedAccount', f.funded).slots.find((s) => s.marketToken.equals(MARKETS[market].token) && s.isLong === isLong);
const isFlat = (env: Env, f: Funded) => {
  const a = env.account('fundedAccount', f.funded);
  return a.slots.every((s) => s.marketToken.equals(PublicKey.default)) && a.orders.every((o) => o.order.equals(PublicKey.default));
};
const oiLong = (env: Env, market: MarketName) => BigInt(env.account('marketConfig', marketConfigPda(MARKETS[market].token)).oiLongUsd.toString()) / USD;
const gmSize = (env: Env, position: PublicKey) => BigInt(env.gm('Position', position).state.size_in_usd.toString()) / USD;

/**
 * Keeper fills a $5,000 SOL long (200 USDC collateral) and closes its order account. Before anyone syncs,
 * the trader tries to place a 1-USDC BTC limit order at the SAME order address, then cancels "that"
 * order: were both accepted, the program would drop the filled SOL order and free the SOL slot, whose
 * last-synced size is still 0.
 */
async function hideFilledPosition(env: Env, f: Funded) {
  const sol = await openIx(env, f, 'SOL', { collateral: '200', size: 5_000n * USD });
  env.ok(sol.instruction, [f.trader]);
  const position = gmPositionPda(f.owner, MARKETS.SOL.token, true);
  env.executeOrder(sol.order, gmOrderEscrow(sol.order));
  env.setPosition(position, 5_000n * USD, usdc('199.8'));

  const decoy = await openIx(env, f, 'BTC', { isLong: false, limit: 90_000n * 10n ** 12n, collateral: '1', size: 10n * USD });
  const reused = env.send([atAddress(decoy, sol.order)], [f.trader]);
  const dupes = env.account('fundedAccount', f.funded).orders.filter((o) => o.order.equals(sol.order)).length;
  const cancel = env.send([await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order: sol.order })], [f.trader]);
  const synced = env.send([await env.vault.sync({ funded: env.funded(f.funded) })], [f.trader]);
  return { position, reused: reused.ok, dupes, cancelled: cancel.ok, synced: synced.ok };
}

describe('review: order-address reuse', () => {
  it('a filled GMTrade position always stays tracked (nonce reuse must not free its slot)', async (t: TestContext) => {
    const { env, f } = await setUp();
    const hide = await hideFilledPosition(env, f);
    const exposureBypass = env.send([(await openIx(env, f, 'ETH', { collateral: '280', size: 7_000n * USD })).instruction], [f.trader]);
    const forced = await env.vault.closePosition({
      authority: env.risk.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true, sizeDeltaUsd: CLOSE_ALL, acceptablePrice: LOW,
    });
    const forceClose = env.send([forced.instruction], [env.risk]);
    const observed = {
      nonceReuseAccepted: hide.reused,
      duplicateTrackedEntries: hide.dupes,
      cancelOfDecoyAccepted: hide.cancelled,
      liveGmPositionUsd: gmSize(env, hide.position),
      solSlotTracked: slotOf(env, f, 'SOL', true) !== undefined,
      solOpenInterestUsd: oiLong(env, 'SOL'),
      secondPositionPastExposureCap: exposureBypass.ok,
      riskForceCloseError: forceClose.error ?? 'ok',
    };
    t.diagnostic(JSON.stringify(observed, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    assert.equal(observed.duplicateTrackedEntries <= 1, true, 'an order address must be tracked at most once');
    assert.equal(observed.solSlotTracked, true, 'the live $5,000 SOL position must keep its slot');
    assert.equal(observed.secondPositionPastExposureCap, false, 'exposure cap is $10,000: $5,000 open + $7,000 new must be refused');
    assert.equal(observed.riskForceCloseError, 'ok', 'a risk authority must always be able to force-close a live position');
  });

  it('close_funded cannot run while a hidden position holds vault USDC', async (t: TestContext) => {
    const { env, f } = await setUp();
    const hide = await hideFilledPosition(env, f);
    env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: f.funded }), [env.risk]);
    const withPosition = env.send([await env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded), positions: [hide.position] })], [env.risk]);
    const withSlots = env.send([await env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded), positions: [] })], [env.risk]);
    const observed = {
      programSeesFlat: isFlat(env, f),
      closeWithPositionPassed: withPosition.error ?? 'ok',
      closeWithSlotPositionsOnly: withSlots.error ?? 'ok',
      statusAfter: env.status(f.funded),
      ownerUsdcExists: env.exists(f.ownerUsdc),
      collateralLeftInGmPosition: BigInt(env.gm('Position', hide.position).state.collateral_amount.toString()),
      gmPositionUsd: gmSize(env, hide.position),
    };
    t.diagnostic(JSON.stringify(observed, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    assert.equal(observed.programSeesFlat, false, 'an account with a $5,000 open position is not flat');
    assert.notEqual(observed.closeWithSlotPositionsOnly, 'ok', 'closing must not strand the position collateral');
  });

  it('update_order cannot resize a limit increase past the market leverage cap through a reused nonce', async (t: TestContext) => {
    const { env, f } = await setUp();
    // A synced $800 NVDA long at the stock cap of 8x.
    const first = await openIx(env, f, 'NVDA', { collateral: '100', size: 800n * USD });
    env.ok(first.instruction, [f.trader]);
    const position = gmPositionPda(f.owner, MARKETS.NVDA.token, true);
    env.executeOrder(first.order, gmOrderEscrow(first.order));
    env.setPosition(position, 800n * USD, usdc('99.9'));
    await sync(env, f);
    // Trader sets a take-profit that triggers at once; the keeper executes and closes it (not yet synced).
    const tp = await env.vault.setProtection({
      trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.NVDA.token, isLong: true,
      orderType: 'takeProfit', triggerPrice: 1n, sizeDeltaUsd: 1n * USD,
    });
    env.ok(tp.instruction, [f.trader]);
    env.executeOrder(tp.order, gmOrderEscrow(tp.order));
    env.setPosition(position, 799n * USD, usdc('99.9'));
    // A 20-USDC NVDA limit increase at 8x, tried at the take-profit's address, then "update the
    // take-profit" to $800 (40x).
    const limit = await openIx(env, f, 'NVDA', { limit: 100n * 10n ** 11n, collateral: '20', size: 160n * USD });
    const reuse = env.send([atAddress(limit, tp.order)], [f.trader]);
    env.ok(limit.instruction, [f.trader]);
    const resize = env.send(
      [await env.vault.updateOrder({ trader: f.trader.publicKey, funded: env.funded(f.funded), order: tp.order, sizeDeltaUsd: 800n * USD })],
      [f.trader],
    );
    const o = env.gm('Order', limit.order);
    const size = BigInt(o.params.size_delta_value.toString()) / USD;
    const collateral = BigInt(o.params.initial_collateral_delta_amount.toString());
    const observed = {
      reuseAccepted: reuse.ok,
      resizeAccepted: resize.ok,
      gmOrderKind: o.params.kind,
      gmOrderSizeUsd: size,
      gmOrderCollateralUsdc: collateral / 10n ** 6n,
      leverage: Number((size * 10n ** 6n) / collateral),
      slotPendingUsd: BigInt(slotOf(env, f, 'NVDA', true)!.pendingUsd.toString()) / USD,
      nvdaOpenInterestUsd: oiLong(env, 'NVDA'),
    };
    t.diagnostic(JSON.stringify(observed, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    assert.equal(observed.reuseAccepted, false, 'an order address is never reused');
    assert.equal(observed.resizeAccepted, false, 'the executed take-profit cannot be resized');
    assert.ok(observed.leverage <= 8, `NVDA max leverage is 8x; the pending GMTrade order is ${observed.leverage}x`);
  });
});

describe('review: new risk while paused, restricted or breached', () => {
  it('update_order refuses to re-price a pending limit increase unless trading is live and the account Active', async (t: TestContext) => {
    const { env, f } = await setUp();
    const limit = await openIx(env, f, 'ETH', { limit: 3_000n * 10n ** 11n, collateral: '100', size: 1_000n * USD });
    env.ok(limit.instruction, [f.trader]);
    const reprice = async (price: bigint) =>
      env.send([await env.vault.updateOrder({ trader: f.trader.publicKey, funded: env.funded(f.funded), order: limit.order, triggerPrice: price })], [f.trader]).ok;
    const setTrading = async (paused: boolean) =>
      env.ok(await env.vault.setPauses({ admin: env.admin.publicKey, paused: { newEvaluations: false, trading: paused, payouts: false } }), [env.admin]);

    await setTrading(true);
    const whilePaused = await reprice(4_000n * 10n ** 11n);
    await setTrading(false);
    env.ok(await env.vault.restrict({ riskAuthority: env.risk.publicKey, funded: f.funded, restricted: true }), [env.risk]);
    const whileRestricted = await reprice(4_100n * 10n ** 11n);
    env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: f.funded }), [env.risk]);
    const whileBreached = await reprice(4_200n * 10n ** 11n);
    const observed = { whilePaused, whileRestricted, whileBreached, triggerNow: BigInt(env.gm('Order', limit.order).params.trigger_price.toString()) };
    t.diagnostic(JSON.stringify(observed, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    assert.deepEqual({ whilePaused, whileRestricted, whileBreached }, { whilePaused: false, whileRestricted: false, whileBreached: false });
  });
});

describe('review: stale-sync slot release and stranded escrow', () => {
  it('cancel_order on an executed-but-unclosed increase does not free the slot of a live position', async (t: TestContext) => {
    const { env, f } = await setUp();
    const o = await openIx(env, f, 'SOL', { collateral: '100', size: 1_000n * USD });
    env.ok(o.instruction, [f.trader]);
    const position = gmPositionPda(f.owner, MARKETS.SOL.token, true);
    const a = env.svm.getAccount(o.order)!;
    const data = Buffer.from(a.data);
    data[9] = 1; // ActionState::Completed, order left open by the keeper
    env.svm.setAccount(o.order, { ...a, data });
    env.setUsdcBalance(gmOrderEscrow(o.order), 0n);
    env.setPosition(position, 1_000n * USD, usdc('99.9'));
    const cancel = env.send([await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order: o.order })], [f.trader]);
    const observed = { cancelAccepted: cancel.ok, solSlotTracked: slotOf(env, f, 'SOL', true) !== undefined, liveGmPositionUsd: gmSize(env, position), flat: isFlat(env, f) };
    t.diagnostic(JSON.stringify(observed, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    assert.equal(observed.solSlotTracked, true, 'the slot must stay while its GMTrade position is open');
  });

  it('close_funded does not strand USDC escrowed in an order GMTrade cancelled but left open', async (t: TestContext) => {
    const { env, f } = await setUp();
    const o = await openIx(env, f, 'SOL', { collateral: '100', size: 1_000n * USD });
    env.ok(o.instruction, [f.trader]);
    const a = env.svm.getAccount(o.order)!;
    const data = Buffer.from(a.data);
    data[9] = 2; // ActionState::Cancelled; the keeper's close was skipped, collateral still in escrow
    env.svm.setAccount(o.order, { ...a, data });
    await sync(env, f); // drops the order from tracking; the slot is released (position never filled)
    env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: f.funded }), [env.risk]);
    const position = gmPositionPda(f.owner, MARKETS.SOL.token, true);
    const close = env.send([await env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded), positions: [position] })], [env.risk]);
    const recover = env.send([await env.vault.closeCompletedOrder({ funded: f.funded, order: o.order })], [f.trader]);
    const observed = {
      closeFunded: close.error ?? 'ok',
      recoverAfterClose: recover.error ?? 'ok',
      usdcLeftInEscrow: env.usdcBalance(gmOrderEscrow(o.order)) / 10n ** 6n,
      orderRentLamportsLeft: env.lamports(o.order),
    };
    t.diagnostic(JSON.stringify(observed, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    assert.equal(observed.usdcLeftInEscrow, 0n, 'close_funded must not leave vault USDC in an order escrow nobody can close');
  });
});

describe('review: SOL float', () => {
  it('a restricted trader cannot place dust orders that each cost the vault an execution fee', async (t: TestContext) => {
    const { env, f } = await setUp();
    const o = await openIx(env, f, 'SOL', { collateral: '100', size: 1_000n * USD });
    env.ok(o.instruction, [f.trader]);
    const position = gmPositionPda(f.owner, MARKETS.SOL.token, true);
    env.executeOrder(o.order, gmOrderEscrow(o.order));
    env.setPosition(position, 1_000n * USD, usdc('99.9'));
    await sync(env, f);
    env.ok(await env.vault.restrict({ riskAuthority: env.risk.publicKey, funded: f.funded, restricted: true }), [env.risk]);
    const before = env.lamports(f.owner);
    let accepted = 0;
    for (let i = 0; i < 8; i++) {
      const dust = await env.vault.closePosition({ authority: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true, sizeDeltaUsd: 1n, acceptablePrice: LOW });
      if (env.send([dust.instruction], [f.trader]).ok) accepted++;
    }
    const orders = env.account('fundedAccount', f.funded).orders.filter((x) => !x.order.equals(PublicKey.default));
    const executionLamports = orders.map((x) => BigInt(env.gm('Order', x.order).header.max_execution_lamports?.toString() ?? '0'));
    const observed = { dustOrdersAccepted: accepted, sizeOfEach: '1e-20 USD', ownerLamportsSpentUpfront: before - env.lamports(f.owner), executionLamportsOffered: executionLamports };
    t.diagnostic(JSON.stringify(observed, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    assert.equal(observed.dustOrdersAccepted, 0, 'decreases of 1e-20 USD only burn the execution fee');
  });
});
