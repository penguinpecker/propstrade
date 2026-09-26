// Settles a funded account's Props order fees due with a risk authority key, for when the keeper cannot (it is down,
// or its key is out of reach): --charge USDC moves from the account's USDC to the fee vault, --waive USDC is forgiven,
// together at most the fees due. Charge only what executed orders owe (the rate of each one's assessment on the size it
// executed; the server's order_fees ledger and venue_fills show it), waive the rest. The script reads the account and
// names its fees due and settlement count in the instruction, so it fails rather than land on a changed account or
// twice (every settlement advances the count). OPERATOR_KEYPAIR must be a risk authority; with --print-for
// <RISK_AUTHORITY> the transaction is printed for that key instead. The server records it when indexed.
import { PublicKey } from '@solana/web3.js';
import { fromMicro, ownerUsdcAddress, toMicro } from '@props/sdk';
import { main, setUp, submit } from './lib.ts';

main(async () => {
  const ctx = setUp(
    'node scripts/admin/settle-order-fees.ts --funded <FUNDED_ACCOUNT> --charge <USDC> --waive <USDC> [--cluster ...] [--execute]\n' +
      '  Signed by a risk authority (OPERATOR_KEYPAIR, or --print-for <RISK_AUTHORITY>). charge + waive ≤ the fees due; charge ≤ the account\'s USDC.',
    { funded: { type: 'string' }, charge: { type: 'string' }, waive: { type: 'string' } },
  );
  const { funded, charge, waive } = ctx.values;
  if (funded === undefined || charge === undefined || waive === undefined) throw new Error('--funded, --charge and --waive are required');
  const address = new PublicKey(String(funded));
  const [config, account, usdc] = await Promise.all([
    ctx.vault.fetchConfig(), ctx.vault.fetchFunded(address), ctx.connection.getTokenAccountBalance(ownerUsdcAddress(address)).catch(() => null),
  ]);
  if (!config) throw new Error('props_vault is not initialized on this cluster');
  if (!account) throw new Error(`funded account ${address.toBase58()} not found`);
  if (!config.riskAuthorities.some((k) => k.equals(ctx.admin))) throw new Error(`${ctx.admin.toBase58()} is not a risk authority (status.ts lists them)`);
  const due = BigInt(account.orderFeesDue.toString());
  const settlements = BigInt(account.orderFeeSettlements.toString());
  const balance = usdc ? BigInt(usdc.value.amount) : 0n;
  const [amount, forgiven] = [toMicro(String(charge)), toMicro(String(waive))];
  console.log(`funded account ${address.toBase58()}: ${fromMicro(due)} USDC of order fees due, ${settlements} settlements so far, ${fromMicro(balance)} USDC in its account, ${fromMicro(BigInt(account.orderFeesPaid.toString()))} USDC charged in all`);
  if (amount + forgiven === 0n) throw new Error('nothing to settle: --charge and --waive are both 0');
  if (amount + forgiven > due) throw new Error(`charge + waive (${fromMicro(amount + forgiven)} USDC) is more than the ${fromMicro(due)} USDC due`);
  if (amount > balance) throw new Error(`--charge ${fromMicro(amount)} USDC is more than the ${fromMicro(balance)} USDC the account holds: charge what it covers and leave the rest due, or waive it`);
  console.log(`settle: charge ${fromMicro(amount)} USDC to the fee vault, waive ${fromMicro(forgiven)} USDC; ${fromMicro(due - amount - forgiven)} USDC stays due`);
  await submit(ctx, 'settle_order_fees', [await ctx.vault.settleOrderFees({
    riskAuthority: ctx.admin, funded: address, charge: amount, waive: forgiven, expectedDue: due, expectedSettlements: settlements,
  })]);
});
