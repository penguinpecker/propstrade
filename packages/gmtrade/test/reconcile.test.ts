// Reconciliation of the gmsol-sdk 0.10.0 WASM model against real GMTrade fills (live; PROPS_OFFLINE=1 skips).
//
// Each fill is re-run on the Market account as it was right before it: every pool the indexer saw
// change since the fill is set back to its last value before it (subsquid MarketStateUpdated), the
// adaptive funding factor to the one saved by the market's previous fee update (MarketFeesUpdated),
// and the market clocks are shifted so the model (which reads wall-clock time) sees the fill's elapsed time.
// A close also rebuilds the Position from the fill's before-state (sizes, collateral, borrowing and
// funding snapshots). SOL/USD[USDC-USDC] shares a positions VirtualInventory with SOL/USD[WSOL-WSOL];
// it holds the users' net open interest over both pools, so it is rebuilt by taking every later fill
// in either pool back out of its current value. The fill is then re-run at the oracle prices recorded
// in its TradeEvent.
//
// Tolerance: execution price, price impact and size in tokens (and, on closes, PnL, the impact diff
// and the borrowing and funding fees) must be EXACTLY equal, and the collateral or payout must
// reconcile to the unit once the owner's order-fee discount is accounted for (the indexer does not
// record referral / GT-rank discounts, so the real fee may be lower than the model's undiscounted fee,
// never higher). GMTrade can rewrite a market's config between a fill and the test run, which the
// indexer does not record, so each test needs most (and at least 2) of its most recent
// reconstructable fills to reproduce exactly rather than all of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { model } from '@props/gmsol-wasm';
import {
  NO_ACCOUNT, PUBLIC_RPC, STORE, SUBSQUID, USDC_MINT, fetchMarkets, fetchTradeEvents, getMultipleAccounts, pubkeyBytes,
  storeIdl, type KeeperMarket, type TradeEvent,
} from '../src/index.ts';
import { graphql } from '../src/graphql.ts';

const offline = process.env.PROPS_OFFLINE === '1';
const SOL_USDC_POOL = '6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc';

interface StateUpdate { id: string; poolKinds: string; pools: string; clocks: string }
interface PoolJson { isPure: number; longTokenAmount: string; shortTokenAmount: string }
/** Position state before a fill, as the indexer records it (decimal strings). */
interface BeforeState {
  id: string; priceImpactDiff: string;
  beforeTradeId: string; beforeIncreasedAt: string; beforeUpdatedAtSlot: string; beforeDecreasedAt: string;
  beforeBorrowingFactor: string; beforeFundingFeeAmountPerSize: string;
  beforeLongTokenClaimableFundingAmountPerSize: string; beforeShortTokenClaimableFundingAmountPerSize: string;
}

const snake = (kind: string) => kind.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase());
const writeU128 = (buf: Buffer, v: bigint, at: number) => {
  buf.writeBigUInt64LE(v & (2n ** 64n - 1n), at);
  buf.writeBigUInt64LE(v >> 64n, at + 8);
};
const readU128 = (buf: Buffer, at: number) => buf.readBigUInt64LE(at) | (buf.readBigUInt64LE(at + 8) << 64n);

async function stateUpdates(marketToken: string, where: string, limit: number): Promise<StateUpdate[]> {
  const d = await graphql<{ marketStateUpdateds: StateUpdate[] }>(SUBSQUID,
    `{ marketStateUpdateds(where: {marketToken_eq: "${marketToken}", ${where}}, orderBy: id_DESC, limit: ${limit}) { id poolKinds pools clocks } }`, 60_000);
  return d.marketStateUpdateds;
}

/**
 * The Market account as it was right before `fill`, or undefined when the indexer window is too short.
 * Call the result right before running the model: it shifts the clocks to the current second.
 */
