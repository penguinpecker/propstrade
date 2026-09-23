// Threat-model review (node tests/siws.review.e2e.mjs): the app must not ask the wallet to sign a sign-in message for
// another site. The message comes from the API (POST /v1/auth/nonce), and the app checks only that it names the wallet
// (src/lib/session.ts), so an API that is compromised or misconfigured can obtain the trader's signature over a
// Sign-In With Solana message for another domain and sign in there as the trader.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { PROGRAM_ID, startStub } from './stub.mjs';
import { exposeSigner, installTestWallet, testKeys } from './wallet.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(tmpdir(), 'props-app-siws-review');
const stub = await startStub();
const [key] = testKeys(1);

Object.assign(process.env, { VITE_API_URL: stub.url, VITE_RPC_URL: `${stub.url}/rpc`, VITE_CLUSTER: 'mainnet-beta', VITE_PROGRAM_ID: PROGRAM_ID });
await build({ root: appDir, logLevel: 'error', build: { outDir, emptyOutDir: true } });
const site = await preview({ root: appDir, logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: 4196, strictPort: true } });
const siteUrl = site.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let failed = false;
try {
  const signed = [];
  const context = await browser.newContext();
  await exposeSigner(context, [key], (_address, bytes) => signed.push(Buffer.from(bytes).toString('utf8')));
  await context.addInitScript(installTestWallet, { accounts: [{ address: key.address, publicKey: key.publicKey }] });
  const page = await context.newPage();
  // The API answers the nonce request with a sign-in message for another site (it still names the wallet).
  await page.route('**/v1/auth/nonce', async (route) => {
    const { wallet } = route.request().postDataJSON();
    const now = new Date();
    const message = [
      'other-dapp.example wants you to sign in with your Solana account:', wallet, '', 'Sign in to Other Dapp.', '',
      'URI: https://other-dapp.example', 'Version: 1', 'Chain ID: mainnet', 'Nonce: 5f3c9a1e7b2d4c6a',
      `Issued At: ${now.toISOString()}`, `Expiration Time: ${new Date(now.getTime() + 300_000).toISOString()}`,
    ].join('\n');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message, nonce: '5f3c9a1e7b2d4c6a', expiresAt: now.getTime() + 300_000 }) });
  });
  await page.goto(`${siteUrl}/#/connect`);
  await page.getByRole('button', { name: /Props Test Wallet/ }).click();
  await page.waitForTimeout(4_000);
  const foreign = signed.filter((m) => m.startsWith('other-dapp.example wants you to sign in'));
  assert.equal(foreign.length, 0, `the wallet was asked to sign, and signed, a sign-in message for another site:\n${foreign[0]}`);
  console.log('PASS the app refuses a sign-in message for another site');
} catch (error) {
  failed = true;
  console.log(`FAIL the app refuses a sign-in message for another site\n     ${error.message.split('\n').join('\n     ')}`);
} finally {
  await browser.close();
  await new Promise((resolve) => site.httpServer.close(resolve));
  stub.close();
}
process.exit(failed ? 1 : 0);
