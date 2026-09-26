// Props.trade HTTP + stream contract. Single source of truth for server/ and app/.
//
// Endpoints (all under /v1; lists return bare JSON arrays; errors return ApiError with a 4xx/5xx status):
//   GET  /health -> Health                                   GET  /config -> AppConfig
//   GET  /markets -> Market[]                                GET  /markets/:symbol -> Market
//   GET  /candles?symbol&interval&from&to -> CandlesResponse  GET  /markets/:symbol/trades?limit -> MarketTrade[]
//   GET  /quote?symbol&side&sizeUsd[&collateralUsd&limitPrice] -> PriceImpactQuote
//   GET  /traders/:address -> TraderLookup (public)           GET  /stream -> SSE, `data: <StreamEvent JSON>`
//   POST /auth/nonce NonceRequest -> NonceResponse           POST /auth/verify VerifyRequest -> VerifyResponse (+cookie)
//   POST /auth/logout -> 204                                  GET  /me -> Me (401 without a session)
//   POST /kyc/start KycStartRequest -> KycStartResponse
//   GET  /notifications -> Notification[]                     POST /notifications/read NotificationsReadRequest -> { updated: number }
//   GET  /accounts -> AccountSummary[]                        GET  /accounts/:id -> AccountDetail
//   GET  /accounts/:id/positions -> Position[]                GET  /accounts/:id/orders -> Order[]
//   GET  /accounts/:id/history -> ClosedTrade[]               GET  /accounts/:id/activity -> ActivityItem[]
//   GET  /accounts/:id/performance?period -> Performance      GET  /accounts/:id/payout-eligibility -> PayoutEligibility
//   POST /sim/:id/orders SimOrderRequest -> SimOrderResponse  DELETE /sim/:id/orders/:orderId -> SimOrderResponse
//   POST /sim/:id/positions/:positionId/close SimCloseRequest -> SimOrderResponse
//   PUT  /sim/:id/positions/:positionId/protection SimProtectionRequest -> Position
//   POST /practice/reset -> AccountSummary                     GET  /sim/:id/fills -> Fill[] (every fill, trades-root order;
//        the owner's, or anyone's once the evaluation result is onchain: see ./merkle.ts)
//   GET  /payouts -> Payout[]                                 GET  /payouts/:id -> Payout
//   GET  /verify?q -> VerifyResult                            GET  /vault -> VaultStats
//   GET  /referrals -> ReferralProgram (public)   GET  /referrals/:code -> ReferralCodeCheck (public)
//   GET  /me/referrals -> ReferralSummary
//   POST /me/referrer SetReferrerRequest -> ReferralSummary (404 unknown_referral_code, 409 already_referred,
//        422 own_referral_code, 403 referral_window_closed)
// Wallet-signed transactions (evaluation purchase, funded activation/trading, payout requests) are built in the
// browser with @props/sdk and sent by the wallet; the server only indexes their results.
// Amounts: USD/USDC values are decimal strings with up to 6 dp (never JS floats on the wire for money).
// Prices are decimal strings. Timestamps are unix milliseconds (number).
// Pubkeys and signatures are base58 strings.

export type Decimal = string;
export type Pubkey = string;
export type Millis = number;

// ---------- markets ----------
export type MarketCategory = 'Crypto' | 'Forex' | 'Commodities' | 'Stocks';
export type SessionState = 'open' | 'closed' | 'unknown';
export type DataFreshness = 'live' | 'delayed' | 'stale' | 'unavailable';

