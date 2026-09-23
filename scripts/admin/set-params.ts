// Changes the Config parameters. Parameters not given keep their current onchain value. Evaluations and funded
// accounts keep the terms pinned at purchase; the trader share of a funded account is part of those terms.
import BN from 'bn.js';
import { formatUnits, fromMicro, parseUnits, toMicro } from '@props/sdk';
import { main, setUp, submit } from './lib.ts';

main(async () => {
  const ctx = setUp(
    'node scripts/admin/set-params.ts [--trader-share-bps 8000] [--min-payout <USDC>] [--owner-sol-target <SOL>] [--owner-sol-min <SOL>] [--cluster ...] [--execute]',
    {
      'trader-share-bps': { type: 'string' },
      'min-payout': { type: 'string' },
      'owner-sol-target': { type: 'string' },
      'owner-sol-min': { type: 'string' },
    },
  );
  const config = await ctx.vault.fetchConfig();
  if (!config) throw new Error('props_vault is not initialized on this cluster');
  const value = (name: string) => (ctx.values[name] === undefined ? undefined : String(ctx.values[name]));
  const share = value('trader-share-bps');
  if (share !== undefined && !/^\d+$/.test(share)) throw new Error('--trader-share-bps must be an integer');
  const params = {
    traderShareBps: share === undefined ? config.traderShareBps : Number(share),
    minPayout: value('min-payout') === undefined ? config.minPayout : new BN(toMicro(value('min-payout')!).toString()),
    ownerSolTarget: value('owner-sol-target') === undefined ? config.ownerSolTarget : new BN(parseUnits(value('owner-sol-target')!, 9).toString()),
    ownerSolMin: value('owner-sol-min') === undefined ? config.ownerSolMin : new BN(parseUnits(value('owner-sol-min')!, 9).toString()),
  };
  const show = (p: typeof params) =>
    `trader share ${p.traderShareBps} bps, min payout ${fromMicro(BigInt(p.minPayout.toString()))} USDC, owner float ${formatUnits(BigInt(p.ownerSolTarget.toString()), 9)} SOL (top-up below ${formatUnits(BigInt(p.ownerSolMin.toString()), 9)} SOL)`;
  console.log(`current ${show(config)}\nnew     ${show(params)}`);
  await submit(ctx, 'set_params', [await ctx.vault.setParams({ admin: ctx.admin, params })]);
});
