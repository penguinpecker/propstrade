// Browser check of the production build (npm run test:e2e).
// 1. Renders every main route at 1920x1080 and 390x844 and fails on console errors, horizontal overflow or missing landmarks.
// 2. Drives wallet connect + Sign-In With Solana, account switch, expiry, rejection, disconnect, wrong network, no wallet,
//    and the footer's live-stream states.
// Test-only fixtures: the stub API/RPC server and the Wallet Standard test wallet below never ship with the app.
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(tmpdir(), 'props-app-e2e');
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM_ID = bs58.encode(randomBytes(32));
const ROUTES = ['/trade/funded', '/trade/evaluation', '/trade/practice', '/markets', '/get-funded', '/program', '/connect', '/checkout',
  '/payment', '/accounts', '/account/funded', '/account/evaluation', '/result', '/activate', '/performance', '/activity', '/payouts',
  '/payout/review', '/payout/receipt', '/verify', '/vault', '/settings'];
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// ---------- stub API + RPC ----------
const stub = { genesis: MAINNET_GENESIS, streamUp: true, streamDelayMs: 0, sessions: new Map(), nonces: new Map(), streams: new Set(), logouts: 0, signatures: 0 };
const me = wallet => ({ wallet, kyc: 'none', usdcBalance: '1234.5', solBalance: '0.25' });
const verifySignature = (wallet, message, signature) => verify(null, Buffer.from(message),
  createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, bs58.decode(wallet)]), format: 'der', type: 'spki' }), bs58.decode(signature));

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}
async function readJson(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

const api = createServer(async (req, res) => {
  if (req.headers.origin) {
    res.setHeader('access-control-allow-origin', req.headers.origin);
    res.setHeader('access-control-allow-credentials', 'true');
  }
  if (req.method === 'OPTIONS') {
    // Echo requested headers: @solana/web3.js adds a solana-client header, which real RPC providers allow.
    res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT, DELETE', 'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '' });
    return res.end();
  }
  const body = await readJson(req);
  const cookie = /props_session=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
  const wallet = cookie && stub.sessions.get(cookie);
  switch (`${req.method} ${req.url.split('?')[0]}`) {
    case 'POST /rpc':
      return send(res, 200, { jsonrpc: '2.0', id: body.id, result: stub.genesis });
    case 'GET /v1/config':
      return send(res, 200, { cluster: 'mainnet-beta', programId: PROGRAM_ID, usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        gmtradeStore: 'CTDLvGGXnoxvqLyTpGzdGLg9pD6JexKxKXSV8tqqo8bN', tiers: [], traderShareBps: 8000, minPayoutUsdc: '50',
        paused: { newEvaluations: false, trading: false, payouts: false }, feeVault: PROGRAM_ID, capitalVault: PROGRAM_ID });
    case 'POST /v1/auth/nonce': {
      const nonce = randomBytes(8).toString('hex');
      stub.nonces.set(nonce, body.wallet);
      return send(res, 200, { message: `127.0.0.1 wants you to sign in with your Solana account:\n${body.wallet}\n\nNonce: ${nonce}`, nonce, expiresAt: Date.now() + 300_000 });
    }
    case 'POST /v1/auth/verify': {
      const nonce = /Nonce: (\w+)/.exec(body.message)?.[1];
      const valid = stub.nonces.get(nonce) === body.wallet && verifySignature(body.wallet, body.message, body.signature);
      stub.nonces.delete(nonce);
      if (!valid) return send(res, 401, { error: { code: 'bad_signature', message: 'The signature did not verify.' } });
      const session = randomBytes(16).toString('hex');
      stub.sessions.set(session, body.wallet);
      // Same body as the real server: the profile itself comes from /v1/me.
      return send(res, 200, { wallet: body.wallet, expiresAt: Date.now() + 7 * 86_400_000 }, { 'set-cookie': `props_session=${session}; HttpOnly; SameSite=Lax; Path=/` });
    }
    case 'POST /v1/auth/logout':
      stub.logouts += 1;
      stub.sessions.delete(cookie);
      return send(res, 204, undefined, { 'set-cookie': 'props_session=; Max-Age=0; Path=/' });
    case 'GET /v1/me':
      return wallet ? send(res, 200, me(wallet)) : send(res, 401, { error: { code: 'unauthorized', message: 'Sign in required.' } });
    case 'GET /v1/stream': {
      if (!stub.streamUp) return send(res, 503, { error: { code: 'unavailable', message: 'Stream down.' } });
      if (stub.streamDelayMs) await new Promise(resolve => setTimeout(resolve, stub.streamDelayMs)); // a slow cold start
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const beat = () => res.write(`data: ${JSON.stringify({ type: 'heartbeat', ts: Date.now() })}\n\n`);
      beat();
      const timer = setInterval(beat, 2_000);
      stub.streams.add(res);
      req.on('close', () => { clearInterval(timer); stub.streams.delete(res); });
      return;
    }
    default:
      return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
  }
});
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

