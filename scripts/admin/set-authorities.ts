// Sets the risk authorities (≤ 4) and the KYC authority. Pass public keys only; never keypairs.
import { PublicKey } from '@solana/web3.js';
import { main, setUp, submit } from './lib.ts';

main(async () => {
  const ctx = setUp('node scripts/admin/set-authorities.ts --risk <pubkey>[,<pubkey>...] --kyc <pubkey> [--cluster ...] [--execute]', {
    risk: { type: 'string' },
    kyc: { type: 'string' },
  });
  if (!ctx.values.risk || !ctx.values.kyc) throw new Error('--risk and --kyc are required');
  const riskAuthorities = String(ctx.values.risk).split(',').map((k) => new PublicKey(k.trim()));
  const kycAuthority = new PublicKey(String(ctx.values.kyc));
  await submit(ctx, 'set_authorities', [
    await ctx.vault.setAuthorities({ admin: ctx.admin, riskAuthorities, kycAuthority }),
  ]);
});
