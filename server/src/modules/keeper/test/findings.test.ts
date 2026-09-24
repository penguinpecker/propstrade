// Review findings, each written as the behaviour the keeper should have (they failed before the fixes):
//  1. equity read across two RPC calls: USDC landing between them reads as a breach and restricts a healthy account;
//  2. the GMTrade upgrade restriction lapses for an account that was payout-pending when the upgrade was handled;
//  3. linked-position (hedge) detection is bypassed by opening a $1 stub first;
//  4. an account whose read keeps failing gets no stop-out or session guard, and no alert (only a log line).
// Later review: a breached account was only restricted, never marked breached and closed (see the last test).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { GMTRADE_PROGRAM_ID, ORDER_DISCRIMINATOR, PROPS_VAULT_PROGRAM_ID, ownerPda, ownerUsdcAddress, type ConfigAccount } from '@props/sdk';
import { eq, isNotNull } from 'drizzle-orm';
import { evaluations, fundedAccounts, gmtradeDeploys, indexerCursors } from '../../../db/schema.ts';
import { encodeAccount, freshDb, offlineClient, sealer, silentLog, until } from '../../chain/test/support.ts';
import type { Alerts } from '../alerts.ts';
import { createKeeper } from '../keeper.ts';
import { exposuresOf, linkedPositions, planStep, reviewPayout, type AccountView, type FillRow, type OrderView } from '../rules.ts';

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOL_MARKET = new PublicKey('6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc');
const USD = 10n ** 20n;
const MIN = 60_000;
const zero = new BN(0);
const FREE_SLOT = { marketToken: PublicKey.default, gmPosition: PublicKey.default, isLong: false, collateral: zero, sizeUsd: zero, pendingUsd: zero, lastSync: zero };
const FREE_ORDER = { order: PublicKey.default, slot: 0, orderType: { market: {} }, sizeUsd: zero, collateral: zero, placedByRisk: false };
const PROGRAM_DATA = PublicKey.findProgramAddressSync([GMTRADE_PROGRAM_ID.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0];

let t: Awaited<ReturnType<typeof freshDb>>;
before(async () => {
  t = await freshDb('keeper_findings');
});
after(async () => {
  await t.sql.end();
});

type Info = { data: Buffer; owner: PublicKey; lamports: number; executable: boolean; rentEpoch: number };
type Status = 'active' | 'restricted' | 'payoutPending' | 'breached' | 'closed';

/** A fake chain + RPC for createKeeper: accounts in a map, every transaction simulates and confirms. */
function fakeChain() {
  const client = offlineClient();
  const accounts = new Map<string, Info>();
  let deploySlot = 100n;
  const sent: string[] = [];
  const restricted: string[] = [];
  let afterFirstRead: (() => void) | null = null;
  const put = (k: PublicKey | string, info: Info) => accounts.set(k.toString(), info);
  const system = (lamports: number): Info => ({ data: Buffer.alloc(0), owner: SystemProgram.programId, lamports, executable: false, rentEpoch: 0 });
  const usdc = (amount: bigint): Info => {
    const data = Buffer.alloc(165);
    USDC.toBuffer().copy(data, 0);
    data.writeBigUInt64LE(amount, 64);
    return { data, owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), lamports: 2_039_280, executable: false, rentEpoch: 0 };
  };
  const funded = (status: Status, over: { slots?: unknown[]; orders?: unknown[] } = {}): Info => ({
    data: encodeAccount(client, 'fundedAccount', {
      trader: Keypair.generate().publicKey, evaluation: Keypair.generate().publicKey,
      terms: { sizeUsd: new BN(10_000_000_000), profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000, termsHash: Array(32).fill(1), tierVersion: 1 },
      principal: new BN(500_000_000), status: { [status]: {} },
      slots: [...(over.slots ?? []), ...Array(8 - (over.slots?.length ?? 0)).fill(FREE_SLOT)],
      orders: [...(over.orders ?? []), ...Array(8 - (over.orders?.length ?? 0)).fill(FREE_ORDER)],
      orderSeq: new BN(1), payoutsPaid: zero, payoutSeq: 0, createdAt: zero, lastSyncAt: zero, bump: 255, ownerBump: 255,
    }),
    owner: PROPS_VAULT_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0,
  });
  const gmOrder = (): Info => {
    const data = Buffer.alloc(2_200);
    Buffer.from(ORDER_DISCRIMINATOR).copy(data);
    data[9] = 0; // pending
    return { data, owner: GMTRADE_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 };
  };
  const setStatus = (address: string, status: Status) => {
    const info = accounts.get(address)!;
    const account = client.decode('fundedAccount', info.data);
    put(address, funded(status, { slots: account.slots.filter((s) => !s.marketToken.equals(PublicKey.default)), orders: account.orders.filter((o) => !o.order.equals(PublicKey.default)) }));
  };

  // What the next transaction does to the fake chain, applied when it is sent.
  let queued: (() => void)[] = [];
  let current: (() => void)[] = [];
  client.fetchConfig = async () => ({ ownerSolMin: new BN(50_000_000), paused: { payouts: false } }) as unknown as ConfigAccount;
  client.fetch = (async () => null) as typeof client.fetch;
  const restrict = client.restrict.bind(client);
  client.restrict = (p) => {
    queued.push(() => {
      restricted.push(p.funded.toBase58());
      setStatus(p.funded.toBase58(), 'restricted');
    });
    return restrict(p);
  };
  const lifecycle: string[] = [];
  const markBreached = client.markBreached.bind(client);
  client.markBreached = (p) => {
    queued.push(() => {
      lifecycle.push('markBreached');
      setStatus(p.funded.toBase58(), 'breached');
    });
    return markBreached(p);
  };
  const closeFunded = client.closeFunded.bind(client);
  client.closeFunded = (p) => {
    queued.push(() => {
      lifecycle.push(`closeFunded(${p.positions?.map(String).join(',')})`);
      setStatus(p.funded.address.toBase58(), 'closed');
    });
    return closeFunded(p);
  };
  const sync = client.sync.bind(client);
  client.sync = (p) => {
    // Drops vanished orders and frees the idle slot (all the scenarios here need).
    queued.push(() => put(p.funded.address, funded(p.funded.account.status.restricted ? 'restricted' : 'active')));
    return sync(p);
  };

  const rpc = {
    async getMultipleAccountsInfoAndContext(keys: PublicKey[]) {
      const value = keys.map((k) => accounts.get(k.toBase58()) ?? null);
      const hook = afterFirstRead;
      afterFirstRead = null;
      hook?.();
      return { context: { slot: 10 }, value };
    },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      return keys.map((k) => accounts.get(k.toBase58()) ?? null);
    },
    async getAccountInfo(k: PublicKey) {
      if (!k.equals(PROGRAM_DATA)) return accounts.get(k.toBase58()) ?? null;
      const data = Buffer.alloc(12);
      data.writeUInt32LE(3, 0);
      data.writeBigUInt64LE(deploySlot, 4);
      return { data, owner: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), lamports: 1, executable: false, rentEpoch: 0 };
    },
    async getLatestBlockhash() {
      current = queued;
      queued = [];
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 };
    },
    async simulateTransaction() {
      return { context: { slot: 10 }, value: { err: null, logs: [], unitsConsumed: 20_000 } };
    },
    async sendRawTransaction() {
      for (const apply of current) apply();
      current = [];
      sent.push('tx');
      return 'sig';
    },
    async getSignatureStatuses() {
      return { context: { slot: 10 }, value: [{ confirmationStatus: 'confirmed', err: null, slot: 10, confirmations: 1 }] };
    },
    async getBlockHeight() {
      return 1;
    },
  };
  return {
    client, rpc, accounts, put, system, usdc, funded, gmOrder, setStatus, sent, restricted, lifecycle,
    setDeploySlot: (s: bigint) => void (deploySlot = s),
    /** Runs once, right after the next getMultipleAccountsInfoAndContext has read its accounts. */
    afterNextRead: (fn: () => void) => void (afterFirstRead = fn),
  };
}

