// Grows the props_vault program data account by --bytes with the loader's top-level ExtendProgram, paid by the operator
// (runbook §14.3). Any key may send it while ExtendProgramChecked (2oMRZEDWT2tqtYMofhmmfQ8SsjqUFzT6sYXppQDavxwz) is
// inactive, so it needs no upgrade authority: after the handover the Squads vault cannot extend (the loader refuses
// ExtendProgram as an inner instruction) and `solana program extend` insists on the upgrade authority's key.
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { PROPS_VAULT_PROGRAM_ID } from '@props/sdk';
import { main, setUp, submit } from './lib.ts';

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

main(async () => {
  const ctx = setUp('node scripts/admin/extend-program.ts --bytes <N> [--cluster ...] [--execute]', { bytes: { type: 'string' } });
  if (!ctx.operator) throw new Error('--print-for does not apply: Squads cannot send ExtendProgram (runbook §14.3)');
  const bytes = Number(ctx.values.bytes);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > 0xffff_ffff) throw new Error('--bytes must be a whole number of bytes above 0');
  const [programData] = PublicKey.findProgramAddressSync([PROPS_VAULT_PROGRAM_ID.toBuffer()], LOADER);
  const data = Buffer.alloc(8);
  data.writeUInt32LE(6, 0); // UpgradeableLoaderInstruction::ExtendProgram { additional_bytes }
  data.writeUInt32LE(bytes, 4);
  await submit(ctx, `extend program data ${programData.toBase58()} by ${bytes} bytes`, [
    new TransactionInstruction({
      programId: LOADER,
      keys: [
        { pubkey: programData, isSigner: false, isWritable: true },
        { pubkey: PROPS_VAULT_PROGRAM_ID, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ctx.admin, isSigner: true, isWritable: true }, // payer of the added rent
      ],
      data,
    }),
  ]);
});
