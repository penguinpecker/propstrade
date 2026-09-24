// The differential fuzz campaign: runs seqfuzz.ts and invariants.ts over a FIXED seed list against
// target/deploy/props_vault.so and target/deploy/props_vault_p.so, at most two LiteSVM processes at a time (each job is
// one fuzzer parent that runs the Anchor child, then the Pinocchio child), and exits 1 on any build difference,
// invariant violation or crashed job. Every job's log and JSON summary go to FUZZ_LOG_DIR (default: a temp dir).
//
//   node programs-p/props_vault_p/fuzz/run.ts                (the whole campaign, about an hour)
//   FUZZ_QUICK=1 node programs-p/props_vault_p/fuzz/run.ts   (the first job of each fuzzer: checks the wiring in a minute)
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('./', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PARALLEL = 2;
// The seed list: seqfuzz seeds 1..1000 at 250 steps, five seeds per process (a seqfuzz child keeps about 200 MB per seed
// it ran), invariants seeds 1..600 at 400 steps (one seed per process by design).
const SEQ = { first: 1, count: 1000, perJob: 5, steps: 250 };
const INV = { first: 1, count: 600, steps: 400 };

type Summary = { fuzzer: string; seeds: number[]; records: number; txs: number; ok: number; actions: Record<string, { ok: number; fail: number }>; differences: string[]; violations: string[] };
type Job = { name: string; args: string[]; env: Record<string, string> };

const seq: Job[] = [];
for (let s = SEQ.first; s < SEQ.first + SEQ.count; s += SEQ.perJob) {
  seq.push({ name: `seqfuzz-${s}-${s + SEQ.perJob - 1}`, args: [join(HERE, 'seqfuzz.ts'), String(SEQ.perJob), String(SEQ.steps)], env: { FIRST_SEED: String(s) } });
}
const inv: Job[] = [];
for (let s = INV.first; s < INV.first + INV.count; s++) {
  inv.push({ name: `invariants-${s}`, args: [join(HERE, 'invariants.ts')], env: { FUZZ_SEED: String(s), FUZZ_STEPS: String(INV.steps) } });
}
// Interleaved so both fuzzers run throughout the campaign.
const jobs = process.env.FUZZ_QUICK
  ? [seq[0]!, inv[0]!]
  : [...seq.map((j, i) => [i / seq.length, j] as const), ...inv.map((j, i) => [i / inv.length, j] as const)].sort((a, b) => a[0] - b[0]).map(([, j]) => j);

const logDir = process.env.FUZZ_LOG_DIR ?? mkdtempSync(join(tmpdir(), 'props-vault-fuzz-'));
mkdirSync(logDir, { recursive: true });
console.log(`${jobs.length} jobs (${seq.length} seqfuzz x ${SEQ.perJob} seeds x ${SEQ.steps} steps, ${inv.length} invariants x ${INV.steps} steps), ${PARALLEL} at a time, logs in ${logDir}`);
const start = Date.now();
const summaries: Summary[] = [];
const crashed: string[] = [];
let next = 0;
let running = 0;
let finished = 0;

await new Promise<void>((done) => {
  const launch = () => {
    while (running < PARALLEL && next < jobs.length) {
      const job = jobs[next++]!;
      running++;
      const t = Date.now();
      const summaryPath = join(logDir, `${job.name}.json`);
      const log = openSync(join(logDir, `${job.name}.log`), 'w');
      const child = spawn(process.execPath, job.args, { cwd: ROOT, env: { ...process.env, ...job.env, FUZZ_SUMMARY: summaryPath }, stdio: ['ignore', log, log] });
      child.on('exit', (code) => {
        closeSync(log);
        running--;
        finished++;
        let s: Summary | undefined;
        try {
          s = JSON.parse(readFileSync(summaryPath, 'utf8'));
        } catch {
          crashed.push(`${job.name}: exit ${code}, no summary (see ${join(logDir, `${job.name}.log`)})`);
        }
        if (s) summaries.push(s);
        console.log(`[${finished}/${jobs.length}] ${job.name.padEnd(22)} ${s ? `${String(s.txs).padStart(5)} txs, ${s.differences.length} differences, ${s.violations.length} violations` : `CRASHED (exit ${code})`}  ${((Date.now() - t) / 1000).toFixed(0)} s`);
        if (next < jobs.length) launch();
        else if (running === 0) done();
      });
    }
  };
  launch();
});

const elapsed = (Date.now() - start) / 1000;
const total = (k: 'records' | 'txs' | 'ok') => summaries.reduce((n, s) => n + s[k], 0);
const differences = summaries.flatMap((s) => s.differences.map((d) => `${s.fuzzer} ${d}`));
const violations = summaries.flatMap((s) => s.violations.map((v) => `${s.fuzzer} ${v}`));
for (const fuzzer of ['seqfuzz', 'invariants']) {
  const actions = new Map<string, { ok: number; fail: number }>();
  const mine = summaries.filter((s) => s.fuzzer === fuzzer);
  for (const s of mine) for (const [k, v] of Object.entries(s.actions)) {
    const a = actions.get(k) ?? { ok: 0, fail: 0 };
    a.ok += v.ok;
    a.fail += v.fail;
    actions.set(k, a);
  }
  console.log(`\n${fuzzer}: ${mine.length} jobs, seeds ${mine.flatMap((s) => s.seeds).length}, ${mine.reduce((n, s) => n + s.txs, 0)} transactions (${mine.reduce((n, s) => n + s.ok, 0)} succeeded)`);
  for (const [k, a] of [...actions].sort()) console.log(`  ${k.padEnd(26)} ok ${String(a.ok).padStart(6)}  fail ${String(a.fail).padStart(6)}`);
}
for (const d of differences) console.log(`DIFFERENCE ${d}`);
for (const v of violations) console.log(`VIOLATION ${v}`);
for (const c of crashed) console.log(`CRASHED ${c}`);
console.log(`\n${summaries.length}/${jobs.length} jobs, ${total('records')} records, ${total('txs')} transactions sent (${total('ok')} succeeded), ${differences.length} differences, ${violations.length} violations, ${crashed.length} crashed, ${(elapsed / 60).toFixed(1)} min`);
process.exitCode = differences.length || violations.length || crashed.length ? 1 : 0;
