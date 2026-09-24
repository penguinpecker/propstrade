// Pinocchio port audit, round 1 (fixes apply to both builds): empty GMTrade Positions left by increases that never
// filled are closed and their SOL returns to the treasury; USDC GMTrade parks in a claimable account for the owner PDA
// can be recovered; update_order cannot shrink a take-profit or stop-loss below $1; the GMTrade post-call bounds match
// GMTrade's real costs; token accounts with malformed COption tags and program accounts with out-of-range bool or enum
// bytes are refused as Anchor's deserialization refuses them. (Refusals of the GMTrade post-call bounds: `cargo test`.)
// Round 2: update_order cannot move or grow a resting limit increase in a disabled market or above the market's current
// limits; the suites run with mainnet's rent and SIMD-0459/0460 (env.ts), and amounts that depend on rent come from it.
// Round 3: top_up_owner refills only Active accounts while trading is live, so restricting an account or pausing trading
// caps what an upgraded GMTrade can take from it at its current SOL float.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { GMTRADE_STORE, USDC_MINT, capitalVaultAddress, gmPositionPda, marketConfigPda, solTreasuryPda, tierPda } from '@props/sdk';
import { CONFIG_PARAMS, Env, LEVERAGE, MAINNET_POSITIONS, MARKETS, TIERS, USD, marketParams, swapKey, tierParams, usdc } from './env.ts';
import type { MarketName } from './env.ts';

const HIGH = 10n ** 30n; // acceptable price for buys
const LOW = 1n; // acceptable price for sells

async function vault(): Promise<Env> {
  const env = new Env();
  await env.setUpVault();
  for (const m of Object.keys(MARKETS) as MarketName[]) {
    const a = env.svm.getAccount(MARKETS[m].gm)!;
    const data = Buffer.from(a.data);
    data[10] = data[10]! & ~(1 << 5); // GMTrade market not "Closed"
    env.svm.setAccount(MARKETS[m].gm, { ...a, data });
  }
  return env;
}

/** Overwrites one byte of an account's data. */
function poke(env: Env, address: PublicKey, at: number, value: number): void {
  const a = env.svm.getAccount(address)!;
  const data = Buffer.from(a.data);
  data[at] = value;
  env.svm.setAccount(address, { ...a, data });
}

type Funded = Awaited<ReturnType<Env['activeFunded']>>;

function open(env: Env, f: Funded, market: MarketName, isLong: boolean, collateral: string, size: bigint) {
  return env.vault.openPosition({
    trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS[market].token, isLong, orderType: 'market',
    collateral: usdc(collateral), sizeDeltaUsd: size, acceptablePrice: isLong ? HIGH : LOW,
  });
}

