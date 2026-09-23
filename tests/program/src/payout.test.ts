import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  USDC_MINT,
  capitalVaultAddress,
  configPda,
  enumName,
  gmOrderEscrow,
  gmPositionPda,
  payoutPda,
  solTreasuryPda,
} from '@props/sdk';
import { Env, MAINNET_POSITIONS, MARKETS, USD, usdc } from './env.ts';

type Funded = Awaited<ReturnType<Env['activeFunded']>>;

/** Opens and fills SOL long $1000 / $100, then closes it at a PnL: the owner ends flat with principal + pnl. */
async function roundTrip(env: Env, f: Funded, pnl: string, keepPositionAccount = false): Promise<PublicKey> {
  const { instruction, order } = await env.vault.openPosition({
    trader: f.trader.publicKey,
    funded: env.funded(f.funded),
    marketToken: MARKETS.SOL.token,
    isLong: true,
    orderType: 'market',
    collateral: usdc('100'),
    sizeDeltaUsd: 1000n * USD,
    acceptablePrice: 10n ** 30n,
  });
  env.ok(instruction, [f.trader]);
  const position = gmPositionPda(f.owner, MARKETS.SOL.token, true);
  env.executeOrder(order, gmOrderEscrow(order));
  env.setPosition(position, 1000n * USD, usdc('99.9'));
  env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [f.trader]);
  // Keeper executes a full close: the position goes flat and collateral ± PnL lands on the owner in USDC.
  if (keepPositionAccount) env.setPosition(position, 0n, 0n);
  else env.remove(position);
  env.setUsdcBalance(f.ownerUsdc, usdc('500') + usdc(pnl.replace('-', '')) * (pnl.startsWith('-') ? -1n : 1n));
  env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [f.trader]);
  return position;
}

async function request(env: Env, f: Funded, signer: Keypair = f.trader) {
  const seq = env.account('fundedAccount', f.funded).payoutSeq;
  const r = env.send([await env.vault.requestPayout({ trader: signer.publicKey, funded: f.funded, payoutSeq: seq })], [signer]);
  return { r, payout: payoutPda(f.funded, seq) };
}

const approve = async (env: Env, f: Funded, payout: PublicKey, positions: PublicKey[] = [], signer = env.risk) =>
  env.vault.approvePayout({ riskAuthority: signer.publicKey, funded: env.funded(f.funded), payout, positions });

