import { createContext, createElement, lazy, Suspense, useContext, useState, type ReactNode } from 'react';
import type { VersionedTransaction } from '@solana/web3.js';

const appId = import.meta.env.VITE_PRIVY_APP_ID || null;
/** A build with a Privy app id signs in with Google only. Builds without one (local tests) use browser wallets. */
export const GOOGLE_ONLY = appId !== null;

/** How the app names the Privy wallet wherever it names the connected wallet. */
export const PRIVY_WALLET = 'Google';
/** Google's "G" mark, for the option that signs in with Google. */
export const PRIVY_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>')}`;

/**
 * The Solana wallet Privy creates and keeps for a trader who signs in with Google (Privy's embedded wallet). It signs
 * without a prompt: the app signs each action the trader confirms in the app.
 */
export interface PrivyWallet {
  address: string | null;
  /** Google sign-in is starting, or the wallet is being created. */
  pending: boolean;
  /** Google sign-in (the page leaves for Google and comes back), or the wallet when a signed-in user has none. */
  open(): Promise<void>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
  disconnect(): Promise<void>;
}

const Context = createContext<PrivyWallet | null>(null);
/** null until the Privy SDK has loaded, and always in a build without VITE_PRIVY_APP_ID (browser wallets only). */
export const usePrivyWallet = () => useContext(Context);

// The Privy SDK is large, so it loads after the app has rendered. It sits beside the app, not around it, so nothing remounts.
const Bridge = lazy(() => import('./privy-bridge'));

export function WithPrivy({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<PrivyWallet | null>(null);
  return createElement(Context.Provider, { value: wallet }, children,
    appId && createElement(Suspense, { fallback: null }, createElement(Bridge, { appId, onChange: setWallet })));
}
