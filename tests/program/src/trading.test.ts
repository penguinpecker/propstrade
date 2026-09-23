import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import {
  CLOSE_ALL,
  USDC_MINT,
  enumName,
  gmOrderEscrow,
  gmOrderPda,
  gmPositionPda,
  marketConfigPda,
  orderNonce,
} from '@props/sdk';
import { Env, LEVERAGE, MAINNET_POSITIONS, MARKETS, USD, marketParams, swapKey, usdc } from './env.ts';
import type { MarketName } from './env.ts';

const HIGH = 10n ** 30n; // acceptable price for buys: no protection needed in these tests
const LOW = 1n; // acceptable price for sells

/** GMTrade OrderKind representation. */
const GM_KIND = { marketIncrease: 3, marketDecrease: 4, limitIncrease: 6, limitDecrease: 7, stopLossDecrease: 8 };

type Funded = Awaited<ReturnType<Env['activeFunded']>>;

async function open(
  env: Env,
  f: Funded,
  market: MarketName,
  p: { isLong?: boolean; collateral: string; size: string; orderType?: 'market' | 'limit'; trigger?: bigint; acceptable?: bigint; signer?: Keypair },
) {
  const isLong = p.isLong ?? true;
  const { instruction, order } = await env.vault.openPosition({
    trader: (p.signer ?? f.trader).publicKey,
    funded: env.funded(f.funded),
    marketToken: MARKETS[market].token,
    isLong,
    orderType: p.orderType ?? 'market',
    collateral: usdc(p.collateral),
    sizeDeltaUsd: BigInt(p.size) * USD,
    triggerPrice: p.trigger,
    acceptablePrice: p.acceptable ?? (isLong ? HIGH : LOW),
  });
  return { instruction, order, position: gmPositionPda(f.owner, MARKETS[market].token, isLong) };
}

function setMarketClosed(env: Env, market: MarketName, closed: boolean): void {
  const a = env.svm.getAccount(MARKETS[market].gm)!;
  const data = Buffer.from(a.data);
  data[10] = closed ? data[10]! | (1 << 5) : data[10]! & ~(1 << 5);
  env.svm.setAccount(MARKETS[market].gm, { ...a, data });
}

async function setUp(capital?: bigint) {
  const env = new Env();
  await env.setUpVault({ capital });
  for (const m of Object.keys(MARKETS) as MarketName[]) setMarketClosed(env, m, false);
  return { env, f: await env.activeFunded() };
}

const oi = (env: Env, market: MarketName) => {
  const m = env.account('marketConfig', marketConfigPda(MARKETS[market].token));
  return { long: BigInt(m.oiLongUsd.toString()), short: BigInt(m.oiShortUsd.toString()) };
};

