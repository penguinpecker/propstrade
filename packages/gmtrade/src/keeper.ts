// GMTrade keeper API: token metadata + live oracle prices, markets with raw account data, virtual
// inventories and per-owner positions/orders. HTTP for snapshots, graphql-ws for live updates.
import { createClient, type Client } from 'graphql-ws';
import { KEEPER_HTTP, KEEPER_WS, PUBLIC_RPC, STALE_AFTER_MS, STORE } from './constants.ts';
import { graphql } from './graphql.ts';
import { getMultipleAccounts } from './solana.ts';

/** Oracle price in unit price (USD * 10^(20 - decimals)); `ts` in unix seconds. */
export interface KeeperPrice { ts: number; min: string; max: string; isOpen: boolean }

export interface KeeperTokenMeta {
  name: string;
  decimals: number;
  /** Meaningful decimals of the USD price. */
  precision: number;
  isEnabled: boolean;
  isSynthetic: boolean;
  category: string | null;
  indexName: string | null;
  uiSymbol: string | null;
  uiName: string | null;
  launchTime: number | null;
  expectedProvider: string;
}

export interface KeeperToken { pubkey: string; price: KeeperPrice | null; meta: KeeperTokenMeta | null }

export interface KeeperMarket {
  marketToken: string;
  /** Market account address. */
  pubkey: string;
  slot: number | null;
  /** Base64 Market account data (discriminator included). */
  data: string | null;
  virtualInventoryForSwaps: string;
  virtualInventoryForPositions: string;
  meta: {
    name: string;
    isPure: boolean;
    isEnabled: boolean;
    indexToken: { pubkey: string };
    longToken: { pubkey: string };
    shortToken: { pubkey: string };
  } | null;
}

export interface KeeperVirtualInventory { pubkey: string; slot: string | null; data: string | null }

export interface KeeperPosition {
  pubkey: string;
  kind: string | null;
  owner: string | null;
  marketToken: string | null;
  collateralToken: string | null;
  increasedAt: number | null;
  sizeInTokens: string | null;
  collateralAmount: string | null;
  size: string | null;
  data: string | null;
}

export interface KeeperOrder {
  pubkey: string;
  marketToken: string | null;
  params: { kind: string; side: string; size: string; acceptablePrice: string; triggerPrice: string } | null;
  data: string | null;
}

const PRICE = 'price { ts min max isOpen }';
const TOKEN_META = 'meta { name decimals precision isEnabled isSynthetic category indexName uiSymbol uiName launchTime expectedProvider }';
const MARKET = `marketToken pubkey slot data virtualInventoryForSwaps virtualInventoryForPositions
  meta { name isPure isEnabled indexToken { pubkey } longToken { pubkey } shortToken { pubkey } }`;
const VI = 'pubkey slot data';

export const fetchTokens = (url = KEEPER_HTTP) =>
  graphql<{ tokens: KeeperToken[] }>(url, `{ tokens(store: "${STORE}") { pubkey ${PRICE} ${TOKEN_META} } }`).then((d) => d.tokens);

export const fetchPrices = (url = KEEPER_HTTP) =>
  graphql<{ tokens: KeeperToken[] }>(url, `{ tokens(store: "${STORE}") { pubkey ${PRICE} } }`).then((d) => d.tokens);

export const fetchMarkets = (url = KEEPER_HTTP) =>
  graphql<{ markets: KeeperMarket[] }>(url, `{ markets(store: "${STORE}") { ${MARKET} } }`, 30_000).then((d) => d.markets);

export const fetchVirtualInventories = (url = KEEPER_HTTP) =>
  graphql<{ virtualInventories: KeeperVirtualInventory[] }>(url, `{ virtualInventories(store: "${STORE}") { ${VI} } }`)
    .then((d) => d.virtualInventories);