async function fundedRow(address: string, trader: string, status: 'active' | 'payout_pending' = 'active') {
  const evaluation = Keypair.generate().publicKey.toBase58();
  await t.db.insert(evaluations).values({
    address: evaluation, trader, evalIndex: 0, tierId: 1, sizeUsd: '10000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000,
    traderShareBps: 8000, termsHash: 'ab'.repeat(32), feePaid: '79', status: 'funded', purchaseSignature: `p${address}`, createdAt: new Date(), updatedSlot: 1,
  });
  await t.db.insert(fundedAccounts).values({
    address, evaluation, trader, ownerPda: ownerPda(new PublicKey(address)).toBase58(), principal: '500', traderShareBps: 8000, status,
    activationSignature: `a${address}`, createdAt: new Date(), updatedSlot: 2,
  });
}

function recorder() {
  const alerts: { key: string; level: string; text: string }[] = [];
  let beats = 0;
  const a: Alerts = { send: (key, level, text) => void alerts.push({ key, level, text }), heartbeat: () => void beats++ };
  return { alerts, a, beats: () => beats };
}

const sol = { marketToken: SOL_MARKET.toBase58(), symbol: 'SOL', indexToken: 'So1Zu7vPQQxrguzUehKAyVLpjcc769zxgBuDAsxTUMH', decimals: 9 };
const openSol = { market: () => ({ session: 'open', freshness: 'live', category: 'Crypto' }), marketState: async () => { throw new Error('no positions to value'); } };

