// Exchange round-trip probe (see README.md next to this file): proves on the live exchange, with a plain wallet and a few
// dollars and WITHOUT deploying props_vault, that an order built exactly as programs/props_vault/src/gmtrade.rs builds
// it is executed by the exchange's keepers and pays its proceeds back to the owner.
//
// It mirrors CreateOrderCpi::invoke, CloseOrderCpi::invoke and close_empty_position for a wallet owner: ATA(order, USDC)
// created idempotently, then prepare_user and prepare_position on every increase, create_order_v2 with owner = receiver =
// the wallet, USDC as the collateral / output / long / short token, one escrow for all four, no swap, no callbacks, the
// execution fee of 300,000 lamports, nonce = the order counter as 8 little-endian bytes in 32 (next_order_nonce),
// close_order_v2 by the owner with reason "cancel" to refund an order, and close_empty_position to recover a flat
// position's rent. Instruction data is encoded by anchor's BorshCoder from the exchange's own IDL (packages/gmtrade/idl);
// accounts and events are decoded with @props/gmtrade. What the exchange did to an order is read from the events of the
// transaction that removed it (OrderRemoved: final state and reason; TradeEvent: the fill), never inferred from balances.
//
//   RPC_URL=https://… PROBE_KEYPAIR=~/.config/props-trade/probe.json STEP=open DRY_RUN=1 node scripts/probe/exchange-roundtrip.ts
//
// Env: RPC_URL (required) · PROBE_KEYPAIR (path to the wallet's key file: loaded at runtime, never printed) · DRY_RUN
// (required: exactly 1 builds and simulates only, printing the decoded instructions and the simulation logs, nothing is
// ever sent; exactly 0 is live; anything else is refused) · STEP = status | open | tp | sl | close | cancel-all |
// close-position | all · MARKET (SOL) · SIZE_USD (20) · COLLATERAL_USDC (2) · TP_BPS (10) · SL_BPS (10; negative puts a
// long's stop above entry, so right after a fill it fills at once) · PROBE_STATE (the order counter, baseline balances and fills; default
// ~/.cache/props-probe/<pubkey>.json). Every transaction is simulated first, sent with preflight on and confirmed at 'confirmed'.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BorshCoder, utils } from '@coral-xyz/anchor';
import type { Idl } from '@coral-xyz/anchor';
import BN from 'bn.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import type { AccountMeta, VersionedTransactionResponse } from '@solana/web3.js';
import { model } from '@props/gmsol-wasm';
import {
  IdlCoder, MarketFlag, NO_ACCOUNT, decodeMarket, decodePosition, fetchMarkets, fetchTokens, fetchUser, fetchVirtualInventories,
  formatFixed, hasFlag, modelInput, parseFixed, priceString, storeIdl, usdString, venueLimits,
} from '@props/gmtrade';
import type { FeedState, Idl as StoreIdl, KeeperMarket, KeeperToken, PositionAccount } from '@props/gmtrade';
import {
  GMTRADE_PROGRAM_ID, GMTRADE_STORE, USDC_MINT, buildTransaction, decodeGmMarketMeta, gmEventAuthority, gmMarketPda, gmOrderEscrow, gmOrderPda,
  gmPositionPda, gmStoreWallet, gmUserPda, orderNonce,
} from '@props/sdk';

// ---- gmtrade.rs constants ----
/** `EXECUTION_LAMPORTS`: gmsol-store `Order::MIN_EXECUTION_LAMPORTS`, the fee offered to the executing keeper. */
const EXECUTION_LAMPORTS = 300_000;
/** `layout::ORDER_LEN`, `USER_LEN`, `POSITION_LEN`, `TOKEN_ACCOUNT_LEN`: what an order costs its owner in rent. */
const LEN = { order: 2472, user: 520, position: 680, tokenAccount: 165 } as const;
const STEPS = ['status', 'open', 'tp', 'sl', 'close', 'cancel-all', 'close-position', 'all'] as const;
type Step = (typeof STEPS)[number];
type Kind = 'MarketIncrease' | 'MarketDecrease' | 'LimitDecrease' | 'StopLossDecrease';
const ACTION_STATE = ['Pending', 'Completed', 'Cancelled'] as const;
const ORDER_SIDE = ['long', 'short'] as const;
const SLIPPAGE_BPS = 50n; // acceptable price = mark ± 0.5 %

// ---- environment ----
const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`set ${name}`);
  return v;
};
const RPC_URL = env('RPC_URL');
const MARKET = env('MARKET', 'SOL');
const SIZE_USD = parseFixed(env('SIZE_USD', '20'), 20);
const COLLATERAL = parseFixed(env('COLLATERAL_USDC', '2'), 6);
const TP_BPS = BigInt(env('TP_BPS', '10'));
const SL_BPS = BigInt(env('SL_BPS', '10'));
// Exactly '0' or '1', nothing else: "DRY_RUN=true" or "yes" must never run live.
const DRY_RUN_FLAG = env('DRY_RUN');
if (DRY_RUN_FLAG !== '0' && DRY_RUN_FLAG !== '1') throw new Error('DRY_RUN must be exactly 1 (simulate only) or 0 (live)');
const DRY_RUN = DRY_RUN_FLAG === '1';
const STEP = env('STEP') as Step;
if (!STEPS.includes(STEP)) throw new Error(`STEP must be one of ${STEPS.join(', ')}`);
if (SIZE_USD <= 0n || COLLATERAL <= 0n || TP_BPS <= 0n) throw new Error('SIZE_USD, COLLATERAL_USDC and TP_BPS must be positive');
const LOCAL = /127\.0\.0\.1|localhost/.test(RPC_URL);

const wallet = loadKeypair(env('PROBE_KEYPAIR'));
const owner = wallet.publicKey;
const walletUsdc = getAssociatedTokenAddressSync(USDC_MINT, owner);
const rpc = new Connection(RPC_URL, 'confirmed');
const STATE_PATH = process.env.PROBE_STATE || join(homedir(), '.cache', 'props-probe', `${owner.toBase58()}.json`);

function loadKeypair(path: string): Keypair {
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  } catch {
    // Never pass the parser's message on: it quotes the start of the file, which is the secret key.
    throw new Error(`PROBE_KEYPAIR (${path}) is not a solana-keygen key file (a JSON array of 64 numbers)`);
  }
}

