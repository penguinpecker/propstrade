// GMTrade (gmsol-store v0.10.0) addresses and the few account fields props_vault relies on.
// Offsets include the 8-byte discriminator and mirror programs/props_vault/src/gmtrade.rs.
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { GMTRADE_PROGRAM_ID, GMTRADE_STORE, USDC_MINT } from './constants.ts';
import { seed } from './pda.ts';

const gmPda = (seeds: Uint8Array[]): PublicKey => PublicKey.findProgramAddressSync(seeds, GMTRADE_PROGRAM_ID)[0];

export const gmEventAuthority = (): PublicKey => gmPda([seed('__event_authority')]);
export const gmStoreWallet = (): PublicKey => gmPda([seed('store_wallet'), GMTRADE_STORE.toBytes()]);
export const gmMarketPda = (marketToken: PublicKey): PublicKey =>
  gmPda([seed('market'), GMTRADE_STORE.toBytes(), marketToken.toBytes()]);
export const gmUserPda = (owner: PublicKey): PublicKey => gmPda([seed('user'), GMTRADE_STORE.toBytes(), owner.toBytes()]);
/** Position of `owner` with USDC collateral; kind 1 = long, 2 = short. */
export const gmPositionPda = (owner: PublicKey, marketToken: PublicKey, isLong: boolean): PublicKey =>
  gmPda([
    seed('position'),
    GMTRADE_STORE.toBytes(),
    owner.toBytes(),
    marketToken.toBytes(),
    USDC_MINT.toBytes(),
    Uint8Array.of(isLong ? 1 : 2),
  ]);
export const gmOrderPda = (owner: PublicKey, nonce: Uint8Array): PublicKey =>
  gmPda([seed('order'), GMTRADE_STORE.toBytes(), owner.toBytes(), nonce]);
/** The order's USDC escrow: ATA(order, USDC). Pure USDC-USDC markets need only this one. */
export const gmOrderEscrow = (order: PublicKey): PublicKey => getAssociatedTokenAddressSync(USDC_MINT, order, true);

/**
 * Nonce of a funded account's order number `seq` (its `orderSeq` when the order is created): the u64
 * little-endian, zero-padded to 32 bytes. The program derives it the same way; traders cannot choose it.
 */
export function orderNonce(seq: bigint): Uint8Array {
  const nonce = new Uint8Array(32);
  new DataView(nonce.buffer).setBigUint64(0, seq, true);
  return nonce;
}

export const POSITION_DISCRIMINATOR = Uint8Array.of(170, 188, 143, 228, 122, 64, 247, 208);
export const ORDER_DISCRIMINATOR = Uint8Array.of(134, 173, 223, 185, 77, 86, 28, 51);
export const MARKET_DISCRIMINATOR = Uint8Array.of(219, 190, 213, 55, 0, 227, 198, 154);

export const POSITION_LAYOUT = {
  length: 680,
  bump: 9,
  store: 10,
  kind: 42,
  owner: 56,
  marketToken: 88,
  collateralToken: 120,
  sizeInTokens: 184,
  collateralAmount: 200,
  sizeInUsd: 216,
} as const;

export const ORDER_LAYOUT = { actionState: 9 } as const;

export const MARKET_LAYOUT = { flags: 10, name: 24, nameLength: 64, marketToken: 88, indexToken: 120, longToken: 152, shortToken: 184, store: 216 } as const;
/** Market flag bits (gmsol-programs model/market.rs `MarketFlag`). */
export const MARKET_FLAG = { enabled: 0, closed: 5 } as const;

const hasPrefix = (data: Uint8Array, prefix: Uint8Array): boolean => prefix.every((b, i) => data[i] === b);
const u128At = (data: Uint8Array, offset: number): bigint => {
  const view = new DataView(data.buffer, data.byteOffset + offset, 16);
  return view.getBigUint64(0, true) | (view.getBigUint64(8, true) << 64n);
};
const keyAt = (data: Uint8Array, offset: number): PublicKey => new PublicKey(data.subarray(offset, offset + 32));

export interface GmPosition {
  store: PublicKey;
  owner: PublicKey;
  marketToken: PublicKey;
  collateralToken: PublicKey;
  isLong: boolean;
  sizeInUsd: bigint;
  sizeInTokens: bigint;
  collateralAmount: bigint;
}

export function decodeGmPosition(data: Uint8Array): GmPosition {
  if (data.length !== POSITION_LAYOUT.length || !hasPrefix(data, POSITION_DISCRIMINATOR)) {
    throw new Error('not an exchange Position account');
  }
  const L = POSITION_LAYOUT;
  return {
    store: keyAt(data, L.store),
    owner: keyAt(data, L.owner),
    marketToken: keyAt(data, L.marketToken),
    collateralToken: keyAt(data, L.collateralToken),
    isLong: data[L.kind] === 1,
    sizeInUsd: u128At(data, L.sizeInUsd),
    sizeInTokens: u128At(data, L.sizeInTokens),
    collateralAmount: u128At(data, L.collateralAmount),
  };
}

/** True while GMTrade holds the order as pending (same rule as the program's sync). */
export function isPendingGmOrder(data: Uint8Array): boolean {
  if (data.length <= ORDER_LAYOUT.actionState || !hasPrefix(data, ORDER_DISCRIMINATOR)) throw new Error('not an exchange Order account');
  return data[ORDER_LAYOUT.actionState] === 0;
}

export interface GmMarketMeta {
  /** e.g. "BTC/USD[USDC-USDC]" or "USD/JPY[USDC-USDC]". */
  name: string;
  marketToken: PublicKey;
  indexToken: PublicKey;
  longToken: PublicKey;
  shortToken: PublicKey;
  store: PublicKey;
  enabled: boolean;
  closed: boolean;
  /** Both pool tokens are USDC: the only markets props_vault trades. */
  pureUsdc: boolean;
}

export function decodeGmMarketMeta(data: Uint8Array): GmMarketMeta {
  if (data.length < MARKET_LAYOUT.store + 32 || !hasPrefix(data, MARKET_DISCRIMINATOR)) {
    throw new Error('not an exchange Market account');
  }
  const L = MARKET_LAYOUT;
  const flags = data[L.flags]!;
  const longToken = keyAt(data, L.longToken);
  const shortToken = keyAt(data, L.shortToken);
  const nameBytes = data.subarray(L.name, L.name + L.nameLength);
  const end = nameBytes.indexOf(0);
  return {
    name: new TextDecoder().decode(end === -1 ? nameBytes : nameBytes.subarray(0, end)),
    marketToken: keyAt(data, L.marketToken),
    indexToken: keyAt(data, L.indexToken),
    longToken,
    shortToken,
    store: keyAt(data, L.store),
    enabled: (flags & (1 << MARKET_FLAG.enabled)) !== 0,
    closed: (flags & (1 << MARKET_FLAG.closed)) !== 0,
    pureUsdc: longToken.equals(USDC_MINT) && shortToken.equals(USDC_MINT),
  };
}
