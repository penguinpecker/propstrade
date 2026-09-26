// Sets Props.trade's fee per order (docs/design/order-fee.md): --usdc flat per order plus --bps of the order's size, at
// most 2 USDC and 10 bps (the program's caps: above them set_order_fee fails InvalidParams); 0 and 0 turn it off. It
// applies to orders placed or updated from then on, on every funded account (the program) and, once the program is
// live, on practice and evaluation accounts too (the server reads the same Config). Fees already assessed or due do not
// change, and setting 0 does not clear fees due. Both values are always named: set_order_fee sets both when it
// executes, and with --print-for Squads may execute an older proposal after a newer one. Before the first nonzero rate,
// check every prerequisite in docs/runbooks/launch.md §10.1.
import { fromMicro, orderFee, toMicro, type OrderFeeRate } from '@props/sdk';
import { main, setUp, submit } from './lib.ts';

const MAX_USDC = 2_000_000n; // programs/props_vault state.rs MAX_ORDER_FEE_USDC
const MAX_BPS = 10; // MAX_ORDER_FEE_BPS
const USD = 10n ** 20n;

main(async () => {
  const ctx = setUp(
    'node scripts/admin/set-order-fee.ts --usdc <USDC per order, e.g. 0.50> --bps <0-10> [--cluster ...] [--execute]\n' +
      '  Both are required (set_order_fee sets both). At most 2 USDC and 10 bps; --usdc 0 --bps 0 turns the fee off.',
    { usdc: { type: 'string' }, bps: { type: 'string' } },
  );
  const { usdc, bps } = ctx.values;
  if (usdc === undefined || bps === undefined) throw new Error('--usdc and --bps are both required: set_order_fee sets both when it executes');
  const feeUsdc = toMicro(String(usdc));
  if (!/^\d{1,2}$/.test(String(bps))) throw new Error('--bps must be a whole number of basis points');
  const feeBps = Number(bps);
  if (feeUsdc > MAX_USDC || feeBps > MAX_BPS) throw new Error(`the program caps the fee at ${fromMicro(MAX_USDC)} USDC and ${MAX_BPS} bps per order`);
  const config = await ctx.vault.fetchConfig();
  if (!config) throw new Error('props_vault is not initialized on this cluster');
  const show = (r: OrderFeeRate) => (r.feeUsdc === 0n && r.feeBps === 0
    ? 'off'
    : `${fromMicro(r.feeUsdc)} USDC + ${r.feeBps} bps per order (${fromMicro(orderFee(r, 1_000n * USD))} USDC on a $1,000 order, ${fromMicro(orderFee(r, 10_000n * USD))} on $10,000)`);
  console.log(`current ${show({ feeUsdc: BigInt(config.orderFeeUsdc.toString()), feeBps: config.orderFeeBps })}\nnew     ${show({ feeUsdc, feeBps })}`);
  await submit(ctx, 'set_order_fee', [await ctx.vault.setOrderFee({ admin: ctx.admin, feeUsdc, feeBps })]);
});
