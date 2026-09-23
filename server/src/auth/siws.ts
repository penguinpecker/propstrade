// Sign-In With Solana: the message (built in @props/shared/siws, which the app checks against its own origin before
// signing), its nonce and the signature check.
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

export { SIWS_STATEMENT, buildSiwsMessage, type SiwsFields } from '@props/shared/siws';

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
