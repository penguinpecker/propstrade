// Offline checks on real mainnet account images (test/fixtures/snapshot.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MarketFlag, USDC_MINT, base58Decode, base58Encode, decodeMarket, decodePosition, formatFixed, hasFlag, marketAddress,
  parseFixed, positionAddress, storeIdl,
} from '../src/index.ts';

const snapshot = JSON.parse(readFileSync(new URL('fixtures/snapshot.json', import.meta.url), 'utf8'));
const USD = 10n ** 20n;

test('base58 round trip, including leading zero bytes', () => {
  assert.equal(base58Encode(new Uint8Array(32)), '11111111111111111111111111111111');
  assert.equal(base58Encode(base58Decode(USDC_MINT)), USDC_MINT);
  assert.equal(base58Decode(USDC_MINT).length, 32);
  assert.throws(() => base58Decode('0OIl'), /invalid base58/);
});

test('program addresses match real mainnet accounts', () => {
  // SOL/USD[USDC-USDC]: market token 6UU9sF…, Market account CJg17D…
  assert.equal(marketAddress('6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc'), 'CJg17Dn4xgUyEW3gKSSyteNw7LhP1o9pzm9eLtvuNjkQ');
  const p = snapshot.position;
  const pos = decodePosition(p.data);
  assert.equal(positionAddress(pos.owner, pos.market_token, pos.collateral_token, pos.kind === 1), p.address);
});

test('Market account decodes with the v0.10.0 IDL (values verified by the research run)', () => {
  const sol = snapshot.markets.find((m: { meta: { name: string } }) => m.meta.name === 'SOL/USD[USDC-USDC]');
  const m = decodeMarket(sol.data);
  assert.equal(m.meta.market_token_mint, '6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc');
  assert.equal(m.meta.long_token_mint, USDC_MINT);
  assert.equal(m.virtual_inventory_for_positions, 'EEcQz9yC68rztSEq8XggVtp8Sa8Dj3gWJ8ckJuQvv5xw');
  // research sim_output.txt: flags=19 closed_bit=0, min_collateral_factor=0.004 (250x), min_cf_for_liq=0.002
  assert.equal(m.flags.value, 19);
  assert.ok(hasFlag(m, MarketFlag.Enabled) && hasFlag(m, MarketFlag.Pure) && !hasFlag(m, MarketFlag.Closed));
  assert.equal(m.config.min_collateral_factor, (4n * USD) / 1000n);
  assert.equal(m.config.min_collateral_factor_for_liquidation, (2n * USD) / 1000n);
  assert.equal(m.config.min_position_size_usd, USD);
  const oi = m.state.pools.open_interest_for_long.pool;
  assert.equal(formatFixed(oi.long_token_amount + oi.short_token_amount, 20, 0), '1137971');
  // real LP money in the pool, in USDC (research: $1,171,565)
  const primary = m.state.pools.primary.pool;
  assert.ok(Math.abs(Number(primary.long_token_amount + primary.short_token_amount) / 1e6 - 1_171_565) < 5);

  const nvda = decodeMarket(snapshot.markets.find((x: { meta: { name: string } }) => x.meta.name === 'NVDA/USD[USDC-USDC]').data);
  assert.ok(hasFlag(nvda, MarketFlag.Closed), 'NVDA was closed at 22:22 UTC');
  assert.equal(nvda.config.market_closed_min_collateral_factor_for_liquidation, USD / 10n);
});

test('Position account decodes and matches the fill that produced it', () => {
  const { data, fromTradeEvent: e } = snapshot.position;
  const pos = decodePosition(data);
  assert.equal(pos.owner, e.user);
  assert.equal(pos.market_token, e.marketToken);
  assert.equal(pos.kind, (Number(e.flags) & 1) === 1 ? 1 : 2);
  assert.equal(pos.state.size_in_usd, BigInt(e.afterSizeInUsd));
  assert.equal(pos.state.size_in_tokens, BigInt(e.afterSizeInTokens));
  assert.equal(pos.state.collateral_amount, BigInt(e.afterCollateralAmount));
});

test('IDL decoder rejects the wrong account type and computes field offsets', () => {
  const sol = snapshot.markets[0];
  assert.throws(() => decodePosition(sol.data), /not a Position account/);
  assert.equal(storeIdl.offsetOf('Market', 'flags'), 10);
  assert.equal(storeIdl.sizeOf({ defined: { name: 'Market' } }) + 8, Buffer.from(sol.data, 'base64').length);
});

test('fixed-point formatting is exact', () => {
  assert.equal(formatFixed(123_456_789n, 6, 6), '123.456789');
  assert.equal(formatFixed(123_456_789n, 6, 2), '123.46');
  assert.equal(formatFixed(-5n, 1, 0), '-1');
  assert.equal(formatFixed(-4n, 1, 0), '0');
  assert.equal(formatFixed(1_000_000n, 6, 6), '1');
  assert.equal(formatFixed(5n, 9, 3), '0');
  assert.equal(formatFixed(12n, 0, 2), '12');
  assert.equal(parseFixed('10000.5', 20), 10_000n * USD + USD / 2n);
  assert.equal(parseFixed('-0.25', 2), -25n);
  assert.throws(() => parseFixed('1.234', 2), /more than 2 decimal places/);
  assert.throws(() => parseFixed('1e5', 2), /not a decimal number/);
});
