// Sign-In With Solana message, in the exact text layout wallets produce for `solana:signIn`
// (Wallet Standard createSignInMessageText), so the app may use signIn or signMessage interchangeably.
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

export interface SiwsFields {
  domain: string;       // host of APP_ORIGIN, e.g. "props.trade"
  address: string;      // base58 wallet
  statement: string;
  uri: string;          // APP_ORIGIN
  chainId: 'mainnet' | 'localnet';
  nonce: string;
  issuedAt: Date;
  expirationTime: Date;
}

export const SIWS_STATEMENT = 'Sign in to Props.trade. This request does not send a transaction or cost a fee.';

export function buildSiwsMessage(f: SiwsFields): string {
  return [
    `${f.domain} wants you to sign in with your Solana account:`,
    f.address,
    '',
    f.statement,
    '',
    `URI: ${f.uri}`,
    'Version: 1',
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt.toISOString()}`,
    `Expiration Time: ${f.expirationTime.toISOString()}`,
  ].join('\n');
}

export function nonceOf(message: string): string | undefined {
  return /^Nonce: ([A-Za-z0-9]+)$/m.exec(message)?.[1];
}

/** Strict RFC 8032 ed25519 check of a base58 signature over the UTF-8 message by the base58 wallet key. */
export function verifySiwsSignature(message: string, signatureB58: string, walletB58: string): boolean {
  try {
    const sig = bs58.decode(signatureB58);
    const key = bs58.decode(walletB58);
    if (sig.length !== 64 || key.length !== 32) return false;
    return ed25519.verify(sig, new TextEncoder().encode(message), key, { zip215: false });
  } catch {
    return false;
  }
}
