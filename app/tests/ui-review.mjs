// UI-fidelity and no-placeholder checks from the round-2 app review (node tests/ui-review.mjs). Each check names the
// finding it proves; they fail until the finding is fixed. Same harness as e2e.mjs: production build + tests/stub.mjs.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { PROGRAM_ID, startStub } from './stub.mjs';
import { exposeSigner, installTestWallet, testKeys } from './wallet.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(tmpdir(), 'props-app-ui-review');
const stub = await startStub();
const [key] = testKeys(1);
Object.assign(process.env, { VITE_API_URL: stub.url, VITE_RPC_URL: `${stub.url}/rpc`, VITE_CLUSTER: 'mainnet-beta', VITE_PROGRAM_ID: PROGRAM_ID });
await build({ root: appDir, logLevel: 'error', build: { outDir, emptyOutDir: true } });
const site = await preview({ root: appDir, logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: 4201 } });
const siteUrl = site.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function signedIn(viewport = { width: 1920, height: 1080 }) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  await exposeSigner(context, [key]);
  await context.addInitScript(installTestWallet, { accounts: [{ address: key.address, publicKey: key.publicKey }], trusted: true });
  await context.addInitScript(() => { if (location.protocol === 'http:') localStorage.setItem('walletName', '"Props Test Wallet"'); });
  const token = randomBytes(16).toString('hex');
  stub.state.sessions.set(token, key.address);
  await context.addCookies([{ name: 'props_session', value: token, url: stub.url }]);
  return context;
}
const row = (scope, label) => scope.locator('.data-row').filter({ has: scope.page().getByText(label, { exact: true }) }).locator('strong').first();

