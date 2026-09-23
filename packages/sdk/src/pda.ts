import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { PROPS_VAULT_PROGRAM_ID, USDC_MINT } from './constants.ts';

const text = new TextEncoder();
export const seed = (s: string): Uint8Array => text.encode(s);

export function u16le(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

export function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

const pda = (seeds: Uint8Array[], programId = PROPS_VAULT_PROGRAM_ID): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

export const configPda = (): PublicKey => pda([seed('config')]);
/** Data-less authority of the capital and fee vaults. */
export const vaultAuthorityPda = (): PublicKey => pda([seed('vault')]);
export const feeVaultPda = (): PublicKey => pda([seed('fee_vault')]);
/** ATA(vault authority, USDC). */
export const capitalVaultAddress = (): PublicKey => getAssociatedTokenAddressSync(USDC_MINT, vaultAuthorityPda(), true);
export const solTreasuryPda = (): PublicKey => pda([seed('sol_treasury')]);
export const tierPda = (id: number): PublicKey => pda([seed('tier'), u16le(id)]);
export const marketConfigPda = (marketToken: PublicKey): PublicKey => pda([seed('market'), marketToken.toBytes()]);
export const traderProfilePda = (wallet: PublicKey): PublicKey => pda([seed('trader'), wallet.toBytes()]);
export const identityLockPda = (identityHash: Uint8Array): PublicKey => pda([seed('identity'), identityHash]);
export const evaluationPda = (wallet: PublicKey, index: number): PublicKey =>
  pda([seed('evaluation'), wallet.toBytes(), u32le(index)]);
export const fundedPda = (evaluation: PublicKey): PublicKey => pda([seed('funded'), evaluation.toBytes()]);
/** Data-less, system-owned signer that owns a funded account's GMTrade user, positions, orders and USDC. */
export const ownerPda = (funded: PublicKey): PublicKey => pda([seed('owner'), funded.toBytes()]);
export const ownerUsdcAddress = (funded: PublicKey): PublicKey => getAssociatedTokenAddressSync(USDC_MINT, ownerPda(funded), true);
export const payoutPda = (funded: PublicKey, seq: number): PublicKey => pda([seed('payout'), funded.toBytes(), u32le(seq)]);