async function marketBefore(fill: TradeEvent, currentBase64: string): Promise<(() => string) | undefined> {
  // Event ids: slot-signature-transaction-instruction-event; everything before this instruction precedes the fill.
  const bound = `${fill.id.split('-').slice(0, 4).join('-')}-000000`;
  const since = await stateUpdates(fill.marketToken, `id_gte: "${bound}"`, 1000);
  if (since.length === 1000) return undefined;
  const changed = new Set(since.flatMap((s) => (JSON.parse(s.poolKinds) as { kind: string }[]).map((k) => k.kind)));
  const pools = new Map<string, PoolJson>();
  let clocks: Record<string, string> | undefined;
  for (const s of await stateUpdates(fill.marketToken, `id_lt: "${bound}"`, 500)) {
    const values = JSON.parse(s.pools) as PoolJson[];
    (JSON.parse(s.poolKinds) as { kind: string }[]).forEach((k, i) => {
      if (changed.has(k.kind) && !pools.has(k.kind)) pools.set(k.kind, values[i]!);
    });
    clocks ??= (JSON.parse(s.clocks) as Record<string, string>[])[0];
  }
  if (pools.size < changed.size || !clocks) return undefined;
  const { marketFeesUpdateds: [fees] } = await graphql<{ marketFeesUpdateds: { updateFundingStateNextFundingFactorPerSecond: string }[] }>(SUBSQUID,
    `{ marketFeesUpdateds(where: {marketToken_eq: "${fill.marketToken}", id_lt: "${bound}"}, orderBy: id_DESC, limit: 1) { updateFundingStateNextFundingFactorPerSecond } }`);
  if (!fees) return undefined;

  const buf = Buffer.from(currentBase64, 'base64');
  const fundingFactor = BigInt(fees.updateFundingStateNextFundingFactorPerSecond);
  const fundingFactorAt = storeIdl.offsetOf('Market', 'state.other.funding_factor_per_second');
  buf.writeBigUInt64LE(fundingFactor & (2n ** 64n - 1n), fundingFactorAt);
  buf.writeBigInt64LE(fundingFactor >> 64n, fundingFactorAt + 8);
  for (const [kind, pool] of pools) {
    const at = storeIdl.offsetOf('Market', `state.pools.${snake(kind)}.pool`);
    buf.writeUInt8(pool.isPure, at);
    writeU128(buf, BigInt(pool.longTokenAmount), at + 16);
    writeU128(buf, BigInt(pool.shortTokenAmount), at + 32);
  }
  return () => {
    const shift = BigInt(Math.floor(Date.now() / 1000) - Math.floor(fill.ts / 1000));
    for (const f of ['price_impact_distribution', 'borrowing', 'funding'] as const) {
      const key = f.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
      buf.writeBigInt64LE(BigInt(clocks[key]!) + shift, storeIdl.offsetOf('Market', `state.clocks.${f}`));
    }
    return buf.toString('base64');
  };
}

async function beforeStates(fills: TradeEvent[]): Promise<Map<string, BeforeState>> {
  const d = await graphql<{ tradeEvents: BeforeState[] }>(SUBSQUID, `{ tradeEvents(where: {id_in: ${JSON.stringify(fills.map((f) => f.id))}}) {
    id priceImpactDiff beforeTradeId beforeIncreasedAt beforeUpdatedAtSlot beforeDecreasedAt beforeBorrowingFactor
    beforeFundingFeeAmountPerSize beforeLongTokenClaimableFundingAmountPerSize beforeShortTokenClaimableFundingAmountPerSize } }`);
  return new Map(d.tradeEvents.map((s) => [s.id, s]));
}

/** The USDC-collateral Position account as it was right before `fill`. */
function positionBefore(fill: TradeEvent, s: BeforeState): string {
  const buf = Buffer.alloc(8 + storeIdl.sizeOf({ defined: { name: 'Position' } }));
  const at = (path: string) => storeIdl.offsetOf('Position', path);
  buf.set(storeIdl.discriminator('Position'));
  buf.writeUInt8(fill.isLong ? 1 : 2, at('kind'));
  buf.set(pubkeyBytes(STORE), at('store'));
  buf.set(pubkeyBytes(fill.user), at('owner'));
  buf.set(pubkeyBytes(fill.marketToken), at('market_token'));
  buf.set(pubkeyBytes(USDC_MINT), at('collateral_token'));
  buf.writeBigUInt64LE(BigInt(s.beforeTradeId), at('state.trade_id'));
  buf.writeBigInt64LE(BigInt(s.beforeIncreasedAt), at('state.increased_at'));
  buf.writeBigUInt64LE(BigInt(s.beforeUpdatedAtSlot), at('state.updated_at_slot'));
  buf.writeBigInt64LE(BigInt(s.beforeDecreasedAt), at('state.decreased_at'));
  const u128s: [string, bigint | string][] = [
    ['size_in_tokens', fill.before.sizeInTokens], ['collateral_amount', fill.before.collateralAmount],
    ['size_in_usd', fill.before.sizeInUsd], ['borrowing_factor', s.beforeBorrowingFactor],
    ['funding_fee_amount_per_size', s.beforeFundingFeeAmountPerSize],
    ['long_token_claimable_funding_amount_per_size', s.beforeLongTokenClaimableFundingAmountPerSize],
    ['short_token_claimable_funding_amount_per_size', s.beforeShortTokenClaimableFundingAmountPerSize],
  ];
  for (const [field, v] of u128s) writeU128(buf, BigInt(v), at(`state.${field}`));
  return buf.toString('base64');
}

/**
 * Re-runs `fill` on the rebuilt state. Returns the fields that differ ([] = reproduced exactly); on an
 * exact reproduction it also asserts that collateral / payout reconcile up to the order-fee discount.
 */
