// The whole of Props.trade on one machine, for rehearsals and the full-stack browser test (app/tests/fullstack.e2e.mjs):
//
//   1. solana-test-validator: the mainnet GMTrade binary at its address, the committed mainnet account snapshots
//      (Store patched for the local restart slot) plus the markets' virtual inventories and index-token mints cloned
//      from mainnet, props_vault deployed with a throwaway upgrade authority, and USDC token accounts pre-seeded for
//      the operator and the trader (USDC cannot be minted locally).
//   2. The operator scripts in scripts/admin, in the mainnet runbook's order (docs/runbooks/program-deploy.md §4):
//      initialize, set-authorities (throwaway risk and KYC keys), upsert-tiers (+ a small test tier), upsert-markets,
//      deposit-capital, SOL treasury funding, set-pauses off.
//   3. The real server (marketdata, sim, chain, keeper) on a freshly created database, against the validator, with
//      live GMTrade market data, and NODE_ENV=test for its price-pin test hook (server/README.md).
//   4. A production build of the app, served at APP_URL, pointed at that server and validator.
//
//   export PATH=$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH
//   LOCAL_STACK_DATABASE_URL=postgres://postgres:…@127.0.0.1:5432/props_local_test node scripts/local-stack.ts [--trader <pubkey>]
//
// Ports: validator RPC 38899 (websocket 38900), faucet 38901, gossip 38902, 38910-38950, API 38951, app 38952; set
// LOCAL_STACK_PORT to move them all (it names the RPC port; the others keep their offsets).
// The database named in LOCAL_STACK_DATABASE_URL is dropped and recreated (its name must contain _test). Mainnet is
// only read: GMTrade's APIs and the cloned accounts. Keys are generated per run in a temporary directory that is
// removed on exit; nothing secret is printed. Ctrl-C or SIGTERM stops everything.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { PROPS_VAULT_PROGRAM_ID, solTreasuryPda, toMicro } from '@props/sdk';
import { decodeMarket } from '@props/gmtrade';
import { build, preview } from 'vite';
import { startValidator, type Validator } from '../tests/program/src/validator.ts';
import { recreateDatabase } from '../server/test/db.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Every port follows LOCAL_STACK_PORT (the validator's RPC port; its websocket is the next one). */
const BASE_PORT = Number(process.env.LOCAL_STACK_PORT || 38899);
const PORTS = {
  rpc: BASE_PORT, faucet: BASE_PORT + 2, gossip: BASE_PORT + 3, dynamic: `${BASE_PORT + 11}-${BASE_PORT + 51}`, api: BASE_PORT + 52, app: BASE_PORT + 53,
};
/** Evaluation tier for rehearsals: $1,000 account, 1 USDC fee, 0.1% target, 5% ($50) loss allowance. */
export const TEST_TIER = { id: 9, sizeUsd: '1000', feeUsdc: '1', profitTargetBps: 10 } as const;
/** The markets funded (and evaluation) trading is enabled on; all of them have committed account snapshots. */
export const ALLOWLIST = ['SOL', 'BTC', 'ETH', 'XAU'] as const;
const OPERATOR_USDC = '2000';
const CAPITAL_USDC = '1000';
const TRADER_USDC = '100';
const TREASURY_SOL = '5';

export interface LocalStack {
  rpcUrl: string;
  wsUrl: string;
  apiUrl: string;
  appUrl: string;
  databaseUrl: string;
  /** Bearer token of the server's /v1/admin routes (throwaway, this run only). */
  adminToken: string;
  operator: PublicKey;
  risk: PublicKey;
  kyc: PublicKey;
  trader: PublicKey;
  /** Server log file (the server's stdout and stderr). */
  serverLog: string;
  stop(): Promise<void>;
}

