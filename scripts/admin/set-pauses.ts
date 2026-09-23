// Sets the three pause flags. Flags not given keep their current onchain value.
import { main, setUp, submit } from './lib.ts';

const FLAGS = ['new-evaluations', 'trading', 'payouts'] as const;

main(async () => {
  const ctx = setUp(
    'node scripts/admin/set-pauses.ts [--new-evaluations on|off] [--trading on|off] [--payouts on|off] [--cluster ...] [--execute]\n' +
      '  "on" pauses. Pauses stop new evaluations, opens and payouts; closes and cancels always work.',
    Object.fromEntries(FLAGS.map((f) => [f, { type: 'string' as const }])),
  );
  const config = await ctx.vault.fetchConfig();
  if (!config) throw new Error('props_vault is not initialized on this cluster');
  const flag = (name: (typeof FLAGS)[number], current: boolean): boolean => {
    const v = ctx.values[name];
    if (v === undefined) return current;
    if (v !== 'on' && v !== 'off') throw new Error(`--${name} must be "on" or "off"`);
    return v === 'on';
  };
  const paused = {
    newEvaluations: flag('new-evaluations', config.paused.newEvaluations),
    trading: flag('trading', config.paused.trading),
    payouts: flag('payouts', config.paused.payouts),
  };
  console.log('current', config.paused, '→ new', paused);
  await submit(ctx, 'set_pauses', [await ctx.vault.setPauses({ admin: ctx.operator.publicKey, paused })]);
});
