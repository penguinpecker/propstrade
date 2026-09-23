// Operator API under /v1/admin, authenticated by `Authorization: Bearer <ADMIN_API_TOKEN>`. Every change is
// written to admin_audit_log in the same transaction.
import { createHash, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { adminAuditLog, chainJobs, kycRequests } from '../db/schema.js';
import { ApiError, parse } from '../errors.js';
import { isBlocked, refineResidence, residence } from '../lib/geo.js';
import type { Sealer } from '../lib/integrity.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest();

const ListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const IdParams = z.object({ id: z.uuid() });
/** The identity hash and the residence the reviewer confirmed from the documents (not what the trader declared). */
const ApproveBody = z.object({ identityHash: z.string().regex(/^[0-9a-f]{64}$/, '32-byte lowercase hex'), ...residence }).superRefine(refineResidence);
const RejectBody = z.object({ reason: z.string().trim().min(1).max(500) });

/** Postgres unique_violation, raw or wrapped by drizzle. */
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null &&
  ((err as { code?: string }).code === '23505' || isUniqueViolation((err as { cause?: unknown }).cause));

/** onRequest hook for operator routes: `Authorization: Bearer <ADMIN_API_TOKEN>`, else 401. */
export function adminAuth(adminToken: string) {
  const expected = sha256(adminToken);
  return async (req: FastifyRequest) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    // Hashing first makes the comparison constant-time regardless of the presented token's length.
    if (!token || !timingSafeEqual(sha256(token), expected)) {
      throw new ApiError(401, 'unauthorized', 'Admin token required');
    }
  };
}

/** admin_audit_log row for an operator action. */
export const audit = (req: FastifyRequest, action: string, target: string, details: Record<string, unknown>) =>
  ({ action, target, details, ip: req.ip, requestId: req.id });

export function registerAdminRoutes(app: FastifyInstance, { db, adminToken, sealer }: { db: Db; adminToken: string; sealer: Sealer }) {
  app.register(async (admin) => {
    admin.addHook('onRequest', adminAuth(adminToken));

    admin.get('/kyc', async (req) => {
      const { status, limit } = parse(ListQuery, req.query);
      const rows = await db.select({
        id: kycRequests.id, wallet: kycRequests.wallet, country: kycRequests.country, status: kycRequests.status,
        region: kycRequests.region, identityHash: kycRequests.identityHash, reason: kycRequests.reason, createdAt: kycRequests.createdAt,
        reviewedAt: kycRequests.reviewedAt, jobStatus: chainJobs.status, jobSignature: chainJobs.signature,
        jobError: chainJobs.lastError,
      }).from(kycRequests).leftJoin(chainJobs, eq(chainJobs.id, kycRequests.setIdentityJob))
        .where(eq(kycRequests.status, status)).orderBy(desc(kycRequests.createdAt)).limit(limit);
      return rows.map((r) => ({ ...r, createdAt: r.createdAt.getTime(), reviewedAt: r.reviewedAt?.getTime() ?? null }));
    });

    /** Approves a pending request and queues the onchain `set_identity` write for the chain module. */
    admin.post('/kyc/:id/approve', async (req) => {
      const { id } = parse(IdParams, req.params);
      const { identityHash, country, region } = parse(ApproveBody, req.body);
      if (isBlocked({ country, region })) {
        throw new ApiError(403, 'region_blocked', 'Funded accounts are not available where this person lives: reject the request instead');
      }
      try {
        return await db.transaction(async (tx) => {
          const [request] = await tx.select().from(kycRequests).where(eq(kycRequests.id, id)).for('update');
          if (!request) throw new ApiError(404, 'not_found', 'KYC request not found');
          if (request.status !== 'pending') throw new ApiError(409, 'not_pending', `Request is already ${request.status}`);
          const job = { kind: 'set_identity' as const, subject: null, payload: { wallet: request.wallet, identityHash } };
          const [row] = await tx.insert(chainJobs).values({ ...job, mac: sealer.job(job) }).returning({ id: chainJobs.id });
          await tx.update(kycRequests)
            .set({ status: 'approved', identityHash, country, region: region ?? null, setIdentityJob: row!.id, reviewedAt: sql`now()` })
            .where(eq(kycRequests.id, id));
          const declared = { country: request.country, region: request.region };
          await tx.insert(adminAuditLog).values(audit(req, 'kyc.approve', request.wallet, { requestId: id, identityHash, country, region, declared, job: row!.id }));
          return { id, status: 'approved' as const, job: row!.id };
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(409, 'identity_in_use', 'This identity is already approved for another wallet');
        throw err;
      }
    });

    admin.post('/kyc/:id/reject', async (req) => {
      const { id } = parse(IdParams, req.params);
      const { reason } = parse(RejectBody, req.body);
      return db.transaction(async (tx) => {
        const [updated] = await tx.update(kycRequests).set({ status: 'rejected', reason, reviewedAt: sql`now()` })
          .where(and(eq(kycRequests.id, id), eq(kycRequests.status, 'pending'))).returning({ wallet: kycRequests.wallet });
        if (!updated) throw new ApiError(409, 'not_pending', 'No pending KYC request with this id');
        await tx.insert(adminAuditLog).values(audit(req, 'kyc.reject', updated.wallet, { requestId: id, reason }));
        return { id, status: 'rejected' as const };
      });
    });
  }, { prefix: '/v1/admin' });
}
