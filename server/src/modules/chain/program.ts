// Program-wide state: /v1/config from the onchain Config and Tier accounts (cached ~30 s, dropped early when a settings
// change is indexed), and /v1/vault from the vault balances and Config totals read together, plus the indexed ledger.
import type { Connection, PublicKey } from '@solana/web3.js';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AppConfig, Tier, VaultStats } from '@props/shared';
import { capitalVaultAddress, configPda, feeVaultPda, solTreasuryPda, type ConfigAccount, type PropsVaultClient, type TierAccount } from '@props/sdk';
import { formatFixed } from '@props/gmtrade';
import type { Db } from '../../db/client.ts';
import { fundedAccounts, payouts, vaultLedger } from '../../db/schema.ts';
import { tokenAccountAmount } from '../../lib/solana.ts';
import type { VaultEvent } from './events.ts';
import { LEDGER } from './projector.ts';
import { dec, hex, micro, sizeName, toMicro6 } from './reader.ts';

const CACHE_MS = 30_000;
const LEDGER_ROWS = 50;
/** Series points returned (most recent); the ledger walk itself always starts at the first entry. */
const SERIES_POINTS = 500;

export interface ProgramState { config: ConfigAccount; tiers: TierAccount[] }

export class ProgramNotInitialized extends Error {
  constructor() {
    super('props_vault is not initialized');
  }
}

/** A value loaded at most every CACHE_MS (a failed load is not kept), which `clear` drops early. */
function cached<T>(load: () => Promise<T>) {
  let entry: { at: number; value: Promise<T> } | undefined;
  return {
    get(): Promise<T> {
      if (!entry || Date.now() - entry.at > CACHE_MS) {
        const next = { at: Date.now(), value: load() };
        next.value.catch(() => entry === next && (entry = undefined));
        entry = next;
      }
      return entry.value;
    },
    clear: () => void (entry = undefined),
  };
}

/** Total capital (capital vault + principal out in funded accounts) after each ledger entry, oldest first. */
export async function capitalSeries(db: Db): Promise<VaultStats['series']> {
  const rows = await db.select({ event: vaultLedger.event, amount: vaultLedger.amountUsd, ts: vaultLedger.ts, principal: fundedAccounts.principal })
    .from(vaultLedger).leftJoin(fundedAccounts, eq(fundedAccounts.address, vaultLedger.account))
    .orderBy(asc(vaultLedger.slot), asc(vaultLedger.signature), asc(vaultLedger.eventIndex));
  let vault = 0n;
  let allocated = 0n;
  const series: VaultStats['series'] = [];
  for (const r of rows) {
    const a = toMicro6(r.amount);
    switch (r.event) {
      case LEDGER.deposit.event: case LEDGER.feesSwept.event: case LEDGER.profitShare.event: vault += a; break;
      case LEDGER.withdrawal.event: vault -= a; break;
      case LEDGER.principalAllocated.event: vault -= a; allocated += a; break;
      case LEDGER.principalReturned.event: vault += a; allocated -= toMicro6(r.principal ?? '0'); break;
      default: continue; // evaluation fees land in the fee vault, not capital
    }
    series.push({ ts: r.ts.getTime(), capitalUsdc: formatFixed(vault + allocated, 6, 6) });
  }
  return series.slice(-SERIES_POINTS);
}

