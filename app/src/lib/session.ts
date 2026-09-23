import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletError, WalletNotReadyError, WalletReadyState, type WalletName } from '@solana/wallet-adapter-base';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import type { AppConfig, Me } from '@props/shared';
import { SIWS_STATEMENT, buildSiwsMessage } from '@props/shared/siws';
import { api, ApiRequestError } from './api';
import { env, type Cluster } from './env';
import { PRIVY_WALLET, usePrivyWallet } from './privy';
import { clearUserData, keys, meOptions, useConfig, useMe } from './queries';

export type SessionStatus = 'no-wallet' | 'disconnected' | 'connecting' | 'needs-sign-in' | 'signing' | 'signed-in';

/**
 * Why a sign-in message from the API must not be signed, or null when it is exactly the message this app's server
 * builds for this wallet, this site (host and origin) and this cluster: any other text could sign the trader in
 * elsewhere, for whoever controls the API.
 */
export function signInMessageProblem(message: string, expected: { address: string; host: string; origin: string; cluster: Cluster }): string | null {
  const field = (name: string) => new RegExp(`^${name}: (.+)$`, 'm').exec(message)?.[1];
  const [nonce, issuedAt, expirationTime] = [field('Nonce'), field('Issued At'), field('Expiration Time')];
  const refused = 'The sign-in message is not for this site or network, so it was not signed.';
  if (!nonce || !issuedAt || !expirationTime || !/^[A-Za-z0-9]+$/.test(nonce)) return refused;
  try {
    const built = buildSiwsMessage({
      domain: expected.host, address: expected.address, statement: SIWS_STATEMENT, uri: expected.origin,
      chainId: expected.cluster === 'mainnet-beta' ? 'mainnet' : 'localnet', nonce, issuedAt: new Date(issuedAt), expirationTime: new Date(expirationTime),
    });
    return built === message ? null : refused;
  } catch { // an invalid date
    return refused;
  }
}
/** `wrong` blocks sign-in; `unreachable` only warns (sign-in does not need the RPC). */
export interface NetworkCheck { state: 'checking' | 'ok' | 'wrong' | 'unreachable'; reason?: string }
/** `email`: the Privy wallet, which needs no browser extension. */
export interface WalletOption { name: WalletName; icon: string; email?: boolean }

export interface Session {
  status: SessionStatus;
  /** Detected wallets (Wallet Standard auto-detection plus the mobile adapter on phones), then the Privy email wallet. */
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
    if (cause?.code === 4001 || /reject|declin|denied|cancel|exited/i.test(`${error.message} ${cause?.message ?? ''}`))
      return 'The request was declined in your wallet.';
    return error.message || cause?.message || 'Your wallet reported an error. Try again.';
  }
  if (error instanceof ApiRequestError) return error.message;
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}

export function useSession(): Session {
  const { wallets, wallet, publicKey, connecting, select, signMessage, disconnect: disconnectWallet } = useWallet();
  const privy = usePrivyWallet();
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
  // One wallet at a time: connecting either kind disconnects the other (connect below).
  const address = privy?.address ?? publicKey?.toBase58() ?? null;
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
    const sign = privy?.address ? privy.signMessage : signMessage;
    if (!sign) { setNotice('This wallet cannot sign messages, so it cannot sign in. Choose another wallet.'); return; }
    setSigning(true);
    setNotice(null);
    try {
      const { message } = await api.nonce(address);
      const problem = signInMessageProblem(message, { address, host: location.host, origin: location.origin, cluster: env.cluster });
      if (problem) throw new Error(problem);
      const signature = await sign(new TextEncoder().encode(message));
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
  }, [address, client, network.state, network.reason, privy, signMessage]);

  const connect = useCallback((name: WalletName) => {
    setNotice(null);
    const email = name === PRIVY_WALLET;
    if (address && (email ? privy?.address : !privy?.address && adapter?.name === name)) {
      if (me?.wallet !== address) void signIn();
      return;
    }
    wantsSignIn.current = true;
    if (!email) {
      if (privy?.address) void privy.disconnect();
      select(name);
      return;
    }
    if (!privy) return;
    if (adapter) void disconnectWallet().catch(() => undefined);
    privy.open().catch(error => { wantsSignIn.current = false; setNotice(describeError(error)); });
  }, [adapter, address, disconnectWallet, me, privy, select, signIn]);

  const disconnect = useCallback(async () => {
    wantsSignIn.current = false;
    await endSession(null);
    await disconnectWallet().catch(() => undefined); // the wallet reports its own failure through the error event
    if (privy?.address) await privy.disconnect().catch(() => undefined);
  }, [disconnectWallet, endSession, privy]);

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
    .map((w): WalletOption => ({ name: w.adapter.name, icon: w.adapter.icon }))
    .concat(privy ? [{ name: PRIVY_WALLET as WalletName, icon: '', email: true }] : []);

  const status: SessionStatus = signing ? 'signing'
    : connecting || privy?.pending ? 'connecting'
    : address && me?.wallet === address ? 'signed-in'
    : address ? 'needs-sign-in'
    : options.length ? 'disconnected' : 'no-wallet';

  const walletName = privy?.address || privy?.pending ? PRIVY_WALLET as WalletName : adapter?.name ?? null;
  return { status, wallets: options, walletName, address, me: me ?? null, network, notice, connect, signIn, disconnect };
}

/** The connected account and its transaction signer: the Privy wallet when that is connected, else the browser wallet. */
export function useSigner() {
  const { publicKey, signTransaction } = useWallet();
  const privy = usePrivyWallet();
  const privyKey = useMemo(() => privy?.address ? new PublicKey(privy.address) : null, [privy?.address]);
  return privy && privyKey ? { publicKey: privyKey, signTransaction: privy.signTransaction } : { publicKey, signTransaction };
}
