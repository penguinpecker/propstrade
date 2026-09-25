// Read side for practice and evaluation accounts (AccountsProvider): every figure comes from the engine's records
// and live marks. undefined = not found or not the wallet's.
import { and, asc, desc, eq, gte } from 'drizzle-orm';
import type { ActivityItem, ClosedTrade, Fill, Performance } from '@props/shared';
import type { Db } from '../../db/client.ts';
import { accountEvents, accounts, closedTrades, equitySnapshots, simFills } from '../../db/schema.ts';
import type { AccountsProvider, MarketDataService } from '../types.ts';
import { loadAccount, orderList, practiceId, snapshot, toFill, visibleTo, type AccountRow } from './book.ts';
import { canonicalOrder } from '@props/shared/merkle';
import { micro, microText, trim, usd, usdText } from './model.ts';

const PERIOD_MS: Record<Performance['period'], number | null> = { '1W': 7 * 86_400_000, '1M': 30 * 86_400_000, All: null };

export function createReader(db: Db, md: MarketDataService, ensurePractice: (wallet: string) => Promise<void>) {
  async function find(wallet: string, id: string): Promise<AccountRow | undefined> {
    const account = await loadAccount(db, id, wallet);
    if (account || id !== practiceId(wallet)) return account;
    await ensurePractice(wallet);
    return loadAccount(db, id, wallet);
  }
  const live = async (wallet: string, id: string) => {
    const account = await find(wallet, id);
    return account && { account, ...(await snapshot(db, md, account)) };
  };

  async function performance(account: AccountRow, period: Performance['period']): Promise<Performance> {
    const span = PERIOD_MS[period];
    const since = new Date(span === null ? 0 : Date.now() - span);
    const [{ valuation }, points, trades, fills] = await Promise.all([
      snapshot(db, md, account),
      db.select().from(equitySnapshots).where(and(eq(equitySnapshots.accountId, account.id), gte(equitySnapshots.ts, since))).orderBy(asc(equitySnapshots.ts)),
      db.select().from(closedTrades).where(and(eq(closedTrades.accountId, account.id), gte(closedTrades.closedAt, since))),
      db.select().from(simFills).where(and(eq(simFills.accountId, account.id), gte(simFills.ts, since))),
    ]);
    const size = micro(account.sizeUsd);
    const series = points.map((p) => ({ ts: p.ts.getTime(), equity: trim(p.equity), netPnl: microText(micro(p.equity) - size) }));
    series.push({ ts: Date.now(), equity: microText(valuation.equity), netPnl: microText(valuation.equity - size) });

    const nets = trades.map((t) => micro(t.netPnl));
    const wins = nets.filter((n) => n > 0n);
    const won = wins.reduce((a, n) => a + n, 0n);
    const lost = nets.filter((n) => n < 0n).reduce((a, n) => a - n, 0n);
    const total = nets.reduce((a, n) => a + n, 0n);
    const fees = fills.reduce((a, f) => a + usd(f.feeUsd), 0n);
    const fundingBorrow = fills.reduce((a, f) => a + micro(f.fundingUsd) + micro(f.borrowUsd), 0n);
    const bySymbol = new Map<string, bigint>();
    for (const t of trades) bySymbol.set(t.symbol, (bySymbol.get(t.symbol) ?? 0n) + micro(t.netPnl));
    const magnitude = [...bySymbol.values()].reduce((a, n) => a + (n < 0n ? -n : n), 0n);
    return {
      period, series,
      netPnl: microText(valuation.equity - size),
      grossRealized: microText(total + trades.reduce((a, t) => a + micro(t.feesUsd), 0n)),
      feesUsd: usdText(fees), fundingBorrowUsd: microText(fundingBorrow), unrealizedPnl: microText(valuation.unrealized),
      trades: trades.length,
      winRatePct: trades.length ? Math.round((wins.length / trades.length) * 10_000) / 100 : null,
      profitFactor: lost > 0n ? Math.round((Number(won) / Number(lost)) * 100) / 100 : null,
      averageTradeUsd: trades.length ? microText(total / BigInt(trades.length)) : null,
      byMarket: [...bySymbol].map(([symbol, net]) => ({
        symbol, netPnl: microText(net), sharePct: magnitude ? Math.round((Number(net < 0n ? -net : net) / Number(magnitude)) * 10_000) / 100 : 0,
      })).sort((a, b) => b.sharePct - a.sharePct),
    };
  }

  const reader: AccountsProvider & { fills(wallet: string | null, id: string): Promise<Fill[] | undefined> } = {
    async list(wallet) {
      await find(wallet, practiceId(wallet)); // opens the practice account on first use
      const rows = await db.select({ id: accounts.id }).from(accounts).where(visibleTo(wallet)).orderBy(asc(accounts.createdAt));
      const out = await Promise.all(rows.map((r) => live(wallet, r.id)));
      return out.flatMap((x) => (x ? [x.valuation.summary] : []));
    },
    async detail(wallet, id) {
      const x = await live(wallet, id);
      return x && { ...x.valuation.summary, positions: x.valuation.positions, orders: await orderList(db, id) };
    },
    async positions(wallet, id) {
      return (await live(wallet, id))?.valuation.positions;
    },
    async orders(wallet, id) {
      return (await find(wallet, id)) && orderList(db, id);
    },
    async history(wallet, id, limit): Promise<ClosedTrade[] | undefined> {
      if (!(await find(wallet, id))) return undefined;
      const query = db.select().from(closedTrades).where(eq(closedTrades.accountId, id)).orderBy(desc(closedTrades.closedAt)).$dynamic();
      const rows = await (limit ? query.limit(limit) : query);
      return rows.map((t) => ({
        id: t.id, symbol: t.symbol, side: t.side, openedAt: t.openedAt.getTime(), closedAt: t.closedAt.getTime(), sizeUsd: trim(t.sizeUsd),
        entryPrice: trim(t.entryPrice), exitPrice: trim(t.exitPrice), feesUsd: trim(t.feesUsd), orderFeesUsd: trim(t.orderFeesUsd),
        fundingUsd: trim(t.fundingUsd), borrowUsd: trim(t.borrowUsd), priceImpactUsd: trim(t.priceImpactUsd), netPnl: trim(t.netPnl),
        venue: t.venue, signatures: t.signatures,
      }));
    },
    async activity(wallet, id): Promise<ActivityItem[] | undefined> {
      if (!(await find(wallet, id))) return undefined;
      const rows = await db.select().from(accountEvents).where(eq(accountEvents.accountId, id)).orderBy(desc(accountEvents.ts)).limit(200);
      return rows.map((e) => ({
        id: e.id, type: e.type, title: e.title, detail: e.detail, ts: e.ts.getTime(), status: e.status, simulated: e.simulated,
        ...(e.amountUsd === null ? {} : { amountUsd: trim(e.amountUsd) }), ...(e.symbol === null ? {} : { symbol: e.symbol }),
        ...(e.signature === null ? {} : { signature: e.signature }),
      }));
    },
    async performance(wallet, id, period) {
      const account = await find(wallet, id);
      return account && performance(account, period);
    },
    /**
     * Every fill of the account in the canonical trades-root order (@props/shared/merkle): for its wallet, and for anyone
     * once the evaluation's result, and with it the trades root, is recorded onchain (markRecorded).
     */
    async fills(wallet, id) {
      const own = wallet ? await find(wallet, id) : undefined;
      const account = own ?? (await loadAccount(db, id));
      if (!account || (account !== own && !(account.stage === 'evaluation' && account.resultSignature))) return undefined;
      return (await db.select().from(simFills).where(eq(simFills.accountId, id))).map(toFill).sort(canonicalOrder);
    },
  };
  return reader;
}