function rerun(fill: TradeEvent, name: string, market: string, virtualInventories: Record<string, string>, before?: BeforeState): string[] {
  const input = { market, virtualInventories, prices: fill.prices };
  const diff: string[] = [];
  const eq = (what: string, sim: bigint, real: bigint) => (sim === real ? undefined : diff.push(`${what}: model ${sim}, real ${real}`));
  const checkDiscount = (simOrderFee: bigint) =>
    assert.ok(fill.fees.order <= simOrderFee && fill.fees.order * 2n >= simOrderFee, `${name}: fee discount out of range`);

  if (fill.isIncrease) {
    const sim = model.simulateIncrease({
      market: input, isLong: fill.isLong, collateralToken: USDC_MINT,
      collateralAmount: fill.after.collateralAmount + fill.fees.order, sizeDeltaUsd: fill.after.sizeInUsd,
    });
    eq('execution price', sim.executionPrice, fill.executionPrice);
    eq('size in tokens', sim.position.sizeInTokens, fill.after.sizeInTokens);
    eq('price impact', sim.priceImpactValue, fill.priceImpactValue);
    if (diff.length) return diff;
    // Collateral: the model charges the undiscounted fee; the owner's discount explains any difference exactly.
    assert.equal(sim.position.collateralAmount + (sim.fees.totalCostAmount - fill.fees.order), fill.after.collateralAmount, name);
    checkDiscount(sim.fees.totalCostAmount);
    return diff;
  }

  const sim = model.simulateDecrease({
    market: input, position: positionBefore(fill, before!), sizeDeltaUsd: fill.before.sizeInUsd, liquidation: fill.isLiquidation,
  });
  eq('execution price', sim.executionPrice, fill.executionPrice);
  eq('size in tokens', sim.sizeDeltaInTokens, fill.before.sizeInTokens);
  eq('price impact', sim.priceImpactValue, fill.priceImpactValue);
  eq('price impact diff', sim.priceImpactDiff, BigInt(before!.priceImpactDiff));
  eq('pnl', sim.pnl, fill.pnl);
  eq('borrowing fee', sim.fees.borrowingFeeAmount, fill.fees.borrowing);
  eq('funding fee', sim.fees.fundingFeeAmount, fill.fees.funding);
  assert.equal(sim.position, null, `${name}: a full close removes the position`);
  if (diff.length) return diff;
  // Payout: the owner receives what the model pays plus the discount on the order fee (a liquidation
  // fee is taken as recorded, so a wrong one would surface as a discount out of range).
  const simOrderFee = sim.fees.totalCostAmount - sim.fees.borrowingFeeAmount - sim.fees.fundingFeeAmount - fill.fees.liquidation;
  assert.equal(sim.outputAmount + sim.secondaryOutputAmount + (simOrderFee - fill.fees.order), fill.outputAmount + fill.secondaryOutputAmount, name);
  checkDiscount(simOrderFee);
  return diff;
}

/** Re-runs up to `max` reconstructable fills; returns the names of those reproduced exactly and how many were tried. */
async function reconcile(
  fills: TradeEvent[], markets: Map<string, KeeperMarket>, max: number,
  virtualInventories: (fill: TradeEvent) => Record<string, string> = () => ({}),
): Promise<{ exact: string[]; tried: number }> {
  const closes = fills.filter((f) => !f.isIncrease);
  const before = closes.length ? await beforeStates(closes) : new Map<string, BeforeState>();
  const exact: string[] = [];
  let tried = 0;
  for (const fill of fills) {
    if (tried === max) break;
    const market = await marketBefore(fill, markets.get(fill.marketToken)!.data!);
    if (!market) continue;
    tried++;
    const kind = fill.isIncrease ? 'open' : fill.isLiquidation ? 'liquidation' : 'close';
    const name = `${markets.get(fill.marketToken)!.meta!.name} ${fill.isLong ? 'long' : 'short'} ${kind} ${fill.id}`;
    const diff = rerun(fill, name, market(), virtualInventories(fill), before.get(fill.id));
    if (diff.length) console.log(`not reproduced (market config may have changed since): ${name}\n  ${diff.join('\n  ')}`);
    else exact.push(name);
  }
  console.log(`reproduced exactly (${exact.length} of ${tried}):\n  ${exact.join('\n  ')}`);
  return { exact, tried };
}

async function pureUsdcPools(withPositionsVi: boolean): Promise<Map<string, KeeperMarket>> {
  const markets = (await fetchMarkets()).filter((m) => m.meta?.isPure && m.meta.longToken.pubkey === USDC_MINT && m.data
    && (m.virtualInventoryForPositions !== NO_ACCOUNT) === withPositionsVi && m.virtualInventoryForSwaps === NO_ACCOUNT);
  return new Map(markets.map((m) => [m.marketToken, m]));
}

