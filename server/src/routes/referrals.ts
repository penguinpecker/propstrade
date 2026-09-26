// Referral program (api.ts ReferralSummary). A wallet's code is the shortest prefix of its address, 8 characters or more,
// upper-cased, that no other user holds: given at the first sign-in (the first come keeps the short one; users from
// before the program get theirs from the boot backfill, oldest first), never changed, matched case-insensitively. A user
// binds one referrer, once, within 7 days of the first sign-in and before buying an evaluation. The referrer then earns
// REFERRAL_REWARD_BPS of the Props fee each settlement charges that trader's funded orders (written when the indexer
// applies the settlement, modules/chain/projector.ts; waived fees earn nothing, nor does a charge whose USDC returns to
// Props anyway, and practice and evaluation fees are simulated and earn nothing), paid in USDC by Props.trade: an
// operator sends it, then records the payout under /v1/admin/referrals: only to a referrer who passed identity review
// (one approved wallet per person, so never to a funded referee's own second wallet), and only once the transfer is
// confirmed onchain.
import type { Connection, TokenBalance } from '@solana/web3.js';
import bs58 from 'bs58';
import { and, count, desc, eq, inArray, isNull, sql, sum } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatFixed, parseFixed } from '@props/gmtrade';
import type { ReferralCodeCheck, ReferralProgram, ReferralSummary } from '@props/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { adminAuditLog, evaluations, fundedAccounts, gmOrders, kycRequests, referralPayouts, referralRewards, users, venueFills } from '../db/schema.js';
import { ApiError, parse } from '../errors.js';
import { LOCK_KEYS } from '../lib/leader.js';
import { USDC_MINT, walletSchema } from '../lib/solana.js';
import { adminAuth, audit, isUniqueViolation } from './admin.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type PayoutRpc = Pick<Connection, 'getTransaction'>;

const CODE_MIN_LENGTH = 8;
const BIND_WINDOW_MS = 7 * 24 * 3600_000;
const RECENT_REWARDS = 50;
const LOOKUP_RATE_LIMIT = { rateLimit: { max: 60, timeWindow: '1 minute' } };
const BIND_RATE_LIMIT = { rateLimit: { max: 30, timeWindow: '1 minute' } };

const micro = (v: string | null) => (v === null ? 0n : parseFixed(v, 6));
const usd = (v: bigint) => formatFixed(v, 6, 6);
/** A code as typed (any case, spaces around it) in its stored form; null when no code can look like it. */
const codeOf = (input: string) => {
  const code = input.trim().toUpperCase();
  return /^[A-Z0-9]{8,44}$/.test(code) ? code : null;
};
/** A referee's wallet as the referrer sees it: enough to tell referees apart, not to follow one onchain. */
const masked = (wallet: string) => `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
const isSignature = (v: string) => {
  try {
    return bs58.decode(v).length === 64;
  } catch {
    return false;
  }
};

const CodeParams = z.object({ code: z.string().max(64) });
const SetReferrerBody = z.object({ code: z.string().max(64) });
const AdminListQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
const PayoutBody = z.object({
  referrer: walletSchema,
  amountUsd: z.string().refine((v) => /^\d{1,20}(\.\d{1,6})?$/.test(v) && parseFixed(v, 6) > 0n, 'a USD amount above 0, at most 6 decimals'),
  signature: z.string().max(88).refine(isSignature, 'a base58 transaction signature'),
  note: z.string().trim().min(1).max(500).optional(),
});

/**
 * Gives `wallet` its referral code unless it has one; returns the code given, else null. Runs in the caller's
 * transaction under a lock held to its end, so assignments running at the same time see each other's codes (the unique
 * constraint stays the last word).
 */
export async function assignReferralCode(tx: Tx, wallet: string): Promise<string | null> {
  // ponytail: one lock serializes every code assignment (first sign-ins and the boot backfill, a few ms each); key it by
  // the 8-character prefix if sign-ups ever queue on it.
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEYS.referralCodes}::int)`);
  const [row] = await tx.execute<{ code: string | null }>(sql`
    update users u set referral_code = (
      select c from generate_series(${CODE_MIN_LENGTH}::int, length(u.wallet)) n, upper(left(u.wallet, n)) c
      where not exists (select 1 from users taken where taken.referral_code = c)
      order by n limit 1)
    where u.wallet = ${wallet} and u.referral_code is null
    returning u.referral_code as code`);
  return row?.code ?? null;
}

/** Gives every user without a code one, oldest first (the first come keeps the short one), a batch per transaction.
 *  Idempotent; returns how many codes it gave. */
