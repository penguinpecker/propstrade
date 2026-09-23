import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  capitalVaultAddress,
  configPda,
  feeVaultPda,
  gmOrderEscrow,
  gmPositionPda,
  payoutPda,
  solTreasuryPda,
  traderProfilePda,
} from '@props/sdk';
import { CONFIG_PARAMS, Env, MARKETS, TIERS, USD, usdc } from './env.ts';

type Funded = Awaited<ReturnType<Env['activeFunded']>>;

async function filledSolLong(env: Env, f: Funded) {
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
  return { order, position };
}

const totals = (env: Env) => {
  const c = env.account('config', configPda());
  const n = (v: { toString(): string }) => BigInt(v.toString());
  return {
    allocated: n(c.allocatedPrincipal),
    fees: n(c.feesCollected),
    paid: n(c.payoutsPaid),
    toVault: n(c.profitToVault),
    active: c.fundedActive,
  };
};

describe('breach and closure', () => {
  it('breached accounts only reduce risk; close_funded returns USDC and SOL and releases the principal', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const { position } = await filledSolLong(env, f);
    env.fails(await env.vault.markBreached({ riskAuthority: f.trader.publicKey, funded: f.funded }), [f.trader], 'Unauthorized');
    assert.equal(env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: f.funded }), [env.risk]).events[0]?.name, 'accountBreached');
    assert.equal(env.status(f.funded), 'breached');

    const reopen = await env.vault.openPosition({
      trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.BTC.token, isLong: true, orderType: 'market',
      collateral: usdc('10'), sizeDeltaUsd: 100n * USD, acceptablePrice: 10n ** 30n,
    });
    env.fails(reopen.instruction, [f.trader], 'InvalidAccountStatus');
    const forced = await env.vault.closePosition({
      authority: env.risk.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true, sizeDeltaUsd: 1000n * USD, acceptablePrice: 1n,
    });
    env.ok(forced.instruction, [env.risk]);
    const close = async (positions: PublicKey[]) => env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded), positions });
    env.fails(await close([position]), [env.risk], 'NotFlat');

    // GMTrade liquidates the position (collateral lost) and cancels the now-pointless decrease order.
    env.remove(position);
    env.executeOrder(forced.order, gmOrderEscrow(forced.order));
    env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [env.risk]);

    const capital = env.usdcBalance(capitalVaultAddress());
    const treasury = env.lamports(solTreasuryPda());
    const ownerLamports = env.lamports(f.owner);
    const ataRent = env.lamports(f.ownerUsdc);
    const stranger = env.wallet();
    env.fails(
      await env.vault.closeFunded({ riskAuthority: stranger.publicKey, funded: env.funded(f.funded), positions: [] }),
      [stranger],
      'Unauthorized',
    );
    env.fails(await close([position]), [env.risk], 'InvalidPositionAccount'); // a closed position account proves nothing
    const r = env.ok(await close([]), [env.risk]);
    assert.equal(r.events[0]?.name, 'accountClosed');
    assert.equal(env.usdcBalance(capitalVaultAddress()) - capital, usdc('400'), 'remaining USDC back to capital');
    assert.equal(env.exists(f.ownerUsdc), false, 'owner USDC account closed');
    assert.equal(env.lamports(f.owner), 0n, 'owner PDA emptied');
    assert.equal(env.lamports(solTreasuryPda()) - treasury, ownerLamports + ataRent);
    assert.equal(env.status(f.funded), 'closed');
    assert.equal(env.account('traderProfile', traderProfilePda(f.trader.publicKey)).activeFunded, 0);
    assert.deepEqual({ allocated: totals(env).allocated, active: totals(env).active }, { allocated: 0n, active: 0 });

    env.fails(await close([]), [env.risk], 'AccountNotInitialized'); // its USDC account no longer exists
    env.fails(await env.vault.sync({ funded: env.funded(f.funded) }), [env.risk], 'InvalidAccountStatus');
    env.fails(await env.vault.topUpOwner({ funded: f.funded }), [env.risk], 'InvalidAccountStatus');

    // The same person can be funded again after passing another evaluation.
    await env.activeFunded(f.trader);
    assert.equal(totals(env).active, 1);
  });

  it('restrict toggles Active ↔ Restricted only', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const restrict = (restricted: boolean) => env.vault.restrict({ riskAuthority: env.risk.publicKey, funded: f.funded, restricted });
    env.fails(await restrict(false), [env.risk], 'InvalidAccountStatus');
    env.fails(await env.vault.restrict({ riskAuthority: f.trader.publicKey, funded: f.funded, restricted: true }), [f.trader], 'Unauthorized');
    env.ok(await restrict(true), [env.risk]);
    env.fails(await restrict(true), [env.risk], 'InvalidAccountStatus');
    const r = env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: f.funded }), [env.risk]);
    assert.equal(r.events[0]?.name, 'accountBreached');
    env.fails(await restrict(false), [env.risk], 'InvalidAccountStatus');
  });
});

