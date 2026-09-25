// Black-swan scenarios for the keeper (ARCHITECTURE.md §4.5, §8): a 30 % gap on the four launch markets breaching 30
// funded accounts in one tick, congestion, a lost leader lock, RPC failures and a lagging node mid-close, GMTrade refusing
// the forced closes of insolvent positions, a closed market, thin SOL floats, a stale or missing price feed, alert
// throttling and the per-tick load of 50 accounts. Each test states the behaviour the keeper should have: the ones that
// failed at 3c53c9d were findings, fixed with them (2026-09-25); the others prove a feared failure cannot happen.
//
// The keeper is the real one (createKeeper, real alerts with a recording Telegram). The chain is a fake that decodes
// every props_vault instruction the keeper sends with the program's IDL and applies it with the program's checks
// (statuses, slot and position accounts, 8 tracked orders, the order address GMTrade derives from order_seq, the owner PDA
// paying for each order), atomically per transaction and on a copy for simulations. Its SOL numbers are the real
// program's on the mainnet GMTrade binary (LiteSVM, props_vault_p.so, mainnet rent): a forced close takes 14,996,440
// lamports from the owner PDA (escrow ATA 1,488,440 + order account 13,208,000 + GMTrade's execution fee 300,000), a float
// too thin fails it with "Transfer: insufficient lamports" (system error 1, no Anchor code), and one that would end under
// the rent floor with InsufficientFundsForRent. Positions are real GMTrade Position images valued by the real model on the
// SOL[USDC-USDC] mainnet snapshot at a shifted price; GMTrade's keepers (executing or cancelling orders, liquidating) are
// scripted per test.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import BN from 'bn.js';
import bs58 from 'bs58';
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  CLOSE_ALL, GMTRADE_PROGRAM_ID, ORDER_DISCRIMINATOR, ORDER_LAYOUT, POSITION_LAYOUT, PROPS_VAULT_IDL, PROPS_VAULT_PROGRAM_ID, gmOrderPda,
  gmPositionPda, marketConfigPda, orderNonce, ownerPda, ownerUsdcAddress, type ConfigAccount,
} from '@props/sdk';
import { model, type ModelInput } from '@props/gmsol-wasm';
import * as schema from '../../../db/schema.ts';
import { chainJobs, evaluations, fundedAccounts, gmOrders as gmOrderRows, gmtradeDeploys, payouts } from '../../../db/schema.ts';
import { encodeAccount, freshDb, offlineClient, sealer } from '../../chain/test/support.ts';
import { createAlerts, type Alerts } from '../alerts.ts';
import { createKeeper } from '../keeper.ts';

const USD = 10n ** 20n;
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const PROGRAM_DATA = PublicKey.findProgramAddressSync([GMTRADE_PROGRAM_ID.toBuffer()], LOADER)[0];
const DEPLOY_SLOT = 100;
const ESCROW_RENT = 1_488_440;
const ORDER_RENT = 13_208_000;
const EXECUTION_FEE = 300_000;
const RENT_FLOOR = 650_240;
const PER_CLOSE = ESCROW_RENT + ORDER_RENT + EXECUTION_FEE;
const OWNER_SOL_MIN = 50_000_000;
const OWNER_SOL_TARGET = 250_000_000;
/** chain/send.ts polls a sent transaction's status once a second until it is confirmed. */
const CONFIRM_POLL_MS = 1_000;
/** Compute units per instruction for the fee each transaction pays: mark, close and sync as measured on the real build (LiteSVM), the rest estimated. */
const CU: Record<string, number> = { markBreached: 3_800, restrict: 3_800, closePosition: 93_000, sync: 8_000, cancelOrder: 60_000, closeCompletedOrder: 60_000, topUpOwner: 5_000, closeFunded: 30_000 };
const VAULT_ERROR = Object.fromEntries(PROPS_VAULT_IDL.errors.map((e) => [e.name, e.code]));
const zero = new BN(0);
const bn = (v: bigint) => new BN(v.toString());

let t: Awaited<ReturnType<typeof freshDb>>;
before(async () => {
  t = await freshDb('keeper_blackswan');
});
after(async () => {
  await t.sql.end();
});

/** The SOL[USDC-USDC] mainnet snapshot with its clocks a day ahead, so accrual is a no-op and valuations are exact. */
function solMarket(): ModelInput {
  const f = JSON.parse(readFileSync(new URL('../../../../../packages/gmsol-wasm/test/fixtures/sol-usdc-usdc.json', import.meta.url), 'utf8'));
  const p = (k: string) => ({ min: BigInt(f.prices[k].min), max: BigInt(f.prices[k].max) });
  const market = Buffer.from(f.market, 'base64');
  for (const at of [4024, 4032, 4040]) market.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 86_400), at);
  return { market: market.toString('base64'), virtualInventories: f.virtualInventories, prices: { index: p('index'), long: p('long'), short: p('short') } };
}
const sol = solMarket();
/** The snapshot with its index price moved by `pct` percent. */
function priced(pct: number): ModelInput {
  const s = (v: bigint) => (v * BigInt(Math.round((100 + pct) * 1000))) / 100_000n;
  return { ...sol, prices: { ...sol.prices, index: { min: s(sol.prices.index.min), max: s(sol.prices.index.max) } } };
}

type Status = 'active' | 'restricted' | 'payoutPending' | 'breached' | 'closed';
type OrderType = 'market' | 'limit' | 'close' | 'takeProfit' | 'stopLoss';
type Freshness = 'live' | 'delayed' | 'stale' | 'unavailable';
interface Slot { marketToken: string; isLong: boolean; gmPosition: string; sizeUsd: bigint; collateral: bigint; pendingUsd: bigint }
interface Tracked { order: string; slot: number; type: OrderType; sizeUsd: bigint; placedByRisk: boolean }
interface Account {
  key: string; trader: string; evaluation: string; status: Status;
  /** The program's 8 slots; null = free. */
  slots: (Slot | null)[];
  orders: Tracked[]; orderSeq: bigint; usdc: bigint; lamports: number;
}
/** A pending GMTrade Order account (GMTrade closes the account once it executes or cancels the order). */
interface GmOrder { funded: string; slot: number; placedAt: number }
/** What props_vault instructions change: copied for simulations and lagging reads, replaced when a transaction lands. */
interface State { accounts: Map<string, Account>; orders: Map<string, GmOrder> }
/** One of the launch markets, priced off the SOL snapshot (the model does not check the Position's market token). */
interface Market {
  symbol: string; token: PublicKey; config: string; category: string; sessionRestricted: boolean;
  /** Price move applied to valuations and to GMTrade's executions, percent. */
  movePct: number;
  /** marketdata's session. */
  open: boolean;
  /** GMTrade's own Closed flag: it refuses to create decrease orders while set. */
  gmClosed: boolean;
  freshness: Freshness;
  /** marketdata.marketState() throws (no Market account in the feed, e.g. after a restart during a GMTrade outage). */
  stateUnavailable: boolean;
}
interface Position { key: string; funded: string; market: Market; isLong: boolean; image: Buffer; sizeUsd: bigint; collateral: bigint }
interface Ix { index: number; name: string; args: Record<string, unknown>; accounts: Map<string, string>; remaining: string[] }

