// Migration 0006 backfills closed_trades' cost breakdown from the fills each trip was written from. The columns exist
// already here (the test database is migrated), so the rows are written with the defaults and the migration's UPDATE
// statements are run again over them: they must reproduce what the writers now record. Migration 0008 (white label)
// rewrites the order notes that named the venue, run the same way. Migration 0009 (referrals) is applied for real, to a
// database of its own holding users from before it.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { accounts, closedTrades, evaluations, fundedAccounts, simFills, simOrders, simPositions, users, venueFills } from '../src/db/schema.js';
import { migrationsFolder, runMigrations } from '../src/db/migrate.js';
import { createDb } from '../src/db/client.js';
import { uuidOf } from '../src/modules/chain/venue.js';
import { backfillReferralCodes } from '../src/routes/referrals.js';
import { recreateDatabase, testDatabaseUrl } from './db.js';

const { sql, db } = createDb(testDatabaseUrl());
afterAll(async () => { await sql.end(); });

const key = () => Keypair.generate().publicKey.toBase58();
const backfill = readFileSync(`${migrationsFolder}/0006_costs_and_fill_timing.sql`, 'utf8').split('--> statement-breakpoint')
  .map((s) => s.trim()).filter((s) => s.startsWith('UPDATE') || s.startsWith('-- Simulated') || s.startsWith('-- Funded'));
beforeAll(() => { expect(backfill).toHaveLength(2); });

it('backfills a simulated round trip from its position\'s fills', async () => {
  const wallet = key();
  const id = `practice:${wallet}`;
  await db.insert(accounts).values({ id, wallet, stage: 'practice', status: 'active', label: 'Practice', sizeUsd: '25000', lossAllowanceUsd: '1250', maxExposureBps: 10_000, traderShareBps: 0 });
  const openedAt = new Date('2026-09-20T10:00:00Z');
  const [p] = await db.insert(simPositions).values({
    accountId: id, symbol: 'SOL', marketToken: key(), side: 'Long', sizeUsd: '0', sizeTokens: '0', collateralUsd: '0', entryPrice: '118', openedAt, closedAt: new Date('2026-09-20T11:00:00Z'),
  }).returning({ id: simPositions.id });
  const fill = (isIncrease: boolean, feeUsd: string, priceImpactUsd: string, fundingUsd: string, borrowUsd: string) => ({
    accountId: id, positionId: p!.id, symbol: 'SOL', side: 'Long' as const, isIncrease, sizeUsd: '10000', price: '118', feeUsd, priceImpactUsd, fundingUsd, borrowUsd,
    realizedPnl: '0', tickTs: openedAt, ts: openedAt,
  });
  await db.insert(simFills).values([fill(true, '1', '0.07', '0', '0'), fill(false, '1.2', '-0.05', '0.25', '0.5')]);
  const [trade] = await db.insert(closedTrades).values({
    accountId: id, symbol: 'SOL', side: 'Long', venue: 'simulated', openedAt, closedAt: new Date('2026-09-20T11:00:00Z'), sizeUsd: '10000', entryPrice: '118', exitPrice: '118',
    feesUsd: '2.95', netPnl: '-3.2',
  }).returning({ id: closedTrades.id });
  for (const statement of backfill) await sql.unsafe(statement);
  const [after] = await db.select().from(closedTrades).where(eq(closedTrades.id, trade!.id));
  expect([after!.orderFeesUsd, after!.fundingUsd, after!.borrowUsd, after!.priceImpactUsd, after!.feesUsd])
    .toEqual(['2.200000', '0.250000', '0.500000', '0.020000', '2.950000']);
});