export function createProgramReader(d: {
  db: Db; rpc: Pick<Connection, 'getMultipleAccountsInfo'>; client: PropsVaultClient; programId: PublicKey; cluster: AppConfig['cluster'];
}) {
  const config = cached(async () => {
    const c = await d.client.fetchConfig();
    if (!c) throw new ProgramNotInitialized();
    return c;
  });
  // Every Tier account at once is a getProgramAccounts query: only when the cache is cold or a tier changed.
  const tiers = cached(async () => (await d.client.program.account.tier.all()).map((t) => t.account).sort((a, b) => a.id - b.id));

  async function state(): Promise<ProgramState> {
    const [c, t] = await Promise.all([config.get(), tiers.get()]);
    return { config: c, tiers: t };
  }

  async function appConfig(): Promise<AppConfig> {
    const { config: c, tiers } = await state();
    const tier = (t: TierAccount): Tier => {
      const sizeUsd = micro(t.sizeUsd.toString());
      return {
        id: t.id, name: sizeName(sizeUsd), sizeUsd, feeUsdc: micro(t.feeUsdc.toString()),
        profitTargetBps: t.profitTargetBps, maxDrawdownBps: t.maxDrawdownBps, maxExposureBps: t.maxExposureBps,
        traderShareBps: c.traderShareBps, enabled: t.enabled, termsHash: hex(t.termsHash), version: t.version,
      };
    };
    return {
      cluster: d.cluster, programId: d.programId.toBase58(), usdcMint: c.usdcMint.toBase58(), gmtradeStore: c.gmtradeStore.toBase58(),
      tiers: tiers.map(tier), traderShareBps: c.traderShareBps, minPayoutUsdc: micro(c.minPayout.toString()),
      paused: { newEvaluations: c.paused.newEvaluations, trading: c.paused.trading, payouts: c.paused.payouts },
      feeVault: feeVaultPda().toBase58(), capitalVault: c.capitalVault.toBase58(),
    };
  }

  async function vault(): Promise<VaultStats> {
    // One read, one slot: an activation moves principal out of the capital vault and into Config.allocated_principal
    // in the same instruction, so the balance and the totals must come from the same moment.
    const [configInfo, capital, fee, treasury] = await d.rpc.getMultipleAccountsInfo([configPda(), capitalVaultAddress(), feeVaultPda(), solTreasuryPda()]);
    if (!configInfo) throw new ProgramNotInitialized();
    const c = d.client.decode('config', configInfo.data);
    const balance = (info: typeof capital) => (info ? tokenAccountAmount(info.data) : 0n);
    const capitalUsdc = balance(capital);
    const allocated = BigInt(c.allocatedPrincipal.toString());
    const [pending] = await d.db.select({ sum: sql<string | null>`sum(${payouts.traderAmount})` }).from(payouts)
      .where(inArray(payouts.status, ['requested', 'reviewing']));
    const ledger = await d.db.select().from(vaultLedger).orderBy(desc(vaultLedger.slot), desc(vaultLedger.eventIndex)).limit(LEDGER_ROWS);
    return {
      programId: d.programId.toBase58(), capitalVault: capitalVaultAddress().toBase58(), feeVault: feeVaultPda().toBase58(),
      solTreasury: solTreasuryPda().toBase58(),
      capitalUsdc: micro(capitalUsdc + allocated), allocatedPrincipal: micro(allocated), unallocated: micro(capitalUsdc),
      feeVaultUsdc: micro(balance(fee)), pendingPayouts: dec(pending?.sum ?? '0'),
      fundedAccounts: c.fundedActive, solTreasurySol: formatFixed(BigInt(treasury?.lamports ?? 0), 9, 9),
      totals: { feesCollected: micro(c.feesCollected.toString()), payoutsPaid: micro(c.payoutsPaid.toString()), profitToVault: micro(c.profitToVault.toString()) },
      series: await capitalSeries(d.db),
      ledger: ledger.map((l) => ({
        id: `${l.signature}:${l.eventIndex}`, event: l.event, account: l.account ?? undefined, amountUsd: dec(l.amountUsd),
        direction: l.direction, ts: l.ts.getTime(), signature: l.signature,
      })),
      freshness: 'live', updatedAt: Date.now(),
    };
  }

  /** Drops what indexed events changed: the Config on any settings change, the tiers when a tier was written. */
  function changed(events: VaultEvent[]) {
    for (const e of events) {
      if (e.name !== 'configChanged') continue;
      config.clear();
      if (e.data.change === 'tier') tiers.clear();
    }
  }

  return { state, appConfig, vault, changed };
}

export type ProgramReader = ReturnType<typeof createProgramReader>;
