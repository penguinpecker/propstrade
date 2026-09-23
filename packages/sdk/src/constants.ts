import { PublicKey } from '@solana/web3.js';
import idl from './idl/props_vault.json' with { type: 'json' };

/** props_vault program id (mainnet and the local test environments use the same key). */
export const PROPS_VAULT_PROGRAM_ID = new PublicKey(idl.address);

/** Circle USDC on Solana mainnet: the only collateral, fee and payout token. */
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const USDC_DECIMALS = 6;

/** GMTrade store program (release v0.10.0) and the store props_vault pins at initialize. */
export const GMTRADE_PROGRAM_ID = new PublicKey('Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo');
export const GMTRADE_STORE = new PublicKey('CTDLvGGXnoxvqLyTpGzdGLg9pD6JexKxKXSV8tqqo8bN');

/** GMTrade USD values (sizes, open interest) are integers with 1 USD = 10^20. */
export const GM_USD_DECIMALS = 20;
/** Program USD limits (account size, position caps) are micro-USD, like USDC base units. */
export const MICRO_USD_DECIMALS = 6;
export const BPS = 10_000;
/** Close the whole position (GMTrade caps the decrease to the position size). */
export const CLOSE_ALL = (1n << 128n) - 1n;
