// GMTrade's subsquid indexer: every position fill (TradeEvent) with before/after state, fees and
// oracle prices, ~35 s behind the chain. Ids start with the zero-padded slot, so `id_DESC` is newest
// first and uses the primary key (ordering by `slot` takes ~30 s on this service).
import { SUBSQUID } from './constants.ts';
import { graphql } from './graphql.ts';

export interface PositionSnapshot { sizeInUsd: bigint; sizeInTokens: bigint; collateralAmount: bigint }
export interface TokenPrices { index: { min: bigint; max: bigint }; long: { min: bigint; max: bigint }; short: { min: bigint; max: bigint } }

export interface TradeEvent {
  id: string;
  /** Unix ms of the fill. */
  ts: number;
  slot: number;
  marketToken: string;
  /** Position owner. */
  user: string;
  position: string;
  order: string;
  isLong: boolean;
  isCollateralLong: boolean;
  isIncrease: boolean;
  isLiquidation: boolean;
  executionPrice: bigint;
  priceImpactValue: bigint;
  before: PositionSnapshot;
  after: PositionSnapshot;
  pnl: bigint;
  /** Fee amounts in collateral token units. */
  fees: { order: bigint; liquidation: bigint; borrowing: bigint; funding: bigint };
  /** Oracle unit prices the fill used. */
  prices: TokenPrices;
  outputAmount: bigint;
  secondaryOutputAmount: bigint;
}

const FIELDS = `id timestamp flags slot marketToken user position order executionPrice priceImpactValue
  beforeSizeInUsd beforeSizeInTokens beforeCollateralAmount afterSizeInUsd afterSizeInTokens afterCollateralAmount
  pnlPnl feesOrderFeeForReceiverAmount feesOrderFeeForPoolAmount feesLiquidationFeeAmount feesTotalBorrowingFeeAmount
  feesFundingFeeAmount outputAmountsOutputAmount outputAmountsSecondaryOutputAmount
  pricesIndexMin pricesIndexMax pricesLongMin pricesLongMax pricesShortMin pricesShortMax`;

type Row = Record<string, string | null>;
const b = (v: string | null | undefined) => BigInt(v ?? '0');

function toTradeEvent(r: Row): TradeEvent {
  const flags = Number(r.flags);
  return {
    id: r.id!,
    ts: Date.parse(r.timestamp!),
    slot: Number(r.slot),
    marketToken: r.marketToken!,
    user: r.user!,
    position: r.position!,
    order: r.order!,
    isLong: (flags & 1) !== 0,
    isCollateralLong: (flags & 2) !== 0,
    isIncrease: (flags & 4) !== 0,
    isLiquidation: b(r.feesLiquidationFeeAmount) > 0n,
    executionPrice: b(r.executionPrice),
    priceImpactValue: b(r.priceImpactValue),
    before: { sizeInUsd: b(r.beforeSizeInUsd), sizeInTokens: b(r.beforeSizeInTokens), collateralAmount: b(r.beforeCollateralAmount) },
    after: { sizeInUsd: b(r.afterSizeInUsd), sizeInTokens: b(r.afterSizeInTokens), collateralAmount: b(r.afterCollateralAmount) },
    pnl: b(r.pnlPnl),
    fees: {
      order: b(r.feesOrderFeeForReceiverAmount) + b(r.feesOrderFeeForPoolAmount),
      liquidation: b(r.feesLiquidationFeeAmount),
      borrowing: b(r.feesTotalBorrowingFeeAmount),
      funding: b(r.feesFundingFeeAmount),
    },
    prices: {
      index: { min: b(r.pricesIndexMin), max: b(r.pricesIndexMax) },
      long: { min: b(r.pricesLongMin), max: b(r.pricesLongMax) },
      short: { min: b(r.pricesShortMin), max: b(r.pricesShortMax) },
    },
    outputAmount: b(r.outputAmountsOutputAmount),
    secondaryOutputAmount: b(r.outputAmountsSecondaryOutputAmount),
  };
}

export interface TradeFilter {
  marketTokens?: string[];
  /** Position owner. */
  user?: string;
  /** Only fills that opened a position from zero size. */
  opensOnly?: boolean;
  /** Only events with a smaller id (pagination). */
  beforeId?: string;
}

/** Newest fills first. */
export async function fetchTradeEvents(filter: TradeFilter, limit = 50, url = SUBSQUID): Promise<TradeEvent[]> {
  const where: string[] = [];
  if (filter.marketTokens) where.push(`marketToken_in: ${JSON.stringify(filter.marketTokens)}`);
  if (filter.user) where.push(`user_eq: ${JSON.stringify(filter.user)}`);
  if (filter.opensOnly) where.push('beforeSizeInUsd_eq: "0"');
  if (filter.beforeId) where.push(`id_lt: ${JSON.stringify(filter.beforeId)}`);
  const d = await graphql<{ tradeEvents: Row[] }>(url,
    `{ tradeEvents(where: {${where.join(', ')}}, orderBy: id_DESC, limit: ${limit}) { ${FIELDS} } }`);
  return d.tradeEvents.map(toTradeEvent);
}
