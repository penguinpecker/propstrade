// Test-only Wallet Standard wallet for the browser tests: ed25519 keys held by the test process, signing through a
// function the test exposes to the page (`__testWalletSign`). Never shipped with the app.
import { generateKeyPairSync, sign } from 'node:crypto';
import bs58 from 'bs58';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function testKeys(count = 2) {
  return Array.from({ length: count }, () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519_PREFIX.length);
    return { address: bs58.encode(raw), publicKey: [...raw], privateKey };
  });
}

/** Exposes signing to the page; `onSign` sees every signature request. */
export async function exposeSigner(context, keys, onSign = () => {}) {
  await context.exposeFunction('__testWalletSign', (address, bytes) => {
    onSign(address, bytes);
    return [...sign(null, Buffer.from(bytes), keys.find(k => k.address === address).privateKey)];
  });
}

/**
 * Runs in the page (context.addInitScript). `trusted` wallets also approve the silent connect the wallet adapter makes
 * on page load, like a wallet that already trusts the site.
 */
export function installTestWallet({ accounts, trusted = false }) {
  const chains = ['solana:mainnet'];
  const standardAccounts = accounts.map(({ address, publicKey }) =>
    Object.freeze({ address, publicKey: new Uint8Array(publicKey), chains, features: ['solana:signMessage', 'solana:signTransaction'] }));
  const listeners = new Set();
  let current = 0, connected = false, rejectNext = false;
  const rejection = () => Object.assign(new Error('User rejected the request.'), { code: 4001 });
  const wallet = {
    version: '1.0.0',
    name: 'Props Test Wallet',
    icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#8552cc"/></svg>'),
    chains,
    get accounts() { return connected ? [standardAccounts[current]] : []; },
    features: {
      // Like a locked or untrusted wallet: silent (page-load) connects are refused unless trusted, interactive ones approved.
      'standard:connect': { version: '1.0.0', connect: async input => {
        if (input?.silent && !trusted) throw rejection();
        connected = true;
        return { accounts: wallet.accounts };
      } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { connected = false; } },
      'standard:events': { version: '1.0.0', on: (event, listener) => { listeners.add(listener); return () => listeners.delete(listener); } },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async ({ account, message }) => {
          if (rejectNext) { rejectNext = false; throw rejection(); }
          return [{ signedMessage: message, signature: new Uint8Array(await window.__testWalletSign(account.address, [...message])) }];
        },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        // Wire format: compact-u16 signature count (< 128 here), the signatures, then the message. The fee payer signs first.
        signTransaction: async (...inputs) => Promise.all(inputs.map(async ({ account, transaction }) => {
          if (rejectNext) { rejectNext = false; throw rejection(); }
          const signatures = transaction[0];
          const signature = await window.__testWalletSign(account.address, [...transaction.slice(1 + 64 * signatures)]);
          const signedTransaction = new Uint8Array(transaction);
          signedTransaction.set(signature, 1);
          return { signedTransaction };
        })),
      },
    },
  };
  window.__testWallet = {
    switchAccount() { current = 1 - current; listeners.forEach(listener => listener({ accounts: wallet.accounts })); },
    rejectNextSign() { rejectNext = true; },
  };
  // Wallet Standard registration protocol (same as @wallet-standard/wallet registerWallet).
  const register = ({ register }) => register(wallet);
  window.addEventListener('wallet-standard:app-ready', ({ detail }) => register(detail));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
}