/** Runs the keeper until it has completed `ticks` more ticks after `from`, then stops it. */
async function runTicks(keeper: ReturnType<typeof createKeeper>, stop: AbortController, done: Promise<void>, ticks: number) {
  let seen = keeper.status().lastTickAt;
  for (let i = 0; i < ticks; i++) {
    await until(async () => keeper.status().lastTickAt !== seen, 20_000, 'a keeper tick');
    seen = keeper.status().lastTickAt;
  }
  stop.abort();
  await done;
}

/**
 * The trader put the whole $500 allowance into one market increase ($10k at 20x): the owner holds no USDC while the
 * order is pending. GMTrade cannot fill it (price moved past the acceptable price), so it cancels and closes the order
 * and refunds the $500 to the owner's USDC account. `race`: that transaction lands between the keeper's first read
 * (funded account, owner USDC, owner SOL) and its second read (positions and orders); otherwise before both.
 */
async function refundedOrder(race: boolean) {
  await t.db.delete(gmtradeDeploys);
  const chain = fakeChain();
  const fundedKey = Keypair.generate().publicKey;
  const address = fundedKey.toBase58();
  const order = Keypair.generate().publicKey;
  await fundedRow(address, Keypair.generate().publicKey.toBase58());
  const tenK = new BN(10_000).mul(new BN(10).pow(new BN(20)));
  chain.put(fundedKey, chain.funded('active', {
    slots: [{ ...FREE_SLOT, marketToken: SOL_MARKET, gmPosition: Keypair.generate().publicKey, isLong: true, pendingUsd: tenK }],
    orders: [{ ...FREE_ORDER, order, sizeUsd: tenK, collateral: new BN(500_000_000) }],
  }));
  chain.put(ownerUsdcAddress(fundedKey), chain.usdc(0n));
  chain.put(ownerPda(fundedKey), chain.system(250_000_000));
  chain.put(order, chain.gmOrder());
  const refund = () => {
    chain.accounts.delete(order.toBase58());
    chain.put(ownerUsdcAddress(fundedKey), chain.usdc(500_000_000n));
  };
  if (race) chain.afterNextRead(refund);
  else refund();

  const notified: string[] = [];
  const keeper = createKeeper({
    db: t.db, rpc: chain.rpc as never, client: chain.client, reader: { evaluation: async () => { throw new Error('unused'); }, market: async () => sol },
    marketdata: openSol as never, risk: Keypair.generate(), sealer, log: silentLog, alerts: recorder().a,
    notify: async (_wallet, n) => void notified.push(n.title),
  });
  const stop = new AbortController();
  await runTicks(keeper, stop, keeper.run(stop.signal, async () => true, 20), 1);
  await t.db.delete(fundedAccounts).where(eq(fundedAccounts.address, address));
  return { restricted: chain.restricted, notified };
}

