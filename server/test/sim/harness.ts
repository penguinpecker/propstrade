// Sim module test harness: a disposable database per test file, the real server app (auth, stream hub), the sim module
// registered for real (routes + leader lock), and a MarketDataService double that serves live GMTrade state recorded in
// fixtures/gmtrade-live.json (capture-fixtures.ts): real Market / VirtualInventory account images, real collateral
// prices, real catalog rows and the real price ticks of the capture window. Tests replay those ticks re-based to now,
// and reach far-away prices (triggers, liquidation, targets) by scaling a recorded tick.
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import type { Market, PriceTick, StreamEvent } from '@props/shared';
import { formatFixed, parseFixed } from '@props/gmtrade';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { notifications } from '../../src/db/schema.js';
import { createConnection } from '../../src/lib/solana.js';
import register from '../../src/modules/sim/index.js';
import type { EvaluationResult, MarketDataService, MarketState, ModuleContext } from '../../src/modules/types.js';
import { createStreamHub } from '../../src/stream.js';
import { recreateDatabase, testDatabaseUrl } from '../db.js';
import { APP_ORIGIN, fixtureRpc, signIn } from '../helpers.js';

interface FixtureMarket {
  row: Market; indexToken: string; indexDecimals: number; isClosed: boolean; slot: number;
  market: string; virtualInventories: Record<string, string>;
  prices: Record<'index' | 'long' | 'short', { min: string; max: string }>;
}
const fixture = JSON.parse(readFileSync(new URL('fixtures/gmtrade-live.json', import.meta.url), 'utf8')) as {
  markets: FixtureMarket[]; ticks: PriceTick[];
};

const CLOCKS = [4024, 4032, 4040]; // Market state.clocks: price impact distribution, borrowing, funding (0.10.0 IDL)
const FLAGS = 10; // Market flags byte; bit 5 = Closed

export class FixtureMarketData implements MarketDataService {
  readonly #listeners = new Set<(tick: PriceTick) => void>();
  readonly #latest = new Map<string, PriceTick>();
  readonly #rows = new Map<string, Market>();
  /** Closed flag of each Market account; starts as recorded (NVDA closed, the rest open). */
  readonly closed = new Map<string, boolean>();
  /**
   * Seconds since the market last changed onchain: the model accrues borrowing and funding over this span, as GMTrade
   * does before every action. 0 = no accrual at all (the clocks sit a day ahead), so fills are exact and repeatable.
   */
  clockAgeSeconds = 0;

  constructor() {
    for (const m of fixture.markets) {
      this.#rows.set(m.row.symbol, m.row);
      this.closed.set(m.row.symbol, m.isClosed);
      this.#latest.set(m.row.symbol, { ...this.recorded(m.row.symbol).at(-1)!, ts: Date.now() });
    }
  }

  /** The recorded ticks of a symbol (for a closed market without ticks: its closing price). */
  recorded(symbol: string): PriceTick[] {
    const ticks = fixture.ticks.filter((t) => t.symbol === symbol);
    if (ticks.length) return ticks;
    const m = this.#fixture(symbol);
    const text = (v: string) => formatFixed(BigInt(v), 20 - m.indexDecimals, 20 - m.indexDecimals);
    const { min, max } = m.prices.index;
    return [{ symbol, min: text(min), max: text(max), mid: text(String((BigInt(min) + BigInt(max)) / 2n)), ts: 0, session: m.isClosed ? 'closed' : 'open' }];
  }

  /** The last recorded tick of `symbol` with min and max scaled by `factor` (e.g. 0.95), at `ts`. */
  scaled(symbol: string, factor: number, ts = Date.now()): PriceTick {
    const { indexDecimals: dec } = this.#fixture(symbol);
    const last = this.recorded(symbol).at(-1)!;
    const scale = (v: string) => formatFixed((parseFixed(v, 20 - dec) * BigInt(Math.round(factor * 1e9))) / 10n ** 9n, 20 - dec, 20 - dec);
    const [min, max] = [scale(last.min), scale(last.max)];
    const mid = formatFixed((parseFixed(min, 20 - dec) + parseFixed(max, 20 - dec)) / 2n, 20 - dec, 20 - dec);
    return { ...last, min, max, mid, ts };
  }

  setRow(symbol: string, patch: Partial<Market>) {
    this.#rows.set(symbol, { ...this.#rows.get(symbol)!, ...patch });
  }

  /** Delivers a tick as marketdata does: latest price, then every onTick listener. */
  push(tick: PriceTick) {
    this.#latest.set(tick.symbol, tick);
    for (const listener of this.#listeners) listener(tick);
  }

  #fixture(symbol: string): FixtureMarket {
    const m = fixture.markets.find((x) => x.row.symbol === symbol);
    if (!m) throw new Error(`no fixture market ${symbol}`);
    return m;
  }

