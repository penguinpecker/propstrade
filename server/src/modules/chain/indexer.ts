// props_vault indexer: a logs subscription only wakes a gap-free catch-up that pages getSignaturesForAddress back to
// the last processed signature, then applies every transaction oldest-first. Each transaction's events, projections
// and the cursor commit together, so restarts and duplicate deliveries neither skip nor double-apply anything.
import { setTimeout as sleep } from 'node:timers/promises';
import type { ConfirmedSignatureInfo, Connection, PublicKey } from '@solana/web3.js';
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { PropsVaultClient } from '@props/sdk';
import type { Db } from '../../db/client.ts';
import { indexerCursors, programEvents } from '../../db/schema.ts';
import { parseVaultEvents, type VaultEvent } from './events.ts';
import { project, type Notice, type ProjectDeps } from './projector.ts';

const PAGE = 1_000;
/** Notifications are for news: events older than this (a first backfill, a long outage) are indexed silently. */
const NOTIFY_WITHIN_MS = 3_600_000;

export interface IndexerDeps extends ProjectDeps {
  db: Db;
  rpc: Pick<Connection, 'getSignaturesForAddress' | 'getTransaction' | 'onLogs' | 'removeOnLogsListener'>;
  client: PropsVaultClient;
  programId: PublicKey;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  notify(n: Notice): Promise<void>;
  /** Called with each applied transaction's events (after commit). */
  onApplied(events: VaultEvent[]): void;
}

export function createIndexer(d: IndexerDeps) {
  const program = d.programId.toBase58();

  async function cursor(): Promise<string | undefined> {
    const [row] = await d.db.select({ signature: indexerCursors.signature }).from(indexerCursors).where(eq(indexerCursors.program, program));
    return row?.signature;
  }

  /** Signatures after the cursor, oldest first. */
  async function pending(until: string | undefined): Promise<ConfirmedSignatureInfo[]> {
    const newestFirst: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await d.rpc.getSignaturesForAddress(d.programId, { before, until, limit: PAGE }, 'confirmed');
      newestFirst.push(...page);
      if (page.length < PAGE) return newestFirst.reverse();
      before = page.at(-1)!.signature;
    }
  }

  async function fetchTransaction(signature: string) {
    // A signature can be listed a moment before its transaction is served.
    for (let attempt = 0; attempt < 5; attempt++) {
      const tx = await d.rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (tx?.meta) return tx;
      await sleep(400 * (attempt + 1));
    }
    throw new Error(`transaction ${signature} is not available yet`);
  }

  async function apply(info: ConfirmedSignatureInfo): Promise<VaultEvent[]> {
    let events: VaultEvent[] = [];
    let fee = 0n;
    let blockTime = info.blockTime ?? null;
    if (!info.err) {
      const tx = await fetchTransaction(info.signature);
      events = parseVaultEvents(d.client, tx);
      fee = BigInt(tx.meta!.fee);
      blockTime = tx.blockTime ?? blockTime;
    }
    const txInfo = { signature: info.signature, slot: info.slot, fee };
    const notices = await d.db.transaction(async (tx) => {
      const out: Notice[] = [];
      for (const [i, ev] of events.entries()) {
        const fresh = await tx.insert(programEvents).values({
          signature: info.signature, eventIndex: i, slot: info.slot, blockTime: blockTime === null ? null : new Date(blockTime * 1000),
          name: ev.name, data: ev.data,
        }).onConflictDoNothing().returning({ i: programEvents.eventIndex });
        if (fresh.length) out.push(...(await project(tx, ev, i, txInfo, d)));
      }
      await tx.insert(indexerCursors).values({ program, signature: info.signature, slot: info.slot })
        .onConflictDoUpdate({ target: indexerCursors.program, set: { signature: info.signature, slot: info.slot, updatedAt: sql`now()` } });
      return out;
    });
    if (blockTime !== null && Date.now() - blockTime * 1000 < NOTIFY_WITHIN_MS) {
      for (const n of notices) await d.notify(n).catch((err: unknown) => d.log.warn({ err }, 'notification failed'));
    }
    return events;
  }

  /** Applies every transaction after the cursor; returns how many it applied. */
  async function catchUp(signal?: AbortSignal): Promise<number> {
    const list = await pending(await cursor());
    let applied = 0;
    for (const info of list) {
      if (signal?.aborted) break;
      const events = await apply(info);
      applied++;
      if (events.length) d.onApplied(events);
    }
    if (applied) d.log.info({ applied }, 'indexed props_vault transactions');
    return applied;
  }

  /** Catches up on every program log notification, and at least every `pollMs` (the subscription is best-effort). */
  async function run(signal: AbortSignal, pollMs = 10_000): Promise<void> {
    let woken = false;
    let wake = () => {};
    const pause = (ms: number, interruptible: boolean) => new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        wake = () => {};
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
      if (interruptible) wake = done;
    });
    const subscription = d.rpc.onLogs(d.programId, () => {
      woken = true;
      wake();
    }, 'confirmed');
    let failures = 0;
    try {
      while (!signal.aborted) {
        woken = false;
        try {
          await catchUp(signal);
          failures = 0;
        } catch (err) {
          failures++;
          d.log.error({ err }, 'indexer catch-up failed; retrying');
        }
        if (failures) await pause(Math.min(60_000, 1_000 * 2 ** failures), false);
        else if (!woken) await pause(pollMs, true);
      }
    } finally {
      await d.rpc.removeOnLogsListener(subscription).catch(() => {});
    }
  }

  return { catchUp, run };
}