// ---- the exchange's IDL: anchor encodes the five instructions, @props/gmtrade decodes accounts and events ----
interface RawIdl {
  instructions: { name: string; accounts: { name: string }[]; args: { name: string; type: unknown }[] }[];
  events: { name: string; discriminator: number[] }[];
  types: { name: string; type: { kind: string; fields?: { name: string; type: unknown }[]; variants?: { name: string; fields?: unknown[] }[] } }[];
  [key: string]: unknown;
}
const fullIdl = JSON.parse(readFileSync(new URL('../../packages/gmtrade/idl/gmsol_store-0.10.0.json', import.meta.url), 'utf8')) as RawIdl;
const IX_NAMES = ['prepare_user', 'prepare_position', 'create_order_v2', 'close_order_v2', 'close_empty_position'];
/** anchor's coder refuses the whole IDL ("unable to infer src variant"), so it gets the five instructions and their types only. */
function trimmedIdl(): Idl {
  const types = new Map(fullIdl.types.map((t) => [t.name, t]));
  const needed = new Set<string>();
  const walk = (ty: unknown): void => {
    if (!ty || typeof ty !== 'object') return;
    const t = ty as { defined?: { name: string }; option?: unknown; vec?: unknown; array?: [unknown, number] };
    if (t.defined) {
      if (needed.has(t.defined.name)) return;
      needed.add(t.defined.name);
      const def = types.get(t.defined.name);
      for (const f of def?.type.fields ?? []) walk(f.type);
      for (const v of def?.type.variants ?? []) for (const f of v.fields ?? []) walk((f as { type?: unknown }).type ?? f);
    } else if (t.option) walk(t.option);
    else if (t.vec) walk(t.vec);
    else if (t.array) walk(t.array[0]);
  };
  const instructions = fullIdl.instructions.filter((i) => IX_NAMES.includes(i.name));
  for (const i of instructions) for (const a of i.args) walk(a.type);
  return { ...fullIdl, instructions, accounts: [], events: [], types: fullIdl.types.filter((t) => needed.has(t.name)) } as unknown as Idl;
}
const ixCoder = new BorshCoder(trimmedIdl());
/** Events decode like accounts: same {name, discriminator} shape, same sequential layout. */
const eventCoder = new IdlCoder({ ...fullIdl, accounts: fullIdl.events } as unknown as StoreIdl);
const EVENT_CPI_TAG = Buffer.from('e445a52e51cb9a1d', 'hex');
const idlAccounts = (name: string) => fullIdl.instructions.find((i) => i.name === name)!.accounts.map((a) => a.name);
const ORDER_KINDS = fullIdl.types.find((t) => t.name === 'OrderKind')!.type.variants!.map((v) => v.name);
const OFF = {
  orderOwner: storeIdl.offsetOf('Order', 'header.owner'),
  orderMarketToken: storeIdl.offsetOf('Order', 'market_token'),
  positionOwner: storeIdl.offsetOf('Position', 'owner'),
};

// ---- formatting ----
const bn = (v: bigint | number) => new BN(v.toString());
const usdc = (v: bigint | number) => `${formatFixed(BigInt(v), 6, 6)} USDC`;
const sol = (lamports: bigint | number) => `${formatFixed(BigInt(lamports), 9, 9)} SOL`;
const usd = (v: bigint) => `$${usdString(v)}`;
const link = (signature: string) => (LOCAL ? `https://solscan.io/tx/${signature}?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}` : `https://solscan.io/tx/${signature}`);
const plain = (v: unknown): unknown =>
  BN.isBN(v) ? v.toString() : typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- state: order counter (the program's order_seq), baseline balances, fills ----
interface Fill { step: string; signature: string; keeper: string; executionPrice: string; pnlUsd: bigint; feesUsdc: bigint; impactUsd: bigint; paidOutUsdc: bigint }
interface State { seq: number; baseline?: { usdc: string; lamports: number; at: string }; fills: Fill[] }
function loadState(): State {
  if (!existsSync(STATE_PATH)) return { seq: 0, fills: [] };
  const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as { seq: number; baseline?: State['baseline']; fills?: Record<string, string>[] };
  return {
    seq: raw.seq,
    baseline: raw.baseline,
    fills: (raw.fills ?? []).map((f) => ({ ...f, pnlUsd: BigInt(f.pnlUsd!), feesUsdc: BigInt(f.feesUsdc!), impactUsd: BigInt(f.impactUsd!), paidOutUsdc: BigInt(f.paidOutUsdc!) }) as Fill),
  };
}
function saveState(state: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(plain(state), null, 2));
}
const state = loadState();

// ---- reads ----
interface MarketView {
  symbol: string; name: string; market: PublicKey; marketToken: PublicKey; indexToken: string; decimals: number;
  price: { min: bigint; max: bigint; mid: bigint; ageS: number; isOpen: boolean };
  enabled: boolean; closed: boolean;
  pool: bigint; capacityLong: bigint; capacityShort: bigint; maxSizeLong: bigint | null; maxSizeShort: bigint | null;
  maxLeverageLong: number; minPositionSizeUsd: bigint; minCollateralUsd: bigint;
}
const px = (m: MarketView, p: bigint) => `$${priceString(p, m.decimals, 4)}`;

