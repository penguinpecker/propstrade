import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { gmOrderEscrow, gmPositionPda, marketConfigPda } from '@props/sdk';
import { Env, MAINNET_POSITIONS, MARKETS, USD, usdc } from './env.ts';
import type { MarketName } from './env.ts';

type Funded = Awaited<ReturnType<Env['activeFunded']>>;

async function openOrder(env: Env, f: Funded, market: MarketName, isLong: boolean, size: bigint, collateral: string) {
  const { instruction, order } = await env.vault.openPosition({
    trader: f.trader.publicKey,
    funded: env.funded(f.funded),
    marketToken: MARKETS[market].token,
    isLong,
    orderType: 'market',
    collateral: usdc(collateral),
    sizeDeltaUsd: size * USD,
    acceptablePrice: isLong ? 10n ** 30n : 1n,
  });
  env.ok(instruction, [f.trader]);
  return { order, position: gmPositionPda(f.owner, MARKETS[market].token, isLong) };
}

function slotOf(env: Env, f: Funded, market: MarketName, isLong: boolean) {
  return env.account('fundedAccount', f.funded).slots.find((s) => s.marketToken.equals(MARKETS[market].token) && s.isLong === isLong);
}

function oi(env: Env, market: MarketName) {
  const m = env.account('marketConfig', marketConfigPda(MARKETS[market].token));
  return { long: BigInt(m.oiLongUsd.toString()) / USD, short: BigInt(m.oiShortUsd.toString()) / USD };
}