export async function backfillReferralCodes(db: Db, batch = 500): Promise<number> {
  let given = 0;
  for (;;) {
    const n = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEYS.referralCodes}::int)`);
      const pending = await tx.select({ wallet: users.wallet }).from(users).where(isNull(users.referralCode))
        .orderBy(users.createdAt, users.wallet).limit(batch);
      let assigned = 0;
      for (const { wallet } of pending) if (await assignReferralCode(tx, wallet)) assigned++;
      return assigned;
    });
    given += n;
    if (n === 0) return given;
  }
}

/**
 * The referrer's rewards for the Props fees a confirmed settlement charged `funded`'s orders (the per-order shares the
 * indexer applied to the fee ledger), written in the settlement's own indexed transaction: `rateBps` of each order's
 * charge, rounded down to the micro-dollar. Once per order and settlement (its signature and event index); nothing for a
 * trader no one referred, a fee only waived or a zero rate, nor for a charge that only moved Props' own capital into the
 * fee vault: one settled once the account breached (its USDC all returns to the capital vault) or in the transaction that
 * closes the account (`closing`).
 */
export async function accrueReferralRewards(
  tx: Tx, settlement: { signature: string; eventIndex: number; funded: string; shares: { order: string; charge: bigint }[]; closing?: boolean }, rateBps: number,
) {
  const charged = settlement.shares.filter((s) => s.charge > 0n);
  if (rateBps <= 0 || !charged.length || settlement.closing) return;
  const [trader] = await tx.select({ wallet: users.wallet, referrer: users.referredBy, status: fundedAccounts.status }).from(fundedAccounts)
    .innerJoin(users, eq(users.wallet, fundedAccounts.trader)).where(eq(fundedAccounts.address, settlement.funded));
  if (!trader?.referrer || trader.status === 'breached') return;
  const referrer = trader.referrer;
  const symbols = new Map((await tx.select({ order: gmOrders.address, symbol: gmOrders.symbol }).from(gmOrders)
    .where(inArray(gmOrders.address, charged.map((s) => s.order)))).map((o) => [o.order, o.symbol]));
  await tx.insert(referralRewards).values(charged.map((s) => ({
    referrer, referee: trader.wallet, order: s.order, fundedAccount: settlement.funded, settlementSignature: settlement.signature,
    settlementEventIndex: settlement.eventIndex, symbol: symbols.get(s.order)!, feeUsd: usd(s.charge), rateBps, rewardUsd: usd((s.charge * BigInt(rateBps)) / 10_000n),
  }))).onConflictDoNothing({ target: [referralRewards.order, referralRewards.settlementSignature, referralRewards.settlementEventIndex] });
}

/** USDC (micro) the confirmed transaction `signature` moved into `owner`'s token accounts; null when no successful
 *  transaction has that signature. */
async function usdcReceived(rpc: PayoutRpc, signature: string, owner: string) {
  let tx: Awaited<ReturnType<PayoutRpc['getTransaction']>>;
  try {
    tx = await rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  } catch {
    throw new ApiError(502, 'upstream_unavailable', 'Solana is not reachable right now, try again shortly');
  }
  if (!tx?.meta || tx.meta.err) return null;
  const held = (balances: TokenBalance[] | null | undefined) => (balances ?? [])
    .filter((b) => b.owner === owner && b.mint === USDC_MINT.toBase58()).reduce((total, b) => total + BigInt(b.uiTokenAmount.amount), 0n);
  return held(tx.meta.postTokenBalances) - held(tx.meta.preTokenBalances);
}

/** Whether the wallet bought an evaluation, as indexed (a funded account needs one). */
async function hasEvaluation(db: Db | Tx, wallet: string) {
  return (await db.select({ one: sql`1` }).from(evaluations).where(eq(evaluations.trader, wallet)).limit(1)).length > 0;
}

/** What a referrer earned and was paid, micro-USD. */
async function totals(db: Db | Tx, referrer: string) {
  const [earned] = await db.select({ usd: sum(referralRewards.rewardUsd) }).from(referralRewards).where(eq(referralRewards.referrer, referrer));
  const [paid] = await db.select({ usd: sum(referralPayouts.amountUsd) }).from(referralPayouts).where(eq(referralPayouts.referrer, referrer));
  return { earned: micro(earned?.usd ?? null), paid: micro(paid?.usd ?? null) };
}

async function summaryOf(db: Db, wallet: string, rewardBps: number): Promise<ReferralSummary> {
  let [me] = await db.select().from(users).where(eq(users.wallet, wallet));
  if (me && !me.referralCode) {
    // A session from before the program, ahead of the boot backfill.
    await db.transaction((tx) => assignReferralCode(tx, wallet));
    [me] = await db.select().from(users).where(eq(users.wallet, wallet));
  }
  if (!me?.referralCode) throw new Error(`no referral code for ${wallet}`);
  const until = me.createdAt.getTime() + BIND_WINDOW_MS;
  const canSetReferrer = !me.referredBy && Date.now() < until && !(await hasEvaluation(db, wallet));
  const [by, [referees], [volume], { earned, paid }, recent] = await Promise.all([
    me.referredBy ? db.select({ code: users.referralCode }).from(users).where(eq(users.wallet, me.referredBy)) : [],
    db.select({
      all: count(),
      withEvaluation: sql<number>`count(*) filter (where exists (select 1 from ${evaluations} where ${evaluations.trader} = ${users.wallet}))`.mapWith(Number),
      funded: sql<number>`count(*) filter (where exists (select 1 from ${fundedAccounts} where ${fundedAccounts.trader} = ${users.wallet}))`.mapWith(Number),
    }).from(users).where(eq(users.referredBy, wallet)),
    // ponytail: sums every funded fill of the referees per read; keep a running total if a referrer's passes ~100k fills.
    db.select({ usd: sum(venueFills.sizeUsd) }).from(venueFills)
      .innerJoin(fundedAccounts, eq(fundedAccounts.address, venueFills.fundedAccount))
      .innerJoin(users, eq(users.wallet, fundedAccounts.trader)).where(eq(users.referredBy, wallet)),
    totals(db, wallet),
    db.select().from(referralRewards).where(eq(referralRewards.referrer, wallet)).orderBy(desc(referralRewards.createdAt)).limit(RECENT_REWARDS),
  ]);
  return {
    code: me.referralCode,
    referredBy: by[0]?.code ?? null,
    canSetReferrer,
    setReferrerUntil: canSetReferrer ? until : null,
    rewardBps,
    referees: referees?.all ?? 0,
    refereesWithEvaluation: referees?.withEvaluation ?? 0,
    refereesFunded: referees?.funded ?? 0,
    fundedVolumeUsd: usd(micro(volume?.usd ?? null)),
    earnedUsd: usd(earned),
    paidUsd: usd(paid),
    pendingUsd: usd(earned - paid),
    recent: recent.map((r) => ({
      at: r.createdAt.getTime(), referee: masked(r.referee), symbol: r.symbol, feeUsd: usd(micro(r.feeUsd)), rewardUsd: usd(micro(r.rewardUsd)),
    })),
  };
}

export function registerReferralRoutes(
  app: FastifyInstance,
  { db, config, rpc }: { db: Db; config: Pick<Config, 'ADMIN_API_TOKEN' | 'REFERRAL_REWARD_BPS'>; rpc: PayoutRpc },
) {
  const auth = { preHandler: app.requireWallet };

  app.get('/v1/referrals', async (): Promise<ReferralProgram> => ({ rewardBps: config.REFERRAL_REWARD_BPS }));

  app.get('/v1/referrals/:code', { config: LOOKUP_RATE_LIMIT }, async (req, reply): Promise<ReferralCodeCheck> => {
    const code = codeOf(parse(CodeParams, req.params).code);
    const [row] = code ? await db.select({ wallet: users.wallet }).from(users).where(eq(users.referralCode, code)) : [];
    reply.header('cache-control', 'no-store');
    return { valid: row !== undefined };
  });

  app.get('/v1/me/referrals', auth, async (req): Promise<ReferralSummary> => summaryOf(db, req.wallet!, config.REFERRAL_REWARD_BPS));

  app.post('/v1/me/referrer', { ...auth, config: BIND_RATE_LIMIT }, async (req): Promise<ReferralSummary> => {
    const wallet = req.wallet!;
    const code = codeOf(parse(SetReferrerBody, req.body).code);
    await db.transaction(async (tx) => {
      // The row lock makes a second bind of the same user wait for this one, then find it.
      const [me] = await tx.select().from(users).where(eq(users.wallet, wallet)).for('no key update');
      if (!me) throw new ApiError(401, 'unauthorized', 'Sign in with your wallet first');
      if (me.referredBy) throw new ApiError(409, 'already_referred', 'You already have a referrer, and it cannot be changed');
      if (Date.now() >= me.createdAt.getTime() + BIND_WINDOW_MS) {
        throw new ApiError(403, 'referral_window_closed', 'A referral code can only be added in the first 7 days after your first sign-in');
      }
      if (await hasEvaluation(tx, wallet)) {
        throw new ApiError(403, 'referral_window_closed', 'A referral code can only be added before you buy an evaluation');
      }
      const [referrer] = code ? await tx.select({ wallet: users.wallet }).from(users).where(eq(users.referralCode, code)) : [];
      if (!referrer) throw new ApiError(404, 'unknown_referral_code', 'No such referral code');
      if (referrer.wallet === wallet) throw new ApiError(422, 'own_referral_code', 'You cannot use your own referral code');
      await tx.update(users).set({ referredBy: referrer.wallet, referredAt: sql`now()` }).where(eq(users.wallet, wallet));
    });
    return summaryOf(db, wallet, config.REFERRAL_REWARD_BPS);
  });

  app.register(async (admin) => {
    admin.addHook('onRequest', adminAuth(config.ADMIN_API_TOKEN));

    /** Every referrer with a referee, most owed first: rewards earned, payouts recorded and what is still owed, USD. */
    admin.get('/referrals', async (req) => {
      const { limit } = parse(AdminListQuery, req.query);
      // ponytail: sums the whole ledger per call (operators only); keep running totals per referrer if it gets slow.
      const rows = await db.execute<{ referrer: string; code: string | null; referees: number; earned: string; paid: string }>(sql`
        select r.wallet as referrer, u.referral_code as code, r.referees, coalesce(e.usd, 0)::text as earned, coalesce(p.usd, 0)::text as paid
        from (select referred_by as wallet, count(*)::int as referees from users where referred_by is not null group by referred_by) r
        join users u on u.wallet = r.wallet
        left join (select referrer, sum(reward_usd) as usd from referral_rewards group by referrer) e on e.referrer = r.wallet
        left join (select referrer, sum(amount_usd) as usd from referral_payouts group by referrer) p on p.referrer = r.wallet
        order by coalesce(e.usd, 0) - coalesce(p.usd, 0) desc, r.referees desc, r.wallet
        limit ${limit}`);
      return rows.map((r) => ({
        referrer: r.referrer, code: r.code, referees: r.referees, earnedUsd: usd(micro(r.earned)), paidUsd: usd(micro(r.paid)),
        pendingUsd: usd(micro(r.earned) - micro(r.paid)),
      }));
    });

    /** Records USDC an operator sent a referrer (the transfer's signature), up to what the referrer is owed. */
    admin.post('/referrals/payouts', async (req) => {
      const { referrer, amountUsd, signature, note } = parse(PayoutBody, req.body);
      const amount = micro(amountUsd);
      const [user] = await db.select({ wallet: users.wallet }).from(users).where(eq(users.wallet, referrer));
      if (!user) throw new ApiError(404, 'not_found', 'No user with this wallet');
      // kyc_requests_approved_identity_uq allows one approved wallet per person, and every funded referee has one, so a
      // verified referrer is never a referee's own second wallet.
      const [verified] = await db.select({ id: kycRequests.id }).from(kycRequests)
        .where(and(eq(kycRequests.wallet, referrer), eq(kycRequests.status, 'approved'))).limit(1);
      if (!verified) throw new ApiError(409, 'referrer_unverified', 'This referrer has not passed identity review, which referral payouts need');
      const received = await usdcReceived(rpc, signature, referrer);
      if (received === null) throw new ApiError(422, 'payout_not_found', 'No confirmed, successful transaction has this signature');
      if (received < amount) {
        throw new ApiError(422, 'payout_not_sent', `This transaction sends the referrer ${usd(received > 0n ? received : 0n)} USDC, not ${usd(amount)}`);
      }
      try {
        return await db.transaction(async (tx) => {
          // One payout of a referrer at a time, so each sees the ones recorded before it.
          await tx.select({ wallet: users.wallet }).from(users).where(eq(users.wallet, referrer)).for('no key update');
          const { earned, paid } = await totals(tx, referrer);
          if (amount > earned - paid) throw new ApiError(409, 'exceeds_pending', `This referrer is owed ${usd(earned - paid)} USD`);
          const [row] = await tx.insert(referralPayouts).values({ referrer, amountUsd: usd(amount), signature, note: note ?? null, createdBy: req.ip }).returning();
          await tx.insert(adminAuditLog).values(audit(req, 'referral.payout', referrer, { payout: row!.id, amountUsd: usd(amount), signature, note: note ?? null }));
          return {
            id: row!.id, referrer, amountUsd: usd(amount), signature, note: row!.note, createdAt: row!.createdAt.getTime(),
            earnedUsd: usd(earned), paidUsd: usd(paid + amount), pendingUsd: usd(earned - paid - amount),
          };
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError(409, 'payout_recorded', 'A payout with this signature is already recorded for this referrer');
        throw err;
      }
    });
  }, { prefix: '/v1/admin' });
}