/** Live GMTrade positions and pending orders of an owner (a wallet or a program address). */
export async function fetchUser(owner: string, url = KEEPER_HTTP): Promise<{ positions: KeeperPosition[]; orders: KeeperOrder[] }> {
  const d = await graphql<{ user: { positions: KeeperPosition[]; orders: KeeperOrder[] } }>(url, `{ user(store: "${STORE}", owner: "${owner}") {
    positions { pubkey kind owner marketToken collateralToken increasedAt sizeInTokens collateralAmount size data }
    orders { pubkey marketToken params { kind side size acceptablePrice triggerPrice } data } } }`);
  return d.user;
}

/** Keeps the latest price per token and drops ticks older than the last accepted one. */
export class PriceBook {
  readonly #last = new Map<string, KeeperPrice>();

  /** True when `price` is accepted as the token's new latest price. */
  accept(token: string, price: KeeperPrice): boolean {
    const prev = this.#last.get(token);
    if (prev && (price.ts < prev.ts || (price.ts === prev.ts && price.min === prev.min && price.max === prev.max && price.isOpen === prev.isOpen))) {
      return false;
    }
    this.#last.set(token, price);
    return true;
  }
}

export interface AccountData { data: string; slot: number }
export type FeedMode = 'ws' | 'poll';

export interface FeedOptions {
  rpcUrl?: string;
  httpUrl?: string;
  wsUrl?: string;
  log?: { warn(obj: unknown, msg: string): void };
}

/**
 * Live GMTrade state: token metadata and prices, market metadata, and raw Market / VirtualInventory
 * account data (newest slot wins between the keeper stream and a 30 s RPC refresh).
 * Prices stream over WebSocket; when the stream is silent for 20 s the feed polls HTTP every 2 s and
 * restarts the socket (graphql-ws reconnects with exponential backoff).
 */
export class KeeperFeed {
  readonly tokens = new Map<string, KeeperToken>();
  /** By market token. */
  readonly markets = new Map<string, KeeperMarket>();
  /** Raw Market and VirtualInventory accounts by account address. */
  readonly accounts = new Map<string, AccountData>();
  mode: FeedMode = 'poll';
  lastMessageAt = 0;

  readonly #book = new PriceBook();
  readonly #tickListeners = new Set<(token: KeeperToken) => void>();
  readonly #timers: NodeJS.Timeout[] = [];
  readonly #opts: Required<Omit<FeedOptions, 'log'>> & Pick<FeedOptions, 'log'>;
  #client: Client | undefined;
  #stopped = false;

  constructor(opts: FeedOptions = {}) {
    this.#opts = { rpcUrl: PUBLIC_RPC, httpUrl: KEEPER_HTTP, wsUrl: KEEPER_WS, ...opts };
  }

  onTick(fn: (token: KeeperToken) => void): () => void {
    this.#tickListeners.add(fn);
    return () => this.#tickListeners.delete(fn);
  }

