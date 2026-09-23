// gmsol_store v0.10.0 Market and Position accounts, decoded with the release IDL
// (idl/gmsol_store-0.10.0.json, copied from the crates.io gmsol-programs 0.10.0 crate).
import { readFileSync } from 'node:fs';
import { STORE, STORE_PROGRAM } from './constants.ts';
import { IdlCoder, type Idl } from './idl.ts';
import { findProgramAddress, pubkeyBytes } from './solana.ts';

export const storeIdl = new IdlCoder(
  JSON.parse(readFileSync(new URL('../idl/gmsol_store-0.10.0.json', import.meta.url), 'utf8')) as Idl,
);

/** gmsol-utils MarketFlag bit positions. */
export const MarketFlag = { Enabled: 0, Pure: 1, AdlLong: 2, AdlShort: 3, GtEnabled: 4, Closed: 5 } as const;

interface PoolStorage { pool: { is_pure: number; long_token_amount: bigint; short_token_amount: bigint } }

/** Typed subset of the decoded account (factors 1e20 = 100%, USD 1e20 = $1); every IDL field is present. */
export interface MarketAccount {
  flags: { value: number };
  meta: { market_token_mint: string; index_token_mint: string; long_token_mint: string; short_token_mint: string };
  config: {
    min_position_size_usd: bigint;
    min_collateral_value: bigint;
    min_collateral_factor: bigint;
    min_collateral_factor_for_liquidation: bigint;
    market_closed_min_collateral_factor_for_liquidation: bigint;
    order_fee_factor_for_positive_impact: bigint;
    order_fee_factor_for_negative_impact: bigint;
    max_open_interest_for_long: bigint;
    max_open_interest_for_short: bigint;
  };
  state: {
    pools: { primary: PoolStorage; open_interest_for_long: PoolStorage; open_interest_for_short: PoolStorage };
  };
  virtual_inventory_for_swaps: string;
  virtual_inventory_for_positions: string;
}

export interface PositionAccount {
  store: string;
  /** 1 = long, 2 = short. */
  kind: number;
  created_at: bigint;
  owner: string;
  market_token: string;
  collateral_token: string;
  state: {
    trade_id: bigint;
    increased_at: bigint;
    decreased_at: bigint;
    size_in_tokens: bigint;
    collateral_amount: bigint;
    size_in_usd: bigint;
    borrowing_factor: bigint;
    funding_fee_amount_per_size: bigint;
  };
}

const bytes = (base64: string) => Buffer.from(base64, 'base64');

export function decodeMarket(base64: string): MarketAccount {
  return storeIdl.decodeAccount('Market', bytes(base64)) as unknown as MarketAccount;
}

export function decodePosition(base64: string): PositionAccount {
  return storeIdl.decodeAccount('Position', bytes(base64)) as unknown as PositionAccount;
}

export function hasFlag(market: MarketAccount, flag: number): boolean {
  return ((market.flags.value >> flag) & 1) === 1;
}

/** Market account address: PDA ["market", store, market_token]. */
export const marketAddress = (marketToken: string) =>
  findProgramAddress([Buffer.from('market'), pubkeyBytes(STORE), pubkeyBytes(marketToken)], STORE_PROGRAM);

/** Position account address: PDA ["position", store, owner, market_token, collateral_token, kind]. */
export const positionAddress = (owner: string, marketToken: string, collateralToken: string, isLong: boolean) =>
  findProgramAddress(
    [Buffer.from('position'), pubkeyBytes(STORE), pubkeyBytes(owner), pubkeyBytes(marketToken), pubkeyBytes(collateralToken), Uint8Array.of(isLong ? 1 : 2)],
    STORE_PROGRAM,
  );
