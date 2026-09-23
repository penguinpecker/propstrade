// Shared test helpers for the chain module (node:test): a fresh migrated database per test file, props_vault events
// encoded exactly as the program emits them, and a stand-in sim service.
import { Connection, Keypair, PublicKey, TransactionMessage } from '@solana/web3.js';
import bs58 from 'bs58';
import { PROPS_VAULT_IDL, PROPS_VAULT_PROGRAM_ID, PropsVaultClient } from '@props/sdk';
import type { AccountDetail, AccountSummary, Performance } from '@props/shared';
import { createDb } from '../../../db/client.ts';
import { runMigrations } from '../../../db/migrate.ts';
import { recreateDatabase, testDatabaseUrl } from '../../../../test/db.ts';
import type { EvaluationResult, SimService } from '../../types.ts';

/** A dedicated database for one test file: TEST_DATABASE_URL's name + `_<suffix>`, dropped, recreated and migrated. */
export async function freshDb(suffix: string) {
  const url = new URL(testDatabaseUrl());
  url.pathname = `${url.pathname}_${suffix}`;
  await recreateDatabase(url.toString());
  await runMigrations(url.toString());
  return { url: url.toString(), ...createDb(url.toString()) };
}

/** Builders never touch the network; the connection only satisfies Anchor's provider type. */
export const offlineClient = () => new PropsVaultClient(new Connection('http://127.0.0.1:1'));

/**
 * A props_vault account's data as the program stores it. Anchor's own encode() writes into a fixed 1,000-byte buffer,
 * too small for FundedAccount, so this uses the same layout with room to spare.
 */
export function encodeAccount(client: PropsVaultClient, name: string, data: Record<string, unknown>): Buffer {
  const coder = client.program.coder.accounts as unknown as {
    accountLayouts: Map<string, { discriminator: number[]; layout: { encode(src: unknown, b: Buffer): number } }>;
  };
  const entry = coder.accountLayouts.get(name);
  if (!entry) throw new Error(`no account ${name}`);
  const body = Buffer.alloc(10_000);
  const length = entry.layout.encode(data, body);
  return Buffer.concat([Buffer.from(entry.discriminator), body.subarray(0, length)]);
}

/** Data of the self-CPI props_vault's emit_cpi! makes for an event: Anchor's event tag, discriminator, borsh body. */
export function eventCpiData(client: PropsVaultClient, name: string, data: Record<string, unknown>): Buffer {
  const idlName = name[0]!.toUpperCase() + name.slice(1);
  const event = PROPS_VAULT_IDL.events.find((e) => e.name === idlName);
  if (!event) throw new Error(`no event ${idlName}`);
  const body = client.program.coder.types.encode(name as never, data);
  return Buffer.concat([Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]), Buffer.from(event.discriminator), body]);
}

/** The transaction and meta of one props_vault instruction emitting these events, as getTransaction returns them. */
export function programTx(client: PropsVaultClient, events: [name: string, data: Record<string, unknown>][]) {
  const message = new TransactionMessage({
    payerKey: Keypair.generate().publicKey, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [{ programId: PROPS_VAULT_PROGRAM_ID, keys: [], data: Buffer.alloc(8) }],
  }).compileToV0Message();
  const programIdIndex = message.staticAccountKeys.findIndex((k) => k.equals(PROPS_VAULT_PROGRAM_ID));
  const instructions = events.map(([n, d]) => ({ programIdIndex, accounts: [], data: bs58.encode(eventCpiData(client, n, d)), stackHeight: 2 }));
  return {
    transaction: { message, signatures: [] as string[] },
    meta: { innerInstructions: events.length ? [{ index: 0, instructions }] : [], loadedAddresses: { writable: [] as PublicKey[], readonly: [] as PublicKey[] } },
  };
}

/** Records what the chain module asks of the sim engine; accounts are whatever the test puts in `accounts`. */
export function simStub(accounts: AccountDetail[] = []) {
  const listeners = new Set<(r: EvaluationResult) => void>();
  const created: Parameters<SimService['createEvaluation']>[0][] = [];
  const recorded: [evaluation: string, signature: string][] = [];
  const mine = (wallet: string, id: string) => accounts.find((a) => a.id === id && a.id.includes(wallet));
  const sim: SimService = {
    async createEvaluation(input) {
      created.push(input);
    },
    onResolved(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async markRecorded(evaluation, signature) {
      recorded.push([evaluation, signature]);
    },
    async list(wallet) {
      return accounts.filter((a) => a.id.includes(wallet)).map(({ positions: _p, orders: _o, ...summary }) => summary as AccountSummary);
    },
    async detail(wallet, id) {
      return mine(wallet, id);
    },
    async positions(wallet, id) {
      return mine(wallet, id)?.positions;
    },
    async orders(wallet, id) {
      return mine(wallet, id)?.orders;
    },
    async history(wallet, id) {
      return mine(wallet, id) ? [] : undefined;
    },
    async activity(wallet, id) {
      return mine(wallet, id) ? [] : undefined;
    },
    async performance(wallet, id, period): Promise<Performance | undefined> {
      return mine(wallet, id) && {
        period, series: [], netPnl: '0', grossRealized: '0', feesUsd: '0', fundingBorrowUsd: '0', unrealizedPnl: '0', trades: 0,
        winRatePct: null, profitFactor: null, averageTradeUsd: null, byMarket: [],
      };
    },
  };
  return { sim, created, recorded, resolve: (r: EvaluationResult) => listeners.forEach((l) => l(r)) };
}

export const silentLog = { info() {}, warn() {}, error() {} };

export async function until<T>(check: () => Promise<T | undefined | false | null>, ms = 20_000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