test('finding 1: USDC landing between the two account reads is not a breach (a healthy account must not be restricted)', async () => {
  // Control: the same end state read consistently ($500 USDC, no order) → nothing to stop out.
  assert.deepEqual(await refundedOrder(false), { restricted: [], notified: [] });
  // The refund lands between the two reads: the order is gone from the second read and its $500 is not in the first.
  const raced = await refundedOrder(true);
  assert.deepEqual(raced, { restricted: [], notified: [] }, 'a healthy account holding its whole $500 allowance was restricted as a loss-limit breach');
});

test('finding 2: an account that was payout-pending when a GMTrade upgrade was handled is restricted once it is active again', async () => {
  const chain = fakeChain();
  const fundedKey = Keypair.generate().publicKey;
  const address = fundedKey.toBase58();
  await fundedRow(address, Keypair.generate().publicKey.toBase58(), 'payout_pending');
  chain.put(fundedKey, chain.funded('payoutPending'));
  chain.put(ownerUsdcAddress(fundedKey), chain.usdc(600_000_000n));
  chain.put(ownerPda(fundedKey), chain.system(250_000_000));
  await t.db.delete(gmtradeDeploys);

  const r = recorder();
  const keeper = createKeeper({
    db: t.db, rpc: chain.rpc as never, client: chain.client, reader: { evaluation: async () => { throw new Error('unused'); }, market: async () => sol },
    marketdata: openSol as never, risk: Keypair.generate(), sealer, log: silentLog, alerts: r.a, notify: async () => {},
  });
  const stop = new AbortController();
  const done = keeper.run(stop.signal, async () => true, 20);
  await until(async () => keeper.status().lastTickAt, 20_000, 'baseline tick');
  chain.setDeploySlot(200n); // GMTrade is redeployed
  const handled = await until(async () => (await t.db.select().from(gmtradeDeploys).where(isNotNull(gmtradeDeploys.handledAt))).find((d) => d.slot === 200), 20_000, 'upgrade handled');
  assert.ok(r.alerts.some((a) => a.key === 'gmtrade-upgrade:200'), 'upgrade alerted');
  assert.ok(handled.handledAt, 'the upgrade was marked handled while the only account was payout-pending');

  // The trader cancels the payout request (or it is approved/rejected): the account is Active on the unreviewed GMTrade.
  chain.setStatus(address, 'active');
  await runTicks(keeper, stop, done, 3);
  assert.deepEqual(chain.restricted, [address], 'the account trades on the upgraded GMTrade without ever being restricted');
  await t.db.delete(fundedAccounts).where(eq(fundedAccounts.address, address));
});

// ---------- payout review ----------

const T0 = Date.parse('2026-09-23T12:00:00Z');
const fill = (f: Partial<FillRow> & Pick<FillRow, 'venueId' | 'ts' | 'account' | 'position'>): FillRow => ({
  symbol: 'SOL', side: 'Long', isIncrease: true, sizeUsd: '0', sizeAfterUsd: '0', feeUsd: '0', fundingUsd: '0', borrowUsd: '0', realizedPnl: null, ...f,
});

test('finding 3: a $10k hedge placed in the same minute is linked even when one leg started as a $1 stub', () => {
  // Account A (requesting the payout): $1 long stub at T0, then +$9,999 at T0+10 min, closed at T0+40 min for +$1,000.
  const ours = [
    fill({ account: 'A', position: 'pA', venueId: '01', ts: new Date(T0), sizeUsd: '1', sizeAfterUsd: '1' }),
    fill({ account: 'A', position: 'pA', venueId: '03', ts: new Date(T0 + 10 * MIN), sizeUsd: '9999', sizeAfterUsd: '10000' }),
    fill({ account: 'A', position: 'pA', venueId: '05', ts: new Date(T0 + 40 * MIN), isIncrease: false, sizeUsd: '10000', sizeAfterUsd: '0', realizedPnl: '1000' }),
  ];
  // Account B (the partner): $10k short opened in the same minute as A's $10k, closed with it (B loses the vault's money).
  const theirs = [
    fill({ account: 'B', position: 'pB', side: 'Short', venueId: '02', ts: new Date(T0 + 10 * MIN), sizeUsd: '10000', sizeAfterUsd: '10000' }),
    fill({ account: 'B', position: 'pB', side: 'Short', venueId: '04', ts: new Date(T0 + 40 * MIN), isIncrease: false, sizeUsd: '10000', sizeAfterUsd: '0', realizedPnl: '-500' }),
  ];
  const now = T0 + 60 * MIN;
  const links = linkedPositions(exposuresOf(ours), exposuresOf(theirs), now);
  const review = reviewPayout({ profit: 1_000_000_000n, requestedAt: T0 + 45 * MIN, flat: true, verified: true, fills: ours, links, now });
  assert.equal(review.decision, 'hold', 'the payout of a same-minute $10k hedge was approved because one leg opened with a $1 stub 10 minutes earlier');
});

