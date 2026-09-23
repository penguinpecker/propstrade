// Moves USDC from the operator's USDC account into the capital vault.
import { main, setUp, submit } from './lib.ts';
import { toMicro } from '@props/sdk';

main(async () => {
  const ctx = setUp('node scripts/admin/deposit-capital.ts --amount <USDC, e.g. 5000> [--cluster ...] [--execute]', {
    amount: { type: 'string' },
  });
  if (!ctx.values.amount) throw new Error('--amount is required');
  const amount = toMicro(String(ctx.values.amount));
  await submit(ctx, `deposit_capital ${ctx.values.amount} USDC`, [await ctx.vault.depositCapital({ admin: ctx.admin, amount })]);
});
