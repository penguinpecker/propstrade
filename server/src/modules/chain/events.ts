// props_vault events as the indexer stores them (program_events.data) and projects them: Anchor's decoded values
// turned into JSON — u64/i64/u128 as decimal strings, pubkeys base58, [u8; 32] as hex, enums by variant name.
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import BN from 'bn.js';
import { innerInstructionsOf, type PropsVaultClient } from '@props/sdk';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export function toJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (BN.isBN(value)) return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) {
    // The only number arrays in the IDL's events are [u8; 32] hashes.
    return value.length > 0 && value.every((v) => typeof v === 'number') ? Buffer.from(value).toString('hex') : value.map(toJson);
  }
  const entries = Object.entries(value as object);
  // Anchor decodes a unit enum variant as { variantName: {} }.
  const [only] = entries;
  if (entries.length === 1 && only![1] !== null && typeof only![1] === 'object' && Object.keys(only![1]).length === 0) return only![0];
  return Object.fromEntries(entries.map(([k, v]) => [k, toJson(v)]));
}

type U64 = string;
type Key = string;
type OrderType = 'market' | 'limit' | 'close' | 'takeProfit' | 'stopLoss';
interface SlotSnapshot { marketToken: Key; isLong: boolean; sizeUsd: U64; collateral: U64; pendingUsd: U64 }

/** Every event the program emits (programs/props_vault/src/events.rs), camelCase as Anchor names them. */
export type VaultEvent =
  | { name: 'configChanged'; data: { change: string; subject: Key; paused: { newEvaluations: boolean; trading: boolean; payouts: boolean }; ts: U64 } }
  | { name: 'capitalDeposited'; data: { amount: U64; capitalVaultBalance: U64; ts: U64 } }
  | { name: 'capitalWithdrawn'; data: { amount: U64; to: Key; capitalVaultBalance: U64; ts: U64 } }
  | { name: 'feesSwept'; data: { amount: U64; ts: U64 } }
  | { name: 'solTreasuryWithdrawn'; data: { lamports: U64; to: Key; ts: U64 } }
  | { name: 'identitySet'; data: { profile: Key; wallet: Key; identityHash: string; ts: U64 } }
  | { name: 'evaluationPurchased'; data: { evaluation: Key; trader: Key; tierId: number; tierVersion: number; feePaid: U64; ts: U64 } }
  | { name: 'evaluationResolved'; data: { evaluation: Key; trader: Key; passed: boolean; finalEquity: U64; tradesRoot: string; ts: U64 } }
  | { name: 'fundedActivated'; data: { funded: Key; evaluation: Key; trader: Key; owner: Key; principal: U64; ownerLamports: U64; ts: U64 } }
  | { name: 'orderRequested'; data: {
    funded: Key; order: Key; marketToken: Key; isLong: boolean; orderType: OrderType; sizeDeltaUsd: U64; collateral: U64;
    triggerPrice: U64; acceptablePrice: U64; by: Key; ts: U64;
  } }
  | { name: 'protectionSet'; data: {
    funded: Key; order: Key; marketToken: Key; isLong: boolean; orderType: OrderType; sizeDeltaUsd: U64; triggerPrice: U64; ts: U64;
  } }
  | { name: 'orderUpdated'; data: { funded: Key; order: Key; sizeDeltaUsd: U64 | null; triggerPrice: U64 | null; acceptablePrice: U64 | null; ts: U64 } }
  | { name: 'orderCancelled'; data: { funded: Key; order: Key; by: Key; ts: U64 } }
  | { name: 'completedOrderClosed'; data: { funded: Key; order: Key; ts: U64 } }
  | { name: 'synced'; data: { funded: Key; slots: SlotSnapshot[]; ordersDropped: Key[]; ts: U64 } }
  | { name: 'ownerToppedUp'; data: { funded: Key; lamports: U64; ts: U64 } }
  | { name: 'payoutRequested'; data: {
    funded: Key; request: Key; seq: number; balance: U64; profit: U64; traderAmount: U64; vaultAmount: U64; ts: U64;
  } }
  | { name: 'payoutCancelled'; data: { funded: Key; request: Key; ts: U64 } }
  | { name: 'payoutPaid'; data: { funded: Key; request: Key; trader: Key; traderAmount: U64; vaultAmount: U64; ts: U64 } }
  | { name: 'payoutRejected'; data: { funded: Key; request: Key; reasonCode: number; ts: U64 } }
  | { name: 'accountRestricted'; data: { funded: Key; restricted: boolean; ts: U64 } }
  | { name: 'accountBreached'; data: { funded: Key; ts: U64 } }
  | { name: 'accountClosed'; data: { funded: Key; principal: U64; usdcReturned: U64; lamportsReturned: U64; ts: U64 } };

export type VaultEventName = VaultEvent['name'];

export type ConfirmedTx = Pick<VersionedTransactionResponse, 'transaction' | 'meta'>;

/**
 * props_vault events of a confirmed transaction, in emission order. The program emits each one as a self-CPI, which
 * the transaction records as an inner instruction: unlike log lines, nothing a transaction adds can cut them off.
 */
export function parseVaultEvents(client: PropsVaultClient, tx: ConfirmedTx): VaultEvent[] {
  return client.parseEvents(innerInstructionsOf(tx)).map((e) => ({ name: e.name, data: toJson(e.data) }) as VaultEvent);
}

/** Whether a transaction invoked `programId`, as one of its instructions or through another program. */
export function invokes(tx: ConfirmedTx, programId: PublicKey): boolean {
  const { message } = tx.transaction;
  const keys = message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
  return message.compiledInstructions.some((ix) => keys.get(ix.programIdIndex)?.equals(programId))
    || innerInstructionsOf(tx).some((ix) => ix.programId.equals(programId));
}