test('finding 3b: a partner that never goes flat (a permanent $1 stub) is never linked', () => {
  const ours = [
    fill({ account: 'A', position: 'pA', venueId: '03', ts: new Date(T0), sizeUsd: '10000', sizeAfterUsd: '10000' }),
    fill({ account: 'A', position: 'pA', venueId: '05', ts: new Date(T0 + 30 * MIN), isIncrease: false, sizeUsd: '10000', sizeAfterUsd: '0', realizedPnl: '1000' }),
  ];
  // B opened its $1 short stub days ago; in the window it only grows it to $10k and shrinks it back to $1.
  const theirs = [
    fill({ account: 'B', position: 'pB', side: 'Short', venueId: '04', ts: new Date(T0), sizeUsd: '9999', sizeAfterUsd: '10000' }),
    fill({ account: 'B', position: 'pB', side: 'Short', venueId: '06', ts: new Date(T0 + 30 * MIN), isIncrease: false, sizeUsd: '9999', sizeAfterUsd: '1', realizedPnl: '-500' }),
  ];
  const links = linkedPositions(exposuresOf(ours), exposuresOf(theirs), T0 + 60 * MIN);
  assert.equal(links.length, 1, 'the partner position opened in the same second is invisible to the hedge check');
});

// ---------- monitoring ----------

test('finding 4: an account the keeper cannot read or value is alerted, not only logged', async () => {
  await t.db.delete(gmtradeDeploys);
  const chain = fakeChain();
  const fundedKey = Keypair.generate().publicKey;
  const address = fundedKey.toBase58();
  await fundedRow(address, Keypair.generate().publicKey.toBase58());
  // An open slot whose market the reader cannot resolve (RPC error on that market, an account that no longer decodes, …).
  chain.put(fundedKey, chain.funded('active', { slots: [{ ...FREE_SLOT, marketToken: SOL_MARKET, gmPosition: Keypair.generate().publicKey, isLong: true }] }));
  chain.put(ownerUsdcAddress(fundedKey), chain.usdc(0n));
  chain.put(ownerPda(fundedKey), chain.system(250_000_000));
  const errors: string[] = [];
  const r = recorder();
  const keeper = createKeeper({
    db: t.db, rpc: chain.rpc as never, client: chain.client,
    reader: { evaluation: async () => { throw new Error('unused'); }, market: async () => { throw new Error('market account unavailable'); } },
    marketdata: openSol as never, risk: Keypair.generate(), sealer, alerts: r.a, notify: async () => {},
    log: { ...silentLog, error: (_o: unknown, msg?: string) => void errors.push(String(msg)) },
  });
  const stop = new AbortController();
  const done = keeper.run(stop.signal, async () => true, 20);
  await runTicks(keeper, stop, done, 3);
  assert.ok(errors.includes('keeper: account pass failed'), 'the failure is logged');
  assert.ok(r.beats() >= 3, 'and the heartbeat keeps reporting a healthy keeper');
  assert.ok(r.alerts.some((a) => a.text.includes(address)), 'no Telegram/Sentry alert: stop-outs and the session guard are off for this account, silently');
  await t.db.delete(fundedAccounts).where(eq(fundedAccounts.address, address));
});

