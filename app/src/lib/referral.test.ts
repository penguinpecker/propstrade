import { describe, expect, it } from 'vitest';
import { REFERRAL_MAX_AGE_MS, captureReferral, clearReferral, normalizeReferral, saveReferral, savedReferral } from './referral';

/** A localStorage stand-in. */
function memory(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, String(v)); }, removeItem: (k: string) => { map.delete(k); }, map } as unknown as Storage & { map: Map<string, string> };
}
/** The page's address and history: what captureReferral reads and rewrites. */
function page(href: string) {
  const win = { location: { href }, replaced: undefined as unknown, history: { state: { kept: true } as unknown, replaceState(state: unknown, _: string, url: string): void { win.location.href = url; win.replaced = state; } } };
  return win;
}
const NOW = 1_800_000_000_000;

describe('normalizeReferral', () => {
  it('trims and upper-cases a code of 4 to 16 letters and digits, and refuses anything else', () => {
    expect(normalizeReferral(' 7xk2abcd ')).toBe('7XK2ABCD');
    expect(normalizeReferral('abcd')).toBe('ABCD');
    expect(normalizeReferral('A'.repeat(16))).toBe('A'.repeat(16));
    for (const bad of ['abc', 'A'.repeat(17), 'ab cd', 'abcd-1', 'ﬀﬀab', '<script>', '', null, 42, { code: 'ABCD' }]) expect(normalizeReferral(bad)).toBeNull();
  });
});

describe('the kept code', () => {
  it('reads back what was saved for 30 days, then nothing', () => {
    const storage = memory();
    saveReferral('7XK2ABCD', storage, NOW);
    expect(savedReferral(storage, NOW + REFERRAL_MAX_AGE_MS)).toBe('7XK2ABCD');
    expect(savedReferral(storage, NOW + REFERRAL_MAX_AGE_MS + 1)).toBeNull();
    expect(savedReferral(storage, NOW - 1)).toBeNull(); // saved "in the future": a clock that moved, or a hand edit
    clearReferral(storage);
    expect(storage.map.size).toBe(0);
  });

  it('reads junk as no code', () => {
    for (const junk of ['not json', '"7XK2ABCD"', '42', 'null', '[]', '{"code":"7XK2ABCD"}', `{"code":"7XK2ABCD","at":"${NOW}"}`, `{"code":"no way","at":${NOW}}`, `{"code":["7XK2ABCD"],"at":${NOW}}`])
      expect(savedReferral(memory({ 'props.referral': junk }), NOW), junk).toBeNull();
    expect(savedReferral(memory({ 'props.referral': `{"code":"7xk2abcd","at":${NOW}}` }), NOW)).toBe('7XK2ABCD'); // a hand-edited case
  });

  it('works without storage, and when storage throws', () => {
    const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } } as unknown as Storage;
    expect(() => saveReferral('ABCD', throwing, NOW)).not.toThrow();
    expect(savedReferral(throwing, NOW)).toBeNull();
    expect(() => clearReferral(throwing)).not.toThrow();
    expect(savedReferral(null, NOW)).toBeNull();
  });
});

describe('captureReferral', () => {
  it('keeps the code of ?ref= in the query and takes it out of the address, route and history state untouched', () => {
    const storage = memory();
    const win = page('https://props.trade/?ref=7xk2abcd#/trade/funded');
    captureReferral(win, storage, NOW);
    expect(savedReferral(storage, NOW)).toBe('7XK2ABCD');
    expect(win.location.href).toBe('https://props.trade/#/trade/funded');
    expect(win.replaced).toEqual({ kept: true });
  });

  it('reads ?ref= in the hash query of any route and keeps the route\'s other parameters', () => {
    const storage = memory();
    const win = page('https://props.trade/?utm=x#/account/funded?id=abc&ref=Abcd1234');
    captureReferral(win, storage, NOW);
    expect(savedReferral(storage, NOW)).toBe('ABCD1234');
    expect(win.location.href).toBe('https://props.trade/?utm=x#/account/funded?id=abc');
    const bare = page('https://props.trade/#/connect?ref=abcd1234');
    captureReferral(bare, storage, NOW);
    expect(bare.location.href).toBe('https://props.trade/#/connect');
  });

  it('a newer link replaces the kept code; a malformed one keeps it but still leaves the address', () => {
    const storage = memory();
    captureReferral(page('https://props.trade/?ref=FIRST111'), storage, NOW);
    captureReferral(page('https://props.trade/?ref=SECOND22'), storage, NOW);
    expect(savedReferral(storage, NOW)).toBe('SECOND22');
    const win = page('https://props.trade/?ref=%3Cscript%3E#/connect');
    captureReferral(win, storage, NOW);
    expect(savedReferral(storage, NOW)).toBe('SECOND22');
    expect(win.location.href).toBe('https://props.trade/#/connect');
  });

  it('leaves an address without ?ref= alone', () => {
    const storage = memory();
    const win = page('https://props.trade/?reference=1#/search?q=ref');
    captureReferral(win, storage, NOW);
    expect(win.replaced).toBeUndefined();
    expect(win.location.href).toBe('https://props.trade/?reference=1#/search?q=ref');
    expect(storage.map.size).toBe(0);
  });
});