/** The market through the catalog's helpers: metadata and prices from the keeper API, the accounts from the chain traded on. */
async function readMarket(symbol: string): Promise<MarketView> {
  const [tokens, markets, vis] = await Promise.all([fetchTokens(), fetchMarkets(), fetchVirtualInventories()]);
  const tokenMap = new Map<string, KeeperToken>(tokens.map((t) => [t.pubkey, t]));
  // Props.trade trades only pure USDC-USDC pools: the same choice buildCatalog makes.
  const market: KeeperMarket | undefined = markets.find(
    (m) => m.meta?.isEnabled && m.meta.isPure && m.meta.longToken.pubkey === USDC_MINT.toBase58() && tokenMap.get(m.meta.indexToken.pubkey)?.meta?.name === symbol,
  );
  if (!market?.meta) throw new Error(`the exchange lists no enabled pure USDC-USDC pool for ${symbol}`);
  const index = tokenMap.get(market.meta.indexToken.pubkey)!;
  if (!index.price || !index.meta) throw new Error(`no price for ${symbol} from the keeper API`);
  const addresses = [market.pubkey, market.virtualInventoryForSwaps, market.virtualInventoryForPositions].filter((a) => a !== NO_ACCOUNT);
  const infos = await rpc.getMultipleAccountsInfo(addresses.map((a) => new PublicKey(a)));
  const accounts = new Map<string, { data: string; slot: number }>();
  addresses.forEach((a, i) => {
    const info = infos[i];
    if (info) accounts.set(a, { data: info.data.toString('base64'), slot: 0 });
    else if (a === market.pubkey) throw new Error(`market account ${a} does not exist on ${RPC_URL}`);
    else {
      const vi = vis.find((v) => v.pubkey === a);
      if (!vi?.data) throw new Error(`virtual inventory ${a} is neither on this chain nor in the keeper API`);
      accounts.set(a, { data: vi.data, slot: 0 });
      console.log(`note: virtual inventory ${a} is not on this chain; using the keeper's copy for the model`);
    }
  });
  const feed: FeedState = { tokens: tokenMap, markets: new Map([[market.marketToken, market]]), accounts, mode: 'poll' };
  const input = modelInput(feed, market);
  if (!input) throw new Error('the model input is incomplete (missing a price or an account)');
  const status = model.marketStatus(input);
  const image = accounts.get(market.pubkey)!.data;
  const decoded = decodeMarket(image);
  // What the program checks on chain before every order (`check_pure_usdc_market`); the keeper API's "pure" flag is not trusted for it.
  const onChain = decodeGmMarketMeta(Buffer.from(image, 'base64'));
  if (!onChain.pureUsdc || !onChain.store.equals(GMTRADE_STORE) || onChain.marketToken.toBase58() !== market.marketToken) {
    throw new Error(`market ${market.pubkey} on chain is not a pure USDC-USDC market of the GMTrade store (long ${onChain.longToken.toBase58()}, short ${onChain.shortToken.toBase58()}, store ${onChain.store.toBase58()})`);
  }
  const price = { min: BigInt(index.price.min), max: BigInt(index.price.max) };
  const limits = venueLimits(image, status, price);
  return {
    symbol, name: market.meta.name, market: new PublicKey(market.pubkey), marketToken: new PublicKey(market.marketToken), indexToken: index.pubkey,
    decimals: index.meta.decimals,
    price: { ...price, mid: (price.min + price.max) / 2n, ageS: Math.round(Date.now() / 1000 - index.price.ts), isOpen: index.price.isOpen },
    enabled: hasFlag(decoded, MarketFlag.Enabled), closed: hasFlag(decoded, MarketFlag.Closed),
    pool: status.poolValueForLong + status.poolValueForShort, capacityLong: status.liquidityForLong, capacityShort: status.liquidityForShort,
    maxSizeLong: limits.maxSizeLong === null ? null : parseFixed(limits.maxSizeLong, 20), maxSizeShort: limits.maxSizeShort === null ? null : parseFixed(limits.maxSizeShort, 20),
    maxLeverageLong: limits.maxLeverageLong, minPositionSizeUsd: decoded.config.min_position_size_usd, minCollateralUsd: decoded.config.min_collateral_value,
  };
}

function printMarket(m: MarketView): void {
  console.log(`market ${m.name} (${m.market.toBase58()}, market token ${m.marketToken.toBase58()})`);
  console.log(`  price ${px(m, m.price.min)} – ${px(m, m.price.max)} (mid ${px(m, m.price.mid)}, ${m.price.ageS} s old, ${m.price.isOpen ? 'open' : 'CLOSED'}), flags: ${m.enabled ? 'enabled' : 'DISABLED'}${m.closed ? ', CLOSED' : ''}`);
  console.log(`  pool ${usd(m.pool)} · capacity long ${usd(m.capacityLong)} / short ${usd(m.capacityShort)} · max new size long ${m.maxSizeLong === null ? '?' : usd(m.maxSizeLong)} / short ${m.maxSizeShort === null ? '?' : usd(m.maxSizeShort)}`);
  console.log(`  minimum position ${usd(m.minPositionSizeUsd)} · minimum collateral ${usd(m.minCollateralUsd)} · max leverage long ${m.maxLeverageLong}x`);
}

interface WalletView { lamports: number; usdc: bigint; hasUsdcAccount: boolean; userExists: boolean }
async function readWallet(): Promise<WalletView> {
  const [lamports, usdcInfo, userInfo] = await Promise.all([rpc.getBalance(owner), rpc.getAccountInfo(walletUsdc), rpc.getAccountInfo(gmUserPda(owner))]);
  return { lamports, usdc: usdcInfo ? usdcInfo.data.readBigUInt64LE(64) : 0n, hasUsdcAccount: usdcInfo !== null, userExists: userInfo !== null };
}

interface OrderView { address: PublicKey; raw: Record<string, unknown>; state: string; kind: string; side: string; marketToken: string; size: bigint; trigger: bigint; acceptable: bigint; collateral: bigint; initialEscrow: string; finalEscrow: string; receiver: string; rentReceiver: string }
function viewOrder(address: PublicKey, data: Buffer): OrderView {
  const d = storeIdl.decodeAccount('Order', data) as Record<string, Record<string, unknown>>;
  const header = d.header!;
  const params = d.params!;
  const tokens = d.tokens as Record<string, { account: string }>;
  return {
    address, raw: d, state: ACTION_STATE[header.action_state as number] ?? String(header.action_state), kind: ORDER_KINDS[params.kind as number] ?? String(params.kind),
    side: ORDER_SIDE[params.side as number] ?? String(params.side), marketToken: d.market_token as unknown as string, size: params.size_delta_value as bigint,
    trigger: params.trigger_price as bigint, acceptable: params.acceptable_price as bigint, collateral: params.initial_collateral_delta_amount as bigint,
    initialEscrow: tokens.initial_collateral!.account, finalEscrow: tokens.final_output_token!.account, receiver: header.receiver as string, rentReceiver: header.rent_receiver as string,
  };
}
const describeOrder = (m: MarketView | null, o: OrderView) =>
  `${o.address.toBase58()}: ${o.kind} ${o.side} ${usd(o.size)}${o.collateral ? ` collateral ${usdc(o.collateral)}` : ''}${o.trigger ? ` trigger ${m ? px(m, o.trigger) : o.trigger}` : ''}${o.acceptable ? ` acceptable ${m ? px(m, o.acceptable) : o.acceptable}` : ''} [${o.state}]${m && o.marketToken !== m.marketToken.toBase58() ? ` (another market: ${o.marketToken})` : ''}`;

/** Every exchange Order and Position account of the wallet: getProgramAccounts, or the keeper API when the RPC refuses it. */
async function ownerAccounts(): Promise<{ orders: OrderView[]; positions: { address: PublicKey; position: PositionAccount }[] }> {
  const disc = (name: string) => utils.bytes.bs58.encode(Buffer.from(storeIdl.discriminator(name)));
  const list = (name: 'Order' | 'Position', size: number, ownerOffset: number) =>
    rpc.getProgramAccounts(GMTRADE_PROGRAM_ID, {
      commitment: 'confirmed',
      filters: [{ dataSize: size }, { memcmp: { offset: 0, bytes: disc(name) } }, { memcmp: { offset: ownerOffset, bytes: owner.toBase58() } }],
    });
  let orders: { pubkey: PublicKey; data: Buffer }[];
  let positions: { pubkey: PublicKey; data: Buffer }[];
  try {
    const [o, p] = await Promise.all([list('Order', LEN.order, OFF.orderOwner), list('Position', LEN.position, OFF.positionOwner)]);
    orders = o.map((a) => ({ pubkey: a.pubkey, data: a.account.data }));
    positions = p.map((a) => ({ pubkey: a.pubkey, data: a.account.data }));
  } catch (err) {
    console.log(`note: getProgramAccounts refused (${(err as Error).message.slice(0, 80)}); listing through the keeper API`);
    const user = await fetchUser(owner.toBase58());
    orders = user.orders.filter((o) => o.data).map((o) => ({ pubkey: new PublicKey(o.pubkey), data: Buffer.from(o.data!, 'base64') }));
    positions = user.positions.filter((p) => p.data).map((p) => ({ pubkey: new PublicKey(p.pubkey), data: Buffer.from(p.data!, 'base64') }));
  }
  return {
    orders: orders.map((o) => viewOrder(o.pubkey, o.data)),
    positions: positions.map((p) => ({ address: p.pubkey, position: decodePosition(p.data.toString('base64')) })),
  };
}