/** The chain refuses a transaction: the simulation or execution error Solana reports. */
class Refused extends Error {
  constructor(readonly err: unknown, readonly logs: string[]) {
    super(JSON.stringify(err));
  }
}
const vaultError = (index: number, name: string) => new Refused(
  { InstructionError: [index, { Custom: VAULT_ERROR[name] }] },
  [`Program log: AnchorError occurred. Error Code: ${name}. Error Number: ${VAULT_ERROR[name]}. Error Message: ${name}.`],
);
/** GMTrade's own errors (gmsol_store IDL): FeatureDisabled 6005, MarketClosed 6127; Anchor's ConstraintSeeds 2006. */
const gmtradeError = (index: number, name: string, code: number) => new Refused(
  { InstructionError: [index, { Custom: code }] },
  [`Program log: AnchorError occurred. Error Code: ${name}. Error Number: ${code}. Error Message: ${name}.`],
);

function blackSwanChain() {
  const client = offlineClient();
  const markets: Market[] = ['SOL', 'BTC', 'ETH', 'XAU'].map((symbol) => {
    const token = Keypair.generate().publicKey;
    return {
      symbol, token, config: marketConfigPda(token).toBase58(), category: symbol === 'XAU' ? 'Commodities' : 'Crypto', sessionRestricted: false,
      movePct: 0, open: true, gmClosed: false, freshness: 'live' as Freshness, stateUnavailable: false,
    };
  });
  const byToken = new Map(markets.map((m) => [m.token.toBase58(), m]));
  const byConfig = new Map(markets.map((m) => [m.config, m]));
  let state: State = { accounts: new Map(), orders: new Map() };
  const positions = new Map<string, Position>();
  const ownerOf = new Map<string, string>();
  const usdcOf = new Map<string, string>();
  const venue = {
    /** GMTrade's keepers act on an order this long after it was placed (measured 2-8 s; Infinity: not within the test). */
    latencyMs: Infinity,
    /** An order GMTrade cannot execute (a user decrease of an insolvent position) is cancelled, else left pending. */
    cancelsRefused: true,
    /** GMTrade liquidates every liquidatable position at the next read. */
    liquidates: false,
    /** create_order_v2 refuses decreases (FEATURE_KEEPER). */
    decreasesDisabled: false,
    /** Config.paused.trading. */
    tradingPaused: false,
  };
  const rpcScript = {
    latencyMs: 0,
    /** The next getSignatureStatuses calls that throw (a transient RPC error after the transaction landed). */
    statusThrows: 0,
    /** Sent transactions land at once; false: they never do (congestion, a priority fee too low). */
    landing: true,
    /** Status polls a blockhash stays valid for (mainnet: 150 blocks ≈ 60 s ≈ 60 polls). */
    blockhashLifetime: 3,
    /** After a transaction lands, this many account reads are served from before it (a lagging RPC node). */
    lagReads: 0,
  };
  const calls: Record<string, number> = {};
  const sends: { at: number; signature: string; names: string[]; funded: string[]; landed: boolean; err: unknown; feeLamports: number }[] = [];
  const closes: { funded: string; slot: number; at: number }[] = [];
  const statuses = new Map<string, { err: unknown }>();
  /** Transactions the simulation refused (nothing sent). */
  const refusals: { funded: string[]; err: unknown }[] = [];
  let reads = 0;
  let height = 1;
  let lagging: State | null = null;
  let lagLeft = 0;

  const pk = (k: string) => new PublicKey(k);
  const count = (m: string) => void (calls[m] = (calls[m] ?? 0) + 1);
  const system = (lamports: number) => (lamports > 0 ? { data: Buffer.alloc(0), owner: SystemProgram.programId, lamports, executable: false, rentEpoch: 0 } : null);
  const usdcInfo = (amount: bigint) => {
    const data = Buffer.alloc(165);
    USDC.toBuffer().copy(data, 0);
    data.writeBigUInt64LE(amount, 64);
    return { data, owner: TOKEN_PROGRAM, lamports: 2_039_280, executable: false, rentEpoch: 0 };
  };
  const orderInfo = () => {
    const data = Buffer.alloc(2_200);
    Buffer.from(ORDER_DISCRIMINATOR).copy(data);
    data[ORDER_LAYOUT.actionState] = 0;
    return { data, owner: GMTRADE_PROGRAM_ID, lamports: ORDER_RENT, executable: false, rentEpoch: 0 };
  };
  const FREE_SLOT = { marketToken: PublicKey.default, gmPosition: PublicKey.default, isLong: false, collateral: zero, sizeUsd: zero, pendingUsd: zero, lastSync: zero };
  const FREE_ORDER = { order: PublicKey.default, slot: 0, orderType: { market: {} }, sizeUsd: zero, collateral: zero, placedByRisk: false };
  const encode = (a: Account) => ({
    data: encodeAccount(client, 'fundedAccount', {
      trader: pk(a.trader), evaluation: pk(a.evaluation),
      terms: { sizeUsd: new BN(10_000_000_000), profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000, termsHash: Array(32).fill(1), tierVersion: 1 },
      principal: new BN(500_000_000), status: { [a.status]: {} },
      slots: a.slots.map((s) => (s
        ? { marketToken: pk(s.marketToken), gmPosition: pk(s.gmPosition), isLong: s.isLong, collateral: bn(s.collateral), sizeUsd: bn(s.sizeUsd), pendingUsd: bn(s.pendingUsd), lastSync: zero }
        : FREE_SLOT)),
      orders: [
        ...a.orders.map((o) => ({ order: pk(o.order), slot: o.slot, orderType: { [o.type]: {} }, sizeUsd: bn(o.sizeUsd), collateral: zero, placedByRisk: o.placedByRisk })),
        ...Array(8 - a.orders.length).fill(FREE_ORDER),
      ],
      orderSeq: bn(a.orderSeq), payoutsPaid: zero, payoutSeq: 0, createdAt: zero, lastSyncAt: zero, bump: 255, ownerBump: 255,
    }),
    owner: PROPS_VAULT_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0,
  });
  function infoOf(key: string, s: State) {
    const account = s.accounts.get(key);
    if (account) return encode(account);
    const byUsdc = usdcOf.get(key);
    if (byUsdc) return s.accounts.get(byUsdc)!.status === 'closed' ? null : usdcInfo(s.accounts.get(byUsdc)!.usdc);
    const byOwner = ownerOf.get(key);
    if (byOwner) return system(s.accounts.get(byOwner)!.lamports);
    const p = positions.get(key);
    if (p) return { data: p.image, owner: GMTRADE_PROGRAM_ID, lamports: 5_623_680, executable: false, rentEpoch: 0 };
    return s.orders.has(key) ? orderInfo() : null;
  }

  const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  /** The props_vault instructions of a transaction (decoded with the program's IDL) and its compute budget. */
  function decode(tx: VersionedTransaction) {
    const keys = tx.message.staticAccountKeys;
    const ixs: Ix[] = [];
    let units = 200_000;
    let microLamports = 0;
    for (const [index, ix] of tx.message.compiledInstructions.entries()) {
      const program = keys[ix.programIdIndex]!;
      const data = Buffer.from(ix.data);
      if (program.equals(COMPUTE_BUDGET)) {
        if (data[0] === 2) units = data.readUInt32LE(1);
        if (data[0] === 3) microLamports = Number(data.readBigUInt64LE(1));
        continue;
      }
      assert.ok(program.equals(PROPS_VAULT_PROGRAM_ID), `unexpected program ${program.toBase58()}`);
      const coder = client.program.coder.instruction as unknown as { decode(data: Buffer): { name: string; data: Record<string, unknown> } | null };
      const decoded = coder.decode(data);
      assert.ok(decoded, 'unknown props_vault instruction');
      const idl = client.program.idl.instructions.find((i) => i.name === decoded.name || camel(i.name) === decoded.name)!;
      const accountKeys = ix.accountKeyIndexes.map((i) => keys[i]!.toBase58());
      ixs.push({ index, name: camel(idl.name), args: decoded.data, accounts: new Map(idl.accounts.map((a, i) => [camel(a.name), accountKeys[i]!])), remaining: accountKeys.slice(idl.accounts.length) });
    }
    return { ixs, units, microLamports };
  }

  /** The owner PDA pays: a system transfer, refused as the runtime does when it lacks the lamports. */
  function pay(a: Account, lamports: number, index: number) {
    if (a.lamports < lamports) {
      throw new Refused({ InstructionError: [index, { Custom: 1 }] }, [`Transfer: insufficient lamports ${a.lamports}, need ${lamports}`, 'Program 11111111111111111111111111111111 failed: custom program error: 0x1']);
    }
    a.lamports -= lamports;
  }

  /** Applies a transaction's props_vault instructions to `s` with the program's (and GMTrade's) checks; throws Refused. */
  function execute(s: State, ixs: Ix[]) {
    const touched = new Set<Account>();
    for (const ix of ixs) {
      const funded = ix.accounts.get('funded')!;
      const a = s.accounts.get(funded);
      if (!a) throw new Refused({ InstructionError: [ix.index, { Custom: 3012 }] }, ['Program log: AnchorError occurred. Error Code: AccountNotInitialized.']);
      touched.add(a);
      switch (ix.name) {
        case 'markBreached':
          if (a.status !== 'active' && a.status !== 'restricted') throw vaultError(ix.index, 'InvalidAccountStatus');
          a.status = 'breached';
          break;
        case 'restrict': {
          const restricted = ix.args.restricted as boolean;
          if (a.status !== (restricted ? 'active' : 'restricted')) throw vaultError(ix.index, 'InvalidAccountStatus');
          a.status = restricted ? 'restricted' : 'active';
          break;
        }
        case 'topUpOwner':
          if (venue.tradingPaused) throw vaultError(ix.index, 'Paused');
          if (a.status !== 'active') throw vaultError(ix.index, 'InvalidAccountStatus');
          if (a.lamports >= OWNER_SOL_MIN) throw vaultError(ix.index, 'OwnerFloatSufficient');
          a.lamports = OWNER_SOL_TARGET;
          break;
        case 'closePosition': {
          const { isLong } = ix.args.args as { isLong: boolean };
          if (a.status === 'closed') throw vaultError(ix.index, 'InvalidAccountStatus');
          const market = byConfig.get(ix.accounts.get('marketConfig')!)!;
          const slot = a.slots.findIndex((x) => x?.marketToken === market.token.toBase58() && x.isLong === isLong);
          if (slot < 0) throw vaultError(ix.index, 'NoPosition');
          if (ix.accounts.get('gmPosition') !== a.slots[slot]!.gmPosition) throw vaultError(ix.index, 'InvalidPositionAccount');
          if (a.orders.length >= 8) throw vaultError(ix.index, 'TooManyOrders');
          pay(a, ESCROW_RENT, ix.index); // props_vault creates the order's USDC escrow, paid by the owner PDA
          if (venue.decreasesDisabled) throw gmtradeError(ix.index, 'FeatureDisabled', 6005);
          if (market.gmClosed) throw gmtradeError(ix.index, 'MarketClosed', 6127);
          // GMTrade derives the order address from the nonce props_vault passes: the account's order_seq now.
          const order = gmOrderPda(ownerPda(pk(funded)), orderNonce(a.orderSeq)).toBase58();
          if (ix.accounts.get('gmOrder') !== order) throw gmtradeError(ix.index, 'ConstraintSeeds', 2006);
          pay(a, ORDER_RENT, ix.index);
          pay(a, EXECUTION_FEE, ix.index);
          a.orders.push({ order, slot, type: 'close', sizeUsd: CLOSE_ALL, placedByRisk: ix.accounts.get('authority') !== a.trader });
          a.orderSeq++;
          s.orders.set(order, { funded, slot, placedAt: Date.now() });
          break;
        }
        case 'cancelOrder': {
          const order = ix.accounts.get('gmOrder')!;
          const i = a.orders.findIndex((o) => o.order === order);
          if (i < 0) throw vaultError(ix.index, 'OrderNotTracked');
          if (!s.orders.has(order)) throw vaultError(ix.index, 'OrderNotPending');
          a.orders.splice(i, 1);
          s.orders.delete(order);
          a.lamports += ORDER_RENT + ESCROW_RENT + EXECUTION_FEE;
          break;
        }
        case 'sync':
          a.orders = a.orders.filter((o) => s.orders.has(o.order));
          a.slots = a.slots.map((x, i) => {
            if (!x) return null;
            const p = positions.get(x.gmPosition)!;
            const synced = { ...x, sizeUsd: p.sizeUsd, collateral: p.collateral };
            return synced.sizeUsd > 0n || synced.pendingUsd > 0n || a.orders.some((o) => o.slot === i) ? synced : null;
          });
          break;
        case 'closeFunded':
          if (!['active', 'restricted', 'breached'].includes(a.status)) throw vaultError(ix.index, 'InvalidAccountStatus');
          if (a.slots.some(Boolean) || a.orders.length) throw vaultError(ix.index, 'NotFlat');
          for (const k of ix.remaining) if ((positions.get(k)?.sizeUsd ?? 1n) !== 0n) throw vaultError(ix.index, 'NotFlat');
          a.status = 'closed';
          a.usdc = 0n;
          a.lamports = 0;
          break;
        default:
          throw new Error(`the fake chain does not apply ${ix.name}`);
      }
    }
    for (const a of touched) {
      if (a.lamports > 0 && a.lamports < RENT_FLOOR) throw new Refused({ InsufficientFundsForRent: { account_index: 5 } }, []);
    }
  }

  const empty = (p: Position) => {
    p.sizeUsd = 0n;
    p.collateral = 0n;
    for (const at of [POSITION_LAYOUT.sizeInUsd, POSITION_LAYOUT.collateralAmount, POSITION_LAYOUT.sizeInTokens]) p.image.fill(0, at, at + 16);
  };
  /** GMTrade closes a finished order: the rent back to the owner PDA, the execution fee to its keeper. */
  const finish = (a: Account, order: string) => {
    state.orders.delete(order);
    a.lamports += ORDER_RENT + ESCROW_RENT;
  };
  /** What GMTrade's keepers do between two reads: execute or cancel orders, liquidate. */
  function advanceVenue() {
    reads++;
    for (const [address, o] of [...state.orders]) {
      if (Date.now() - o.placedAt < venue.latencyMs) continue;
      const a = state.accounts.get(o.funded)!;
      const slot = a.slots[o.slot];
      const p = slot ? positions.get(slot.gmPosition) : undefined;
      if (!p || p.sizeUsd === 0n) {
        finish(a, address); // nothing left to decrease
        continue;
      }
      let output: bigint;
      try {
        output = model.simulateDecrease({ market: priced(p.market.movePct), position: p.image.toString('base64'), sizeDeltaUsd: p.sizeUsd }).outputAmount;
      } catch {
        if (venue.cancelsRefused) finish(a, address); // insufficient funds to pay for costs: only a liquidation can close it
        continue;
      }
      a.usdc += output;
      empty(p);
      finish(a, address);
    }
    if (!venue.liquidates) return;
    for (const p of positions.values()) {
      if (p.sizeUsd === 0n || !model.positionStatus(priced(p.market.movePct), p.image.toString('base64')).liquidatable) continue;
      state.accounts.get(p.funded)!.usdc += model.simulateDecrease({ market: priced(p.market.movePct), position: p.image.toString('base64'), sizeDeltaUsd: p.sizeUsd, liquidation: true }).outputAmount;
      empty(p);
    }
  }

  const wait = () => (rpcScript.latencyMs ? sleep(rpcScript.latencyMs) : undefined);
  const rpc = {
    async getMultipleAccountsInfoAndContext(keys: PublicKey[]) {
      count('getMultipleAccountsInfoAndContext');
      await wait();
      advanceVenue();
      let view = state;
      if (lagging && lagLeft > 0) {
        lagLeft--;
        view = lagging;
      }
      return { context: { slot: reads }, value: keys.map((k) => infoOf(k.toBase58(), view)) };
    },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      count('getMultipleAccountsInfo');
      await wait();
      return keys.map((k) => infoOf(k.toBase58(), state));
    },
    async getAccountInfo(key: PublicKey) {
      count('getAccountInfo');
      await wait();
      if (!key.equals(PROGRAM_DATA)) return infoOf(key.toBase58(), state);
      const data = Buffer.alloc(12);
      data.writeUInt32LE(3, 0);
      data.writeBigUInt64LE(BigInt(DEPLOY_SLOT), 4);
      return { data, owner: LOADER, lamports: 1, executable: false, rentEpoch: 0 };
    },
    async getSignaturesForAddress() {
      count('getSignaturesForAddress');
      return [];
    },
    async getLatestBlockhash() {
      count('getLatestBlockhash');
      await wait();
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: height + rpcScript.blockhashLifetime };
    },
    async simulateTransaction(tx: VersionedTransaction) {
      count('simulateTransaction');
      await wait();
      const { ixs } = decode(tx);
      try {
        execute(structuredClone(state), ixs);
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        refusals.push({ funded: uniq(ixs.map((i) => i.accounts.get('funded')!)), err: err.err });
        return { context: { slot: reads }, value: { err: err.err, logs: err.logs, unitsConsumed: 20_000 } };
      }
      return { context: { slot: reads }, value: { err: null, logs: [], unitsConsumed: ixs.reduce((s, i) => s + (CU[i.name] ?? 50_000), 0) } };
    },
    async sendRawTransaction(raw: Uint8Array) {
      count('sendRawTransaction');
      await wait();
      const tx = VersionedTransaction.deserialize(raw);
      const signature = bs58.encode(tx.signatures[0]!);
      const { ixs, units, microLamports } = decode(tx);
      const record = {
        at: Date.now(), signature, names: ixs.map((i) => i.name), funded: [...new Set(ixs.map((i) => i.accounts.get('funded')!))], landed: false, err: null as unknown,
        feeLamports: 5_000 + Math.ceil((units * microLamports) / 1e6),
      };
      sends.push(record);
      if (!rpcScript.landing || statuses.has(signature)) return signature;
      const next = structuredClone(state);
      try {
        execute(next, ixs);
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        record.err = err.err; // failed onchain (the fee is paid all the same)
        statuses.set(signature, { err: err.err });
        return signature;
      }
      if (rpcScript.lagReads) {
        lagging = state;
        lagLeft = rpcScript.lagReads;
      }
      state = next;
      record.landed = true;
      statuses.set(signature, { err: null });
      for (const ix of ixs.filter((i) => i.name === 'closePosition')) {
        const funded = ix.accounts.get('funded')!;
        const order = ix.accounts.get('gmOrder')!;
        const slot = state.accounts.get(funded)!.orders.find((o) => o.order === order)!.slot;
        closes.push({ funded, slot, at: Date.now() });
        const market = byConfig.get(ix.accounts.get('marketConfig')!)!;
        // As the chain module's projector records every OrderRequested (the keeper's churn check reads these rows).
        await t.db.insert(gmOrderRows).values({
          address: order, fundedAccount: funded, marketToken: market.token.toBase58(), symbol: market.symbol, side: (ix.args.args as { isLong: boolean }).isLong ? 'Long' : 'Short',
          kind: 'Market', isIncrease: false, sizeUsd: '2500', status: 'awaiting_execution', createSignature: signature, createdAt: new Date(),
        }).onConflictDoNothing();
      }
      return signature;
    },
    async getSignatureStatuses([signature]: string[]) {
      count('getSignatureStatuses');
      await wait();
      if (rpcScript.statusThrows > 0) {
        rpcScript.statusThrows--;
        throw new Error('fetch failed');
      }
      height++;
      const s = statuses.get(signature!);
      return { context: { slot: reads }, value: [s ? { slot: reads, confirmations: 1, err: s.err, confirmationStatus: 'confirmed' } : null] };
    },
    async getBlockHeight() {
      count('getBlockHeight');
      return height;
    },
  };

  client.fetchConfig = async () => (count('getAccountInfo'), { ownerSolMin: new BN(OWNER_SOL_MIN), paused: { payouts: false, trading: venue.tradingPaused, newEvaluations: false } }) as unknown as ConfigAccount;
  client.fetch = (async (name: string, address: PublicKey) => {
    count('getAccountInfo');
    const m = name === 'marketConfig' ? byConfig.get(address.toBase58()) : undefined;
    return m ? { sessionRestricted: m.sessionRestricted, closedMaxLeverageBps: 80_000, enabled: true } : null;
  }) as typeof client.fetch;
  client.fetchOwnerPositions = async (funded: PublicKey, o: { open?: boolean } = {}) =>
    [...positions.values()].filter((p) => p.funded === funded.toBase58() && (!o.open || p.sizeUsd > 0n)).map((p) => pk(p.key));

  const reader = {
    evaluation: async () => {
      throw new Error('unused');
    },
    market: async (token: string) => {
      const m = byToken.get(token);
      if (!m) throw new Error(`unknown market ${token}`);
      return { marketToken: token, symbol: m.symbol, indexToken: 'So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH', decimals: 9 };
    },
  };
  const marketdata = {
    market: (symbol: string) => {
      const m = markets.find((x) => x.symbol === symbol);
      return m && { symbol, category: m.category, session: m.open ? 'open' : 'closed', freshness: m.freshness, updatedAt: Date.now() - (m.freshness === 'stale' ? 300_000 : 500) };
    },
    marketState: async (token: string) => {
      const m = byToken.get(token)!;
      if (m.stateUnavailable) throw new Error(`no onchain state for market ${token}`);
      const input = priced(m.movePct);
      return { symbol: m.symbol, marketToken: token, raw: { market: input.market, virtualInventories: input.virtualInventories }, prices: input.prices, indexDecimals: 9, fetchedAt: Date.now() };
    },
  };

  /** A funded account with real GMTrade positions (Position images from the model) at the snapshot price. */
  async function addAccount(p: { status?: Status; usdc?: bigint; lamports?: number; slots: { symbol: string; isLong?: boolean; sizeUsd: bigint; collateral: bigint }[] }) {
    const key = Keypair.generate().publicKey;
    const trader = Keypair.generate().publicKey;
    const evaluation = Keypair.generate().publicKey;
    const owner = ownerPda(key);
    ownerOf.set(owner.toBase58(), key.toBase58());
    usdcOf.set(ownerUsdcAddress(key).toBase58(), key.toBase58());
    const slots: (Slot | null)[] = Array(8).fill(null);
    p.slots.forEach((s, i) => {
      const market = markets.find((m) => m.symbol === s.symbol)!;
      const isLong = s.isLong ?? true;
      const open = model.simulateIncrease({ market: sol, isLong, collateralToken: USDC.toBase58(), collateralAmount: s.collateral, sizeDeltaUsd: s.sizeUsd });
      const image = Buffer.from(open.position.account, 'base64');
      owner.toBuffer().copy(image, POSITION_LAYOUT.owner);
      market.token.toBuffer().copy(image, POSITION_LAYOUT.marketToken);
      const gmPosition = gmPositionPda(owner, market.token, isLong).toBase58();
      positions.set(gmPosition, { key: gmPosition, funded: key.toBase58(), market, isLong, image, sizeUsd: open.position.sizeInUsd, collateral: open.position.collateralAmount });
      slots[i] = { marketToken: market.token.toBase58(), isLong, gmPosition, sizeUsd: open.position.sizeInUsd, collateral: open.position.collateralAmount, pendingUsd: 0n };
    });
    const account: Account = {
      key: key.toBase58(), trader: trader.toBase58(), evaluation: evaluation.toBase58(), status: p.status ?? 'active', slots, orders: [], orderSeq: 1n,
      usdc: p.usdc ?? 0n, lamports: p.lamports ?? OWNER_SOL_TARGET,
    };
    state.accounts.set(account.key, account);
    await t.db.insert(evaluations).values({
      address: account.evaluation, trader: account.trader, evalIndex: 0, tierId: 1, sizeUsd: '10000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000,
      traderShareBps: 8000, termsHash: 'ab'.repeat(32), feePaid: '79', status: 'funded', purchaseSignature: `p${account.key}`, createdAt: new Date(), updatedSlot: 1,
    });
    await t.db.insert(fundedAccounts).values({
      address: account.key, evaluation: account.evaluation, trader: account.trader, ownerPda: owner.toBase58(), principal: '500', traderShareBps: 8000,
      status: account.status === 'payoutPending' ? 'payout_pending' : account.status, activationSignature: `a${account.key}`, createdAt: new Date(), updatedSlot: 2,
    });
    return account.key;
  }

  /** Empty GMTrade Positions of an owner PDA that no slot uses (every cancelled or unfilled increase leaves one). */
  function addEmptyPositions(funded: string, n: number) {
    const [any] = [...positions.values()];
    for (let i = 0; i < n; i++) {
      const key = Keypair.generate().publicKey.toBase58();
      positions.set(key, { key, funded, market: markets[0]!, isLong: true, image: Buffer.from(any!.image), sizeUsd: 0n, collateral: 0n });
      empty(positions.get(key)!);
    }
  }

  const raised: { key: string; level: string; text: string }[] = [];
  const warnings: string[] = [];
  /** The real keeper with the real alerts (Telegram recorded); `run(n)` runs n ticks back to back. */
  function keeper(o: { now?: () => number; db?: typeof t.db } = {}) {
    let tickEnded = () => {};
    const alertLog = (level: string) => (obj: unknown, text?: string) => {
      const key = (obj as { alert?: string } | undefined)?.alert;
      if (key) raised.push({ key, level, text: text ?? '' });
    };
    const real = createAlerts({
      env: { TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_CHAT_ID: 'chat' }, log: { info: alertLog('info'), warn: alertLog('warning'), error: alertLog('critical') },
      fetch: (async () => new Response('{"ok":true}')) as typeof fetch,
    });
    const alerts: Alerts = {
      send(key, level, text, repeatMs) {
        real.send(key, level, text, repeatMs);
        if (key === 'tick') tickEnded();
      },
      heartbeat() {
        real.heartbeat();
        tickEnded();
      },
    };
    const k = createKeeper({
      db: o.db ?? t.db, rpc: rpc as never, client, reader, marketdata: marketdata as never, risk: Keypair.generate(), sealer, reviewedDeploySlot: DEPLOY_SLOT,
      log: { info() {}, warn: (_o: unknown, msg?: string) => void warnings.push(String(msg)), error: (_o: unknown, msg?: string) => void warnings.push(String(msg)) },
      notify: async () => {}, alerts, now: o.now,
    });
    return {
      status: k.status,
      /** Runs `ticks` ticks back to back, or until leadership is lost; each tick's duration, ms. */
      async run(ticks: number, held: () => Promise<boolean> = async () => true) {
        const stop = new AbortController();
        const durations: number[] = [];
        let from = Date.now();
        tickEnded = () => {
          durations.push(Date.now() - from);
          from = Date.now();
          if (durations.length >= ticks) stop.abort();
        };
        await k.run(stop.signal, held, 20);
        return durations;
      },
    };
  }

  async function reset() {
    await t.db.delete(gmOrderRows);
    await t.db.delete(chainJobs);
    await t.db.delete(payouts);
    await t.db.delete(fundedAccounts);
    await t.db.delete(evaluations);
    await t.db.delete(gmtradeDeploys);
    state = { accounts: new Map(), orders: new Map() };
    for (const m of [positions, ownerOf, usdcOf, statuses]) m.clear();
    for (const l of [sends, closes, raised, warnings, refusals]) l.length = 0;
    for (const k of Object.keys(calls)) delete calls[k];
    Object.assign(venue, { latencyMs: Infinity, cancelsRefused: true, liquidates: false, decreasesDisabled: false, tradingPaused: false });
    Object.assign(rpcScript, { latencyMs: 0, statusThrows: 0, landing: true, blockhashLifetime: 3, lagReads: 0 });
    for (const m of markets) Object.assign(m, { category: m.symbol === 'XAU' ? 'Commodities' : 'Crypto', sessionRestricted: false, movePct: 0, open: true, gmClosed: false, freshness: 'live', stateUnavailable: false });
    lagging = null;
    lagLeft = 0;
  }

  return {
    rpc, markets, venue, rpcScript, calls, sends, closes, refusals, raised, warnings, positions, addAccount, addEmptyPositions, keeper, reset,
    resetCounts: () => Object.keys(calls).forEach((k) => delete calls[k]),
    account: (key: string) => state.accounts.get(key)!,
    /** GMTrade orders of an account that still exist (pending). */
    pendingOrders: (funded: string) => [...state.orders.values()].filter((o) => o.funded === funded).length,
    market: (symbol: string) => markets.find((m) => m.symbol === symbol)!,
    gap: (pct: number) => markets.forEach((m) => void (m.movePct = pct)),
    /** A plain SystemProgram transfer to an owner PDA (the runbook's fix for a float too thin for a forced close). */
    transferToOwner: (funded: string, lamports: number) => void (state.accounts.get(funded)!.lamports += lamports),
  };
}