describe('empty GMTrade positions', () => {
  it('close_empty_position returns what an increase that never filled left in its Position to the SOL treasury', async () => {
    const env = await vault();
    const treasury = solTreasuryPda();
    const treasuryBefore = env.lamports(treasury);
    const f = await env.activeFunded();
    const anyone = env.wallet();
    const closeEmpty = (position: PublicKey) => env.vault.closeEmptyPosition({ funded: f.funded, position });
    /** A $2 increase on (market, side), cancelled before any fill: GMTrade keeps the Position it prepared. */
    const openAndCancel = async (market: MarketName, isLong: boolean) => {
      const o = await open(env, f, market, isLong, '1', 2n * USD);
      env.ok(o.instruction, [f.trader]);
      env.ok(await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order: o.order }), [f.trader]);
      return gmPositionPda(f.owner, MARKETS[market].token, isLong);
    };

    const sol = await openAndCancel('SOL', true);
    env.fails(await closeEmpty(sol), [anyone], 'NotFlat'); // its slot still uses it until sync frees it
    env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [anyone]);
    const held = env.lamports(sol);
    const rent = (bytes: number) => env.svm.minimumBalanceForRentExemption(BigInt(bytes));
    // Its own rent and the liquidation reserve (one order's cost: escrow ATA and Order rent, keeper fee), at any rent rate.
    assert.equal(held, rent(680) + rent(165) + rent(2472) + 300_000n, 'rent and liquidation reserve are in the empty Position');
    env.fails(await closeEmpty(MAINNET_POSITIONS.flat), [anyone], 'InvalidPositionAccount'); // another owner's
    env.setPosition(sol, USD, 1n);
    env.fails(await closeEmpty(sol), [anyone], 'NotFlat');
    env.setPosition(sol, 0n, 0n);

    const ownerBefore = env.lamports(f.owner);
    const before = env.lamports(treasury);
    const r = env.ok(await closeEmpty(sol), [anyone]);
    assert.equal(env.exists(sol), false);
    assert.equal(env.lamports(treasury) - before, held);
    assert.equal(env.lamports(f.owner), ownerBefore, "the owner's float is untouched");
    assert.equal(r.events[0]?.name, 'emptyPositionClosed');
    assert.equal(BigInt(String(r.events[0]!.data.lamports)), held);

    // After the account closes, its remaining empty Positions are still recovered.
    const btc = await openAndCancel('BTC', false);
    env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [anyone]);
    env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: f.funded }), [env.risk]);
    env.ok(await env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded), positions: [btc] }), [env.risk]);
    assert.equal(env.status(f.funded), 'closed');
    env.ok(await closeEmpty(btc), [anyone]);
    assert.equal(env.exists(btc), false);
    assert.equal(env.lamports(f.owner), 0n);
    // Over the account's life the treasury is down only the GMTrade user account's rent (GMTrade never closes it).
    assert.equal(treasuryBefore - env.lamports(treasury), env.svm.minimumBalanceForRentExemption(520n));
  });
});

describe('USDC GMTrade parks in a claimable account for the owner PDA', () => {
  it("collect_claimable moves it to the account's USDC, or to the capital vault once the account is closed", async () => {
    const env = await vault();
    const f = await env.activeFunded();
    const anyone = env.wallet();
    /** A claimable account as GMTrade leaves it once a keeper unlocked it for the owner PDA (token authority: the store). */
    const claimable = (amount: bigint, p: { delegate?: PublicKey; authority?: PublicKey; delegated?: bigint } = {}) => {
      const address = PublicKey.unique();
      const data = Buffer.alloc(AccountLayout.span);
      AccountLayout.encode(
        {
          mint: USDC_MINT, owner: p.authority ?? GMTRADE_STORE, amount, delegateOption: 1, delegate: p.delegate ?? f.owner,
          state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: p.delegated ?? amount, closeAuthorityOption: 0,
          closeAuthority: PublicKey.default,
        },
        data,
      );
      env.svm.setAccount(address, { lamports: 2_039_280, data, owner: TOKEN_PROGRAM_ID, executable: false });
      return address;
    };
    const collect = (account: PublicKey) => env.vault.collectClaimable({ funded: env.funded(f.funded), claimable: account });

    env.fails(await collect(claimable(usdc('10'), { delegate: anyone.publicKey })), [anyone], 'NotClaimable');
    env.fails(await collect(claimable(usdc('10'), { authority: anyone.publicKey })), [anyone], 'NotClaimable');
    env.fails(await collect(claimable(usdc('10'), { delegated: 0n })), [anyone], 'InvalidAmount');
    const parked = claimable(usdc('174.68'));
    env.fails(swapKey(await collect(parked), f.ownerUsdc, env.setUsdc(anyone.publicKey, 0n)), [anyone], 'ConstraintAddress');

    const before = env.usdcBalance(f.ownerUsdc);
    const r = env.ok(await collect(parked), [anyone]);
    assert.equal(env.usdcBalance(f.ownerUsdc) - before, usdc('174.68'));
    assert.equal(env.usdcBalance(parked), 0n);
    assert.equal(r.events[0]?.name, 'claimableCollected');
    const partial = claimable(usdc('100'), { delegated: usdc('60') }); // only what the keeper unlocked moves
    env.ok(await collect(partial), [anyone]);
    assert.equal(env.usdcBalance(partial), usdc('40'));

    env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: f.funded }), [env.risk]);
    env.ok(await env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded) }), [env.risk]);
    const late = claimable(usdc('12.5'));
    const capital = env.usdcBalance(capitalVaultAddress());
    env.ok(await collect(late), [anyone]);
    assert.equal(env.usdcBalance(capitalVaultAddress()) - capital, usdc('12.5'));
    assert.equal(env.usdcBalance(late), 0n);
  });
});

