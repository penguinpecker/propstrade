import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useConnection } from '@solana/wallet-adapter-react';
import type { Connection, PublicKey } from '@solana/web3.js';
import type { Execution, OrderFollow, Prepared } from './chain';
import { useConfig } from './queries';
import { describeError, useSigner } from './session';

/** The transaction module (Anchor, spl-token, the program IDL) loads on first use. */
export const loadChain = () => import('./chain');
export type Chain = Awaited<ReturnType<typeof loadChain>>;

export type TxPhase = 'idle' | 'preparing' | 'signing' | 'submitted' | 'awaiting_execution' | 'done' | 'failed';
export interface TxState { phase: TxPhase; message: string | null; signature: string | null }
const IDLE: TxState = { phase: 'idle', message: null, signature: null };
export const TX_BUSY: TxPhase[] = ['preparing', 'signing', 'submitted', 'awaiting_execution'];

/** True when the error proves how a sent transaction ended (failed onchain, or expired without being included). */
export const isFinalTxError = (error: unknown) => error instanceof Error && error.name === 'TxError' && !(error as { uncertain?: boolean }).uncertain;

export interface TxOptions<T> {
  /** Wait for confirmation before finishing (default true). Without it the flow ends once the transaction is sent. */
  confirm?: boolean;
  /** After confirmation: the GMTrade orders the transaction created, followed until a keeper executes or cancels each. */
  execution?: (prepared: T) => OrderFollow[];
  /** Message shown when the flow completes. */
  done?: string;
}
export interface TxResult<T> { prepared: T; signature: string; execution?: Execution }

/**
 * Wallet transactions: prepare (fresh state + blockhash) → simulate → sign → send → confirm, and for GMTrade orders →
 * execution. Only one run at a time may be between prepare and send, so a double click never submits twice; a new run
 * may start while earlier ones are still confirming or awaiting execution, and the state shown is the latest run's.
 * Every run rebuilds the transaction from current chain state, so retrying after a failure is safe.
 */
export function useWalletTransaction() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, autoSigns } = useSigner();
  const programId = useConfig().data?.programId;
  const [state, setState] = useState<TxState>(IDLE);
  const sending = useRef(false);
  const latest = useRef(0);

  const run = useCallback(async <T extends Prepared>(
    prepare: (chain: Chain, connection: Connection, trader: PublicKey) => Promise<T>,
    options: TxOptions<T> = {},
  ): Promise<TxResult<T> | null> => {
    if (sending.current) return null;
    const id = ++latest.current;
    const show = (next: TxState) => { if (latest.current === id) setState(next); };
    if (!publicKey || !signTransaction) {
      show({ phase: 'failed', message: 'Connect a wallet that can sign transactions.', signature: null });
      return null;
    }
    if (!programId) {
      show({ phase: 'failed', message: 'The Props.trade service is not reachable yet. Try again shortly.', signature: null });
      return null;
    }
    let signature: string | null = null;
    let chain: Chain | undefined;
    try {
      let prepared: T;
      sending.current = true;
      try {
        show({ phase: 'preparing', message: null, signature: null });
        const c = chain = await loadChain();
        c.assertProgram(programId);
        prepared = await prepare(c, connection, publicKey);
        // A wallet that signs without a prompt has no approval step to show.
        if (!autoSigns) show({ phase: 'signing', message: null, signature: null });
        signature = await c.signAndSend(connection, prepared, signTransaction).catch((error: unknown) => {
          if (error instanceof c.TxError && error.uncertain && error.signature) return error.signature; // it may still land: follow it
          throw error;
        });
      } finally {
        sending.current = false;
      }
      show({ phase: 'submitted', message: null, signature });
      if (options.confirm !== false) await chain.confirm(connection, signature, prepared.lastValidBlockHeight);
      const follows = options.execution?.(prepared) ?? [];
      if (!follows.length) {
        show({ phase: 'done', message: options.done ?? null, signature });
        return { prepared, signature };
      }
      show({ phase: 'awaiting_execution', message: null, signature });
      const { watchExecution } = chain;
      const outcomes = await Promise.all(follows.map(follow => watchExecution(connection, follow)));
      const execution: Execution = outcomes.includes('cancelled') ? 'cancelled' : outcomes.includes('pending') ? 'pending' : 'executed';
      show(execution === 'cancelled'
        ? { phase: 'failed', message: `The exchange did not execute ${follows.length > 1 ? 'every order' : 'the order'}, for example because the price moved past your slippage tolerance. Any collateral returned to the account.`, signature }
        : { phase: 'done', message: execution === 'executed' ? options.done ?? null : 'Still awaiting execution by the exchange. It stays under Open orders until it executes.', signature });
      return { prepared, signature, execution };
    } catch (error) {
      const known = chain && error instanceof chain.TxError ? error : null;
      show({ phase: 'failed', message: known ? known.message : describeError(error), signature: signature ?? known?.signature ?? null });
      return null;
    }
  }, [autoSigns, connection, programId, publicKey, signTransaction]);

  /** Clears the shown state; runs still in flight keep going but no longer update it. */
  const reset = useCallback(() => { if (sending.current) return; latest.current += 1; setState(IDLE); }, []);
  return { ...state, busy: TX_BUSY.includes(state.phase), sending: state.phase === 'preparing' || state.phase === 'signing', run, reset };
}

/**
 * Builds a transaction without signing it, to show its exact network fee and rent deposit before the wallet prompt.
 * The transaction that is actually signed is built again, from fresh state, when the trader confirms.
 */
export function useTxCost(key: readonly unknown[], prepare: (chain: Chain, connection: Connection, trader: PublicKey) => Promise<Prepared>, enabled = true) {
  const { connection } = useConnection();
  const { publicKey } = useSigner();
  return useQuery({
    queryKey: ['tx-cost', publicKey?.toBase58(), ...key],
    queryFn: async () => {
      const prepared = await prepare(await loadChain(), connection, publicKey!);
      return { feeLamports: prepared.feeLamports, rentLamports: prepared.rentLamports };
    },
    enabled: enabled && publicKey !== null,
    staleTime: 30_000,
    retry: 1,
  });
}