// ---------- Wallet Standard test wallet (runs in the page) ----------
function installTestWallet(accounts) {
  const chains = ['solana:mainnet'];
  const standardAccounts = accounts.map(({ address, publicKey }) =>
    Object.freeze({ address, publicKey: new Uint8Array(publicKey), chains, features: ['solana:signMessage', 'solana:signTransaction'] }));
  const listeners = new Set();
  let current = 0, connected = false, rejectNextSign = false;
  const wallet = {
    version: '1.0.0',
    name: 'Props Test Wallet',
    icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#8552cc"/></svg>'),
    chains,
    get accounts() { return connected ? [standardAccounts[current]] : []; },
    features: {
      // Like a locked or untrusted wallet: silent (page-load) connects are refused, interactive ones approved.
      'standard:connect': { version: '1.0.0', connect: async input => {
        if (input?.silent) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        connected = true;
        return { accounts: wallet.accounts };
      } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { connected = false; } },
      'standard:events': { version: '1.0.0', on: (event, listener) => { listeners.add(listener); return () => listeners.delete(listener); } },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async ({ account, message }) => {
          if (rejectNextSign) { rejectNextSign = false; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
          return [{ signedMessage: message, signature: new Uint8Array(await window.__testWalletSign(account.address, [...message])) }];
        },
      },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async () => { throw new Error('Not used in this test.'); } },
    },
  };
  window.__testWallet = {
    switchAccount() { current = 1 - current; listeners.forEach(listener => listener({ accounts: wallet.accounts })); },
    rejectNextSign() { rejectNextSign = true; },
  };
  // Wallet Standard registration protocol (same as @wallet-standard/wallet registerWallet).
  const register = ({ register }) => register(wallet);
  window.addEventListener('wallet-standard:app-ready', ({ detail }) => register(detail));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
}

const keys = [generateKeyPairSync('ed25519'), generateKeyPairSync('ed25519')].map(({ publicKey, privateKey }) => {
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519_PREFIX.length);
  return { address: bs58.encode(raw), publicKey: [...raw], privateKey };
});
const short = address => `${address.slice(0, 4)}…${address.slice(-4)}`;

// ---------- build + serve the app against the stub ----------
Object.assign(process.env, { VITE_API_URL: apiUrl, VITE_RPC_URL: `${apiUrl}/rpc`, VITE_CLUSTER: 'mainnet-beta', VITE_PROGRAM_ID: PROGRAM_ID });
await build({ root: appDir, logLevel: 'error', build: { outDir, emptyOutDir: true } });
const site = await preview({ root: appDir, logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: 4198 } });
const siteUrl = site.resolvedUrls.local[0].replace(/\/$/, '');

// Expected console noise, all caused on purpose by the stub: anonymous /v1/me (401) and the stream outage (503).
const expected = msg => /status of 401/.test(msg.text()) && msg.location().url.endsWith('/v1/me')
  || /503|ERR_INCOMPLETE_CHUNKED_ENCODING/.test(msg.text()) && (msg.location().url.endsWith('/v1/stream') || /EventSource/.test(msg.text()));