describe('take-profit and stop-loss size', () => {
  it('update_order cannot shrink one below $1, the minimum set_protection and close_position enforce', async () => {
    const env = await vault();
    const f = await env.activeFunded();
    env.ok((await open(env, f, 'SOL', true, '10', 100n * USD)).instruction, [f.trader]);
    const tp = await env.vault.setProtection({
      trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true,
      orderType: 'takeProfit', triggerPrice: 150n * 10n ** 11n, sizeDeltaUsd: USD,
    });
    env.ok(tp.instruction, [f.trader]);
    const resize = (size: bigint) => env.vault.updateOrder({ trader: f.trader.publicKey, funded: env.funded(f.funded), order: tp.order, sizeDeltaUsd: size });
    env.fails(await resize(1n), [f.trader], 'InvalidAmount');
    env.fails(await resize(USD - 1n), [f.trader], 'InvalidAmount');
    env.ok(await resize(2n * USD), [f.trader]);
    assert.equal(BigInt(env.gm('Order', tp.order).params.size_delta_value.toString()), 2n * USD);
  });
});

describe('a resting limit increase after the admin changes its market', () => {
  /** A SOL long limit increase with trigger 1: it never fills until its trigger moves. */
  async function parked(collateral: string, size: bigint) {
    const env = await vault();
    const f = await env.activeFunded();
    const limit = await env.vault.openPosition({
      trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'limit',
      triggerPrice: 1n, collateral: usdc(collateral), sizeDeltaUsd: size, acceptablePrice: HIGH,
    });
    env.ok(limit.instruction, [f.trader]);
    const update = async (p: { triggerPrice?: bigint; acceptablePrice?: bigint; sizeDeltaUsd?: bigint }) =>
      env.vault.updateOrder({ trader: f.trader.publicKey, funded: env.funded(f.funded), order: limit.order, ...p });
    const setSol = async (maxLeverageBps: number, overrides: Parameters<typeof marketParams>[2] = {}) =>
      env.ok(await env.vault.upsertMarket({ admin: env.admin.publicKey, marketToken: MARKETS.SOL.token, params: marketParams('SOL', maxLeverageBps, overrides) }), [env.admin]);
    const order = () => env.gm('Order', limit.order).params;
    return { env, f, limit, update, setSol, order };
  }

  it('update_order cannot move or grow it in a market the admin disabled; cancels and protective orders still work', async () => {
    const { env, f, limit, update, setSol, order } = await parked('100', 1_000n * USD);
    const tp = await env.vault.setProtection({
      trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true,
      orderType: 'takeProfit', triggerPrice: 150n * 10n ** 11n, sizeDeltaUsd: USD,
    });
    env.ok(tp.instruction, [f.trader]);
    await setSol(LEVERAGE.crypto, { enabled: false }); // switched off, caps unchanged (runbook §5.4)
    const reopen = await env.vault.openPosition({
      trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'market',
      collateral: usdc('10'), sizeDeltaUsd: 100n * USD, acceptablePrice: HIGH,
    });
    env.fails(reopen.instruction, [f.trader], 'MarketDisabled');
    env.fails(await update({ triggerPrice: HIGH }), [f.trader], 'MarketDisabled'); // would fill at the next keeper pass
    env.fails(await update({ sizeDeltaUsd: 2_400n * USD }), [f.trader], 'MarketDisabled');
    env.fails(await update({ acceptablePrice: 10n ** 29n }), [f.trader], 'MarketDisabled');
    assert.equal(BigInt(order().trigger_price.toString()), 1n);
    assert.equal(BigInt(order().size_delta_value.toString()), 1_000n * USD);
    assert.equal(BigInt(env.account('marketConfig', marketConfigPda(MARKETS.SOL.token)).oiLongUsd.toString()), 1_000n * USD);

    env.ok(await env.vault.updateOrder({ trader: f.trader.publicKey, funded: env.funded(f.funded), order: tp.order, triggerPrice: 160n * 10n ** 11n }), [f.trader]);
    env.ok(await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order: limit.order }), [f.trader]);
  });

  it("update_order re-applies the market's current limits even when only the trigger moves", async () => {
    const { env, f, update, setSol, order } = await parked('10', 250n * USD); // 25x, the crypto cap when placed
    await setSol(50_000); // 5x
    env.fails(await update({ sizeDeltaUsd: 250n * USD }), [f.trader], 'LeverageTooHigh');
    env.fails(await update({ triggerPrice: HIGH }), [f.trader], 'LeverageTooHigh');
    env.fails(await update({ acceptablePrice: 10n ** 29n }), [f.trader], 'LeverageTooHigh');
    assert.equal(BigInt(order().trigger_price.toString()), 1n);
    await setSol(LEVERAGE.crypto, { maxPositionUsd: usdc('200') });
    env.fails(await update({ triggerPrice: HIGH }), [f.trader], 'PositionTooLarge');
    await setSol(50_000);
    env.ok(await update({ sizeDeltaUsd: 50n * USD, triggerPrice: HIGH }), [f.trader]); // 5x on 10 USDC
    assert.equal(BigInt(order().trigger_price.toString()), HIGH);
    assert.equal(BigInt(order().size_delta_value.toString()), 50n * USD);
  });
});

