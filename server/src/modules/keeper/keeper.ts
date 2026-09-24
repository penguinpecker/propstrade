// The risk keeper's loop (leader only, ARCHITECTURE.md §4.5). Every tick: watch GMTrade's program for upgrades; for each
// open funded account read the chain, plan the next transaction (rules.ts), send it with the risk authority after
// confirming leadership, then read and plan again until nothing is left; review payout requests; raise alerts.
import { setTimeout as sleep } from 'node:timers/promises';
import { PublicKey, type Connection, type Keypair, type TransactionInstruction } from '@solana/web3.js';
import { and, count, desc, eq, gt, gte, inArray, isNotNull, isNull, max, ne } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Notification } from '@props/shared';
import {
  CLOSE_ALL, GMTRADE_PROGRAM_ID, PROPS_VAULT_PROGRAM_ID, decodeGmPosition, enumName, marketConfigPda, traderProfilePda, type ConfigAccount,
  type PropsVaultClient,
} from '@props/sdk';
import type { Db } from '../../db/client.ts';
import type { Sealer } from '../../lib/integrity.ts';
import { chainJobs, fundedAccounts, gmOrders, gmtradeDeploys, indexerCursors, payouts, venueFills } from '../../db/schema.ts';
import type { KeeperStatus, MarketDataService } from '../types.ts';
import { money } from '../chain/funded.ts';
import { fundedHref } from '../chain/projector.ts';
import { enqueue } from '../chain/jobs.ts';
import { dec, toMicro6, type ChainReader } from '../chain/reader.ts';
import { fitsInTransaction, sendTransaction, type SendRpc } from '../chain/send.ts';
import { readFundedState, valueFunded, type FundedState } from '../chain/venue.ts';
import type { Alerts } from './alerts.ts';
import {
  LINK_WINDOW_MS, exposuresOf, linkedPositions, planStep, programDeploySlot, reviewPayout, upgradeState,
  type AccountView, type Action, type FillRow, type MarketView, type OrderType, type Step, type StepKind,
} from './rules.ts';
import { covers, type Schedule } from './sessions.ts';

