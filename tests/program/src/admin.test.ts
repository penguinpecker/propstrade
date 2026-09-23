import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  GMTRADE_STORE,
  USDC_MINT,
  capitalVaultAddress,
  configPda,
  feeVaultPda,
  marketConfigPda,
  solTreasuryPda,
  tierPda,
  vaultAuthorityPda,
} from '@props/sdk';
import { AccountLayout } from '@solana/spl-token';
import { CONFIG_PARAMS, Env, LEVERAGE, MARKETS, NON_PURE_MARKET, NON_PURE_MARKET_TOKEN, TIERS, bn, marketParams, swapKey, tierParams, usdc } from './env.ts';

const allPaused = { newEvaluations: true, trading: true, payouts: true };

describe('initialize', () => {
  it('only the upgrade authority can initialize; config pins USDC and the GMTrade store; everything starts paused', async () => {
    const env = new Env();
    const stranger = env.wallet();
    env.fails(await env.vault.initialize({ admin: stranger.publicKey, params: CONFIG_PARAMS }), [stranger], 'NotUpgradeAuthority');

    const r = env.ok(await env.vault.initialize({ admin: env.admin.publicKey, params: CONFIG_PARAMS }), [env.admin]);
    assert.equal(r.events[0]?.name, 'configChanged');
    const c = env.account('config', configPda());
    assert.ok(c.admin.equals(env.admin.publicKey));
    assert.ok(c.usdcMint.equals(USDC_MINT));
    assert.ok(c.gmtradeStore.equals(GMTRADE_STORE));
    assert.ok(c.capitalVault.equals(capitalVaultAddress()));
    assert.deepEqual(c.paused, allPaused);
    assert.equal(c.traderShareBps, 8000);
    for (const vault of [feeVaultPda(), capitalVaultAddress()]) {
      const t = AccountLayout.decode(env.svm.getAccount(vault)!.data);
      assert.ok(t.owner.equals(vaultAuthorityPda()) && t.mint.equals(USDC_MINT));
    }
    env.fails(await env.vault.initialize({ admin: env.admin.publicKey, params: CONFIG_PARAMS }), [env.admin], 'already in use');
  });

  it('refuses a store not owned by GMTrade and invalid params', async () => {
    const env = new Env();
    const ix = await env.vault.initialize({ admin: env.admin.publicKey, params: CONFIG_PARAMS });
    env.fails(swapKey(ix, GMTRADE_STORE, MARKETS.SOL.token), [env.admin], 'ConstraintOwner');
    const badShare = { ...CONFIG_PARAMS, traderShareBps: 10_001 };
    env.fails(await env.vault.initialize({ admin: env.admin.publicKey, params: badShare }), [env.admin], 'InvalidParams');
    const badFloat = { ...CONFIG_PARAMS, ownerSolMin: bn(1000) };
    env.fails(await env.vault.initialize({ admin: env.admin.publicKey, params: badFloat }), [env.admin], 'InvalidParams');
  });
});