describe('open_position', () => {
  it('creates a GMTrade market increase owned and received by the owner PDA, within ~300k CU', async () => {
    const { env, f } = await setUp();
    const { instruction, order, position } = await open(env, f, 'SOL', { collateral: '100', size: '1000' });
    const r = env.ok(instruction, [f.trader]);
    assert.ok(r.cu < 300_000n, `open used ${r.cu} CU`);
    assert.equal(r.events[0]?.name, 'orderRequested');

    const o = env.gm('Order', order);
    for (const k of ['owner', 'receiver', 'rent_receiver'] as const) assert.ok(o.header[k].equals(f.owner), `order ${k} must be the owner PDA`);
    assert.equal(o.params.kind, GM_KIND.marketIncrease);
    assert.ok(o.params.collateral_token.equals(USDC_MINT));
    assert.ok(o.params.position.equals(position));
    assert.equal(BigInt(o.params.initial_collateral_delta_amount.toString()), usdc('100'));
    assert.equal(BigInt(o.params.size_delta_value.toString()), 1000n * USD);
    assert.equal(BigInt(o.params.acceptable_price.toString()), HIGH);
    assert.equal(env.usdcBalance(gmOrderEscrow(order)), usdc('100'));
    assert.equal(env.usdcBalance(f.ownerUsdc), usdc('400'));

    const pos = env.gm('Position', position);
    assert.ok(pos.owner.equals(f.owner) && pos.market_token.equals(MARKETS.SOL.token) && pos.collateral_token.equals(USDC_MINT));
    assert.equal(pos.kind, 1);

    const acc = env.account('fundedAccount', f.funded);
    const slot = acc.slots[0]!;
    assert.ok(slot.marketToken.equals(MARKETS.SOL.token) && slot.isLong && slot.gmPosition.equals(position));
    assert.equal(BigInt(slot.pendingUsd.toString()), 1000n * USD);
    assert.equal(BigInt(slot.sizeUsd.toString()), 0n);
    const tracked = acc.orders[0]!;
    assert.ok(tracked.order.equals(order));
    assert.ok(order.equals(gmOrderPda(f.owner, orderNonce(0n))), 'the program picks the nonce from its order counter');
    assert.equal(acc.orderSeq.toString(), '1');
    assert.equal(enumName(tracked.orderType), 'market');
    assert.equal(tracked.placedByRisk, false);
    assert.deepEqual(oi(env, 'SOL'), { long: 1000n * USD, short: 0n });

    const ownerInfo = env.svm.getAccount(f.owner)!;
    assert.ok(ownerInfo.owner.equals(SystemProgram.programId) && ownerInfo.data.length === 0, 'owner PDA stays data-less');
  });

  it('cannot be blocked by a stranger who pre-creates the next (predictable) order address and escrow', async () => {
    const { env, f } = await setUp();
    const griefer = env.wallet();
    const next = await open(env, f, 'SOL', { collateral: '100', size: '1000' });
    env.ok(
      [
        SystemProgram.transfer({ fromPubkey: griefer.publicKey, toPubkey: next.order, lamports: 5_000_000 }),
        createAssociatedTokenAccountIdempotentInstruction(griefer.publicKey, gmOrderEscrow(next.order), next.order, USDC_MINT),
      ],
      [griefer],
    );
    env.ok(next.instruction, [f.trader]);
    assert.equal(env.gm('Order', next.order).params.kind, GM_KIND.marketIncrease);
    assert.equal(env.usdcBalance(gmOrderEscrow(next.order)), usdc('100'));
  });

  it('needs a trigger for limits only and an acceptable price always', async () => {
    const { env, f } = await setUp();
    const limit = await open(env, f, 'BTC', { isLong: false, orderType: 'limit', collateral: '50', size: '500', trigger: 90_000n * 10n ** 12n });
    env.ok(limit.instruction, [f.trader]);
    const o = env.gm('Order', limit.order);
    assert.equal(o.params.kind, GM_KIND.limitIncrease);
    assert.equal(BigInt(o.params.trigger_price.toString()), 90_000n * 10n ** 12n);

    env.fails((await open(env, f, 'SOL', { collateral: '10', size: '100', trigger: 5n })).instruction, [f.trader], 'InvalidTriggerPrice');
    env.fails((await open(env, f, 'SOL', { collateral: '10', size: '100', orderType: 'limit' })).instruction, [f.trader], 'InvalidTriggerPrice');
    env.fails((await open(env, f, 'SOL', { collateral: '10', size: '100', acceptable: 0n })).instruction, [f.trader], 'ZeroAcceptablePrice');
    const notIncrease = await env.vault.openPosition({
      trader: f.trader.publicKey,
      funded: env.funded(f.funded),
      marketToken: MARKETS.SOL.token,
      isLong: true,
      orderType: 'close' as 'market',
      collateral: usdc('10'),
      sizeDeltaUsd: 100n * USD,
      acceptablePrice: HIGH,
    });
    env.fails(notIncrease.instruction, [f.trader], 'InvalidOrderType');
  });

  it('enforces collateral, leverage, position size and account exposure', async () => {
    const { env, f } = await setUp();
    env.fails((await open(env, f, 'SOL', { collateral: '0', size: '0' })).instruction, [f.trader], 'InvalidAmount');
    env.fails((await open(env, f, 'SOL', { collateral: '500.000001', size: '1000' })).instruction, [f.trader], 'CollateralExceedsBalance');
    env.fails((await open(env, f, 'SOL', { collateral: '10', size: '251' })).instruction, [f.trader], 'LeverageTooHigh');
    env.ok((await open(env, f, 'SOL', { collateral: '10', size: '250' })).instruction, [f.trader]); // exactly 25×
    env.fails((await open(env, f, 'NVDA', { collateral: '10', size: '81' })).instruction, [f.trader], 'LeverageTooHigh'); // stocks ≤ 8×
    env.fails((await open(env, f, 'ETH', { collateral: '450', size: '10001' })).instruction, [f.trader], 'PositionTooLarge');

    // Exposure: Σ committed size ≤ S × 1.0 = $10,000 (250 already committed on SOL).
    env.ok((await open(env, f, 'ETH', { collateral: '240', size: '6000' })).instruction, [f.trader]);
    env.fails((await open(env, f, 'BTC', { isLong: false, collateral: '160', size: '3751' })).instruction, [f.trader], 'ExposureTooHigh');
    env.ok((await open(env, f, 'BTC', { isLong: false, collateral: '160', size: '3750' })).instruction, [f.trader]);
  });

  it('caps funded open interest per market side across accounts and refuses disabled markets', async () => {
    const { env, f } = await setUp();
    const g = await env.activeFunded();
    const admin = env.admin.publicKey;
    const capped = marketParams('XAU', LEVERAGE.metals, { maxPositionUsd: usdc('2000'), maxTotalOiUsd: usdc('2000') });
    env.ok(await env.vault.upsertMarket({ admin, marketToken: MARKETS.XAU.token, params: capped }), [env.admin]);
    env.ok((await open(env, f, 'XAU', { collateral: '100', size: '1500' })).instruction, [f.trader]);
    env.fails((await open(env, g, 'XAU', { collateral: '100', size: '600' })).instruction, [g.trader], 'MarketOpenInterestCap');
    env.ok((await open(env, g, 'XAU', { collateral: '100', size: '500' })).instruction, [g.trader]);
    env.ok((await open(env, g, 'XAU', { isLong: false, collateral: '100', size: '600' })).instruction, [g.trader]);
    assert.deepEqual(oi(env, 'XAU'), { long: 2000n * USD, short: 600n * USD });

    env.ok(
      await env.vault.upsertMarket({ admin, marketToken: MARKETS.XAU.token, params: { ...capped, enabled: false } }),
      [env.admin],
    );
    env.fails((await open(env, g, 'XAU', { isLong: false, collateral: '10', size: '10' })).instruction, [g.trader], 'MarketDisabled');
    assert.deepEqual(oi(env, 'XAU'), { long: 2000n * USD, short: 600n * USD }, 'upsert keeps open interest');
  });

  it('refuses strangers, foreign positions, restricted accounts, paused trading and closed markets', async () => {
    const { env, f } = await setUp();
    const stranger = env.wallet();
    env.fails((await open(env, f, 'SOL', { collateral: '10', size: '100', signer: stranger })).instruction, [stranger], 'Unauthorized');

    const first = await open(env, f, 'SOL', { collateral: '10', size: '100' });
    env.ok(first.instruction, [f.trader]);
    const again = await open(env, f, 'SOL', { collateral: '10', size: '100' });
    env.fails(swapKey(again.instruction, again.position, MAINNET_POSITIONS.long), [f.trader], 'InvalidPositionAccount');
    const fresh = await open(env, f, 'BTC', { collateral: '10', size: '100' });
    env.fails(swapKey(fresh.instruction, fresh.position, MAINNET_POSITIONS.long), [f.trader], 'ConstraintSeeds');
    // The order address is not the trader's to choose: only the counter's next nonce is accepted.
    const chosen = gmOrderPda(f.owner, orderNonce(7n));
    env.fails(swapKey(swapKey(fresh.instruction, fresh.order, chosen), gmOrderEscrow(fresh.order), gmOrderEscrow(chosen)), [f.trader], 'ConstraintSeeds');

    const pause = (trading: boolean) => env.vault.setPauses({ admin: env.admin.publicKey, paused: { newEvaluations: false, trading, payouts: false } });
    env.ok(await pause(true), [env.admin]);
    env.fails((await open(env, f, 'SOL', { collateral: '10', size: '100' })).instruction, [f.trader], 'Paused');
    env.ok(await pause(false), [env.admin]);

    env.ok(await env.vault.restrict({ riskAuthority: env.risk.publicKey, funded: f.funded, restricted: true }), [env.risk]);
    env.fails((await open(env, f, 'SOL', { collateral: '10', size: '100' })).instruction, [f.trader], 'InvalidAccountStatus');
    env.ok(await env.vault.restrict({ riskAuthority: env.risk.publicKey, funded: f.funded, restricted: false }), [env.risk]);

    setMarketClosed(env, 'NVDA', true);
    env.fails((await open(env, f, 'NVDA', { collateral: '10', size: '50' })).instruction, [f.trader], 'MarketClosed');
    setMarketClosed(env, 'NVDA', false);
    env.ok((await open(env, f, 'NVDA', { collateral: '10', size: '50' })).instruction, [f.trader]);
  });

  it('holds at most 8 position slots and 8 tracked orders', async () => {
    const { env, f } = await setUp();
    env.svm.airdrop(f.owner, BigInt(LAMPORTS_PER_SOL)); // GMTrade rents for 8 positions + 8 orders exceed one float
    const sides: [MarketName, boolean][] = [
      ['SOL', true], ['SOL', false], ['BTC', true], ['BTC', false], ['ETH', true], ['ETH', false], ['XAU', true], ['XAU', false],
    ];
    for (const [m, isLong] of sides) env.ok((await open(env, f, m, { isLong, collateral: '5', size: '20' })).instruction, [f.trader]);
    env.fails((await open(env, f, 'EUR', { collateral: '5', size: '20' })).instruction, [f.trader], 'NoFreeSlot');
    env.fails((await open(env, f, 'SOL', { collateral: '5', size: '20' })).instruction, [f.trader], 'TooManyOrders');
    const sync = env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [f.trader]);
    assert.ok(sync.cu < 200_000n, `a full sync (8 slots, 8 orders, 4 markets) used ${sync.cu} CU`);

    // With every order slot taken, a forced close frees one first, atomically.
    const forceClose = await env.vault.closePosition({
      authority: env.risk.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true, sizeDeltaUsd: CLOSE_ALL, acceptablePrice: LOW,
    });
    env.fails(forceClose.instruction, [env.risk], 'TooManyOrders');
    const other = env.account('fundedAccount', f.funded).orders[1]!.order; // the SOL short's order
    const cancel = await env.vault.cancelOrder({ authority: env.risk.publicKey, funded: env.funded(f.funded), order: other });
    env.ok([cancel, forceClose.instruction], [env.risk]);
  });
});