async function readPosition(m: MarketView): Promise<PositionAccount | null> {
  const info = await rpc.getAccountInfo(gmPositionPda(owner, m.marketToken, true));
  return info ? decodePosition(info.data.toString('base64')) : null;
}
const positionSize = (p: PositionAccount | null) => p?.state.size_in_usd ?? 0n;
/** Average entry as a unit price: size in USD (1e20) over size in index-token base units, GMTrade's own price scale. */
const entryPrice = (p: PositionAccount) => p.state.size_in_usd / p.state.size_in_tokens;
function describePosition(m: MarketView, p: PositionAccount | null): string {
  if (!p || p.state.size_in_usd === 0n) return `position ${gmPositionPda(owner, m.marketToken, true).toBase58()}: ${p ? 'flat (account kept; STEP=close-position recovers its rent)' : 'none'}`;
  return `position ${gmPositionPda(owner, m.marketToken, true).toBase58()}: ${p.kind === 1 ? 'long' : 'short'} ${usd(p.state.size_in_usd)} · collateral ${usdc(p.state.collateral_amount)} · entry ${px(m, entryPrice(p))}`;
}

// ---- instruction builders (gmtrade.rs mirrored for a wallet owner) ----
const NONE: AccountMeta = { pubkey: GMTRADE_PROGRAM_ID, isSigner: false, isWritable: false }; // anchor's "no account": the program id
const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

function gmInstruction(name: string, keys: AccountMeta[], args: Record<string, unknown>): TransactionInstruction {
  const expected = idlAccounts(name).length;
  if (keys.length !== expected) throw new Error(`${name}: built ${keys.length} accounts, the IDL lists ${expected}`);
  return new TransactionInstruction({ programId: GMTRADE_PROGRAM_ID, keys, data: ixCoder.instruction.encode(name, args) });
}

/** `gmtrade::order_params`: USDC collateral and output, no swap, no unwrapping, no delayed start. */
function orderParams(kind: Kind, collateral: bigint, size: bigint, trigger: bigint | null, acceptable: bigint | null) {
  return {
    kind: { [kind]: {} },
    decrease_position_swap_type: kind === 'MarketIncrease' ? null : { NoSwap: {} },
    execution_lamports: bn(EXECUTION_LAMPORTS),
    swap_path_length: 0,
    initial_collateral_delta_amount: bn(collateral),
    size_delta_value: bn(size),
    is_long: true,
    is_collateral_long: true, // pure USDC-USDC market: the collateral token is both the long and the short token
    min_output: null,
    trigger_price: trigger === null ? null : bn(trigger),
    acceptable_price: acceptable === null ? null : bn(acceptable),
    should_unwrap_native_token: false,
    valid_from_ts: null,
  };
}

/**
 * The order's nonce: the first counter value from the state file whose order address is free. An executed or cancelled
 * order's account is closed, so after the state file is deleted this reuses its address (the exchange does not mind);
 * the program's monotonic counter never does.
 */
async function nextNonce(): Promise<{ seq: number; nonce: Uint8Array; order: PublicKey }> {
  let seq = state.seq;
  for (;;) {
    const nonce = orderNonce(BigInt(seq));
    const order = gmOrderPda(owner, nonce);
    if (!(await rpc.getAccountInfo(order))) return { seq, nonce, order };
    seq++;
  }
}

/** `CreateOrderCpi::invoke`: escrow (idempotent), [prepare_user, prepare_position for increases], create_order_v2. */
function createOrderInstructions(m: MarketView, p: { kind: Kind; collateral: bigint; size: bigint; trigger: bigint | null; acceptable: bigint | null; nonce: Uint8Array }) {
  const increase = p.kind === 'MarketIncrease';
  const order = gmOrderPda(owner, p.nonce);
  const escrow = gmOrderEscrow(order);
  const position = gmPositionPda(owner, m.marketToken, true);
  const user = gmUserPda(owner);
  const params = orderParams(p.kind, p.collateral, p.size, p.trigger, p.acceptable);
  const instructions = [createAssociatedTokenAccountIdempotentInstruction(owner, escrow, order, USDC_MINT)];
  if (increase) {
    // On every increase, as the program does: the exchange creates a missing user account and validates an existing one.
    instructions.push(gmInstruction('prepare_user', [w(owner, true), r(GMTRADE_STORE), w(user), r(SystemProgram.programId)], {}));
    instructions.push(gmInstruction('prepare_position', [w(owner, true), r(GMTRADE_STORE), r(m.market), w(position), r(SystemProgram.programId)], { params }));
  }
  instructions.push(
    gmInstruction(
      'create_order_v2',
      [
        w(owner, true), r(owner) /* receiver */, r(GMTRADE_STORE), w(m.market), w(user), w(order), w(position),
        increase ? r(USDC_MINT) : NONE /* initial_collateral_token */, r(USDC_MINT) /* final_output_token */, r(USDC_MINT) /* long_token */, r(USDC_MINT) /* short_token */,
        increase ? w(escrow) : NONE /* initial_collateral_token_escrow */, increase ? NONE : w(escrow) /* final_output_token_escrow */, w(escrow) /* long_token_escrow */, w(escrow) /* short_token_escrow */,
        increase ? w(walletUsdc) : NONE /* initial_collateral_token_source */,
        r(SystemProgram.programId), r(TOKEN_PROGRAM_ID), r(ASSOCIATED_TOKEN_PROGRAM_ID),
        NONE, NONE, NONE, NONE /* no callbacks */,
        r(gmEventAuthority()), r(GMTRADE_PROGRAM_ID),
      ],
      { nonce: Array.from(p.nonce), params, callback_version: null },
    ),
  );
  return { instructions, order, escrow, position };
}

