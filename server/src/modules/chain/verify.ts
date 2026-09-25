// /v1/verify: turns an evaluation, funded account or payout address, a transaction signature or a wallet into the
// onchain records behind it, each with what it proves and what it does not.
import { PublicKey, type Connection } from '@solana/web3.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import bs58 from 'bs58';
import type { AppConfig, EvidenceItem, VerifyResult } from '@props/shared';
import type { Db } from '../../db/client.ts';
import { evaluations, fundedAccounts, gmPositionSnapshots, payouts, programEvents, venueFills } from '../../db/schema.ts';
import { invokes } from './events.ts';
import { rejectionReason } from './projector.ts';
import { dec, decPrice, micro, sizeName, toMicro6 } from './reader.ts';

type Evaluation = typeof evaluations.$inferSelect;
type Funded = typeof fundedAccounts.$inferSelect;
type PayoutRow = typeof payouts.$inferSelect;

const pct = (bps: number) => `${bps / 100}%`;
const day = (d: Date) => d.toISOString().slice(0, 10);

const EVENT_TITLES: Record<string, string> = {
  evaluationPurchased: 'Evaluation purchased', evaluationResolved: 'Evaluation result recorded', fundedActivated: 'Funded account activated',
  orderRequested: 'Exchange order placed', protectionSet: 'Take-profit or stop-loss placed', orderUpdated: 'Exchange order updated',
  orderCancelled: 'Exchange order cancelled', completedOrderClosed: 'Finished exchange order closed', synced: 'Account synced with the exchange',
  ownerToppedUp: 'Network fee float topped up', payoutRequested: 'Payout requested', payoutCancelled: 'Payout request cancelled',
  payoutPaid: 'Payout paid', payoutRejected: 'Payout rejected', accountRestricted: 'Account restriction changed', accountBreached: 'Loss limit reached',
  accountClosed: 'Funded account closed', capitalDeposited: 'Capital deposited', capitalWithdrawn: 'Capital withdrawn', feesSwept: 'Fees moved to capital',
  configChanged: 'Program settings changed', identitySet: 'Identity verified', solTreasuryWithdrawn: 'SOL treasury withdrawal',
  emptyPositionClosed: 'Empty exchange position closed', claimableCollected: 'Exchange claimable USDC collected',
};

