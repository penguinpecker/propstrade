// Props.trade HTTP + stream contract. Single source of truth for server/ and app/.
//
// Endpoints (all under /v1; lists return bare JSON arrays; errors return ApiError with a 4xx/5xx status):
//   GET  /health -> Health                                   GET  /config -> AppConfig
//   GET  /markets -> Market[]                                GET  /markets/:symbol -> Market
//   GET  /candles?symbol&interval&from&to -> CandlesResponse  GET  /markets/:symbol/trades?limit -> MarketTrade[]
//   GET  /quote?symbol&side&sizeUsd -> PriceImpactQuote       GET  /stream -> SSE, `data: <StreamEvent JSON>`
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
//   POST /practice/reset -> AccountSummary                     GET  /sim/:id/fills -> Fill[] (every fill, trades-root order)
//   GET  /payouts -> Payout[]                                 GET  /payouts/:id -> Payout
//   GET  /verify?q -> VerifyResult                            GET  /vault -> VaultStats
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
  marketToken: Pubkey;         // GMTrade market token of the preferred pool (pure USDC-USDC when available)
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
  borrowRateHourlyLong: number | null;
  borrowRateHourlyShort: number | null;
  capacityLong: Decimal | null;           // USD of additional long OI the pool accepts
  capacityShort: Decimal | null;
  poolLiquidity: Decimal | null;          // real LP value of the preferred pool, USD
  maxLeverage: number;                    // Props limit (min of venue and MarketConfig)
  closedMaxLeverage: number | null;       // leverage allowed through a session close
  session: SessionState;
  sessionNote?: string;                   // e.g. "US market hours, Mon–Fri 13:30–20:00 UTC"
  freshness: DataFreshness;
  updatedAt: Millis | null;
}

export interface PriceTick { symbol: string; min: Decimal; max: Decimal; mid: Decimal; ts: Millis; session: SessionState }

export type CandleInterval = '5m' | '15m' | '1h' | '4h' | '1D';
export interface Candle { time: number /* unix seconds */; open: number; high: number; low: number; close: number; volume?: number }
export interface CandlesResponse { symbol: string; interval: CandleInterval; candles: Candle[]; source: 'gmtrade'; freshness: DataFreshness }

export interface MarketTrade { id: string; symbol: string; side: 'Long' | 'Short'; isIncrease: boolean; price: Decimal; sizeUsd: Decimal; ts: Millis; signature?: string }

export interface PriceImpactQuote { symbol: string; side: 'Long' | 'Short'; sizeUsd: Decimal; priceImpactPct: number; openFeeUsd: Decimal; executionPrice: Decimal }

// ---------- programs / config ----------
export interface Tier {
  id: number; name: string;    // "10K"
  sizeUsd: Decimal; feeUsdc: Decimal;
  profitTargetBps: number; maxDrawdownBps: number; maxExposureBps: number;
  traderShareBps: number; enabled: boolean; termsHash: string; version: number;
}
export interface AppConfig {
  cluster: 'mainnet-beta' | 'localnet';
  programId: Pubkey; usdcMint: Pubkey; gmtradeStore: Pubkey;
  tiers: Tier[];
  traderShareBps: number; minPayoutUsdc: Decimal;
  paused: { newEvaluations: boolean; trading: boolean; payouts: boolean };
  feeVault: Pubkey; capitalVault: Pubkey;
}

// ---------- auth / me ----------
export interface Health {
  status: 'ok' | 'degraded'; db: 'ok' | 'down'; modules: Record<string, 'running' | 'absent'>; time: Millis;
  /** Present when the keeper module runs: whether this replica leads it, its last completed tick, and the last GMTrade
   *  program upgrade it saw (after which every active funded account is restricted until an operator acknowledges it). */
  keeper?: {
    leader: boolean; lastTickAt: Millis | null;
    gmtradeUpgrade: { slot: number; detectedAt: Millis; restrictedAt: Millis | null; acknowledgedAt: Millis | null } | null;
  };
}
export interface NonceRequest { wallet: Pubkey }
export interface VerifyResponse { wallet: Pubkey; expiresAt: Millis }
export interface KycStartRequest { country: string /* ISO 3166-1 alpha-2 */ }
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
  allowanceRemaining: Decimal; availableMargin: Decimal; openNotional: Decimal;
  targetProgressPct: number | null;
  eligiblePayout: Decimal | null;          // funded: trader share of realized profit now
  createdAt: Millis; activatedAt: Millis | null; resolvedAt: Millis | null;
  evidence: { evaluation?: Pubkey; funded?: Pubkey; owner?: Pubkey; purchaseSignature?: string; activationSignature?: string };
  freshness: DataFreshness;
}

export type OrderKind = 'Market' | 'Limit' | 'TakeProfit' | 'StopLoss';
export type OrderStatus = 'draft' | 'signing' | 'submitted' | 'awaiting_execution' | 'awaiting_price' | 'executed' | 'canceled' | 'rejected' | 'frozen' | 'unknown';
export interface Position {
  id: string; symbol: string; side: 'Long' | 'Short';
  sizeUsd: Decimal; sizeTokens: Decimal; collateralUsd: Decimal; leverage: number;
  entryPrice: Decimal; markPrice: Decimal | null; liquidationPrice: Decimal | null;
  unrealizedPnl: Decimal | null; pendingFeesUsd: Decimal;
  takeProfit: { price: Decimal; orderId: string; status: OrderStatus } | null;
  stopLoss: { price: Decimal; orderId: string; status: OrderStatus } | null;
  openedAt: Millis;
  venue: 'simulated' | 'gmtrade'; gmPosition?: Pubkey;
}
export interface Order {
  id: string; symbol: string; side: 'Long' | 'Short'; kind: OrderKind; isIncrease: boolean;
  sizeUsd: Decimal; collateralUsd: Decimal | null; triggerPrice: Decimal | null; acceptablePrice: Decimal | null;
  status: OrderStatus; statusDetail?: string; createdAt: Millis; updatedAt: Millis;
  signature?: string; gmOrder?: Pubkey;
}
export interface Fill {
  id: string; symbol: string; side: 'Long' | 'Short'; isIncrease: boolean;
  sizeUsd: Decimal; price: Decimal; feeUsd: Decimal; priceImpactUsd: Decimal; fundingUsd: Decimal; borrowUsd: Decimal;
  realizedPnl: Decimal | null;  // on decreases; simulated fills also give an increase's costs (≤ 0), so realized P&L = Σ fills
  ts: Millis; venue: 'simulated' | 'gmtrade'; signature?: string;
}
export interface ClosedTrade {
  id: string; symbol: string; side: 'Long' | 'Short'; openedAt: Millis; closedAt: Millis;
  sizeUsd: Decimal; entryPrice: Decimal; exitPrice: Decimal; feesUsd: Decimal; netPnl: Decimal;
  venue: 'simulated' | 'gmtrade'; signatures: string[];
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
  netPnl: Decimal; grossRealized: Decimal; feesUsd: Decimal; fundingBorrowUsd: Decimal; unrealizedPnl: Decimal;
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

// ---------- verification ----------
export type EvidenceState = 'confirmed' | 'pending' | 'indexing' | 'stale' | 'unavailable' | 'simulated';
export interface EvidenceItem {
  title: string; description: string; state: EvidenceState;
  address?: Pubkey; signature?: string; slot?: number; ts?: Millis;
  explorerUrl?: string; establishes: string;   // plain English: what this record proves, and its limits
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
  totals: { feesCollected: Decimal; payoutsPaid: Decimal; profitToVault: Decimal };
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