/** `CloseOrderCpi::invoke` as the owner: exactly the escrows the order recorded; funds to the owner's USDC, rent to the owner. */
function closeOrderInstructions(o: OrderView): TransactionInstruction[] {
  const escrow = gmOrderEscrow(o.address);
  const hasInitial = o.initialEscrow !== NO_ACCOUNT;
  const hasFinal = o.finalEscrow !== NO_ACCOUNT;
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, walletUsdc, owner, USDC_MINT),
    gmInstruction(
      'close_order_v2',
      [
        r(owner, true) /* executor */, w(GMTRADE_STORE), w(gmStoreWallet()), w(owner), w(new PublicKey(o.receiver)), w(new PublicKey(o.rentReceiver)), w(gmUserPda(owner)),
        NONE /* referrer_user */, w(o.address),
        hasInitial ? r(USDC_MINT) : NONE, r(USDC_MINT), r(USDC_MINT), r(USDC_MINT),
        hasInitial ? w(escrow) : NONE, hasFinal ? w(escrow) : NONE, w(escrow), w(escrow),
        hasInitial ? w(walletUsdc) : NONE, hasFinal ? w(walletUsdc) : NONE, w(walletUsdc), w(walletUsdc),
        r(SystemProgram.programId), r(TOKEN_PROGRAM_ID), r(ASSOCIATED_TOKEN_PROGRAM_ID),
        NONE, NONE, NONE, NONE,
        r(gmEventAuthority()), r(GMTRADE_PROGRAM_ID),
      ],
      { reason: 'cancel' },
    ),
  ];
}

// ---- transactions ----
function printDecoded(instructions: TransactionInstruction[]): void {
  for (const ix of instructions) {
    if (ix.programId.equals(GMTRADE_PROGRAM_ID)) {
      const decoded = ixCoder.instruction.decode(ix.data);
      if (!decoded) throw new Error('the exchange instruction does not decode with its own IDL');
      console.log(`  ${decoded.name} ${JSON.stringify(plain(decoded.data))}`);
      idlAccounts(decoded.name).forEach((name, i) => {
        const k = ix.keys[i]!;
        console.log(`    ${name.padEnd(34)} ${k.pubkey.equals(GMTRADE_PROGRAM_ID) && name !== 'program' ? '(none)' : k.pubkey.toBase58()}${k.isSigner ? ' signer' : ''}${k.isWritable ? ' writable' : ''}`);
      });
    } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      console.log(`  associated token: create idempotent ${ix.keys[1]!.pubkey.toBase58()} (owner ${ix.keys[2]!.pubkey.toBase58()}, mint ${ix.keys[3]!.pubkey.toBase58()})`);
    } else console.log(`  ${ix.programId.toBase58()} (${ix.data.length} bytes)`);
  }
}

/** Simulates, then (unless DRY_RUN) sends with preflight and confirms. Returns the signature, or null for a dry run. */
async function run(label: string, instructions: TransactionInstruction[]): Promise<string | null> {
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash('confirmed');
  const tx = buildTransaction({ payer: owner, instructions, recentBlockhash: blockhash });
  console.log(`${label}: ${instructions.length} instructions, ${tx.serialize().length} bytes${DRY_RUN ? ' (dry run)' : ''}`);
  if (DRY_RUN) printDecoded(instructions);
  const sim = await rpc.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  const cu = sim.value.unitsConsumed ?? 0;
  if (DRY_RUN) {
    console.log(`  simulation: ${sim.value.err ? `FAILS ${JSON.stringify(sim.value.err)}` : 'ok'}, ${cu} CU`);
    for (const l of sim.value.logs ?? []) console.log(`    ${l}`);
    console.log('  dry run: nothing sent');
    return null;
  }
  if (sim.value.err) {
    console.log(`  simulation FAILS ${JSON.stringify(sim.value.err)} after ${cu} CU; nothing sent. Logs:`);
    for (const l of sim.value.logs ?? []) console.log(`    ${l}`);
    throw new Error(`${label}: simulation failed`);
  }
  console.log(`  simulation ok, ${cu} CU; sending…`);
  tx.sign([wallet]);
  const signature = await rpc.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
  const result = await rpc.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (result.value.err) {
    const t = await rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    for (const l of t?.meta?.logMessages ?? []) console.log(`    ${l}`);
    throw new Error(`${label} failed on chain: ${JSON.stringify(result.value.err)} (${signature})`);
  }
  console.log(`  confirmed ${signature}\n  ${link(signature)}`);
  return signature;
}

async function waitUntil<T>(what: string, timeoutMs: number, intervalMs: number, check: () => Promise<T | undefined>): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() >= end) return undefined;
    process.stdout.write(`  waiting for ${what}… ${Math.round((end - Date.now()) / 1000)} s left\r`);
    await sleep(intervalMs);
  }
}

type Keys = ReturnType<VersionedTransactionResponse['transaction']['message']['getAccountKeys']>;
/** The exchange's CPI event `name` in `tx` (a self-invocation carrying anchor's event tag), decoded from the IDL. */
function cpiEvent(tx: VersionedTransactionResponse, keys: Keys, name: string): Record<string, unknown> | null {
  const disc = Buffer.from(eventCoder.discriminator(name));
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (!keys.get(ix.programIdIndex)?.equals(GMTRADE_PROGRAM_ID)) continue;
      const data = Buffer.from(utils.bytes.bs58.decode(ix.data));
      if (data.length >= 16 && data.subarray(0, 8).equals(EVENT_CPI_TAG) && data.subarray(8, 16).equals(disc)) return eventCoder.decodeAccount(name, data.subarray(8)) as Record<string, unknown>;
    }
  }
  return null;
}

interface Removal { signature: string; slot: number; payer: string; latencyS: number | null; state: string; reason: string; trade: Record<string, unknown> | null }
/** The OrderRemoved event of `signature` (the order's final state and the reason) with the TradeEvent when it executed, or null when the transaction removed no order. */
async function removalIn(signature: string): Promise<Omit<Removal, 'slot' | 'latencyS'> | null> {
  const tx = await rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!tx) return null;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
  const removed = cpiEvent(tx, keys, 'OrderRemoved');
  if (!removed) return null;
  return { signature, payer: keys.get(0)!.toBase58(), state: removed.state as string, reason: removed.reason as string, trade: cpiEvent(tx, keys, 'TradeEvent') };
}

/** What the exchange did to `order` after our transaction `ours`: the newest other successful transaction that removed it. Undefined until the RPC has indexed one. */
async function removalOf(order: PublicKey, ours: string): Promise<Removal | undefined> {
  const signatures = await rpc.getSignaturesForAddress(order, { limit: 20 }, 'confirmed');
  const ourTime = signatures.find((s) => s.signature === ours)?.blockTime ?? null;
  for (const s of signatures) {
    if (s.signature === ours) break; // only transactions newer than ours: an older cycle of a reused address never counts
    if (s.err !== null) continue;
    const removal = await removalIn(s.signature);
    if (removal) return { ...removal, slot: s.slot, latencyS: ourTime !== null && s.blockTime != null ? s.blockTime - ourTime : null };
  }
  return undefined;
}

