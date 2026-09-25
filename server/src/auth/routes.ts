import { createHmac, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import type { NonceResponse } from '@props/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { authNonces, sessions, users } from '../db/schema.js';
import { ApiError, parse } from '../errors.js';
import { walletSchema } from '../lib/solana.js';
import { assignReferralCode } from '../routes/referrals.js';
import type { StreamHub } from '../stream.js';
import { SIWS_STATEMENT, buildSiwsMessage, nonceOf, verifySiwsSignature } from './siws.js';

// __Host-: browsers refuse it from a sibling subdomain (Domain=) or a narrower Path, so no one can plant a session.
export const SESSION_COOKIE = '__Host-props_session';
const NONCE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 3600_000;
const AUTH_RATE_LIMIT = { rateLimit: { max: 30, timeWindow: '1 minute' } };

/** A live signed-in session (sessions row). */
export interface Session { id: string; wallet: string; expiresAt: Date }

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in wallet; set by `requireWallet`, null otherwise. */
    wallet: string | null;
  }
  interface FastifyInstance {
    /** preHandler for routes that need a signed-in wallet; modules use it via `app.requireWallet`. */
    requireWallet: preHandlerAsyncHookHandler;
    /** Resolves the session cookie to its live session without failing the request. */
    session(req: FastifyRequest): Promise<Session | null>;
  }
}

const NonceBody = z.object({ wallet: walletSchema });
const VerifyBody = z.object({ wallet: walletSchema, message: z.string().max(2000), signature: z.string().max(100) });

export function registerAuth(app: FastifyInstance, { db, config, hub }: { db: Db; config: Config; hub: Pick<StreamHub, 'endSession'> }) {
  const hashToken = (token: string) => createHmac('sha256', config.SESSION_SECRET).update(token).digest('hex');
  const unsafeMethod = (m: string) => !['GET', 'HEAD', 'OPTIONS'].includes(m);

  async function session(req: FastifyRequest): Promise<Session | null> {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return null;
    const [row] = await db.select({ id: sessions.id, wallet: sessions.wallet, expiresAt: sessions.expiresAt }).from(sessions)
      .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, sql`now()`)));
    return row ?? null;
  }

  // Cross-site request forgery guard on top of SameSite=Lax, for every write (logout included): browsers always send
  // Origin on unsafe methods; clients without one are not browsers and carry no ambient cookie.
  app.addHook('onRequest', async (req) => {
    const origin = req.headers.origin;
    if (unsafeMethod(req.method) && origin !== undefined && origin !== config.APP_ORIGIN) {
      throw new ApiError(403, 'forbidden_origin', 'Request origin is not allowed');
    }
  });

  app.decorateRequest('wallet', null);
  app.decorate('session', session);
  app.decorate('requireWallet', async (req: FastifyRequest) => {
    const wallet = (await session(req))?.wallet;
    if (!wallet) throw new ApiError(401, 'unauthorized', 'Sign in with your wallet first');
    req.wallet = wallet;
  });

  const domain = new URL(config.APP_ORIGIN).host;
  const chainId = config.SOLANA_CLUSTER === 'mainnet-beta' ? 'mainnet' : 'localnet';

  app.post('/v1/auth/nonce', { config: AUTH_RATE_LIMIT }, async (req): Promise<NonceResponse> => {
    const { wallet } = parse(NonceBody, req.body);
    const nonce = randomBytes(16).toString('hex');
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
    const message = buildSiwsMessage({
      domain, address: wallet, statement: SIWS_STATEMENT, uri: config.APP_ORIGIN, chainId, nonce, issuedAt,
      expirationTime: expiresAt,
    });
    // Keep an hour of expired nonces so late verifies get a precise error; older ones are dead weight.
    await db.delete(authNonces).where(lt(authNonces.expiresAt, sql`now() - interval '1 hour'`));
    await db.insert(authNonces).values({ nonce, wallet, message, expiresAt });
    return { message, nonce, expiresAt: expiresAt.getTime() };
  });

  app.post('/v1/auth/verify', { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    const { wallet, message, signature } = parse(VerifyBody, req.body);
    const nonce = nonceOf(message);
    const [issued] = nonce ? await db.select().from(authNonces).where(eq(authNonces.nonce, nonce)) : [];
    if (!issued) throw new ApiError(401, 'nonce_unknown', 'Sign-in request not found, start again');
    if (issued.wallet !== wallet || issued.message !== message) {
      throw new ApiError(401, 'message_mismatch', 'Signed message does not match the sign-in request');
    }
    if (issued.usedAt) throw new ApiError(401, 'nonce_used', 'Sign-in request already used, start again');
    if (issued.expiresAt.getTime() <= Date.now()) throw new ApiError(401, 'nonce_expired', 'Sign-in request expired, start again');
    if (!verifySiwsSignature(message, signature, wallet)) throw new ApiError(401, 'bad_signature', 'Signature is not valid for this wallet');

    // Atomic single use: of two concurrent verifies only one flips used_at.
    const consumed = await db.update(authNonces).set({ usedAt: sql`now()` })
      .where(and(eq(authNonces.nonce, issued.nonce), isNull(authNonces.usedAt), gt(authNonces.expiresAt, sql`now()`)))
      .returning({ nonce: authNonces.nonce });
    if (consumed.length === 0) throw new ApiError(401, 'nonce_used', 'Sign-in request already used, start again');

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const user = await db.transaction(async (tx) => {
      const [row] = await tx.insert(users).values({ wallet }).onConflictDoUpdate({ target: users.wallet, set: { lastLoginAt: sql`now()` } })
        .returning({ referralCode: users.referralCode });
      await tx.delete(sessions).where(and(eq(sessions.wallet, wallet), lt(sessions.expiresAt, sql`now()`)));
      await tx.insert(sessions).values({ wallet, tokenHash: hashToken(token), expiresAt });
      return row;
    });
    // In its own transaction, after the user row's lock is released: every code assignment takes the codes lock first,
    // then user rows (the boot backfill too), so the two never wait on each other in a circle.
    if (!user?.referralCode) await db.transaction((tx) => assignReferralCode(tx, wallet));
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/', expires: expiresAt,
    });
    return { wallet, expiresAt: expiresAt.getTime() };
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const ended = await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).returning({ id: sessions.id });
      for (const { id } of ended) hub.endSession(id);
    }
    reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    return reply.status(204).send();
  });
}