it('backfills a funded round trip from the fills of its position since the previous close, by the trip id derived from the closing fill', async () => {
  const [trader, evaluation, funded, owner] = [key(), key(), key(), key()];
  await db.insert(evaluations).values({
    address: evaluation, trader, evalIndex: 0, tierId: 1, sizeUsd: '10000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000,
    termsHash: 'ab'.repeat(32), feePaid: '79', status: 'funded', purchaseSignature: 'p', createdAt: new Date(), updatedSlot: 1,
  });
  await db.insert(fundedAccounts).values({ address: funded, evaluation, trader, ownerPda: owner, principal: '500', traderShareBps: 8000, status: 'active', activationSignature: 'a', createdAt: new Date(), updatedSlot: 2 });
  await db.insert(accounts).values({ id: funded, wallet: trader, stage: 'funded', status: 'active', label: 'Funded', sizeUsd: '10000', lossAllowanceUsd: '500', maxExposureBps: 10_000, traderShareBps: 8000 });
  const position = key();
  // Two trips of the same position: the first closed by fill 2, the second by fill 5; a fill of another position in between.
  const fills = [
    ['000000000001-a-000001-000001-000000', position, true, '10000', '1', '0.1', '0', '0'],
    ['000000000002-a-000001-000001-000000', position, false, '0', '1.2', '0.2', '0.3', '0.4'],
    ['000000000003-a-000001-000001-000000', position, true, '5000', '0.5', '0.05', '0', '0'],
    ['000000000004-a-000001-000001-000000', key(), false, '0', '9', '9', '9', '9'],
    ['000000000005-a-000001-000001-000000', position, false, '0', '0.6', '-0.02', '0.07', '0.08'],
  ] as const;
  await db.insert(venueFills).values(fills.map(([venueId, pos, isIncrease, sizeAfterUsd, feeUsd, priceImpactUsd, fundingUsd, borrowUsd], i) => ({
    signature: `sig${i}`, eventIndex: 0, venueId, slot: i, fundedAccount: funded, position: pos, order: key(), symbol: 'SOL', side: 'Long' as const, isIncrease,
    sizeUsd: '5000', sizeAfterUsd, price: '118', feeUsd, priceImpactUsd, fundingUsd, borrowUsd, realizedPnl: isIncrease ? null : '1', ts: new Date(1_700_000_000_000 + i),
  })));
  const trip = (closing: string) => ({
    id: uuidOf(`closed:${closing}`), accountId: funded, symbol: 'SOL', side: 'Long' as const, venue: 'gmtrade' as const, openedAt: new Date(), closedAt: new Date(),
    sizeUsd: '10000', entryPrice: '118', exitPrice: '118', feesUsd: '0', netPnl: '0',
  });
  await db.insert(closedTrades).values([trip(fills[1][0]), trip(fills[4][0]), { ...trip(randomUUID()), id: randomUUID() }]);
  for (const statement of backfill) await sql.unsafe(statement);
  const rows = await db.select().from(closedTrades).where(eq(closedTrades.accountId, funded));
  const by = Object.fromEntries(rows.map((r) => [r.id, [r.orderFeesUsd, r.fundingUsd, r.borrowUsd, r.priceImpactUsd]]));
  expect(by[uuidOf(`closed:${fills[1][0]}`)]).toEqual(['2.200000', '0.300000', '0.400000', '0.300000']);
  expect(by[uuidOf(`closed:${fills[4][0]}`)]).toEqual(['1.100000', '0.070000', '0.080000', '0.030000']);
  expect(Object.values(by).filter((v) => v.every((x) => x === '0.000000'))).toHaveLength(1);
});

it('0008 rewrites the order notes earlier releases stored with the venue\'s name, and no other note', async () => {
  const wallet = key();
  const id = `practice:${wallet}`;
  await db.insert(accounts).values({ id, wallet, stage: 'practice', status: 'active', label: 'Practice', sizeUsd: '25000', lossAllowanceUsd: '1250', maxExposureBps: 10_000, traderShareBps: 0 });
  const order = (clientId: string, statusDetail: string) => ({
    accountId: id, clientId, symbol: 'SOL', marketToken: key(), side: 'Long' as const, kind: 'Market' as const, isIncrease: true, sizeUsd: '100',
    collateralUsd: '10', slippageBps: 50, status: 'canceled' as const, statusDetail, executableFrom: new Date(),
  });
  await db.insert(simOrders).values([
    order('a', 'GMTrade would not execute this order: invalid argument: insufficient collateral usd'),
    order('b', 'Expired: GMTrade drops market orders not executed within 30 minutes'),
    order('c', 'Cancelled by you'),
  ]);
  await sql.unsafe(readFileSync(`${migrationsFolder}/0008_white_label_order_notes.sql`, 'utf8'));
  const rows = await db.select().from(simOrders).where(eq(simOrders.accountId, id)).orderBy(simOrders.clientId);
  expect(rows.map((r) => r.statusDetail)).toEqual([
    'The exchange would not execute this order: invalid argument: insufficient collateral usd',
    'Expired: the exchange drops market orders not executed within 30 minutes',
    'Cancelled by you',
  ]);
});

it('0009 applies over a database at 0008 with users in it, a second run applies nothing, and the boot backfill gives those users codes, oldest first', async () => {
  const url = new URL(testDatabaseUrl());
  url.pathname = `${url.pathname}_m0009`;
  await recreateDatabase(url.toString());
  // The committed migrations as they stood before 0009.
  const before = mkdtempSync(join(tmpdir(), 'props-migrations-'));
  cpSync(migrationsFolder, before, { recursive: true });
  const journal = JSON.parse(readFileSync(join(before, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number }[] };
  const all = journal.entries.length;
  writeFileSync(join(before, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 8) }));
  const m = createDb(url.toString());
  try {
    await migrate(m.db, { migrationsFolder: before });
    // Their first 8 characters are one code in upper case; the one who signed in first keeps it.
    const [older, newer] = [`MigrAte9${key().slice(0, 30)}`, `mIGRATE9${key().slice(0, 30)}`];
    await m.sql`insert into users (wallet, created_at) values (${newer}, now()), (${older}, now() - interval '1 day')`;
    await runMigrations(url.toString());
    await runMigrations(url.toString());
    const [applied] = await m.sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(applied!.n).toBe(all);
    const rows = await m.db.select().from(users).orderBy(users.createdAt);
    expect(rows.map((r) => [r.wallet, r.referralCode, r.referredBy, r.referredAt])).toEqual([[older, null, null, null], [newer, null, null, null]]);

    expect(await backfillReferralCodes(m.db)).toBe(2);
    expect(await backfillReferralCodes(m.db)).toBe(0);
    const codes = await m.db.select({ wallet: users.wallet, code: users.referralCode }).from(users).orderBy(users.createdAt);
    expect(codes).toEqual([{ wallet: older, code: 'MIGRATE9' }, { wallet: newer, code: `MIGRATE9${newer[8]!.toUpperCase()}` }]);
  } finally {
    await m.sql.end();
    rmSync(before, { recursive: true, force: true });
  }
});