export interface Market {
  symbol: string;              // index asset, e.g. "BTC", "EUR", "XAU", "NVDA"
  pair: string;                // display pair, e.g. "BTC / USD", "USD / JPY"
  name: string;                // "Bitcoin", "Euro / US Dollar", "NVIDIA"
  category: MarketCategory;
  // Group within the category: GMTrade's own token category for crypto ("Layer 1 & 2", "DeFi", "Meme", "Other"; a
  // category GMTrade adds later keeps its GMTrade name), curated by symbol for the rest ("Metals", "Energy", "Majors",
  // "Emerging", "Index ETFs", "Companies"); "Other" for a symbol the curated table does not know yet.
  subcategory: string;
  marketToken: Pubkey;         // GMTrade market token of the preferred pool: its pure USDC-USDC pool (an asset without one is not listed)
  pools: { marketToken: Pubkey; name: string; pure: boolean; longToken: Pubkey; shortToken: Pubkey }[];
  tradable: boolean;           // on the Props allowlist (MarketConfig.enabled) AND pure USDC-USDC
  unavailableReason?: string;  // plain-English reason when !tradable
  price: Decimal | null;       // mid of GMTrade min/max, null when unavailable
  priceDecimals: number;       // display decimals; prices may carry more
  indexTokenDecimals: number;  // GMTrade unit prices (trigger/acceptable) are USD × 10^(20 − this)
  change24h: number | null;    // percent
  volume24h: Decimal | null;   // USD, summed over all pools of the asset
  openInterestLong: Decimal | null;       // preferred pool (as are funding, borrow and capacity below)
  openInterestShort: Decimal | null;
  fundingRateHourlyLong: number | null;   // percent per hour, sign = paid(+)/received(−) by longs
  fundingRateHourlyShort: number | null;  // same for shorts: not the negative of the long rate (scaled by the OI ratio)
  borrowRateHourlyLong: number | null;    // percent per hour, always paid (0 for the smaller side when GMTrade waives it)
  borrowRateHourlyShort: number | null;
  capacityLong: Decimal | null;           // USD of additional long OI the pool accepts
  capacityShort: Decimal | null;
  poolLiquidity: Decimal | null;          // real LP value of the preferred pool, USD
  maxLeverage: number;                    // Props limit (min of venue and MarketConfig)
  closedMaxLeverage: number | null;       // leverage allowed through a session close
  // What the exchange accepts for a NEW position on each side right now (the preferred pool's state; rows are re-sent as
  // it moves). Leverage: the lower of the Props limit and the exchange's (1 / its min collateral factor, which grows
  // with the side's open interest), whole.
  maxLeverageLong: number;
  maxLeverageShort: number;
  maxSizeLong: Decimal | null;            // USD: the largest new long it accepts (reserve and max open interest headroom, the lower); null without pool state
  maxSizeShort: Decimal | null;
  minCollateralUsd: Decimal | null;       // the exchange's minimum collateral per position; null when the market sets none
  session: SessionState;
  sessionNote?: string;                   // e.g. "US market hours, Mon–Fri 13:30–20:00 UTC"
  freshness: DataFreshness;
  updatedAt: Millis | null;
}

export interface PriceTick { symbol: string; min: Decimal; max: Decimal; mid: Decimal; ts: Millis; session: SessionState }

// 5m 15m 1h 4h 1D come from GMTrade's candle service (source 'venue'); 30m 2h 6h 12h 1W (Monday 00:00 UTC) 1M (calendar
// month, UTC) are rolled up from them on the server; 1m and 3m come from Props.trade's own price record (source
// 'record'), whose history starts with it (2026-09-23): an empty older window means history start, as with GMTrade's.
export type CandleInterval = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1D' | '1W' | '1M';
export interface Candle { time: number /* unix seconds */; open: number; high: number; low: number; close: number; volume?: number }
export interface CandlesResponse { symbol: string; interval: CandleInterval; candles: Candle[]; source: 'venue' | 'record'; freshness: DataFreshness }

export interface MarketTrade { id: string; symbol: string; side: 'Long' | 'Short'; isIncrease: boolean; price: Decimal; sizeUsd: Decimal; ts: Millis; signature?: string }

/**
 * The order ticket's cost preview for an order that opens or adds to a position. The exchange's figures (open and
 * close fee, impact, rates) are priced on the pool without the account's own position in it, at the live price (at
 * `limitPrice` for a limit order); the resulting position is then valued as the positions table will value it (in the
 * pool). Props.trade's own fee per order (`platformFeeUsd`, `platformCloseFeeUsd`) is the AppConfig rate on the order's
 * size, computed with @props/sdk `orderFee` exactly as the program and the simulator compute it; both are '0' while the
 * rate is 0.
 */
