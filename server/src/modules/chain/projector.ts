// Projects props_vault events into the chain tables (evaluations, funded_accounts + their accounts rows, gm_orders,
// payouts, vault_ledger, account_events). Runs inside the indexer's per-transaction database transaction, exactly
// once per (signature, event index), so every write here is applied once and in chain order.
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Notification } from '@props/shared';
import { CLOSE_ALL } from '@props/sdk';
import { formatFixed } from '@props/gmtrade';
import type { Db } from '../../db/client.ts';
import type { SimService } from '../types.ts';
import {
  accountEvents, accounts, equitySnapshots, evaluations, fundedAccounts, gmOrders, gmPositionSnapshots, payouts, vaultLedger,
} from '../../db/schema.ts';
import type { VaultEvent } from './events.ts';
import { gmUsd, micro, orderPrice, sizeName, toMicro6, type ChainReader } from './reader.ts';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface TxInfo { signature: string; slot: number; /** lamports */ fee: bigint }
export interface ProjectDeps {
  reader: ChainReader;
  /** Absent when the sim module is not deployed: evaluations are then indexed but not tradable. */
  sim?: Pick<SimService, 'createEvaluation'>;
  log?: Pick<FastifyBaseLogger, 'error'>;
}
export type Notice = { wallet: string } & Pick<Notification, 'title' | 'body' | 'href' | 'kind'>;

/** Vault ledger entries: USDC moving into (in) or out of (out) the Props vault accounts, or between them (internal). */
export const LEDGER = {
  deposit: { event: 'Capital deposited', direction: 'in' },
  withdrawal: { event: 'Capital withdrawn', direction: 'out' },
  evaluationFee: { event: 'Evaluation fee', direction: 'in' },
  feesSwept: { event: 'Fees moved to capital', direction: 'internal' },
  principalAllocated: { event: 'Principal allocated', direction: 'out' },
  principalReturned: { event: 'Principal returned', direction: 'in' },
  profitShare: { event: 'Profit share received', direction: 'in' },
} as const;

/** Plain-English reasons for `reject_payout` reason codes (the admin API and the keeper use only these codes). */
export const PAYOUT_REJECTION_REASONS: Record<number, string> = {
  1: 'Open positions or orders were found at review',
  2: 'Requested profit does not match the account\'s GMTrade trade history',
  3: 'Opposite or correlated positions were found across accounts',
  4: 'Identity review is not complete',
  5: 'Trading broke the account terms',
};
export const rejectionReason = (code: number) => PAYOUT_REJECTION_REASONS[code] ?? `Rejected by risk review (code ${code})`;

const at = (ts: string) => new Date(Number(ts) * 1000);
const side = (isLong: boolean) => (isLong ? 'Long' : 'Short') as 'Long' | 'Short';
/** App route of one funded account (a trader can have a closed funded account next to a new one). */
export const fundedHref = (funded: string) => `/account/funded?id=${funded}`;

/**
 * Applies one event. Onchain reads go through the (cached) reader; the sim's createEvaluation is idempotent, so a
 * rollback after it ran only means it runs again on the retry.
 */
