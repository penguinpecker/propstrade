import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The shipped interface describes real behaviour only: no copy may present the app as a preview or its data as samples.
const appDir = fileURLToPath(new URL('..', import.meta.url));
const shipped = dir => readdirSync(join(appDir, dir), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? shipped(join(dir, entry.name)) : /\.(jsx?|tsx?)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [join(dir, entry.name)] : []);

describe('interface copy', () => {
  it('has no preview, sample or illustrative wording', () => {
    const hits = ['index.html', ...shipped('src')].flatMap(file => readFileSync(join(appDir, file), 'utf8').split('\n')
      .flatMap((line, i) => /preview|sample|illustrative|design mock/i.test(line) ? [`${file}:${i + 1}: ${line.trim().slice(0, 120)}`] : []));
    expect(hits).toEqual([]);
  });

  it('ships no HTML comments in index.html (anyone can read them with view-source)', () => {
    expect(readFileSync(join(appDir, 'index.html'), 'utf8')).not.toMatch(/<!--/);
  });

  it('keeps the unsupported stop-entry order type out of the ticket', () => {
    expect(readFileSync(join(appDir, 'src/Trading.jsx'), 'utf8')).not.toMatch(/['"]Stop['"]/);
  });
});