export interface PriceImpactQuote {
  symbol: string; side: 'Long' | 'Short'; sizeUsd: Decimal; priceImpactPct: number; openFeeUsd: Decimal; executionPrice: Decimal;
  orderValueUsd: Decimal;               // the order's notional (= sizeUsd)
  collateralUsd: Decimal | null;        // the margin the quote was priced at; null = 1x (the request gave none)
  closeFeeUsd: Decimal;                 // the exchange's fee to close the resulting position at the same price
  /** Every per-order fee of the round trip: openFeeUsd + closeFeeUsd + platformFeeUsd + platformCloseFeeUsd. */
  roundTripFeeUsd: Decimal;
  fundingRateHourlyPct: number | null;  // the requested side's, as Market gives it (positive = this side pays)
  borrowRateHourlyPct: number | null;
  hourlyCostUsd: Decimal | null;        // (borrow + funding when paid) × size, per hour: received funding is never credited
  liquidationPrice: Decimal | null;     // of the resulting position at collateralUsd; null when the model cannot value it
  /**
   * Props.trade's fee on this order: flat + bps × size at the current rate (AppConfig.orderFeeUsd / orderFeeBps). Charged
   * only if the order executes: on practice and evaluation accounts it is simulated (deducted from the virtual balance at
   * the fill); on a funded account the program assesses exactly this amount when the order is placed.
   */
  platformFeeUsd: Decimal;
  /**
   * `platformFeeUsd` in USDC base units (a u64 as a decimal integer string): the `maxFee` the funded open passes to
   * @props/sdk `openPosition`. The program refuses the order (OrderFeeChanged) if the rate gives more when it lands: then
   * quote again and let the trader place it again at the new fee. A close, take profit or stop loss passes its maximum
   * instead, the rate on the account's exposure cap: `orderFee(rate, CLOSE_ALL, usdToGm(rules.maxExposureUsd))` (the
   * program assesses decreases on that cap).
   */
  maxFeeMicro: string;
  /** Props.trade's fee to close the resulting position (this order's size) at the same rate, charged when a close executes. */
  platformCloseFeeUsd: Decimal;
  maxSizeUsd: Decimal | null;           // the requested side's Market.maxSizeLong / maxSizeShort, as of the quote
  maxLeverage: number;                  // the requested side's Market.maxLeverageLong / maxLeverageShort
}

// ---------- programs / config ----------
export interface Tier {
  id: number; name: string;    // "10K"
  sizeUsd: Decimal; feeUsdc: Decimal;
  profitTargetBps: number; maxDrawdownBps: number; maxExposureBps: number;
  traderShareBps: number; enabled: boolean; termsHash: string; version: number;
}
export interface AppConfig {
  cluster: 'mainnet-beta' | 'localnet';
  programId: Pubkey; usdcMint: Pubkey; venueStore: Pubkey;
  tiers: Tier[];
  traderShareBps: number; minPayoutUsdc: Decimal;
  paused: { newEvaluations: boolean; trading: boolean; payouts: boolean };
  feeVault: Pubkey; capitalVault: Pubkey;
  /**
   * Props.trade's fee per order: `orderFeeUsd` flat (USDC, '0' when off) plus `orderFeeBps` of the order's size, both 0
   * until the admin sets them (at most $2 and 10 bps). The same rate on every stage and every account, applied to orders
   * placed or updated from then on: @props/sdk `orderFee` computes an order's fee from it (a close, take profit or stop
   * loss counts at most the account's exposure cap). `orderFeeSource`: 'program' = the onchain Config (once the program is
   * live, practice and evaluation read it too), 'server' = the server's settings (ORDER_FEE_USDC / ORDER_FEE_BPS) before
   * then, which only /v1/order-fee (`OrderFeeInfo`) can serve. Practice and evaluation fees are simulated: they lower the
   * virtual balance, no USDC moves.
   */
  orderFeeUsd: Decimal;
  orderFeeBps: number;
  orderFeeSource: 'program' | 'server';
}
/**
 * GET /v1/order-fee: the rate alone, answered on every stage before the program is live too (then from the server's
 * settings, `orderFeeSource` 'server'), while /v1/config answers 503 `not_initialized` until the program is live.
 */
