// Every environment variable the app reads — inlined by Vite at build time (src/, vite.config.js) or read by the Vercel
// middleware at request time — is documented in app/.env.example and in the launch runbook, and every documented one
// is still read. A new variable therefore cannot reach a deploy undocumented, and a removed one cannot linger.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
// Vite's own flags, not variables anyone sets.
const VITE_BUILT_INS = new Set(['DEV', 'PROD', 'MODE', 'BASE_URL', 'SSR']);

/** Names read through `import.meta.env.X`, `process.env.X`, or the `env` / `vars` objects holding either. */
const envReads = code => [...code.matchAll(/\b(?:import\.meta\.env|process\.env|env|vars)\.([A-Z][A-Z0-9_]*)/g)].map(m => m[1]).filter(name => !VITE_BUILT_INS.has(name));

const files = [
  ...readdirSync(new URL('app/src/', root), { recursive: true }).filter(f => /\.(jsx?|tsx?)$/.test(f) && !/\.test\./.test(f)).map(f => `app/src/${f}`),
  'app/middleware.js', 'app/vite.config.js',
];
const reads = new Set(files.flatMap(f => envReads(read(f))));
const example = new Set([...read('app/.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(m => m[1]));
const runbook = read('docs/runbooks/launch.md');

describe('app environment documentation', () => {
  it('finds every form of env read the app uses', () => {
    expect(envReads('import.meta.env.DEV; import.meta.env.VITE_A; process.env.VITE_B; vars.VITE_C; env.VITE_D; env.apiUrl')).toEqual(['VITE_A', 'VITE_B', 'VITE_C', 'VITE_D']);
    expect([...reads]).toEqual(expect.arrayContaining(['VITE_API_URL', 'VITE_CLUSTER', 'VITE_PROGRAM_ID', 'VITE_RPC_URL']));
  });

  it('documents every variable the app reads in app/.env.example', () => {
    expect([...reads].filter(name => !example.has(name))).toEqual([]);
  });

  it('documents every variable the app reads in docs/runbooks/launch.md', () => {
    expect([...reads].filter(name => !new RegExp(`\\b${name}\\b`).test(runbook))).toEqual([]);
  });

  it('documents no variable that nothing reads', () => {
    expect([...example].filter(name => !reads.has(name))).toEqual([]);
  });
});
