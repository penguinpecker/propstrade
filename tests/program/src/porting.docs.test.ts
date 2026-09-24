// The launch runbook deploys the Pinocchio build (PORTING.md deviation 5 records the switch of 2026-09-24). These checks
// fail if a section regresses to the Anchor binary (`target/deploy/props_vault.so`), the Anchor crate, `anchor idl`
// tooling or a suite run without PROPS_VAULT_SO: the round-3 audit found exactly such gaps (§4 sized and deployed
// whatever Anchor build `target/deploy/props_vault.so` held, §14.2 wrote one into the upgrade buffer).
// Round-4 audit: the runbook's build and admin steps also rest on things no suite asserted: both Cargo workspaces parse
// (a duplicated `[workspace.metadata.cli]` had broken `cargo test`, `anchor build` and `solana-verify build` for the
// Anchor crate), the suites and compare scenarios name the binary they load, and every `set-params.ts` /
// `set-pauses.ts` line names what the `--print-for` refusal demands of a Squads proposal.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const ROOT = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const PINOCCHIO_SO = 'programs-p/props_vault_p/target/deploy/props_vault_p.so';

describe('launch runbook: the deploy is the Pinocchio build (PORTING.md deviation 5)', () => {
  const lines = read('docs/runbooks/launch.md').split('\n');
  /** The lines of section `n` of the runbook (its `## n.` heading to the next), or of numbered step `s` inside it. */
  const section = (n: number, s?: number) => {
    let current = '';
    let step = '';
    return lines.filter((line) => {
      const heading = /^## (\d+)\./.exec(line);
      if (heading) [current, step] = [heading[1]!, ''];
      else if (/^\d+\. /.test(line)) step = line.slice(0, line.indexOf('.'));
      return current === String(n) && (s === undefined || step === String(s));
    });
  };
  const has = (where: string[], text: string, label: string) => assert.ok(where.some((l) => l.includes(text)), `${label}: no line has ${JSON.stringify(text)}`);

  it('§4 sizes and deploys, and §14.2 writes into the upgrade buffer, the solana-verify build of the Pinocchio crate', () => {
    has(section(4), `SO=${PINOCCHIO_SO}`, '§4');
    has(section(14, 2), `write-buffer ${PINOCCHIO_SO}`, '§14.2');
    assert.deepEqual([...section(4), ...section(14)].filter((l) => l.includes('target/deploy/props_vault.so')), [], 'the Anchor binary in §4 or §14');
  });

  it('§3.2, §13.4 and §14.5 build and verify programs-p/props_vault_p, and nothing names the Anchor crate', () => {
    has(section(3, 2), 'solana-verify build "$PWD/programs-p/props_vault_p" --library-name props_vault_p', '§3.2');
    has(section(3, 2), `get-executable-hash ${PINOCCHIO_SO}`, '§3.2');
    for (const [n, s] of [[13, 4], [14, 5]] as const) {
      assert.ok(section(n, s).join(' ').includes('--library-name props_vault_p --mount-path programs-p/props_vault_p'), `§${n}.${s}: verify-from-repo flags`);
    }
    assert.deepEqual(lines.filter((l) => /--library-name props_vault\b(?!_p)|programs\/props_vault\//.test(l)), [], 'lines naming the Anchor crate');
  });

  it('§3.3 exports PROPS_VAULT_SO as that file and runs every suite, the compare scenarios and the fuzzers on it', () => {
    const step = section(3, 3);
    has(step, `export PROPS_VAULT_SO=$PWD/${PINOCCHIO_SO}`, '§3.3');
    for (const cmd of [
      'cargo test --manifest-path programs-p/props_vault_p/Cargo.toml',
      'npm test --workspace tests/program',
      'npm run test:validator --workspace tests/program',
      'npm run test:modules --workspace server',
      'node app/tests/fullstack.e2e.mjs',
      'node programs-p/props_vault_p/compare/$s.ts',
      'FUZZ_QUICK=1 node programs-p/props_vault_p/fuzz/run.ts',
    ]) has(step, cmd, '§3.3');
  });

  it('no IDL step: §0, §4, §13 and §14 run no anchor idl command and §15 has no IDL row', () => {
    const commands = [0, 4, 13, 14].flatMap((n) => section(n).filter((l) => /anchor idl (init|authority|set-|write-|build)/.test(l)));
    assert.deepEqual(commands, []);
    assert.ok(!section(0).some((l) => l.startsWith('build →') && l.includes('IDL')), '§0 order still has an IDL step');
    assert.ok(!section(15).some((l) => l.startsWith('| Anchor IDL')), '§15 still has the IDL row');
  });
});

describe('launch runbook build and admin steps (round 4)', () => {
  it('both Cargo workspaces parse and pin the solana-verify image (§3.2, §3.3, scripts/fixtures.sh)', () => {
    for (const [manifest, crate] of [['Cargo.toml', 'props_vault'], ['programs-p/props_vault_p/Cargo.toml', 'props_vault_p']] as const) {
      const r = spawnSync('cargo', ['metadata', '--no-deps', '--offline', '--format-version', '1', '--manifest-path', new URL(manifest, ROOT).pathname], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${manifest}: ${r.error?.message ?? r.stderr}`);
      const meta = JSON.parse(r.stdout) as { packages: { name: string }[]; metadata: { cli?: { solana?: string } } | null };
      assert.ok(meta.packages.some((p) => p.name === crate), `${crate} is not a member of ${manifest}`);
      assert.equal(meta.metadata?.cli?.solana, '3.1.10', `${manifest}: [workspace.metadata.cli] solana`);
    }
  });

  /** Imports env.ts in a child process with PROPS_VAULT_SO set (or unset), as every suite and compare scenario does. */
  const loadEnv = (so?: string) => {
    const env = { ...process.env };
    delete env.PROPS_VAULT_SO;
    if (so !== undefined) env.PROPS_VAULT_SO = so;
    return spawnSync(process.execPath, ['--input-type=module', '-e', `import ${JSON.stringify(new URL('./env.ts', import.meta.url).href)}`], { encoding: 'utf8', env });
  };

  it('every suite names the binary it loads: path, size and the hash solana-verify get-executable-hash prints (§3.3)', () => {
    const so = process.env.PROPS_VAULT_SO || new URL('target/deploy/props_vault.so', ROOT).pathname;
    const bytes = readFileSync(so);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--; // solana-verify hashes the file minus its trailing zero bytes
    const hash = createHash('sha256').update(bytes.subarray(0, end)).digest('hex');
    const r = loadEnv(so);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(`props_vault binary: ${so} (${bytes.length} bytes, executable hash ${hash})`), r.stderr);
  });

  it('refuses a relative PROPS_VAULT_SO instead of resolving it against the working directory', () => {
    const r = loadEnv('target/deploy/props_vault.so');
    assert.notEqual(r.status, 0, 'a relative path was accepted');
    assert.match(r.stderr, /PROPS_VAULT_SO must be an absolute path/);
  });

  it('the compare harness takes its Pinocchio side from PROPS_VAULT_SO (deviation 5 §3.3)', () => {
    const r = spawnSync(process.execPath, [new URL('programs-p/props_vault_p/compare/admin.ts', ROOT).pathname], {
      encoding: 'utf8', env: { ...process.env, PROPS_VAULT_SO: '/nonexistent/props_vault_p.so' },
    });
    assert.notEqual(r.status, 0, `a missing Pinocchio binary still compared: ${r.stdout.trim().split('\n').at(-1)}`);
  });

  it('every set-params.ts / set-pauses.ts line that may run with --print-for names every parameter or flag (§12)', () => {
    const needed = {
      params: ['--trader-share-bps', '--min-payout', '--owner-sol-target', '--owner-sol-min', '--max-daily-principal'],
      pauses: ['--new-evaluations', '--trading', '--payouts'],
    };
    const stale: string[] = [];
    read('docs/runbooks/launch.md').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/set-(params|pauses)\.ts( --[^`#]*)/g)) {
        const args = m[2]!;
        if (!args.includes('--execute') && !needed[m[1] as keyof typeof needed].every((flag) => args.includes(flag))) stale.push(`line ${i + 1}: ${m[0].trim()}`);
      }
    });
    assert.deepEqual(stale, [], 'invocations the --print-for refusal rejects');
  });
});