export type OrderFeeInfo = Pick<AppConfig, 'orderFeeUsd' | 'orderFeeBps' | 'orderFeeSource'>;

// ---------- auth / me ----------
/**
 * An outside source the service depends on: 'checking' until its first answer, 'degraded' after a failure, 'down' after
 * three in a row, with why, since when, and what the service does meanwhile (`fallback`).
 */
export interface UpstreamStatus {
  state: 'checking' | 'ok' | 'degraded' | 'down'; since: Millis | null; lastOkAt: Millis | null; lastError: string | null;
  latencyMs: number | null; fallback: string;
  /** The candles source only: the chart history the server keeps in its database — how many series (market ×
   *  interval) it restored the latest window of at boot, and the background backfill's progress. */
  history?: { seriesWarmAtBoot: number; backfill: { seriesDone: number; seriesTotal: number; windowsStored: number } };
}
/** `status` is 'degraded' when the database is down (HTTP 503) or an outside source is down (HTTP 200: fallbacks serve). */
export interface Health {
  status: 'ok' | 'degraded'; db: 'ok' | 'down'; modules: Record<string, 'running' | 'absent'>; time: Millis;
  /** p99 time the process was busy over the last minute: high means this server is overloaded, not its sources. */
  eventLoopDelayMs: number;
  /** Present when marketdata runs: GMTrade's price stream, candles, trades, market-info and the Solana RPC. */
  upstreams?: Record<string, UpstreamStatus>;
  /** Present when the keeper module runs: whether this replica leads it, its last completed tick, and the last GMTrade
   *  program upgrade it saw (after which every active funded account is restricted until an operator acknowledges it). */
  keeper?: {
    leader: boolean; lastTickAt: Millis | null;
    venueUpgrade: { slot: number; detectedAt: Millis; restrictedAt: Millis | null; acknowledgedAt: Millis | null } | null;
  };
}
export interface NonceRequest { wallet: Pubkey }
export interface VerifyResponse { wallet: Pubkey; expiresAt: Millis }
/** Residence: `country` ISO 3166-1 alpha-2; `region` ISO 3166-2 (e.g. "UA-30"), required where only part of a country is sanctioned (UA). */
export interface KycStartRequest { country: string; region?: string }
export interface KycStartResponse { kyc: 'pending' }
export interface NotificationsReadRequest { ids?: string[] /* omit = all */ }
export interface NonceResponse { message: string; nonce: string; expiresAt: Millis }
export interface VerifyRequest { wallet: Pubkey; message: string; signature: string /* base58 */ }
export interface Me {
  wallet: Pubkey;
  kyc: 'none' | 'pending' | 'verified' | 'rejected';
  profile?: Pubkey;            // TraderProfile PDA when it exists
  usdcBalance: Decimal | null; solBalance: Decimal | null;
}

// ---------- accounts ----------
export type Stage = 'practice' | 'evaluation' | 'funded';
export type AccountStatus =
  | 'active' | 'near_limit' | 'checking' | 'passed' | 'breached' | 'failed'           // practice / evaluation
  | 'awaiting_capacity' | 'activating' | 'restricted' | 'payout_pending' | 'closure_pending' | 'closed'; // funded