let c: ReturnType<typeof blackSwanChain>;
before(() => {
  c = blackSwanChain();
});

/** $2,500 at 20x in each of the four launch markets: the whole $500 allowance posted as collateral, no USDC left. */
const allIn = { slots: ['SOL', 'BTC', 'ETH', 'XAU'].map((symbol) => ({ symbol, sizeUsd: 2_500n * USD, collateral: 125_000_000n })), usdc: 0n };
const oneSol = { slots: [{ symbol: 'SOL', sizeUsd: 10_000n * USD, collateral: 500_000_000n }], usdc: 0n };
const uniq = <T>(list: T[]) => [...new Set(list)];
const landed = () => c.sends.filter((s) => s.landed);
const alertsFor = (key: string) => c.raised.filter((a) => a.key === key);
/** A step's failure alerts: keyed failed:<funded>:<step>:<cause>. */
const failuresOf = (funded: string, step: string) => c.raised.filter((a) => a.key.startsWith(`failed:${funded}:${step}:`));

// ---------- 1. a 20-40 % move in one tick, 30 accounts breaching together ----------

test('1a: a -30 % gap on SOL, BTC, ETH and XAU breaches 30 all-in accounts in one tick: each is marked breached in a transaction of its own, the accounts are worked on eight at a time, no forced close is placed for a position worth nothing (only GMTrade\'s liquidation closes one), and once GMTrade liquidates them every account is closed', async () => {
  await c.reset();
  const accounts: string[] = [];
  for (let i = 0; i < 30; i++) accounts.push(await c.addAccount(allIn));
  const k = c.keeper();
  await k.run(1);
  assert.equal(c.sends.length, 0, 'healthy accounts need nothing');

  c.gap(-30);
  // GMTrade's model: every position is worth nothing and liquidatable, and a user close of it is refused.
  const p = [...c.positions.values()][0]!;
  const status = model.positionStatus(priced(-30), p.image.toString('base64'));
  assert.deepEqual([status.netValue, status.liquidatable], [0n, true]);
  assert.throws(() => model.simulateDecrease({ market: priced(-30), position: p.image.toString('base64'), sizeDeltaUsd: p.sizeUsd }), /insufficient funds to pay for costs/);

  const started = Date.now();
  const [tick] = await k.run(1);
  const txs = landed();
  const firstTx = new Map<string, number>();
  for (const s of txs) if (!firstTx.has(s.funded[0]!)) firstTx.set(s.funded[0]!, s.at - started);
  const markedAfter = [...firstTx.values()];
  console.log(JSON.stringify({
    accounts: 30, positions: 120, tickSeconds: Math.round(tick! / 1000), transactions: txs.length,
    transactionShapes: uniq(txs.map((s) => s.names.join('+'))), forcedCloses: c.closes.length, feeLamportsPerTransaction: uniq(txs.map((s) => s.feeLamports)),
    firstAccountMarkedAfterMs: Math.min(...markedAfter), lastAccountMarkedAfterMs: Math.max(...markedAfter), rpcCalls: c.calls,
  }));
  assert.deepEqual(uniq(accounts.map((a) => c.account(a).status)), ['breached'], 'every account is marked breached');
  assert.deepEqual(uniq(txs.map((s) => s.names.join('+'))), ['markBreached'], 'each mark goes out alone, one transaction per account');
  assert.equal(c.closes.length, 0, 'no user decrease for a position GMTrade values at nothing: it would be refused and cancelled at an execution fee');
  assert.ok(Math.max(...markedAfter) <= 10_000, `the last of 30 breached accounts was marked ${Math.round(Math.max(...markedAfter) / 1000)} s into the tick`);

  // GMTrade liquidates every position (for 0 at -30 %): the keeper syncs each account flat and closes it.
  c.venue.liquidates = true;
  await k.run(2);
  assert.deepEqual(uniq(accounts.map((a) => c.account(a).status)), ['closed']);
  assert.equal(c.closes.length, 0);
});

