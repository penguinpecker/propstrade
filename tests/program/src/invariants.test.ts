// Spec §3 invariants that the per-instruction suites do not already pin down: exfiltration attempts,
// cross-trader access, and the owner PDA staying a plain, data-less system account.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  PROPS_VAULT_IDL,
  USDC_MINT,
  capitalVaultAddress,
  gmOrderEscrow,
  gmPositionPda,
  payoutPda,
} from '@props/sdk';
import { Env, MARKETS, USD, swapKey, usdc } from './env.ts';

describe('invariants', () => {
  it('only order creation, cancels into the owner, payouts and closure touch the owner USDC account', () => {
    const touching = PROPS_VAULT_IDL.instructions
      .filter((ix) => ix.accounts.some((a) => a.name === 'owner_usdc' && 'writable' in a && a.writable))
      .map((ix) => ix.name)
      .sort();
    // activate_funded funds it; cancel_order / close_completed_order return escrow into it (receiver = owner PDA);
    // open_position escrows collateral with GMTrade; approve_payout / close_funded are the only outflows.
    assert.deepEqual(touching, [
      'activate_funded',
      'approve_payout',
      'cancel_order',
      'close_completed_order',
      'close_funded',
      'open_position',
    ]);
  });

  it('refuses trader- or authority-chosen token accounts on every money path', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const thief = env.wallet();
    const thiefUsdc = env.setUsdc(thief.publicKey, 0n);
    const riskUsdc = env.setUsdc(env.risk.publicKey, 0n);

    const { instruction, order } = await env.vault.openPosition({
      trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'market',
      collateral: usdc('100'), sizeDeltaUsd: 1000n * USD, acceptablePrice: 10n ** 30n,
    });
    env.fails(swapKey(instruction, f.ownerUsdc, thiefUsdc), [f.trader], 'ConstraintTokenOwner');
    env.fails(swapKey(instruction, gmOrderEscrow(order), thiefUsdc), [f.trader], 'ConstraintAddress');
    env.ok(instruction, [f.trader]);

    const cancel = await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order });
    env.fails(swapKey(cancel, f.ownerUsdc, thiefUsdc), [f.trader], 'ConstraintTokenOwner');
    env.ok(cancel, [f.trader]);

    // Realize profit, then try to redirect the payout and the vault share.
    env.setUsdcBalance(f.ownerUsdc, usdc('900'));
    env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [f.trader]);
    env.ok(await env.vault.requestPayout({ trader: f.trader.publicKey, funded: f.funded, payoutSeq: 0 }), [f.trader]);
    const approve = await env.vault.approvePayout({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded), payout: payoutPda(f.funded, 0) });
    const traderUsdc = getAssociatedTokenAddressSync(USDC_MINT, f.trader.publicKey);
    env.fails(swapKey(approve, traderUsdc, riskUsdc), [env.risk], 'Unauthorized');
    env.fails(swapKey(approve, capitalVaultAddress(), riskUsdc), [env.risk], 'ConstraintAddress');
    env.fails(swapKey(approve, f.trader.publicKey, env.risk.publicKey), [env.risk], 'Unauthorized');
    env.ok(approve, [env.risk]);
    assert.equal(env.usdcBalance(riskUsdc), 0n);
    assert.equal(env.usdcBalance(thiefUsdc), 0n);

    const close = await env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded) });
    env.fails(swapKey(close, capitalVaultAddress(), riskUsdc), [env.risk], 'ConstraintAddress');
    env.fails(await env.vault.withdrawCapital({ admin: env.risk.publicKey, amount: 1n, adminUsdc: riskUsdc }), [env.risk], 'Unauthorized');
  });

  it("a trader cannot act on another trader's funded account", async () => {
    const env = new Env();
    await env.setUpVault();
    const a = await env.activeFunded();
    const b = await env.activeFunded();
    const { instruction, order } = await env.vault.openPosition({
      trader: a.trader.publicKey, funded: env.funded(a.funded), marketToken: MARKETS.ETH.token, isLong: true, orderType: 'limit',
      collateral: usdc('50'), sizeDeltaUsd: 500n * USD, triggerPrice: 2000n * 10n ** 11n, acceptablePrice: 10n ** 30n,
    });
    env.ok(instruction, [a.trader]);
    const other = b.trader;
    const funded = env.funded(a.funded);
    const attempts = [
      (await env.vault.openPosition({
        trader: other.publicKey, funded: env.funded(a.funded), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'market',
        collateral: usdc('10'), sizeDeltaUsd: 100n * USD, acceptablePrice: 10n ** 30n,
      })).instruction,
      (await env.vault.closePosition({
        authority: other.publicKey, funded: env.funded(a.funded), marketToken: MARKETS.ETH.token, isLong: true, sizeDeltaUsd: 100n * USD, acceptablePrice: 1n,
      })).instruction,
      (await env.vault.setProtection({
        trader: other.publicKey, funded: env.funded(a.funded), marketToken: MARKETS.ETH.token, isLong: true, orderType: 'stopLoss',
        triggerPrice: 1000n * 10n ** 11n, sizeDeltaUsd: 500n * USD,
      })).instruction,
      await env.vault.updateOrder({ trader: other.publicKey, funded, order, triggerPrice: 1n }),
      await env.vault.cancelOrder({ authority: other.publicKey, funded, order }),
      await env.vault.requestPayout({ trader: other.publicKey, funded: a.funded, payoutSeq: 0 }),
    ];
    for (const ix of attempts) env.fails(ix, [other], 'Unauthorized');
    assert.equal(env.usdcBalance(gmOrderEscrow(order)), usdc('50'));
  });

  it('the owner PDA stays a data-less system account through a full lifecycle', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const check = () => {
      const info = env.svm.getAccount(f.owner);
      if (!info || info.lamports === 0) return; // closed: no account at all
      assert.ok(info.owner.equals(SystemProgram.programId));
      assert.equal(info.data.length, 0);
    };
    const { instruction, order } = await env.vault.openPosition({
      trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'market',
      collateral: usdc('100'), sizeDeltaUsd: 1000n * USD, acceptablePrice: 10n ** 30n,
    });
    env.ok(instruction, [f.trader]);
    check();
    const position = gmPositionPda(f.owner, MARKETS.SOL.token, true);
    env.executeOrder(order, gmOrderEscrow(order));
    env.setPosition(position, 1000n * USD, usdc('100'));
    env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [f.trader]);
    const sl = await env.vault.setProtection({
      trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'stopLoss',
      triggerPrice: 100n * 10n ** 11n, sizeDeltaUsd: 1000n * USD,
    });
    env.ok(sl.instruction, [f.trader]);
    check();
    env.ok(await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order: sl.order }), [f.trader]);
    env.remove(position);
    env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [f.trader]);
    env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: f.funded }), [env.risk]);
    env.ok(await env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded) }), [env.risk]);
    check();
    assert.equal(env.lamports(f.owner), 0n);
  });
});