/**
 * Waits for the exchange to act on `order` (created by our transaction `ours`): 'pending' when it still rests after the
 * wait, or the fill read from the TradeEvent of the transaction that removed it. A keeper that tried and failed leaves
 * OrderRemoved state Cancelled and no TradeEvent: that throws instead of counting as a fill. Nothing is inferred from
 * the position or balances, which the same transaction changes.
 */
async function settle(m: MarketView, step: string, order: PublicKey, ours: string, timeoutMs: number, intervalMs: number): Promise<Fill | 'pending'> {
  const outcome = await waitUntil('the keeper', timeoutMs, intervalMs, async (): Promise<Removal | { kept: string } | undefined> => {
    const info = await rpc.getAccountInfo(order);
    const kept = info ? viewOrder(order, info.data).state : null;
    if (kept === 'Pending') return undefined;
    // Gone, or kept in a final state: the removing transaction decides (keep polling until the RPC has indexed it).
    return (await removalOf(order, ours)) ?? (kept ? { kept } : undefined);
  });
  console.log('');
  if (!outcome) return 'pending';
  if ('kept' in outcome) throw new Error(`order ${order.toBase58()} is ${outcome.kept} but still on chain (not removed yet); STEP=status re-polls it`);
  const where = `in ${outcome.signature} by ${outcome.payer} (slot ${outcome.slot}, ${outcome.latencyS === null ? 'latency unknown' : `${outcome.latencyS} s after ours`})\n  ${link(outcome.signature)}`;
  if (outcome.state === 'Cancelled') throw new Error(`the exchange CANCELLED order ${order.toBase58()} (reason "${outcome.reason}") ${where}\n  it never executed; the collateral and rent went back to the wallet`);
  if (outcome.state !== 'Completed' || !outcome.trade) throw new Error(`order ${order.toBase58()} was removed as ${outcome.state} (reason "${outcome.reason}") without a TradeEvent, so it did not execute, ${where}`);
  console.log(`  executed (OrderRemoved Completed, reason "${outcome.reason}") ${where}`);
  const event = outcome.trade;
  const fees = event.fees as Record<string, bigint>;
  const feesUsdc = fees.order_fee_for_receiver_amount! + fees.order_fee_for_pool_amount! + fees.total_borrowing_fee_amount! + fees.funding_fee_amount!;
  const out = event.transfer_out as Record<string, bigint>;
  const paidOutUsdc = BigInt(out.final_output_token!) + BigInt(out.long_token!) + BigInt(out.short_token!);
  const after = event.after as Record<string, bigint>;
  const pnl = (event.pnl as Record<string, bigint>).pnl!;
  console.log(`  execution price ${px(m, event.execution_price as bigint)} · fees ${usdc(feesUsdc)} (order ${usdc(fees.order_fee_for_receiver_amount! + fees.order_fee_for_pool_amount!)}, borrowing ${usdc(fees.total_borrowing_fee_amount!)}, funding ${usdc(fees.funding_fee_amount!)}) · price impact ${usd(event.price_impact_value as bigint)} · P&L ${usd(pnl)} · paid out ${usdc(paidOutUsdc)} · position after ${usd(after.size_in_usd!)} with ${usdc(after.collateral_amount!)} collateral`);
  const fill: Fill = { step, signature: outcome.signature, keeper: outcome.payer, executionPrice: priceString(event.execution_price as bigint, m.decimals, 4), pnlUsd: pnl, feesUsdc, impactUsd: event.price_impact_value as bigint, paidOutUsdc };
  state.fills.push(fill);
  saveState(state);
  console.log(`  ${describePosition(m, await readPosition(m))}`);
  return fill;
}

// ---- prerequisites ----
async function rentFor(len: number): Promise<number> {
  return rpc.getMinimumBalanceForRentExemption(len);
}
/** What an open may take from the wallet (`CreateOrderCpi::invoke`'s bound): order + escrow + fee, the same again as the position's liquidation reserve, user and position rent. */
async function openCostLamports(wv: WalletView, positionExists: boolean): Promise<number> {
  const orderCost = (await rentFor(LEN.tokenAccount)) + (await rentFor(LEN.order)) + EXECUTION_LAMPORTS;
  return orderCost * (positionExists ? 1 : 2) + (wv.userExists ? 0 : await rentFor(LEN.user)) + (positionExists ? 0 : await rentFor(LEN.position)) + 10_000;
}

function refuseOrWarn(problems: string[]): void {
  if (!problems.length) return;
  for (const p of problems) console.log(`  MISSING: ${p}`);
  if (!DRY_RUN) throw new Error('prerequisites not met; nothing sent');
  console.log('  dry run: continuing to the simulation anyway (it will fail where the chain checks these)');
}

async function checkOpen(m: MarketView, wv: WalletView): Promise<void> {
  const problems: string[] = [];
  if (!m.enabled) problems.push('the market is disabled on the exchange');
  if (m.closed || !m.price.isOpen) problems.push('the market is closed (outside its trading session)');
  if (m.price.ageS > 20) problems.push(`the price is ${m.price.ageS} s old (stale)`);
  if (m.capacityLong <= 0n) problems.push(`no long capacity on ${m.symbol} right now (open interest at the pool's reserve cap)`);
  if (m.maxSizeLong !== null && m.maxSizeLong < SIZE_USD) problems.push(`the largest new long the pool takes is ${usd(m.maxSizeLong)}, size asked ${usd(SIZE_USD)}`);
  if (SIZE_USD < m.minPositionSizeUsd) problems.push(`size ${usd(SIZE_USD)} is below the market minimum ${usd(m.minPositionSizeUsd)}`);
  if (COLLATERAL * 10n ** 14n < m.minCollateralUsd) problems.push(`collateral ${usdc(COLLATERAL)} is below the market minimum ${usd(m.minCollateralUsd)}`);
  const leverage = Number(SIZE_USD / 10n ** 14n) / Number(COLLATERAL);
  if (leverage > m.maxLeverageLong) problems.push(`leverage ${leverage.toFixed(1)}x is above the market maximum ${m.maxLeverageLong}x`);
  if (wv.usdc < COLLATERAL) problems.push(`USDC: have ${usdc(wv.usdc)}${wv.hasUsdcAccount ? '' : ' (no USDC account)'}, need ${usdc(COLLATERAL)}: send ${usdc(COLLATERAL - wv.usdc)} more to ${owner.toBase58()}`);
  const need = await openCostLamports(wv, (await readPosition(m)) !== null);
  if (wv.lamports < need) problems.push(`SOL: have ${sol(wv.lamports)}, need about ${sol(need)} for rent and fees (most of it comes back when the order and position close): send ${sol(need - wv.lamports)} more`);
  refuseOrWarn(problems);
}

