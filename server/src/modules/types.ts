// Contracts between server core (server/src/*) and feature modules (server/src/modules/<name>/).
// Core owns: config, db, auth, stream hub, registry. Each module owns its folder and exports a default
// `register(ctx)` that returns its service. Modules talk to each other only through these interfaces.
import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import type { Connection } from '@solana/web3.js';
import type {
  Market, PriceTick, CandleInterval, CandlesResponse, MarketTrade, PriceImpactQuote, StreamEvent, Notification,
  AccountSummary, AccountDetail, Position, Order, ClosedTrade, ActivityItem, Performance, AppConfig,
} from '@props/shared';
import type { Config } from '../config.js';
import type { Db, Sql } from '../db/client.js';

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
  keeper?: { status(): { leader: boolean; lastTickAt: number | null } };
}

/** Read side of one stage family. The accounts router (chain module) merges providers and dispatches by stage. */
export interface AccountsProvider {
  list(wallet: string): Promise<AccountSummary[]>;
  /** undefined = not found OR not owned by wallet (never leak other wallets' accounts). */
  detail(wallet: string, id: string): Promise<AccountDetail | undefined>;
  positions(wallet: string, id: string): Promise<Position[] | undefined>;
  orders(wallet: string, id: string): Promise<Order[] | undefined>;
  history(wallet: string, id: string): Promise<ClosedTrade[] | undefined>;
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
  /** Called once per evaluation when the engine decides pass/fail; the chain module sends record_evaluation_result. */
  onResolved(listener: (result: EvaluationResult) => void): () => void;
  /** Called by the chain module once record_evaluation_result is confirmed onchain (or already resolved). */
  markRecorded(evaluation: string, signature: string): Promise<void>;
}

/** Chain indexer, funded accounts, payouts, verify, vault, config, chain jobs (server/src/modules/chain).
 * Owns routes /v1/config, /v1/accounts* (merging sim + funded), /v1/payouts*, /v1/verify, /v1/vault. */
export interface ChainService extends AccountsProvider {
  config(): Promise<AppConfig>;
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
  quote(symbol: string, side: 'Long' | 'Short', sizeUsd: string): Promise<PriceImpactQuote>;
}

export type ModuleRegister<S> = (ctx: ModuleContext) => Promise<S>;
