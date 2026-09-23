// Typed wrapper over the props-gmsol WASM exports (gmsol-sdk 0.10.0 + HEAD liquidation-price fix).
// All numbers are GMTrade units as bigint:
//   USD values and factors: 1e20 = $1 / 100%
//   token amounts: base units (USDC: 1e6)
//   prices: unit prices = USD * 10^(20 - token decimals), as min/max quoted by the oracle

export interface Price { min: bigint; max: bigint }
export interface Prices { index: Price; long: Price; short: Price }

/** Onchain state the model runs on: raw account images, base64 with discriminator. */
export interface MarketSnapshot {
  market: string;
  /** VirtualInventory accounts by address; required for every VI the market references. */
  virtualInventories: Record<string, string>;
}

export interface ModelInput extends MarketSnapshot {
  prices: Prices;
  /** Order fee discount (1e20 = 100%) from the owner's referral code / GT rank. */
  orderFeeDiscountFactor?: bigint;
}

export interface IncreaseArgs {
  market: ModelInput;
  /** Base64 Position account of the position being increased; omit to open a new one. */
  position?: string;
  isLong: boolean;
  collateralToken: string;
  collateralAmount: bigint;
  sizeDeltaUsd: bigint;
  acceptablePrice?: bigint;
}

export interface DecreaseArgs {
  market: ModelInput;
  position: string;
  sizeDeltaUsd: bigint;
  collateralWithdrawalAmount?: bigint;
  acceptablePrice?: bigint;
  /** Execute as a keeper liquidation: liquidation fee charged, insolvent close allowed. */
  liquidation?: boolean;
}

export interface Fees {
  orderFeeValue: bigint;
  /** In collateral token units. */
  borrowingFeeAmount: bigint;
  /** In collateral token units. */
  fundingFeeAmount: bigint;
  liquidationFeeValue: bigint | null;
  /** All fees in collateral token units. */
  totalCostAmount: bigint;
}

export interface PositionState {
  /** Base64 Position account after the action (discriminator included). */
  account: string;
  sizeInUsd: bigint;
  sizeInTokens: bigint;
  collateralAmount: bigint;
}

export interface IncreaseResult {
  executionPrice: bigint;
  priceImpactValue: bigint;
  sizeDeltaInTokens: bigint;
  collateralDeltaAmount: bigint;
  fees: Fees;
  position: PositionState;
}

export interface DecreaseResult {
  executionPrice: bigint;
  priceImpactValue: bigint;
  priceImpactDiff: bigint;
  sizeDeltaUsd: bigint;
  sizeDeltaInTokens: bigint;
  pnl: bigint;
  uncappedPnl: bigint;
  fees: Fees;
  /** Collateral token paid out to the owner. */
  outputAmount: bigint;
  secondaryOutputAmount: bigint;
  /** Excess negative impact parked in the owner's claimable account. */
  claimableForUser: bigint;
  insolventCloseStep: string | null;
  /** null when the position was fully closed. */
  position: PositionState | null;
}

export interface PositionStatus {
  entryPrice: bigint;
  collateralValue: bigint;
  pendingPnl: bigint;
  pendingBorrowingFeeValue: bigint;
  pendingFundingFeeValue: bigint;
  closeOrderFeeValue: bigint;
  netValue: bigint;
  leverage: bigint | null;
  liquidationPrice: bigint | null;
  /** GMTrade's own check: a keeper could liquidate at these prices. */
  liquidatable: boolean;
}

export interface MarketStatus {
  fundingRatePerSecondForLong: bigint;
  fundingRatePerSecondForShort: bigint;
  borrowingRatePerSecondForLong: bigint;
  borrowingRatePerSecondForShort: bigint;
  openInterestForLong: bigint;
  openInterestForShort: bigint;
  liquidityForLong: bigint;
  liquidityForShort: bigint;
  poolValueForLong: bigint;
  poolValueForShort: bigint;
  minCollateralFactorForLong: bigint;
  minCollateralFactorForShort: bigint;
}

/** The raw wasm-bindgen exports: JSON in, JSON with decimal strings out. */
export interface Bindings {
  simulateIncrease(args: unknown): unknown;
  simulateDecrease(args: unknown): unknown;
  positionStatus(args: unknown): unknown;
  marketStatus(args: unknown): unknown;
}

/**
 * Every call first accrues the market from its onchain clocks up to the wall clock (position impact
 * distribution, borrowing, funding), as GMTrade does before executing any order or liquidation.
 */
