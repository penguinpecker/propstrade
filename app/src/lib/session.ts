import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletError, WalletNotReadyError, WalletReadyState, type WalletName } from '@solana/wallet-adapter-base';
import bs58 from 'bs58';
import type { AppConfig, Me } from '@props/shared';
import { api, ApiRequestError } from './api';
import { env, type Cluster } from './env';
import { clearUserData, keys, meOptions, useConfig, useMe } from './queries';

export type SessionStatus = 'no-wallet' | 'disconnected' | 'connecting' | 'needs-sign-in' | 'signing' | 'signed-in';
/** `wrong` blocks sign-in; `unreachable` only warns (sign-in does not need the RPC). */
export interface NetworkCheck { state: 'checking' | 'ok' | 'wrong' | 'unreachable'; reason?: string }
export interface WalletOption { name: WalletName; icon: string }

export interface Session {
  status: SessionStatus;
  /** Detected wallets (Wallet Standard auto-detection plus the mobile adapter on phones). */
  wallets: WalletOption[];
  walletName: WalletName | null;
  /** Address of the connected wallet account (may differ from `me.wallet` until signed in). */
  address: string | null;
  me: Me | null;
  network: NetworkCheck;
  /** Plain-English reason for the last failure or session change, cleared by the next action. */
  notice: string | null;
  connect(name: WalletName): void;
  signIn(): Promise<void>;
  disconnect(): Promise<void>;
}

const CLUSTER_NAMES: Record<Cluster, string> = { 'mainnet-beta': 'Solana mainnet', localnet: 'a local Solana validator' };

/** Compares the RPC genesis hash and the API's deployment with the cluster this build targets. */
export function checkNetwork(
  expected: { cluster: Cluster; genesisHash: string | null; programId: string | null },
  rpcGenesisHash: string | undefined,
  config: Pick<AppConfig, 'cluster' | 'programId'> | undefined,
  rpcFailed = false,
): NetworkCheck {
  const target = CLUSTER_NAMES[expected.cluster];
  if (expected.genesisHash && rpcGenesisHash && rpcGenesisHash !== expected.genesisHash)
    return { state: 'wrong', reason: `The Solana connection is not on ${target}. Transactions are disabled.` };
  if (config && config.cluster !== expected.cluster)
    return { state: 'wrong', reason: `The Props.trade service runs on ${CLUSTER_NAMES[config.cluster]}, not ${target}.` };
  if (config && expected.programId && config.programId !== expected.programId)
    return { state: 'wrong', reason: 'The Props.trade service uses a different program than this app. Reload to update.' };
  if (rpcFailed) return { state: 'unreachable', reason: 'The Solana connection is not responding. Wallet actions may fail until it recovers.' };
  if ((expected.genesisHash && !rpcGenesisHash) || !config) return { state: 'checking' };
  return { state: 'ok' };
}

export function describeError(error: unknown): string {
  if (error instanceof WalletNotReadyError) return 'This wallet is not available in this browser.';
  if (error instanceof WalletError) {
    const cause = error.error as { code?: number; message?: string } | undefined;
    if (cause?.code === 4001 || /reject|declin|denied|cancel/i.test(`${error.message} ${cause?.message ?? ''}`))
      return 'The request was declined in your wallet.';
    return error.message || cause?.message || 'Your wallet reported an error. Try again.';
  }
  if (error instanceof ApiRequestError) return error.message;
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}