/** Opens SOL long $1000 / $100 and emulates the keeper fill. */
async function filledSolLong(env: Env, f: Funded) {
  const { instruction, order, position } = await open(env, f, 'SOL', { collateral: '100', size: '1000' });
  env.ok(instruction, [f.trader]);
  env.executeOrder(order, gmOrderEscrow(order));
  env.setPosition(position, 1000n * USD, usdc('99.9'));
  env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [f.trader]);
  return position;
}

describe('close_position', () => {
  it('lets the trader and a risk authority place market decreases; pauses and restrictions never block them', async () => {
    const { env, f } = await setUp();
    await filledSolLong(env, f);
    const close = (authority: PublicKey, p: { size?: bigint; acceptable?: bigint; isLong?: boolean; market?: MarketName } = {}) =>
      env.vault.closePosition({
        authority,
        funded: env.funded(f.funded),
        marketToken: MARKETS[p.market ?? 'SOL'].token,
        isLong: p.isLong ?? true,
        sizeDeltaUsd: p.size ?? 400n * USD,
        acceptablePrice: p.acceptable ?? LOW,
      });
    const stranger = env.wallet();
    env.fails((await close(stranger.publicKey)).instruction, [stranger], 'Unauthorized');
    env.fails((await close(f.trader.publicKey, { market: 'BTC' })).instruction, [f.trader], 'NoPosition');
    env.fails((await close(f.trader.publicKey, { acceptable: 0n })).instruction, [f.trader], 'ZeroAcceptablePrice');
    env.fails((await close(f.trader.publicKey, { size: 0n })).instruction, [f.trader], 'InvalidAmount');
    env.fails((await close(f.trader.publicKey, { size: USD - 1n })).instruction, [f.trader], 'InvalidAmount'); // below GMTrade's $1 minimum

    env.ok(await env.vault.setPauses({ admin: env.admin.publicKey, paused: { newEvaluations: true, trading: true, payouts: true } }), [env.admin]);
    env.ok(await env.vault.restrict({ riskAuthority: env.risk.publicKey, funded: f.funded, restricted: true }), [env.risk]);
    const byTrader = await close(f.trader.publicKey);
    const r = env.ok(byTrader.instruction, [f.trader]);
    assert.equal(r.events[0]?.name, 'orderRequested');
    const o = env.gm('Order', byTrader.order);
    assert.equal(o.params.kind, GM_KIND.marketDecrease);
    assert.ok(o.header.owner.equals(f.owner) && o.header.receiver.equals(f.owner));

    const forced = await close(env.risk.publicKey, { size: CLOSE_ALL });
    env.ok(forced.instruction, [env.risk]);
    assert.equal(BigInt(env.gm('Order', forced.order).params.size_delta_value.toString()), CLOSE_ALL);
    const tracked = env.account('fundedAccount', f.funded).orders.find((t) => t.order.equals(forced.order))!;
    assert.equal(tracked.placedByRisk, true);
    assert.equal(enumName(tracked.orderType), 'close');

    // The trader cannot cancel a forced close; the risk authority can.
    const cancelForced = (authority: PublicKey) => env.vault.cancelOrder({ authority, funded: env.funded(f.funded), order: forced.order });
    env.fails(await cancelForced(f.trader.publicKey), [f.trader], 'Unauthorized');
    env.ok(await cancelForced(env.risk.publicKey), [env.risk]);
    assert.equal(env.exists(forced.order), false);
  });
});