function watchConsole(page) {
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error' && !expected(msg)) errors.push(msg.text()); });
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name}\n     ${error.message.split('\n').slice(0, 4).join('\n     ')}`); }
}

try {
  // ---------- 1. every route, two viewports ----------
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = watchConsole(page);
    for (const route of ROUTES) {
      await check(`${viewport.width}x${viewport.height} ${route}`, async () => {
        await page.goto('about:blank');
        await page.goto(`${siteUrl}/#${route}`);
        await page.locator('#main > *').first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(250);
        for (const selector of ['header.app-header', 'nav[aria-label="Main navigation"]', 'main#main', 'footer.app-footer'])
          assert.equal(await page.locator(selector).count(), 1, `missing landmark ${selector}`);
        assert.ok(await page.getByRole('main').isVisible(), 'main is not visible');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `horizontal overflow of ${overflow}px`);
        const found = errors.splice(0);
        assert.equal(found.length, 0, `console errors: ${found.join(' | ')}`);
      });
    }
    await context.close();
  }

  await check('production build has no screen index', async () => {
    const page = await browser.newPage();
    await page.goto(`${siteUrl}/#/screens`);
    await page.getByRole('heading', { name: 'This page has moved.' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Screen index' }).count(), 0);
    await page.close();
  });

  // ---------- 2. wallet + session ----------
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.exposeFunction('__testWalletSign', (address, bytes) => {
    stub.signatures += 1;
    return [...sign(null, Buffer.from(bytes), keys.find(k => k.address === address).privateKey)];
  });
  await context.addInitScript(installTestWallet, keys.map(({ address, publicKey }) => ({ address, publicKey })));
  const page = await context.newPage();
  const errors = watchConsole(page);
  const walletButton = page.locator('.wallet-button');
  const dialog = page.getByRole('dialog');

  await check('connect + sign in from the Connect page continues to checkout', async () => {
    await page.goto(`${siteUrl}/#/connect`);
    await page.getByRole('button', { name: /Props Test Wallet/ }).click();
    await page.waitForURL('**/#/checkout');
    await page.getByText(`Props Test Wallet · ${short(keys[0].address)}`).waitFor();
    await page.getByText('Your USDC balance covers this payment').waitFor(); // /v1/me says 1,234.50 USDC
    assert.equal(await walletButton.innerText(), short(keys[0].address));
    assert.equal(stub.sessions.size, 1);
  });

  await check('wallet dialog shows the /v1/me balance', async () => {
    await walletButton.click();
    await dialog.getByText('$1,234.50').waitFor();
    await page.keyboard.press('Escape');
  });

  await check('a refused silent reconnect stays quiet, and reconnecting reuses the session without signing', async () => {
    const before = stub.signatures;
    await page.reload();
    await walletButton.getByText('Connect wallet').waitFor();
    await walletButton.click();
    await dialog.getByText('Signing in proves this wallet is yours.').waitFor();
    await dialog.getByRole('button', { name: /Props Test Wallet/ }).click();
    await walletButton.getByText(short(keys[0].address)).waitFor();
    assert.equal(stub.signatures, before);
    await page.keyboard.press('Escape');
  });

  await check('footer shows the live stream state', async () => {
    await page.locator('.app-footer').getByText('Live data connected').waitFor();
  });

  await check('an account switch in the wallet ends the old session', async () => {
    await page.evaluate(() => window.__testWallet.switchAccount());
    await walletButton.getByText('Sign in').waitFor();
    await expectEventually(() => stub.sessions.size === 0, 'old session was not logged out');
    await walletButton.click();
    await dialog.getByText('Your wallet switched accounts').waitFor();
    await dialog.getByRole('button', { name: 'Sign in' }).click();
    await walletButton.getByText(short(keys[1].address)).waitFor();
    await page.keyboard.press('Escape');
  });

  await check('an expired session is detected and explained', async () => {
    stub.sessions.clear();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await walletButton.getByText('Sign in').waitFor();
    await walletButton.click();
    await dialog.getByText('Your session expired').waitFor();
  });

  await check('a declined signature is explained and nothing is signed', async () => {
    const before = stub.signatures;
    await page.evaluate(() => window.__testWallet.rejectNextSign());
    await dialog.getByRole('button', { name: 'Sign in' }).click();
    await dialog.getByRole('status').getByText('The request was declined in your wallet.').waitFor(); // announced
    assert.equal(stub.signatures, before);
    assert.equal(stub.sessions.size, 0);
  });

  await check('Settings shows the session and disconnects it', async () => {
    await dialog.getByRole('button', { name: 'Sign in' }).click();
    await walletButton.getByText(short(keys[1].address)).waitFor();
    await page.keyboard.press('Escape');
    await page.goto(`${siteUrl}/#/settings`);
    await page.getByRole('button', { name: 'Wallet & session' }).click();
    await page.locator('.session-card').getByText('Signed in').waitFor();
    await page.getByRole('button', { name: 'Disconnect wallet' }).click();
    await walletButton.getByText('Connect wallet').waitFor();
    assert.equal(stub.sessions.size, 0);
  });

  await check('stream outage: reconnecting, offline, trading paused, then recovery', async () => {
    await page.goto(`${siteUrl}/#/trade/practice`);
    const footer = page.locator('.app-footer');
    await footer.getByText('Live data connected').waitFor();
    stub.streamUp = false;
    for (const res of stub.streams) res.destroy();
    await footer.getByText('Reconnecting to live data…').waitFor();
    await footer.getByText('Offline · retrying').waitFor({ timeout: 10_000 });
    assert.ok(await page.locator('.order-submit').first().isDisabled(), 'orders can be submitted while offline');
    await page.getByText('Price updates paused').first().waitFor();
    stub.streamUp = true;
    await footer.getByText('Live data connected').waitFor({ timeout: 15_000 });
  });

  await check('a slow stream start waits for prices without calling them paused', async () => {
    stub.streamDelayMs = 3_000;
    await page.reload();
    const footer = page.locator('.app-footer');
    await footer.getByText('Connecting to live data…').waitFor();
    await page.getByText('Waiting for live prices before you can submit.').first().waitFor();
    assert.ok(await page.locator('.order-submit').first().isDisabled(), 'orders can be submitted before prices arrive');
    assert.equal(await page.getByText('Price updates paused').count(), 0, 'a first connection is shown as paused');
    await footer.getByText('Live data connected').waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText('Waiting for live prices before you can submit.').count(), 0);
    stub.streamDelayMs = 0;
  });

  await check('no unexpected console errors during the wallet flows', async () => {
    const found = errors.splice(0);
    assert.equal(found.length, 0, `console errors: ${found.join(' | ')}`);
  });

  await check('wrong network blocks sign-in', async () => {
    stub.genesis = DEVNET_GENESIS;
    const before = stub.signatures;
    const fresh = await context.newPage();
    const freshErrors = watchConsole(fresh);
    await fresh.goto(`${siteUrl}/#/connect`);
    await fresh.getByText('The Solana connection is not on Solana mainnet').waitFor();
    await fresh.getByRole('button', { name: /Props Test Wallet/ }).click();
    await fresh.locator('.wallet-button').getByText('Sign in').waitFor();
    await fresh.waitForTimeout(500);
    assert.equal(stub.signatures, before, 'a message was signed on the wrong network');
    assert.equal(freshErrors.length, 0, `console errors: ${freshErrors.join(' | ')}`);
    stub.genesis = MAINNET_GENESIS;
    await fresh.close();
  });
  await context.close();

  await check('no wallet installed', async () => {
    const bare = await browser.newPage();
    await bare.goto(`${siteUrl}/#/connect`);
    await bare.getByText('No Solana wallet was found in this browser.').waitFor();
    const [amber, neutral] = await bare.evaluate(() => ['.notice.amber', '.notice.neutral'].map(s => getComputedStyle(document.querySelector(s)).backgroundColor));
    assert.notEqual(amber, neutral, 'warning notices look like info notices in the dark theme');
    await bare.goto(`${siteUrl}/#/checkout`);
    await bare.getByText('No wallet connected').waitFor();
    assert.equal(await bare.getByText('balance covers this payment').count(), 0, 'balance check shown without a balance');
    await bare.close();
  });
} finally {
  await browser.close();
  await new Promise(resolve => site.httpServer.close(resolve));
  for (const res of stub.streams) res.destroy();
  api.close();
}

async function expectEventually(predicate, message, timeout = 5_000) {
  for (const start = Date.now(); Date.now() - start < timeout;) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