test('1b: congestion: accounts whose transactions do not land wait side by side, not one blockhash lifetime after another; the keeper raises one alert for it, and each re-plan pays a higher priority fee', async () => {
  await c.reset();
  const accounts: string[] = [];
  for (let i = 0; i < 6; i++) accounts.push(await c.addAccount(oneSol));
  c.gap(-30);
  c.rpcScript.landing = false;
  c.rpcScript.blockhashLifetime = 3; // polls; mainnet: 150 blocks ≈ 60 s
  const started = Date.now();
  const k = c.keeper();
  const [tick] = await k.run(1);
  const firstSend = accounts.map((a) => c.sends.find((s) => s.funded.includes(a))!.at - started);
  const firstRound = c.sends.length;
  const fees = (from: number, to = c.sends.length) => uniq(c.sends.slice(from, to).map((s) => s.feeLamports - 5_000));
  console.log(JSON.stringify({ accounts: 6, tickSeconds: Math.round(tick! / 1000), firstSendAfterMs: firstSend, sendAttempts: c.sends.length, distinctTransactions: uniq(c.sends.map((s) => s.signature)).length, alerts: c.raised.map((a) => a.key), priorityFeeLamports: fees(0) }));
  assert.equal(c.raised.filter((a) => a.key === 'landing').length, 1, 'one alert for the keeper, not one per account');
  assert.equal(c.raised.filter((a) => a.key.startsWith('failed:')).length, 0);
  const lifetime = c.rpcScript.blockhashLifetime * CONFIRM_POLL_MS;
  assert.ok(Math.max(...firstSend) < lifetime, `the last account's breach transaction went out ${Math.round(Math.max(...firstSend) / 1000)} s into the tick, after ${accounts.length - 1} blockhash lifetimes of ${lifetime / 1000} s`);
  await k.run(1); // the same marks, planned again
  assert.ok(Math.min(...fees(firstRound)) > Math.max(...fees(0, firstRound)), `priority fees ${fees(0, firstRound)} lamports, then ${fees(firstRound)}`);
  c.rpcScript.landing = true;
  await k.run(1);
  assert.deepEqual(uniq(accounts.map((a) => c.account(a).status)), ['breached']);
});

