import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  capitalVaultAddress,
  configPda,
  enumName,
  evaluationPda,
  feeVaultPda,
  fundedPda,
  identityLockPda,
  ownerPda,
  ownerUsdcAddress,
  solTreasuryPda,
  traderProfilePda,
} from '@props/sdk';
import { CONFIG_PARAMS, Env, TIERS, bn, hash32, usdc } from './env.ts';

describe('buy_evaluation', () => {
  it('takes the tier fee and snapshots the terms in one transaction', async () => {
    const env = new Env();
    await env.setUpVault();
    const trader = env.wallet();
    env.setUsdc(trader.publicKey, usdc('500'));
    const r = env.ok(await env.vault.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t25k.id, index: 0, ...env.reviewed(TIERS.t25k.id) }), [trader]);
    assert.equal(r.events[0]?.name, 'evaluationPurchased');
    assert.equal(env.usdcBalance(feeVaultPda()), usdc('149'));

    const e = env.account('evaluation', evaluationPda(trader.publicKey, 0));
    assert.ok(e.trader.equals(trader.publicKey));
    assert.equal(enumName(e.status), 'active');
    assert.equal(BigInt(e.terms.sizeUsd.toString()), usdc('25000'));
    assert.equal(e.terms.profitTargetBps, 800);
    assert.equal(e.terms.maxDrawdownBps, 500);
    assert.equal(e.terms.maxExposureBps, 10_000);
    assert.equal(e.terms.traderShareBps, CONFIG_PARAMS.traderShareBps);
    assert.equal(e.terms.tierVersion, 1);
    assert.equal(BigInt(e.feePaid.toString()), usdc('149'));
    assert.equal(env.account('traderProfile', traderProfilePda(trader.publicKey)).evaluationCount, 1);
    const c = env.account('config', configPda());
    assert.equal(BigInt(c.feesCollected.toString()), usdc('149'));
    assert.equal(c.evaluationsSold.toString(), '1');

    env.fails(await env.vault.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t10k.id, index: 0, ...env.reviewed(TIERS.t10k.id) }), [trader], 'already in use');
    env.fails(await env.vault.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t10k.id, index: 2, ...env.reviewed(TIERS.t10k.id) }), [trader], 'InvalidParams');
    env.ok(await env.vault.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t10k.id, index: 1, ...env.reviewed(TIERS.t10k.id) }), [trader]);
    assert.equal(env.usdcBalance(feeVaultPda()), usdc('228'));
  });

  it('refuses disabled tiers, paused sales and unpaid purchases', async () => {
    const env = new Env();
    await env.setUpVault();
    const trader = env.wallet();
    env.setUsdc(trader.publicKey, usdc('100'));
    env.fails(await env.vault.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t50k.id, index: 0, ...env.reviewed(TIERS.t50k.id) }), [trader], 'TierDisabled');
    env.fails(await env.vault.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t25k.id, index: 0, ...env.reviewed(TIERS.t25k.id) }), [trader], 'insufficient funds');
    env.ok(await env.vault.setPauses({ admin: env.admin.publicKey, paused: { newEvaluations: true, trading: false, payouts: false } }), [env.admin]);
    env.fails(await env.vault.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t10k.id, index: 0, ...env.reviewed(TIERS.t10k.id) }), [trader], 'Paused');
    assert.equal(env.usdcBalance(feeVaultPda()), 0n);
  });
});