describe('set_protection', () => {
  it('places take-profit and stop-loss orders for the trader only, also while paused', async () => {
    const { env, f } = await setUp();
    await filledSolLong(env, f);
    const protect = (authority: PublicKey, orderType: 'takeProfit' | 'stopLoss', triggerPrice = 150n * 10n ** 11n) =>
      env.vault.setProtection({ trader: authority, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true, orderType, triggerPrice, sizeDeltaUsd: 1000n * USD });
    env.ok(await env.vault.setPauses({ admin: env.admin.publicKey, paused: { newEvaluations: true, trading: true, payouts: true } }), [env.admin]);
    const tp = await protect(f.trader.publicKey, 'takeProfit');
    assert.equal(env.ok(tp.instruction, [f.trader]).events[0]?.name, 'protectionSet');
    const sl = await protect(f.trader.publicKey, 'stopLoss', 100n * 10n ** 11n);
    env.ok(sl.instruction, [f.trader]);
    assert.equal(env.gm('Order', tp.order).params.kind, GM_KIND.limitDecrease);
    const slOrder = env.gm('Order', sl.order);
    assert.equal(slOrder.params.kind, GM_KIND.stopLossDecrease);
    assert.equal(BigInt(slOrder.params.trigger_price.toString()), 100n * 10n ** 11n);
    assert.ok(slOrder.header.receiver.equals(f.owner));

    env.fails((await protect(env.risk.publicKey, 'stopLoss')).instruction, [env.risk], 'Unauthorized');
    env.fails((await protect(f.trader.publicKey, 'stopLoss', 0n)).instruction, [f.trader], 'InvalidTriggerPrice');
    env.fails((await protect(f.trader.publicKey, 'market' as 'stopLoss')).instruction, [f.trader], 'InvalidOrderType');
  });
});