describe('capital accounting', () => {
  it('keeps allocated principal, fees, payouts and vault profit consistent with token balances', async () => {
    const env = new Env();
    const deposit = usdc('20000');
    await env.setUpVault({ capital: deposit });
    const a = await env.activeFunded();
    const b = await env.activeFunded(env.wallet(), TIERS.t25k.id);
    assert.deepEqual(totals(env), { allocated: usdc('1750'), fees: usdc('228'), paid: 0n, toVault: 0n, active: 2 });
    assert.equal(env.usdcBalance(capitalVaultAddress()), deposit - usdc('1750'));
    assert.equal(env.usdcBalance(feeVaultPda()), usdc('228'));

    // A: +250 realized, paid out 200 / 50.
    await filledSolLong(env, a);
    env.remove(gmPositionPda(a.owner, MARKETS.SOL.token, true));
    env.setUsdcBalance(a.ownerUsdc, usdc('750'));
    env.ok(await env.vault.sync({ funded: env.funded(a.funded) }), [a.trader]);
    const seq = env.account('fundedAccount', a.funded).payoutSeq;
    env.ok(await env.vault.requestPayout({ trader: a.trader.publicKey, funded: a.funded, payoutSeq: seq }), [a.trader]);
    env.ok(await env.vault.approvePayout({ riskAuthority: env.risk.publicKey, funded: env.funded(a.funded), payout: payoutPda(a.funded, seq) }), [env.risk]);

    // B: breached at a loss of 1,000 of its 1,250 principal, then closed.
    env.setUsdcBalance(b.ownerUsdc, usdc('250'));
    env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: b.funded }), [env.risk]);
    env.ok(await env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(b.funded) }), [env.risk]);
    env.ok(await env.vault.sweepFees({ admin: env.admin.publicKey }), [env.admin]);

    assert.deepEqual(totals(env), { allocated: usdc('500'), fees: usdc('228'), paid: usdc('200'), toVault: usdc('50'), active: 1 });
    // capital = deposits − principal posted + returned from closures + vault profit share + swept fees
    assert.equal(env.usdcBalance(capitalVaultAddress()), deposit - usdc('1750') + usdc('250') + usdc('50') + usdc('228'));
    assert.equal(env.usdcBalance(a.ownerUsdc), usdc('500'));
  });
});

describe('owner SOL float and stuck orders', () => {
  it('tops the owner PDA up from the treasury only below the minimum (permissionless)', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const cranker = env.wallet();
    env.fails(await env.vault.topUpOwner({ funded: f.funded }), [cranker], 'OwnerFloatSufficient');
    env.svm.setAccount(f.owner, { lamports: 0.05 * LAMPORTS_PER_SOL, data: new Uint8Array(), owner: SystemProgram.programId, executable: false });
    const treasury = env.lamports(solTreasuryPda());
    const r = env.ok(await env.vault.topUpOwner({ funded: f.funded }), [cranker]);
    assert.equal(r.events[0]?.name, 'ownerToppedUp');
    const target = BigInt(CONFIG_PARAMS.ownerSolTarget.toString());
    assert.equal(env.lamports(f.owner), target);
    assert.equal(treasury - env.lamports(solTreasuryPda()), target - BigInt(0.05 * LAMPORTS_PER_SOL));
  });

  it('closes tracked orders GMTrade finished but left open, never pending or untracked ones', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const { instruction, order } = await env.vault.openPosition({
      trader: f.trader.publicKey, funded: env.funded(f.funded), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'market',
      collateral: usdc('100'), sizeDeltaUsd: 1000n * USD, acceptablePrice: 10n ** 30n,
    });
    env.ok(instruction, [f.trader]);
    const setState = (state: number) => {
      const acc = env.svm.getAccount(order)!;
      const data = Buffer.from(acc.data);
      data[9] = state;
      env.svm.setAccount(order, { ...acc, data });
    };
    const cranker = env.wallet();
    const closeCompleted = () => env.vault.closeCompletedOrder({ funded: f.funded, order });
    env.fails(await closeCompleted(), [cranker], 'OrderPending');
    setState(2); // Cancelled, but the keeper could not close it: 100 USDC still in escrow
    env.fails(await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order }), [f.trader], 'OrderNotPending');
    const lamports = env.lamports(f.owner);
    const r = env.ok(await closeCompleted(), [cranker]);
    assert.equal(r.events[0]?.name, 'completedOrderClosed');
    assert.equal(env.exists(order), false);
    assert.equal(env.usdcBalance(f.ownerUsdc), usdc('500'), 'escrowed USDC returned to the owner');
    assert.ok(env.lamports(f.owner) > lamports, 'order rent returned to the owner');
    assert.ok(env.account('fundedAccount', f.funded).orders.every((o) => o.order.equals(PublicKey.default)), 'no longer tracked');
    env.fails(await closeCompleted(), [cranker], 'OrderNotTracked');
  });
});