// ---- steps ----
function recordBaseline(wv: WalletView): void {
  if (DRY_RUN || state.baseline) return;
  state.baseline = { usdc: wv.usdc.toString(), lamports: wv.lamports, at: new Date().toISOString() };
  saveState(state);
}

async function stepOpen(m: MarketView, wv: WalletView, timeoutMs = 120_000): Promise<'executed' | 'pending' | 'dry'> {
  console.log(`\n== open: MarketIncrease long ${usd(SIZE_USD)} with ${usdc(COLLATERAL)} on ${m.symbol} ==`);
  await checkOpen(m, wv);
  const acceptable = (m.price.mid * (10_000n + SLIPPAGE_BPS)) / 10_000n;
  const { seq, nonce, order } = await nextNonce();
  const built = createOrderInstructions(m, { kind: 'MarketIncrease', collateral: COLLATERAL, size: SIZE_USD, trigger: null, acceptable, nonce });
  console.log(`  order ${order.toBase58()} (counter ${seq}) · escrow ${built.escrow.toBase58()} · position ${built.position.toBase58()} · acceptable ${px(m, acceptable)} (mark + 0.5 %) · min output none`);
  recordBaseline(wv);
  const signature = await run('create order', built.instructions);
  if (!signature) return 'dry';
  state.seq = seq + 1;
  saveState(state);
  if ((await settle(m, 'open', order, signature, timeoutMs, 3_000)) === 'pending') {
    console.log(`not executed yet: order ${order.toBase58()} is still open. STEP=status re-polls it; STEP=cancel-all refunds it.`);
    return 'pending';
  }
  return 'executed';
}

/** `tp` (LimitDecrease, trigger above entry) or `sl` (StopLossDecrease, trigger below entry) closing the whole long. */
async function stepTrigger(m: MarketView, kind: 'LimitDecrease' | 'StopLossDecrease', bps: bigint, timeoutMs = 120_000, intervalMs = 3_000): Promise<'executed' | 'resting' | 'dry'> {
  const [step, label] = kind === 'LimitDecrease' ? ['tp', 'take-profit'] : ['sl', 'stop-loss'];
  const position = await readPosition(m);
  if (positionSize(position) === 0n) throw new Error(`no open long on ${m.symbol} to place a ${label} on`);
  const entry = entryPrice(position!);
  // A long's stop sits below entry; SL_BPS < 0 puts it above entry, i.e. above the mark right after a fill, so the exchange fills it at once (a cheap execution proof of the kind).
  const delta = kind === 'LimitDecrease' ? bps : -bps;
  const trigger = (entry * (10_000n + delta)) / 10_000n;
  console.log(`\n== ${step}: ${kind} long ${usd(position!.state.size_in_usd)} (close all) at ${px(m, trigger)} = entry ${px(m, entry)} ${delta < 0n ? '−' : '+'} ${delta < 0n ? -delta : delta} bps (mark ${px(m, m.price.mid)}) ==`);
  const { seq, nonce, order } = await nextNonce();
  const built = createOrderInstructions(m, { kind, collateral: 0n, size: position!.state.size_in_usd, trigger, acceptable: null, nonce });
  console.log(`  order ${order.toBase58()} (counter ${seq}) · escrow ${built.escrow.toBase58()}`);
  const signature = await run(`create ${label}`, built.instructions);
  if (!signature) return 'dry';
  state.seq = seq + 1;
  saveState(state);
  if ((await settle(m, step, order, signature, timeoutMs, intervalMs)) === 'pending') {
    console.log(`resting: ${label} ${order.toBase58()} waits for ${px(m, trigger)}. STEP=status re-polls it; STEP=close cancels it and closes the position at market; STEP=cancel-all removes it.`);
    return 'resting';
  }
  return 'executed';
}

