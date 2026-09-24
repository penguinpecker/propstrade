// The launch runbook is written for the Anchor build; PORTING.md deviation 5 lists, section by section, what the switch
// to the Pinocchio build must change there. Round-3 audit: that list missed §4's binary path (it would size and deploy
// an Anchor build), §14.2's write-buffer path and the Anchor-sized SOL figures of §2 and §15. This keeps it complete:
// every runbook line that names the Anchor binary, crate, IDL tooling or size lies in a section the list has a bullet for.
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
const ANCHOR_SPECIFIC = /target\/deploy\/props_vault\.so|--library-name props_vault\b(?!_p)|programs\/props_vault\/|anchor idl|978(,072|072| KB)|10 SOL/;

describe('PORTING.md deviation 5 (switching the deploy to this build)', () => {
  it('has a bullet for every launch-runbook section that names the Anchor binary, crate, IDL tooling or size', () => {
    const porting = read('programs-p/props_vault_p/PORTING.md');
    const start = porting.indexOf('\n5. Anchor');
    const deviation = porting.slice(start, porting.indexOf('\n6. ', start));
    // "§13.2-13.3" covers both steps; "§13.4 and §14.5" both sections.
    const covered = new Set(deviation.split('\n').filter((l) => l.startsWith('   - §')).flatMap((l) => {
      const head = l.slice(5, l.indexOf(':'));
      const range = /^§(\d+)\.(\d+)-\1\.(\d+)$/.exec(head);
      if (range) return Array.from({ length: Number(range[3]) - Number(range[2]) + 1 }, (_, i) => `§${range[1]}.${Number(range[2]) + i}`);
      return head.split(' and ');
    }));
    const missing: string[] = [];
    let section = '';
    let step = '';
    read('docs/runbooks/launch.md').split('\n').forEach((line, i) => {
      const heading = /^## (\d+)\./.exec(line);
      if (heading) [section, step] = [heading[1]!, ''];
      else if (section && /^\d+\. /.test(line)) step = line.slice(0, line.indexOf('.'));
      const label = step ? `§${section}.${step}` : `§${section}`;
      if (section && ANCHOR_SPECIFIC.test(line) && !covered.has(label)) missing.push(`${label} (line ${i + 1}): ${line.trim()}`);
    });
    assert.deepEqual(missing, [], 'runbook lines in sections deviation 5 does not list');
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