test('1c: leadership lost mid-tick: nothing is sent once the lock is gone, the next leader finishes the rest, and no position gets a second forced close', async () => {
  await c.reset();
  const accounts: string[] = [];
  // Breached accounts whose positions are worth closing (the price is back): one forced close each.
  for (let i = 0; i < 6; i++) accounts.push(await c.addAccount({ ...oneSol, status: 'breached' }));
  const old = c.keeper();
  const ticks = await old.run(5, async () => c.sends.length < 3); // the lock's session dies after the third send
  assert.equal(ticks.length, 0, 'the term ended inside the first tick');
  assert.equal(c.sends.length, 3, 'nothing was sent after the lock was gone');
  await c.keeper().run(1);
  console.log(JSON.stringify({ closesByOldLeader: 3, closes: c.closes.length }));
  assert.deepEqual(accounts.map((a) => c.closes.filter((x) => x.funded === a).length), Array(6).fill(1), 'one forced close per position across both leaders');
});

// ---------- 3. RPC failures, blockhash expiry, a lagging node: is a close ever sent twice? ----------

test('3a: a status poll that fails after the close landed: the next plan sees the pending risk close, so no second close goes out', async () => {
  await c.reset();
  const a = await c.addAccount({ ...oneSol, status: 'breached' }); // the forced close is meaningful: the position is solvent again
  c.rpcScript.statusThrows = 1;
  await c.keeper().run(3);
  console.log(JSON.stringify({ closesLanded: c.closes.length, alerts: c.raised.map((x) => `${x.key}: ${x.text.slice(-40)}`) }));
  assert.equal(c.closes.length, 1);
  assert.equal(c.account(a).orders.length, 1);
  assert.deepEqual(c.raised.filter((x) => x.key.startsWith(`failed:${a}`)), [], 'a status poll the RPC did not answer is not a failed transaction: the send polls again');
});

