import { randomInt } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { runAsLeader } from '../src/lib/leader.js';
import { testDatabaseUrl } from './db.js';

const admin = postgres(testDatabaseUrl(), { max: 1 });
afterAll(async () => { await admin.end(); });

const log = { info() {}, warn() {}, error() {} };
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
};

/** One contender (its own process-like client): tracks whether it leads and how many terms it has had. */
function contender(key: number) {
  const stop = new AbortController();
  const state = { leading: false, terms: 0 };
  const done = runAsLeader({
    databaseUrl: testDatabaseUrl(), key, signal: stop.signal, log, intervalMs: 50,
    run: (lost) => new Promise<void>((resolve) => {
      state.leading = true;
      state.terms++;
      lost.addEventListener('abort', () => {
        state.leading = false;
        resolve();
      }, { once: true });
    }),
  });
  return { state, stop: async () => { stop.abort(); await done; } };
}

describe('advisory-lock leader election', () => {
  it('elects exactly one leader and hands over when it stops', async () => {
    const key = randomInt(1, 2 ** 31 - 1);
    const a = contender(key);
    const b = contender(key);
    await until(() => a.state.leading || b.state.leading);
    await new Promise((r) => setTimeout(r, 300)); // several retry rounds: the follower must stay a follower
    expect([a.state.leading, b.state.leading].filter(Boolean)).toHaveLength(1);

    const [leader, follower] = a.state.leading ? [a, b] : [b, a];
    await leader.stop();
    expect(leader.state.leading).toBe(false);
    await until(() => follower.state.leading);
    expect(follower.state.leading).toBe(true);
    await follower.stop();
  });

  it('ends the term when the lock session dies, then competes again', async () => {
    const key = randomInt(1, 2 ** 31 - 1);
    const c = contender(key);
    await until(() => c.state.leading);
    // Kill the backend holding the lock, as a network partition or database failover would.
    await admin`select pg_terminate_backend(pid) from pg_locks
      where locktype = 'advisory' and classid = 0 and objid = ${key} and granted`;
    await until(() => c.state.terms >= 2);
    expect(c.state.terms).toBe(2);
    expect(c.state.leading).toBe(true);
    await c.stop();
    const [row] = await admin`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${key}`;
    expect(row!.n).toBe(0);
  });
});