  ready = async () => {};
  markets = () => [...this.#rows.keys()].map((s) => this.market(s)!);
  market = (symbol: string): Market | undefined => {
    const row = this.#rows.get(symbol.toUpperCase());
    return row && { ...row, session: this.#latest.get(row.symbol)?.session ?? row.session };
  };
  price = (symbol: string) => this.#latest.get(symbol.toUpperCase());
  onTick = (listener: (tick: PriceTick) => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  marketState = async (marketToken: string): Promise<MarketState> => {
    const m = fixture.markets.find((x) => x.row.marketToken === marketToken);
    if (!m) throw new Error(`no onchain state for market ${marketToken}`);
    const account = Buffer.from(m.market, 'base64');
    const clock = Math.floor(Date.now() / 1000) + (this.clockAgeSeconds ? -this.clockAgeSeconds : 86_400);
    for (const at of CLOCKS) account.writeBigInt64LE(BigInt(clock), at);
    const closed = this.closed.get(m.row.symbol)!;
    account[FLAGS] = closed ? account[FLAGS]! | 0x20 : account[FLAGS]! & ~0x20;
    const price = (p: { min: string; max: string }) => ({ min: BigInt(p.min), max: BigInt(p.max) });
    return {
      symbol: m.row.symbol, marketToken, indexToken: m.indexToken, pure: true, isClosed: closed,
      raw: { market: account.toString('base64'), virtualInventories: m.virtualInventories, slot: m.slot },
      prices: { index: price(m.prices.index), long: price(m.prices.long), short: price(m.prices.short) },
      indexDecimals: m.indexDecimals, fetchedAt: Date.now(),
    };
  };
  candles = () => Promise.reject(new Error('not used by the sim module'));
  trades = () => Promise.reject(new Error('not used by the sim module'));
  quote = () => Promise.reject(new Error('not used by the sim module'));
}

/** Starts the app with the sim module on its own database `<TEST_DATABASE_URL>_<name>`. */
export async function startSim(name: string, { fillDelayMs = 2_000, databaseUrl, onResolved }: {
  fillDelayMs?: number;
  /** Reuse this database as it is (a restart) instead of creating a fresh one. */
  databaseUrl?: string;
  /** Subscribed before the engine leads, so results redelivered at leadership start are heard. */
  onResolved?: (result: EvaluationResult) => void;
} = {}) {
  const url = new URL(testDatabaseUrl());
  url.pathname = `${url.pathname}_${name}`;
  if (!databaseUrl) {
    await recreateDatabase(url.toString());
    await runMigrations(url.toString());
  }
  const config = loadConfig({
    DATABASE_URL: databaseUrl ?? url.toString(), APP_ORIGIN, SESSION_SECRET: 'x'.repeat(64), ADMIN_API_TOKEN: 'y'.repeat(64),
    RPC_URL: 'http://127.0.0.1:8899', PROGRAM_ID: Keypair.generate().publicKey.toBase58(), TRUST_PROXY_HOPS: '0',
  });
  const { sql, db } = createDb(config.DATABASE_URL);
  const hub = createStreamHub();
  const app = await buildApp({ config, db, sql, hub, modules: new Map(), rpc: fixtureRpc(), logger: false });
  const md = new FixtureMarketData();
  const events: { event: StreamEvent; wallet?: string }[] = [];
  const stop = new AbortController();
  const ctx: ModuleContext = {
    app, log: app.log, env: { SIM_FILL_DELAY_MS: String(fillDelayMs) }, services: { marketdata: md }, signal: stop.signal,
    config, db, sql, rpc: createConnection(config),
    publish(event, audience) {
      events.push({ event, wallet: audience?.wallet });
      hub.publish(event, audience);
    },
    async notify(wallet, n) {
      await db.insert(notifications).values({ wallet, ...n });
    },
  };
  const sim = await register(ctx);
  if (onResolved) sim.onResolved(onResolved);
  for (let i = 0; i < 400 && !sim.engine.leading; i++) await new Promise((r) => setTimeout(r, 10));
  if (!sim.engine.leading) throw new Error('sim engine did not become leader');

  const as = (cookie: string) => ({
    get: (path: string) => app.inject({ method: 'GET', url: path, headers: { cookie } }),
    post: (path: string, payload?: object) => app.inject({ method: 'POST', url: path, payload, headers: { cookie, origin: APP_ORIGIN } }),
    put: (path: string, payload?: object) => app.inject({ method: 'PUT', url: path, payload, headers: { cookie, origin: APP_ORIGIN } }),
    delete: (path: string) => app.inject({ method: 'DELETE', url: path, headers: { cookie, origin: APP_ORIGIN } }),
  });

  return {
    app, db, sql, md, sim, events, databaseUrl: config.DATABASE_URL,
    /** A signed-in wallet with request helpers. */
    async user() {
      const u = await signIn(app);
      return { ...u, ...as(u.cookie) };
    },
    /** Pushes ticks one by one and waits until the engine has processed each. */
    async tick(...ticks: PriceTick[]) {
      for (const t of ticks) {
        md.push(t);
        await sim.engine.settled();
      }
    },
    /** One rules pass, as the leader loop runs every second. */
    async rules() {
      await sim.engine.rulesPass();
      await sim.engine.settled();
    },
    async stop() {
      stop.abort();
      await sim.stopped;
      await app.close();
      await sql.end();
    },
  };
}
export type Sim = Awaited<ReturnType<typeof startSim>>;
