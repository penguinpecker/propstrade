// Upserts the spec §1 tiers. Each tier's terms hash is sha256 of its canonical rules JSON (printed), so the
// published rules can be checked against the onchain tier. `--test-tier` adds one more, small tier for local
// rehearsals (scripts/local-stack.ts); it is refused on mainnet.
import { createHash } from 'node:crypto';
import BN from 'bn.js';
import { toMicro } from '@props/sdk';
import { main, setUp, submit } from './lib.ts';

const RULES = {
  profitTargetBps: 800, // 8% of S, evaluation only, net of costs
  maxDrawdownBps: 500, // loss allowance L = 5% of S, static floor S − L, includes open P&L and costs
  maxExposureBps: 10_000, // Σ open notional ≤ 1.0 × S
  traderShareBps: 8000,
  drawdown: 'static',
  includesOpenPnl: true,
  dailyLossLimit: null,
  timeLimit: null,
  minTradingDays: null,
} as const;

const TIERS = [
  { id: 1, name: '10K', sizeUsd: '10000', feeUsdc: '79', enabled: true },
  { id: 2, name: '25K', sizeUsd: '25000', feeUsdc: '149', enabled: true },
  { id: 3, name: '50K', sizeUsd: '50000', feeUsdc: '249', enabled: false }, // pool depth limits size at launch
  { id: 4, name: '100K', sizeUsd: '100000', feeUsdc: '449', enabled: false },
];

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

main(async () => {
  const ctx = setUp('node scripts/admin/upsert-tiers.ts [--test-tier <id>:<sizeUsd>:<feeUsdc>:<profitTargetBps>] [--cluster ...] [--execute]', {
    'test-tier': { type: 'string' },
  });
  const tiers: { id: number; name: string; sizeUsd: string; feeUsdc: string; enabled: boolean; profitTargetBps?: number }[] = [...TIERS];
  if (ctx.values['test-tier']) {
    if ((await ctx.connection.getGenesisHash()) === MAINNET_GENESIS) throw new Error('--test-tier is for local clusters only');
    const [id, sizeUsd, feeUsdc, profitTargetBps] = String(ctx.values['test-tier']).split(':');
    if (!/^\d+$/.test(id ?? '') || !sizeUsd || !feeUsdc || !/^\d+$/.test(profitTargetBps ?? '')) {
      throw new Error('--test-tier takes <id>:<sizeUsd>:<feeUsdc>:<profitTargetBps>, e.g. 9:1000:1:10');
    }
    tiers.push({ id: Number(id), name: `test ${sizeUsd}`, sizeUsd, feeUsdc, enabled: true, profitTargetBps: Number(profitTargetBps) });
  }
  const instructions = [];
  for (const t of tiers) {
    const rules = { ...RULES, profitTargetBps: t.profitTargetBps ?? RULES.profitTargetBps };
    const terms = JSON.stringify({ tier: t.name, sizeUsd: t.sizeUsd, feeUsdc: t.feeUsdc, ...rules });
    const termsHash = createHash('sha256').update(terms).digest();
    console.log(`tier ${t.id} ${t.name}: fee ${t.feeUsdc} USDC, ${t.enabled ? 'enabled' : 'disabled'}, terms ${termsHash.toString('hex')}`);
    instructions.push(
      await ctx.vault.upsertTier({
        admin: ctx.operator.publicKey,
        id: t.id,
        params: {
          sizeUsd: new BN(toMicro(t.sizeUsd).toString()),
          feeUsdc: new BN(toMicro(t.feeUsdc).toString()),
          profitTargetBps: rules.profitTargetBps,
          maxDrawdownBps: RULES.maxDrawdownBps,
          maxExposureBps: RULES.maxExposureBps,
          enabled: t.enabled,
          termsHash: Array.from(termsHash),
        },
      }),
    );
  }
  await submit(ctx, `upsert_tier ×${instructions.length}`, instructions);
});
