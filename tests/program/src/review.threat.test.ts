// Threat-model review: the evaluation purchase must charge the fee (and pin the terms) the trader reviewed; a breached
// funded account must not block the trader's next funded account.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { configPda, evaluationPda, solTreasuryPda, tierPda, traderProfilePda } from '@props/sdk';
import { Env, TIERS, tierParams, usdc } from './env.ts';

describe('buy_evaluation binds what the trader reviewed', () => {
  it('does not charge a fee or pin terms that changed after the trader reviewed them', async () => {
    const env = new Env();
    await env.setUpVault();
    const trader = env.wallet();
    const traderUsdc = env.setUsdc(trader.publicKey, usdc('500'));

    // The app reads the onchain tier, checks it against what it shows (79 USDC, v1) and builds the purchase
    // (app/src/lib/chain.ts prepareEvaluation) carrying that fee and tier version.
    const reviewed = env.account('tier', tierPda(TIERS.t10k.id));
    assert.equal(BigInt(reviewed.feeUsdc.toString()), usdc('79'));
    const purchase = await env.vault.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t10k.id, index: 0, ...env.reviewed(TIERS.t10k.id) });

    // Before the signed purchase lands, the admin key rewrites the tier: a fee change racing the purchase, or a front-run.
    env.ok(await env.vault.upsertTier({
      admin: env.admin.publicKey, id: TIERS.t10k.id,
      params: { ...tierParams({ ...TIERS.t10k, fee: '449' }), profitTargetBps: 5_000 },
    }), [env.admin]);

    const r = env.send([purchase], [trader]);
    const charged = usdc('500') - env.usdcBalance(traderUsdc);
    const pinned = r.ok ? env.account('evaluation', evaluationPda(trader.publicKey, 0)) : null;
    assert.ok(
      !r.ok || (charged === usdc('79') && pinned!.terms.tierVersion === reviewed.version),
      `the purchase landed charging ${Number(charged) / 1e6} USDC (reviewed 79) with terms v${pinned?.terms.tierVersion} `
        + `(reviewed v${reviewed.version}, profit target ${pinned?.terms.profitTargetBps} bps)`,
    );
    assert.equal(r.error, 'TierChanged');
    assert.equal(charged, 0n);

    // Reviewing the new terms and buying them works.
    env.ok(await env.vault.buyEvaluation({ trader: trader.publicKey, tierId: TIERS.t10k.id, index: 0, ...env.reviewed(TIERS.t10k.id) }), [trader]);
    assert.equal(usdc('500') - env.usdcBalance(traderUsdc), usdc('449'));
  });
});

describe('breach lifecycle as the server runs it', () => {
  it('lets a trader whose funded account breached activate the next evaluation they pass', async () => {
    const env = new Env();
    await env.setUpVault();
    const { trader, funded, owner, ownerUsdc } = await env.activeFunded();
    const treasuryBefore = env.lamports(solTreasuryPda());
    // Nearly all of the 500 USDC allowance is lost on GMTrade (V ≤ 0; a liquidation returned $5). The keeper's breach
    // step marks the account breached and closes its positions; once it is flat it closes the account
    // (server/src/modules/keeper/rules.ts).
    env.setUsdc(owner, usdc('5'), ownerUsdc);
    env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded }), [env.risk]);
    env.fails(await env.vault.restrict({ riskAuthority: env.risk.publicKey, funded, restricted: false }), [env.risk], 'InvalidAccountStatus');
    env.ok(await env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(funded), positions: [] }), [env.risk]);
    assert.equal(env.status(funded), 'closed');
    assert.equal(env.lamports(owner), 0n);
    assert.ok(env.lamports(solTreasuryPda()) > treasuryBefore);

    // The trader pays for a new evaluation and passes it.
    const next = await env.passedEvaluation(trader);
    const r = env.send([await env.vault.activateFunded({ trader: trader.publicKey, evaluation: next })], [trader]);
    const c = env.account('config', configPda());
    assert.ok(
      r.ok,
      `activation refused (${r.error}): the breached account is still ${env.status(funded)}, `
        + `profile.active_funded = ${env.account('traderProfile', traderProfilePda(trader.publicKey)).activeFunded}, `
        + `allocated_principal = ${Number(BigInt(c.allocatedPrincipal.toString())) / 1e6} USDC, owner PDA holds ${Number(env.lamports(owner)) / 1e9} SOL`,
    );
  });
});
