// Byte-level comparison of the Anchor build (target/deploy/props_vault.so) and the Pinocchio build
// (target/deploy/props_vault_p.so): runs one scenario on each in LiteSVM (tests/program/src/env.ts, deterministic keys
// and clock) and diffs every transaction outcome (success, Anchor error name, runtime error, every inner instruction's
// stack height, program, account list and data, i.e. events and CPIs) and every snapshotted account (lamports, owner,
// data). Compute units are printed, not compared, and so are log lines other than errors. The transaction metadata does
// not record an inner instruction's signer/writable flags, so those are not compared.
//
//   node programs-p/props_vault_p/compare/admin.ts        (exit code 1 when anything differs)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { FailedTransactionMetadata } from 'litesvm';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BUILDS = { anchor: join(ROOT, 'target/deploy/props_vault.so'), pinocchio: join(ROOT, 'target/deploy/props_vault_p.so') };

type EnvModule = typeof import('../../../tests/program/src/env.ts');
export type Env = InstanceType<EnvModule['Env']>;
type Record =
  | { label: string; ok: boolean; err: string | null; code: string | null; inner: string[]; cu: number; errors: string[] }
  | { label: string; accounts: unknown[] };

export interface Harness {
  /** tests/program/src/env.ts, imported after keys and clock were made deterministic. */
  env: EnvModule;
  /** Sends one transaction and records its outcome (it may fail; nothing is asserted). */
  send(env: Env, label: string, ixs: TransactionInstruction | TransactionInstruction[], signers: Keypair[]): void;
  /** Records the current state of `addresses`. */
  snap(env: Env, label: string, addresses: PublicKey[]): void;
  /** Copy of `ix` with its accounts and data rewritten by `f` (for malformed-instruction cases). */
  raw(ix: TransactionInstruction, f: (keys: TransactionInstruction['keys'], data: Buffer) => [TransactionInstruction['keys'], Buffer]): TransactionInstruction;
}

async function record(scenario: (h: Harness) => Promise<void>): Promise<Record[]> {
  let seed = 1;
  (Keypair as unknown as { generate: () => Keypair }).generate = () => {
    const s = new Uint8Array(32);
    s[0] = seed & 255;
    s[1] = seed >> 8;
    seed++;
    return Keypair.fromSeed(s);
  };
  Date.now = () => 1_790_000_000_000;
  const env: EnvModule = await import('../../../tests/program/src/env.ts');
  const out: Record[] = [];
  await scenario({
    env,
    send(e, label, ixs, signers) {
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...[ixs].flat());
      tx.feePayer = signers[0]!.publicKey;
      tx.recentBlockhash = e.svm.latestBlockhash();
      tx.sign(...signers);
      const res = e.svm.sendTransaction(tx);
      e.svm.expireBlockhash();
      const failed = res instanceof FailedTransactionMetadata;
      const meta = failed ? res.meta() : res;
      const logs = meta.logs();
      const keys = tx.compileMessage().accountKeys;
      out.push({
        label,
        ok: !failed,
        err: failed ? res.err().toString() : null,
        code: logs.map((l) => /Error Code: (\w+)/.exec(l)?.[1]).find(Boolean) ?? null,
        inner: failed
          ? []
          : meta.innerInstructions().flat().map((i) => {
              const ix = i.instruction();
              const accounts = Array.from(ix.accounts(), (a) => keys[a]!.toBase58()).join(',');
              return `${i.stackHeight()} ${keys[ix.programIdIndex()]!.toBase58()} [${accounts}] ${Buffer.from(ix.data()).toString('hex')}`;
            }),
        cu: Number(meta.computeUnitsConsumed()),
        errors: logs.filter((l) => /rror|already in use/.test(l)),
      });
    },
    snap(e, label, addresses) {
      out.push({
        label: `snapshot ${label}`,
        accounts: addresses.map((a) => {
          const acc = e.svm.getAccount(a);
          return acc ? { a: a.toBase58(), lamports: acc.lamports, owner: acc.owner.toBase58(), data: Buffer.from(acc.data).toString('hex') } : { a: a.toBase58(), missing: true };
        }),
      });
    },
    raw(ix, f) {
      const [keys, data] = f(ix.keys.map((k) => ({ ...k })), Buffer.from(ix.data));
      return new TransactionInstruction({ programId: ix.programId, keys, data });
    },
  });
  return out;
}

/** Runs `scenario` on both builds (each in its own process) and prints every difference. */
export async function compare(scenario: (h: Harness) => Promise<void>): Promise<void> {
  if (process.env.COMPARE_DUMP) {
    writeFileSync(process.env.COMPARE_DUMP, JSON.stringify(await record(scenario)));
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'props-vault-compare-'));
  const runs = Object.fromEntries(
    Object.entries(BUILDS).map(([name, so]) => {
      const dump = join(dir, `${name}.json`);
      const r = spawnSync(process.execPath, [process.argv[1]!], { env: { ...process.env, PROPS_VAULT_SO: so, COMPARE_DUMP: dump }, stdio: ['ignore', 'inherit', 'inherit'] });
      if (r.status !== 0) throw new Error(`${name} run failed`);
      return [name, JSON.parse(readFileSync(dump, 'utf8')) as Record[]];
    }),
  );
  const [a, p] = [runs.anchor!, runs.pinocchio!];
  let differences = 0;
  const show = (what: string, x: unknown, y: unknown) => {
    differences++;
    console.log(`  DIFF ${what}\n    anchor:    ${JSON.stringify(x)}\n    pinocchio: ${JSON.stringify(y)}`);
  };
  for (let i = 0; i < Math.max(a.length, p.length); i++) {
    const x = a[i]!;
    const y = p[i]!;
    if (!x || !y || x.label !== y.label) throw new Error(`scenario diverged at record ${i}`);
    if ('accounts' in x && 'accounts' in y) {
      console.log(x.label);
      x.accounts.forEach((acc, j) => JSON.stringify(acc) !== JSON.stringify(y.accounts[j]) && show(`account ${j}`, acc, y.accounts[j]));
    } else if (!('accounts' in x) && !('accounts' in y)) {
      console.log(`${x.label.padEnd(40)} ${x.ok ? 'ok  ' : 'fail'} ${String(x.code ?? '').padEnd(32)} CU ${x.cu} -> ${y.cu}`);
      for (const k of ['ok', 'err', 'code', 'inner'] as const) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) show(k, x[k], y[k]);
      // Error lines too, minus the origin ("caused by account: x" / "thrown in f:l") the Pinocchio build omits.
      const plain = (e: string[]) => e.map((l) => l.replace(/^(Program log: (?:Anchor|Program)Error) (?:caused by account: \w+|thrown in \S+:\d+)\./, '$1 occurred.'));
      if (JSON.stringify(plain(x.errors)) !== JSON.stringify(plain(y.errors))) show('errors', x.errors, y.errors);
    }
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`${a.length} records, ${differences} differences`);
  process.exitCode = differences ? 1 : 0;
}
