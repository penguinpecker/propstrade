import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import Fastify from 'fastify';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../src/app.js';
import { SIWS_STATEMENT, buildSiwsMessage, nonceOf, verifySiwsSignature } from '../src/auth/siws.js';
import { loadConfig } from '../src/config.js';
import { migrationsFolder, runMigrations } from '../src/db/migrate.js';
import { registerModules, type ModuleStatus } from '../src/modules/index.js';
import type { ModuleContext, Services } from '../src/modules/types.js';
import { formatUnits, loadKeypair } from '../src/lib/solana.js';
import { recreateDatabase, testDatabaseUrl } from './db.js';
import { signMessage } from './helpers.js';

describe('config', () => {
  it('fails fast naming every missing or invalid variable, without echoing values', () => {
    const secret = 'short-secret-value';
    expect(() => loadConfig({ SESSION_SECRET: secret, APP_ORIGIN: 'https://props.trade/app' })).toThrowError(
      /DATABASE_URL[\s\S]*APP_ORIGIN[\s\S]*SESSION_SECRET[\s\S]*ADMIN_API_TOKEN[\s\S]*RPC_URL/,
    );
    try {
      loadConfig({ SESSION_SECRET: secret });
    } catch (err) {
      expect(String(err)).not.toContain(secret);
    }
  });

  it('treats empty assignments as unset so defaults apply', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://u@localhost/db', APP_ORIGIN: 'https://props.trade', SESSION_SECRET: 's'.repeat(32),
      ADMIN_API_TOKEN: 'a'.repeat(32), RPC_URL: 'https://rpc.example', SOLANA_CLUSTER: '', PORT: '', PROGRAM_ID: '',
    });
    expect(config).toMatchObject({ SOLANA_CLUSTER: 'mainnet-beta', PORT: 8080 });
    expect(config.PROGRAM_ID).toBeUndefined();
  });
});

describe('keypair loading', () => {
  it('accepts base58 and JSON byte-array secret keys, and never echoes a bad value', () => {
    const kp = Keypair.generate();
    const env = { B58: bs58.encode(kp.secretKey), JSON: JSON.stringify([...kp.secretKey]), BAD: 'notakey0OIl', SHORT: '[1,2,3]' };
    expect(loadKeypair(env, 'B58')!.publicKey.equals(kp.publicKey)).toBe(true);
    expect(loadKeypair(env, 'JSON')!.publicKey.equals(kp.publicKey)).toBe(true);
    expect(loadKeypair(env, 'UNSET')).toBeUndefined();
    expect(() => loadKeypair(env, 'BAD')).toThrowError(/^BAD is not a base58 string or JSON byte array$/);
    expect(() => loadKeypair(env, 'SHORT')).toThrowError(/^SHORT must hold a 64-byte secret key$/);
    const mismatched = Uint8Array.from([...kp.secretKey.slice(0, 32), ...Keypair.generate().publicKey.toBytes()]);
    expect(() => loadKeypair({ K: bs58.encode(mismatched) }, 'K')).toThrowError(/does not match/);
  });
});

describe('formatUnits', () => {
  it('renders base units as exact decimal strings', () => {
    expect(formatUnits(0n, 6)).toBe('0');
    expect(formatUnits(1n, 6)).toBe('0.000001');
    expect(formatUnits(12_345_678n, 6)).toBe('12.345678');
    expect(formatUnits(1_500_000_000n, 9)).toBe('1.5');
    expect(formatUnits(18_446_744_073_709_551_615n, 6)).toBe('18446744073709.551615');
  });
});

describe('SIWS message', () => {
  it('matches the Wallet Standard sign-in text layout exactly', () => {
    const message = buildSiwsMessage({
      domain: 'props.trade', address: '7d3kQ1mYzXjYp5nZ1Pz3cG6b3nqS6q2eE9uH5vAaF8v', statement: SIWS_STATEMENT,
      uri: 'https://props.trade', chainId: 'mainnet', nonce: 'a1b2c3d4e5f60718',
      issuedAt: new Date('2026-09-23T10:00:00Z'), expirationTime: new Date('2026-09-23T10:05:00Z'),
    });
    expect(message).toBe([
      'props.trade wants you to sign in with your Solana account:',
      '7d3kQ1mYzXjYp5nZ1Pz3cG6b3nqS6q2eE9uH5vAaF8v',
      '',
      SIWS_STATEMENT,
      '',
      'URI: https://props.trade',
      'Version: 1',
      'Chain ID: mainnet',
      'Nonce: a1b2c3d4e5f60718',
      'Issued At: 2026-09-23T10:00:00.000Z',
      'Expiration Time: 2026-09-23T10:05:00.000Z',
    ].join('\n'));
    expect(nonceOf(message)).toBe('a1b2c3d4e5f60718');
  });

  it('verifies ed25519 signatures strictly', () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const sig = signMessage('hello', kp);
    expect(verifySiwsSignature('hello', sig, wallet)).toBe(true);
    expect(verifySiwsSignature('hello!', sig, wallet)).toBe(false);
    expect(verifySiwsSignature('hello', sig, Keypair.generate().publicKey.toBase58())).toBe(false);
    expect(verifySiwsSignature('hello', 'x', wallet)).toBe(false);
  });
});