export async function project(tx: Tx, ev: VaultEvent, eventIndex: number, info: TxInfo, deps: ProjectDeps): Promise<Notice[]> {
  const { signature, slot } = info;
  const ledger = (entry: (typeof LEDGER)[keyof typeof LEDGER], amount: string, ts: string, account?: string) =>
    tx.insert(vaultLedger).values({ signature, eventIndex, slot, ...entry, account, amountUsd: micro(amount), ts: at(ts) });
  const activity = (accountId: string, v: Omit<typeof accountEvents.$inferInsert, 'accountId' | 'status' | 'simulated' | 'signature'>) =>
    tx.insert(accountEvents).values({ accountId, status: 'confirmed', simulated: false, signature, ...v });
  const setFundedStatus = async (funded: string, status: typeof fundedAccounts.$inferSelect.status, extra: Partial<typeof fundedAccounts.$inferInsert> = {}) => {
    await tx.update(fundedAccounts).set({ status, updatedSlot: slot, ...extra }).where(eq(fundedAccounts.address, funded));
    await tx.update(accounts).set({ status, updatedAt: sql`now()` }).where(eq(accounts.id, funded));
  };
  const traderOf = async (funded: string) => {
    const [row] = await tx.select({ trader: fundedAccounts.trader }).from(fundedAccounts).where(eq(fundedAccounts.address, funded));
    if (!row) throw new Error(`event for unknown funded account ${funded}`);
    return row.trader;
  };

  switch (ev.name) {
    case 'evaluationPurchased': {
      const e = ev.data;
      const { index, terms } = await deps.reader.evaluation(e.evaluation);
      await tx.insert(evaluations).values({
        address: e.evaluation, trader: e.trader, evalIndex: index, tierId: e.tierId, sizeUsd: terms.sizeUsd,
        profitTargetBps: terms.profitTargetBps, maxDrawdownBps: terms.maxDrawdownBps, maxExposureBps: terms.maxExposureBps,
        traderShareBps: terms.traderShareBps, termsHash: terms.termsHash, feePaid: micro(e.feePaid), status: 'active',
        purchaseSignature: signature, createdAt: at(e.ts), updatedSlot: slot,
      }).onConflictDoNothing();
      await ledger(LEDGER.evaluationFee, e.feePaid, e.ts, e.evaluation);
      await deps.sim?.createEvaluation({ evaluation: e.evaluation, wallet: e.trader, terms, purchasedAt: Number(e.ts) * 1000, signature });
      return [];
    }
    case 'evaluationResolved': {
      const e = ev.data;
      await tx.update(evaluations).set({
        status: e.passed ? 'passed' : 'failed', finalEquity: micro(e.finalEquity), tradesRoot: e.tradesRoot,
        resultSignature: signature, resolvedAt: at(e.ts), updatedSlot: slot,
      }).where(eq(evaluations.address, e.evaluation));
      return [];
    }
    case 'fundedActivated': {
      const e = ev.data;
      const { terms, tierVersion } = await deps.reader.evaluation(e.evaluation);
      const principal = micro(e.principal);
      const label = `Funded ${sizeName(terms.sizeUsd)}`;
      await tx.insert(fundedAccounts).values({
        address: e.funded, evaluation: e.evaluation, trader: e.trader, ownerPda: e.owner, principal,
        traderShareBps: terms.traderShareBps, status: 'active', activationSignature: signature, createdAt: at(e.ts), updatedSlot: slot,
      });
      await tx.update(evaluations).set({ status: 'funded', updatedSlot: slot }).where(eq(evaluations.address, e.evaluation));
      await tx.insert(accounts).values({
        id: e.funded, wallet: e.trader, stage: 'funded', status: 'active', label, tierId: terms.tierId, evaluation: e.evaluation,
        funded: e.funded, sizeUsd: terms.sizeUsd, lossAllowanceUsd: principal, profitTargetUsd: null,
        maxExposureBps: terms.maxExposureBps, traderShareBps: terms.traderShareBps, termsHash: terms.termsHash,
        termsVersion: tierVersion, createdAt: at(e.ts), activatedAt: at(e.ts),
      });
      await tx.insert(equitySnapshots).values({ accountId: e.funded, ts: at(e.ts), equity: terms.sizeUsd, realizedPnl: '0', unrealizedPnl: '0' });
      await activity(e.funded, {
        type: 'account', title: 'Funded account activated', amountUsd: principal, ts: at(e.ts),
        detail: `${principal} USDC loss allowance moved from the Props.trade capital vault to this account.`,
      });
      await ledger(LEDGER.principalAllocated, e.principal, e.ts, e.funded);
      return [{ wallet: e.trader, kind: 'account', title: `${label} is active`, body: `Your funded account is ready to trade with a ${principal} USDC loss allowance.`, href: fundedHref(e.funded) }];
    }
    case 'orderRequested': {
      const e = ev.data;
      const m = await deps.reader.market(e.marketToken);
      const isIncrease = e.orderType !== 'close';
      const closeAll = !isIncrease && BigInt(e.sizeDeltaUsd) === CLOSE_ALL;
      let sizeUsd = gmUsd(e.sizeDeltaUsd);
      if (closeAll) {
        const [last] = await tx.select({ size: gmPositionSnapshots.sizeUsd }).from(gmPositionSnapshots)
          .where(and(eq(gmPositionSnapshots.fundedAccount, e.funded), eq(gmPositionSnapshots.marketToken, e.marketToken), eq(gmPositionSnapshots.side, side(e.isLong))))
          .orderBy(desc(gmPositionSnapshots.slot)).limit(1);
        sizeUsd = last?.size ?? '0';
      }
      const trader = await traderOf(e.funded);
      const byRisk = e.by !== trader;
      await tx.insert(gmOrders).values({
        address: e.order, fundedAccount: e.funded, marketToken: e.marketToken, symbol: m.symbol, side: side(e.isLong),
        kind: e.orderType === 'limit' ? 'Limit' : 'Market', isIncrease, sizeUsd,
        collateralUsd: isIncrease ? micro(e.collateral) : null,
        triggerPrice: e.orderType === 'limit' ? orderPrice(e.triggerPrice, m.decimals) : null,
        acceptablePrice: orderPrice(e.acceptablePrice, m.decimals),
        status: e.orderType === 'limit' ? 'awaiting_price' : 'awaiting_execution',
        statusDetail: closeAll ? 'Closes the whole position' : byRisk ? 'Placed by the risk service' : null,
        createSignature: signature, createdAt: at(e.ts),
      }).onConflictDoNothing();
      const what = isIncrease ? `${e.orderType} order` : 'close order';
      await activity(e.funded, {
        type: byRisk ? 'risk' : 'order', symbol: m.symbol, ts: at(e.ts), amountUsd: closeAll ? null : sizeUsd,
        title: byRisk ? `Risk service placed a close order on ${side(e.isLong)} ${m.symbol}` : `${side(e.isLong)} ${m.symbol} ${what} placed`,
        detail: isIncrease ? `Size ${sizeUsd} USD with ${micro(e.collateral)} USDC collateral, sent to GMTrade.` : closeAll ? 'Closes the whole position on GMTrade.' : `Reduces the position by ${sizeUsd} USD on GMTrade.`,
      });
      return [];
    }
    case 'protectionSet': {
      const e = ev.data;
      const m = await deps.reader.market(e.marketToken);
      const kind = e.orderType === 'takeProfit' ? 'TakeProfit' : 'StopLoss';
      const trigger = orderPrice(e.triggerPrice, m.decimals);
      await tx.insert(gmOrders).values({
        address: e.order, fundedAccount: e.funded, marketToken: e.marketToken, symbol: m.symbol, side: side(e.isLong), kind,
        isIncrease: false, sizeUsd: gmUsd(e.sizeDeltaUsd), collateralUsd: null, triggerPrice: trigger, acceptablePrice: null,
        status: 'awaiting_price', createSignature: signature, createdAt: at(e.ts),
      }).onConflictDoNothing();
      await activity(e.funded, {
        type: 'protection', symbol: m.symbol, ts: at(e.ts),
        title: `${kind === 'TakeProfit' ? 'Take-profit' : 'Stop-loss'} set on ${side(e.isLong)} ${m.symbol}`,
        detail: `Triggers at ${trigger ?? 'no set price'} for ${gmUsd(e.sizeDeltaUsd)} USD of the position.`,
      });
      return [];
    }
    case 'orderUpdated': {
      const e = ev.data;
      const [order] = await tx.select().from(gmOrders).where(eq(gmOrders.address, e.order));
      if (!order) throw new Error(`update of unknown order ${e.order}`);
      const { decimals } = await deps.reader.market(order.marketToken);
      await tx.update(gmOrders).set({
        ...(e.sizeDeltaUsd !== null && { sizeUsd: gmUsd(e.sizeDeltaUsd) }),
        ...(e.triggerPrice !== null && { triggerPrice: orderPrice(e.triggerPrice, decimals) }),
        ...(e.acceptablePrice !== null && { acceptablePrice: orderPrice(e.acceptablePrice, decimals) }),
        updatedAt: at(e.ts),
      }).where(eq(gmOrders.address, e.order));
      await activity(e.funded, {
        type: 'order', symbol: order.symbol, ts: at(e.ts), title: `${order.side} ${order.symbol} order updated`, detail: 'New order terms sent to GMTrade.',
      });
      return [];
    }
    case 'orderCancelled': {
      const e = ev.data;
      const byRisk = e.by !== (await traderOf(e.funded));
      const [order] = await tx.update(gmOrders).set({
        status: 'canceled', statusDetail: byRisk ? 'Cancelled by the risk service' : 'Cancelled', closeSignature: signature,
        closedAt: at(e.ts), updatedAt: at(e.ts),
      }).where(eq(gmOrders.address, e.order)).returning();
      await activity(e.funded, {
        type: byRisk ? 'risk' : 'cancel', symbol: order?.symbol, ts: at(e.ts),
        title: `${order ? `${order.side} ${order.symbol} ` : ''}order cancelled${byRisk ? ' by the risk service' : ''}`,
        detail: 'The order was withdrawn from GMTrade; its collateral and deposit returned to the account.',
      });
      return [];
    }
    case 'completedOrderClosed':
    case 'synced': {
      const e = ev.data;
      const finished = ev.name === 'synced' ? ev.data.ordersDropped : [ev.data.order];
      if (finished.length) {
        // GMTrade finished these orders (filled or cancelled by its keeper); the venue sync reads which.
        await tx.update(gmOrders).set({ closedAt: at(e.ts), updatedAt: at(e.ts) })
          .where(and(inArray(gmOrders.address, finished), isNull(gmOrders.closedAt)));
      }
      if (ev.name === 'synced') await tx.update(fundedAccounts).set({ lastSyncAt: at(e.ts), updatedSlot: slot }).where(eq(fundedAccounts.address, e.funded));
      return [];
    }
    case 'payoutRequested': {
      const e = ev.data;
      const trader = await traderOf(e.funded);
      await tx.insert(payouts).values({
        address: e.request, fundedAccount: e.funded, seq: e.seq, status: 'requested', balanceAtRequest: micro(e.balance),
        profit: micro(e.profit), traderAmount: micro(e.traderAmount), vaultAmount: micro(e.vaultAmount), destination: trader,
        requestSignature: signature, requestedAt: at(e.ts),
      }).onConflictDoNothing();
      await setFundedStatus(e.funded, 'payout_pending', { payoutSeq: e.seq + 1 });
      await activity(e.funded, {
        type: 'payout', title: 'Payout requested', amountUsd: micro(e.traderAmount), ts: at(e.ts),
        detail: `${micro(e.profit)} USDC realized profit: ${micro(e.traderAmount)} USDC to you, ${micro(e.vaultAmount)} USDC to the capital vault, after review.`,
      });
      return [{ wallet: trader, kind: 'payout', title: 'Payout requested', body: `${micro(e.traderAmount)} USDC is under review.`, href: '/payouts' }];
    }
    case 'payoutCancelled': {
      const e = ev.data;
      await tx.update(payouts).set({ status: 'cancelled', resolvedAt: at(e.ts) }).where(eq(payouts.address, e.request));
      await setFundedStatus(e.funded, 'active');
      await activity(e.funded, { type: 'payout', title: 'Payout request cancelled', detail: 'You cancelled the request; trading is open again.', ts: at(e.ts) });
      return [];
    }
    case 'payoutPaid': {
      const e = ev.data;
      await tx.update(payouts).set({
        status: 'paid', paySignature: signature, resolvedAt: at(e.ts), networkFeeSol: formatFixed(info.fee, 9, 9),
      }).where(eq(payouts.address, e.request));
      await setFundedStatus(e.funded, 'active');
      await tx.update(fundedAccounts).set({ payoutsPaid: sql`${fundedAccounts.payoutsPaid} + ${micro(e.traderAmount)}` })
        .where(eq(fundedAccounts.address, e.funded));
      await activity(e.funded, {
        type: 'payout', title: 'Payout paid', amountUsd: micro(e.traderAmount), ts: at(e.ts),
        detail: `${micro(e.traderAmount)} USDC sent to your wallet and ${micro(e.vaultAmount)} USDC to the capital vault. The loss allowance is back to its starting level.`,
      });
      await ledger(LEDGER.profitShare, e.vaultAmount, e.ts, e.funded);
      return [{ wallet: e.trader, kind: 'payout', title: 'Payout paid', body: `${micro(e.traderAmount)} USDC was sent to your wallet.`, href: '/payouts' }];
    }
    case 'payoutRejected': {
      const e = ev.data;
      const reason = rejectionReason(e.reasonCode);
      await tx.update(payouts).set({ status: 'rejected', reasonCode: e.reasonCode, resolvedAt: at(e.ts) }).where(eq(payouts.address, e.request));
      await setFundedStatus(e.funded, 'active');
      await activity(e.funded, { type: 'payout', title: 'Payout rejected', detail: `${reason}. Trading is open again.`, ts: at(e.ts) });
      return [{ wallet: await traderOf(e.funded), kind: 'payout', title: 'Payout rejected', body: reason, href: '/payouts' }];
    }
    case 'accountRestricted': {
      const e = ev.data;
      await setFundedStatus(e.funded, e.restricted ? 'restricted' : 'active');
      await activity(e.funded, {
        type: 'risk', ts: at(e.ts), title: e.restricted ? 'Account restricted' : 'Restriction lifted',
        detail: e.restricted ? 'The risk service limited this account to closing and protecting positions.' : 'The account can open positions again.',
      });
      return e.restricted ? [{ wallet: await traderOf(e.funded), kind: 'risk', title: 'Account restricted', body: 'New positions are blocked; you can still close and protect positions.', href: fundedHref(e.funded) }] : [];
    }
    case 'accountBreached': {
      const e = ev.data;
      await setFundedStatus(e.funded, 'breached');
      await activity(e.funded, { type: 'risk', ts: at(e.ts), title: 'Loss limit reached', detail: 'Equity reached the account floor; the account is closing.' });
      return [{ wallet: await traderOf(e.funded), kind: 'risk', title: 'Loss limit reached', body: 'Your funded account reached its equity floor and is being closed.', href: fundedHref(e.funded) }];
    }
    case 'accountClosed': {
      const e = ev.data;
      await setFundedStatus(e.funded, 'closed', { closedAt: at(e.ts) });
      const [account] = await tx.update(accounts).set({ resolvedAt: at(e.ts) }).where(eq(accounts.id, e.funded)).returning();
      // Final equity: the account ends flat, holding exactly the USDC it returns.
      const realized = BigInt(e.usdcReturned) - BigInt(e.principal);
      const final = { equity: micro(toMicro6(account!.sizeUsd) + realized), realizedPnl: micro(realized), unrealizedPnl: '0' };
      await tx.insert(equitySnapshots).values({ accountId: e.funded, ts: at(e.ts), ...final })
        .onConflictDoUpdate({ target: [equitySnapshots.accountId, equitySnapshots.ts], set: final });
      await activity(e.funded, {
        type: 'account', title: 'Account closed', amountUsd: micro(e.usdcReturned), ts: at(e.ts),
        detail: `${micro(e.usdcReturned)} USDC returned to the capital vault.`,
      });
      await ledger(LEDGER.principalReturned, e.usdcReturned, e.ts, e.funded);
      return [];
    }
    case 'capitalDeposited':
      await ledger(LEDGER.deposit, ev.data.amount, ev.data.ts);
      return [];
    case 'capitalWithdrawn':
      await ledger(LEDGER.withdrawal, ev.data.amount, ev.data.ts);
      return [];
    case 'feesSwept':
      await ledger(LEDGER.feesSwept, ev.data.amount, ev.data.ts);
      return [];
    case 'identitySet':
      return [{ wallet: ev.data.wallet, kind: 'account', title: 'Identity verified', body: 'Your identity review is complete.', href: '/activate' }];
    case 'configChanged':
    case 'ownerToppedUp':
    case 'solTreasuryWithdrawn':
    case 'emptyPositionClosed':
    case 'claimableCollected':
      return []; // kept in program_events; no projection
    default:
      // An event this server does not know (a newer program): kept in program_events like the rest, never a stall.
      deps.log?.error({ event: (ev as { name: string }).name, signature }, 'unknown props_vault event: stored, not projected');
      return [];
  }
}
