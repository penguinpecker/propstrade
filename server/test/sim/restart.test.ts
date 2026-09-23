// Restart recovery: a new engine on the same database takes over the open book (pending orders, positions) and
// redelivers every evaluation result the chain module has not confirmed as recorded.
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { expect, it } from 'vitest';
import type { SimOrderRequest } from '@props/shared';
import { fromUnitPrice, toUnitPrice } from '@props/sdk';
import type { EvaluationResult } from '../../src/modules/types.js';
import { startSim, type Sim } from './harness.js';

const later = () => Date.now() + 2_500;
const until = async (check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

async function order(sim: Sim, cookie: string, id: string, body: Partial<SimOrderRequest>) {
  const res = await sim.app.inject({
    method: 'POST', url: `/v1/sim/${encodeURIComponent(id)}/orders`, headers: { cookie, origin: 'https://app.props.test' },
    payload: { clientId: `c-${randomUUID()}`, symbol: 'SOL', side: 'Long', kind: 'Market', sizeUsd: '25000', collateralUsd: '1250', slippageBps: 50, ...body },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().order as { id: string };
}

it('takes over the open book after a restart and redelivers unrecorded results until they are recorded', async () => {
  const heard: Record<'a' | 'b' | 'c', EvaluationResult[]> = { a: [], b: [], c: [] };
  const a = await startSim('restart', { onResolved: (r) => heard.a.push(r) });
  const user = await a.user();
  const practice = `practice:${user.wallet}`;
  const evaluations = [Keypair.generate(), Keypair.generate()].map((k) => k.publicKey.toBase58());
  let pendingMarket: { id: string };
  let pendingLimit: { id: string };
  try {
    const terms = { tierId: 2, sizeUsd: '25000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8_000, termsHash: 'cd'.repeat(32) };
    await a.tick({ ...a.md.scaled('SOL', 1), session: 'open' });
    for (const ev of evaluations) {
      await a.sim.createEvaluation({ evaluation: ev, wallet: user.wallet, terms, purchasedAt: Date.now(), signature: '3'.repeat(87) });
      await order(a, user.cookie, ev, {});
    }
    await a.tick(a.md.scaled('SOL', 1, later()));
    await a.tick(a.md.scaled('SOL', 0.9, later())); // a 10% gap takes both whole allowances
    await a.rules();
    expect(heard.a.map((r) => [r.evaluation, r.passed]).sort()).toEqual(evaluations.map((e) => [e, false]).sort());

    await a.tick(a.md.scaled('SOL', 1, Date.now()));
    await order(a, user.cookie, practice, { sizeUsd: '5000', collateralUsd: '250' });
    await a.tick(a.md.scaled('SOL', 1, later()));
    pendingMarket = await order(a, user.cookie, practice, { sizeUsd: '1000', collateralUsd: '100' });
    const far = fromUnitPrice(toUnitPrice(a.md.price('SOL')!.mid, 9) * 2n, 9);
    pendingLimit = await order(a, user.cookie, practice, { side: 'Short', kind: 'Limit', triggerPrice: far, sizeUsd: '1000', collateralUsd: '100' });
  } finally {
    await a.stop();
  }

  const b = await startSim('restart', { databaseUrl: a.databaseUrl, onResolved: (r) => heard.b.push(r) });
  try {
    await until(() => heard.b.length === 2);
    expect([...heard.b].sort((x, y) => x.evaluation.localeCompare(y.evaluation)))
      .toEqual([...heard.a].sort((x, y) => x.evaluation.localeCompare(y.evaluation)));
    await b.rules(); // the leader's pass: B now watches A's pending orders
    await b.tick(b.md.scaled('SOL', 1, later()));
    const orders = (await b.sim.orders(user.wallet, practice))!;
    expect(orders.find((o) => o.id === pendingMarket.id)!.status).toBe('executed');
    expect(orders.find((o) => o.id === pendingLimit.id)!.status).toBe('awaiting_price');
    const detail = (await b.sim.detail(user.wallet, practice))!;
    expect(detail.positions.map((p) => [p.side, p.sizeUsd])).toEqual([['Long', '6000']]);
    expect(detail.freshness).toBe('live');
    await b.sim.markRecorded(evaluations[0]!, '2'.repeat(87));
  } finally {
    await b.stop();
  }

  const c = await startSim('restart', { databaseUrl: a.databaseUrl, onResolved: (r) => heard.c.push(r) });
  try {
    await until(() => heard.c.length > 0);
    expect(heard.c.map((r) => r.evaluation)).toEqual([evaluations[1]]);
  } finally {
    await c.stop();
  }
});