describe('the runtime these suites run on', () => {
  it("has mainnet's rent, and SIMD-0459 and SIMD-0460 on (Env refuses a LiteSVM without them)", () => {
    const env = new Env();
    assert.equal(env.svm.minimumBalanceForRentExemption(0n), 650_240n); // `solana rent 0 -um`: 0.00065024 SOL
    assert.equal(env.svm.minimumBalanceForRentExemption(165n), 1_488_440n); // a token account
  });
});

describe('GMTrade post-call bounds', () => {
  it("allow exactly what GMTrade's own orders cost the owner PDA", async () => {
    const env = await vault();
    const f = await env.activeFunded();
    const rent = (bytes: number) => env.svm.minimumBalanceForRentExemption(BigInt(bytes));
    const order = rent(165) + rent(2472) + 300_000n; // escrow ATA, Order account, keeper fee
    let lamports = env.lamports(f.owner);
    const spent = () => {
      const now = env.lamports(f.owner);
      const d = lamports - now;
      lamports = now;
      return d;
    };
    const first = await open(env, f, 'SOL', true, '10', 100n * USD);
    env.ok(first.instruction, [f.trader]);
    // A first increase also pays for the user account and the Position with its liquidation reserve: the whole bound.
    assert.equal(spent(), 2n * order + rent(520) + rent(680));
    env.ok((await open(env, f, 'SOL', true, '10', 100n * USD)).instruction, [f.trader]);
    assert.equal(spent(), order);
    const tp = await env.vault.setProtection({
      trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true,
      orderType: 'takeProfit', triggerPrice: 150n * 10n ** 11n, sizeDeltaUsd: USD,
    });
    env.ok(tp.instruction, [f.trader]);
    assert.equal(spent(), order);
    const usdcBefore = env.usdcBalance(f.ownerUsdc);
    env.ok(await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order: first.order }), [f.trader]);
    assert.equal(spent(), -order, 'a cancel refunds the order, never charges');
    assert.equal(env.usdcBalance(f.ownerUsdc) - usdcBefore, usdc('10'));
  });

  // Round 3: the bounds hold per call, and restricted, breached and paused accounts may still place closes and
  // protective orders, so refilled floats would let an upgraded GMTrade drain the SOL treasury one bounded call at a time.
  it('top_up_owner refills only an Active account while trading is live, so any other account risks only its float', async () => {
    const env = await vault();
    const anyone = env.wallet();
    const [min, target] = [BigInt(CONFIG_PARAMS.ownerSolMin.toString()), BigInt(CONFIG_PARAMS.ownerSolTarget.toString())];
    const drain = (owner: PublicKey) => env.svm.setAccount(owner, { ...env.svm.getAccount(owner)!, lamports: Number(min - 1n) });
    const topUp = async (funded: PublicKey) => env.vault.topUpOwner({ funded });
    const restrict = async (funded: PublicKey, restricted: boolean) =>
      env.ok(await env.vault.restrict({ riskAuthority: env.risk.publicKey, funded, restricted }), [env.risk]);
    const pauseTrading = async (trading: boolean) =>
      env.ok(await env.vault.setPauses({ admin: env.admin.publicKey, paused: { newEvaluations: false, trading, payouts: false } }), [env.admin]);

    const f = await env.activeFunded();
    drain(f.owner);
    await restrict(f.funded, true); // what the keeper does to every active account when GMTrade is upgraded
    env.fails(await topUp(f.funded), [anyone], 'InvalidAccountStatus');
    await restrict(f.funded, false);
    await pauseTrading(true); // the operator's response
    env.fails(await topUp(f.funded), [anyone], 'Paused');
    await pauseTrading(false);
    const treasury = env.lamports(solTreasuryPda());
    env.ok(await topUp(f.funded), [anyone]);
    assert.equal(env.lamports(f.owner), target);
    assert.equal(treasury - env.lamports(solTreasuryPda()), target - (min - 1n));
    drain(f.owner);
    env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: f.funded }), [env.risk]);
    env.fails(await topUp(f.funded), [anyone], 'InvalidAccountStatus');

    const g = await env.activeFunded(); // flat with 100 USDC of profit: 80 to the trader, above the 50 minimum
    env.setUsdcBalance(g.ownerUsdc, usdc('600'));
    env.ok(await env.vault.requestPayout({ trader: g.trader.publicKey, funded: g.funded, payoutSeq: 0 }), [g.trader]);
    assert.equal(env.status(g.funded), 'payoutPending');
    drain(g.owner);
    env.fails(await topUp(g.funded), [anyone], 'InvalidAccountStatus');
  });
});

