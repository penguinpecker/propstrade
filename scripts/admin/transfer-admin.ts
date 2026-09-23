// Two-step admin handover. The operator proposes the new admin (normally the Squads vault); the new admin
// must then sign accept_admin, which --print-accept prints for import into Squads as a custom instruction.
import { utils } from '@coral-xyz/anchor';
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
    const ix = await ctx.vault.acceptAdmin({ newAdmin });
    console.log(JSON.stringify({
      programId: ix.programId.toBase58(),
      accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
      dataBase58: utils.bytes.bs58.encode(ix.data),
    }, null, 2));
    return;
  }
  await submit(ctx, `propose_admin ${newAdmin.toBase58()}`, [await ctx.vault.proposeAdmin({ admin: ctx.operator.publicKey, newAdmin })]);
});
