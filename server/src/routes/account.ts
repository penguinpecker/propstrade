// Signed-in wallet routes: profile (/v1/me), identity review start, notifications.
import { PublicKey, type Connection } from '@solana/web3.js';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Me, Notification } from '@props/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { chainJobs, kycRequests, notifications } from '../db/schema.js';
import { ApiError, parse } from '../errors.js';
import { TOKEN_PROGRAM_ID, USDC_MINT, associatedTokenAddress, formatUnits, tokenAccountAmount } from '../lib/solana.js';

export type BalanceRpc = Pick<Connection, 'getMultipleAccountsInfo'>;

/**
 * US persons (GMTrade terms), including residents of US territories with their own ISO code, and comprehensively
 * sanctioned countries (ISO 3166-1 alpha-2).
 */
const BLOCKED_COUNTRIES = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'CU', 'IR', 'KP', 'SY']);

const KycStartBody = z.object({ country: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code') });
const ReadBody = z.object({ ids: z.array(z.uuid()).max(200).optional() });

const walletOf = (req: FastifyRequest): string => {
  if (!req.wallet) throw new ApiError(401, 'unauthorized', 'Sign in with your wallet first');
  return req.wallet;
};

async function latestKyc(db: Db, wallet: string) {
  const [latest] = await db.select({ status: kycRequests.status, job: chainJobs.status }).from(kycRequests)
    .leftJoin(chainJobs, eq(chainJobs.id, kycRequests.setIdentityJob))
    .where(eq(kycRequests.wallet, wallet)).orderBy(desc(kycRequests.createdAt)).limit(1);
  return latest;
}

async function kycState(db: Db, wallet: string): Promise<Me['kyc']> {
  const latest = await latestKyc(db, wallet);
  if (!latest) return 'none';
  if (latest.status === 'rejected') return 'rejected';
  // Verified only once the identity is set onchain; activation checks the onchain profile, not this row.
  return latest.status === 'approved' && latest.job === 'confirmed' ? 'verified' : 'pending';
}

export function registerAccountRoutes(app: FastifyInstance, deps: { db: Db; config: Config; rpc: BalanceRpc }) {
  const { db, config, rpc } = deps;
  const programId = config.PROGRAM_ID ? new PublicKey(config.PROGRAM_ID) : undefined;
  const auth = { preHandler: app.requireWallet };

  app.get('/v1/me', auth, async (req): Promise<Me> => {
    const wallet = walletOf(req);
    const owner = new PublicKey(wallet);
    const profile = programId && PublicKey.findProgramAddressSync([Buffer.from('trader'), owner.toBuffer()], programId)[0];
    const keys = [owner, associatedTokenAddress(owner, USDC_MINT), ...(profile ? [profile] : [])];
    const [kyc, infos] = await Promise.all([
      kycState(db, wallet),
      rpc.getMultipleAccountsInfo(keys).catch((err: unknown) => {
        req.log.warn({ err }, 'balance lookup failed');
        return null;
      }),
    ]);
    const me: Me = { wallet, kyc, solBalance: null, usdcBalance: null };
    if (infos) {
      const [walletInfo, ata, profileInfo] = infos;
      me.solBalance = formatUnits(BigInt(walletInfo?.lamports ?? 0), 9);
      me.usdcBalance = ata && ata.owner.equals(TOKEN_PROGRAM_ID) ? formatUnits(tokenAccountAmount(ata.data), 6) : '0';
      if (profile && programId && profileInfo?.owner.equals(programId)) me.profile = profile.toBase58();
    }
    return me;
  });

  app.post('/v1/kyc/start', auth, async (req) => {
    const wallet = walletOf(req);
    const { country } = parse(KycStartBody, req.body);
    if (BLOCKED_COUNTRIES.has(country)) {
      throw new ApiError(403, 'region_blocked', 'Funded accounts are not available in your country');
    }
    if ((await latestKyc(db, wallet))?.status === 'approved') {
      throw new ApiError(409, 'already_approved', 'This wallet has already passed identity review');
    }
    // The partial unique index keeps one pending request per wallet, also under concurrent calls.
    await db.insert(kycRequests).values({ wallet, country }).onConflictDoNothing();
    return { kyc: 'pending' as const };
  });

  app.get('/v1/notifications', auth, async (req): Promise<Notification[]> => {
    const rows = await db.select().from(notifications).where(eq(notifications.wallet, walletOf(req)))
      .orderBy(desc(notifications.createdAt)).limit(100);
    return rows.map((n) => ({
      id: n.id, title: n.title, body: n.body, href: n.href, kind: n.kind, ts: n.createdAt.getTime(), read: n.readAt !== null,
    }));
  });

  /** Marks the given notifications read, or all of them when `ids` is omitted. */
  app.post('/v1/notifications/read', auth, async (req) => {
    const { ids } = parse(ReadBody, req.body ?? {});
    const scope = and(eq(notifications.wallet, walletOf(req)), isNull(notifications.readAt));
    const updated = await db.update(notifications).set({ readAt: sql`now()` })
      .where(ids ? and(scope, inArray(notifications.id, ids)) : scope).returning({ id: notifications.id });
    return { updated: updated.length };
  });
}