export interface AccountRules {
  sizeUsd: Decimal; lossAllowanceUsd: Decimal; floorUsd: Decimal;
  profitTargetUsd: Decimal | null; maxExposureUsd: Decimal; traderShareBps: number;
  drawdownType: 'static'; includesOpenPnl: true; dailyLossLimit: null; timeLimit: null;
  termsHash: string | null; version: number | null;
}
export interface AccountSummary {
  id: string;                  // practice: "practice:<wallet>", evaluation/funded: onchain PDA
  stage: Stage; status: AccountStatus;
  label: string;               // "Evaluation 25K"
  shortId: string;             // display id, e.g. "PT-9Kq3…"
  rules: AccountRules;
  equity: Decimal; realizedPnl: Decimal; unrealizedPnl: Decimal;
  allowanceRemaining: Decimal;
  /** Margin a new order may commit, its own Props fee included: net of `platformFees.heldUsd`. */
  availableMargin: Decimal;
  openNotional: Decimal;
  /**
   * Props.trade order fees (on practice and evaluation accounts simulated). `dueUsd`: of orders that left the book, not
   * settled yet (funded only; payouts and closure wait for it to be 0). `paidUsd`: charged so far (funded: USDC moved to
   * the fee vault; demo: deducted from the virtual balance at the fills). `heldUsd`: kept out of `availableMargin`: the
   * fees due plus the fees of pending orders that add exposure (charged when they execute).
   */
  platformFees: { dueUsd: Decimal; paidUsd: Decimal; heldUsd: Decimal };
  targetProgressPct: number | null;
  eligiblePayout: Decimal | null;          // funded: trader share of realized profit now
  createdAt: Millis; activatedAt: Millis | null; resolvedAt: Millis | null;
  /** `resultSignature`: the confirmed record_evaluation_result transaction; absent until the result is onchain. */
  evidence: { evaluation?: Pubkey; funded?: Pubkey; owner?: Pubkey; purchaseSignature?: string; resultSignature?: string; activationSignature?: string };
  freshness: DataFreshness;
}

export type OrderKind = 'Market' | 'Limit' | 'TakeProfit' | 'StopLoss';
export type OrderStatus = 'draft' | 'signing' | 'submitted' | 'awaiting_execution' | 'awaiting_price' | 'executed' | 'canceled' | 'rejected' | 'frozen' | 'unknown';
export interface Position {
  id: string; symbol: string; side: 'Long' | 'Short';
  sizeUsd: Decimal; sizeTokens: Decimal; collateralUsd: Decimal; leverage: number;
  entryPrice: Decimal; markPrice: Decimal | null; liquidationPrice: Decimal | null;
  /** Net, in every stage: the position's net value minus its collateral, i.e. price P&L less the pending borrowing,
   *  funding and close fee below (GMTrade's netValue is floored at 0, so never below −collateral). */
  unrealizedPnl: Decimal | null;
  /** pendingBorrowUsd + pendingFundingUsd + closeFeeUsd: what the next fill of this position settles. */
  pendingFeesUsd: Decimal;
  pendingBorrowUsd: Decimal; pendingFundingUsd: Decimal; closeFeeUsd: Decimal;
  /** Props.trade's fee to close the whole position at the current rate, charged when a close executes (not in
   *  pendingFeesUsd or unrealizedPnl: like every Props fee it counts once its order executes). */
  platformFeeUsd: Decimal;
  /** A market order closing the whole position is pending: the row is on its way out. */
  closing: boolean;
  takeProfit: { price: Decimal; orderId: string; status: OrderStatus } | null;
  stopLoss: { price: Decimal; orderId: string; status: OrderStatus } | null;
  openedAt: Millis;
  venue: 'simulated' | 'exchange'; gmPosition?: Pubkey;
}
export interface Order {
  id: string; symbol: string; side: 'Long' | 'Short'; kind: OrderKind; isIncrease: boolean;
  sizeUsd: Decimal; collateralUsd: Decimal | null; triggerPrice: Decimal | null; acceptablePrice: Decimal | null;
  status: OrderStatus; statusDetail?: string; createdAt: Millis; updatedAt: Millis;
  /** Props.trade's fee assessed on the order, charged only if it executes: an increase exactly this; a close, take
   *  profit or stop loss at most this (the rate on the account's exposure cap), charged on the size it closes. */
  platformFeeUsd: Decimal;
  signature?: string; gmOrder?: Pubkey;
}
export interface Fill {
  id: string; symbol: string; side: 'Long' | 'Short'; isIncrease: boolean;
  sizeUsd: Decimal; price: Decimal; feeUsd: Decimal; priceImpactUsd: Decimal; fundingUsd: Decimal; borrowUsd: Decimal;
  /** Props.trade's fee on this fill (simulated): in realizedPnl like the exchange's fee; 0 for a liquidation. */
  platformFeeUsd: Decimal;
  realizedPnl: Decimal | null;  // on decreases; simulated fills also give an increase's costs (≤ 0), so realized P&L = Σ fills
  ts: Millis; venue: 'simulated' | 'exchange'; signature?: string;
}
export interface ClosedTrade {
  id: string; symbol: string; side: 'Long' | 'Short'; openedAt: Millis; closedAt: Millis;
  sizeUsd: Decimal; entryPrice: Decimal; exitPrice: Decimal;
  /** Every cost of the round trip: feesUsd = orderFeesUsd + platformFeeUsd + fundingUsd + borrowUsd (the exchange's
   *  order fees include a liquidation fee; platformFeeUsd is Props.trade's fee on the trip's orders that executed).
   *  Price impact is inside the prices and the P&L, shown for the record. netPnl is after all of them. */
  feesUsd: Decimal; orderFeesUsd: Decimal; platformFeeUsd: Decimal; fundingUsd: Decimal; borrowUsd: Decimal; priceImpactUsd: Decimal;
  netPnl: Decimal;
  venue: 'simulated' | 'exchange'; signatures: string[];
}
export type ActivityType = 'order' | 'fill' | 'cancel' | 'protection' | 'liquidation' | 'charge' | 'account' | 'payout' | 'risk';
export interface ActivityItem {
  id: string; type: ActivityType; title: string; detail: string; ts: Millis;
  status: 'pending' | 'confirmed' | 'failed' | 'indexing';
  amountUsd?: Decimal; symbol?: string; signature?: string; simulated: boolean;
}
export interface PerformancePoint { ts: Millis; equity: Decimal; netPnl: Decimal }
export interface Performance {
  period: '1W' | '1M' | 'All';
  series: PerformancePoint[];
  /** feesUsd: the exchange's order fees; platformFeesUsd: Props.trade's fees on the period's fills. */
  netPnl: Decimal; grossRealized: Decimal; feesUsd: Decimal; platformFeesUsd: Decimal; fundingBorrowUsd: Decimal; unrealizedPnl: Decimal;
  trades: number; winRatePct: number | null; profitFactor: number | null; averageTradeUsd: Decimal | null;
  byMarket: { symbol: string; netPnl: Decimal; sharePct: number }[];
}
export interface AccountDetail extends AccountSummary { positions: Position[]; orders: Order[] }

