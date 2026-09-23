import { Keypair } from '@solana/web3.js';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/routes.js';
import { authNonces, sessions } from '../src/db/schema.js';
import { APP_ORIGIN, makeApp, requestNonce, signIn, signMessage } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { t = await makeApp(); });
afterAll(async () => { await t.close(); });

const verify = (payload: object) => t.app.inject({ method: 'POST', url: '/v1/auth/verify', payload });
const me = (cookie?: string) => t.app.inject({ method: 'GET', url: '/v1/me', headers: cookie ? { cookie } : {} });

describe('Sign-In With Solana', () => {
  it('issues a message bound to the app domain, uri, chain, wallet and a 5-minute nonce', async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const before = Date.now();
    const { message, nonce, expiresAt } = await requestNonce(t.app, wallet);
    const lines = message.split('\n');
    expect(lines[0]).toBe('app.props.test wants you to sign in with your Solana account:');
    expect(lines[1]).toBe(wallet);
    expect(lines).toContain(`URI: ${APP_ORIGIN}`);
    expect(lines).toContain('Chain ID: mainnet');
    expect(lines).toContain(`Nonce: ${nonce}`);
    expect(expiresAt - before).toBeGreaterThan(4.9 * 60_000);
    expect(expiresAt - before).toBeLessThanOrEqual(5 * 60_000 + 1000);
  });

  it('happy path: verify sets an httpOnly Secure SameSite=Lax __Host- cookie that authenticates /v1/me', async () => {
    const keypair = Keypair.generate();
    const wallet = keypair.publicKey.toBase58();
    const { message } = await requestNonce(t.app, wallet);
    const res = await verify({ wallet, message, signature: signMessage(message, keypair) });
    expect(res.statusCode).toBe(200);
    expect(res.json().wallet).toBe(wallet);
    // __Host- makes browsers refuse a planted props.trade-wide cookie; it requires Secure, Path=/ and no Domain.
    const cookie = res.cookies.find((c) => c.name === '__Host-props_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(cookie.domain).toBeUndefined();
    expect(cookie.expires!.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);

    const meRes = await me(`${SESSION_COOKIE}=${cookie.value}`);
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toMatchObject({ wallet, kyc: 'none' });
  });

  it('rejects a replayed nonce', async () => {
    const keypair = Keypair.generate();
    const wallet = keypair.publicKey.toBase58();
    const { message } = await requestNonce(t.app, wallet);
    const body = { wallet, message, signature: signMessage(message, keypair) };
    expect((await verify(body)).statusCode).toBe(200);
    const replay = await verify(body);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ error: { code: 'nonce_used', message: expect.any(String) } });
  });

  it('lets only one of two concurrent verifies of the same nonce succeed', async () => {
    const keypair = Keypair.generate();
    const wallet = keypair.publicKey.toBase58();
    const { message } = await requestNonce(t.app, wallet);
    const body = { wallet, message, signature: signMessage(message, keypair) };
    const codes = (await Promise.all([verify(body), verify(body), verify(body)])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 401, 401]);
  });

  it('rejects a correctly signed message for another domain', async () => {
    const keypair = Keypair.generate();
    const wallet = keypair.publicKey.toBase58();
    const { message } = await requestNonce(t.app, wallet);
    const phished = message.replace('app.props.test wants', 'evil.example wants');
    const res = await verify({ wallet, message: phished, signature: signMessage(phished, keypair) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('message_mismatch');
  });

  it('rejects a nonce issued to a different wallet', async () => {
    const a = Keypair.generate();
    const b = Keypair.generate();
    const { message } = await requestNonce(t.app, a.publicKey.toBase58());
    const res = await verify({ wallet: b.publicKey.toBase58(), message, signature: signMessage(message, b) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('message_mismatch');
  });

  it('rejects a bad signature and leaves the nonce usable', async () => {
    const keypair = Keypair.generate();
    const wallet = keypair.publicKey.toBase58();
    const { message } = await requestNonce(t.app, wallet);
    const forged = await verify({ wallet, message, signature: signMessage(message, Keypair.generate()) });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error.code).toBe('bad_signature');
    const garbage = await verify({ wallet, message, signature: 'not-base58!' });
    expect(garbage.json().error.code).toBe('bad_signature');
    expect((await verify({ wallet, message, signature: signMessage(message, keypair) })).statusCode).toBe(200);
  });

  it('rejects an expired nonce', async () => {
    const keypair = Keypair.generate();
    const wallet = keypair.publicKey.toBase58();
    const { message, nonce } = await requestNonce(t.app, wallet);
    await t.db.update(authNonces).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(authNonces.nonce, nonce));
    const res = await verify({ wallet, message, signature: signMessage(message, keypair) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('nonce_expired');
  });

  it('rejects an unknown nonce and malformed input', async () => {
    const keypair = Keypair.generate();
    const wallet = keypair.publicKey.toBase58();
    const { message } = await requestNonce(t.app, wallet);
    const unknown = message.replace(/Nonce: \w+/, 'Nonce: 0123456789abcdef0123456789abcdef');
    expect((await verify({ wallet, message: unknown, signature: signMessage(unknown, keypair) })).json().error.code).toBe('nonce_unknown');
    const bad = await t.app.inject({ method: 'POST', url: '/v1/auth/nonce', payload: { wallet: 'nope' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('bad_request');
  });
});

describe('sessions', () => {
  it('stores only a keyed hash of the cookie token', async () => {
    const { cookie, wallet } = await signIn(t.app);
    const token = cookie.split('=')[1]!;
    const rows = await t.db.select().from(sessions).where(eq(sessions.wallet, wallet));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.tokenHash).not.toContain(token);
  });

  it('expires after its expiry time', async () => {
    const { cookie, wallet } = await signIn(t.app);
    expect((await me(cookie)).statusCode).toBe(200);
    await t.db.update(sessions).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(sessions.wallet, wallet));
    const res = await me(cookie);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('logout deletes the session and clears the cookie', async () => {
    const { cookie } = await signIn(t.app);
    const out = await t.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    expect(out.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('rejects requests without a session or with a forged token', async () => {
    expect((await me()).statusCode).toBe(401);
    expect((await me(`${SESSION_COOKIE}=forged`)).statusCode).toBe(401);
  });

  it('refuses cookie-authenticated writes from a foreign origin', async () => {
    const { cookie } = await signIn(t.app);
    const res = await t.app.inject({
      method: 'POST', url: '/v1/kyc/start', headers: { cookie, origin: 'https://evil.example' }, payload: { country: 'DE' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden_origin');
  });
});
