import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Keypair, type AccountInfo, type PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import type { FastifyServerOptions } from 'fastify';
import type { NonceResponse } from '@props/shared';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/routes.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import type { Services } from '../src/modules/types.js';
import type { BalanceRpc } from '../src/routes/account.js';
import { createStreamHub } from '../src/stream.js';
import { testDatabaseUrl } from './db.js';

export const APP_ORIGIN = 'https://app.props.test';

export function testConfig() {
  return loadConfig({
    DATABASE_URL: testDatabaseUrl(),
    APP_ORIGIN,
    SESSION_SECRET: randomBytes(32).toString('hex'),
    ADMIN_API_TOKEN: randomBytes(32).toString('hex'),
    RPC_URL: 'http://127.0.0.1:8899',
    PROGRAM_ID: Keypair.generate().publicKey.toBase58(),
    TRUST_PROXY_HOPS: '0',
  });
}

/** Stand-in for the RPC connection: answers getMultipleAccountsInfo from a fixture map. */
export function fixtureRpc(accounts: Map<string, AccountInfo<Buffer>> = new Map()): BalanceRpc & { calls: number } {
  const rpc = {
    calls: 0,
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      rpc.calls++;
      return keys.map((k) => accounts.get(k.toBase58()) ?? null);
    },
  };
  return rpc as BalanceRpc & { calls: number };
}

export async function makeApp(opts: { rpc?: BalanceRpc; logger?: FastifyServerOptions['logger']; services?: Services } = {}) {
  const config = testConfig();
  const { sql, db } = createDb(config.DATABASE_URL);
  const hub = createStreamHub();
  const app = await buildApp({
    config, db, sql, hub, modules: new Map([['marketdata', 'absent']]), services: opts.services, rpc: opts.rpc ?? fixtureRpc(), logger: opts.logger ?? false,
  });
  return {
    app, db, sql, hub, config,
    async close() {
      await app.close();
      await sql.end();
    },
  };
}

export function signMessage(message: string, keypair: Keypair): string {
  return bs58.encode(ed25519.sign(new TextEncoder().encode(message), keypair.secretKey.slice(0, 32)));
}

type App = Awaited<ReturnType<typeof makeApp>>['app'];

export async function requestNonce(app: App, wallet: string): Promise<NonceResponse> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/nonce', payload: { wallet } });
  if (res.statusCode !== 200) throw new Error(`nonce failed: ${res.body}`);
  return res.json();
}

/** Full Sign-In With Solana round trip; returns the Cookie header value for later requests. */
export async function signIn(app: App, keypair = Keypair.generate()): Promise<{ cookie: string; wallet: string; keypair: Keypair }> {
  const wallet = keypair.publicKey.toBase58();
  const { message } = await requestNonce(app, wallet);
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/verify', payload: { wallet, message, signature: signMessage(message, keypair) },
  });
  if (res.statusCode !== 200) throw new Error(`verify failed: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error('no session cookie');
  return { cookie: `${SESSION_COOKIE}=${cookie.value}`, wallet, keypair };
}
