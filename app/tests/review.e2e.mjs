// Review findings in the funded terminal, driven in headless Chrome against the test stub (same setup as e2e.mjs).
// Run: node tests/review.e2e.mjs. Each check states the behaviour the terminal should have.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { toUnitPrice } from '@props/sdk';
import { PROGRAM_ID, startStub } from './stub.mjs';
import { exposeSigner, installTestWallet, testKeys } from './wallet.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(tmpdir(), 'props-app-review-e2e');
const stub = await startStub();
const { state } = stub;
const [key] = testKeys(1);
Object.assign(process.env, { VITE_API_URL: stub.url, VITE_RPC_URL: `${stub.url}/rpc`, VITE_CLUSTER: 'mainnet-beta', VITE_PROGRAM_ID: PROGRAM_ID });
await build({ root: appDir, logLevel: 'error', build: { outDir, emptyOutDir: true } });
const site = await preview({ root: appDir, logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: 4199 } });
const siteUrl = site.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name}\n     ${error.message.split('\n').slice(0, 3).join('\n     ')}`); }
}

try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await exposeSigner(context, [key], () => { state.signatures += 1; });
  await context.addInitScript(installTestWallet, { accounts: [{ address: key.address, publicKey: key.publicKey }], trusted: true });
  await context.addInitScript(() => { if (location.protocol === 'http:') localStorage.setItem('walletName', '"Props Test Wallet"'); });
  const token = randomBytes(16).toString('hex');
  state.sessions.set(token, key.address);
  await context.addCookies([{ name: 'props_session', value: token, url: stub.url }]);
  const page = await context.newPage();
  const ticket = page.locator('.order-panel');
  const opens = () => state.sent.filter(s => s.name === 'openPosition' && s.wallet === key.address);
  await page.goto(`${siteUrl}/#/trade/funded`);
  await page.getByText('Funded 1K').first().waitFor();
  await page.getByText('Live data connected').waitFor({ timeout: 10_000 });

  await check('a slippage the dialog refuses to save is not used for a funded order', async () => {
    // Slippage lives in the Order details disclosure, collapsed by default.
    const details = ticket.locator('.order-details');
    if (!(await details.evaluate(d => d.open))) await details.locator('summary').click();
    await ticket.getByRole('button', { name: /0\.5%/ }).click();
    await page.getByLabel('Maximum slippage (%)').fill('50');
    assert.ok(await page.getByRole('button', { name: 'Save tolerance' }).isDisabled(), 'the dialog accepts 50%');
    await page.keyboard.press('Escape'); // or the dialog's close button: both keep the typed value
    await page.getByLabel('Order size in USD').fill('200');
    await ticket.getByRole('button', { name: 'Buy / Long BTC' }).click();
    await ticket.getByText('BTC long executed on the exchange.').waitFor({ timeout: 10_000 });
    const [open] = opens();
    const mid = toUnitPrice(state.markets.find(m => m.symbol === 'BTC').price, 8);
    const tolerance = Number(BigInt(open.data.args.acceptablePrice.toString()) * 10_000n / mid) / 100 - 100;
    assert.ok(tolerance <= 5, `the signed order accepts fills ${tolerance.toFixed(2)}% above the price (dialog maximum 5%)`);
  });

  await check('an open position can still be closed while another funded order awaits execution', async () => {
    const row = page.locator('.position-table tbody tr').filter({ hasText: 'BTC / USD' });
    await row.waitFor();
    await page.getByLabel('Order size in USD').fill('100');
    await ticket.getByRole('button', { name: 'Buy / Long BTC' }).click();
    await ticket.getByRole('button', { name: 'Awaiting execution…' }).waitFor({ timeout: 10_000 });
    assert.ok(await row.getByRole('button', { name: /Close/ }).isEnabled(), 'the Close button is disabled until the other order finishes (up to 90 s)');
  });

  await check('a funded order whose send response is lost is followed by its signature: reported executed, sent once', async () => {
    await ticket.getByRole('button', { name: 'Buy / Long BTC' }).waitFor({ timeout: 15_000 }); // the previous order finished
    const before = opens().length;
    let dropped = 0;
    await page.route(`${stub.url}/rpc`, async route => {
      if (dropped || !route.request().postData()?.includes('"sendTransaction"')) return route.continue();
      dropped += 1;
      await route.fetch(); // the node receives and forwards it...
      await route.abort('connectionreset'); // ...but the answer never reaches the browser
    });
    await ticket.getByRole('button', { name: 'Buy / Long BTC' }).click();
    await ticket.getByRole('button', { name: 'Awaiting execution…' }).waitFor({ timeout: 10_000 });
    await ticket.getByText('BTC long executed on the exchange.').waitFor({ timeout: 10_000 });
    await page.unroute(`${stub.url}/rpc`);
    assert.equal(dropped, 1, 'the send was not intercepted');
    assert.equal(opens().length, before + 1, 'the order was sent more or less than once');
  });

  await check('checkout builds no payment when the fee the API shows differs from the onchain tier', async () => {
    await page.route(`${stub.url}/v1/config`, async route => {
      const response = await route.fetch();
      const config = await response.json();
      route.fulfill({ response, json: { ...config, tiers: config.tiers.map(t => ({ ...t, feeUsdc: t.id === 1 ? '49' : t.feeUsdc })) } });
    });
    await page.goto(`${siteUrl}/#/checkout`);
    await page.reload();
    await page.getByText('fee or terms changed since the page loaded').waitFor({ timeout: 10_000 });
    await page.getByLabel(/I have read the evaluation rules/).check();
    assert.ok(await page.getByRole('button', { name: /Pay 49\.00 USDC/ }).isDisabled(), 'the Pay button is enabled for a fee the program would not charge');
    await page.unroute(`${stub.url}/v1/config`);
  });
  await context.close();
} finally {
  await browser.close();
  await new Promise(resolve => site.httpServer.close(resolve));
  stub.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
