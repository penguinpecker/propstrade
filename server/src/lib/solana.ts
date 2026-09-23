import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';
import type { Config } from '../config.js';

export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** A base58 ed25519 public key in canonical form. */
export const walletSchema = z.string().max(44).refine((v) => {
  try {
    return new PublicKey(v).toBase58() === v;
  } catch {
    return false;
  }
}, 'must be a base58 public key');

export function createConnection(config: Pick<Config, 'RPC_URL' | 'RPC_WS_URL'>): Connection {
  return new Connection(config.RPC_URL, { commitment: 'confirmed', wsEndpoint: config.RPC_WS_URL });
}

/**
 * Loads a signing key from an env var holding a 64-byte secret key as base58 or a JSON byte array
 * (the solana-keygen file format). Returns undefined when unset. Errors never include the value.
 */
export function loadKeypair(env: Record<string, string | undefined>, name: string): Keypair | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = raw.startsWith('[') ? Uint8Array.from(z.array(z.int().min(0).max(255)).parse(JSON.parse(raw))) : bs58.decode(raw);
  } catch {
    throw new Error(`${name} is not a base58 string or JSON byte array`);
  }
  if (bytes.length !== 64) throw new Error(`${name} must hold a 64-byte secret key`);
  try {
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error(`${name} secret key does not match its public key half`);
  }
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

/** Integer base units → decimal string without trailing zeros ("1.5", "0", "12.345678"). */
export function formatUnits(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** SPL token account `amount` (u64 LE at byte 64). */
export function tokenAccountAmount(data: Buffer): bigint {
  return data.readBigUInt64LE(64);
}
