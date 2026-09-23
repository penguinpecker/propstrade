// Sends SOL from the operator to the props_vault SOL treasury (PDA ["sol_treasury"]). The treasury pays each funded
// account's owner float at activation (Config.owner_sol_target), its later top-ups, and the rent of payout USDC
// accounts. Only the admin can take SOL back out (withdraw_sol_treasury).
import { SystemProgram } from '@solana/web3.js';
import { formatUnits, parseUnits, solTreasuryPda } from '@props/sdk';
import { main, setUp, submit } from './lib.ts';

main(async () => {
  const ctx = setUp('node scripts/admin/fund-sol-treasury.ts --sol <amount, e.g. 1.5> [--cluster ...] [--execute]', {
    sol: { type: 'string' },
  });
  if (!ctx.values.sol) throw new Error('--sol is required');
  const lamports = parseUnits(String(ctx.values.sol), 9);
  if (lamports === 0n) throw new Error('--sol must be more than 0');
  const treasury = solTreasuryPda();
  const before = BigInt(await ctx.connection.getBalance(treasury));
  console.log(`sol treasury ${treasury.toBase58()}: ${formatUnits(before, 9)} SOL → ${formatUnits(before + lamports, 9)} SOL`);
  await submit(ctx, `transfer ${ctx.values.sol} SOL`, [
    SystemProgram.transfer({ fromPubkey: ctx.admin, toPubkey: treasury, lamports }),
  ]);
});
