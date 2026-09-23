// Loaded lazily by privy.ts. Everything that imports the Privy SDK lives here.
// Privy's Solana signing reads the Node `Buffer` global when it signs ("Buffer is not defined" left sign-in hanging).
import './buffer';
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PrivyProvider, useLoginWithOAuth, usePrivy, type PrivyClientConfig } from '@privy-io/react-auth';
import { useCreateWallet, useSignMessage, useSignTransaction, useWallets } from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import { WalletNotConnectedError, WalletSignMessageError, WalletSignTransactionError } from '@solana/wallet-adapter-base';
import { VersionedTransaction } from '@solana/web3.js';
import { env } from './env';
import type { PrivyWallet } from './privy';

const rpcUrl = env.rpcUrl!; // main.jsx refuses to start without one
const config: PrivyClientConfig = {
  loginMethods: ['google'],
  // The wallet signs without Privy's confirmation window: the trader's click in the app is the approval. Privy creates
  // the wallet right after the first Google sign-in.
  embeddedWallets: { showWalletUIs: false, solana: { createOnLogin: 'users-without-wallets' } },
  // The symbol has no intrinsic size (viewBox only), so the logo is an element with one.
  appearance: { theme: 'dark', accentColor: '#b28aff', logo: createElement('img', { src: '/brand/symbol.svg', alt: 'Props.trade', width: 58, height: 45 }), walletChainType: 'solana-only' },
  // Privy reads through the app's RPC. It only opens the websocket to follow a transaction it sent itself, and this app
  // sends its own, so that URL is never used.
  solana: { rpcs: { 'solana:mainnet': { rpc: createSolanaRpc(rpcUrl), rpcSubscriptions: createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, 'ws')) } } },
};

// Declines arrive as Privy errors; wallet-adapter errors carry them to describeError, which words them for the trader.
// A request Privy never answers (an error thrown inside its own callbacks) fails here instead of hanging the app.
const SIGN_TIMEOUT_MS = 60_000;
const answered = <T>(request: Promise<T>, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Your Google wallet did not answer the ${what} request. Try again.`)), SIGN_TIMEOUT_MS); });
  return Promise.race([request, late]).finally(() => clearTimeout(timer));
};
const asWalletError = (Kind: typeof WalletSignMessageError) => (error: unknown): never => {
  throw new Kind(error instanceof Error ? error.message : String(error), error);
};

function Bridge({ onChange }: { onChange(wallet: PrivyWallet): void }) {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signMessage } = useSignMessage();
  const { signTransaction } = useSignTransaction();
  const [pending, setPending] = useState(false);
  const flow = useRef<{ resolve(): void; reject(error: unknown): void } | null>(null);
  // Only Privy's own wallet: browser wallets connect through the wallet adapter.
  const wallet = wallets.find(w => (w.standardWallet as { isPrivyWallet?: boolean }).isPrivyWallet) ?? null;

  const finish = useCallback((error?: unknown) => {
    const current = flow.current;
    flow.current = null;
    setPending(false);
    if (error) current?.reject(error); else current?.resolve();
  }, []);
  const ensureWallet = useCallback(async (hasWallet: boolean) => {
    try {
      if (!hasWallet) await createWallet();
      finish();
    } catch (error) {
      finish(error);
    }
  }, [createWallet, finish]);
  // Google sign-in leaves the page and comes back to it: this hook finishes the sign-in on return (then `flow` is empty,
  // and Privy creates the wallet itself).
  const { initOAuth } = useLoginWithOAuth({
    onComplete: ({ user }) => {
      if (!flow.current) return;
      void ensureWallet(user.linkedAccounts.some(a => a.type === 'wallet' && a.chainType === 'solana' && a.walletClientType === 'privy'));
    },
    onError: code => finish(code === 'exited_auth_flow' ? undefined : new Error(`Google sign-in did not complete (${code}). Try again.`)),
  });

  // Privy's hooks return new functions on every render: the wallet handed to the app changes only with its address or
  // pending state (anything more re-renders the app into a loop), and reads the latest of everything else when called.
  const latest = useRef({ ready, authenticated, wallet, initOAuth, logout, ensureWallet, signMessage, signTransaction });
  latest.current = { ready, authenticated, wallet, initOAuth, logout, ensureWallet, signMessage, signTransaction };
  const address = wallet?.address ?? null;

  const value = useMemo<PrivyWallet>(() => ({
    address,
    pending,
    open: () => new Promise<void>((resolve, reject) => {
      const { ready, authenticated, wallet, initOAuth, ensureWallet } = latest.current;
      if (wallet) return resolve();
      if (!ready) return reject(new Error('Google sign-in is still loading. Try again in a moment.'));
      flow.current?.resolve();
      flow.current = { resolve, reject };
      setPending(true);
      if (authenticated) void ensureWallet(false); // signed in to Privy, but the wallet was never created
      else initOAuth({ provider: 'google' }).catch(finish); // leaves the page on success
    }),
    async signMessage(message) {
      const { wallet, signMessage } = latest.current;
      if (!wallet) throw new WalletNotConnectedError();
      return (await answered(signMessage({ message, wallet }), 'sign-in').catch(asWalletError(WalletSignMessageError))).signature;
    },
    async signTransaction(tx) {
      const { wallet, signTransaction } = latest.current;
      if (!wallet) throw new WalletNotConnectedError();
      const { signedTransaction } = await answered(signTransaction({ transaction: tx.serialize(), wallet, chain: 'solana:mainnet' }), 'signature')
        .catch(asWalletError(WalletSignTransactionError));
      return VersionedTransaction.deserialize(signedTransaction);
    },
    disconnect: () => latest.current.logout(),
  }), [address, finish, pending]);

  useEffect(() => { onChange(value); }, [onChange, value]);
  return null;
}

export default function PrivyBridge({ appId, onChange }: { appId: string; onChange(wallet: PrivyWallet): void }) {
  return createElement(PrivyProvider, { appId, config, children: createElement(Bridge, { onChange }) });
}