export function useSession(): Session {
  const { wallets, wallet, publicKey, connecting, select, signMessage, disconnect: disconnectWallet } = useWallet();
  const { connection } = useConnection();
  const client = useQueryClient();
  const meQuery = useMe();
  const me = meQuery.data;
  const config = useConfig().data;
  const genesis = useQuery({
    queryKey: ['genesis', connection.rpcEndpoint],
    queryFn: () => connection.getGenesisHash(),
    enabled: env.genesisHash !== null,
    staleTime: Infinity,
  });
  const network = checkNetwork(env, genesis.data, config, genesis.isError);

  const [notice, setNotice] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const wantsSignIn = useRef(false);
  const ending = useRef(false);
  const address = publicKey?.toBase58() ?? null;
  const adapter = wallet?.adapter ?? null;

  // Connection and signing errors arrive as adapter events (the provider's autoConnect has no caller to throw to).
  useEffect(() => {
    if (!adapter) return;
    const onError = (error: WalletError) => {
      if (!adapter.publicKey) { // failed while connecting
        if (!wantsSignIn.current) return; // the silent reconnect on page load; the user asked for nothing
        wantsSignIn.current = false;
      }
      setNotice(describeError(error));
    };
    adapter.on('error', onError);
    return () => { adapter.off('error', onError); };
  }, [adapter]);

  const endSession = useCallback(async (reason: string | null) => {
    ending.current = true;
    client.setQueryData(keys.me, null);
    clearUserData(client);
    setNotice(reason);
    // A failed logout leaves only a cookie that this app no longer uses; it expires server-side.
    await api.logout().catch(() => undefined);
    ending.current = false;
  }, [client]);

  const signIn = useCallback(async () => {
    if (!address) return;
    if (network.state === 'wrong') { setNotice(network.reason ?? null); return; }
    if (!signMessage) { setNotice('This wallet cannot sign messages, so it cannot sign in. Choose another wallet.'); return; }
    setSigning(true);
    setNotice(null);
    try {
      const { message } = await api.nonce(address);
      if (!message.includes(address)) throw new Error('The sign-in message does not name this wallet, so it was not signed.');
      const signature = await signMessage(new TextEncoder().encode(message));
      await api.verify({ wallet: address, message, signature: bs58.encode(signature) });
      // The profile comes from /v1/me. Drop any read that started before the cookie existed, then read it fresh.
      await client.cancelQueries({ queryKey: keys.me });
      const profile = await client.fetchQuery(meOptions);
      if (profile?.wallet !== address) // the API accepted the signature, but this browser did not send its cookie back
        throw new Error('This browser did not keep the sign-in. Allow cookies for this site, then sign in again.');
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setSigning(false);
    }
  }, [address, client, network.state, network.reason, signMessage]);

  const connect = useCallback((name: WalletName) => {
    setNotice(null);
    if (adapter?.name === name && address) {
      if (me?.wallet !== address) void signIn();
      return;
    }
    wantsSignIn.current = true;
    select(name);
  }, [adapter, address, me, select, signIn]);

  const disconnect = useCallback(async () => {
    wantsSignIn.current = false;
    await endSession(null);
    await disconnectWallet().catch(() => undefined); // the wallet reports its own failure through the error event
  }, [disconnectWallet, endSession]);

  // A connection the user asked for continues straight into sign-in once /v1/me has answered.
  useEffect(() => {
    if (!wantsSignIn.current || !address || !meQuery.isFetched) return;
    wantsSignIn.current = false;
    if (me?.wallet !== address) void signIn();
  }, [address, me, meQuery.isFetched, signIn]);

  // The session belongs to one wallet account: end it when the wallet switches accounts or disconnects.
  const previousAddress = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousAddress.current;
    previousAddress.current = address;
    if (!me || ending.current) return;
    if (address && address !== me.wallet)
      void endSession(previous === me.wallet ? 'Your wallet switched accounts. Sign in with this account to continue.' : null);
    else if (!address && previous === me.wallet) void endSession('Your wallet disconnected.');
  }, [address, me, endSession]);

  // A session that disappears without us ending it has expired (or was revoked) on the server.
  const previousMe = useRef<Me | null | undefined>(undefined);
  useEffect(() => {
    if (previousMe.current && me === null && !ending.current) setNotice('Your session expired. Sign in again to continue.');
    previousMe.current = me;
  }, [me]);

  const options = wallets
    .filter(w => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable)
    .map(w => ({ name: w.adapter.name, icon: w.adapter.icon }));

  const status: SessionStatus = signing ? 'signing'
    : connecting ? 'connecting'
    : address && me?.wallet === address ? 'signed-in'
    : address ? 'needs-sign-in'
    : options.length ? 'disconnected' : 'no-wallet';

  return { status, wallets: options, walletName: adapter?.name ?? null, address, me: me ?? null, network, notice, connect, signIn, disconnect };
}