// ---------- simulated trading (practice + evaluation) ----------
export interface SimOrderRequest {
  clientId: string;            // idempotency key
  symbol: string; side: 'Long' | 'Short'; kind: 'Market' | 'Limit';
  sizeUsd: Decimal; collateralUsd: Decimal;
  triggerPrice?: Decimal; slippageBps: number;
  takeProfit?: Decimal; stopLoss?: Decimal;
}
export interface SimOrderResponse { order: Order; account: AccountSummary }
export interface SimCloseRequest { clientId: string; percent: number /* 1..100 */; slippageBps: number }
export interface SimProtectionRequest { takeProfit: Decimal | null; stopLoss: Decimal | null }

// ---------- payouts ----------
export type PayoutStatus = 'requested' | 'reviewing' | 'paid' | 'rejected' | 'cancelled' | 'uncertain';
export interface Payout {
  id: string;                  // PayoutRequest PDA
  account: string; accountLabel: string;
  seq: number; status: PayoutStatus; reasonCode?: number; reason?: string;
  balanceAtRequest: Decimal; profit: Decimal; traderAmount: Decimal; vaultAmount: Decimal; networkFeeSol: Decimal | null;
  destination: Pubkey;         // trader USDC ATA owner wallet
  requestedAt: Millis; resolvedAt: Millis | null;
  requestSignature?: string; paySignature?: string;
}
export interface PayoutEligibility {
  account: string; eligible: boolean; reasons: string[];
  realizedProfit: Decimal; traderShare: Decimal; vaultShare: Decimal; minPayout: Decimal;
  flat: boolean; openPositions: number; pendingOrders: number;
}

// ---------- traders (public search) ----------
/** A trader's public record by wallet address: accounts at every stage, open positions, the last 50 closed trades and
 *  payouts. Never identity data. An evaluation or funded account address resolves to its trader. */
