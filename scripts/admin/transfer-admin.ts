// Two-step admin handover. The operator proposes the new admin (normally the Squads vault); the new admin
// must then sign accept_admin, which --print-accept simulates and prints as a transaction to import into Squads.
import { PublicKey } from '@solana/web3.js';
import { main, setUp, submit } from './lib.ts';

main(async () => {
  const ctx = setUp('node scripts/admin/transfer-admin.ts --to <NEW_ADMIN_PUBKEY> [--print-accept] [--cluster ...] [--execute]', {
    to: { type: 'string' },
    'print-accept': { type: 'boolean', default: false },
  });
  if (!ctx.values.to) throw new Error('--to is required');
  const newAdmin = new PublicKey(String(ctx.values.to));
  if (ctx.values['print-accept']) {
    // Built for the new admin, simulated (it fails until propose_admin has landed) and printed for Squads; nothing is sent.
    await submit({ ...ctx, admin: newAdmin, operator: null, execute: false }, 'accept_admin', [await ctx.vault.acceptAdmin({ newAdmin })]);
    return;
  }
  await submit(ctx, `propose_admin ${newAdmin.toBase58()}`, [await ctx.vault.proposeAdmin({ admin: ctx.admin, newAdmin })]);
});