export function createVerify(d: { db: Db; rpc: Pick<Connection, 'getAccountInfo' | 'getTransaction'>; programId: PublicKey; cluster: AppConfig['cluster'] }) {
  const { db } = d;
  const explorer = (kind: 'tx' | 'account', id: string) => (d.cluster === 'mainnet-beta' ? `https://solscan.io/${kind}/${id}` : undefined);
  const tx = (signature: string, slot?: number, ts?: Date | null) => ({ signature, slot, ts: ts?.getTime(), explorerUrl: explorer('tx', signature) });
  const account = (address: string) => ({ address, explorerUrl: explorer('account', address) });

  /** Latest indexed event `name` whose data field `field` equals `value`. */
  async function eventOf(name: string, field: string, value: string) {
    const [row] = await db.select().from(programEvents)
      .where(and(eq(programEvents.name, name), sql`${programEvents.data}->>${field} = ${value}`)).orderBy(desc(programEvents.slot)).limit(1);
    return row;
  }

  function evaluationItems(e: Evaluation): EvidenceItem[] {
    const items: EvidenceItem[] = [
      {
        title: 'Evaluation purchased', state: 'confirmed', ...tx(e.purchaseSignature, undefined, e.createdAt),
        description: `${dec(e.feePaid)} USDC paid for a ${sizeName(dec(e.sizeUsd))} evaluation on ${day(e.createdAt)}.`,
        establishes: `The trader's wallet paid the fee into the Props.trade fee vault and, in the same transaction, the program fixed the rules: `
          + `account size ${dec(e.sizeUsd)} USD, profit target ${pct(e.profitTargetBps)}, loss allowance ${pct(e.maxDrawdownBps)}, `
          + `maximum exposure ${pct(e.maxExposureBps)}, profit share ${pct(e.traderShareBps)}, terms hash ${e.termsHash}. It shows no trading.`,
      },
      {
        title: 'Evaluation account', state: 'confirmed', ...account(e.address),
        description: 'The program account that holds the evaluation\'s rules and, once decided, its result.',
        establishes: 'Only a Props.trade risk authority can record the result, and only once; the rules cannot change after purchase.',
      },
    ];
    if (e.resultSignature && e.resolvedAt) {
      items.push({
        title: `Evaluation ${e.status === 'failed' ? 'failed' : 'passed'}`, state: 'confirmed', ...tx(e.resultSignature, undefined, e.resolvedAt),
        description: `Result recorded with final equity ${dec(e.finalEquity ?? '0')} USD and trades root ${e.tradesRoot}.`,
        establishes: 'A Props.trade risk authority recorded the result onchain. The evaluation\'s trades were simulated off-chain against live '
          + 'market prices and are not onchain. The trades root is a SHA-256 Merkle root over the evaluation\'s canonical fill list, which '
          + 'anyone can download here and recompute it from. A match shows the fill list was not changed after the result was recorded; it '
          + 'does not show that the simulated fills were fair.',
        ...(e.tradesRoot ? { tradesRoot: { root: e.tradesRoot, evaluation: e.address } } : {}),
      });
    } else {
      items.push({
        title: 'Simulated trading in progress', state: 'simulated',
        description: 'Evaluation trades are simulated by Props.trade against live market prices.',
        establishes: 'Nothing onchain yet: simulated trades are off-chain. When the evaluation ends, its result and a commitment to its fill list are recorded here.',
      });
    }
    return items;
  }

  async function fundedItems(f: Funded): Promise<EvidenceItem[]> {
    const items: EvidenceItem[] = [
      {
        title: 'Funded account activated', state: 'confirmed', ...tx(f.activationSignature, undefined, f.createdAt),
        description: `${dec(f.principal)} USDC allocated on ${day(f.createdAt)}.`,
        establishes: `${dec(f.principal)} USDC moved from the Props.trade capital vault to an address only the program controls. It is the account's `
          + 'loss allowance and the most the vault can lose on this account: exchange positions carry no debt.',
      },
      {
        title: 'Funded account', state: 'confirmed', ...account(f.address),
        description: 'The program account with the rules, open position slots and tracked exchange orders.',
        establishes: 'The program checks every trade against these rules (leverage, exposure, market allowlist) before it reaches the exchange.',
      },
      {
        title: 'Trading address', state: 'confirmed', ...account(f.ownerPda),
        description: 'Owns the account\'s USDC and every exchange position and order.',
        establishes: 'A program address with no private key: only the Props.trade program can sign for it, and it sends USDC only to exchange orders, '
          + 'approved payouts to the trader\'s registered wallet, or back to the capital vault.',
      },
    ];
    const positions = await db.selectDistinctOn([gmPositionSnapshots.position]).from(gmPositionSnapshots)
      .where(eq(gmPositionSnapshots.fundedAccount, f.address)).orderBy(gmPositionSnapshots.position, desc(gmPositionSnapshots.slot));
    for (const p of positions.filter((x) => toMicro6(x.sizeUsd) > 0n)) {
      items.push({
        title: `Exchange position: ${p.side}`, state: 'confirmed', ...account(p.position), slot: p.slot, ts: p.ts.getTime(),
        description: `${dec(p.sizeUsd)} USD with ${dec(p.collateralUsd)} USDC collateral, as last read.`,
        establishes: 'A real position on the exchange held by the account\'s trading address; its size and collateral are the exchange\'s own account data.',
      });
    }
    const fills = await db.select().from(venueFills).where(eq(venueFills.fundedAccount, f.address)).orderBy(desc(venueFills.venueId)).limit(20);
    for (const x of fills) {
      items.push({
        title: `${x.side} ${x.symbol} ${x.isIncrease ? 'increase' : 'decrease'} filled`, state: 'confirmed', ...tx(x.signature, x.slot, x.ts),
        description: `${dec(x.sizeUsd)} USD at ${decPrice(x.price)}, fees ${dec(x.feeUsd)} USD.`,
        establishes: 'The exchange\'s keeper executed this order onchain; size, price and fees are the exchange\'s own records of the fill.',
      });
    }
    for (const p of await db.select().from(payouts).where(eq(payouts.fundedAccount, f.address)).orderBy(desc(payouts.requestedAt))) {
      items.push(...(await payoutItems(p, f)).slice(0, 2));
    }
    if (f.closedAt) {
      const closed = await eventOf('accountClosed', 'funded', f.address);
      if (closed) {
        items.push({
          title: 'Funded account closed', state: 'confirmed', ...tx(closed.signature, closed.slot, closed.blockTime),
          description: `${micro((closed.data as { usdcReturned: string }).usdcReturned)} USDC returned to the capital vault.`,
          establishes: 'The account was flat; all its USDC went back to the capital vault and its principal was released.',
        });
      }
    }
    return items;
  }

  async function payoutItems(p: PayoutRow, f: Funded): Promise<EvidenceItem[]> {
    const items: EvidenceItem[] = [{
      title: 'Payout requested', state: 'confirmed', ...tx(p.requestSignature, undefined, p.requestedAt),
      description: `${dec(p.traderAmount)} USDC to the trader, ${dec(p.vaultAmount)} USDC to the vault.`,
      establishes: `The trader requested a payout while the account was flat: ${dec(p.profit)} USDC realized profit above the ${dec(f.principal)} USDC `
        + `principal, split ${pct(f.traderShareBps)} to the trader. The request alone moves no money.`,
    }];
    if (p.status === 'paid' && p.paySignature) {
      items.push({
        title: 'Payout paid', state: 'confirmed', ...tx(p.paySignature, undefined, p.resolvedAt),
        description: `${dec(p.traderAmount)} USDC to ${p.destination}.`,
        establishes: `${dec(p.traderAmount)} USDC went to the trader's registered wallet and ${dec(p.vaultAmount)} USDC to the capital vault, in one `
          + 'transaction in which the program checked again that the account was flat and its balance unchanged.',
      });
    } else if (p.status === 'rejected') {
      const rejected = await eventOf('payoutRejected', 'request', p.address);
      items.push({
        title: 'Payout rejected', state: rejected ? 'confirmed' : 'indexing', ...(rejected ? tx(rejected.signature, rejected.slot, rejected.blockTime) : {}),
        description: rejectionReason(p.reasonCode ?? 0),
        establishes: 'A Props.trade risk authority rejected the request; no USDC moved and the account returned to trading.',
      });
    } else if (p.status === 'requested' || p.status === 'reviewing') {
      items.push({
        title: 'Awaiting review', state: 'pending', description: 'The request is waiting for the risk review.',
        establishes: 'Nothing has been paid yet.',
      });
    }
    items.push({
      title: 'Payout request account', state: 'confirmed', ...account(p.address),
      description: `Request #${p.seq} of funded account ${f.address}.`,
      establishes: 'Holds the requested amounts and the request\'s status.',
    });
    return items;
  }

  async function bySignature(signature: string): Promise<VerifyResult> {
    const events = await db.select().from(programEvents).where(eq(programEvents.signature, signature)).orderBy(programEvents.eventIndex);
    const fills = await db.select().from(venueFills).where(eq(venueFills.signature, signature));
    const items: EvidenceItem[] = [
      ...events.map((e): EvidenceItem => ({
        title: EVENT_TITLES[e.name] ?? e.name, state: 'confirmed', ...tx(signature, e.slot, e.blockTime),
        description: JSON.stringify(e.data),
        establishes: 'The Props.trade program emitted this record in this transaction; the values are exactly what the program logged.',
      })),
      ...fills.map((x): EvidenceItem => ({
        title: `${x.side} ${x.symbol} ${x.isIncrease ? 'increase' : 'decrease'} filled on the exchange`, state: 'confirmed', ...tx(signature, x.slot, x.ts),
        description: `${dec(x.sizeUsd)} USD at ${decPrice(x.price)} for funded account ${x.fundedAccount}.`,
        establishes: 'The exchange\'s keeper executed a funded account\'s order in this transaction.',
      })),
    ];
    if (items.length) return { query: signature, kind: 'transaction', title: 'Transaction', items };
    const found = await d.rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!found) return { query: signature, kind: 'not_found', title: 'No transaction with this signature', items: [] };
    if (!invokes(found, d.programId)) return { query: signature, kind: 'unsupported', title: 'Not a Props.trade transaction', items: [] };
    const where = tx(signature, found.slot, found.blockTime ? new Date(found.blockTime * 1000) : null);
    const item: EvidenceItem = found.meta?.err
      ? {
        title: 'Failed Props.trade transaction', state: 'confirmed', ...where,
        description: `Included in a block but failed (${JSON.stringify(found.meta.err)}), so it changed nothing; only its network fee was charged.`,
        establishes: 'The transaction called the Props.trade program and was rejected: no account, balance or record changed.',
      }
      : {
        title: 'Props.trade transaction', state: 'indexing', ...where,
        description: 'Confirmed on Solana; the indexer has not processed it yet.', establishes: 'The transaction exists and called the Props.trade program.',
      };
    return { query: signature, kind: 'transaction', title: 'Transaction', items: [item] };
  }

  async function byAddress(address: string): Promise<VerifyResult> {
    const [evaluation] = await db.select().from(evaluations).where(eq(evaluations.address, address));
    if (evaluation) {
      const [funded] = await db.select().from(fundedAccounts).where(eq(fundedAccounts.evaluation, address));
      const items = evaluationItems(evaluation);
      if (funded) items.push({ title: 'Activated as a funded account', state: 'confirmed', ...account(funded.address), description: 'See this address for the funded account.', establishes: 'The evaluation passed and was turned into this funded account.' });
      return { query: address, kind: 'evaluation', title: `Evaluation ${sizeName(dec(evaluation.sizeUsd))}`, items };
    }
    const [funded] = await db.select().from(fundedAccounts).where(eq(fundedAccounts.address, address));
    if (funded) {
      const [e] = await db.select().from(evaluations).where(eq(evaluations.address, funded.evaluation));
      return { query: address, kind: 'funded', title: 'Funded account', items: [...(await fundedItems(funded)), ...(e ? evaluationItems(e).filter((i) => i.signature) : [])] };
    }
    const [payout] = await db.select().from(payouts).innerJoin(fundedAccounts, eq(fundedAccounts.address, payouts.fundedAccount)).where(eq(payouts.address, address));
    if (payout) return { query: address, kind: 'payout', title: `Payout #${payout.payouts.seq}`, items: await payoutItems(payout.payouts, payout.funded_accounts) };

    const owned = await db.select().from(evaluations).where(eq(evaluations.trader, address)).orderBy(desc(evaluations.createdAt));
    if (owned.length) {
      const items: EvidenceItem[] = [];
      for (const e of owned) items.push({ ...evaluationItems(e)[0]!, title: `Evaluation ${sizeName(dec(e.sizeUsd))}`, ...account(e.address), signature: e.purchaseSignature });
      for (const f of await db.select().from(fundedAccounts).where(eq(fundedAccounts.trader, address))) items.push(...(await fundedItems(f)).slice(0, 2));
      return { query: address, kind: 'wallet', title: 'Wallet', items };
    }
    const info = await d.rpc.getAccountInfo(new PublicKey(address));
    if (info?.owner.equals(d.programId)) {
      return {
        query: address, kind: 'unsupported', title: 'Props.trade account',
        items: [{ title: 'Program account', state: 'indexing', ...account(address), description: 'Owned by the Props.trade program.', establishes: 'Not an evaluation, funded account or payout the indexer has recorded.' }],
      };
    }
    return { query: address, kind: 'not_found', title: 'No Props.trade record for this address', items: [] };
  }

  return async function verify(query: string): Promise<VerifyResult> {
    const q = query.trim();
    let bytes: Uint8Array | undefined;
    try {
      bytes = bs58.decode(q);
    } catch {
      bytes = undefined;
    }
    if (bytes?.length === 64) return bySignature(q);
    if (bytes?.length === 32) return byAddress(q);
    return { query: q, kind: 'unsupported', title: 'Search by an account address, a payout address, a transaction signature or a wallet', items: [] };
  };
}

