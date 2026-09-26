// Funded accounts through the AccountsProvider contract, plus payouts and payout eligibility. Money comes from the
// venue valuation (onchain balances + the GMTrade model); history, activity and orders from the indexed tables.
//
// For a funded account with size S and loss allowance L (the principal posted):
//   value V   = owner USDC + collateral escrowed in pending increase orders + Σ position net value (model, no debt)
//               − Props fees executed orders owe and nothing has charged yet (chain/fees.ts)
//   equity    = S − L + V            (so the allowance, equity − floor, is V itself)
//   unrealized= Σ (position net value − its collateral)      realized = V − L − unrealized
//   available margin = owner USDC − the Props fees the program holds (due + those of pending increases)
import { and, asc, desc, eq, gte, isNull } from 'drizzle-orm';
import type {
  AccountStatus, AccountSummary, ActivityItem, ClosedTrade, DataFreshness, Order, Payout, PayoutEligibility, Performance, Position,
} from '@props/shared';
import { BPS, orderFee } from '@props/sdk';
import { formatFixed, parseFixed } from '@props/gmtrade';
import type { Db } from '../../db/client.ts';
import {
  accountEvents, accounts, closedTrades, equitySnapshots, evaluations, fundedAccounts, gmOrders, gmPositionSnapshots, orderFees, payouts, venueFills,
} from '../../db/schema.ts';
import { chargedSince } from './fees.ts';
import type { AccountsProvider } from '../types.ts';
import type { ProgramReader } from './program.ts';
import { rejectionReason } from './projector.ts';
import { dec, decPrice, gmUsd, micro, toMicro6, tokenAmount, unitPrice } from './reader.ts';
import type { Valuation, Venue } from './venue.ts';

const MICRO_TO_GM = 10n ** 14n;
const fmt6 = (micros: bigint) => formatFixed(micros, 6, 6);
const toGmUsd = (v: string) => parseFixed(v, 20); // API decimal → GMTrade USD
const PERIOD_MS: Record<Performance['period'], number | null> = { '1W': 7 * 86_400_000, '1M': 30 * 86_400_000, All: null };

const STATUS: Record<string, AccountStatus> = {
  active: 'active', restricted: 'restricted', payoutPending: 'payout_pending', breached: 'breached', closed: 'closed',
  payout_pending: 'payout_pending',
};

type AccountRow = typeof accounts.$inferSelect;
type FundedRow = typeof fundedAccounts.$inferSelect;

/** Money of a funded account in GMTrade USD (1e20), from a valuation. */
export function money(v: Valuation, principal: bigint /* micro */) {
  let value = (v.ownerUsdc + v.pendingCollateral - v.fees.owed) * MICRO_TO_GM;
  let unrealized = 0n;
  let notional = 0n;
  for (const p of v.positions) {
    const collateral = p.position.collateralAmount * MICRO_TO_GM;
    notional += p.position.sizeInUsd;
    // An unvalued position counts at its collateral (cost) and the valuation is flagged unavailable.
    value += p.status ? p.status.netValue : collateral;
    if (p.status) unrealized += p.status.netValue - collateral;
  }
  return { value, unrealized, realized: value - principal * MICRO_TO_GM - unrealized, notional };
}