/** Transactions per account per tick; each is followed by a fresh read, so this only bounds a pathological loop. */
const MAX_STEPS = 8;
const CHURN_WINDOW_MS = 3_600_000;
/** Orders per account per hour that count as churn (each costs GMTrade execution fees paid from the owner's SOL). */
const CHURN_ALERT_ORDERS = 50;
const CALENDAR_WARNING_MS = 30 * 86_400_000;
/** A props_vault transaction not indexed this long after it landed means the indexer is stuck or down. */
const INDEXER_LAG_ALERT_MS = 5 * 60_000;
const INDEXER_CHECK_EVERY_MS = 60_000;
const FREE = PublicKey.default;
/** A forced close must not fail on price: a long decrease sells at no less than 1, a short buys back at no more than u128::MAX. */
const ANY_PRICE = { long: 1n, short: CLOSE_ALL };
const SCHEDULES: Record<string, Schedule> = { Stocks: 'nyse', Forex: 'fx' };
const ORDER_NAMES: Record<OrderType, string> = { market: 'market order', limit: 'limit order', close: 'close order', takeProfit: 'take-profit', stopLoss: 'stop-loss' };
const GMTRADE_PROGRAM_DATA = PublicKey.findProgramAddressSync([GMTRADE_PROGRAM_ID.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0];

/** Leadership was gone when a transaction was about to be sent: nothing was sent and the term ends. */
export class LeadershipLost extends Error {}

export interface KeeperDeps {
  db: Db;
  rpc: SendRpc & Pick<Connection, 'getAccountInfo' | 'getMultipleAccountsInfo' | 'getMultipleAccountsInfoAndContext' | 'getSignaturesForAddress'>;
  client: PropsVaultClient;
  reader: ChainReader;
  marketdata?: Pick<MarketDataService, 'market' | 'marketState'>;
  /** Signs every keeper transaction; without it the keeper only watches and alerts. */
  risk?: Keypair;
  /** Seals the payout approvals the keeper queues for the chain-job executor. */
  sealer: Sealer;
  /** GMTrade's reviewed deploy slot (GMTRADE_DEPLOY_SLOT): on first sight any other deploy is an unreviewed upgrade. */
  reviewedDeploySlot?: number;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  notify(wallet: string, n: Pick<Notification, 'title' | 'body' | 'href' | 'kind'>): Promise<void>;
  alerts: Alerts;
  now?: () => number;
}

type Read = { state: FundedState; view: AccountView };
const big = (v: { toString(): string }) => BigInt(v.toString());

export function createKeeper(d: KeeperDeps) {
  const { db, rpc, client } = d;
  const clock = d.now ?? Date.now;
  const status: KeeperStatus = { leader: false, lastTickAt: null, gmtradeUpgrade: null };
  let indexerCheckedAt = 0;

  // ---------- reading an account ----------

  function marketViews() {
    const cache = new Map<string, Promise<MarketView>>();
    const load = async (token: string): Promise<MarketView> => {
      const info = await d.reader.market(token);
      const config = await client.fetch('marketConfig', marketConfigPda(new PublicKey(token)));
      const market = d.marketdata?.market(info.symbol);
      const schedule = config?.sessionRestricted ? SCHEDULES[market?.category ?? ''] ?? null : null;
      if (config?.sessionRestricted && !schedule) {
        d.alerts.send(`schedule:${info.symbol}`, 'warning', `${info.symbol} is session-restricted but its session hours are unknown (category ${market?.category ?? 'unavailable'}): the session guard cannot protect it`);
      }
      return { symbol: info.symbol, open: market?.session === 'open', schedule, closedMaxLeverageBps: config?.closedMaxLeverageBps ?? 0 };
    };
    return (token: string) => {
      let v = cache.get(token);
      if (!v) cache.set(token, (v = load(token)));
      return v;
    };
  }

  async function readAccount(funded: string, market: (token: string) => Promise<MarketView>): Promise<Read | null> {
    const state = await readFundedState(d, funded);
    if (!state) return null;
    const valuation = await valueFunded(d, funded, state);
    const netValue = new Map(valuation.positions.map((p) => [p.address, p.status?.netValue ?? null]));
    const orderKeys = state.orders.map((o) => o.tracked.order.toBase58());
    const created = new Map(orderKeys.length
      ? (await db.select({ address: gmOrders.address, at: gmOrders.createdAt }).from(gmOrders).where(inArray(gmOrders.address, orderKeys))).map((r) => [r.address, r.at.getTime()])
      : []);
    const slots = state.account.slots.flatMap((s, index) => (s.marketToken.equals(FREE) ? [] : [{
      index, marketToken: s.marketToken.toBase58(), isLong: s.isLong, gmPosition: s.gmPosition.toBase58(),
      sizeUsd: big(s.sizeUsd), collateral: big(s.collateral), pendingUsd: big(s.pendingUsd),
    }]));
    const trusted = valuation.freshness === 'live' || valuation.freshness === 'delayed';
    return {
      state,
      view: {
        funded, status: enumName(state.account.status), slots,
        orders: state.orders.map((o, i) => ({
          order: orderKeys[i]!, slot: o.tracked.slot, type: enumName<OrderType>(o.tracked.orderType), sizeUsd: big(o.tracked.sizeUsd),
          placedByRisk: o.tracked.placedByRisk, state: o.state, createdAt: created.get(orderKeys[i]!),
        })),
        positions: new Map(state.positions.map((p) => [p.address, {
          size: p.position.sizeInUsd, collateral: p.position.collateralAmount, netValue: netValue.get(p.address) ?? null,
        }])),
        value: trusted ? money(valuation, big(state.account.principal)).value : null,
        ownerLamports: state.ownerLamports,
        markets: new Map(await Promise.all(slots.map(async (s) => [s.marketToken, await market(s.marketToken)] as const))),
      },
    };
  }

  // ---------- sending ----------

  async function instruction(a: Action, state: FundedState, address: PublicKey, removed: Set<string>, ordersBefore: number, risk: Keypair): Promise<TransactionInstruction> {
    const ref = { address, account: state.account };
    switch (a.type) {
      case 'topUp': return client.topUpOwner({ funded: address });
      case 'restrict': return client.restrict({ riskAuthority: risk.publicKey, funded: address, restricted: true });
      case 'markBreached': return client.markBreached({ riskAuthority: risk.publicKey, funded: address });
      // The program re-checks every existing GMTrade position of the owner PDA as flat.
      case 'closeFunded': return client.closeFunded({ riskAuthority: risk.publicKey, funded: ref, positions: await client.fetchOwnerPositions(address) });
      case 'closeCompleted': return client.closeCompletedOrder({ funded: address, order: new PublicKey(a.order) });
      case 'cancel': return client.cancelOrder({ authority: risk.publicKey, funded: ref, order: new PublicKey(a.order) });
      case 'sync': {
        // Orders closed earlier in the same transaction are no longer tracked when sync runs.
        const orders = state.account.orders.map((o) => (removed.has(o.order.toBase58()) ? { ...o, order: FREE } : o));
        return client.sync({ funded: { address, account: { ...state.account, orders } } });
      }
      case 'close': {
        const slot = state.account.slots[a.slot]!;
        const close = await client.closePosition({
          authority: risk.publicKey, funded: ref, marketToken: slot.marketToken, isLong: slot.isLong, sizeDeltaUsd: CLOSE_ALL,
          acceptablePrice: slot.isLong ? ANY_PRICE.long : ANY_PRICE.short, ordersBefore,
        });
        return close.instruction;
      }
    }
  }

  /** Sends as much of the step as fits in one transaction (in order); returns what was sent. */
  async function execute(step: Step, state: FundedState, funded: string, risk: Keypair, held: () => Promise<boolean>) {
    const address = new PublicKey(funded);
    const removed = new Set<string>();
    const sent: Action[] = [];
    const instructions: TransactionInstruction[] = [];
    let ordersBefore = 0;
    for (const a of step.actions) {
      const ix = await instruction(a, state, address, removed, ordersBefore, risk);
      if (!fitsInTransaction(risk.publicKey, [...instructions, ix])) break;
      instructions.push(ix);
      sent.push(a);
      if (a.type === 'cancel' || a.type === 'closeCompleted') removed.add(a.order);
      if (a.type === 'close') ordersBefore++;
    }
    if (!instructions.length) throw new Error(`${step.actions[0]!.type} does not fit in a transaction`);
    const signature = await sendTransaction(rpc, {
      instructions, signer: risk,
      beforeSend: async () => {
        if (!(await held())) throw new LeadershipLost('leadership lost before sending');
      },
    });
    return { signature, sent };
  }

  async function reportSent(step: Step, sent: Action[], read: Read, trader: string, signature: string) {
    const { funded } = read.view;
    d.log.info({ funded, kind: step.kind, actions: sent.map((a) => a.type), signature }, `keeper: ${step.detail}`);
    const href = fundedHref(funded);
    const cancelled = sent.flatMap((a) => {
      const o = a.type === 'cancel' ? read.view.orders.find((x) => x.order === a.order) : undefined;
      const slot = o && read.view.slots.find((s) => s.index === o.slot);
      return o && slot ? [`${ORDER_NAMES[o.type]} on ${slot.isLong ? 'Long' : 'Short'} ${read.view.markets.get(slot.marketToken)?.symbol ?? 'an unknown market'}`] : [];
    });
    if (cancelled.length && (step.kind === 'breach' || step.kind === 'session')) {
      await d.notify(trader, {
        kind: 'risk', title: cancelled.length === 1 ? 'Pending order cancelled' : 'Pending orders cancelled', href,
        body: `An account holds at most 8 GMTrade orders, so to place its closing order the risk service cancelled your ${cancelled.join(', ')}.`,
      });
    }
    // The trader hears of a breach from the indexed AccountBreached event (chain projector).
    if (step.kind === 'breach') {
      d.alerts.send(`breach:${funded}`, 'critical', `Funded account ${funded} reached its equity floor: marked breached and closing every open position; it is closed once flat (last transaction ${signature})`);
    }
    if (step.kind === 'closure') {
      d.alerts.send(`closed:${funded}`, 'info', `Breached funded account ${funded} closed: its USDC and SOL are back in the vault and its principal is released (${signature})`);
    }
    if (step.kind === 'session') {
      for (const a of sent) {
        if (a.type !== 'close') continue;
        const slot = read.view.slots.find((s) => s.index === a.slot)!;
        const market = read.view.markets.get(slot.marketToken)!;
        const p = read.view.positions.get(slot.gmPosition)!;
        const margin = p.netValue ?? p.collateral * 10n ** 14n;
        await d.notify(trader, {
          kind: 'risk', title: `${slot.isLong ? 'Long' : 'Short'} ${market.symbol} closed before the market closes`, href,
          body: margin > 0n
            ? `At ${Number((p.size * 100n) / margin) / 100}x leverage it was above the ${market.closedMaxLeverageBps / 10_000}x allowed through the session close, so the risk service closed it.`
            : 'It had no margin left to hold through the session close, so the risk service closed it.',
        });
      }
    }
  }

  async function runAccount(row: { address: string; trader: string }, ctx: { config: ConfigAccount; upgradePending: boolean; held: () => Promise<boolean>; market: (t: string) => Promise<MarketView> }) {
    const skip = new Set<StepKind>();
    let breachSeen = false;
    let read = await readAccount(row.address, ctx.market);
    for (let i = 0; read && i < MAX_STEPS; i++) {
      const step = planStep(read.view, { now: clock(), ownerSolMin: big(ctx.config.ownerSolMin), tradingPaused: ctx.config.paused.trading, upgradePending: ctx.upgradePending, skip });
      if (!step) break;
      if (step.actions.some((a) => a.type === 'markBreached') && !breachSeen) {
        // Marking an account breached ends it for good: act only when a second, fresh read agrees.
        breachSeen = true;
        read = await readAccount(row.address, ctx.market);
        continue;
      }
      if (!d.risk) {
        d.alerts.send(`nokey:${row.address}:${step.kind}`, 'critical', `Funded account ${row.address} needs a ${step.kind} transaction (${step.detail}) but RISK_AUTHORITY_KEYPAIR is not set`);
        break;
      }
      const result = await execute(step, read.state, row.address, d.risk, ctx.held).catch((err: unknown) => {
        if (err instanceof LeadershipLost) throw err;
        skip.add(step.kind);
        const urgent = step.kind === 'breach' || step.kind === 'session' || step.kind === 'upgrade';
        d.alerts.send(`failed:${row.address}:${step.kind}`, urgent ? 'critical' : 'warning', `Keeper ${step.kind} transaction for ${row.address} failed (${step.detail}): ${(err as Error).message}`);
        return null;
      });
      if (result) {
        await reportSent(step, result.sent, read, row.trader, result.signature)
          .catch((err: unknown) => d.log.warn({ err, funded: row.address }, 'keeper: trader notification failed'));
      }
      read = await readAccount(row.address, ctx.market);
    }
    return read?.view ?? null;
  }

  // ---------- GMTrade upgrade watch ----------

  /**
   * The GMTrade deploy running now, and whether it is an upgrade no operator has acknowledged yet: until then every
   * active account is restricted, tick after tick, and payouts wait.
   */
  async function watchUpgrade(): Promise<{ pending: boolean; slot: number }> {
    const info = await rpc.getAccountInfo(GMTRADE_PROGRAM_DATA, { dataSlice: { offset: 0, length: 12 } });
    if (!info) throw new Error('GMTrade program data account not found');
    const slot = programDeploySlot(info.data);
    const newest = async () => (await db.select().from(gmtradeDeploys).orderBy(desc(gmtradeDeploys.slot)).limit(1))[0];
    const latest = await newest();
    const state = upgradeState(latest, slot);
    const now = new Date();
    const pinned = d.reviewedDeploySlot;
    if (state === 'first' && (pinned === undefined || pinned === slot)) {
      await db.insert(gmtradeDeploys).values({ slot, acknowledgedAt: now, handledAt: now }).onConflictDoNothing();
      if (pinned === undefined) {
        d.alerts.send(`gmtrade-baseline:${slot}`, 'warning', `GMTrade deploy slot ${slot} was accepted as the reviewed release on first sight: set GMTRADE_DEPLOY_SLOT to the reviewed deploy to pin it`, Infinity);
      }
    } else if (state === 'first' || state === 'upgraded') {
      await db.insert(gmtradeDeploys).values({ slot, detectedAt: now }).onConflictDoNothing();
      const was = latest ? `previously ${latest.slot}` : `the reviewed deploy is ${pinned}`;
      d.alerts.send(`gmtrade-upgrade:${slot}`, 'critical', `GMTrade's program is not the reviewed release (deploy slot ${slot}, ${was}): every active funded account is restricted to closing positions and payouts wait until an operator acknowledges it (POST /v1/admin/gmtrade-deploys/${slot}/acknowledge)`);
    }
    const current = (await newest())!;
    const [upgrade] = await db.select().from(gmtradeDeploys).where(isNotNull(gmtradeDeploys.detectedAt)).orderBy(desc(gmtradeDeploys.slot)).limit(1);
    status.gmtradeUpgrade = upgrade ? {
      slot: upgrade.slot, detectedAt: upgrade.detectedAt!.getTime(), restrictedAt: upgrade.handledAt?.getTime() ?? null, acknowledgedAt: upgrade.acknowledgedAt?.getTime() ?? null,
    } : null;
    return { pending: !current.acknowledgedAt, slot: current.slot };
  }

  // ---------- payout review ----------

  const fillRow = (f: typeof venueFills.$inferSelect): FillRow => ({ ...f, account: f.fundedAccount });

  async function review(p: typeof payouts.$inferSelect, trader: string) {
    const request = await client.fetch('payoutRequest', new PublicKey(p.address));
    if (!request || enumName(request.status) !== 'requested') return; // resolved onchain; the indexer catches up
    const funded = new PublicKey(p.fundedAccount);
    const account = await client.fetchFunded(funded);
    if (!account) return;
    const owned = await client.fetchOwnerPositions(funded);
    const infos = owned.length ? await rpc.getMultipleAccountsInfo(owned) : [];
    const flat = account.slots.every((s) => s.marketToken.equals(FREE)) && account.orders.every((o) => o.order.equals(FREE))
      && infos.every((i) => i?.owner.equals(GMTRADE_PROGRAM_ID) && decodeGmPosition(i.data).sizeInUsd === 0n);
    const profile = await client.fetch('traderProfile', traderProfilePda(new PublicKey(trader)));
    const [lastPaid] = await db.select({ at: max(payouts.requestedAt) }).from(payouts)
      .where(and(eq(payouts.fundedAccount, p.fundedAccount), eq(payouts.status, 'paid')));
    const fills = (await db.select().from(venueFills)
      .where(and(eq(venueFills.fundedAccount, p.fundedAccount), lastPaid?.at ? gt(venueFills.ts, lastPaid.at) : undefined))).map(fillRow);
    const ours = exposuresOf(fills);
    const others = ours.length
      ? (await db.select().from(venueFills).where(and(
        ne(venueFills.fundedAccount, p.fundedAccount), inArray(venueFills.symbol, [...new Set(ours.map((e) => e.symbol))]),
        gte(venueFills.ts, new Date(Math.min(...ours.map((e) => e.at)) - LINK_WINDOW_MS)),
      ))).map(fillRow)
      : [];
    const r = reviewPayout({
      profit: toMicro6(p.profit), requestedAt: p.requestedAt.getTime(), flat, verified: !!profile?.identityHash.some((b) => b !== 0),
      fills, links: linkedPositions(ours, exposuresOf(others), clock()), now: clock(),
    });
    if (r.decision === 'approve') {
      if (await enqueue(db, d.sealer, 'approve_payout', p.address, { payout: p.address })) d.log.info({ payout: p.address }, 'keeper: payout approved for payment');
    } else if (r.decision === 'hold') {
      const reviewNote = r.reasons.join('; ');
      const [held] = await db.update(payouts).set({ status: 'reviewing', reviewNote })
        .where(and(eq(payouts.address, p.address), eq(payouts.status, 'requested'))).returning({ address: payouts.address });
      if (held) d.alerts.send(`payout:${p.address}`, 'warning', `Payout ${p.address} (${dec(p.traderAmount)} USDC to the trader) held for manual review: ${reviewNote}`);
    }
  }

  /** Skipped while payouts are paused or a GMTrade upgrade awaits review (payouts are decided on the reviewed release). */
  async function reviewPayouts(config: ConfigAccount, upgradePending: boolean) {
    if (config.paused.payouts || upgradePending) return;
    const rows = await db.select({ payout: payouts, trader: fundedAccounts.trader }).from(payouts)
      .innerJoin(fundedAccounts, eq(fundedAccounts.address, payouts.fundedAccount))
      .leftJoin(chainJobs, eq(chainJobs.subject, payouts.address))
      .where(and(eq(payouts.status, 'requested'), isNull(chainJobs.id)));
    for (const { payout, trader } of rows) {
      await review(payout, trader).catch((err: unknown) => d.log.warn({ err, payout: payout.address }, 'payout review failed; retrying next tick'));
    }
  }

  // ---------- operator checks ----------

  async function checks(openBySymbol: Map<string, number>, now: number) {
    for (const [symbol, positions] of openBySymbol) {
      const m = d.marketdata?.market(symbol);
      if (m && (m.session === 'closed' || m.freshness === 'live' || m.freshness === 'delayed')) continue;
      const age = m?.updatedAt ? `${Math.round((now - m.updatedAt) / 1000)} s old` : 'unavailable';
      d.alerts.send(`stale:${symbol}`, 'warning', `${symbol} prices are ${age} with ${positions} funded position(s) open: the keeper cannot value them`);
    }
    const churn = await db.select({ funded: gmOrders.fundedAccount, n: count() }).from(gmOrders)
      .where(gt(gmOrders.createdAt, new Date(now - CHURN_WINDOW_MS))).groupBy(gmOrders.fundedAccount).having(gte(count(), CHURN_ALERT_ORDERS));
    for (const c of churn) d.alerts.send(`churn:${c.funded}`, 'warning', `Funded account ${c.funded} created ${c.n} GMTrade orders in the last hour`);
    const failed = await db.select().from(chainJobs).where(and(eq(chainJobs.status, 'failed'), gt(chainJobs.updatedAt, new Date(now - 86_400_000))));
    for (const j of failed) {
      d.alerts.send(`job:${j.id}`, 'critical', `Chain job ${j.kind} for ${j.subject ?? j.id} failed for good: ${j.lastError}. Once the cause is fixed: POST /v1/admin/jobs/${j.id}/retry`, Infinity);
    }
    if (!covers(now + CALENDAR_WARNING_MS)) d.alerts.send('calendar', 'warning', 'The NYSE holiday calendar in keeper/sessions.ts ends within 30 days: add next year\'s dates', 86_400_000);
    await checkIndexer().catch((err: unknown) => d.log.warn({ err }, 'keeper: indexer check failed'));
  }

  /**
   * Alerts when a props_vault transaction has waited too long for the chain module's indexer (stuck on a transaction,
   * or not running): purchases, activations, payouts and new funded accounts then reach neither the app nor this keeper.
   */
  async function checkIndexer() {
    if (Date.now() - indexerCheckedAt < INDEXER_CHECK_EVERY_MS) return;
    indexerCheckedAt = Date.now();
    const [cursor] = await db.select({ signature: indexerCursors.signature }).from(indexerCursors).where(eq(indexerCursors.program, PROPS_VAULT_PROGRAM_ID.toBase58()));
    const waiting = await rpc.getSignaturesForAddress(PROPS_VAULT_PROGRAM_ID, { until: cursor?.signature, limit: 1_000 }, 'confirmed');
    const oldest = waiting.at(-1);
    if (!oldest?.blockTime || Date.now() - oldest.blockTime * 1000 < INDEXER_LAG_ALERT_MS) return;
    d.alerts.send('indexer', 'critical', `The props_vault indexer is behind: ${waiting.length}${waiting.length === 1_000 ? '+' : ''} transaction(s) not indexed, the oldest `
      + `${Math.round((Date.now() - oldest.blockTime * 1000) / 60_000)} min old (${oldest.signature}); purchases, activations and payouts are not being processed`);
  }

  // ---------- loop ----------

  async function tick(held: () => Promise<boolean>, lost: AbortSignal) {
    const config = await client.fetchConfig();
    if (!config) {
      d.log.warn('props_vault is not initialized: keeper idle');
      return;
    }
    // A failed watch must not hold up stop-outs and session closes; it is retried next tick.
    const upgrade = await watchUpgrade().catch((err: unknown) => {
      d.alerts.send('gmtrade-watch', 'warning', `GMTrade upgrade watch failed: ${(err as Error).message}`);
      return { pending: false, slot: -1 };
    });
    const market = marketViews();
    // ponytail: each account is read here and again by the chain module's venue loop; share one read per tick if RPC load matters.
    const rows = await db.select({ address: fundedAccounts.address, trader: fundedAccounts.trader }).from(fundedAccounts).where(ne(fundedAccounts.status, 'closed'));
    const openBySymbol = new Map<string, number>();
    let active = 0;
    for (const row of rows) {
      if (lost.aborted) return;
      try {
        const view = await runAccount(row, { config, upgradePending: upgrade.pending, held, market });
        if (!view) continue;
        if (view.status === 'active') active++;
        for (const s of view.slots) {
          if ((view.positions.get(s.gmPosition)?.size ?? 0n) === 0n) continue;
          const { symbol } = view.markets.get(s.marketToken)!;
          openBySymbol.set(symbol, (openBySymbol.get(symbol) ?? 0) + 1);
        }
      } catch (err) {
        if (err instanceof LeadershipLost) throw err;
        active++; // unknown: keep an upgrade's restriction pass open
        d.log.error({ err, funded: row.address }, 'keeper: account pass failed');
        d.alerts.send(`read:${row.address}`, 'critical', `Keeper cannot read or value funded account ${row.address}: no stop-out, session guard or upgrade restriction for it until this clears (${(err as Error).message})`);
      }
    }
    if (upgrade.pending && !active) {
      const [restricted] = await db.update(gmtradeDeploys).set({ handledAt: new Date() })
        .where(and(eq(gmtradeDeploys.slot, upgrade.slot), isNull(gmtradeDeploys.handledAt))).returning({ at: gmtradeDeploys.handledAt });
      if (restricted) {
        d.alerts.send(`gmtrade-restricted:${upgrade.slot}`, 'warning', 'Every active funded account is restricted after the GMTrade upgrade: once the new release is reviewed, acknowledge it, then lift each restriction (POST /v1/admin/funded/:id/lift-restriction)');
        if (status.gmtradeUpgrade?.slot === upgrade.slot) status.gmtradeUpgrade.restrictedAt = restricted.at!.getTime();
      }
    }
    await reviewPayouts(config, upgrade.pending);
    await checks(openBySymbol, clock());
  }

  /** Leader loop: one tick every `intervalMs`; returns when leadership is lost (or found gone right before a send). */
  async function run(lost: AbortSignal, held: () => Promise<boolean>, intervalMs = 5_000) {
    if (!d.risk) d.log.error('RISK_AUTHORITY_KEYPAIR is not set: the keeper watches and alerts but cannot act');
    status.leader = true;
    try {
      while (!lost.aborted) {
        const started = Date.now();
        try {
          await tick(held, lost);
          status.lastTickAt = Date.now();
          d.alerts.heartbeat();
        } catch (err) {
          if (err instanceof LeadershipLost) {
            d.log.warn('keeper: leadership lost before a send; nothing was sent, stepping down');
            return;
          }
          d.alerts.send('tick', 'critical', `Keeper tick failed: ${(err as Error).message}`);
        }
        await sleep(Math.max(0, intervalMs - (Date.now() - started)), undefined, { signal: lost }).catch(() => {});
      }
    } finally {
      status.leader = false;
    }
  }

  return { run, status: (): KeeperStatus => ({ ...status, gmtradeUpgrade: status.gmtradeUpgrade && { ...status.gmtradeUpgrade } }) };
}