describe('logger', () => {
  it('redacts credentials whatever object carries them', async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _enc, done) { lines.push(chunk.toString()); done(); } });
    const app = Fastify({ logger: { ...loggerOptions('info'), stream } });
    app.log.info({ headers: { authorization: 'Bearer admin-secret', cookie: 'props_session=cookie-secret' } }, 'x');
    app.log.info({ wallet: { secretKey: 'key-secret' }, token: 'token-secret' }, 'y');
    await app.close();
    const out = lines.join('');
    for (const secret of ['admin-secret', 'cookie-secret', 'key-secret', 'token-secret']) expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });
});

describe('module registry', () => {
  const context = () => {
    const warnings: string[] = [];
    const app = Fastify();
    const services: Services = {};
    const ctx: ModuleContext = {
      app, env: {}, services, signal: new AbortController().signal, publish: () => {},
      config: {} as never, db: {} as never, sql: {} as never, rpc: {} as never, notify: async () => {}, // unused by registry fixtures
      log: { ...app.log, warn: (o: { module: string }) => warnings.push(o.module), info: () => {} } as never,
    };
    return { app, ctx, services, warnings };
  };

  it('registers present modules in order and reports the rest as absent', async () => {
    const { app, ctx, services, warnings } = context();
    const status: ModuleStatus = new Map();
    await registerModules(ctx, status, new URL('./fixtures/modules/', import.meta.url));
    expect(Object.fromEntries(status)).toEqual({ marketdata: 'running', sim: 'absent', chain: 'absent', keeper: 'absent' });
    expect(services.marketdata).toMatchObject({ name: 'fixture-marketdata' });
    expect(warnings).toEqual(['sim', 'chain', 'keeper']);
    expect((await app.inject({ method: 'GET', url: '/v1/fixture-module' })).json()).toEqual({ ok: true });
  });

  it('stops startup when a present module fails to register', async () => {
    const { ctx } = context();
    await expect(registerModules(ctx, new Map(), new URL('./fixtures/broken-modules/', import.meta.url)))
      .rejects.toThrow('upstream unreachable');
  });
});

describe('migrations', () => {
  it('build the whole schema on a fresh database and are idempotent', async () => {
    const url = new URL(testDatabaseUrl());
    url.pathname = `${url.pathname}_migrations`;
    await recreateDatabase(url.toString());
    await runMigrations(url.toString());
    await runMigrations(url.toString());
    const sql = postgres(url.toString(), { max: 1 });
    try {
      const tables = await sql<{ table_name: string }[]>`
        select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
      expect(tables.map((t) => t.table_name)).toEqual([
        'account_events', 'accounts', 'admin_audit_log', 'auth_nonces', 'chain_jobs', 'closed_trades', 'equity_snapshots',
        'evaluations', 'funded_accounts', 'gm_orders', 'gm_position_snapshots', 'gmtrade_deploys', 'indexer_cursors', 'kyc_requests', 'notifications', 'payouts',
        'program_events', 'sessions', 'sim_fills', 'sim_orders', 'sim_positions', 'users', 'vault_ledger', 'venue_fills',
      ]);
      const committed = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8')).entries.length;
      const [applied] = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(applied!.n).toBe(committed); // each applied once, however often migrate runs
      // Chain rows are idempotent per (signature, event index).
      const event = { signature: 'sig', event_index: 0, slot: 1, name: 'EvaluationPurchased', data: sql.json({}) };
      await sql`insert into program_events ${sql(event)}`;
      await expect(sql`insert into program_events ${sql(event)}`).rejects.toThrow(/duplicate key/);
    } finally {
      await sql.end();
    }
  });
});
