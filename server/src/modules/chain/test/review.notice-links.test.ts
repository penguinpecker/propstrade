// Notification links must be app routes that name their account (docs/ARCHITECTURE.md §8): `/account/<stage>?id=<id>`.
// The app routes `/account/<anything>` to the account page, which ignores a path id and shows whichever stage the
// trader last opened, so a link to `/account/<funded PDA>` opens the wrong account.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import type { TradeEvent } from '@props/gmtrade';
import { accounts, evaluations, fundedAccounts } from '../../../db/schema.ts';
import type { Notice } from '../projector.ts';
import type { ChainReader } from '../reader.ts';
import { createVenue, type GmIndexer } from '../venue.ts';
import { freshDb, offlineClient, silentLog } from './support.ts';

type Trip = (TradeEvent & { signature: string })[];
const trip: Trip = JSON.parse(readFileSync(new URL('fixtures/sol-round-trip.json', import.meta.url), 'utf8'),
  (_k, v) => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
const sol = { marketToken: '6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc', symbol: 'SOL', indexToken: 'So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH', decimals: 9 };
const reader: ChainReader = { evaluation: async () => { throw new Error('unused'); }, market: async () => sol };
const key = () => Keypair.generate().publicKey.toBase58();

let t: Awaited<ReturnType<typeof freshDb>>;
before(async () => {
  t = await freshDb('chain_notice_links');
});
after(async () => {
  await t.sql.end();
});

test('a GMTrade fill notice links to the funded account route, not to the funded PDA', async () => {
  const [trader, evaluation, funded, owner] = [key(), key(), key(), key()];
  await t.db.insert(evaluations).values({
    address: evaluation, trader, evalIndex: 0, tierId: 1, sizeUsd: '10000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000,
    traderShareBps: 8000, termsHash: 'ab'.repeat(32), feePaid: '79', status: 'funded', purchaseSignature: 'purchase', createdAt: new Date(), updatedSlot: 1,
  });
  await t.db.insert(fundedAccounts).values({
    address: funded, evaluation, trader, ownerPda: owner, principal: '500', traderShareBps: 8000, status: 'active', activationSignature: 'activation',
    createdAt: new Date(), updatedSlot: 2,
  });
  await t.db.insert(accounts).values({
    id: funded, wallet: trader, stage: 'funded', status: 'active', label: 'Funded 10K', tierId: 1, evaluation, funded, sizeUsd: '10000',
    lossAllowanceUsd: '500', maxExposureBps: 10_000, traderShareBps: 8000, termsHash: 'ab'.repeat(32), termsVersion: 1, activatedAt: new Date(),
  });
  const gm: GmIndexer = {
    // The closing fill happened just now, so it is notified.
    trades: async () => trip.map((e, i) => ({ ...e, user: owner, ts: i === trip.length - 1 ? Date.now() : Date.now() - 86_400_000 + i })),
    signatures: async (ids) => new Map(trip.filter((e) => ids.includes(e.id)).map((e) => [e.id, e.signature])),
    removals: async () => [],
  };
  const notices: Notice[] = [];
  const venue = createVenue({ db: t.db, rpc: {} as never, client: offlineClient(), reader, gm, log: silentLog, notify: async (n) => void notices.push(n) });
  await venue.syncFills(funded, owner, trader);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.href, `/account/funded?id=${funded}`, `fill notice links to ${notices[0]!.href}`);
});
