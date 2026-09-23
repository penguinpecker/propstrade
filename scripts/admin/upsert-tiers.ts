// Upserts the spec §1 tiers. Each tier's terms hash is sha256 of its canonical rules JSON (printed), so the
// published rules can be checked against the onchain tier.
// --smoke-test instead makes tier 1 a tiny account for the mainnet smoke test (docs/runbooks/launch.md) and disables
// the others: 200 USD size (a 10 USDC loss allowance), 1 USDC fee, 0.1% target. Purchased evaluations keep the terms
// they were bought with, so running this script again without the flag restores the spec tiers for everyone else.
// --test-tier adds one more, small tier for local rehearsals (scripts/local-stack.ts); it is refused on mainnet.
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
  { id: 1, name: '10K', sizeUsd: '10000', feeUsdc: '79', enabled: true, rules: RULES },
  { id: 2, name: '25K', sizeUsd: '25000', feeUsdc: '149', enabled: true, rules: RULES },
  { id: 3, name: '50K', sizeUsd: '50000', feeUsdc: '249', enabled: false, rules: RULES }, // pool depth limits size at launch
  { id: 4, name: '100K', sizeUsd: '100000', feeUsdc: '449', enabled: false, rules: RULES },
];
const SMOKE_TEST_TIERS = [
  { id: 1, name: 'smoke test', sizeUsd: '200', feeUsdc: '1', enabled: true, rules: { ...RULES, profitTargetBps: 10 } },
  ...TIERS.slice(1).map((t) => ({ ...t, enabled: false })),
];

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

main(async () => {
  const ctx = setUp('node scripts/admin/upsert-tiers.ts [--smoke-test] [--test-tier <id>:<sizeUsd>:<feeUsdc>:<profitTargetBps>] [--cluster ...] [--execute]', {
    'smoke-test': { type: 'boolean', default: false },
    'test-tier': { type: 'string' },
  });
  const tiers: { id: number; name: string; sizeUsd: string; feeUsdc: string; enabled: boolean; rules: Omit<typeof RULES, 'profitTargetBps'> & { profitTargetBps: number } }[] =
    [...(ctx.values['smoke-test'] ? SMOKE_TEST_TIERS : TIERS)];
  if (ctx.values['test-tier']) {
    if ((await ctx.connection.getGenesisHash()) === MAINNET_GENESIS) throw new Error('--test-tier is for local clusters only');
    const [id, sizeUsd, feeUsdc, profitTargetBps] = String(ctx.values['test-tier']).split(':');
    if (!/^\d+$/.test(id ?? '') || !sizeUsd || !feeUsdc || !/^\d+$/.test(profitTargetBps ?? '')) {
      throw new Error('--test-tier takes <id>:<sizeUsd>:<feeUsdc>:<profitTargetBps>, e.g. 9:1000:1:10');
    }
    tiers.push({ id: Number(id), name: `test ${sizeUsd}`, sizeUsd, feeUsdc, enabled: true, rules: { ...RULES, profitTargetBps: Number(profitTargetBps) } });
  }
  const instructions = [];
  for (const t of tiers) {
    const terms = JSON.stringify({ tier: t.name, sizeUsd: t.sizeUsd, feeUsdc: t.feeUsdc, ...t.rules });
    const termsHash = createHash('sha256').update(terms).digest();
    console.log(`tier ${t.id} ${t.name}: size ${t.sizeUsd} USD, fee ${t.feeUsdc} USDC, target ${t.rules.profitTargetBps / 100}%, ${t.enabled ? 'enabled' : 'disabled'}, terms ${termsHash.toString('hex')}`);
    instructions.push(
      await ctx.vault.upsertTier({
        admin: ctx.admin,
        id: t.id,
        params: {
          sizeUsd: new BN(toMicro(t.sizeUsd).toString()),
          feeUsdc: new BN(toMicro(t.feeUsdc).toString()),
          profitTargetBps: t.rules.profitTargetBps,
          maxDrawdownBps: t.rules.maxDrawdownBps,
          maxExposureBps: t.rules.maxExposureBps,
          enabled: t.enabled,
          termsHash: Array.from(termsHash),
        },
      }),
    );
  }
  await submit(ctx, `upsert_tier ×${instructions.length}`, instructions);
});
