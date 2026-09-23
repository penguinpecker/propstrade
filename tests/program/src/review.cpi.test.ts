// Review of the Pinocchio port: every GMTrade CPI is signed by the owner PDA, the authority of the account's USDC, so
// a build that invoked a caller-chosen `gmtrade_program` would hand that signature to any program. Anchor refuses a
// substituted program before anything runs (`Program<'info, GmsolStore>`: InvalidProgramId); every build must.
import { describe, it } from 'node:test';
import type { Keypair, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { CLOSE_ALL, GMTRADE_PROGRAM_ID, gmOrderEscrow, gmPositionPda } from '@props/sdk';
import { Env, MARKETS, USD, swapKey, usdc } from './env.ts';

describe('CPI program pinning', () => {
  it('every instruction that signs a GMTrade CPI as the owner PDA refuses another program in its place', async () => {
    const env = new Env();
    await env.setUpVault();
    const f = await env.activeFunded();
    const funded = () => env.funded(f.funded);
    /** Refused with SPL Token (executable, and a program the owner PDA's signature could move USDC with) as GMTrade; accepted as built. */
    const pinned = (ix: TransactionInstruction, signer: Keypair = f.trader) => {
      env.fails(swapKey(ix, GMTRADE_PROGRAM_ID, TOKEN_PROGRAM_ID), [signer], 'InvalidProgramId');
      env.ok(ix, [signer]);
    };
    const sol = { marketToken: MARKETS.SOL.token, isLong: true };

    const open = await env.vault.openPosition({
      trader: f.trader.publicKey, funded: funded(), ...sol, orderType: 'market', collateral: usdc('100'), sizeDeltaUsd: 1000n * USD, acceptablePrice: 10n ** 30n,
    });
    pinned(open.instruction);
    // A keeper filled it and left the order open (Completed, escrow drained).
    const order = env.svm.getAccount(open.order)!;
    const data = Buffer.from(order.data);
    data[9] = 1;
    env.svm.setAccount(open.order, { ...order, data });
    env.setUsdcBalance(gmOrderEscrow(open.order), 0n);
    env.setPosition(gmPositionPda(f.owner, MARKETS.SOL.token, true), 1000n * USD, usdc('99.9'));
    pinned(await env.vault.closeCompletedOrder({ funded: f.funded, order: open.order }));
    env.ok(await env.vault.sync({ funded: funded() }), [f.trader]);

    const sl = await env.vault.setProtection({ trader: f.trader.publicKey, funded: funded(), ...sol, orderType: 'stopLoss', triggerPrice: 100n * 10n ** 11n, sizeDeltaUsd: 1000n * USD });
    pinned(sl.instruction);
    pinned(await env.vault.updateOrder({ trader: f.trader.publicKey, funded: funded(), order: sl.order, triggerPrice: 90n * 10n ** 11n }));
    pinned(await env.vault.cancelOrder({ authority: f.trader.publicKey, funded: funded(), order: sl.order }));
    pinned((await env.vault.closePosition({ authority: f.trader.publicKey, funded: funded(), ...sol, sizeDeltaUsd: CLOSE_ALL, acceptablePrice: 1n })).instruction);
  });
});