  /** Loads the HTTP snapshot, then starts the stream and the refresh timers. */
  async start(): Promise<void> {
    const [tokens, markets, vis] = await Promise.all([
      fetchTokens(this.#opts.httpUrl), fetchMarkets(this.#opts.httpUrl), fetchVirtualInventories(this.#opts.httpUrl),
    ]);
    for (const t of tokens) this.#token(t);
    for (const m of markets) this.#market(m);
    for (const v of vis) this.#virtualInventory(v);
    this.#connect();
    this.#every(1_000, () => this.#watchdog());
    this.#every(2_000, () => (this.mode === 'poll' ? this.#poll() : undefined));
    this.#every(30_000, () => this.refreshAccounts());
    this.#every(600_000, async () => {
      for (const t of await fetchTokens(this.#opts.httpUrl)) this.#token(t);
      for (const m of await fetchMarkets(this.#opts.httpUrl)) this.#market(m);
    });
  }

  stop(): void {
    this.#stopped = true;
    for (const t of this.#timers) clearInterval(t);
    // dispose() rejects with the socket error when a connection attempt is in flight; irrelevant once stopped.
    Promise.resolve(this.#client?.dispose()).catch(() => undefined);
  }

  /** Re-reads every known Market and VirtualInventory account from the RPC. */
  async refreshAccounts(): Promise<void> {
    const keys = [...this.accounts.keys()];
    const { slot, accounts } = await getMultipleAccounts(this.#opts.rpcUrl, keys);
    keys.forEach((k, i) => {
      const data = accounts[i];
      if (data) this.#account(k, data, slot);
    });
  }

  #every(ms: number, fn: () => unknown): void {
    const t = setInterval(async () => {
      try {
        await fn();
      } catch (err) {
        this.#opts.log?.warn({ err }, 'gmtrade feed refresh failed');
      }
    }, ms);
    t.unref();
    this.#timers.push(t);
  }

  #watchdog(): void {
    if (Date.now() - this.lastMessageAt <= STALE_AFTER_MS || this.mode === 'poll') return;
    this.mode = 'poll';
    this.#opts.log?.warn({ silentMs: Date.now() - this.lastMessageAt }, 'gmtrade price stream stale; polling and reconnecting');
    this.#client?.terminate();
  }

  async #poll(): Promise<void> {
    for (const t of await fetchPrices(this.#opts.httpUrl)) this.#token(t);
  }

  #connect(): void {
    this.#client = createClient({
      url: this.#opts.wsUrl,
      webSocketImpl: WebSocket,
      keepAlive: 10_000,
      retryAttempts: Infinity,
      shouldRetry: () => !this.#stopped,
      retryWait: (retries) => new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** retries) * (0.5 + Math.random() / 2))),
    });
    this.#subscribe(`subscription { tokens(store: "${STORE}", withSnapshot: true) { pubkey ${PRICE} } }`, (d) => {
      this.lastMessageAt = Date.now();
      this.mode = 'ws';
      this.#token((d as { tokens: KeeperToken }).tokens);
    });
    this.#subscribe(`subscription { markets(store: "${STORE}", withSnapshot: false) { ${MARKET} } }`, (d) =>
      this.#market((d as { markets: KeeperMarket }).markets));
    this.#subscribe(`subscription { virtualInventories(store: "${STORE}", withSnapshot: false) { ${VI} } }`, (d) =>
      this.#virtualInventory((d as { virtualInventories: KeeperVirtualInventory }).virtualInventories));
  }

  /** Keeps `query` subscribed for the feed's lifetime: graphql-ws only replays subscriptions that are still active. */
  #subscribe(query: string, next: (data: unknown) => void): void {
    const resubscribe = (ms: number) => {
      if (!this.#stopped) setTimeout(() => this.#subscribe(query, next), ms).unref();
    };
    this.#client!.subscribe({ query }, {
      next: (v) => (v.data ? next(v.data) : undefined),
      error: (err) => {
        this.#opts.log?.warn({ err }, 'gmtrade subscription failed; resubscribing');
        resubscribe(5_000);
      },
      complete: () => {
        if (!this.#stopped) this.#opts.log?.warn({ query }, 'gmtrade subscription completed by the keeper; resubscribing');
        resubscribe(1_000);
      },
    });
  }

  #token(t: KeeperToken): void {
    const known = this.tokens.get(t.pubkey);
    const merged: KeeperToken = { pubkey: t.pubkey, price: known?.price ?? null, meta: t.meta ?? known?.meta ?? null };
    const accepted = t.price !== null && this.#book.accept(t.pubkey, t.price);
    if (accepted) merged.price = t.price;
    this.tokens.set(t.pubkey, merged);
    if (accepted) for (const fn of this.#tickListeners) fn(merged);
  }

  #market(m: KeeperMarket): void {
    const known = this.markets.get(m.marketToken);
    this.markets.set(m.marketToken, { ...m, data: null, meta: m.meta ?? known?.meta ?? null });
    if (m.data && m.slot !== null) this.#account(m.pubkey, m.data, m.slot);
  }

  #virtualInventory(v: KeeperVirtualInventory): void {
    if (v.data && v.slot !== null) this.#account(v.pubkey, v.data, Number(v.slot));
  }

  #account(address: string, data: string, slot: number): void {
    const known = this.accounts.get(address);
    if (known && known.slot >= slot) return;
    this.accounts.set(address, { data, slot });
  }
}