async function stepClose(m: MarketView, timeoutMs = 120_000): Promise<'flat' | 'pending' | 'dry'> {
  const position = await readPosition(m);
  if (positionSize(position) === 0n) {
    console.log(`\n== close: nothing to close, ${describePosition(m, position)} ==`);
    return 'flat';
  }
  const acceptable = (m.price.mid * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  console.log(`\n== close: MarketDecrease long ${usd(position!.state.size_in_usd)} (close all) · acceptable ${px(m, acceptable)} (mark − 0.5 %) ==`);
  // A resting take-profit or stop-loss would race the close (the exchange cancels the loser) or outlive it, aimed at the wallet's next position here.
  const { orders } = await ownerAccounts();
  for (const o of orders.filter((o) => o.marketToken === m.marketToken.toBase58() && o.state === 'Pending' && o.kind.endsWith('Decrease'))) {
    console.log(`  cancelling resting ${describeOrder(m, o)} first`);
    await run(`close order ${o.address.toBase58()}`, closeOrderInstructions(o));
  }
  const { seq, nonce, order } = await nextNonce();
  const built = createOrderInstructions(m, { kind: 'MarketDecrease', collateral: 0n, size: position!.state.size_in_usd, trigger: null, acceptable, nonce });
  console.log(`  order ${order.toBase58()} (counter ${seq}) · escrow ${built.escrow.toBase58()}`);
  const signature = await run('create close', built.instructions);
  if (!signature) return 'dry';
  state.seq = seq + 1;
  saveState(state);
  if ((await settle(m, 'close', order, signature, timeoutMs, 3_000)) === 'pending') {
    console.log(`not executed yet: close order ${order.toBase58()} is still open. STEP=status re-polls it; STEP=cancel-all refunds it.`);
    return 'pending';
  }
  return 'flat';
}

async function stepCancelAll(m: MarketView): Promise<number> {
  const { orders } = await ownerAccounts();
  const mine = orders.filter((o) => o.marketToken === m.marketToken.toBase58());
  console.log(`\n== cancel-all: ${mine.length} order(s) of ${owner.toBase58()} on ${m.symbol}${orders.length > mine.length ? ` (${orders.length - mine.length} on other markets left alone)` : ''} ==`);
  for (const o of mine) {
    console.log(`  ${describeOrder(m, o)}`);
    const before = await readWallet();
    const signature = await run(`close order ${o.address.toBase58()}`, closeOrderInstructions(o));
    if (!signature) continue;
    const after = await readWallet();
    const removed = await removalIn(signature);
    console.log(`  OrderRemoved ${removed ? `${removed.state}, reason "${removed.reason}"` : 'not found in our transaction'} · refunded ${usdc(after.usdc - before.usdc)} and ${sol(after.lamports - before.lamports)} (rent and the unspent execution fee, less the transaction fee)`);
  }
  return mine.length;
}

/** `close_empty_position` as the owner (the program's `gmtrade::close_empty_position`): a flat position's rent and liquidation reserve come back. */
async function stepClosePosition(m: MarketView): Promise<void> {
  const address = gmPositionPda(owner, m.marketToken, true);
  const info = await rpc.getAccountInfo(address);
  const position = info ? decodePosition(info.data.toString('base64')) : null;
  console.log(`\n== close-position: close_empty_position of ${describePosition(m, position)}${info ? ` holding ${sol(info.lamports)}` : ''} ==`);
  if (!info) throw new Error(`this wallet has no position account on ${m.symbol}`);
  if (positionSize(position) > 0n) throw new Error('the position is not empty: STEP=close first');
  const before = await rpc.getBalance(owner);
  const signature = await run('close empty position', [gmInstruction('close_empty_position', [w(owner, true), r(GMTRADE_STORE), w(address)], {})]);
  if (!signature) return;
  console.log(`  refunded ${sol((await rpc.getBalance(owner)) - before)} (rent and liquidation reserve, less the transaction fee)`);
}

async function stepStatus(m: MarketView, wv: WalletView): Promise<void> {
  console.log(`\n== status of ${owner.toBase58()} ==`);
  console.log(`  balances: ${sol(wv.lamports)} · ${usdc(wv.usdc)}${wv.hasUsdcAccount ? '' : ' (no USDC account yet)'} · exchange user account ${wv.userExists ? gmUserPda(owner).toBase58() : 'not created'}`);
  const { orders, positions } = await ownerAccounts();
  console.log(`  positions: ${positions.length}`);
  for (const p of positions) {
    const onMarket = p.position.market_token === m.marketToken.toBase58();
    console.log(`    ${p.address.toBase58()}: ${p.position.kind === 1 ? 'long' : 'short'} ${usd(p.position.state.size_in_usd)} · collateral ${usdc(p.position.state.collateral_amount)}${p.position.state.size_in_tokens > 0n && onMarket ? ` · entry ${px(m, entryPrice(p.position))}` : ''}${onMarket ? '' : ` (market token ${p.position.market_token})`}`);
  }
  console.log(`  orders: ${orders.length}`);
  for (const o of orders) console.log(`    ${describeOrder(m, o)}`);
  if (state.baseline) {
    const b = state.baseline;
    const inFlight = positions.reduce((s, p) => s + p.position.state.collateral_amount, 0n) + orders.reduce((s, o) => s + o.collateral, 0n);
    console.log(`  since ${b.at} (baseline ${usdc(BigInt(b.usdc))}, ${sol(b.lamports)}):`);
    console.log(`    USDC: ${signed(wv.usdc - BigInt(b.usdc), (v) => usdc(v))}${inFlight ? ` (${usdc(inFlight)} still held as collateral or escrow)` : ' realized'}`);
    const fees = state.fills.reduce((s, f) => s + f.feesUsdc, 0n);
    const pnl = state.fills.reduce((s, f) => s + f.pnlUsd, 0n);
    if (state.fills.length) console.log(`    ${state.fills.length} fill(s): exchange fees ${usdc(fees)} · price P&L ${signed(pnl, usd)} · impact ${signed(state.fills.reduce((s, f) => s + f.impactUsd, 0n), usd)}`);
    console.log(`    SOL: ${signed(BigInt(wv.lamports - b.lamports), sol)} (transaction and execution fees, plus rent the exchange still holds: user account${positions.length ? ', position(s) with their liquidation reserve' : ''}${orders.length ? ', open order(s)' : ''})`);
  } else console.log('  no baseline yet (the first live open records one)');
  console.log(`  state file: ${STATE_PATH}`);
}
const signed = (v: bigint, fmt: (abs: bigint) => string) => `${v < 0n ? '-' : '+'}${fmt(v < 0n ? -v : v)}`;

async function stepAll(m: MarketView): Promise<void> {
  const before = await readWallet();
  console.log(`\n== all: open → sl → tp (up to 10 min) → close → cancel leftovers → status · wallet before: ${usdc(before.usdc)}, ${sol(before.lamports)} ==`);
  const opened = await stepOpen(m, before);
  if (opened !== 'executed') return;
  // The stop-loss rests (SL_BPS > 0) or fills at once (SL_BPS < 0); the take-profit is waited on; close cancels whatever still rests.
  await stepTrigger(m, 'StopLossDecrease', SL_BPS, 60_000, 3_000);
  if (positionSize(await readPosition(m)) > 0n) await stepTrigger(m, 'LimitDecrease', TP_BPS, 600_000, 5_000);
  await stepClose(await readMarket(MARKET));
  const leftover = await stepCancelAll(m);
  if (leftover) console.log(`  ${leftover} resting order(s) removed so nothing can hit a future position`);
  const after = await readWallet();
  await stepStatus(m, after);
  const fees = state.fills.reduce((s, f) => s + f.feesUsdc, 0n);
  const pnl = state.fills.reduce((s, f) => s + f.pnlUsd, 0n);
  console.log(`\n== summary ==\n  USDC before ${usdc(before.usdc)} · after ${usdc(after.usdc)} · net ${signed(after.usdc - before.usdc, (v) => usdc(v))}\n  exchange fees paid ${usdc(fees)} (this run's fills) · price P&L ${signed(pnl, usd)}\n  SOL spent ${sol(before.lamports - after.lamports)} (fees + rent still held by the exchange: user account, empty position with its reserve; STEP=close-position recovers the position's)`);
}

// ---- main ----
async function main(): Promise<void> {
  console.log(`exchange round-trip probe · ${DRY_RUN ? 'DRY RUN (simulate only)' : 'LIVE'} · ${RPC_URL} · wallet ${owner.toBase58()}`);
  const m = await readMarket(MARKET);
  printMarket(m);
  const wv = await readWallet();
  console.log(`wallet: ${sol(wv.lamports)} · ${usdc(wv.usdc)}${wv.hasUsdcAccount ? '' : ' (no USDC account)'} · exchange user account ${wv.userExists ? 'exists' : 'missing (prepare_user will create it)'}`);
  switch (STEP) {
    case 'status': return stepStatus(m, wv);
    case 'open': {
      const r = await stepOpen(m, wv);
      if (r === 'pending') process.exitCode = 2;
      return;
    }
    case 'tp': {
      await stepTrigger(m, 'LimitDecrease', TP_BPS);
      return;
    }
    case 'sl': {
      await stepTrigger(m, 'StopLossDecrease', SL_BPS);
      return;
    }
    case 'close': {
      const r = await stepClose(m);
      if (r === 'pending') process.exitCode = 2;
      return;
    }
    case 'cancel-all': {
      await stepCancelAll(m);
      return;
    }
    case 'close-position': return stepClosePosition(m);
    case 'all': return stepAll(m);
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