export function createFundedProvider(d: { db: Db; venue: Venue; program: ProgramReader }): AccountsProvider & {
  isFunded(id: string): Promise<boolean>;
  summaryOf(row: AccountRow, funded: FundedRow, v: Valuation | null): Promise<AccountSummary>;
  positionsOf(v: Valuation, funded: string): Promise<Position[]>;
  eligibility(wallet: string, id: string): Promise<PayoutEligibility | undefined>;
  payouts(wallet: string): Promise<Payout[]>;
  payout(wallet: string, id: string): Promise<Payout | undefined>;
} {
  const { db, venue } = d;

  async function owned(wallet: string, id: string) {
    const [row] = await db.select().from(accounts).innerJoin(fundedAccounts, eq(fundedAccounts.address, accounts.id))
      .where(and(eq(accounts.id, id), eq(accounts.wallet, wallet), eq(accounts.stage, 'funded')));
    return row;
  }

  async function valuation(funded: string): Promise<Valuation | null> {
    try {
      return await venue.valuation(funded);
    } catch {
      return null; // RPC unavailable: the summary falls back to the last equity snapshot, flagged stale
    }
  }

  async function summaryOf(row: AccountRow, funded: FundedRow, v: Valuation | null): Promise<AccountSummary> {
    const size = toGmUsd(row.sizeUsd);
    const principal = toMicro6(funded.principal);
    const floor = size - principal * MICRO_TO_GM;
    const [evaluation] = await db.select({ purchase: evaluations.purchaseSignature }).from(evaluations).where(eq(evaluations.address, funded.evaluation));
    let equity: bigint;
    let realized: bigint;
    let unrealized: bigint;
    let notional = 0n;
    let available = 0n;
    let freshness: DataFreshness;
    let fees: { due: bigint; paid: bigint; held: bigint };
    let status = STATUS[funded.status]!;
    // A closed account holds nothing onchain any more: its final state is the snapshot taken when it closed.
    if (v && v.status !== 'closed' && funded.status !== 'closed') {
      const m = money(v, principal);
      // New exposure must leave the fees the program holds in the USDC: what is left is the margin an order may commit.
      const free = v.ownerUsdc - v.fees.held;
      [equity, realized, unrealized, notional, available, freshness, fees] = [floor + m.value, m.realized, m.unrealized, m.notional, free > 0n ? free : 0n, v.freshness, v.fees];
      // A breached account still holding positions or orders is being closed ('Closing', a current account in the app);
      // it reads 'breached' (ended) once flat.
      status = v.status === 'breached' && !v.flat ? 'closure_pending' : STATUS[v.status] ?? status;
    } else {
      const [last] = await db.select().from(equitySnapshots).where(eq(equitySnapshots.accountId, row.id)).orderBy(desc(equitySnapshots.ts)).limit(1);
      equity = toGmUsd(last?.equity ?? row.sizeUsd);
      realized = toGmUsd(last?.realizedPnl ?? '0');
      unrealized = toGmUsd(last?.unrealizedPnl ?? '0');
      freshness = funded.status === 'closed' ? 'live' : 'stale'; // a closed account's last snapshot is its final state
      fees = { due: 0n, paid: await chargedSince(db, row.id, null), held: 0n };
    }
    const profit = realized > 0n ? realized / MICRO_TO_GM : 0n;
    return {
      id: row.id, stage: 'funded', status, label: row.label, shortId: `PT-${row.id.slice(0, 4)}…`,
      rules: {
        sizeUsd: dec(row.sizeUsd), lossAllowanceUsd: dec(funded.principal), floorUsd: gmUsd(floor), profitTargetUsd: null,
        maxExposureUsd: gmUsd((size * BigInt(row.maxExposureBps)) / BigInt(BPS)), traderShareBps: row.traderShareBps,
        drawdownType: 'static', includesOpenPnl: true, dailyLossLimit: null, timeLimit: null,
        termsHash: row.termsHash, version: row.termsVersion,
      },
      equity: gmUsd(equity), realizedPnl: gmUsd(realized), unrealizedPnl: gmUsd(unrealized),
      allowanceRemaining: gmUsd(equity - floor), availableMargin: micro(available), openNotional: gmUsd(notional),
      platformFees: { dueUsd: micro(fees.due), paidUsd: micro(fees.paid), heldUsd: micro(fees.held) },
      targetProgressPct: null,
      eligiblePayout: fmt6((profit * BigInt(row.traderShareBps)) / BigInt(BPS)),
      createdAt: row.createdAt.getTime(), activatedAt: row.activatedAt?.getTime() ?? null, resolvedAt: row.resolvedAt?.getTime() ?? null,
      evidence: {
        evaluation: funded.evaluation, funded: funded.address, owner: funded.ownerPda,
        purchaseSignature: evaluation?.purchase, activationSignature: funded.activationSignature,
      },
      freshness,
    };
  }

  async function ordersOf(funded: string): Promise<Order[]> {
    const rows = await db.select({ o: gmOrders, fee: orderFees.assessedUsd }).from(gmOrders).leftJoin(orderFees, eq(orderFees.order, gmOrders.address))
      .where(and(eq(gmOrders.fundedAccount, funded), isNull(gmOrders.closedAt))).orderBy(asc(gmOrders.createdAt));
    return rows.map(({ o, fee }) => ({
      id: o.address, symbol: o.symbol, side: o.side, kind: o.kind, isIncrease: o.isIncrease, sizeUsd: dec(o.sizeUsd),
      collateralUsd: o.collateralUsd === null ? null : dec(o.collateralUsd), triggerPrice: o.triggerPrice && decPrice(o.triggerPrice), acceptablePrice: o.acceptablePrice && decPrice(o.acceptablePrice),
      status: o.status, statusDetail: o.statusDetail ?? undefined, createdAt: o.createdAt.getTime(), updatedAt: o.updatedAt.getTime(),
      platformFeeUsd: dec(fee ?? '0'), signature: o.createSignature, gmOrder: o.address,
    }));
  }

  async function positionsOf(v: Valuation, funded: string): Promise<Position[]> {
    const [orders, rate] = await Promise.all([ordersOf(funded), d.program.orderFeeRate()]);
    const out: Position[] = [];
    for (const p of v.positions) {
      const { market, position, status } = p;
      const side = p.isLong ? 'Long' : 'Short';
      const protection = (kind: 'TakeProfit' | 'StopLoss') => {
        const o = orders.find((x) => x.kind === kind && x.symbol === market.symbol && x.side === side);
        return o?.triggerPrice ? { price: o.triggerPrice, orderId: o.id, status: o.status } : null;
      };
      const [opening] = await db.select({ ts: venueFills.ts }).from(venueFills)
        .where(and(eq(venueFills.position, p.address), eq(venueFills.isIncrease, true))).orderBy(desc(venueFills.venueId)).limit(1);
      const [snapshot] = opening ? [] : await db.select({ ts: gmPositionSnapshots.ts }).from(gmPositionSnapshots)
        .where(eq(gmPositionSnapshots.position, p.address)).orderBy(desc(gmPositionSnapshots.slot)).limit(1);
      const collateral = position.collateralAmount * MICRO_TO_GM;
      // GMTrade's entry price is size_in_usd / size_in_tokens; in USD per whole token that is scaled by the decimals.
      const entry = (position.sizeInUsd * 10n ** BigInt(market.decimals) * 10n ** 18n) / (position.sizeInTokens * 10n ** 20n);
      const pending = (value: bigint | null | undefined) => (value == null ? '0' : gmUsd(value));
      // A pending market decrease of at least the position's size closes all of it (gm_orders keeps no close-all flag).
      const closing = orders.some((o) => o.kind === 'Market' && !o.isIncrease && o.symbol === market.symbol && o.side === side
        && (o.status === 'awaiting_execution' || o.status === 'awaiting_price') && toGmUsd(o.sizeUsd) >= position.sizeInUsd);
      out.push({
        id: p.address, symbol: market.symbol, side, sizeUsd: gmUsd(position.sizeInUsd),
        sizeTokens: tokenAmount(position.sizeInTokens, market.decimals), collateralUsd: micro(position.collateralAmount),
        leverage: Number((position.sizeInUsd * 10_000n) / (status?.netValue || collateral || 1n)) / 10_000,
        entryPrice: formatFixed(entry, 18, 18), markPrice: p.mark === null ? null : unitPrice(p.mark, market.decimals),
        liquidationPrice: status?.liquidationPrice == null ? null : unitPrice(status.liquidationPrice, market.decimals),
        // Net of pending costs, as the sim values its positions and as the account's unrealized is summed (money()).
        unrealizedPnl: status ? gmUsd(status.netValue - collateral) : null,
        pendingFeesUsd: pending(status && status.pendingBorrowingFeeValue + status.pendingFundingFeeValue + status.closeOrderFeeValue),
        pendingBorrowUsd: pending(status?.pendingBorrowingFeeValue), pendingFundingUsd: pending(status?.pendingFundingFeeValue),
        closeFeeUsd: pending(status?.closeOrderFeeValue), platformFeeUsd: micro(orderFee(rate, position.sizeInUsd)), closing,
        takeProfit: protection('TakeProfit'), stopLoss: protection('StopLoss'),
        openedAt: (opening ?? snapshot)?.ts.getTime() ?? v.at, venue: 'exchange', gmPosition: p.address,
      });
    }
    return out;
  }

  async function history(funded: string, since?: Date, limit?: number): Promise<ClosedTrade[]> {
    const query = db.select().from(closedTrades)
      .where(and(eq(closedTrades.accountId, funded), since ? gte(closedTrades.closedAt, since) : undefined)).orderBy(desc(closedTrades.closedAt)).$dynamic();
    const rows = await (limit ? query.limit(limit) : query);
    return rows.map((t) => ({
      id: t.id, symbol: t.symbol, side: t.side, openedAt: t.openedAt.getTime(), closedAt: t.closedAt.getTime(), sizeUsd: dec(t.sizeUsd),
      entryPrice: decPrice(t.entryPrice), exitPrice: decPrice(t.exitPrice), feesUsd: dec(t.feesUsd), orderFeesUsd: dec(t.orderFeesUsd),
      platformFeeUsd: dec(t.platformFeeUsd), fundingUsd: dec(t.fundingUsd), borrowUsd: dec(t.borrowUsd), priceImpactUsd: dec(t.priceImpactUsd),
      netPnl: dec(t.netPnl),
      venue: t.venue === 'gmtrade' ? 'exchange' : t.venue, signatures: t.signatures,
    }));
  }

  async function performance(row: AccountRow, funded: FundedRow, period: Performance['period']): Promise<Performance> {
    const span = PERIOD_MS[period];
    const since = span === null ? undefined : new Date(Date.now() - span);
    const summary = await summaryOf(row, funded, funded.status === 'closed' ? null : await valuation(row.id));
    const trades = await history(row.id, since);
    const fills = await db.select().from(venueFills).where(and(eq(venueFills.fundedAccount, row.id), since ? gte(venueFills.ts, since) : undefined));
    const points = await db.select().from(equitySnapshots)
      .where(and(eq(equitySnapshots.accountId, row.id), since ? gte(equitySnapshots.ts, since) : undefined)).orderBy(asc(equitySnapshots.ts));
    const size = toMicro6(row.sizeUsd);
    const m6 = (v: string) => parseFixed(v, 6);
    const nets = trades.map((t) => m6(t.netPnl));
    const wins = nets.filter((n) => n > 0n);
    const losses = nets.filter((n) => n < 0n);
    const sum = (list: bigint[]) => list.reduce((s, x) => s + x, 0n);
    const realized = sum(nets);
    const fees = sum(fills.map((f) => toMicro6(f.feeUsd)));
    const platformFees = sum(fills.map((f) => toMicro6(f.platformFeeUsd)));
    const fundingBorrow = sum(fills.map((f) => toMicro6(f.fundingUsd) + toMicro6(f.borrowUsd)));
    const gross = sum(fills.filter((f) => !f.isIncrease).map((f) => toMicro6(f.realizedPnl ?? '0') + toMicro6(f.feeUsd) + toMicro6(f.fundingUsd) + toMicro6(f.borrowUsd)));
    const bySymbol = new Map<string, bigint>();
    for (const t of trades) bySymbol.set(t.symbol, (bySymbol.get(t.symbol) ?? 0n) + m6(t.netPnl));
    const absTotal = sum([...bySymbol.values()].map((v) => (v < 0n ? -v : v)));
    const unrealized = m6(summary.unrealizedPnl);
    return {
      period,
      series: [
        ...points.map((p) => ({ ts: p.ts.getTime(), equity: dec(p.equity), netPnl: fmt6(toMicro6(p.equity) - size) })),
        { ts: Date.now(), equity: summary.equity, netPnl: fmt6(m6(summary.equity) - size) },
      ],
      netPnl: fmt6(realized + unrealized), grossRealized: fmt6(gross), feesUsd: fmt6(fees), platformFeesUsd: fmt6(platformFees), fundingBorrowUsd: fmt6(fundingBorrow),
      unrealizedPnl: summary.unrealizedPnl, trades: trades.length,
      winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
      profitFactor: losses.length ? Number(sum(wins)) / Number(-sum(losses)) : null,
      averageTradeUsd: trades.length ? fmt6(realized / BigInt(trades.length)) : null,
      byMarket: [...bySymbol].map(([symbol, net]) => ({
        symbol, netPnl: fmt6(net), sharePct: absTotal === 0n ? 0 : (Number(net < 0n ? -net : net) / Number(absTotal)) * 100,
      })),
    };
  }

  function payoutOf(p: typeof payouts.$inferSelect, label: string): Payout {
    return {
      id: p.address, account: p.fundedAccount, accountLabel: label, seq: p.seq, status: p.status,
      reasonCode: p.reasonCode ?? undefined, reason: p.reasonCode === null ? undefined : rejectionReason(p.reasonCode),
      balanceAtRequest: dec(p.balanceAtRequest), profit: dec(p.profit), traderAmount: dec(p.traderAmount), vaultAmount: dec(p.vaultAmount),
      networkFeeSol: p.networkFeeSol === null ? null : formatFixed(parseFixed(p.networkFeeSol, 9), 9, 9), destination: p.destination,
      requestedAt: p.requestedAt.getTime(), resolvedAt: p.resolvedAt?.getTime() ?? null,
      requestSignature: p.requestSignature, paySignature: p.paySignature ?? undefined,
    };
  }

  const walletPayouts = (wallet: string, id?: string) => db.select({ payout: payouts, label: accounts.label }).from(payouts)
    .innerJoin(accounts, eq(accounts.id, payouts.fundedAccount))
    .where(and(eq(accounts.wallet, wallet), id ? eq(payouts.address, id) : undefined)).orderBy(desc(payouts.requestedAt));

  return {
    async isFunded(id) {
      const [row] = await db.select({ a: fundedAccounts.address }).from(fundedAccounts).where(eq(fundedAccounts.address, id));
      return row !== undefined;
    },
    summaryOf,
    positionsOf,
    async list(wallet) {
      const rows = await db.select().from(accounts).innerJoin(fundedAccounts, eq(fundedAccounts.address, accounts.id))
        .where(and(eq(accounts.wallet, wallet), eq(accounts.stage, 'funded'))).orderBy(desc(accounts.createdAt));
      return Promise.all(rows.map(async (r) => summaryOf(r.accounts, r.funded_accounts, r.funded_accounts.status === 'closed' ? null : await valuation(r.accounts.id))));
    },
    async detail(wallet, id) {
      const row = await owned(wallet, id);
      if (!row) return undefined;
      const v = row.funded_accounts.status === 'closed' ? null : await valuation(id);
      return { ...(await summaryOf(row.accounts, row.funded_accounts, v)), positions: v ? await positionsOf(v, id) : [], orders: await ordersOf(id) };
    },
    async positions(wallet, id) {
      const row = await owned(wallet, id);
      if (!row) return undefined;
      const v = row.funded_accounts.status === 'closed' ? null : await valuation(id);
      return v ? positionsOf(v, id) : [];
    },
    async orders(wallet, id) {
      return (await owned(wallet, id)) ? ordersOf(id) : undefined;
    },
    async history(wallet, id, limit) {
      return (await owned(wallet, id)) ? history(id, undefined, limit) : undefined;
    },
    async activity(wallet, id): Promise<ActivityItem[] | undefined> {
      if (!(await owned(wallet, id))) return undefined;
      const rows = await db.select().from(accountEvents).where(eq(accountEvents.accountId, id)).orderBy(desc(accountEvents.ts)).limit(500);
      return rows.map((e) => ({
        id: e.id, type: e.type, title: e.title, detail: e.detail, ts: e.ts.getTime(), status: e.status,
        amountUsd: e.amountUsd === null ? undefined : dec(e.amountUsd), symbol: e.symbol ?? undefined, signature: e.signature ?? undefined,
        simulated: e.simulated,
      }));
    },
    async performance(wallet, id, period) {
      const row = await owned(wallet, id);
      return row ? performance(row.accounts, row.funded_accounts, period) : undefined;
    },
    async eligibility(wallet, id) {
      const row = await owned(wallet, id);
      if (!row) return undefined;
      const funded = row.funded_accounts;
      const [v, { config }] = await Promise.all([venue.valuation(id, 0), d.program.state()]);
      if (!v) return undefined;
      const principal = toMicro6(funded.principal);
      const open = v.positions.length;
      const profit = v.ownerUsdc + v.pendingCollateral + v.positions.reduce((s, p) => s + p.position.collateralAmount, 0n) - principal;
      const positive = profit > 0n ? profit : 0n;
      const traderShare = (positive * BigInt(funded.traderShareBps)) / BigInt(BPS);
      const minPayout = BigInt(config.minPayout.toString());
      const reasons: string[] = [];
      const status = STATUS[v.status];
      if (config.paused.payouts) reasons.push('Payouts are paused right now');
      if (status === 'payout_pending') reasons.push('A payout request is already under review');
      else if (status !== 'active') reasons.push(`Payouts need an active account; this one is ${status?.replace('_', ' ')}`);
      if (open || v.pendingOrders) reasons.push('Close every position and cancel pending orders first');
      else if (!v.flat) reasons.push('Waiting for the next account sync to confirm the account is flat');
      else if (v.fees.due > 0n) reasons.push('Order fees are being settled; payouts open once they are');
      if (positive === 0n) reasons.push('There is no realized profit to pay out');
      else if (traderShare < minPayout) reasons.push(`Your share must be at least ${micro(minPayout)} USDC`);
      return {
        account: id, eligible: reasons.length === 0, reasons, realizedProfit: fmt6(profit), traderShare: fmt6(traderShare),
        vaultShare: fmt6(positive - traderShare), minPayout: micro(minPayout), flat: v.flat && !open && !v.pendingOrders,
        openPositions: open, pendingOrders: v.pendingOrders,
      };
    },
    async payouts(wallet) {
      return (await walletPayouts(wallet)).map((r) => payoutOf(r.payout, r.label));
    },
    async payout(wallet, id) {
      const [r] = await walletPayouts(wallet, id);
      return r && payoutOf(r.payout, r.label);
    },
  };
}

export type FundedProvider = ReturnType<typeof createFundedProvider>;
