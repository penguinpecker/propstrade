// Contracts between server core (server/src/*) and feature modules (server/src/modules/<name>/).
// Core owns: config, db, auth, stream hub, registry. Each module owns its folder and exports a default
// `register(ctx)` that returns its service. Modules talk to each other only through these interfaces.
import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import type { Connection } from '@solana/web3.js';
import type {
  Market, PriceTick, CandleInterval, CandlesResponse, MarketTrade, PriceImpactQuote, StreamEvent, Notification,
  AccountSummary, AccountDetail, Position, Order, ClosedTrade, ActivityItem, Performance, AppConfig,
} from '@props/shared';
import type { Prices } from '@props/gmsol-wasm';
import type { Config } from '../config.js';
import type { Db, Sql } from '../db/client.js';
import type { OrderFeeRateInfo } from '../lib/order-fee.js';
import type { UpstreamStatus } from './marketdata/upstreams.js';

export interface ModuleContext {
  app: FastifyInstance;                 // register routes under /v1; auth guard: app.requireWallet (see auth/routes.ts)
  log: FastifyBaseLogger;
  env: Record<string, string | undefined>;
  publish(event: StreamEvent, audience?: { wallet?: string }): void; // SSE hub; no audience = broadcast
  services: Services;                   // filled in registration order: marketdata → sim → chain → keeper
  signal: AbortSignal;                  // aborted on shutdown
  config: Config;                       // validated env (server/src/config.ts)
  db: Db;                               // Drizzle over the shared pool (server/src/db/schema.ts)
  sql: Sql;                             // raw postgres-js client for the same pool
  rpc: Connection;                      // Solana RPC (commitment 'confirmed')
  /** Persist a notification for a wallet (notifications table) and push it on the stream. */
  notify(wallet: string, n: Pick<Notification, 'title' | 'body' | 'href' | 'kind'>): Promise<void>;
}

export interface Services {
  marketdata?: MarketDataService;
  sim?: SimService;
  chain?: ChainService;
  keeper?: { status(): KeeperStatus };
}

/** Risk keeper state for /v1/health (server/src/modules/keeper). */
export interface KeeperStatus {
  leader: boolean;
  lastTickAt: number | null;
  /**
   * The last GMTrade program upgrade seen: deploy slot, when noticed, when every active account had been restricted,
   * and when an operator acknowledged the new release as reviewed (until then accounts stay restricted).
   */
  venueUpgrade: { slot: number; detectedAt: number; restrictedAt: number | null; acknowledgedAt: number | null } | null;
}

/** Read side of one stage family. The accounts router (chain module) merges providers and dispatches by stage. */
export interface AccountsProvider {
  list(wallet: string): Promise<AccountSummary[]>;
  /** undefined = not found OR not owned by wallet (never leak other wallets' accounts). */
  detail(wallet: string, id: string): Promise<AccountDetail | undefined>;
  positions(wallet: string, id: string): Promise<Position[] | undefined>;
  orders(wallet: string, id: string): Promise<Order[] | undefined>;
  /** Newest first; `limit` caps the read (the public trader lookup keeps 50 per account, the owner's pages take all). */
  history(wallet: string, id: string, limit?: number): Promise<ClosedTrade[] | undefined>;
  activity(wallet: string, id: string): Promise<ActivityItem[] | undefined>;
  performance(wallet: string, id: string, period: Performance['period']): Promise<Performance | undefined>;
}

/** Evaluation terms as pinned onchain in the Evaluation account at purchase. Amounts are USD decimal strings. */
export interface EvaluationTerms {
  tierId: number; sizeUsd: string; profitTargetBps: number; maxDrawdownBps: number; maxExposureBps: number;
  traderShareBps: number; termsHash: string;
}
export interface EvaluationResult { evaluation: string; wallet: string; passed: boolean; finalEquityUsd: string; tradesRoot: string /* hex */; resolvedAt: number }

/** Practice + evaluation engine (server/src/modules/sim). Owns routes /v1/sim/* and /v1/practice/*. */
export interface SimService extends AccountsProvider {
  /** Idempotent: called by the chain indexer for every EvaluationPurchased event (also on backfill). */
  createEvaluation(input: { evaluation: string; wallet: string; terms: EvaluationTerms; purchasedAt: number; signature: string }): Promise<void>;
  /** Called when the engine decides pass/fail, then again (every 5 min, and when a new leader starts) until markRecorded,
   * so a crash or a late subscriber loses nothing; the chain module sends record_evaluation_result idempotently. */
  onResolved(listener: (result: EvaluationResult) => void): () => void;
  /** Called by the chain module once record_evaluation_result is confirmed onchain (or already resolved). */
  markRecorded(evaluation: string, signature: string): Promise<void>;
}

/** Chain indexer, funded accounts, payouts, verify, vault, config, chain jobs (server/src/modules/chain).
 * Owns routes /v1/config, /v1/accounts* (merging sim + funded), /v1/payouts*, /v1/verify, /v1/vault. */
export interface ChainService extends AccountsProvider {
  config(): Promise<AppConfig>;
  /** The rate every stage assesses orders at now: the onchain Config's once the program is live, else the server's
   *  settings (cached ~30 s; a failed read keeps the last rate known). */
  orderFeeRate(): Promise<OrderFeeRateInfo>;
}

/** Raw GMTrade market state needed by the simulator and risk checks (decoded onchain Market + live prices). */
export interface MarketState {
  symbol: string;
  marketToken: string;
  indexToken: string;
  pure: boolean;
  isClosed: boolean;
  /** { market: base64 Market account, virtualInventories: { address: base64 }, slot } — raw images the WASM model reads. */
  raw: unknown;
  /** Oracle unit prices (USD × 10^(20 − token decimals)) of the index, long and short tokens, as the WASM model takes them. */
  prices: Prices;
  /** Index token decimals: a PriceTick's USD price × 10^(20 − indexDecimals) is its unit price. */
  indexDecimals: number;
  fetchedAt: number;
}

export interface MarketDataService {
  ready(): Promise<void>;
  markets(): Market[];                                   // all 68 index assets
  market(symbol: string): Market | undefined;
  price(symbol: string): PriceTick | undefined;          // latest accepted tick (monotonic ts)
  onTick(listener: (tick: PriceTick) => void): () => void;
  marketState(marketToken: string): Promise<MarketState>;
  candles(symbol: string, interval: CandleInterval, from?: number, to?: number): Promise<CandlesResponse>;
  trades(symbol: string, limit?: number): Promise<MarketTrade[]>;
  /** The ticket's cost preview; `collateralUsd` prices the resulting position at that margin (1x without it),
   *  `limitPrice` prices a limit order at its price instead of the live one. */
  quote(symbol: string, side: 'Long' | 'Short', sizeUsd: string, collateralUsd?: string, limitPrice?: string): Promise<PriceImpactQuote>;
  /** Each outside source's state: which is failing, since when, why, and what the service does meanwhile. */
  health(): Record<string, UpstreamStatus>;
}

export type ModuleRegister<S> = (ctx: ModuleContext) => Promise<S>;