describe('update_order', () => {
  it('updates trigger orders and re-checks limits when a limit increase is resized', async () => {
    const { env, f } = await setUp();
    await filledSolLong(env, f);
    const tp = await env.vault.setProtection({
      trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true,
      orderType: 'takeProfit', triggerPrice: 150n * 10n ** 11n, sizeDeltaUsd: 1000n * USD,
    });
    env.ok(tp.instruction, [f.trader]);
    const limit = await open(env, f, 'ETH', { orderType: 'limit', collateral: '100', size: '1000', trigger: 3000n * 10n ** 11n });
    env.ok(limit.instruction, [f.trader]);
    const market = await open(env, f, 'BTC', { collateral: '10', size: '100' });
    env.ok(market.instruction, [f.trader]);
    const update = (order: PublicKey, p: { triggerPrice?: bigint; acceptablePrice?: bigint; sizeDeltaUsd?: bigint }, trader = f.trader.publicKey) =>
      env.vault.updateOrder({ trader, funded: env.funded(f.funded), order, ...p });

    env.ok(await update(tp.order, { triggerPrice: 160n * 10n ** 11n }), [f.trader]);
    assert.equal(BigInt(env.gm('Order', tp.order).params.trigger_price.toString()), 160n * 10n ** 11n);

    env.ok(await update(limit.order, { sizeDeltaUsd: 2000n * USD }), [f.trader]);
    assert.equal(BigInt(env.gm('Order', limit.order).params.size_delta_value.toString()), 2000n * USD);
    const acc = env.account('fundedAccount', f.funded);
    const ethSlot = acc.slots.find((s) => s.marketToken.equals(MARKETS.ETH.token))!;
    assert.equal(BigInt(ethSlot.pendingUsd.toString()), 2000n * USD);
    assert.equal(oi(env, 'ETH').long, 2000n * USD);

    env.fails(await update(limit.order, { sizeDeltaUsd: 2501n * USD }), [f.trader], 'LeverageTooHigh');
    env.fails(await update(limit.order, { acceptablePrice: 0n }), [f.trader], 'ZeroAcceptablePrice');
    env.fails(await update(limit.order, {}), [f.trader], 'InvalidParams');
    env.fails(await update(market.order, { acceptablePrice: HIGH }), [f.trader], 'InvalidOrderType');
    const stranger = env.wallet();
    env.fails(await update(tp.order, { triggerPrice: 1n }, stranger.publicKey), [stranger], 'Unauthorized');

    env.ok(await env.vault.setPauses({ admin: env.admin.publicKey, paused: { newEvaluations: true, trading: true, payouts: true } }), [env.admin]);
    env.fails(await update(limit.order, { sizeDeltaUsd: 1500n * USD }), [f.trader], 'Paused');
    env.fails(await update(limit.order, { triggerPrice: 3500n * 10n ** 11n }), [f.trader], 'Paused'); // a new trigger can fill it at once
    env.ok(await update(tp.order, { triggerPrice: 170n * 10n ** 11n }), [f.trader]);
  });
});

