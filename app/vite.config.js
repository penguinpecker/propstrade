import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const appDir = fileURLToPath(new URL('.', import.meta.url));
const CLUSTERS = ['mainnet-beta', 'localnet'];

/** Build-time copy of the checks env.ts makes at runtime, so a misconfigured deploy fails its build instead of shipping a blank page. */
export function checkBuildEnv(vars) {
  const cluster = vars.VITE_CLUSTER || 'mainnet-beta';
  if (!CLUSTERS.includes(cluster)) throw new Error(`VITE_CLUSTER must be one of: ${CLUSTERS.join(', ')}`);
  if (cluster === 'mainnet-beta' && !vars.VITE_RPC_URL) throw new Error('VITE_RPC_URL is required for mainnet builds (see app/.env.example).');
  if (!vars.VITE_API_URL) throw new Error('VITE_API_URL is required for builds: the API is deployed separately (see app/.env.example).');
}

/** Emits third-party-licenses.txt: name, version, license and license/notice files of every package in the bundle. */
export function bundledLicenses() {
  return {
    name: 'bundled-licenses',
    apply: 'build',
    generateBundle(_, bundle) {
      const roots = new Set();
      for (const file of Object.values(bundle))
        for (const id of file.type === 'chunk' ? Object.keys(file.modules) : []) {
          const root = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(id)?.[1];
          if (root) roots.add(root);
        }
      const entries = new Map(); // one entry per name@version, however many copies are installed
      for (const root of roots) {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        const license = pkg.license?.type ?? pkg.license ?? pkg.licenses?.map(l => l.type).join(' OR ') ?? 'see below';
        const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
        const source = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
        const texts = readdirSync(root).filter(name => /^(licen[cs]e|notice|copying)/i.test(name)).sort()
          .map(name => readFileSync(join(root, name), 'utf8').trim());
        entries.set(`${pkg.name}@${pkg.version}`, [
          `${pkg.name} ${pkg.version} (${license})`, author && `Author: ${author}`, source && `Source: ${source}`, '',
          texts.join('\n\n') || `The package ships no license file; its package.json declares ${license}.`,
        ].filter(line => line !== undefined).join('\n'));
      }
      const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text);
      this.emitFile({
        type: 'asset',
        fileName: 'third-party-licenses.txt',
        source: `Third-party packages bundled in the Props.trade app (${sorted.length}).\n\n${sorted.map(text => `${'='.repeat(78)}\n${text}`).join('\n\n')}\n`,
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  if (command === 'build') checkBuildEnv(loadEnv(mode, appDir, 'VITE_'));
  return { plugins: [bundledLicenses()] };
});