describe('payouts', () => {
  it('pays the trader share of realized profit to the trader wallet and the vault share to capital', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const traderUsdc = getAssociatedTokenAddressSync(USDC_MINT, f.trader.publicKey);
    env.remove(traderUsdc); // no USDC account yet: approval creates it, paid by the SOL treasury
    const position = await roundTrip(env, f, '200', true);

    const { r, payout } = await request(env, f);
    assert.ok(r.ok, r.error);
    assert.equal(r.events[0]?.name, 'payoutRequested');
    const p = env.account('payoutRequest', payout);
    assert.equal(BigInt(p.balanceAtRequest.toString()), usdc('700'));
    assert.equal(BigInt(p.profit.toString()), usdc('200'));
    assert.equal(BigInt(p.traderAmount.toString()), usdc('160'));
    assert.equal(BigInt(p.vaultAmount.toString()), usdc('40'));
    assert.equal(env.status(f.funded), 'payoutPending');

    const blocked = await env.vault.openPosition({
      trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.BTC.token, isLong: true, orderType: 'market',
      collateral: usdc('10'), sizeDeltaUsd: 100n * USD, acceptablePrice: 10n ** 30n,
    });
    env.fails(blocked.instruction, [f.trader], 'InvalidAccountStatus');
    const stranger = env.wallet();
    env.fails(await approve(env, f, payout, [], stranger), [stranger], 'Unauthorized');

    const treasury = env.lamports(solTreasuryPda());
    const capital = env.usdcBalance(capitalVaultAddress());
    const paid = env.ok(await approve(env, f, payout, [position]), [env.risk]);
    assert.equal(paid.events[0]?.name, 'payoutPaid');
    assert.equal(env.usdcBalance(traderUsdc), usdc('160'));
    assert.equal(env.usdcBalance(capitalVaultAddress()) - capital, usdc('40'));
    assert.equal(env.usdcBalance(f.ownerUsdc), usdc('500'), 'the allowance resets to L');
    assert.ok(env.lamports(solTreasuryPda()) < treasury, 'the treasury paid the trader ATA rent');
    assert.equal(env.status(f.funded), 'active');
    assert.equal(enumName(env.account('payoutRequest', payout).status), 'paid');
    assert.equal(BigInt(env.account('fundedAccount', f.funded).payoutsPaid.toString()), usdc('160'));
    const c = env.account('config', configPda());
    assert.equal(BigInt(c.payoutsPaid.toString()), usdc('160'));
    assert.equal(BigInt(c.profitToVault.toString()), usdc('40'));

    env.fails(await approve(env, f, payout), [env.risk], 'InvalidPayoutStatus');
    assert.equal((await request(env, f)).r.error, 'NoProfit');
  });

  it('refuses requests that are not flat, too small, paused or from a stranger', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const { instruction } = await env.vault.openPosition({
      trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.ETH.token, isLong: false, orderType: 'limit',
      collateral: usdc('10'), sizeDeltaUsd: 100n * USD, triggerPrice: 5000n * 10n ** 11n, acceptablePrice: 1n,
    });
    env.ok(instruction, [f.trader]);
    env.setUsdcBalance(f.ownerUsdc, usdc('800'));
    assert.equal((await request(env, f)).r.error, 'NotFlat', 'a pending order blocks a payout');

    const env2 = new Env();
    await env2.setUpVault();
    const g = await env2.activeFunded();
    await roundTrip(env2, g, '60');
    assert.equal((await request(env2, g)).r.error, 'BelowMinPayout', '80% of 60 is below the 50 USDC minimum');
    env2.setUsdcBalance(g.ownerUsdc, usdc('800'));
    const stranger = env2.wallet();
    assert.equal((await request(env2, g, stranger)).r.error, 'Unauthorized');
    env2.ok(await env2.vault.setPauses({ admin: env2.admin.publicKey, paused: { newEvaluations: false, trading: false, payouts: true } }), [env2.admin]);
    assert.equal((await request(env2, g)).r.error, 'Paused');
  });

  it('re-checks flatness and balance at approval, and supports rejection and cancellation', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const position = await roundTrip(env, f, '300', true);

    // Rejection: nothing moves, the account is active again.
    const first = await request(env, f);
    assert.ok(first.r.ok, first.r.error);
    const reject = (signer = env.risk) =>
      env.vault.rejectPayout({ riskAuthority: signer.publicKey, funded: f.funded, payout: first.payout, reasonCode: 3 });
    env.fails(await reject(f.trader), [f.trader], 'Unauthorized');
    assert.equal(env.ok(await reject(), [env.risk]).events[0]?.name, 'payoutRejected');
    const rejected = env.account('payoutRequest', first.payout);
    assert.equal(enumName(rejected.status), 'rejected');
    assert.equal(rejected.reasonCode, 3);
    assert.equal(env.status(f.funded), 'active');
    assert.equal(env.usdcBalance(f.ownerUsdc), usdc('800'));
    env.fails(await approve(env, f, first.payout), [env.risk], 'InvalidPayoutStatus');

    // Cancellation by the trader only.
    const second = await request(env, f);
    const stranger = env.wallet();
    env.fails(await env.vault.cancelPayout({ trader: stranger.publicKey, funded: f.funded, payout: second.payout }), [stranger], 'Unauthorized');
    env.ok(await env.vault.cancelPayout({ trader: f.trader.publicKey, funded: f.funded, payout: second.payout }), [f.trader]);
    assert.equal(enumName(env.account('payoutRequest', second.payout).status), 'cancelled');
    assert.equal(env.status(f.funded), 'active');

    // Approval re-checks: owner positions must be flat (and really the owner's), the balance must still be there.
    const third = await request(env, f);
    env.setPosition(position, 100n * USD, usdc('10'));
    env.fails(await approve(env, f, third.payout, [position]), [env.risk], 'NotFlat');
    env.setPosition(position, 0n, 0n);
    env.fails(await approve(env, f, third.payout, [MAINNET_POSITIONS.flat]), [env.risk], 'InvalidPositionAccount');
    env.setUsdcBalance(f.ownerUsdc, usdc('799'));
    env.fails(await approve(env, f, third.payout, [position]), [env.risk], 'BalanceChanged');
    env.setUsdcBalance(f.ownerUsdc, usdc('800'));
    env.ok(await env.vault.setPauses({ admin: env.admin.publicKey, paused: { newEvaluations: false, trading: false, payouts: true } }), [env.admin]);
    env.fails(await approve(env, f, third.payout, [position]), [env.risk], 'Paused');
    env.ok(await env.vault.setPauses({ admin: env.admin.publicKey, paused: { newEvaluations: false, trading: false, payouts: false } }), [env.admin]);
    env.ok(await approve(env, f, third.payout, [position]), [env.risk]);
    assert.equal(env.usdcBalance(getAssociatedTokenAddressSync(USDC_MINT, f.trader.publicKey)), usdc('1000') - usdc('79') + usdc('240'));
  });
});