export interface Model {
  simulateIncrease(args: IncreaseArgs): IncreaseResult;
  simulateDecrease(args: DecreaseArgs): DecreaseResult;
  positionStatus(market: ModelInput, position: string): PositionStatus;
  marketStatus(market: ModelInput): MarketStatus;
}

type Raw = Record<string, unknown>;

const str = (v: bigint | undefined) => (v === undefined ? undefined : v.toString());
const price = (p: Price) => ({ min: p.min.toString(), max: p.max.toString() });
const big = (v: unknown) => BigInt(v as string);
const bigOrNull = (v: unknown) => (v == null ? null : BigInt(v as string));

function marketArg(m: ModelInput) {
  return {
    market: m.market,
    virtualInventories: m.virtualInventories,
    prices: { index: price(m.prices.index), long: price(m.prices.long), short: price(m.prices.short) },
    orderFeeDiscountFactor: str(m.orderFeeDiscountFactor),
  };
}

function fees(r: Raw): Fees {
  return {
    orderFeeValue: big(r.orderFeeValue),
    borrowingFeeAmount: big(r.borrowingFeeAmount),
    fundingFeeAmount: big(r.fundingFeeAmount),
    liquidationFeeValue: bigOrNull(r.liquidationFeeValue),
    totalCostAmount: big(r.totalCostAmount),
  };
}

function positionState(r: Raw): PositionState {
  return {
    account: r.account as string,
    sizeInUsd: big(r.sizeInUsd),
    sizeInTokens: big(r.sizeInTokens),
    collateralAmount: big(r.collateralAmount),
  };
}

export function createModel(b: Bindings): Model {
  return {
    simulateIncrease(a) {
      const r = b.simulateIncrease({
        market: marketArg(a.market),
        position: a.position,
        isLong: a.isLong,
        collateralToken: a.collateralToken,
        collateralAmount: a.collateralAmount.toString(),
        sizeDeltaUsd: a.sizeDeltaUsd.toString(),
        acceptablePrice: str(a.acceptablePrice),
      }) as Raw;
      return {
        executionPrice: big(r.executionPrice),
        priceImpactValue: big(r.priceImpactValue),
        sizeDeltaInTokens: big(r.sizeDeltaInTokens),
        collateralDeltaAmount: big(r.collateralDeltaAmount),
        fees: fees(r.fees as Raw),
        position: positionState(r.position as Raw),
      };
    },
    simulateDecrease(a) {
      const r = b.simulateDecrease({
        market: marketArg(a.market),
        position: a.position,
        sizeDeltaUsd: a.sizeDeltaUsd.toString(),
        collateralWithdrawalAmount: str(a.collateralWithdrawalAmount),
        acceptablePrice: str(a.acceptablePrice),
        liquidation: a.liquidation ?? false,
      }) as Raw;
      return {
        executionPrice: big(r.executionPrice),
        priceImpactValue: big(r.priceImpactValue),
        priceImpactDiff: big(r.priceImpactDiff),
        sizeDeltaUsd: big(r.sizeDeltaUsd),
        sizeDeltaInTokens: big(r.sizeDeltaInTokens),
        pnl: big(r.pnl),
        uncappedPnl: big(r.uncappedPnl),
        fees: fees(r.fees as Raw),
        outputAmount: big(r.outputAmount),
        secondaryOutputAmount: big(r.secondaryOutputAmount),
        claimableForUser: big(r.claimableForUser),
        insolventCloseStep: (r.insolventCloseStep as string | null | undefined) ?? null,
        position: r.position == null ? null : positionState(r.position as Raw),
      };
    },
    positionStatus(market, position) {
      const r = b.positionStatus({ market: marketArg(market), position }) as Raw;
      return {
        entryPrice: big(r.entryPrice),
        collateralValue: big(r.collateralValue),
        pendingPnl: big(r.pendingPnl),
        pendingBorrowingFeeValue: big(r.pendingBorrowingFeeValue),
        pendingFundingFeeValue: big(r.pendingFundingFeeValue),
        closeOrderFeeValue: big(r.closeOrderFeeValue),
        netValue: big(r.netValue),
        leverage: bigOrNull(r.leverage),
        liquidationPrice: bigOrNull(r.liquidationPrice),
        liquidatable: r.liquidatable === true,
      };
    },
    marketStatus(market) {
      const r = b.marketStatus(marketArg(market)) as Raw;
      const out = {} as Record<keyof MarketStatus, bigint>;
      for (const k of Object.keys(r) as (keyof MarketStatus)[]) out[k] = big(r[k]);
      return out;
    },
  };
}