describe('set_identity', () => {
  it('binds one identity to one wallet, only by the KYC authority', async () => {
    const env = new Env();
    await env.setUpVault();
    const alice = env.wallet();
    const aliceAgain = env.wallet();
    const id = hash32('passport:alice');
    env.fails(await env.vault.setIdentity({ kycAuthority: env.risk.publicKey, wallet: alice.publicKey, identityHash: id }), [env.risk], 'Unauthorized');
    env.fails(await env.vault.setIdentity({ kycAuthority: env.kyc.publicKey, wallet: alice.publicKey, identityHash: new Uint8Array(32) }), [env.kyc], 'InvalidParams');

    // Verification before any purchase creates the profile.
    env.ok(await env.vault.setIdentity({ kycAuthority: env.kyc.publicKey, wallet: alice.publicKey, identityHash: id }), [env.kyc]);
    const p = env.account('traderProfile', traderProfilePda(alice.publicKey));
    assert.deepEqual(Uint8Array.from(p.identityHash), id);
    assert.ok(p.wallet.equals(alice.publicKey));
    assert.ok(env.account('identityLock', identityLockPda(id)).profile.equals(traderProfilePda(alice.publicKey)));

    // The same person cannot attach a second wallet, and a verified wallet cannot change identity.
    env.fails(await env.vault.setIdentity({ kycAuthority: env.kyc.publicKey, wallet: aliceAgain.publicKey, identityHash: id }), [env.kyc], 'already in use');
    env.fails(await env.vault.setIdentity({ kycAuthority: env.kyc.publicKey, wallet: alice.publicKey, identityHash: hash32('other') }), [env.kyc], 'AlreadyVerified');
  });
});

describe('record_evaluation_result', () => {
  it('lets only a risk authority resolve an active evaluation once', async () => {
    const env = new Env();
    await env.setUpVault();
    const trader = env.wallet();
    env.setUsdc(trader.publicKey, usdc('100'));
    env.ok(await env.vault.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t10k.id, index: 0, ...env.reviewed(TIERS.t10k.id) }), [trader]);
    const evaluation = evaluationPda(trader.publicKey, 0);
    const result = (riskAuthority = env.risk.publicKey, passed = false) =>
      env.vault.recordEvaluationResult({ riskAuthority, evaluation, passed, finalEquity: usdc('9480'), tradesRoot: hash32('fills') });
    env.fails(await result(trader.publicKey), [trader], 'Unauthorized');
    const r = env.ok(await result(), [env.risk]);
    assert.equal(r.events[0]?.name, 'evaluationResolved');
    const e = env.account('evaluation', evaluation);
    assert.equal(enumName(e.status), 'failed');
    assert.equal(BigInt(e.finalEquity.toString()), usdc('9480'));
    env.fails(await result(env.risk.publicKey, true), [env.risk], 'InvalidEvaluationStatus');
  });
});

