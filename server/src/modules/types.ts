// Contracts between server core (server/src/*) and feature modules (server/src/modules/<name>/).
// Core owns: config, db, auth, stream hub, registry. Each module owns its folder and exports a default
// `register(ctx)` that returns its service. Modules talk to each other only through these interfaces.
import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import type { Connection } from '@solana/web3.js';
import type { Market, PriceTick, CandleInterval, CandlesResponse, MarketTrade, PriceImpactQuote, StreamEvent } from '@props/shared';
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
}

export interface Services {
  marketdata?: MarketDataService;
  sim?: unknown;                         // defined by the sim module (round 2)
  chain?: unknown;                       // defined by the chain module (round 2)
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
