// Security review: each test states an invariant from docs/ARCHITECTURE.md §3 (or the program's own doc
// comments) and tries to break it. A failing test here is a finding.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import {
  PROPS_VAULT_IDL,
  PROPS_VAULT_PROGRAM_ID,
  USDC_MINT,
  capitalVaultAddress,
  eventAuthorityPda,
  gmOrderEscrow,
  gmPositionPda,
  marketConfigPda,
  payoutPda,
  vaultAuthorityPda,
} from '@props/sdk';
import { CONFIG_PARAMS, Env, MARKETS, USD, usdc } from './env.ts';
import type { MarketName } from './env.ts';

type Funded = Awaited<ReturnType<Env['activeFunded']>>;

async function open(env: Env, f: Funded, market: MarketName, collateral: string, size: bigint, limitTrigger?: bigint) {
  const { instruction, order } = await env.vault.openPosition({
    trader: f.trader.publicKey,
    funded: env.funded(f.funded),
    marketToken: MARKETS[market].token,
    isLong: true,
    orderType: limitTrigger ? 'limit' : 'market',
    collateral: usdc(collateral),
    sizeDeltaUsd: size * USD,
    triggerPrice: limitTrigger,
    acceptablePrice: 10n ** 30n,
  });
  return { instruction, order, position: gmPositionPda(f.owner, MARKETS[market].token, true) };
}

/** A keeper filled the increase but its close was skipped: order Completed and still open, escrow drained. */
function fillButLeaveOpen(env: Env, order: PublicKey, position: PublicKey, size: bigint, collateral: bigint) {
  const a = env.svm.getAccount(order)!;
  const data = Buffer.from(a.data);
  data[9] = 1; // ActionState::Completed
  env.svm.setAccount(order, { ...a, data });
  env.setUsdcBalance(gmOrderEscrow(order), 0n);
  env.setPosition(position, size, collateral);
}

const slotOf = (env: Env, f: Funded, market: MarketName) =>
  env.account('fundedAccount', f.funded).slots.find((s) => s.marketToken.equals(MARKETS[market].token));