describe('activate_funded', () => {
  it('posts L = S × drawdown to a data-less owner PDA and funds its SOL float', async () => {
    const env = new Env();
    await env.setUpVault();
    const trader = env.wallet();
    const evaluation = await env.passedEvaluation(trader, TIERS.t10k.id);
    const treasuryBefore = env.lamports(solTreasuryPda());
    const r = env.ok(await env.vault.activateFunded({ trader: trader.publicKey, evaluation }), [trader]);
    assert.equal(r.events[0]?.name, 'fundedActivated');

    const funded = fundedPda(evaluation);
    const owner = ownerPda(funded);
    const f = env.account('fundedAccount', funded);
    assert.equal(enumName(f.status), 'active');
    assert.equal(BigInt(f.principal.toString()), usdc('500'));
    assert.equal(env.usdcBalance(ownerUsdcAddress(funded)), usdc('500'));
    assert.equal(env.usdcBalance(capitalVaultAddress()), usdc('99500'));
    const ownerInfo = env.svm.getAccount(owner)!;
    assert.ok(ownerInfo.owner.equals(SystemProgram.programId), 'owner PDA must stay system-owned');
    assert.equal(ownerInfo.data.length, 0, 'owner PDA must stay data-less');
    const target = BigInt(CONFIG_PARAMS.ownerSolTarget.toString());
    assert.equal(treasuryBefore - env.lamports(solTreasuryPda()), target);
    assert.ok(env.lamports(owner) < target, 'the owner paid its own USDC account rent from the float');
    assert.equal(enumName(env.account('evaluation', evaluation).status), 'funded');
    assert.equal(env.account('traderProfile', traderProfilePda(trader.publicKey)).activeFunded, 1);
    const c = env.account('config', configPda());
    assert.equal(BigInt(c.allocatedPrincipal.toString()), usdc('500'));
    assert.equal(c.fundedActive, 1);

    env.fails(await env.vault.activateFunded({ trader: trader.publicKey, evaluation }), [trader], 'already in use');
    const second = await env.passedEvaluation(trader, TIERS.t10k.id);
    env.fails(await env.vault.activateFunded({ trader: trader.publicKey, evaluation: second }), [trader], 'AlreadyFunded');
  });

  it('refuses unpassed, unverified, foreign, paused and uncovered activations', async () => {
    const env = new Env();
    await env.setUpVault({ capital: usdc('600') });
    const trader = env.wallet();
    env.setUsdc(trader.publicKey, usdc('1000'));
    env.ok(await env.vault.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t10k.id, index: 0, ...env.reviewed(TIERS.t10k.id) }), [trader]);
    const evaluation = evaluationPda(trader.publicKey, 0);
    env.fails(await env.vault.activateFunded({ trader: trader.publicKey, evaluation }), [trader], 'InvalidEvaluationStatus');
    env.ok(
      await env.vault.recordEvaluationResult({ riskAuthority: env.risk.publicKey, evaluation, passed: true, finalEquity: usdc('10850'), tradesRoot: hash32('f') }),
      [env.risk],
    );
    env.fails(await env.vault.activateFunded({ trader: trader.publicKey, evaluation }), [trader], 'NotVerified');
    env.ok(await env.vault.setIdentity({ kycAuthority: env.kyc.publicKey, wallet: trader.publicKey, identityHash: hash32('t') }), [env.kyc]);

    const thief = env.wallet();
    env.ok(await env.vault.setIdentity({ kycAuthority: env.kyc.publicKey, wallet: thief.publicKey, identityHash: hash32('thief') }), [env.kyc]);
    env.fails(await env.vault.activateFunded({ trader: thief.publicKey, evaluation }), [thief], 'ConstraintSeeds');

    env.ok(await env.vault.setPauses({ admin: env.admin.publicKey, paused: { newEvaluations: false, trading: true, payouts: false } }), [env.admin]);
    env.fails(await env.vault.activateFunded({ trader: trader.publicKey, evaluation }), [trader], 'Paused');
    env.ok(await env.vault.setPauses({ admin: env.admin.publicKey, paused: { newEvaluations: false, trading: false, payouts: false } }), [env.admin]);

    env.ok(await env.vault.withdrawCapital({ admin: env.admin.publicKey, amount: usdc('200') }), [env.admin]);
    env.fails(await env.vault.activateFunded({ trader: trader.publicKey, evaluation }), [trader], 'InsufficientCapital');
  });

  it('posts at most the daily principal limit, whoever signed the passes and identities', async () => {
    const env = new Env();
    await env.setUpVault();
    env.ok(await env.vault.setParams({ admin: env.admin.publicKey, params: { ...CONFIG_PARAMS, maxDailyPrincipal: bn(usdc('1000')) } }), [env.admin]);
    const passed: { trader: Keypair; evaluation: PublicKey }[] = [];
    for (let i = 0; i < 3; i++) {
      const trader = env.wallet();
      passed.push({ trader, evaluation: await env.passedEvaluation(trader, TIERS.t10k.id) });
    }
    const activate = (p: { trader: Keypair; evaluation: PublicKey }) => env.vault.activateFunded({ trader: p.trader.publicKey, evaluation: p.evaluation });
    env.ok(await activate(passed[0]!), [passed[0]!.trader]);
    env.ok(await activate(passed[1]!), [passed[1]!.trader]);
    env.fails(await activate(passed[2]!), [passed[2]!.trader], 'DailyPrincipalLimit');
    assert.equal(BigInt(env.account('config', configPda()).principalInWindow.toString()), usdc('1000'));

    const clock = env.svm.getClock();
    clock.unixTimestamp += 86_400n;
    env.svm.setClock(clock);
    env.ok(await activate(passed[2]!), [passed[2]!.trader]);
    assert.equal(BigInt(env.account('config', configPda()).principalInWindow.toString()), usdc('500'), 'a new day starts a new window');
    env.fails(await env.vault.setParams({ admin: env.admin.publicKey, params: { ...CONFIG_PARAMS, maxDailyPrincipal: bn(0) } }), [env.admin], 'InvalidParams');
  });
});
