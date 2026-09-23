import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Connection, TransactionInstruction, VersionedTransactionResponse } from '@solana/web3.js';
import { utils } from '@coral-xyz/anchor';
import { GMTRADE_PROGRAM_ID, GMTRADE_STORE, PROPS_VAULT_PROGRAM_ID, USDC_MINT } from './constants.ts';
import { gmEventAuthority, gmStoreWallet } from './gmtrade.ts';
import type { InvokedInstruction } from './client.ts';
import { capitalVaultAddress, configPda, eventAuthorityPda, solTreasuryPda, vaultAuthorityPda } from './pda.ts';

/**
 * Measured on the mainnet GMTrade binary: an open ≈ 140–155k CU; an open plus a stop-loss in one
 * transaction ≈ 255–321k (it varies with the PDA bump searches of the order and position addresses). Pass
 * `computeUnits` to tighten it for single instructions.
 */
export const DEFAULT_COMPUTE_UNITS = 400_000;

export function computeBudgetInstructions(p: { units?: number; microLamportsPerUnit?: number } = {}): TransactionInstruction[] {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: p.units ?? DEFAULT_COMPUTE_UNITS })];
  if (p.microLamportsPerUnit) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.microLamportsPerUnit }));
  return ixs;
}

/** Builds an unsigned v0 transaction with a compute budget prefix and optional lookup tables. */
export function buildTransaction(p: {
  payer: PublicKey;
  instructions: TransactionInstruction[];
  recentBlockhash: string;
  lookupTables?: AddressLookupTableAccount[];
  computeUnits?: number;
  microLamportsPerUnit?: number;
}): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: p.payer,
    recentBlockhash: p.recentBlockhash,
    instructions: [...computeBudgetInstructions({ units: p.computeUnits, microLamportsPerUnit: p.microLamportsPerUnit }), ...p.instructions],
  }).compileToV0Message(p.lookupTables ?? []);
  return new VersionedTransaction(message);
}

export async function fetchLookupTables(connection: Connection, addresses: PublicKey[]): Promise<AddressLookupTableAccount[]> {
  const tables = await Promise.all(addresses.map((a) => connection.getAddressLookupTable(a)));
  return tables.map((t, i) => {
    if (!t.value) throw new Error(`lookup table ${addresses[i]!.toBase58()} not found`);
    return t.value;
  });
}

/** Static accounts shared by props_vault trading instructions: good contents for a Props lookup table. */
export function sharedLookupAddresses(): PublicKey[] {
  return [
    PROPS_VAULT_PROGRAM_ID,
    eventAuthorityPda(),
    configPda(),
    vaultAuthorityPda(),
    capitalVaultAddress(),
    solTreasuryPda(),
    USDC_MINT,
    GMTRADE_PROGRAM_ID,
    GMTRADE_STORE,
    gmStoreWallet(),
    gmEventAuthority(),
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    ComputeBudgetProgram.programId,
  ];
}

/** Instructions that create a lookup table owned by `authority` and fill it with `addresses` (≤ 30 per extend). */
export function createLookupTableInstructions(p: {
  authority: PublicKey;
  payer: PublicKey;
  recentSlot: number;
  addresses: PublicKey[];
}): { address: PublicKey; instructions: TransactionInstruction[] } {
  const [create, address] = AddressLookupTableProgram.createLookupTable({ authority: p.authority, payer: p.payer, recentSlot: p.recentSlot });
  const instructions: TransactionInstruction[] = [create];
  for (let i = 0; i < p.addresses.length; i += 30) {
    instructions.push(
      AddressLookupTableProgram.extendLookupTable({
        lookupTable: address,
        authority: p.authority,
        payer: p.payer,
        addresses: p.addresses.slice(i, i + 30),
      }),
    );
  }
  return { address, instructions };
}

/** Every inner instruction (CPI) of a confirmed transaction, in execution order, with its program resolved. */
export function innerInstructionsOf(tx: Pick<VersionedTransactionResponse, 'transaction' | 'meta'>): InvokedInstruction[] {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
  return [...(tx.meta?.innerInstructions ?? [])]
    .sort((a, b) => a.index - b.index)
    .flatMap((group) => group.instructions.map((ix) => ({ programId: keys.get(ix.programIdIndex)!, data: utils.bytes.bs58.decode(ix.data) })));
}