describe('security review', () => {
  it('cancel_order must not untrack an increase that GMTrade already filled (exposure, OI and flatness)', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded(); // S = $10,000, exposure cap $10,000, principal 500 USDC
    const sol = await open(env, f, 'SOL', '100', 1000n);
    env.ok(sol.instruction, [f.trader]);
    fillButLeaveOpen(env, sol.order, sol.position, 1000n * USD, usdc('99.9'));

    const cancel = env.send([await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order: sol.order })], [f.trader]);
    const live = env.gm('Position', sol.position);
    assert.equal(BigInt(live.state.size_in_usd.toString()), 1000n * USD, 'the $1,000 GMTrade position is still open');
    const oi = BigInt(env.account('marketConfig', marketConfigPda(MARKETS.SOL.token)).oiLongUsd.toString());
    assert.ok(
      !cancel.ok || (slotOf(env, f, 'SOL') !== undefined && oi === 1000n * USD),
      `cancel_order accepted a filled order: slot released=${slotOf(env, f, 'SOL') === undefined}, SOL long OI=${oi / USD}`,
    );
  });

  it('after that cancel, the trader cannot exceed S × exposure', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const sol = await open(env, f, 'SOL', '100', 1000n);
    env.ok(sol.instruction, [f.trader]);
    fillButLeaveOpen(env, sol.order, sol.position, 1000n * USD, usdc('99.9'));
    env.send([await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order: sol.order })], [f.trader]);

    // $1,000 live + $9,500 new = $10,500 > $10,000 cap.
    const eth = await open(env, f, 'ETH', '380', 9500n);
    const r = env.send([eth.instruction], [f.trader]);
    assert.ok(!r.ok, 'opened $9,500 on top of a live $1,000 position: account exposure cap bypassed');
  });

  it('after that cancel, close_funded (no positions passed) cannot close an account with a live position', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const sol = await open(env, f, 'SOL', '100', 1000n);
    env.ok(sol.instruction, [f.trader]);
    fillButLeaveOpen(env, sol.order, sol.position, 1000n * USD, usdc('99.9'));
    env.send([await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: env.funded(f.funded), order: sol.order })], [f.trader]);
    env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: f.funded }), [env.risk]);

    const r = env.send([await env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded) })], [env.risk]);
    assert.ok(!r.ok, 'account Closed and principal released while its $1,000 GMTrade position (99.9 USDC collateral) is open');
  });

  it('approve_payout / close_funded: an address that is not a position of the owner is not accepted as a flat position', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    env.setUsdcBalance(f.ownerUsdc, usdc('900'));
    env.ok(await env.vault.requestPayout({ trader: f.trader.publicKey, funded: f.funded, payoutSeq: 0 }), [f.trader]);
    const unrelated = Keypair.generate().publicKey; // never a GMTrade Position PDA of this owner
    const r = env.send(
      [await env.vault.approvePayout({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded), payout: payoutPda(f.funded, 0), positions: [unrelated] })],
      [env.risk],
    );
    assert.ok(!r.ok, 'an arbitrary system address passed the "verified by seeds" position re-check');
  });

  it('initialize cannot be blocked by anyone pre-creating the capital vault ATA', async () => {
    const env = new Env();
    const griefer = env.wallet();
    env.ok(
      createAssociatedTokenAccountIdempotentInstruction(griefer.publicKey, capitalVaultAddress(), vaultAuthorityPda(), USDC_MINT),
      [griefer],
    );
    const r = env.send([await env.vault.initialize({ admin: env.admin.publicKey, params: CONFIG_PARAMS })], [env.admin]);
    assert.ok(r.ok, `initialize failed after a stranger created ATA(vault, USDC): ${r.error}`);
  });

  it('close_funded does not strand USDC held by an order GMTrade cancelled but left open', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const sol = await open(env, f, 'SOL', '100', 1000n);
    env.ok(sol.instruction, [f.trader]);
    const a = env.svm.getAccount(sol.order)!;
    const data = Buffer.from(a.data);
    data[9] = 2; // ActionState::Cancelled; the keeper's close was skipped, 100 USDC still in escrow
    env.svm.setAccount(sol.order, { ...a, data });
    env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [f.trader]); // keeps it: its escrow still holds USDC
    env.ok(await env.vault.markBreached({ riskAuthority: env.risk.publicKey, funded: f.funded }), [env.risk]);
    env.fails(await env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded) }), [env.risk], 'NotFlat');

    env.ok(await env.vault.closeCompletedOrder({ funded: f.funded, order: sol.order }), [env.risk]);
    env.ok(await env.vault.sync({ funded: env.funded(f.funded) }), [env.risk]);
    const capital = env.usdcBalance(capitalVaultAddress());
    env.ok(await env.vault.closeFunded({ riskAuthority: env.risk.publicKey, funded: env.funded(f.funded) }), [env.risk]);
    assert.equal(env.exists(gmOrderEscrow(sol.order)), false, `100 USDC left in ${gmOrderEscrow(sol.order).toBase58()}`);
    assert.equal(env.usdcBalance(capitalVaultAddress()) - capital, usdc('500'), 'the whole principal, escrow included, is back in the vault');
  });

  it('a restricted account cannot re-price a pending limit increase (restricted = reduce risk only)', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const limit = await open(env, f, 'ETH', '100', 1000n, 1000n * 10n ** 11n); // buy ETH far below market
    env.ok(limit.instruction, [f.trader]);
    env.ok(await env.vault.restrict({ riskAuthority: env.risk.publicKey, funded: f.funded, restricted: true }), [env.risk]);
    const r = env.send(
      [await env.vault.updateOrder({ trader: f.trader.publicKey, funded: env.funded(f.funded), order: limit.order, triggerPrice: 10n ** 20n })],
      [f.trader],
    );
    assert.ok(!r.ok, 'restricted trader moved a limit increase trigger to fill immediately');
  });

  it('events cannot be cut off with the logs (self-CPI, not log lines), and nobody but the program can emit one', async () => {
    const env = new Env();
    await env.setUpVault();
    const trader = env.wallet();
    const evaluation = await env.passedEvaluation(trader);
    // Cheap log spam ahead of the trader's own instruction pushes its log lines past Solana's 10,000-byte cut-off.
    const memo = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    const spam = Array.from({ length: 50 }, () => new TransactionInstruction({ programId: memo, keys: [], data: Buffer.from('x') }));
    const r = env.ok([...spam, await env.vault.activateFunded({ trader: trader.publicKey, evaluation })], [trader]);
    assert.ok(r.logs.includes('Log truncated'), 'the logs were cut off');
    assert.deepEqual(r.events.map((e) => e.name), ['fundedActivated'], 'the event is still in the transaction');

    // Event data sent to the program directly: only a CPI signed by the program's event authority is accepted.
    const tag = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
    const discriminator = Buffer.from(PROPS_VAULT_IDL.events.find((e) => e.name === 'FundedActivated')!.discriminator);
    const forged = new TransactionInstruction({
      programId: PROPS_VAULT_PROGRAM_ID,
      keys: [{ pubkey: eventAuthorityPda(), isSigner: false, isWritable: false }],
      data: Buffer.concat([tag, discriminator, Buffer.alloc(200)]),
    });
    env.fails(forged, [trader], 'ConstraintSigner');
  });
});