test('3b: a close whose blockhash expires before it lands is planned again next tick and lands once', async () => {
  await c.reset();
  const a = await c.addAccount({ ...oneSol, status: 'breached' });
  c.rpcScript.landing = false;
  await c.keeper().run(1);
  c.rpcScript.landing = true;
  await c.keeper().run(2);
  assert.equal(c.closes.length, 1);
  assert.equal(c.account(a).orders.length, 1);
});

test('3c: a lagging RPC node serves the re-read after a confirmed close: the re-planned close reuses the order address GMTrade already used (order_seq moved on), so the chain refuses it and only one close exists', async () => {
  await c.reset();
  const a = await c.addAccount({ ...oneSol, status: 'breached' });
  c.rpcScript.lagReads = 2; // the keeper's re-read after the confirmed send (two calls) shows the state from before it
  await c.keeper().run(2);
  const refused = c.sends.filter((s) => !s.landed);
  console.log(JSON.stringify({ closesLanded: c.closes.length, refusedSends: refused.length, trackedOrders: c.account(a).orders.length, alerts: c.raised.map((x) => `${x.key}: ${x.text.slice(-60)}`) }));
  assert.equal(c.closes.length, 1);
  assert.equal(c.account(a).orders.length, 1);
});

test('3d: a breached account\'s positions worth nothing get no forced close (GMTrade runs user decreases with is_insolvent_close_allowed = false, refuses and cancels each at an execution fee): the keeper leaves them to GMTrade\'s liquidation and places nothing, so no churn alert either', async () => {
  await c.reset();
  c.gap(-30);
  const a = await c.addAccount({ ...allIn, status: 'breached' });
  c.venue.latencyMs = 2_000; // GMTrade's keeper tries each order 2 s after it was placed and cancels what it cannot execute
  const before = c.account(a).lamports;
  const ticks = await c.keeper().run(5);
  const burnt = before - c.account(a).lamports;
  const pending = c.pendingOrders(a);
  const churn = c.raised.filter((x) => x.key === `churn:${a}`);
  console.log(JSON.stringify({ ticks: 5, tickSeconds: ticks.map((d) => Math.round(d / 1000)), positions: 4, forcedCloses: c.closes.length, cancelledByGmtrade: c.closes.length - pending, transactions: landed().length, ownerLamportsBurnt: burnt, churnAlert: churn[0]?.text ?? null }));
  assert.equal(burnt, (c.closes.length - pending) * EXECUTION_FEE + pending * PER_CLOSE, 'every close GMTrade refused cost its execution fee');
  assert.equal(c.closes.length, 0, `${c.closes.length} forced closes for 4 insolvent positions in 5 ticks (${burnt / 1e9} SOL from the owner PDA)`);
  assert.equal(churn.length, 0, `churn alert: ${churn[0]?.text}`);
  // Once GMTrade liquidates them, the account is synced flat and closed.
  c.venue.liquidates = true;
  await c.keeper().run(2);
  assert.equal(c.account(a).status, 'closed');
});