describe('admin configuration', () => {
  it('sets authorities (≤ 4 risk, no default key), params and pauses; strangers are refused', async () => {
    const env = new Env();
    await env.setUpVault();
    const v = env.vault;
    const admin = env.admin.publicKey;
    const stranger = env.wallet();
    const five = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
    env.fails(await v.setAuthorities({ admin, riskAuthorities: five, kycAuthority: admin }), [env.admin], 'TooManyRiskAuthorities');
    env.fails(await v.setAuthorities({ admin, riskAuthorities: [PublicKey.default], kycAuthority: admin }), [env.admin], 'InvalidParams');
    env.fails(
      await v.setAuthorities({ admin: stranger.publicKey, riskAuthorities: [stranger.publicKey], kycAuthority: stranger.publicKey }),
      [stranger],
      'Unauthorized',
    );
    const four = five.slice(0, 4);
    env.ok(await v.setAuthorities({ admin, riskAuthorities: four, kycAuthority: env.kyc.publicKey }), [env.admin]);
    assert.equal(env.account('config', configPda()).riskAuthorities.length, 4);

    env.ok(await v.setParams({ admin, params: { ...CONFIG_PARAMS, traderShareBps: 7000 } }), [env.admin]);
    assert.equal(env.account('config', configPda()).traderShareBps, 7000);
    env.fails(await v.setParams({ admin: stranger.publicKey, params: CONFIG_PARAMS }), [stranger], 'Unauthorized');
    env.fails(await v.setParams({ admin, params: { ...CONFIG_PARAMS, minPayout: bn(0) } }), [env.admin], 'InvalidParams');

    env.ok(await v.setPauses({ admin, paused: allPaused }), [env.admin]);
    assert.deepEqual(env.account('config', configPda()).paused, allPaused);
    env.fails(await v.setPauses({ admin: stranger.publicKey, paused: allPaused }), [stranger], 'Unauthorized');
  });

  it('hands admin over in two steps', async () => {
    const env = new Env();
    await env.setUpVault();
    const v = env.vault;
    const next = env.wallet();
    const stranger = env.wallet();
    env.ok(await v.proposeAdmin({ admin: env.admin.publicKey, newAdmin: next.publicKey }), [env.admin]);
    env.fails(await v.acceptAdmin({ newAdmin: stranger.publicKey }), [stranger], 'Unauthorized');
    env.ok(await v.acceptAdmin({ newAdmin: next.publicKey }), [next]);
    const c = env.account('config', configPda());
    assert.ok(c.admin.equals(next.publicKey));
    assert.equal(c.pendingAdmin, null);
    env.fails(await v.setPauses({ admin: env.admin.publicKey, paused: allPaused }), [env.admin], 'Unauthorized');
    env.ok(await v.setPauses({ admin: next.publicKey, paused: allPaused }), [next]);
  });

  it('upserts tiers with a version bump and validates them', async () => {
    const env = new Env();
    await env.setUpVault();
    const v = env.vault;
    const admin = env.admin.publicKey;
    const t = env.account('tier', tierPda(TIERS.t10k.id));
    assert.equal(t.version, 1);
    assert.equal(BigInt(t.sizeUsd.toString()), usdc('10000'));
    assert.equal(BigInt(t.feeUsdc.toString()), usdc('79'));
    assert.equal(t.maxDrawdownBps, 500);
    assert.equal(env.account('tier', tierPda(TIERS.t50k.id)).enabled, false);

    env.ok(await v.upsertTier({ admin, id: TIERS.t10k.id, params: { ...tierParams(TIERS.t10k), feeUsdc: bn(usdc('89')) } }), [env.admin]);
    const t2 = env.account('tier', tierPda(TIERS.t10k.id));
    assert.equal(t2.version, 2);
    assert.equal(BigInt(t2.feeUsdc.toString()), usdc('89'));
    env.fails(await v.upsertTier({ admin, id: 9, params: { ...tierParams(TIERS.t10k), maxDrawdownBps: 0 } }), [env.admin], 'InvalidParams');
    env.fails(await v.upsertTier({ admin, id: 9, params: { ...tierParams(TIERS.t10k), termsHash: Array(32).fill(0) } }), [env.admin], 'InvalidParams');
    const stranger = env.wallet();
    env.fails(await v.upsertTier({ admin: stranger.publicKey, id: 9, params: tierParams(TIERS.t10k) }), [stranger], 'Unauthorized');
  });

  it('allowlists only pure USDC-USDC markets of the pinned store and keeps open interest on update', async () => {
    const env = new Env();
    await env.setUpVault();
    const v = env.vault;
    const admin = env.admin.publicKey;
    const m = env.account('marketConfig', marketConfigPda(MARKETS.SOL.token));
    assert.ok(m.gmMarket.equals(MARKETS.SOL.gm));
    assert.equal(m.maxLeverageBps, LEVERAGE.crypto);
    assert.equal(env.account('marketConfig', marketConfigPda(MARKETS.NVDA.token)).sessionRestricted, true);

    env.fails(await v.upsertMarket({ admin, marketToken: NON_PURE_MARKET_TOKEN, params: marketParams('SOLX', LEVERAGE.crypto) }), [env.admin], 'MarketNotPure');
    const wrongMarket = await v.upsertMarket({ admin, marketToken: MARKETS.SOL.token, params: marketParams('SOL', LEVERAGE.crypto) });
    env.fails(swapKey(wrongMarket, MARKETS.SOL.gm, MARKETS.BTC.gm), [env.admin], 'MarketNotPure');
    env.fails(swapKey(wrongMarket, MARKETS.SOL.gm, NON_PURE_MARKET), [env.admin], 'MarketNotPure');
    env.fails(await v.upsertMarket({ admin, marketToken: MARKETS.SOL.token, params: marketParams('SOL', 5_000) }), [env.admin], 'InvalidParams');

    env.ok(await v.upsertMarket({ admin, marketToken: MARKETS.SOL.token, params: marketParams('SOL', LEVERAGE.fx, { enabled: false }) }), [env.admin]);
    const updated = env.account('marketConfig', marketConfigPda(MARKETS.SOL.token));
    assert.equal(updated.enabled, false);
    assert.equal(updated.maxLeverageBps, LEVERAGE.fx);
    assert.ok(updated.gmMarket.equals(MARKETS.SOL.gm));
  });
});

describe('capital and treasury', () => {
  it('deposits and withdraws capital, sweeps fees, and moves SOL only for the admin', async () => {
    const env = new Env();
    await env.setUpVault({ capital: usdc('5000') });
    const v = env.vault;
    const admin = env.admin.publicKey;
    const stranger = env.wallet();
    assert.equal(env.usdcBalance(capitalVaultAddress()), usdc('5000'));

    env.fails(await v.withdrawCapital({ admin, amount: usdc('5000.000001') }), [env.admin], 'InvalidAmount');
    env.setUsdc(stranger.publicKey, usdc('10'));
    env.fails(await v.withdrawCapital({ admin: stranger.publicKey, amount: usdc('1') }), [stranger], 'Unauthorized');
    const r = env.ok(await v.withdrawCapital({ admin, amount: usdc('1000') }), [env.admin]);
    assert.equal(r.events[0]?.name, 'capitalWithdrawn');
    assert.equal(env.usdcBalance(capitalVaultAddress()), usdc('4000'));

    env.fails(await v.sweepFees({ admin }), [env.admin], 'InvalidAmount');
    const trader = env.wallet();
    env.setUsdc(trader.publicKey, usdc('200'));
    env.ok(await v.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t10k.id, index: 0, ...env.reviewed(TIERS.t10k.id) }), [trader]);
    assert.equal(env.usdcBalance(feeVaultPda()), usdc('79'));
    env.fails(await v.sweepFees({ admin: stranger.publicKey }), [stranger], 'Unauthorized');
    env.ok(await v.sweepFees({ admin }), [env.admin]);
    assert.equal(env.usdcBalance(feeVaultPda()), 0n);
    assert.equal(env.usdcBalance(capitalVaultAddress()), usdc('4079'));

    const before = env.lamports(solTreasuryPda());
    env.fails(await v.withdrawSolTreasury({ admin: stranger.publicKey, lamports: 1n }), [stranger], 'Unauthorized');
    env.ok(await v.withdrawSolTreasury({ admin, lamports: BigInt(LAMPORTS_PER_SOL) }), [env.admin]);
    assert.equal(env.lamports(solTreasuryPda()), before - BigInt(LAMPORTS_PER_SOL));
  });
});
