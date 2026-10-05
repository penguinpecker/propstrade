// Creates the props_vault config, capital vault and fee vault. The operator must be the program's upgrade
// authority. Everything starts paused. Parameters are the spec §1 defaults; change them later with set_params.
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import BN from 'bn.js';
import { toMicro } from '@props/sdk';
import { main, setUp, submit } from './lib.ts';

main(async () => {
  const ctx = setUp('node scripts/admin/initialize.ts [--cluster ...] [--execute]');
  const params = {
    traderShareBps: 8000, // 80% trader / 20% vault
    minPayout: new BN(toMicro('10').toString()), // 10 USDC trader share
    // Owner PDA float: a position prepays ≈0.026 SOL and each pending order ≈0.02 SOL (refundable).
    ownerSolTarget: new BN(0.25 * LAMPORTS_PER_SOL),
    ownerSolMin: new BN(0.1 * LAMPORTS_PER_SOL),
    // Principal new funded accounts may receive per day: five 10K accounts (500 USDC each). Raise it with set_params
    // as the vault grows; it bounds what a compromised server key or database can put at risk.
    maxDailyPrincipal: new BN(toMicro('2500').toString()),
  };
  await submit(ctx, 'initialize', [await ctx.vault.initialize({ admin: ctx.admin, params })]);
});