export interface TraderLookup {
  address: Pubkey;
  accounts: { id: string; stage: Stage; status: AccountStatus; sizeUsd: Decimal; equityUsd: Decimal; createdAt: Millis }[];
  positions: Position[];
  trades: ClosedTrade[];
  payouts: { id: string; status: PayoutStatus; amountUsd: Decimal; requestedAt: Millis; paidAt: Millis | null; signature: string | null }[];
}

// ---------- referrals ----------
// A wallet's referral code is the first 8 characters of its address, upper-cased (9, 10, … when another wallet holds
// those already); it is given at the first sign-in and never changes. Codes match case-insensitively. A referrer earns
// `rewardBps` of the Props fee charged on every funded-account order of the traders who signed up with its code (a fee
// waived earns nothing; practice and evaluation fees are simulated and earn nothing), paid in USDC by Props.trade.
export interface ReferralProgram { rewardBps: number }
export interface ReferralCodeCheck { valid: boolean }
export interface SetReferrerRequest { code: string }
export interface ReferralSummary {
  code: string;
  referredBy: string | null;       // the referrer's code, never its wallet
  canSetReferrer: boolean;         // no referrer yet, within 7 days of the first sign-in and before any evaluation
  setReferrerUntil: Millis | null; // when that window closes, while canSetReferrer
  rewardBps: number;
  referees: number; refereesWithEvaluation: number; refereesFunded: number;
  fundedVolumeUsd: Decimal;        // the referees' funded fills
  earnedUsd: Decimal; paidUsd: Decimal; pendingUsd: Decimal;
  // latest 50; feeUsd: the Props fee one settlement charged the order the reward is for
  recent: Array<{ at: Millis; referee: string /* masked: first 4 … last 4 */; symbol: string; feeUsd: Decimal; rewardUsd: Decimal }>;
}

// ---------- verification ----------
export type EvidenceState = 'confirmed' | 'pending' | 'indexing' | 'stale' | 'unavailable' | 'simulated';
export interface EvidenceItem {
  title: string; description: string; state: EvidenceState;
  address?: Pubkey; signature?: string; slot?: number; ts?: Millis;
  explorerUrl?: string; establishes: string;   // plain English: what this record proves, and its limits
  /** A recorded evaluation result: the trades root (hex) it committed to, recomputable from GET /sim/:evaluation/fills. */
  tradesRoot?: { root: string; evaluation: Pubkey };
}
export interface VerifyResult {
  query: string; kind: 'evaluation' | 'funded' | 'payout' | 'transaction' | 'wallet' | 'not_found' | 'unsupported';
  title: string; items: EvidenceItem[];
}

// ---------- vault transparency ----------
export interface VaultLedgerItem { id: string; event: string; account?: string; amountUsd: Decimal; direction: 'in' | 'out' | 'internal'; ts: Millis; signature: string }
export interface VaultStats {
  programId: Pubkey; capitalVault: Pubkey; feeVault: Pubkey; solTreasury: Pubkey;
  capitalUsdc: Decimal; allocatedPrincipal: Decimal; unallocated: Decimal; feeVaultUsdc: Decimal;
  pendingPayouts: Decimal; fundedAccounts: number; solTreasurySol: Decimal;
  /** feesCollected: evaluation fees (Config.fees_collected); orderFeesCharged: Props order fees charged to funded
   *  accounts (their settlements); both land in the fee vault. */
  totals: { feesCollected: Decimal; orderFeesCharged: Decimal; payoutsPaid: Decimal; profitToVault: Decimal };
  series: { ts: Millis; capitalUsdc: Decimal }[];
  ledger: VaultLedgerItem[];
  freshness: DataFreshness; updatedAt: Millis;
}

// ---------- notifications / stream ----------
export interface Notification { id: string; title: string; body: string; href: string; ts: Millis; read: boolean; kind: 'fill' | 'risk' | 'payout' | 'account' }
export type StreamEvent =
  | { type: 'price'; ticks: PriceTick[] }
  | { type: 'market'; market: Market }
  | { type: 'account'; account: AccountSummary }
  | { type: 'positions'; accountId: string; positions: Position[] }
  | { type: 'orders'; accountId: string; orders: Order[] }
  | { type: 'notification'; notification: Notification }
  | { type: 'heartbeat'; ts: Millis };

export interface ApiError { error: { code: string; message: string } }
