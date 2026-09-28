// Model checks on real mainnet account images captured 2026-09-22 22:22 UTC (research snapshot,
// slot 449511955). Expected numbers are the research team's gmsol-model 0.10.0 native Rust results
// on the same snapshot (the 2026-09-23 mainnet snapshot in the private research notes, gmtrade-integration-facts).
//
// Like GMTrade before every order, the model first accrues borrowing, funding and the position impact
// distribution from the market's clocks up to the wall clock. load() moves the clocks a day ahead so
// that step is a no-op and results are exact and independent of when the test runs; the accrual itself
// is checked with clocks set a known time in the past.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { model, type ModelInput } from '../src/index.ts';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USD = 10n ** 20n;

interface Fixture {
  market: string; virtualInventories: Record<string, string>;
  prices: Record<'index' | 'long' | 'short', { min: string; max: string }>;
}
const now = () => Math.floor(Date.now() / 1000);

/** The market as if it last changed onchain at `unixSeconds` (Market state.clocks: impact distribution, borrowing, funding). */
function lastChangedAt(m: ModelInput, unixSeconds: number): ModelInput {
  const b = Buffer.from(m.market, 'base64');
  for (const at of [4024, 4032, 4040]) b.writeBigInt64LE(BigInt(unixSeconds), at);
  return { ...m, market: b.toString('base64') };
}

function load(name: string): ModelInput {
  const f = JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8')) as Fixture;
  const p = (k: 'index' | 'long' | 'short') => ({ min: BigInt(f.prices[k].min), max: BigInt(f.prices[k].max) });
  const m = { market: f.market, virtualInventories: f.virtualInventories, prices: { index: p('index'), long: p('long'), short: p('short') } };
  return lastChangedAt(m, now() + 86_400);
}
const usd = (v: bigint) => Number(v) / 1e20;
const at = (m: ModelInput, price: bigint): ModelInput => ({ ...m, prices: { ...m.prices, index: { min: price, max: price } } });
const mid = (m: ModelInput) => (m.prices.index.min + m.prices.index.max) / 2n;

test('SOL 150x long: liquidation price uses the liquidation factor (HEAD fix), 0.438% from the price', () => {
  const m = load('sol-wsol-usdc');
  const open = model.simulateIncrease({
    market: m, isLong: true, collateralToken: USDC,
    collateralAmount: (1000n * 1_000_000n) / 150n, sizeDeltaUsd: 1000n * USD,
  });
  const status = model.positionStatus(m, open.position.account);
  assert.ok(status.liquidationPrice !== null);
  const distancePct = (Number(status.liquidationPrice) / Number(mid(m)) - 1) * 100;
  // Research: 0.10.0 SDK formula gives -0.238%, HEAD gives -0.438% (liq_compare.mjs).
  assert.ok(Math.abs(distancePct + 0.438) < 0.005, `distance ${distancePct.toFixed(4)}%`);

  // The reported price agrees with GMTrade's own liquidation check within 0.01%.
  const liq = status.liquidationPrice;
  assert.equal(model.positionStatus(at(m, (liq * 10001n) / 10000n), open.position.account).liquidatable, false);
  assert.equal(model.positionStatus(at(m, (liq * 9999n) / 10000n), open.position.account).liquidatable, true);
});

test('SOL[USDC-USDC] $10k long on $500: open, liquidation and round trip match the research run', () => {
  const m = load('sol-usdc-usdc');
  const open = model.simulateIncrease({
    market: m, isLong: true, collateralToken: USDC, collateralAmount: 500n * 1_000_000n, sizeDeltaUsd: 10_000n * USD,
  });
  // research sim_output.txt: fee=$1.0000 impact=$0.1098 exec_px=11813878323326 collateral_after_open=498.9999
  assert.equal(usd(open.fees.orderFeeValue).toFixed(4), '1.0000');
  assert.equal(usd(open.priceImpactValue).toFixed(4), '0.1098');
  assert.equal(open.executionPrice, 11813878323326n);
  assert.equal((Number(open.position.collateralAmount) / 1e6).toFixed(4), '498.9999');

  // research: liquidation at -4.771% vs mid
  const status = model.positionStatus(m, open.position.account);
  const move = (Number(status.liquidationPrice) / Number(mid(m)) - 1) * 100;
  assert.equal(move.toFixed(2), '-4.77');
  assert.equal(status.liquidatable, false);

  // Close against the same (pre-open) snapshot, as the simulator does: simulated fills never move
  // the real pool. Closing a long worsens the balance exactly like opening a short, so the impact
  // equals the research's short-open impact on this snapshot ($-0.3152), with the $1.2000 fee.
  const close = model.simulateDecrease({ market: m, position: open.position.account, sizeDeltaUsd: open.position.sizeInUsd });
  assert.equal(close.position, null);
  assert.equal(usd(close.priceImpactValue).toFixed(4), '-0.3152');
  assert.equal(usd(close.fees.orderFeeValue).toFixed(4), '1.2000');
  assert.equal((Number(close.outputAmount) / 1e6).toFixed(4), '496.0265');

  // research: a 10% gap liquidation returns nothing and stops at the PnL step (no debt)
  const gap = model.simulateDecrease({
    market: at(m, (mid(m) * 90n) / 100n), position: open.position.account, sizeDeltaUsd: open.position.sizeInUsd, liquidation: true,
  });
  assert.equal(gap.outputAmount, 0n);
  assert.equal(gap.insolventCloseStep, 'Pnl');
  assert.ok(gap.fees.liquidationFeeValue !== null);
});

