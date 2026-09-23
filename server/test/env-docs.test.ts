// Every environment variable the server process reads (config schema, modules, and the workspace packages it runs) is
// documented in server/.env.example and in the launch runbook, and every documented one is still read by the server
// or its tests. A new variable therefore cannot reach production undocumented, and a removed one cannot linger.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../src/config.js';

const root = new URL('../../', import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const sources = (dir: string) =>
  readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f));
const isTest = (path: string) => /\.test\.ts$|\/test\//.test(path);

/** Names read through `process.env.X`, `ctx.env.X` / `env.X`, `env['X']`, `loadKeypair(env, 'X')` and `const { X } = env`. */
function envReads(code: string): string[] {
  const names = [
    ...code.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)/g),
    ...code.matchAll(/\benv\[['"]([A-Z][A-Z0-9_]*)['"]\]/g),
    ...code.matchAll(/loadKeypair\([^,()]+,\s*'([A-Z][A-Z0-9_]*)'\)/g),
  ].map((m) => m[1]!);
  for (const [, fields] of code.matchAll(/\{([^{}]*)\}\s*=\s*[\w.]*\benv\b/g)) names.push(...(fields!.match(/\b[A-Z][A-Z0-9_]*\b/g) ?? []));
  return names;
}

const files = [...sources('server/src'), ...sources('server/test'), ...['gmtrade', 'sdk', 'shared', 'gmsol-wasm'].flatMap((p) => sources(`packages/${p}/src`))];
const runtime = new Set([...Object.keys(EnvSchema.shape), ...files.filter((f) => !isTest(f)).flatMap((f) => envReads(read(f)))]);
const anywhere = new Set([...runtime, ...files.flatMap((f) => envReads(read(f)))]);
const example = new Set([...read('server/.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));
const runbook = read('docs/runbooks/launch.md');

describe('server environment documentation', () => {
  it('finds every form of env read the server uses', () => {
    expect(envReads(`const a = process.env.A_1; ctx.env.B; env['C']; loadKeypair(ctx.env, 'D');
      const { E: e, F } = d.env; import.meta.env.lower; env.lower;`)).toEqual(['A_1', 'B', 'C', 'D', 'E', 'F']);
    for (const name of ['DATABASE_URL', 'SIM_FILL_DELAY_MS', 'RISK_AUTHORITY_KEYPAIR', 'TELEGRAM_CHAT_ID', 'SENTRY_DSN', 'GMTRADE_DEPLOY_SLOT'])
      expect(runtime).toContain(name);
  });

  it('documents every variable the server reads in server/.env.example', () => {
    expect([...runtime].filter((name) => !example.has(name))).toEqual([]);
  });

  it('documents every variable the server reads in docs/runbooks/launch.md', () => {
    expect([...runtime].filter((name) => !new RegExp(`\\b${name}\\b`).test(runbook))).toEqual([]);
  });

  it('documents no variable that nothing reads', () => {
    expect([...example].filter((name) => !anywhere.has(name))).toEqual([]);
  });
});