describe('accounts as Anchor deserializes them', () => {
  it('refuses an SPL token account or mint with a COption tag other than None or Some', async () => {
    const env = await vault();
    const admin = env.admin.publicKey;
    const adminUsdc = env.setUsdc(admin, usdc('10'));
    // Token account: delegate, is_native and close_authority tags; mint: mint_authority and freeze_authority tags.
    for (const [address, at] of [[adminUsdc, 72], [adminUsdc, 109], [adminUsdc, 129], [USDC_MINT, 0], [USDC_MINT, 46]] as const) {
      const original = env.svm.getAccount(address)!;
      poke(env, address, at, 2);
      env.fails(await env.vault.depositCapital({ admin, amount: 1n }), [env.admin], 'InvalidAccountData');
      env.svm.setAccount(address, original);
    }
    env.ok(await env.vault.depositCapital({ admin, amount: 1n }), [env.admin]);
  });

  it('refuses a program account whose bool or enum byte is out of range', async () => {
    const env = await vault();
    const trader = env.wallet();
    env.setUsdc(trader.publicKey, usdc('1000'));
    const t50k = TIERS.t50k.id; // disabled
    const buy = await env.vault.buyEvaluation({ trader: trader.publicKey, tierId: t50k, index: 0, ...env.reviewed(t50k) });
    env.fails(buy, [trader], 'TierDisabled');
    poke(env, tierPda(t50k), 32, 2); // Tier.enabled
    env.fails(buy, [trader], 'AccountDidNotDeserialize');
    env.fails(await env.vault.upsertTier({ admin: env.admin.publicKey, id: t50k, params: tierParams(TIERS.t50k) }), [env.admin], 'AccountDidNotDeserialize');

    const f = await env.activeFunded();
    const sync = await env.vault.sync({ funded: env.funded(f.funded) });
    poke(env, f.funded, 132, 9); // FundedAccount.status: FundedStatus has 5 variants
    env.fails(sync, [trader], 'AccountDidNotDeserialize');
  });
});