describe('sync', () => {
  it('mirrors keeper fills, partial closes and liquidations into slots and open interest (permissionless)', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const cranker = env.wallet();
    const sync = async () => env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [cranker]);

    const long = await openOrder(env, f, 'SOL', true, 1000n, '100');
    let r = await sync();
    assert.deepEqual(r.events[0]?.data.ordersDropped, [], 'a pending order stays tracked');
    assert.equal(BigInt(slotOf(env, f, 'SOL', true)!.pendingUsd.toString()), 1000n * USD);
    assert.deepEqual(oi(env, 'SOL'), { long: 1000n, short: 0n });

    env.executeOrder(long.order, gmOrderEscrow(long.order));
    env.setPosition(long.position, 1000n * USD, usdc('99.9'));
    r = await sync();
    assert.equal(r.events[0]?.name, 'synced');
    assert.deepEqual((r.events[0]?.data.ordersDropped as PublicKey[]).map(String), [long.order.toBase58()]);
    let slot = slotOf(env, f, 'SOL', true)!;
    assert.equal(BigInt(slot.sizeUsd.toString()), 1000n * USD);
    assert.equal(BigInt(slot.collateral.toString()), usdc('99.9'));
    assert.equal(BigInt(slot.pendingUsd.toString()), 0n);
    assert.ok(Number(env.account('fundedAccount', f.funded).lastSyncAt) > 0);
    assert.deepEqual(oi(env, 'SOL'), { long: 1000n, short: 0n }, 'a fill moves exposure from pending to size');

    // Same market on both sides plus a second market: one MarketConfig per market in the remaining accounts.
    const short = await openOrder(env, f, 'SOL', false, 300n, '30');
    const btc = await openOrder(env, f, 'BTC', true, 500n, '50');
    for (const o of [short, btc]) env.executeOrder(o.order, gmOrderEscrow(o.order));
    env.setPosition(short.position, 300n * USD, usdc('30'));
    env.setPosition(btc.position, 500n * USD, usdc('50'));
    env.setPosition(long.position, 600n * USD, usdc('60')); // a partial decrease filled
    await sync();
    assert.deepEqual(oi(env, 'SOL'), { long: 600n, short: 300n });
    assert.deepEqual(oi(env, 'BTC'), { long: 500n, short: 0n });

    env.remove(long.position); // liquidated: GMTrade closed the position account
    await sync();
    assert.equal(slotOf(env, f, 'SOL', true), undefined, 'flat slot released');
    assert.deepEqual(oi(env, 'SOL'), { long: 0n, short: 300n });
    slot = slotOf(env, f, 'SOL', false)!;
    assert.equal(BigInt(slot.sizeUsd.toString()), 300n * USD);
  });

  it('keeps an order GMTrade finished but left open tracked, outside pending exposure, until it is closed', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const first = await openOrder(env, f, 'ETH', true, 400n, '40');
    const second = await openOrder(env, f, 'ETH', true, 200n, '20');
    const a = env.svm.getAccount(first.order)!;
    const data = Buffer.from(a.data);
    data[9] = 1; // ActionState::Completed, left open by the keeper
    env.svm.setAccount(first.order, { ...a, data });
    env.setPosition(first.position, 400n * USD, usdc('40'));
    const tracked = () => env.account('fundedAccount', f.funded).orders.filter((o) => !o.order.equals(PublicKey.default)).map((o) => o.order.toBase58());

    const r = env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [f.trader]);
    assert.deepEqual(r.events[0]?.data.ordersDropped, [], 'its account still exists');
    assert.deepEqual(tracked(), [first.order.toBase58(), second.order.toBase58()], 'the account is not flat while it holds an escrow');
    assert.equal(BigInt(slotOf(env, f, 'ETH', true)!.pendingUsd.toString()), 200n * USD, 'only the pending order counts as pending');
    assert.deepEqual(oi(env, 'ETH'), { long: 600n, short: 0n });

    env.ok(await env.vault.closeCompletedOrder({ funded: f.funded, order: first.order }), [f.trader]);
    assert.deepEqual(tracked(), [second.order.toBase58()]);
    env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [f.trader]);
    assert.equal(BigInt(slotOf(env, f, 'ETH', true)!.sizeUsd.toString()), 400n * USD);
    assert.deepEqual(oi(env, 'ETH'), { long: 600n, short: 0n });
  });

  it('rejects remaining accounts that do not match the account state', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const sol = await openOrder(env, f, 'SOL', true, 100n, '10');
    const btc = await openOrder(env, f, 'BTC', true, 100n, '10');
    const ix = await env.vault.sync({ funded: env.funded(f.funded) });
    const [config, funded, eventAuthority, program, ...remaining] = ix.keys;
    const withRemaining = (keys: typeof remaining) =>
      new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: [config!, funded!, eventAuthority!, program!, ...keys] });
    const [solPos, btcPos, solOrder, btcOrder, solMarket, btcMarket] = remaining;
    assert.ok(solPos!.pubkey.equals(sol.position) && btcOrder!.pubkey.equals(btc.order));

    env.fails(withRemaining(remaining.slice(0, -1)), [f.trader], 'InvalidRemainingAccounts');
    env.fails(withRemaining([...remaining, solMarket!]), [f.trader], 'InvalidRemainingAccounts');
    env.fails(withRemaining([btcPos!, solPos!, solOrder!, btcOrder!, solMarket!, btcMarket!]), [f.trader], 'InvalidRemainingAccounts');
    env.fails(withRemaining([solPos!, btcPos!, btcOrder!, solOrder!, solMarket!, btcMarket!]), [f.trader], 'InvalidRemainingAccounts');
    env.fails(withRemaining([solPos!, btcPos!, solOrder!, btcOrder!, btcMarket!, solMarket!]), [f.trader], 'InvalidRemainingAccounts');
    const foreign = { pubkey: MAINNET_POSITIONS.long, isSigner: false, isWritable: false };
    env.fails(withRemaining([foreign, btcPos!, solOrder!, btcOrder!, solMarket!, btcMarket!]), [f.trader], 'InvalidRemainingAccounts');
    const readonlyMarket = { ...btcMarket!, isWritable: false };
    env.fails(withRemaining([solPos!, btcPos!, solOrder!, btcOrder!, solMarket!, readonlyMarket]), [f.trader], 'InvalidRemainingAccounts');
    env.ok(ix, [f.trader]);
  });
});
