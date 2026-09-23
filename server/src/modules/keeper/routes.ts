// Operator routes of the keeper under /v1/admin: acknowledging a GMTrade deploy as the reviewed release ends the
// upgrade restriction pass and lets payout reviews resume. Restrictions already placed stay until an operator lifts
// each one (POST /v1/admin/funded/:id/lift-restriction).
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/client.ts';
import { adminAuditLog, gmtradeDeploys } from '../../db/schema.ts';
import { ApiError, parse } from '../../errors.ts';
import { adminAuth, audit } from '../../routes/admin.ts';

const DeployParams = z.object({ slot: z.coerce.number().int().nonnegative() });

export function registerKeeperRoutes(app: FastifyInstance, d: { db: Db; adminToken: string }) {
  app.register(async (admin) => {
    admin.addHook('onRequest', adminAuth(d.adminToken));

    admin.post('/gmtrade-deploys/:slot/acknowledge', async (req) => {
      const { slot } = parse(DeployParams, req.params);
      return d.db.transaction(async (tx) => {
        const [deploy] = await tx.select().from(gmtradeDeploys).where(eq(gmtradeDeploys.slot, slot)).for('update');
        if (!deploy) throw new ApiError(404, 'not_found', 'No GMTrade deploy with this slot has been seen');
        if (deploy.acknowledgedAt) throw new ApiError(409, 'already_acknowledged', 'This GMTrade deploy is already acknowledged');
        const [done] = await tx.update(gmtradeDeploys).set({ acknowledgedAt: sql`now()` }).where(eq(gmtradeDeploys.slot, slot))
          .returning({ at: gmtradeDeploys.acknowledgedAt });
        await tx.insert(adminAuditLog).values(audit(req, 'gmtrade.acknowledge', String(slot), { detectedAt: deploy.detectedAt?.toISOString() ?? null }));
        return { slot, acknowledgedAt: done!.at!.getTime() };
      });
    });
  }, { prefix: '/v1/admin' });
}
