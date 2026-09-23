import { createContext, createElement, lazy, Suspense, useContext, useState, type ReactNode } from 'react';
import type { VersionedTransaction } from '@solana/web3.js';

/** How the app names the Privy wallet wherever it names the connected wallet. */
export const PRIVY_WALLET = 'Email wallet';

/** The Solana wallet Privy creates and keeps for a trader who signs up with an email address (Privy's embedded wallet). */
export interface PrivyWallet {
  address: string | null;
  /** The Privy window is open, or the wallet is being created. */
  pending: boolean;
  /** Privy's email sign-in, then the wallet if this user has none. Resolves when it closes; closing it early is not an error. */
  open(): Promise<void>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
  disconnect(): Promise<void>;
}

const Context = createContext<PrivyWallet | null>(null);
/** null until the Privy SDK has loaded, and always in a build without VITE_PRIVY_APP_ID (browser wallets only). */
export const usePrivyWallet = () => useContext(Context);

const appId = import.meta.env.VITE_PRIVY_APP_ID || null;
// The Privy SDK is large, so it loads after the app has rendered. It sits beside the app, not around it, so nothing remounts.
const Bridge = lazy(() => import('./privy-bridge'));

export function WithPrivy({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<PrivyWallet | null>(null);
  return createElement(Context.Provider, { value: wallet }, children,
    appId && createElement(Suspense, { fallback: null }, createElement(Bridge, { appId, onChange: setWallet })));
}