// ---------- 4. a closed market ----------

test('4: a stock market closed during the gap: mark_breached goes out alone, a close waits for the session, and at the reopen only a position worth something is closed', async () => {
  await c.reset();
  c.gap(-30);
  const stock = c.market('XAU');
  Object.assign(stock, { sessionRestricted: true, category: 'Stocks', open: false, gmClosed: true });
  const a = await c.addAccount({ slots: [{ symbol: 'XAU', sizeUsd: 4_000n * USD, collateral: 500_000_000n }], usdc: 0n });
  await c.keeper().run(2);
  assert.equal(c.account(a).status, 'breached');
  assert.equal(c.closes.length, 0, 'no decrease is created while GMTrade would refuse it');
  Object.assign(stock, { open: true, gmClosed: false });
  await c.keeper().run(1);
  assert.equal(c.closes.length, 0, 'at -30 % the position is worth nothing: GMTrade liquidates it, a close would be refused');
  c.gap(0); // it reopened where it closed
  await c.keeper().run(1);
  assert.equal(c.closes.length, 1, 'the forced close follows the reopening');
});

// ---------- 5. SOL for the forced close ----------

test('5a: mark_breached goes out alone, so a restricted account (no top-ups after a GMTrade upgrade) with too little SOL for a forced close is still marked', async () => {
  await c.reset();
  c.gap(-30);
  // After a GMTrade upgrade every active account is restricted and gets no top-ups; this one has half a close left.
  const a = await c.addAccount({ ...oneSol, status: 'restricted', lamports: Math.floor(PER_CLOSE / 2) });
  await c.keeper().run(3);
  console.log(JSON.stringify({ status: c.account(a).status, landed: landed().map((s) => s.names.join('+')), alerts: c.raised.map((x) => x.key) }));
  assert.equal(c.account(a).status, 'breached');
  assert.deepEqual(landed().map((s) => s.names.join('+')), ['markBreached'], 'mark_breached needs nothing from the owner PDA (LiteSVM: it succeeds alone with the same float)');
  assert.deepEqual(c.raised.filter((x) => x.key.startsWith(`failed:${a}`)), [], 'and no close is tried for a position worth nothing');
});

test('5b: a forced close that fails for lack of SOL: the alert names the owner PDA that needs SOL, and after the runbook\'s plain transfer the close goes through', async () => {
  await c.reset();
  const a = await c.addAccount({ ...oneSol, status: 'breached', lamports: 1_000_000 });
  await c.keeper().run(2);
  assert.equal(c.closes.length, 0);
  const alert = alertsFor(`failed:${a}:breach:sol`)[0];
  assert.ok(alert, 'the failed close is alerted as a lack of SOL');
  c.transferToOwner(a, PER_CLOSE);
  await c.keeper().run(1);
  assert.equal(c.closes.length, 1, 'the plain transfer to the owner PDA unblocks the close');
  console.log(JSON.stringify({ alert: alert.text }));
  const owner = ownerPda(new PublicKey(a)).toBase58();
  assert.ok(alert.text.includes(owner) && /\bSOL\b/.test(alert.text), `the alert reads "${alert.text}": it does not name the owner PDA ${owner} or say it needs SOL`);
});

