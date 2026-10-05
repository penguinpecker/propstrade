// Review findings against the sim engine, kept as regression tests: each states the behaviour the engine must have.
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PriceTick, SimOrderRequest, SimOrderResponse } from '@props/shared';
import { model } from '@props/gmsol-wasm';
import { fromUnitPrice, toUnitPrice } from '@props/sdk';
import { startSim, type Sim } from './harness.js';

let t: Sim;
beforeAll(async () => { t = await startSim('review'); });
afterAll(async () => { await t.stop(); });

type User = Awaited<ReturnType<Sim['user']>>;
const practiceOf = (u: User) => `practice:${u.wallet}`;
const path = (id: string) => `/v1/sim/${encodeURIComponent(id)}`;
const clientId = () => `c-${randomUUID()}`;
const later = () => Date.now() + 2_500;
const base = (symbol: string, session: PriceTick['session'] = 'open') => t.tick({ ...t.md.scaled(symbol, 1), session });
const mid = (symbol = 'SOL') => toUnitPrice(t.md.price(symbol)!.mid, 9);
const priceAt = (pct: bigint) => fromUnitPrice((mid() * pct) / 1000n, 9);

async function placed(u: User, id: string, body: Partial<SimOrderRequest> = {}) {
  const res = await u.post(`${path(id)}/orders`, {
    clientId: clientId(), symbol: 'SOL', side: 'Long', kind: 'Market', sizeUsd: '10000', collateralUsd: '500', slippageBps: 50, ...body,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SimOrderResponse;
}
const positions = async (u: User, id: string) => (await t.sim.positions(u.wallet, id))!;

async function evaluation(u: User) {
  const id = Keypair.generate().publicKey.toBase58();
  const terms = { tierId: 2, sizeUsd: '25000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8_000, termsHash: 'ab'.repeat(32) };
  await t.sim.createEvaluation({ evaluation: id, wallet: u.wallet, terms, purchasedAt: Date.now(), signature: '4'.repeat(87) });
  return id;
}

describe('hand derivation', () => {
  it('fills a 10,000 USD SOL long at the price, impact and fee derived by hand from the Market account', async () => {
    // Market config (fixture): OI long 973,192.40 / short 985,277.39 USD, impact exponent 2, positive factor 5e-10,
    // order fee 1 bp when the order improves balance. d0 = 12,084.99, d1 = 2,084.99 (still short-heavy):
    //   impact = 5e-10 × (d0² − d1²) = 0.0708499…;  fee = 10,000 × 0.0001 = 1
    //   tokens = (10,000 + impact) / max 118.5574 = 84.347926404;  price = 10,000 / tokens = 118.55656002855
    //   collateral = 500 − 1 / USDC min 0.999902 = 498.999902 USDC → realized −1.000098
    const u = await t.user();
    const id = await t.practice(u);
    await base('SOL');
    const { order } = await placed(u, id);
    await t.tick({ ...t.md.recorded('SOL').at(-1)!, ts: order.createdAt + 2_000 });
    const [fill] = (await u.get(`${path(id)}/fills`)).json();
    expect(fill).toMatchObject({ price: '118.55656002855', feeUsd: '1', priceImpactUsd: '0.07085', realizedPnl: '-1.000098' });
    expect((await positions(u, id))[0]).toMatchObject({ sizeTokens: '84.347926404', collateralUsd: '498.999902' });
  });
});

describe('fees over time', () => {
  it('charges no borrowing for the time before a position existed', async () => {
    // Recorded state: SOL's Market account was last written 17 min before capture, BTC's 54 min, NVDA's 5.6 h; an hour
    // is ordinary. SOL longs are the smaller side (973k vs 985k OI), so they pay no borrowing; a 25,000 long makes
    // them the larger side. The open snapshot accrues the hour at the rate without the position (0), every later
    // valuation re-accrues the same hour at the rate with it, and the difference is charged to the new position.
    const u = await t.user();
    const id = await t.practice(u);
    t.md.clockAgeSeconds = 3_600;
    try {
      await base('SOL');
      await placed(u, id, { sizeUsd: '25000', collateralUsd: '1250' });
      await t.tick(t.md.scaled('SOL', 1, later()));
      const [position] = await positions(u, id);
      const close = await u.post(`${path(id)}/positions/${position!.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 50 });
      expect(close.statusCode, close.body).toBe(200);
      await t.tick(t.md.scaled('SOL', 1, later())); // closed ~2.5 s (simulated) after it opened
      const [, exit] = (await u.get(`${path(id)}/fills`)).json();
      console.log('pending borrowing right after open', position!.pendingBorrowUsd, '| borrowUsd charged on the close', exit.borrowUsd);
      expect(Number(position!.pendingBorrowUsd) + Number(position!.pendingFundingUsd)).toBeLessThan(0.01);
      expect(Number(exit.borrowUsd)).toBeLessThan(0.01);
    } finally {
      t.md.clockAgeSeconds = 0;
    }
  });
});

describe('closes', () => {
  it('a 100% close leaves the account flat even when an earlier increase fills on the same tick', async () => {
    const u = await t.user();
    const id = await t.practice(u);
    await base('SOL');
    await placed(u, id, { sizeUsd: '10000', collateralUsd: '500' });
    await t.tick(t.md.scaled('SOL', 1, later()));
    const [position] = await positions(u, id);
    await placed(u, id, { sizeUsd: '5000', collateralUsd: '250' }); // pending increase
    const close = await u.post(`${path(id)}/positions/${position!.id}/close`, { clientId: clientId(), percent: 100, slippageBps: 50 });
    expect(close.statusCode, close.body).toBe(200);
    await t.tick(t.md.scaled('SOL', 1, later())); // both eligible: the increase (older) executes first
    // GMTrade's CLOSE_ALL (§8) closes whatever the position is at execution; the engine closes the old size only.
    expect((await positions(u, id)).map((p) => p.sizeUsd)).toEqual([]);
  });
});

describe('protection', () => {
  it('a stop loss placed with an increase does not shrink the protection of the position it joins', async () => {
    const u = await t.user();
    const id = await t.practice(u);
    await base('SOL');
    await placed(u, id, { sizeUsd: '10000', collateralUsd: '500', stopLoss: priceAt(980n) });
    await t.tick(t.md.scaled('SOL', 1, later()));
    await placed(u, id, { sizeUsd: '2000', collateralUsd: '100', stopLoss: priceAt(975n) });
    await t.tick(t.md.scaled('SOL', 1, later()));
    const [position] = await positions(u, id);
    expect(position).toMatchObject({ sizeUsd: '12000', stopLoss: { price: priceAt(975n) } }); // one stop loss shown
    const stops = (await t.sim.orders(u.wallet, id))!.filter((o) => o.kind === 'StopLoss');
    expect(stops.map((o) => [o.sizeUsd, o.status, o.statusDetail ?? null]).sort()).toEqual([
      ['10000', 'canceled', 'Replaced by a new price'], ['12000', 'awaiting_price', null], // it covers the whole position
    ]);
    await t.tick(t.md.scaled('SOL', 0.97, later())); // through the stop loss the position shows
    expect((await positions(u, id)).map((p) => p.sizeUsd)).toEqual([]);
  });

  it('protection set on a position also covers what is added to it later', async () => {
    const u = await t.user();
    const id = await t.practice(u);
    await base('SOL');
    await placed(u, id, { sizeUsd: '10000', collateralUsd: '500' });
    await t.tick(t.md.scaled('SOL', 1, later()));
    const [position] = await positions(u, id);
    const res = await u.put(`${path(id)}/positions/${position!.id}/protection`, { takeProfit: null, stopLoss: priceAt(980n) });
    expect(res.statusCode, res.body).toBe(200);
    await placed(u, id, { sizeUsd: '5000', collateralUsd: '250' });
    await t.tick(t.md.scaled('SOL', 1, later()));
    expect((await t.sim.orders(u.wallet, id))!.find((o) => o.kind === 'StopLoss')).toMatchObject({ sizeUsd: '15000', status: 'awaiting_price' });
    await t.tick(t.md.scaled('SOL', 0.97, later()));
    expect(await positions(u, id)).toEqual([]);
  });
});

describe('funded parity', () => {
  it('limits an evaluation to the 8 tracked orders a funded account can hold (program MAX_ORDERS)', async () => {
    const u = await t.user();
    const ev = await evaluation(u);
    await base('SOL');
    const far = fromUnitPrice(mid() / 2n, 9);
    for (let i = 0; i < 8; i++) await placed(u, ev, { kind: 'Limit', triggerPrice: far, sizeUsd: '100', collateralUsd: '10' });
    const ninth = await u.post(`${path(ev)}/orders`, {
      clientId: clientId(), symbol: 'SOL', side: 'Long', kind: 'Limit', triggerPrice: far, sizeUsd: '100', collateralUsd: '10', slippageBps: 50,
    });
    expect(ninth.statusCode).toBe(422);
  });

  it('counts each take profit and stop loss as an order, and limits positions to the 8 slots a funded account has', async () => {
    const u = await t.user();
    const id = await t.practice(u);
    await base('SOL');
    const far = fromUnitPrice(mid() / 2n, 9);
    for (let i = 0; i < 6; i++) await placed(u, id, { kind: 'Limit', triggerPrice: far, sizeUsd: '100', collateralUsd: '10' });
    const both = { kind: 'Limit' as const, triggerPrice: far, sizeUsd: '100', collateralUsd: '10', takeProfit: priceAt(1100n), stopLoss: fromUnitPrice(mid() / 4n, 9) };
    const nine = await u.post(`${path(id)}/orders`, { clientId: clientId(), side: 'Long', symbol: 'SOL', slippageBps: 50, ...both });
    expect([nine.statusCode, nine.json().error.message]).toEqual([422, 'At most 8 orders can be pending at once, as on a funded account (take profit and stop loss count as one each)']);
    await placed(u, id, { ...both, stopLoss: undefined }); // the eighth
    for (const o of (await t.sim.orders(u.wallet, id))!) expect((await u.delete(`${path(id)}/orders/${o.id}`)).statusCode).toBe(200);

    // Eight (market, side) pairs filled, then a ninth pair is refused while adding to a held one is not.
    t.md.closed.set('NVDA', false);
    try {
      const markets = ['SOL', 'BTC', 'XAU', 'EUR'];
      for (const symbol of [...markets, 'NVDA']) await base(symbol);
      for (const symbol of markets) {
        for (const side of ['Long', 'Short'] as const) await placed(u, id, { symbol, side, sizeUsd: '100', collateralUsd: '10' });
      }
      await t.tick(...markets.map((s) => t.md.scaled(s, 1, later())));
      expect(await positions(u, id)).toHaveLength(8);
      const ninth = await u.post(`${path(id)}/orders`, { clientId: clientId(), symbol: 'NVDA', side: 'Long', kind: 'Market', sizeUsd: '100', collateralUsd: '20', slippageBps: 50 });
      expect([ninth.statusCode, ninth.json().error.message]).toEqual([422, 'At most 8 positions can be open or pending at once, as on a funded account']);
      await placed(u, id, { sizeUsd: '100', collateralUsd: '10' }); // adds to the SOL long: 1 order pending
      for (let i = 0; i < 6; i++) await placed(u, id, { kind: 'Limit', triggerPrice: priceAt(990n), sizeUsd: '100', collateralUsd: '10' });
      const position = (await positions(u, id)).find((p) => p.symbol === 'SOL' && p.side === 'Long');
      const protect = (body: object) => u.put(`${path(id)}/positions/${position!.id}/protection`, body);
      const over = await protect({ takeProfit: priceAt(1100n), stopLoss: priceAt(900n) }); // 7 + 2
      expect([over.statusCode, over.json().error.message]).toEqual([422, nine.json().error.message]);
      expect((await protect({ takeProfit: null, stopLoss: priceAt(900n) })).statusCode).toBe(200); // 7 + 1
      expect((await protect({ takeProfit: null, stopLoss: priceAt(950n) })).statusCode).toBe(200); // replaces it: still 8
    } finally {
      t.md.closed.set('NVDA', true);
      await base('NVDA', 'closed');
    }
  });
});

describe('capacity', () => {
  it('keeps the 1 s rules pass within budget with 400 idle practice accounts (one far limit order each)', async () => {
    await base('SOL');
    const far = fromUnitPrice(mid() / 2n, 9);
    for (let i = 0; i < 400; i++) {
      const w = Keypair.generate().publicKey.toBase58(); // any wallet can sign in for free and gets a practice account
      await t.sim.engine.placeOrder(w, `practice:${w}`, {
        clientId: clientId(), symbol: 'SOL', side: 'Long', kind: 'Limit', triggerPrice: far, sizeUsd: '100', collateralUsd: '10', slippageBps: 50,
      });
    }
    const start = performance.now();
    await t.rules();
    const pass = performance.now() - start;
    const tickStart = performance.now();
    await t.tick(t.md.scaled('SOL', 1, later()));
    const tick = performance.now() - tickStart;
    console.log(`rules pass ${pass.toFixed(0)} ms, one SOL tick ${tick.toFixed(0)} ms for 400 idle accounts`);
    expect(pass).toBeLessThan(1_000);
  }, 120_000);

  it('values 400 accounts with open positions in memory, locking only those a rule has work for', async () => {
    await base('SOL');
    for (let i = 0; i < 400; i++) {
      const w = Keypair.generate().publicKey.toBase58();
      await t.sim.engine.placeOrder(w, `practice:${w}`, {
        clientId: clientId(), symbol: 'SOL', side: 'Long', kind: 'Market', sizeUsd: '100', collateralUsd: '10', slippageBps: 50,
      });
    }
    await t.tick(t.md.scaled('SOL', 1, later()));
    const start = performance.now();
    await t.rules();
    const pass = performance.now() - start;
    console.log(`rules pass ${pass.toFixed(0)} ms for 400 accounts with an open position`);
    expect(pass).toBeLessThan(1_000);
  }, 120_000);
});

describe('fault isolation', () => {
  it('a liquidation the model refuses does not undo a fill made on the same tick', async () => {
    const u = await t.user();
    const id = await t.practice(u);
    await base('SOL');
    await base('BTC');
    await placed(u, id, { symbol: 'BTC', sizeUsd: '10000', collateralUsd: '500' });
    await t.tick(t.md.scaled('BTC', 1, later()));
    expect(await positions(u, id)).toHaveLength(1);
    const { order } = await placed(u, id, { sizeUsd: '1000', collateralUsd: '100' });
    await t.tick({ ...t.md.scaled('BTC', 0.9, Date.now()), session: 'open' }); // BTC long liquidatable
    const real = model.simulateDecrease;
    const spy = vi.spyOn(model, 'simulateDecrease').mockImplementation((a) => {
      if (a.liquidation) throw new Error('refused');
      return real(a);
    });
    try {
      await t.tick(t.md.scaled('SOL', 1, later())); // fills the SOL order, then the rules step tries the BTC liquidation
    } finally {
      spy.mockRestore();
    }
    const orders = (await t.sim.orders(u.wallet, id))!;
    expect(orders.find((o) => o.id === order.id)!.status).toBe('executed');
    await t.rules(); // retried on the next pass, which the model now accepts
    expect((await positions(u, id)).map((p) => p.symbol)).toEqual(['SOL']);
  });
});

describe('requests', () => {
  it('does not answer a close with an unrelated order that reused its client id', async () => {
    const u = await t.user();
    const id = await t.practice(u);
    await base('SOL');
    const reused = clientId();
    const body = { clientId: reused, sizeUsd: '1000', collateralUsd: '100' };
    await placed(u, id, body);
    await t.tick(t.md.scaled('SOL', 1, later()));
    const [position] = await positions(u, id);
    const res = await u.post(`${path(id)}/positions/${position!.id}/close`, { clientId: reused, percent: 100, slippageBps: 50 });
    expect([res.statusCode, res.json().error.code]).toEqual([409, 'idempotency_conflict']);
    const other = await u.post(`${path(id)}/orders`, { ...body, symbol: 'SOL', side: 'Long', kind: 'Market', sizeUsd: '2000', slippageBps: 50 });
    expect([other.statusCode, other.json().error.code]).toEqual([409, 'idempotency_conflict']);
    expect((await placed(u, id, body)).order.status).toBe('executed'); // the same request again: its order, as it is now

    const close = { clientId: clientId(), percent: 100, slippageBps: 50 };
    const first = await u.post(`${path(id)}/positions/${position!.id}/close`, close);
    expect((await u.post(`${path(id)}/positions/${position!.id}/close`, close)).json().order.id).toBe(first.json().order.id);
    const partial = await u.post(`${path(id)}/positions/${position!.id}/close`, { ...close, percent: 50 });
    expect([partial.statusCode, partial.json().error.code]).toEqual([409, 'idempotency_conflict']);
  });
});