let failures = 0;
const only = process.env.REVIEW_ONLY && new RegExp(process.env.REVIEW_ONLY); // e.g. REVIEW_ONLY='stale|payouts'
async function check(name, fn) {
  if (only && !only.test(name)) return;
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name}\n     ${error.message.split('\n').slice(0, 3).join('\n     ')}`); }
}

try {
  for (const [viewport, place] of [[{ width: 1920, height: 1080 }, 'right-aligned at 1920px'], [{ width: 390, height: 844 }, 'hidden at 390px']])
    await check(`market heading: the session badge is ${place}, as in the reference (Trading.jsx wraps it in a span, so .market-heading>.badge no longer applies)`, async () => {
      const context = await signedIn(viewport);
      const page = await context.newPage();
      await page.goto(`${siteUrl}/#/trade/practice`);
      const badge = page.locator('.market-heading .badge');
      await badge.waitFor({ state: 'attached' });
      await page.locator('.market-price').waitFor();
      if (viewport.width < 600) assert.equal(await badge.isVisible(), false, 'the session badge shows in the phone market heading');
      else {
        const [b, h] = await Promise.all([badge.boundingBox(), page.locator('.market-heading').boundingBox()]);
        assert.ok(h.x + h.width - (b.x + b.width) < 40, `badge ends ${Math.round(h.x + h.width - b.x - b.width)}px before the heading edge`);
      }
      await context.close();
    });

  await check('checkout: "Total due" stays on one line at 1920x1080', async () => {
    const context = await signedIn();
    const page = await context.newPage();
    await page.goto(`${siteUrl}/#/checkout`);
    const total = page.locator('.checkout-total .data-row.total');
    await total.getByText(/SOL/).waitFor();
    const lines = await total.evaluate(el => [...el.children].map(c => Math.round(c.getBoundingClientRect().height / parseFloat(getComputedStyle(c).lineHeight))));
    assert.deepEqual(lines, [1, 1], `label and value wrap to ${lines.join(' and ')} lines`);
    await context.close();
  });

  await check('payouts: no $0.00 placeholder while payout eligibility is loading (non-negotiable 1)', async () => {
    const context = await signedIn();
    await context.route(`${stub.url}/v1/accounts/*/payout-eligibility`, () => undefined); // never answers
    const page = await context.newPage();
    await page.goto(`${siteUrl}/#/payouts`);
    const amount = page.locator('.payout-available > strong');
    await amount.waitFor();
    assert.doesNotMatch(await amount.innerText(), /\$0\s*\.00/, 'shows $0.00 before the API answered');
    await context.close();
  });

  await check('order ticket: after a market switch it never shows the previous market\'s quote', async () => {
    const context = await signedIn();
    const page = await context.newPage();
    await page.goto(`${siteUrl}/#/trade/practice`);
    const entry = row(page.locator('.order-panel'), 'Estimated entry');
    await page.locator('.order-panel').getByText('Trading fee').waitFor();
    await page.waitForFunction(() => /64,4\d\d/.test(document.querySelector('.execution-details')?.innerText ?? ''));
    await context.route(/\/v1\/quote\?symbol=ETH/, () => undefined); // ETH's quote is still loading
    await page.locator('.watchlist-bar').getByRole('button', { name: /^ETH/ }).click();
    await page.locator('.market-price').getByText('2,641.82').waitFor();
    await page.waitForTimeout(1_000);
    const shown = await entry.innerText();
    assert.doesNotMatch(shown, /^64,/, `ETH ticket shows an estimated entry of ${shown} (BTC's quote)`);
    await context.close();
  });

  await check('evaluation result: pending checks are not coloured like completed ones in the dark theme', async () => {
    const context = await signedIn();
    const page = await context.newPage();
    await page.goto(`${siteUrl}/#/trade/evaluation`);
    await page.locator('.account-strip').getByText('Evaluation 25K').waitFor();
    await page.goto(`${siteUrl}/#/result`);
    await page.locator('.pending-mark').first().waitFor();
    const [done, pending] = await page.evaluate(() => ['.checkmark', '.pending-mark'].map(s => getComputedStyle(document.querySelector(s)).color));
    assert.notEqual(pending, done, `pending and done marks share ${done}`);
    await context.close();
  });

  await check('stale prices: a funded order cannot be submitted on a price the terminal marks as stale', async () => {
    const context = await signedIn();
    await context.route(`${stub.url}/v1/markets`, async route => {
      const response = await route.fetch();
      route.fulfill({ response, json: (await response.json()).map(m => ({ ...m, freshness: 'stale', updatedAt: Date.now() - 3_600_000 })) });
    });
    const page = await context.newPage();
    await page.goto(`${siteUrl}/#/trade/funded`);
    await page.getByText('Price is stale').waitFor();
    await page.locator('.app-footer').getByText('Live data connected').waitFor();
    assert.equal(await page.locator('.order-submit').isDisabled(), true, 'Buy / Long is enabled on an hour-old price');
    await context.close();
  });

  await check('stale prices: the Markets directory marks a stale price', async () => {
    const context = await signedIn();
    await context.route(`${stub.url}/v1/markets`, async route => {
      const response = await route.fetch();
      route.fulfill({ response, json: (await response.json()).map(m => ({ ...m, freshness: 'stale', updatedAt: Date.now() - 3_600_000 })) });
    });
    const page = await context.newPage();
    await page.goto(`${siteUrl}/#/markets`);
    const btc = page.locator('.markets-table tbody tr').filter({ hasText: 'BTC / USD' });
    await btc.waitFor();
    assert.match(await btc.innerText(), /stale|delayed|last update/i, 'an hour-old BTC price is listed like a live one');
    await context.close();
  });

  await check('funded activation: the amount labelled USDC is the USDC the vault posts', async () => {
    const context = await signedIn();
    const page = await context.newPage();
    await page.goto(`${siteUrl}/#/activate`);
    const allocation = page.locator('.allocation-value');
    await allocation.waitFor();
    const posted = await row(page.locator('.activation-allocation'), 'Posted as collateral').innerText();
    const shown = await allocation.innerText();
    if (/USDC/.test(shown)) assert.equal(shown.replace(/\s|USDC/g, ''), posted.replace(/\s|USDC/g, ''), `headline "${shown.replace(/\s+/g, ' ')}" vs posted "${posted}"`);
    await context.close();
  });

  await check('trade terminal: a failed accounts request is not presented as "no funded account"', async () => {
    const context = await signedIn();
    await context.route(`${stub.url}/v1/accounts`, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"internal","message":"Internal error."}}' }));
    const page = await context.newPage();
    await page.goto(`${siteUrl}/#/trade/funded`);
    const strip = page.locator('.account-strip');
    await page.waitForFunction(() => !/Loading account|Connect a wallet/.test(document.querySelector('.account-strip')?.innerText ?? 'Loading account'), null, { timeout: 20_000 }); // after the client's retries
    assert.doesNotMatch(await strip.innerText(), /No funded account|Pass an evaluation/, 'the error reads as an empty account list');
    await context.close();
  });

  await check('shipped index.html carries no internal design-process comment', async () => {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /<!--[\s\S]*?(THESIS|user's request|finish review)[\s\S]*?-->/, 'dist/index.html ships the design-process notes');
  });
} finally {
  await browser.close();
  await new Promise(resolve => site.httpServer.close(resolve));
  stub.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
