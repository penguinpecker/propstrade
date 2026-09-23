// Loaded lazily by privy.ts. Everything that imports the Privy SDK lives here.
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PrivyProvider, useLogin, usePrivy, type PrivyClientConfig } from '@privy-io/react-auth';
import { useCreateWallet, useSignMessage, useSignTransaction, useWallets } from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import { WalletNotConnectedError, WalletSignMessageError, WalletSignTransactionError } from '@solana/wallet-adapter-base';
import { VersionedTransaction } from '@solana/web3.js';
import { env } from './env';
import type { PrivyWallet } from './privy';

const rpcUrl = env.rpcUrl!; // main.jsx refuses to start without one
const config: PrivyClientConfig = {
  loginMethods: ['email'],
  // The symbol has no intrinsic size (viewBox only), so the logo is an element with one.
  appearance: { theme: 'dark', accentColor: '#b28aff', logo: createElement('img', { src: '/brand/symbol.svg', alt: 'Props.trade', width: 58, height: 45 }), walletChainType: 'solana-only' },
  // Privy simulates each request before showing it to the trader, reading through the app's RPC. It only opens the websocket to
  // follow a transaction it sent itself, and this app sends its own, so that URL is never used.
  solana: { rpcs: { 'solana:mainnet': { rpc: createSolanaRpc(rpcUrl), rpcSubscriptions: createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, 'ws')) } } },
};

// Declines arrive as Privy errors; wallet-adapter errors carry them to describeError, which words them for the trader.
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
  const { login } = useLogin({
    onComplete: ({ user }) => {
      if (!flow.current) return; // also called on page load for a trader who is already signed in to Privy
      void ensureWallet(user.linkedAccounts.some(a => a.type === 'wallet' && a.chainType === 'solana' && a.walletClientType === 'privy'));
    },
    onError: code => finish(code === 'exited_auth_flow' ? undefined : new Error(`Email sign-in did not complete (${code}). Try again.`)),
  });

  // Privy's hooks return new functions on every render: the wallet handed to the app changes only with its address or
  // pending state (anything more re-renders the app into a loop), and reads the latest of everything else when called.
  const latest = useRef({ ready, authenticated, wallet, login, logout, ensureWallet, signMessage, signTransaction });
  latest.current = { ready, authenticated, wallet, login, logout, ensureWallet, signMessage, signTransaction };
  const address = wallet?.address ?? null;

  const value = useMemo<PrivyWallet>(() => ({
    address,
    pending,
    open: () => new Promise<void>((resolve, reject) => {
      const { ready, authenticated, wallet, login, ensureWallet } = latest.current;
      if (wallet) return resolve();
      if (!ready) return reject(new Error('Email sign-in is still loading. Try again in a moment.'));
      flow.current?.resolve();
      flow.current = { resolve, reject };
      setPending(true);
      if (authenticated) void ensureWallet(false); // signed in to Privy, but the wallet was never created
      else login();
    }),
    async signMessage(message) {
      const { wallet, signMessage } = latest.current;
      if (!wallet) throw new WalletNotConnectedError();
      return (await signMessage({ message, wallet }).catch(asWalletError(WalletSignMessageError))).signature;
    },
    async signTransaction(tx) {
      const { wallet, signTransaction } = latest.current;
      if (!wallet) throw new WalletNotConnectedError();
      const { signedTransaction } = await signTransaction({ transaction: tx.serialize(), wallet, chain: 'solana:mainnet' })
        .catch(asWalletError(WalletSignTransactionError));
      return VersionedTransaction.deserialize(signedTransaction);
    },
    disconnect: () => latest.current.logout(),
  }), [address, pending]);

  useEffect(() => { onChange(value); }, [onChange, value]);
  return null;
}

export default function PrivyBridge({ appId, onChange }: { appId: string; onChange(wallet: PrivyWallet): void }) {
  return createElement(PrivyProvider, { appId, config, children: createElement(Bridge, { onChange }) });
}
