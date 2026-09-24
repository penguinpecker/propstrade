// Changes the Config parameters. Parameters not given keep their current onchain value, except with --print-for:
// set_params sets all five when it executes, and Squads executes an approved older proposal after a newer one, so a
// value copied from the chain now could undo a later change (a lowered --max-daily-principal). There every parameter
// must be named. Evaluations and funded accounts keep the terms pinned at purchase; the trader share of a funded
// account is part of those terms.
import BN from 'bn.js';
import { formatUnits, fromMicro, parseUnits, toMicro } from '@props/sdk';
import { main, setUp, submit } from './lib.ts';

const PARAMS = ['trader-share-bps', 'min-payout', 'owner-sol-target', 'owner-sol-min', 'max-daily-principal'] as const;

main(async () => {
  const ctx = setUp(
    'node scripts/admin/set-params.ts [--trader-share-bps 8000] [--min-payout <USDC>] [--owner-sol-target <SOL>] [--owner-sol-min <SOL>] [--max-daily-principal <USDC>] [--cluster ...] [--execute]\n' +
      '  With --print-for, name all five: the proposal sets every parameter when it executes.',
    Object.fromEntries(PARAMS.map((p) => [p, { type: 'string' as const }])),
  );
  const missing = PARAMS.filter((p) => ctx.values[p] === undefined);
  if (!ctx.operator && missing.length) {
    throw new Error(`--print-for needs every parameter: add ${missing.map((p) => `--${p}`).join(', ')} (the proposal sets all five when it executes, whatever the chain says then)`);
  }
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
    maxDailyPrincipal: value('max-daily-principal') === undefined ? config.maxDailyPrincipal : new BN(toMicro(value('max-daily-principal')!).toString()),
  };
  const show = (p: typeof params) =>
    `trader share ${p.traderShareBps} bps, min payout ${fromMicro(BigInt(p.minPayout.toString()))} USDC, owner float ${formatUnits(BigInt(p.ownerSolTarget.toString()), 9)} SOL (top-up below ${formatUnits(BigInt(p.ownerSolMin.toString()), 9)} SOL), max ${fromMicro(BigInt(p.maxDailyPrincipal.toString()))} USDC principal a day`;
  console.log(`current ${show(config)}\nnew     ${show(params)}`);
  await submit(ctx, 'set_params', [await ctx.vault.setParams({ admin: ctx.admin, params })]);
});