test('finding 5: a burst of per-account critical alerts reaches Telegram in full, within its 20-messages-a-minute group limit', async () => {
  // Telegram (core.telegram.org/bots/faq): "In a group, bots are not able to send more than 20 messages per minute" (429).
  const posted: { at: number; text: string }[] = [];
  const telegram = (async (_url: string, init: RequestInit) => {
    if (posted.filter((p) => Date.now() - p.at < 60_000).length >= 20) {
      return new Response('{"ok":false,"error_code":429,"parameters":{"retry_after":1}}', { status: 429 });
    }
    posted.push({ at: Date.now(), text: JSON.parse(init.body as string).text });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const warnings: string[] = [];
  const { createAlerts } = await import('../alerts.ts');
  const alerts = createAlerts({ env: { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '1' }, fetch: telegram, log: { ...silentLog, warn: (_o: unknown, m?: string) => void warnings.push(String(m)) } });
  // 30 funded accounts hold over-levered stock positions at 15:45 New York; the risk key has run out of SOL, so every
  // session close fails in the same tick (keeper.ts raises `failed:<account>:session` per account).
  const texts = Array.from({ length: 30 }, (_, i) => `Keeper session transaction for account${i} failed (…): simulation failed`);
  for (const [i, text] of texts.entries()) alerts.send(`failed:account${i}:session`, 'critical', text);
  const delivered = () => posted.flatMap((p) => p.text.split('\n'));
  await until(async () => delivered().length === 30, 10_000, 'deliveries');
  assert.deepEqual(delivered(), texts.map((x) => `[critical] ${x}`), 'every alert, once');
  assert.ok(posted.length <= 20, `${posted.length} messages in a minute`);
  assert.ok(!warnings.includes('Telegram rejected the alert'));
});

test('finding 6: freeing an order slot for a session close cancels a pending increase, not the stop-loss of another open position', () => {
  const pos = (size: bigint, netValue: bigint) => ({ size: size * USD, collateral: 50_000_000n, netValue: netValue * USD });
  const o = (order: string, slot: number, type: OrderView['type']): OrderView => ({ order, slot, type, sizeUsd: USD, placedByRisk: false, state: 'pending', createdAt: 1 });
  const view: AccountView = {
    funded: 'F', status: 'active', ownerLamports: 250_000_000n, value: 300n * USD,
    slots: [
      { index: 0, marketToken: 'NVDA', isLong: true, gmPosition: 'p0', sizeUsd: 1_000n * USD, collateral: 50_000_000n, pendingUsd: 0n }, // 20x NVDA
      { index: 1, marketToken: 'BTC', isLong: true, gmPosition: 'p1', sizeUsd: 500n * USD, collateral: 50_000_000n, pendingUsd: 0n },
      { index: 2, marketToken: 'ETH', isLong: true, gmPosition: 'p2', sizeUsd: 0n, collateral: 0n, pendingUsd: USD },
    ],
    positions: new Map([['p0', pos(1_000n, 50n)], ['p1', pos(500n, 50n)]]),
    // All 8 tracked: BTC's stop-loss, a pending ETH limit increase, and six BTC take-profit ladders.
    orders: [o('slBtc', 1, 'stopLoss'), o('incEth', 2, 'limit'), ...Array.from({ length: 6 }, (_, i) => o(`tpBtc${i}`, 1, 'takeProfit'))],
    markets: new Map([
      ['NVDA', { symbol: 'NVDA', open: true, schedule: 'nyse', closedMaxLeverageBps: 80_000 }],
      ['BTC', { symbol: 'BTC', open: true, schedule: null, closedMaxLeverageBps: 0 }],
      ['ETH', { symbol: 'ETH', open: true, schedule: null, closedMaxLeverageBps: 0 }],
    ]),
  };
  const step = planStep(view, { now: Date.parse('2026-09-23T19:50:00Z'), ownerSolMin: 50_000_000n, tradingPaused: false, upgradePending: false });
  assert.equal(step?.kind, 'session');
  const cancelled = step!.actions.filter((a) => a.type === 'cancel').map((a) => (a as { order: string }).order);
  assert.ok(!cancelled.includes('slBtc'), `the keeper cancelled ${cancelled.join(', ')}: the open BTC position loses its stop-loss (the trader is not told) while a pending increase stays`);
});

test('critical finding, keeper side: a props_vault transaction left unindexed for over 5 minutes raises an alert', async () => {
  await t.db.delete(gmtradeDeploys);
  const chain = fakeChain();
  const program = PROPS_VAULT_PROGRAM_ID.toBase58();
  await t.db.insert(indexerCursors).values({ program, signature: 'indexedSig', slot: 5 }).onConflictDoUpdate({ target: indexerCursors.program, set: { signature: 'indexedSig' } });
  let waiting: { signature: string; blockTime: number }[] = [];
  const untils: (string | undefined)[] = [];
  const rpc = {
    ...chain.rpc,
    async getSignaturesForAddress(_p: PublicKey, o: { until?: string }) {
      untils.push(o.until);
      return waiting.map((w) => ({ ...w, slot: 6, err: null, memo: null }));
    },
  };
  const r = recorder();
  const run = async () => {
    const keeper = createKeeper({
      db: t.db, rpc: rpc as never, client: chain.client, reader: { evaluation: async () => { throw new Error('unused'); }, market: async () => sol },
      marketdata: openSol as never, risk: Keypair.generate(), sealer, log: silentLog, alerts: r.a, notify: async () => {},
    });
    const stop = new AbortController();
    await runTicks(keeper, stop, keeper.run(stop.signal, async () => true, 20), 1);
  };
  const now = Math.floor(Date.now() / 1000);
  waiting = [{ signature: 'newSig', blockTime: now - 30 }]; // just landed: the indexer has time
  await run();
  assert.equal(untils.at(-1), 'indexedSig', 'counts what is newer than the indexer\'s cursor');
  assert.ok(!r.alerts.some((a) => a.key === 'indexer'));
  waiting = [{ signature: 'newSig', blockTime: now - 30 }, { signature: 'stuckSig', blockTime: now - 7 * 60 }];
  await run();
  const alert = r.alerts.find((a) => a.key === 'indexer');
  assert.equal(alert?.level, 'critical');
  assert.match(alert!.text, /^The props_vault indexer is behind: 2 transaction\(s\) not indexed, the oldest 7 min old \(stuckSig\)/);
  await t.db.delete(indexerCursors);
});

test('a funded account whose equity reached the floor is marked breached, then closed once flat, and stays closed', async () => {
  await t.db.delete(gmtradeDeploys);
  const chain = fakeChain();
  const fundedKey = Keypair.generate().publicKey;
  const address = fundedKey.toBase58();
  await fundedRow(address, Keypair.generate().publicKey.toBase58());
  // Every position was liquidated and the owner holds no USDC: V = 0, the account is flat.
  chain.put(fundedKey, chain.funded('active'));
  chain.put(ownerUsdcAddress(fundedKey), chain.usdc(0n));
  chain.put(ownerPda(fundedKey), chain.system(250_000_000));
  const flatPosition = Keypair.generate().publicKey;
  chain.client.fetchOwnerPositions = async (f) => (f.equals(fundedKey) ? [flatPosition] : []);
  const r = recorder();
  const keeper = createKeeper({
    db: t.db, rpc: chain.rpc as never, client: chain.client, reader: { evaluation: async () => { throw new Error('unused'); }, market: async () => sol },
    marketdata: openSol as never, risk: Keypair.generate(), sealer, log: silentLog, alerts: r.a, notify: async () => {},
  });
  const stop = new AbortController();
  await runTicks(keeper, stop, keeper.run(stop.signal, async () => true, 20), 3);
  assert.deepEqual(chain.lifecycle, ['markBreached', `closeFunded(${flatPosition.toBase58()})`], 'the owner PDA\'s GMTrade positions are passed for the flat check');
  assert.deepEqual(chain.restricted, [], 'no restriction an operator could lift');
  assert.ok(r.alerts.some((a) => a.key === `breach:${address}` && a.level === 'critical'));
  assert.ok(r.alerts.some((a) => a.key === `closed:${address}`));
  await t.db.delete(fundedAccounts).where(eq(fundedAccounts.address, address));
});
