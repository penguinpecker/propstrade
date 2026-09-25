// GET /v1/traders/:address (api.ts TraderLookup): a trader's public record by Solana address, no session — the
// accounts of every stage, their open positions, the last 50 closed trades and the payouts, read through the same
// providers the owner's own pages use. Nothing identifying is read: kyc_requests and the payout review notes stay
// private. An evaluation or funded account address resolves to the wallet that holds it.
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ClosedTrade, TraderLookup } from '@props/shared';
import { z } from 'zod';
import type { Db } from '../../db/client.ts';
import { accounts, users } from '../../db/schema.ts';
import { ApiError, parse } from '../../errors.ts';
import { walletSchema } from '../../lib/solana.ts';
import type { SimService } from '../types.ts';
import type { FundedProvider } from './funded.ts';

const Params = z.object({ address: walletSchema });
const RECENT_TRADES = 50;
// Each lookup values every open position of the trader (funded ones from chain): tighter than the app-wide limit.
const RATE_LIMIT = { rateLimit: { max: 60, timeWindow: '1 minute' } };

export function registerTraderRoutes(app: FastifyInstance, d: { db: Db; sim?: SimService; funded: FundedProvider }) {
  const { db, funded } = d;

  /** The wallet `address` names: a signed-in wallet, a wallet with an account, or the holder of the account `address`. */
  async function walletOf(address: string): Promise<string | undefined> {
    const [user] = await db.select({ wallet: users.wallet }).from(users).where(eq(users.wallet, address));
    if (user) return user.wallet;
    const [row] = await db.select({ wallet: accounts.wallet }).from(accounts).where(or(eq(accounts.wallet, address), eq(accounts.id, address))).limit(1);
    return row?.wallet;
  }

  app.get<{ Params: { address: string } }>('/v1/traders/:address', { config: RATE_LIMIT }, async (req, reply): Promise<TraderLookup> => {
    const { address } = parse(Params, req.params);
    const wallet = await walletOf(address);
    if (!wallet) throw new ApiError(404, 'unknown_trader', 'No trader with this address');
    // The wallet's accounts as its owner sees them: evaluations, funded accounts and the live practice account (an
    // archived practice account, "practice:<wallet>:<time>", is not).
    const rows = await db.select({ id: accounts.id, stage: accounts.stage }).from(accounts)
      .where(and(eq(accounts.wallet, wallet), or(inArray(accounts.stage, ['evaluation', 'funded']), eq(accounts.id, `practice:${wallet}`))))
      .orderBy(asc(accounts.createdAt));
    const found: TraderLookup['accounts'] = [];
    const positions: TraderLookup['positions'] = [];
    const trades: ClosedTrade[] = [];
    for (const row of rows) {
      const provider = row.stage === 'funded' ? funded : d.sim;
      const detail = await provider?.detail(wallet, row.id);
      if (!detail) continue;
      found.push({ id: detail.id, stage: detail.stage, status: detail.status, sizeUsd: detail.rules.sizeUsd, equityUsd: detail.equity, createdAt: detail.createdAt });
      positions.push(...detail.positions);
      trades.push(...((await provider!.history(wallet, row.id, RECENT_TRADES)) ?? [])); // each account's newest: the read does not grow with a trader's history
    }
    const payouts = (await funded.payouts(wallet)).map((p) => ({
      id: p.id, status: p.status, amountUsd: p.traderAmount, requestedAt: p.requestedAt,
      paidAt: p.status === 'paid' ? p.resolvedAt : null, signature: p.paySignature ?? null,
    }));
    reply.header('cache-control', 'public, s-maxage=5');
    return { address: wallet, accounts: found, positions, trades: trades.sort((a, b) => b.closedAt - a.closedAt).slice(0, RECENT_TRADES), payouts };
  });
}