// ---------- 2. a stale or missing price feed during the move ----------

test('2a: a stale feed (5 min without a price) makes no breach decision and raises one stale alert per market; the breach follows once prices are fresh', async () => {
  await c.reset();
  c.gap(-30);
  c.markets.forEach((m) => void (m.freshness = 'stale'));
  const a = await c.addAccount(allIn);
  const k = c.keeper();
  await k.run(3);
  assert.equal(c.account(a).status, 'active', 'no mark on a stale price');
  assert.deepEqual(c.raised.filter((x) => x.key.startsWith('stale:')).map((x) => x.key).sort(), ['stale:BTC', 'stale:ETH', 'stale:SOL', 'stale:XAU']);
  c.markets.forEach((m) => void (m.freshness = 'live'));
  await k.run(1);
  assert.equal(c.account(a).status, 'breached');
});

test('2b: during a feed pause (≤ 20 s without a tick, still "live") the keeper acts on the last mark: a crash the feed has not shown yet is not acted on, the last tick\'s floor touch is', async () => {
  await c.reset();
  const a = await c.addAccount(allIn);
  // The feed paused at -2 % while the market went on down: marketdata still says live, the keeper values at -2 %.
  c.gap(-2);
  await c.keeper().run(2);
  assert.equal(c.account(a).status, 'active');
  // The feed's last tick before an 8 s pause was the -30 % low; the price is back by now, the mark is not.
  c.gap(-30);
  await c.keeper().run(1);
  assert.equal(c.account(a).status, 'breached', 'touching the floor on the keeper\'s feed ends the account (a second read agrees on the chain, not on the price)');
});

test('2c: GMTrade\'s market data lost the markets (no Market account after a restart during one of its 30 min outages) while prices stay live: the keeper cannot value the accounts, makes no breach decision, and raises a critical alert naming the account and its markets', async () => {
  await c.reset();
  c.gap(-30);
  c.markets.forEach((m) => void (m.stateUnavailable = true));
  const a = await c.addAccount(allIn);
  await c.keeper().run(3);
  const about = c.raised.filter((x) => x.key === `value:${a}`);
  console.log(JSON.stringify({ status: c.account(a).status, alerts: c.raised.map((x) => x.key), keeperWarnings: uniq(c.warnings) }));
  assert.equal(c.account(a).status, 'active', 'no decision without a valuation');
  // ARCHITECTURE §8: alerts are raised for "an account the keeper cannot read or value"; the stale check sees live prices.
  assert.equal(about.length, 1, 'one alert (30 min repeat window), not only a log warning ("position could not be valued")');
  assert.equal(about[0]!.level, 'critical');
  assert.match(about[0]!.text, /SOL, BTC, ETH, XAU position/);
});

// ---------- 7. alert flooding and the 30 min repeat window ----------

test('7: a second, different failure of the same step is raised at once, not hidden for 30 min by the first one\'s repeat window; a repeat of either waits', async () => {
  await c.reset();
  // A breached account whose position is worth closing (the price is back), with a float too thin for the close.
  const a = await c.addAccount({ ...oneSol, status: 'breached', lamports: 1_000_000 });
  const k = c.keeper();
  await k.run(1); // the close fails for SOL
  c.transferToOwner(a, PER_CLOSE); // the runbook's plain transfer…
  c.venue.decreasesDisabled = true; // …but by now GMTrade refuses decreases (FEATURE_KEEPER)
  await k.run(2);
  const failed = failuresOf(a, 'breach');
  console.log(JSON.stringify({ closes: c.closes.length, refused: c.refusals.map((r) => r.err), alerts: failed.map((x) => x.key) }));
  assert.deepEqual(failed.map((x) => x.key.split(':').pop()), ['sol', 'FeatureDisabled'], 'both causes reached the operator, each once');
  assert.equal(c.closes.length, 0);
});

// ---------- 6. more owner positions than a transaction holds ----------

test('6: a breached account whose owner PDA has 25 empty GMTrade Positions (every cancelled or unfilled increase leaves one; 16 fill a close_funded) is closed: only positions with a size are passed for the flat check', async () => {
  await c.reset();
  const a = await c.addAccount({ ...oneSol, status: 'breached' });
  c.addEmptyPositions(a, 25);
  c.venue.liquidates = true;
  c.gap(-30); // GMTrade liquidates the open one: 26 Position accounts, all empty
  await c.keeper().run(2);
  console.log(JSON.stringify({ ownerPositions: [...c.positions.values()].filter((p) => p.funded === a).length, status: c.account(a).status, alerts: c.raised.map((x) => x.key) }));
  assert.equal(c.account(a).status, 'closed');
  assert.deepEqual(c.raised.filter((x) => x.key.startsWith(`failed:${a}`)), []);
});

// ---------- 8. 50 accounts: per-tick RPC and database load ----------

test('8: 50 funded accounts with two open positions each: the keeper\'s RPC calls, database queries and wall time per tick', async () => {
  await c.reset();
  for (let i = 0; i < 50; i++) {
    await c.addAccount({ slots: [{ symbol: 'SOL', sizeUsd: 2_000n * USD, collateral: 200_000_000n }, { symbol: 'BTC', isLong: false, sizeUsd: 2_000n * USD, collateral: 200_000_000n }], usdc: 100_000_000n });
  }
  let queries = 0;
  const db = drizzle(t.sql, { schema, logger: { logQuery: () => void queries++ } });
  const rows = [];
  for (const latencyMs of [0, 50]) {
    c.rpcScript.latencyMs = latencyMs;
    const k = c.keeper({ db });
    await k.run(1); // warm-up: first sight of the GMTrade deploy, the indexer check
    c.resetCounts();
    queries = 0;
    const [tick] = await k.run(1);
    rows.push({ rpcLatencyMs: latencyMs, tickMs: tick!, rpcCallsPerTick: { ...c.calls }, dbQueriesPerTick: queries });
  }
  console.log(JSON.stringify({ accounts: 50, positions: 100, rows }));
  assert.equal(c.sends.length, 0);
  assert.equal(rows[1]!.rpcCallsPerTick.getMultipleAccountsInfoAndContext, 100, 'two sequential account reads per funded account per tick');
  assert.ok(rows[1]!.dbQueriesPerTick <= 10, 'the database load does not grow with the number of accounts');
  // Should: the tick fits its 5 s interval. Every read is awaited in turn, so the tick grows by 2 × latency per account.
  assert.ok(rows[1]!.tickMs <= 5_000, `50 accounts take ${rows[1]!.tickMs} ms a tick at 50 ms per RPC call (${rows[0]!.tickMs} ms with none): the keeper ticks every ${(rows[1]!.tickMs / 1000).toFixed(1)} s, not 5 s`);
});
