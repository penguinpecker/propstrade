// Watches every outside service marketdata depends on, so /v1/health says which one is failing, since when, why, and
// what the service does meanwhile, and the log records each outage and recovery once instead of on every request.
import type { UpstreamStatus } from '@props/shared';

export type { UpstreamStatus };

/** Consecutive failures that make a source 'down' (fewer are 'degraded'). */
const DOWN_AFTER = 3;

/** Why a call failed, in words for the health report, which is public: without the service's URL (it names the venue
 *  and may carry a key) and without the venue's name. */
export function why(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } } | undefined;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /no answer within/.test(e?.message ?? '')) return 'no answer in time';
  if (e?.cause?.code) return `network error (${e.cause.code})`;
  return String(e?.message ?? err).replace(/[a-z][\w+.-]*:\/\/\S+?(:\s|\s|$)/gi, '').replace(/gmtrade/gi, 'exchange').slice(0, 200);
}

export function createUpstreams(fallbacks: Record<string, string>, onChange: (name: string, status: UpstreamStatus) => void) {
  const runs = new Map<string, { failures: number; since: number | null; lastOkAt: number | null; lastError: string | null; latencyMs: number | null }>();
  const run = (name: string) => {
    let r = runs.get(name);
    if (!r) runs.set(name, (r = { failures: 0, since: null, lastOkAt: null, lastError: null, latencyMs: null }));
    return r;
  };
  const status = (name: string): UpstreamStatus => {
    const r = run(name);
    const state: UpstreamStatus['state'] = r.failures ? (r.failures < DOWN_AFTER ? 'degraded' : 'down') : r.lastOkAt ? 'ok' : 'checking';
    return { state, since: r.since, lastOkAt: r.lastOkAt, lastError: r.lastError, latencyMs: r.latencyMs, fallback: fallbacks[name] ?? '' };
  };

  return {
    async track<T>(name: string, call: () => Promise<T>): Promise<T> {
      const r = run(name);
      const started = Date.now();
      try {
        const value = await call();
        const recovered = r.failures >= DOWN_AFTER;
        Object.assign(r, { failures: 0, since: null, lastOkAt: Date.now(), lastError: null, latencyMs: Date.now() - started });
        if (recovered) onChange(name, status(name));
        return value;
      } catch (err) {
        r.failures += 1;
        r.since ??= started;
        r.lastError = why(err);
        if (r.failures === DOWN_AFTER) onChange(name, status(name));
        throw err;
      }
    },
    status,
    report: (): Record<string, UpstreamStatus> => Object.fromEntries([...runs.keys()].map((name) => [name, status(name)])),
  };
}

/** `promise`, or a rejection once `ms` pass. The promise keeps running (and can still fill a cache). */
export function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
