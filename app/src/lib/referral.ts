// Referral codes. A trader's code is the start of their wallet address, upper-cased: codes match without regard to case.
// A visitor's code (from a `?ref=` link, or typed at sign-up) is kept in this browser until the sign-in that binds it
// (App.jsx). localStorage is a trust boundary: every read is validated, and anything malformed or older than
// REFERRAL_MAX_AGE_MS reads as no code.

const KEY = 'props.referral';
/** How long a link's code waits for its visitor to sign up. */
export const REFERRAL_MAX_AGE_MS = 30 * 86_400_000;

const store = (): Storage | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** The code as the service matches it (trimmed, upper-cased), or null when it cannot be one: 4 to 16 letters and digits. */
export function normalizeReferral(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim();
  return /^[A-Za-z0-9]{4,16}$/.test(code) ? code.toUpperCase() : null;
}

export function saveReferral(code: string, storage = store(), now = Date.now()) {
  try { storage?.setItem(KEY, JSON.stringify({ code, at: now })); } catch { /* private mode: the sign-up field still holds it */ }
}

/** The kept code, or null when there is none, it is malformed, or it is older than REFERRAL_MAX_AGE_MS. Reading never writes. */
export function savedReferral(storage = store(), now = Date.now()): string | null {
  try {
    const saved = JSON.parse(storage?.getItem(KEY) ?? 'null') as { code?: unknown; at?: unknown } | null;
    const at = saved?.at;
    return typeof at === 'number' && now - at >= 0 && now - at <= REFERRAL_MAX_AGE_MS ? normalizeReferral(saved?.code) : null;
  } catch {
    return null;
  }
}

export function clearReferral(storage = store()) {
  try { storage?.removeItem(KEY); } catch { /* nothing was kept */ }
}

/**
 * Keeps the code of a `?ref=` link (in the query or in the hash's, on any route) and takes the parameter out of the
 * address, so a reload or a copy of the address does not bring it back once it is bound.
 */
export function captureReferral(win: { location: { href: string }; history: Pick<History, 'state' | 'replaceState'> } = window, storage = store(), now = Date.now()) {
  const url = new URL(win.location.href);
  const [path = '', search = ''] = url.hash.split('?');
  const inHash = new URLSearchParams(search);
  const raw = url.searchParams.get('ref') ?? inHash.get('ref');
  if (raw === null) return;
  const code = normalizeReferral(raw);
  if (code) saveReferral(code, storage, now);
  url.searchParams.delete('ref');
  inHash.delete('ref');
  const rest = inHash.toString();
  url.hash = rest ? `${path}?${rest}` : path;
  win.history.replaceState(win.history.state, '', url.href);
}