export interface StackOptions {
  /** Disposable database, dropped and recreated (its name must contain _test). */
  databaseUrl: string;
  /** Trader wallet to pre-seed with USDC and SOL (default: a new throwaway key, written to the state directory). */
  trader?: PublicKey;
  /** Admin API token for the server (default: random). */
  adminToken?: string;
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mainnet accounts the committed markets need beyond their snapshots: virtual inventories and index-token mints. */
function marketDependencies(): PublicKey[] {
  const dir = new URL('../tests/program/fixtures/accounts/', import.meta.url);
  const out = new Set<string>();
  for (const file of readdirSync(dir)) {
    const { account } = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    let market;
    try {
      market = decodeMarket(account.data[0]);
    } catch {
      continue; // not a Market account
    }
    for (const address of [market.meta.index_token_mint, market.virtual_inventory_for_swaps, market.virtual_inventory_for_positions]) {
      if (address !== PublicKey.default.toBase58()) out.add(address);
    }
  }
  return [...out].map((a) => new PublicKey(a));
}

function writeKey(dir: string, name: string, key: Keypair): string {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify([...key.secretKey]), { mode: 0o600 });
  return path;
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(1_000)) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function startLocalStack(o: StackOptions): Promise<LocalStack> {
  const log = o.log ?? ((line: string) => console.log(line));
  const state = mkdtempSync(join(tmpdir(), 'props-local-stack-'));
  const cleanups: (() => Promise<void> | void)[] = [() => rmSync(state, { recursive: true, force: true })];
  const stop = async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  };
  // Ctrl-C, kill, a process manager or a CI timeout: the validator and the server are stopped and the key directory
  // removed before the process exits (both the script below and app/tests/fullstack.e2e.mjs run through here).
  const onSignal = (signal: NodeJS.Signals) => void stop().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, onSignal);
  cleanups.push(() => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.off(signal, onSignal);
  });
  try {
    // A server already answering on these ports would be taken for ours.
    for (const port of [PORTS.api, PORTS.app]) {
      if (await fetch(`http://127.0.0.1:${port}`).then(() => true, () => false)) throw new Error(`port ${port} is in use; set LOCAL_STACK_PORT`);
    }
    await recreateDatabase(o.databaseUrl); // refuses names without _test
    const operator = Keypair.generate();
    const risk = Keypair.generate();
    const kyc = Keypair.generate();
    let trader = o.trader;
    if (!trader) {
      const key = Keypair.generate();
      trader = key.publicKey;
      log(`trader key (import into a wallet for localnet): ${writeKey(state, 'trader', key)}`);
    }
    const operatorPath = writeKey(state, 'operator', operator);
    let adminToken = o.adminToken;
    if (!adminToken) {
      adminToken = randomBytes(32).toString('hex');
      const path = join(state, 'admin-token');
      writeFileSync(path, adminToken, { mode: 0o600 });
      log(`admin API token (Authorization: Bearer …): ${path}`);
    }

    log('starting solana-test-validator…');
    const clone = marketDependencies();
    const validator: Validator = await startValidator({
      rpcPort: PORTS.rpc, faucetPort: PORTS.faucet, gossipPort: PORTS.gossip, dynamicPortRange: PORTS.dynamic,
      upgradeAuthority: operator.publicKey,
      usdc: [[operator.publicKey, toMicro(OPERATOR_USDC)], [trader, toMicro(TRADER_USDC)]],
      clone,
    });
    cleanups.push(async () => {
      validator.stop();
      await sleep(500);
    });
    const { connection, rpcUrl, wsUrl } = validator;
    for (const [key, sol] of [[operator.publicKey, 100], [risk.publicKey, 10], [kyc.publicKey, 10], [trader, 10]] as const) {
      const signature = await connection.requestAirdrop(key, sol * LAMPORTS_PER_SOL);
      await waitFor('airdrop', async () => ((await connection.getSignatureStatuses([signature])).value[0]?.confirmationStatus === 'confirmed' ? true : undefined), 30_000);
    }
    log(`validator ${rpcUrl} (cloned ${clone.length} mainnet accounts)`);

    // ---- the operator runbook, through the real scripts ----
    const admin = (script: string, ...args: string[]) => {
      const out = execFileSync(process.execPath, [join(ROOT, 'scripts/admin', script), '--cluster', rpcUrl, '--execute', ...args], {
        cwd: ROOT, env: { ...process.env, OPERATOR_KEYPAIR: operatorPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
      });
      for (const line of out.trim().split('\n')) log(`  ${line}`);
    };
    log('operator scripts:');
    admin('initialize.ts');
    admin('set-authorities.ts', '--risk', risk.publicKey.toBase58(), '--kyc', kyc.publicKey.toBase58());
    const t = TEST_TIER;
    admin('upsert-tiers.ts', '--test-tier', `${t.id}:${t.sizeUsd}:${t.feeUsdc}:${t.profitTargetBps}`);
    admin('upsert-markets.ts', '--symbols', ALLOWLIST.join(','), '--max-position-usd', '10000', '--max-total-oi-usd', '50000');
    admin('deposit-capital.ts', '--amount', CAPITAL_USDC);
    execFileSync('solana', ['transfer', solTreasuryPda().toBase58(), TREASURY_SOL, '--keypair', operatorPath, '--url', rpcUrl, '--allow-unfunded-recipient'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    log(`  sol_treasury funded with ${TREASURY_SOL} SOL`);
    admin('set-pauses.ts', '--new-evaluations', 'off', '--trading', 'off', '--payouts', 'off');

    // ---- server ----
    log('starting the server…');
    const serverDir = join(ROOT, 'server');
    execFileSync(process.execPath, ['--import', 'tsx', 'src/db/migrate.ts'], { cwd: serverDir, env: { ...process.env, DATABASE_URL: o.databaseUrl }, stdio: 'ignore' });
    const apiUrl = `http://127.0.0.1:${PORTS.api}`;
    const appUrl = `http://127.0.0.1:${PORTS.app}`;
    const serverLog = join(tmpdir(), `props-local-stack-server-${Date.now()}.log`); // kept after exit
    const out = createWriteStream(serverLog);
    const server: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: o.databaseUrl,
        APP_ORIGIN: appUrl,
        SESSION_SECRET: randomBytes(32).toString('hex'),
        ADMIN_API_TOKEN: adminToken,
        RPC_URL: rpcUrl,
        RPC_WS_URL: wsUrl,
        SOLANA_CLUSTER: 'localnet',
        PROGRAM_ID: PROPS_VAULT_PROGRAM_ID.toBase58(),
        PORT: String(PORTS.api),
        HOST: '127.0.0.1',
        TRUST_PROXY_HOPS: '0',
        GMTRADE_DEPLOY_SLOT: '0', // the GMTrade binary is loaded at genesis
        RISK_AUTHORITY_KEYPAIR: JSON.stringify([...risk.secretKey]),
        KYC_AUTHORITY_KEYPAIR: JSON.stringify([...kyc.secretKey]),
      },
    });
    server.stdout!.pipe(out);
    server.stderr!.pipe(out);
    const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
    cleanups.push(async () => {
      server.kill('SIGTERM');
      await Promise.race([exited, sleep(12_000)]);
    });
    const crashed = exited.then(() => {
      throw new Error(`the server exited (${server.exitCode}); see ${serverLog}`);
    });
    await Promise.race([crashed, waitFor('the server', async () => {
      const health = await fetch(`${apiUrl}/v1/health`).then((r) => r.json()) as { modules: Record<string, string> };
      return Object.values(health.modules).every((m) => m === 'running') ? true : undefined;
    }, 60_000)]);
    await Promise.race([crashed, waitFor('live GMTrade market data', async () => ((await fetch(`${apiUrl}/v1/markets`)).ok ? true : undefined), 120_000)]);
    log(`server ${apiUrl} (log: ${serverLog})`);

    // ---- app: production build against this server and validator ----
    log('building the app…');
    const appDir = join(ROOT, 'app');
    const outDir = join(state, 'app-dist');
    Object.assign(process.env, { VITE_API_URL: apiUrl, VITE_RPC_URL: rpcUrl, VITE_CLUSTER: 'localnet', VITE_PROGRAM_ID: PROPS_VAULT_PROGRAM_ID.toBase58() });
    await build({ root: appDir, logLevel: 'error', build: { outDir, emptyOutDir: true } });
    const viteless = process.listeners('SIGTERM');
    const site = await preview({ root: appDir, logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: PORTS.app, strictPort: true } });
    // Vite's preview exits the process on SIGTERM as soon as its own server is closed, before the rest of the stack.
    for (const listener of process.listeners('SIGTERM')) if (!viteless.includes(listener)) process.off('SIGTERM', listener);
    cleanups.push(() => new Promise<void>((resolve) => site.httpServer.close(() => resolve())));
    log(`app ${appUrl}`);

    return {
      rpcUrl, wsUrl, apiUrl, appUrl, databaseUrl: o.databaseUrl, adminToken, operator: operator.publicKey, risk: risk.publicKey,
      kyc: kyc.publicKey, trader, serverLog, stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { trader: { type: 'string' } } });
  const databaseUrl = process.env.LOCAL_STACK_DATABASE_URL;
  if (!databaseUrl) throw new Error('set LOCAL_STACK_DATABASE_URL to a disposable Postgres database (its name must contain _test)');
  const stack = await startLocalStack({ databaseUrl, trader: values.trader ? new PublicKey(values.trader) : undefined }).catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
  console.log(`\nready: app ${stack.appUrl} · api ${stack.apiUrl} · rpc ${stack.rpcUrl} · trader ${stack.trader.toBase58()}`);
  console.log('Ctrl-C (or SIGTERM) stops the stack.');
}