test('fills accrue borrowing and funding since the market last changed onchain, as GMTrade does', () => {
  const m = load('sol-usdc-usdc');
  const s = model.marketStatus(m); // shorts pay both borrowing and funding on this snapshot
  const open = model.simulateIncrease({
    market: m, isLong: false, collateralToken: USDC, collateralAmount: 1_000n * 1_000_000n, sizeDeltaUsd: 10_000n * USD,
  });
  const closeAfter = (seconds: number) => model.simulateDecrease({
    market: lastChangedAt(m, now() - seconds), position: open.position.account, sizeDeltaUsd: open.position.sizeInUsd,
  }).fees;
  const usdc = (amount: bigint) => (Number(amount) / 1e6) * (Number(m.prices.short.min) / 1e14);
  const secondsOf = (amount: bigint, ratePerSecond: bigint) => usdc(amount) / (10_000 * usd(ratePerSecond));

  assert.deepEqual([closeAfter(-86_400).borrowingFeeAmount, closeAfter(-86_400).fundingFeeAmount], [0n, 0n]);
  const hour = closeAfter(3_600);
  const borrowed = secondsOf(hour.borrowingFeeAmount, s.borrowingRatePerSecondForShort);
  assert.ok(borrowed > 3_598 && borrowed < 3_602, `borrowing for ${borrowed.toFixed(1)} s`);
  const funded = secondsOf(hour.fundingFeeAmount, s.fundingRatePerSecondForShort);
  assert.ok(funded > 3_598 && funded < 3_602, `funding for ${funded.toFixed(1)} s`);
});

test('a simulated position still settles when the accrual at a later price lands below its snapshot', () => {
  // Longs pay borrowing here, at a rate that falls with the price: accrued over two days at a 1% lower
  // price, the market's factor ends below the one the position was opened with.
  const stale = lastChangedAt(load('sol-wsol-usdc'), now() - 2 * 86_400);
  const open = model.simulateIncrease({
    market: stale, isLong: true, collateralToken: USDC, collateralAmount: 100n * 1_000_000n, sizeDeltaUsd: 1_000n * USD,
  });
  const lower = at(stale, (mid(stale) * 99n) / 100n);
  assert.equal(model.positionStatus(lower, open.position.account).pendingBorrowingFeeValue, 0n);
  const close = model.simulateDecrease({ market: lower, position: open.position.account, sizeDeltaUsd: open.position.sizeInUsd });
  assert.equal(close.fees.borrowingFeeAmount, 0n);
});

test('market status: open interest and borrowing rates of the snapshot', () => {
  const s = model.marketStatus(load('sol-usdc-usdc'));
  // research: OI long=$1137971 short=$1153947; short borrow 6.2473491685e-9 /s (19.70% APR), long 0
  assert.equal(Math.round(usd(s.openInterestForLong)), 1137971);
  assert.equal(Math.round(usd(s.openInterestForShort)), 1153947);
  assert.equal(s.borrowingRatePerSecondForLong, 0n);
  assert.equal((usd(s.borrowingRatePerSecondForShort) * 1e9).toFixed(4), '6.2473');
  // research: real LP money in the pool $1,171,565 (both sides of a pure pool)
  assert.ok(Math.abs(usd(s.poolValueForLong + s.poolValueForShort) - 1_171_565) < 5_000);
  assert.ok(s.liquidityForLong > 0n && s.liquidityForShort > 0n);
  // max leverage 250x: min collateral factor 0.004
  assert.equal(s.minCollateralFactorForLong, (4n * USD) / 1000n);
});

test('missing virtual inventory is an error, not a silently different model', () => {
  const m = load('sol-usdc-usdc');
  assert.throws(() => model.marketStatus({ ...m, virtualInventories: {} }), /missing virtual inventory account EEcQz9/);
});

test('the web build gives the same results', async () => {
  const { loadModel } = await import('../src/web.ts');
  const web = await loadModel(readFileSync(new URL('../pkg-web/props_gmsol_bg.wasm', import.meta.url)));
  const m = load('sol-usdc-usdc');
  const args = { market: m, isLong: false, collateralToken: USDC, collateralAmount: 250n * 1_000_000n, sizeDeltaUsd: 5_000n * USD };
  assert.deepEqual(web.simulateIncrease(args), model.simulateIncrease(args));
});