function assertMostReproduced({ exact, tried }: { exact: string[]; tried: number }, what: string) {
  assert.ok(exact.length >= 2 && exact.length * 2 > tried, `only ${exact.length} of ${tried} recent ${what} reproduced`);
}

const isFullClose = (e: TradeEvent) => !e.isIncrease && e.after.sizeInUsd === 0n;

/** Newest-first fills of `marketTokens`, one page at a time (at most 5) until `enough`. */
async function recentFills(marketTokens: string[], pageSize: number, enough: (fills: TradeEvent[]) => boolean): Promise<TradeEvent[]> {
  const fills: TradeEvent[] = [];
  for (let pages = 0; pages < 5 && !enough(fills); pages++) {
    const page = await fetchTradeEvents({ marketTokens, beforeId: fills.at(-1)?.id }, pageSize);
    fills.push(...page);
    if (page.length < pageSize) break;
  }
  return fills;
}

test('model reproduces real GMTrade position opens exactly', { skip: offline, timeout: 180_000 }, async () => {
  const markets = await pureUsdcPools(false);
  const fills = (await fetchTradeEvents({ marketTokens: [...markets.keys()], opensOnly: true }, 40))
    .filter((e) => e.isIncrease && !e.isLiquidation);
  assertMostReproduced(await reconcile(fills, markets, 8), 'opens');
});

test('model reproduces real GMTrade full closes exactly', { skip: offline, timeout: 180_000 }, async () => {
  const markets = await pureUsdcPools(false);
  const fills = (await fetchTradeEvents({ marketTokens: [...markets.keys()] }, 200)).filter(isFullClose);
  assertMostReproduced(await reconcile(fills, markets, 8), 'closes');
});

test('model reproduces real GMTrade liquidations exactly', { skip: offline, timeout: 300_000 }, async () => {
  const markets = await pureUsdcPools(false);
  const fills = (await recentFills([...markets.keys()], 1000, (f) => f.filter((e) => e.isLiquidation).length >= 4))
    .filter((e) => e.isLiquidation);
  assertMostReproduced(await reconcile(fills, markets, 4), 'liquidations');
});

test('model reproduces real SOL/USD[USDC-USDC] fills with its virtual inventory rebuilt', { skip: offline, timeout: 300_000 }, async () => {
  const markets = await pureUsdcPools(true);
  const pool = markets.get(SOL_USDC_POOL)!;
  assert.equal(pool.meta!.name, 'SOL/USD[USDC-USDC]');
  const viAddress = pool.virtualInventoryForPositions;
  const sharing = (await fetchMarkets()).filter((m) => m.virtualInventoryForPositions === viAddress).map((m) => m.marketToken);

  // The account at slot S, and every fill in the pools sharing it up to S (once the indexer has reached S).
  const { slot, accounts } = await getMultipleAccounts(PUBLIC_RPC, [viAddress]);
  for (let i = 0; ; i++) {
    const { squidStatus } = await graphql<{ squidStatus: { height: number } }>(SUBSQUID, '{ squidStatus { height } }');
    if (squidStatus.height >= slot) break;
    assert.ok(i < 30, `indexer still behind slot ${slot}`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
  const candidate = (e: TradeEvent) => e.marketToken === SOL_USDC_POOL && (e.isIncrease ? e.before.sizeInUsd === 0n : e.after.sizeInUsd === 0n);
  const history = (await recentFills(sharing, 200, (f) => f.filter(candidate).length >= 16)).filter((e) => e.slot <= slot);
  const fills = history.filter(candidate);
  assert.ok(fills.length > 0, 'recent SOL/USD[USDC-USDC] opens or closes');

  // Net open interest (longs - shorts, USD 1e20) before each fill: now, minus every fill since.
  const data = Buffer.from(accounts[0]!, 'base64');
  const poolAt = storeIdl.offsetOf('VirtualInventory', 'pool.pool');
  const netBefore = new Map<string, bigint>();
  let net = readU128(data, poolAt + 16) - readU128(data, poolAt + 32);
  for (const e of history) {
    net -= (e.after.sizeInUsd - e.before.sizeInUsd) * (e.isLong ? 1n : -1n);
    netBefore.set(e.id, net);
  }
  const viBefore = (fill: TradeEvent) => {
    const vi = Buffer.from(data);
    const n = netBefore.get(fill.id)!;
    writeU128(vi, n > 0n ? n : 0n, poolAt + 16);
    writeU128(vi, n < 0n ? -n : 0n, poolAt + 32);
    return { [viAddress]: vi.toString('base64') };
  };

  assertMostReproduced(await reconcile(fills, markets, 8, viBefore), 'SOL/USD[USDC-USDC] fills');
});