describe('cancel_order', () => {
  it('returns escrowed USDC and rent to the owner PDA, releases exposure and open interest', async () => {
    const { env, f } = await setUp();
    const { instruction, order } = await open(env, f, 'SOL', { collateral: '100', size: '1000' });
    env.ok(instruction, [f.trader]);
    const lamportsBefore = env.lamports(f.owner);
    env.ok(await env.vault.setPauses({ admin: env.admin.publicKey, paused: { newEvaluations: true, trading: true, payouts: true } }), [env.admin]);

    const stranger = env.wallet();
    env.fails(await env.vault.cancelOrder({ authority: stranger.publicKey, funded: env.funded(f.funded), order }), [stranger], 'Unauthorized');
    const unknown = gmOrderPda(f.owner, orderNonce(99n));
    const cancel = await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order });
    env.fails(swapKey(swapKey(cancel, order, unknown), gmOrderEscrow(order), gmOrderEscrow(unknown)), [f.trader], 'OrderNotTracked');

    const r = env.ok(cancel, [f.trader]);
    assert.equal(r.events[0]?.name, 'orderCancelled');
    assert.equal(env.exists(order), false);
    assert.equal(env.exists(gmOrderEscrow(order)), false);
    assert.equal(env.usdcBalance(f.ownerUsdc), usdc('500'));
    assert.ok(env.lamports(f.owner) > lamportsBefore, 'order rent and execution fee come back to the owner PDA');
    const acc = env.account('fundedAccount', f.funded);
    assert.ok(acc.orders.every((o) => o.order.equals(PublicKey.default)));
    assert.equal(BigInt(acc.slots[0]!.pendingUsd.toString()), 0n);
    assert.deepEqual(oi(env, 'SOL'), { long: 0n, short: 0n });
    env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [f.trader]);
    assert.ok(env.account('fundedAccount', f.funded).slots.every((s) => s.marketToken.equals(PublicKey.default)), 'sync frees the idle slot');
  });
});
