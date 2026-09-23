// Leader election on a Postgres session advisory lock, held on a dedicated single-connection client. A crashed or
// partitioned process loses the lock with its session; money-moving loops run only inside `run`.
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import postgres from 'postgres';

/** Advisory lock keys in use (one namespace for the whole app). */
export const LOCK_KEYS = { keeper: 0x70726f70 } as const; // "prop"

export interface LeaderOptions {
  databaseUrl: string;
  key: number;
  signal: AbortSignal;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  /** How often to retry the lock as follower, and to confirm it is still held as leader. */
  intervalMs?: number;
  /** Runs while leader; must stop promptly once `lost` aborts (shutdown, or the lock's session is gone). */
  run: (lost: AbortSignal) => Promise<void>;
}

/** Competes for leadership until `signal` aborts. Resolves once the last term has ended and the lock is released. */
export async function runAsLeader({ databaseUrl, key, signal, log, intervalMs = 5_000, run }: LeaderOptions): Promise<void> {
  // The lock lives and dies with this one session, so the client must never recycle it on a timer: postgres-js
  // otherwise closes every connection after a random 30–60 min (max_lifetime), silently releasing the lock.
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 0, max_lifetime: null, onnotice: () => {} });
  // Asks "does THIS session hold the lock", so a silent reconnect of the client cannot fake continued leadership.
  const held = async () => {
    const [row] = await sql<{ held: boolean }[]>`
      select exists (select 1 from pg_locks where locktype = 'advisory' and classid = 0 and objid = ${key}
        and objsubid = 1 and granted and pid = pg_backend_pid()) as held`;
    return row?.held === true;
  };

  try {
    while (!signal.aborted) {
      try {
        const [row] = await sql<{ locked: boolean }[]>`select pg_try_advisory_lock(${key}::int) as locked`;
        if (row?.locked) await lead();
      } catch (err) {
        log.error({ err, key }, 'leader election failed');
      }
      await sleep(intervalMs, undefined, { signal }).catch(() => {});
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  async function lead() {
    log.info({ key }, 'leadership acquired');
    const term = new AbortController();
    const stop = () => term.abort();
    signal.addEventListener('abort', stop, { once: true });
    const check = setInterval(async () => {
      const ok = await held().catch(() => false);
      if (!ok && !term.signal.aborted) {
        log.warn({ key }, 'leadership lost');
        term.abort();
      }
    }, intervalMs);
    try {
      await run(term.signal);
    } finally {
      clearInterval(check);
      signal.removeEventListener('abort', stop);
      await sql`select pg_advisory_unlock(${key}::int)`.catch(() => {});
      log.info({ key }, 'leadership released');
    }
  }
}
