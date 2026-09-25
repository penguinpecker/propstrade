// Browser check of the production build (npm run test:e2e) against the test stub API + RPC (tests/stub.mjs), served with the
// Content-Security-Policy the Vercel middleware sends, so a console error from anything the policy blocks fails the check.
// 1. Renders every route at 1920x1080 and 390x844, signed in, in both themes (and signed out once), and fails on console
//    errors, horizontal overflow or missing landmarks.
// 2. Drives wallet connect + Sign-In With Solana, account switch, expiry, rejection, disconnect, wrong network, no wallet.
// 3. Drives the data and transaction flows: markets, live candles, a simulated order through fill and close, a funded
//    order built with @props/sdk, signed by the test wallet and sent to the stub RPC, checkout, payout request, verify,
//    vault, notifications, CSV export and the footer's live-stream states.
// 4. White label: no route or dialog names the venue (GMTrade) in its title, meta tags, text or labelling attributes.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { contentSecurityPolicy } from '../middleware.js';
import { MAINNET_GENESIS, PROGRAM_ID, startStub } from './stub.mjs';
import { exposeSigner, installTestWallet, testKeys } from './wallet.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(tmpdir(), 'props-app-e2e');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const ROUTES = ['/trade/funded', '/trade/evaluation', '/trade/practice', '/markets', '/get-funded', '/program', '/connect', '/checkout',
  '/payment', '/accounts', '/account/funded', '/account/evaluation', '/result', '/activate', '/performance', '/activity', '/payouts',
  '/payout/review', '/payout/receipt', '/search', '/vault', '/settings'];

const stub = await startStub();
const { state } = stub;
const keys = testKeys(4); // keys[3] never signs in or trades: the Search page's unknown trader
const publicAccounts = list => list.map(({ address, publicKey }) => ({ address, publicKey }));
const short = address => `${address.slice(0, 4)}…${address.slice(-4)}`;

// ---------- build + serve the app against the stub ----------
Object.assign(process.env, { VITE_API_URL: stub.url, VITE_RPC_URL: `${stub.url}/rpc`, VITE_CLUSTER: 'mainnet-beta', VITE_PROGRAM_ID: PROGRAM_ID });
await build({ root: appDir, logLevel: 'error', build: { outDir, emptyOutDir: true } });
const csp = contentSecurityPolicy(process.env);
const site = await preview({ root: appDir, logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: 4198, headers: { 'content-security-policy': csp } } });
const siteUrl = site.resolvedUrls.local[0].replace(/\/$/, '');

// Expected console noise, all caused on purpose by the stub: anonymous /v1/me (401), the stream outage (503), the
// candles of a saved market that is not in the catalog (404) and the exchange refusing a quoted order (422).
const expected = msg => /status of 401/.test(msg.text()) && msg.location().url.endsWith('/v1/me')
  || /503|ERR_INCOMPLETE_CHUNKED_ENCODING/.test(msg.text()) && (msg.location().url.endsWith('/v1/stream') || /EventSource/.test(msg.text()))
  || /status of 404/.test(msg.text()) && (msg.location().url.includes('/v1/candles?symbol=ZZZ') || msg.location().url.includes('/v1/traders/'))
  || /status of 422/.test(msg.text()) && msg.location().url.includes('/v1/quote?');
function watchConsole(page) {
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error' && !expected(msg)) errors.push(msg.text()); });
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}

/** A context whose wallet already trusts the site and holds a session cookie: signed in on first load. */
async function signedInContext(browser, key, options = {}) {
  const context = await browser.newContext(options);
  await exposeSigner(context, keys, () => { state.signatures += 1; });
  await context.addInitScript(installTestWallet, { accounts: publicAccounts([key]), trusted: true });
  await context.addInitScript(() => { if (location.protocol === 'http:') localStorage.setItem('walletName', '"Props Test Wallet"'); });
  const token = randomBytes(16).toString('hex');
  state.sessions.set(token, key.address);
  await context.addCookies([{ name: 'props_session', value: token, url: stub.url }]);
  return context;
}
const settle = page => page.waitForFunction(() => !document.querySelector('#main .spinner, #main .chart-skeleton'), null, { timeout: 8_000 }).catch(() => undefined);
/** Forgets the candles this browser saved (lib/candles.ts): a copy younger than staleTime is shown without a fetch. */
const forgetCandles = page => page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('props.candles.')) localStorage.removeItem(key); });
/** Where the page names the venue: the title, meta tags, rendered text, labelling attributes and link targets (white label). */
const brandLeaks = page => page.evaluate(() => {
  const hits = [];
  const test = (where, value) => { const at = value?.search(/gmtrade/i) ?? -1; if (at >= 0) hits.push(`${where}: …${value.slice(Math.max(0, at - 50), at + 50)}…`); };
  test('title', document.title);
  for (const meta of document.querySelectorAll('meta')) test(`meta ${meta.name || meta.getAttribute('property') || ''}`, meta.content);
  test('text', document.body.innerText);
  for (const el of document.querySelectorAll('[title], [aria-label], [aria-valuetext], [placeholder], [alt], [data-tip], a[href]'))
    for (const name of ['title', 'aria-label', 'aria-valuetext', 'placeholder', 'alt', 'data-tip', 'href']) test(`${el.tagName.toLowerCase()}[${name}]`, el.getAttribute(name));
  return hits;
});
/**
 * The x of a native range thumb's centre, measured in a screenshot: a band 4-7 px above the 4 px track's centre, which only
 * the 16 px thumb reaches. The first and last columns that differ from the band's left end bound its chord.
 */
async function thumbCenter(page, slider) {
  const box = await slider.boundingBox();
  const clip = { x: Math.floor(box.x) - 12, y: Math.round(box.y + box.height / 2) - 7, width: Math.ceil(box.width) + 24, height: 3 };
  const png = await page.screenshot({ clip });
  const [first, last] = await page.evaluate(async bytes => {
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const g = new OffscreenCanvas(image.width, image.height).getContext('2d');
    g.drawImage(image, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, image.width, image.height);
    const differs = (i, j) => Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]) > 90;
    const columns = [];
    for (let x = 0; x < width; x += 1) for (let y = 0; y < height; y += 1) if (differs((y * width + x) * 4, y * width * 4)) { columns.push(x); break; }
    return [columns[0], columns.at(-1)];
  }, [...png]);
  if (first === undefined) throw new Error('no thumb found above the track');
  return clip.x + (first + last + 1) / 2;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let failures = 0;
// While iterating: E2E_ONLY='funded|checkout' runs a subset; E2E_SHOTS=<dir> saves screenshots of failing checks.
const only = process.env.E2E_ONLY && new RegExp(process.env.E2E_ONLY);
async function check(name, fn) {
  if (only && !only.test(name)) return;
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; if (process.env.E2E_SHOTS) await Promise.all(browser.contexts().flatMap(c => c.pages()).map((p, i) => p.screenshot({ path: `${process.env.E2E_SHOTS}/fail-${name.replace(/\W+/g, '-').slice(0, 60)}-${i}.png` }).catch(() => undefined))); console.log(`FAIL ${name}\n     ${error.message.split('\n').slice(0, 4).join('\n     ')}`); }
}
async function expectEventually(predicate, message, timeout = 5_000) {
  for (const start = Date.now(); Date.now() - start < timeout;) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

try {
  // ---------- 1. every route: two viewports, both themes, signed in; and signed out once ----------
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 390, height: 844 }])
    for (const [theme, signedIn] of [['dark', true], ['light', true], ['dark', false]]) {
      const options = { viewport, reducedMotion: 'reduce' };
      const context = signedIn ? await signedInContext(browser, keys[2], options) : await browser.newContext(options);
      await context.addInitScript(t => { if (location.protocol === 'http:') localStorage.setItem('props.preferences', JSON.stringify({ fills: true, risk: true, payouts: true, density: 'Comfortable', currency: 'USD', motion: false, theme: t })); }, theme);
      const page = await context.newPage();
      const errors = watchConsole(page);
      for (const route of ROUTES) {
        await check(`${viewport.width}x${viewport.height} ${theme} ${signedIn ? 'signed in' : 'signed out'} ${route}`, async () => {
          await page.goto('about:blank');
          await page.goto(`${siteUrl}/#${route}`);
          await page.locator('#main > *').first().waitFor();
          await page.evaluate(() => document.fonts.ready);
          await settle(page);
          await page.waitForTimeout(200);
          for (const selector of ['header.app-header', 'nav[aria-label="Main navigation"]', 'main#main', 'footer.app-footer'])
            assert.equal(await page.locator(selector).count(), 1, `missing landmark ${selector}`);
          assert.ok(await page.getByRole('main').isVisible(), 'main is not visible');
          assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
          if (signedIn) assert.equal(await page.locator('.wallet-button').innerText(), short(keys[2].address), 'not signed in');
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(overflow <= 0, `horizontal overflow of ${overflow}px`);
          assert.deepEqual(await brandLeaks(page), [], 'the page names the venue');
          const found = errors.splice(0);
          assert.equal(found.length, 0, `console errors: ${found.join(' | ')}`);
        });
      }
      await context.close();
    }

  await check('the content security policy is enforced: the app runs under it and anything else is blocked', async () => {
    const page = await browser.newPage();
    const response = await page.goto(`${siteUrl}/#/markets`);
    assert.equal(response.headers()['content-security-policy'], csp);
    await page.locator('#main > *').first().waitFor();
    const blocked = await page.evaluate(async () => {
      const violation = new Promise(resolve => document.addEventListener('securitypolicyviolation', e => resolve(`${e.effectiveDirective} ${e.blockedURI}`), { once: true }));
      const fetched = await fetch('https://example.com/').then(() => 'fetched', () => 'refused');
      return [fetched, await violation];
    });
    assert.deepEqual(blocked, ['refused', 'connect-src https://example.com/']);
    await page.close();
  });

  await check('production build has no screen index', async () => {
    const page = await browser.newPage();
    await page.goto(`${siteUrl}/#/screens`);
    await page.getByRole('heading', { name: 'This page has moved.' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Screen index' }).count(), 0);
    await page.close();
  });

  // ---------- 2. wallet + session ----------
  {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await exposeSigner(context, keys, () => { state.signatures += 1; });
    await context.addInitScript(installTestWallet, { accounts: publicAccounts(keys.slice(0, 2)) });
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
      assert.equal([...state.sessions.values()].filter(w => w === keys[0].address).length, 1);
    });

    await check('wallet dialog shows the /v1/me balance', async () => {
      await walletButton.click();
      await dialog.getByText('$1,234.50').waitFor();
      await page.keyboard.press('Escape');
    });

    await check('a refused silent reconnect stays quiet, and reconnecting reuses the session without signing', async () => {
      const before = state.signatures;
      await page.reload();
      await walletButton.getByText('Connect wallet').waitFor();
      await walletButton.click();
      await dialog.getByText('Signing in proves this wallet is yours.').waitFor();
      await dialog.getByRole('button', { name: /Props Test Wallet/ }).click();
      await walletButton.getByText(short(keys[0].address)).waitFor();
      assert.equal(state.signatures, before);
      await page.keyboard.press('Escape');
    });

    await check('footer shows the live stream state', async () => {
      await page.locator('.app-footer').getByText('Live data connected').waitFor();
      assert.equal(await page.getByText(/illustrative|No live orders/i).count(), 0);
    });

    await check('an account switch in the wallet ends the old session', async () => {
      const sessions = () => [...state.sessions.values()].filter(w => w === keys[0].address).length;
      await page.evaluate(() => window.__testWallet.switchAccount());
      await walletButton.getByText('Sign in').waitFor();
      await expectEventually(() => sessions() === 0, 'old session was not logged out');
      await walletButton.click();
      await dialog.getByText('Your wallet switched accounts').waitFor();
      await dialog.getByRole('button', { name: 'Sign in' }).click();
      await walletButton.getByText(short(keys[1].address)).waitFor();
      await page.keyboard.press('Escape');
    });

    await check('an expired session is detected and explained', async () => {
      for (const [token, wallet] of state.sessions) if (wallet === keys[1].address) state.sessions.delete(token);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
      await walletButton.getByText('Sign in').waitFor();
      await walletButton.click();
      await dialog.getByText('Your session expired').waitFor();
    });

    await check('a declined signature is explained and nothing is signed', async () => {
      const before = state.signatures;
      await page.evaluate(() => window.__testWallet.rejectNextSign());
      await dialog.getByRole('button', { name: 'Sign in' }).click();
      await dialog.getByRole('status').getByText('The request was declined in your wallet.').waitFor(); // announced
      assert.equal(state.signatures, before);
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
      assert.equal([...state.sessions.values()].filter(w => w === keys[1].address).length, 0);
    });

    await check('no unexpected console errors during the wallet flows', async () => {
      const found = errors.splice(0);
      assert.equal(found.length, 0, `console errors: ${found.join(' | ')}`);
    });

    await check('wrong network blocks sign-in', async () => {
      state.genesis = DEVNET_GENESIS;
      const before = state.signatures;
      const fresh = await context.newPage();
      const freshErrors = watchConsole(fresh);
      await fresh.goto(`${siteUrl}/#/connect`);
      await fresh.getByText('The Solana connection is not on Solana mainnet').waitFor();
      await fresh.getByRole('button', { name: /Props Test Wallet/ }).click();
      await fresh.locator('.wallet-button').getByText('Sign in').waitFor();
      await fresh.waitForTimeout(500);
      assert.equal(state.signatures, before, 'a message was signed on the wrong network');
      assert.equal(freshErrors.length, 0, `console errors: ${freshErrors.join(' | ')}`);
      state.genesis = MAINNET_GENESIS;
      await fresh.close();
    });
    await context.close();
  }

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

  // ---------- 3. data and transactions, signed in as keys[0] ----------
  {
    const context = await signedInContext(browser, keys[0], { viewport: { width: 1920, height: 1080 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = watchConsole(page);
    const w = stub.walletData(keys[0].address);
    const main = page.locator('#main');
    const sent = name => state.sent.filter(s => s.name === name && s.wallet === keys[0].address);

    await check('markets: all rows, category tabs, search, availability, monograms and watchlist', async () => {
      await page.goto(`${siteUrl}/#/markets`);
      const rows = page.locator('.markets-table tbody tr');
      await rows.first().waitFor();
      assert.equal(await rows.count(), state.markets.length);
      await page.getByRole('tab', { name: 'Forex' }).click();
      assert.deepEqual(await rows.locator('strong').filter({ hasText: '/' }).allInnerTexts(), ['EUR / USD', 'USD / JPY']);
      await page.getByRole('tab', { name: 'All markets' }).click();
      await page.getByLabel('Search market directory').fill('doge');
      assert.equal(await rows.count(), 1);
      await rows.getByText('Not available for funded trading').waitFor();
      await page.getByLabel('Search market directory').fill('tao');
      assert.equal(await rows.locator('.market-icon').innerText(), 'TA');
      await page.getByRole('button', { name: 'Add TAO to watchlist' }).click();
      await page.getByLabel('Search market directory').fill('');
      await page.getByRole('tab', { name: 'Watchlist' }).click();
      await rows.getByText('TAO / USD').waitFor();
      await page.getByRole('tab', { name: 'Stocks' }).click();
      await rows.getByText('Closed').waitFor(); // NVDA outside its session
    });

    await check('market picker: category tabs, sub-category chips, search within them, the way out of an empty selection', async () => {
      await page.goto(`${siteUrl}/#/trade/funded`);
      await page.locator('.order-panel').waitFor();
      await page.keyboard.press('Control+k');
      const dialog = page.getByRole('dialog', { name: 'Find a market' });
      const search = dialog.getByLabel('Search markets');
      const rows = dialog.locator('.market-picker-list > .picker-row');
      const pairs = () => rows.locator('strong').filter({ hasText: '/' }).allInnerTexts();
      const tab = name => dialog.getByRole('tab', { name: new RegExp(`^${name}`) });
      const chips = dialog.getByRole('group', { name: /sub-categories$/ }).getByRole('button');
      const focused = () => page.evaluate(() => document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent);
      await rows.first().waitFor();
      assert.equal(await focused(), 'Search markets', '⌘K focuses the search field');
      assert.equal(await tab('All').getAttribute('aria-selected'), 'true');
      assert.equal(await rows.count(), state.markets.length);
      assert.deepEqual(await Promise.all(['All', 'Crypto', 'Commodities', 'Forex', 'Stocks'].map(t => tab(t).locator('.quiet').innerText())), ['10', '5', '1', '2', '2']);
      assert.equal(await chips.count(), 0, 'All has no sub-categories');
      await tab('Crypto').click();
      assert.deepEqual([await tab('Crypto').getAttribute('aria-selected'), await tab('All').getAttribute('aria-selected')], ['true', 'false']);
      assert.deepEqual(await chips.allTextContents(), ['All Crypto 5', 'Layer 1 & 2 3', 'Meme 1', 'Other 1']);
      assert.equal(await chips.first().getAttribute('aria-pressed'), 'true');
      await search.fill('coin');
      assert.deepEqual(await pairs(), ['BTC / USD', 'DOGE / USD']);
      await chips.filter({ hasText: 'Meme' }).click();
      assert.deepEqual([await chips.filter({ hasText: 'Meme' }).getAttribute('aria-pressed'), await chips.first().getAttribute('aria-pressed')], ['true', 'false']);
      assert.deepEqual(await pairs(), ['DOGE / USD']);
      // Keyboard only: the tabs are one Tab stop (the selected tab) where the arrow keys, Home and End select; Tab then
      // reaches the chips and Space presses one. Focus stays on what was operated.
      await search.fill('');
      await page.keyboard.press('Tab');
      assert.match(await focused(), /^Crypto/);
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowRight');
      assert.match(await focused(), /^All/, 'the arrow keys wrap');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await tab('Stocks').getAttribute('aria-selected'), 'true');
      assert.match(await focused(), /^Stocks/);
      assert.deepEqual(await chips.allTextContents(), ['All Stocks 2', 'Companies 1', 'Index ETFs 1']);
      for (let i = 0; i < 3; i += 1) await page.keyboard.press('Tab');
      assert.match(await focused(), /^Index ETFs/);
      await page.keyboard.press('Space');
      assert.equal(await chips.filter({ hasText: 'Index ETFs' }).getAttribute('aria-pressed'), 'true');
      assert.deepEqual(await pairs(), ['SPY / USD']);
      // A search with no match here but matches elsewhere says so (a live region: announced while focus stays in the search),
      // and one click searches every market.
      await search.fill('btc');
      await dialog.getByRole('status').getByRole('heading', { name: 'No match in Stocks › Index ETFs' }).waitFor();
      await dialog.getByText('“btc” matches 1 market elsewhere.').waitFor();
      await dialog.getByRole('button', { name: 'Search all markets' }).click();
      assert.equal(await tab('All').getAttribute('aria-selected'), 'true');
      assert.deepEqual(await pairs(), ['BTC / USD']);
      assert.equal(await focused(), 'Search markets', 'focus returns to the search field');
      await search.fill('nothing like this');
      await dialog.getByRole('heading', { name: 'No matching market' }).waitFor();
      // The last tab is remembered on reopen; the chip and the search start over.
      await tab('Crypto').click();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await page.keyboard.press('Control+k');
      assert.equal(await tab('Crypto').getAttribute('aria-selected'), 'true');
      assert.deepEqual([await chips.first().getAttribute('aria-pressed'), await search.inputValue(), await focused()], ['true', '', 'Search markets']);
      // Phone width: the tabs scroll inside the dialog (the chips do too once they are wider), never the page.
      await page.setViewportSize({ width: 390, height: 844 });
      try {
        const [pageOverflow, dialogOverflow, tabsOverflow] = await page.evaluate(() => [document.documentElement, document.querySelector('dialog'), document.querySelector('.picker-tabs')].map(el => el.scrollWidth - el.clientWidth));
        assert.ok(pageOverflow <= 0 && dialogOverflow <= 0, `page / dialog overflow ${pageOverflow} / ${dialogOverflow}px`);
        assert.ok(tabsOverflow > 0, 'the tabs do not scroll');
        await tab('Stocks').click();
        assert.deepEqual(await pairs(), ['NVDA / USD', 'SPY / USD']);
      } finally {
        await page.setViewportSize({ width: 1920, height: 1080 });
      }
      // A short window: the list gives up height so the dialog never scrolls (its title and Close stay in view), and every
      // new selection opens at its first market. [scrollTop, list scrolls]: the list must scroll for its 0 to mean anything.
      await page.setViewportSize({ width: 1366, height: 520 });
      try {
        const list = dialog.locator('.market-picker-list');
        const position = () => list.evaluate(l => [l.scrollTop, l.scrollHeight > l.clientHeight]);
        const toEnd = () => list.evaluate(l => { l.scrollTop = l.scrollHeight; });
        await tab('All').click();
        await toEnd();
        await tab('Crypto').click();
        assert.deepEqual(await position(), [0, true], 'a new tab opens at its top');
        assert.equal(await page.evaluate(() => { const d = document.querySelector('dialog'); return d.scrollHeight - d.clientHeight; }), 0, 'the dialog scrolls');
        await toEnd();
        await chips.filter({ hasText: 'Layer 1 & 2' }).click();
        // Its three markets fit this window since the rows got compact, so only the position is left to check.
        assert.equal((await position())[0], 0, 'a new chip opens at its top');
      } finally {
        await page.setViewportSize({ width: 1920, height: 1080 });
      }
      await tab('All').click();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      // Closing hands focus back to what opened the dialog.
      await page.locator('.search-trigger').click();
      await rows.first().waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.activeElement.className), 'search-trigger');
    });

    await check('watchlist: the bar\'s + opens the picker on All, a star adds a market without choosing it or closing, the bar follows, a reload keeps it, the markets page removes it', async () => {
      await page.goto(`${siteUrl}/#/trade/funded`);
      const bar = page.locator('.watchlist-bar');
      const inBar = symbol => bar.getByRole('button', { name: new RegExp(`^${symbol}`) });
      const dialog = page.getByRole('dialog', { name: 'Find a market' });
      const tab = name => dialog.getByRole('tab', { name: new RegExp(`^${name}`) });
      const watchlistCount = async () => Number(await tab('Watchlist').locator('.quiet').innerText());
      const heading = () => page.locator('.market-select strong').innerText();
      await inBar('BTC').waitFor();
      assert.equal(await inBar('EUR').count(), 0);
      // The remembered tab is Crypto; the + still opens on All, where markets can be added, and Crypto stays remembered.
      await page.keyboard.press('Control+k');
      await tab('Crypto').click();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await bar.getByRole('button', { name: 'Add a market to your watchlist' }).click();
      assert.equal(await tab('All').getAttribute('aria-selected'), 'true', 'the + did not open the picker on All');
      const [before, shown] = [await watchlistCount(), await heading()];
      await dialog.getByRole('button', { name: 'Add EUR to watchlist' }).click();
      await dialog.getByRole('button', { name: 'Remove EUR from watchlist' }).waitFor();
      assert.deepEqual([await watchlistCount(), await heading()], [before + 1, shown], 'the star did not only star');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await inBar('EUR').waitFor();
      await page.keyboard.press('Control+k');
      assert.equal(await tab('Crypto').getAttribute('aria-selected'), 'true', 'the + replaced the remembered tab');
      await tab('Watchlist').click();
      await dialog.locator('.market-picker-list > .picker-row').getByText('EUR / USD').waitFor();
      await tab('All').click(); // remembered, for the checks that open the picker next
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await page.reload();
      await inBar('EUR').waitFor();
      await page.goto(`${siteUrl}/#/markets`);
      await page.getByRole('button', { name: 'Remove EUR from watchlist' }).click();
      await page.getByRole('button', { name: 'Add EUR to watchlist' }).waitFor();
      await page.goto(`${siteUrl}/#/trade/funded`);
      await inBar('BTC').waitFor();
      assert.equal(await inBar('EUR').count(), 0, 'EUR is still in the watchlist bar');
    });

    await check('chart: candles, OHLC of the last candle, and live ticks move it', async () => {
      await page.goto(`${siteUrl}/#/trade/practice`);
      await page.locator('.price-chart canvas').first().waitFor();
      await page.mouse.move(0, 0); // no crosshair: the legend shows the latest candle
      const legend = page.locator('.tv-legend-main');
      await legend.getByText('C64,482.00').waitFor();
      stub.publish({ type: 'price', ticks: [{ symbol: 'BTC', min: '64600', max: '64600', mid: '64600', ts: Date.now() + 1_000, session: 'open' }] });
      await legend.getByText('C64,600.00').waitFor();
      await page.locator('.market-price').getByText('64,600.00').waitFor();
      for (const interval of ['5m', '4h', '1D', '1h']) { // back to 1h: the interval is kept in the browser now, and the checks below expect 1h
        await page.locator('.timeframes').getByRole('button', { name: interval, exact: true }).click();
        await legend.getByText(`BTC / USD · ${interval} · Props.trade`).waitFor();
      }
      state.markets.find(m => m.symbol === 'BTC').price = '64600.00';
    });

    await check('chart: indicators from the dialog, a drawing kept for the market, a range that picks its interval', async () => {
      await page.goto(`${siteUrl}/#/trade/practice`);
      await page.locator('.price-chart canvas').first().waitFor();
      await page.getByRole('button', { name: 'Indicators', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Indicators' });
      await dialog.getByText(/no trading volume/).waitFor();
      await dialog.getByLabel('Search indicators').fill('rsi');
      await dialog.getByRole('button', { name: /^Relative Strength Index/ }).click();
      await dialog.getByLabel('Search indicators').fill('');
      await dialog.getByRole('button', { name: /^Moving Average/ }).click();
      await page.keyboard.press('Escape');
      await page.locator('.tv-pane-legend').getByText('RSI 14').waitFor();
      await page.locator('.tv-legend').getByText('MA 20').waitFor();
      await page.getByRole('button', { name: 'Line tools' }).click();
      await page.getByRole('menuitemradio', { name: 'Horizontal line' }).click();
      const plot = await page.locator('.price-chart').boundingBox();
      await page.mouse.click(plot.x + plot.width / 2, plot.y + plot.height / 5);
      await page.reload();
      await page.locator('.price-chart canvas').first().waitFor();
      await page.getByRole('button', { name: 'Remove all drawings (1)' }).waitFor();
      await page.locator('.tv-pane-legend').getByText('RSI 14').waitFor();
      await page.getByRole('button', { name: /^1y:/ }).click();
      await page.locator('.tv-legend-main').getByText('BTC / USD · 1D · Props.trade').waitFor();
      await page.locator('.timeframes').getByRole('button', { name: '1h', exact: true }).click();
      await page.locator('.tv-legend-main').getByText('BTC / USD · 1h · Props.trade').waitFor();
    });

    await check('chart at 1366x768: it stays in its row, every drawing tool can be reached, the saved-copy note is whole, and Delete only acts with focus in the chart', async () => {
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.route('**/v1/candles?**', async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), freshness: 'delayed' } }); });
      try {
        await page.goto(`${siteUrl}/#/trade/practice`);
        await forgetCandles(page);
        await page.reload(); // the same URL does not reload the app, and the candles must come through the route
        await page.locator('.chart-section .price-chart canvas').first().waitFor();
        const [bottom, positions] = await Promise.all([page.locator('.chart-section .tv-bottom').boundingBox(), page.locator('.positions-panel').boundingBox()]);
        assert.ok(bottom.y + bottom.height <= positions.y + 0.5, `the chart's bottom bar ends ${Math.round(bottom.y + bottom.height - positions.y)}px inside the positions panel`);
        const source = page.locator('.chart-section .tv-source');
        await source.getByText('saved copy while the charts recover').waitFor();
        assert.equal(await source.evaluate(el => el.scrollWidth - el.clientWidth), 0, 'the saved-copy note is cut short');
        const until = async (predicate, message) => { for (const start = Date.now(); Date.now() - start < 5_000; await page.waitForTimeout(50)) if (await predicate()) return; throw new Error(message); };
        const toolbar = page.locator('.chart-section .tv-drawbar-tools');
        // A horizontal line placed here is selected: a Backspace after pressing elsewhere on the page keeps it, a Delete after pressing it on the chart removes it.
        const count = async () => Number(/\((\d+)\)/.exec(await toolbar.getByRole('button', { name: /^Remove all drawings/ }).getAttribute('aria-label'))?.[1] ?? 0);
        const before = await count();
        await page.locator('.chart-section').getByRole('button', { name: 'Line tools' }).click();
        await page.getByRole('menuitemradio', { name: 'Horizontal line' }).click();
        const plot = await page.locator('.chart-section .price-chart').boundingBox();
        const at = [plot.x + plot.width / 3, plot.y + plot.height / 3];
        await page.mouse.click(...at);
        await until(async () => await count() === before + 1, 'the line was not placed');
        await page.locator('.market-price').click();
        await page.keyboard.press('Backspace');
        assert.equal(await count(), before + 1, 'a Backspace pressed outside the chart removed its drawing');
        await page.mouse.click(...at);
        await page.keyboard.press('Delete');
        await until(async () => await count() === before, 'Delete did not remove the drawing selected on the chart');
        // The lower tools sit below the fold at this height; the arrow at the toolbar's foot brings them in.
        const inView = name => Promise.all([toolbar.boundingBox(), toolbar.getByRole('button', { name, exact: true }).boundingBox()]).then(([bar, button]) => button.y >= bar.y - 0.5 && button.y + button.height <= bar.y + bar.height + 0.5);
        assert.equal(await inView('Hide all drawings'), false, 'expected the lower tools below the fold at this height');
        await page.locator('.chart-section .tv-drawbar-scroll.down').click();
        await until(() => inView('Hide all drawings'), 'the scroll arrow did not bring the lower tools into view');
      } finally {
        await page.unroute('**/v1/candles?**');
        await page.setViewportSize({ width: 1920, height: 1080 });
      }
    });

    await check('chart: the saved market\'s candles and the chart\'s code are asked for before the catalog answers; a saved market that left the catalog falls back to BTC', async () => {
      await page.goto(`${siteUrl}/#/trade/practice`);
      await page.evaluate(() => localStorage.setItem('props.market', '"ETH"'));
      await forgetCandles(page);
      await page.goto('about:blank');
      let candlesFor; let chartCode;
      const candles = new Promise(resolve => { candlesFor = resolve; });
      const chart = new Promise(resolve => { chartCode = resolve; });
      const seen = request => { const url = new URL(request.url()); if (url.pathname === '/v1/candles') candlesFor(url.searchParams.get('symbol')); else if (/\/Chart-[^/]*\.js$/.test(url.pathname)) chartCode(); };
      page.on('request', seen);
      // The catalog answers only once both were asked for: a chart that waited for it would wait forever here.
      await page.route('**/v1/markets', async route => { await Promise.all([candles, chart]); await route.continue(); });
      try {
        await page.goto(`${siteUrl}/#/trade/practice`);
        await page.locator('.tv-legend-main').getByText('ETH / USD · 1h · Props.trade').waitFor({ timeout: 8_000 });
        assert.equal(await candles, 'ETH');
        await page.evaluate(() => localStorage.setItem('props.market', '"ZZZ"'));
        await page.reload();
        await page.locator('.tv-legend-main').getByText('BTC / USD · 1h · Props.trade').waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem('props.market')), '"BTC"');
      } finally {
        page.off('request', seen);
        await page.unroute('**/v1/markets');
      }
    });

    await check('removed markets: a watched market the catalog no longer lists leaves the watchlist (a saved chart market falls back to BTC, above)', async () => {
      await page.goto(`${siteUrl}/#/trade/practice`);
      await page.evaluate(() => localStorage.setItem('props.favorites', JSON.stringify(['BTC', 'ZZZ', 'ETH', 'SOL', 'XAU'])));
      await page.reload();
      await page.locator('.watchlist-bar').getByRole('button', { name: /^XAU/ }).waitFor();
      await page.waitForFunction(() => !JSON.parse(localStorage.getItem('props.favorites') ?? '[]').includes('ZZZ'), null, { timeout: 5_000 });
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('props.favorites'))), ['BTC', 'ETH', 'SOL', 'XAU']);
    });

    await check('watchlist across tabs and the tab title: a star in one tab shows in the other without a reload, a star there keeps it; the tab reads the market and its price, and the page title comes back off the terminal', async () => {
      await page.goto(`${siteUrl}/#/trade/practice`);
      const before = await page.evaluate(() => localStorage.getItem('props.favorites'));
      const other = await page.context().newPage();
      try {
        await other.goto(`${siteUrl}/#/trade/practice`);
        const inBar = (p, symbol) => p.locator('.watchlist-bar').getByRole('button', { name: new RegExp(`^${symbol}`) });
        const star = async (p, symbol) => {
          await p.locator('.watchlist-bar').getByRole('button', { name: 'Add a market to your watchlist' }).click();
          const dialog = p.getByRole('dialog', { name: 'Find a market' });
          await dialog.getByRole('button', { name: `Add ${symbol} to watchlist` }).click();
          await dialog.getByRole('button', { name: `Remove ${symbol} from watchlist` }).waitFor();
          await p.keyboard.press('Escape');
          await dialog.waitFor({ state: 'detached' });
        };
        await inBar(page, 'BTC').waitFor();
        await inBar(other, 'BTC').waitFor();
        await star(page, 'EUR');
        await inBar(other, 'EUR').waitFor({ timeout: 5_000 });
        await star(other, 'NVDA');
        await inBar(page, 'NVDA').waitFor({ timeout: 5_000 });
        assert.equal(await inBar(page, 'EUR').count(), 1, "the other tab's star saved its older list over EUR");
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('props.favorites')));
        assert.ok(saved.includes('EUR') && saved.includes('NVDA'), `saved watchlist ${saved}`);

        const shown = (await page.locator('.market-select strong').innerText()).split(' / ')[0];
        await page.waitForFunction(symbol => new RegExp(`^${symbol} [0-9,.]+ — Props\\.trade$`).test(document.title), shown, { timeout: 5_000 });
        await inBar(page, 'EUR').click();
        await page.waitForFunction(() => /^EUR [0-9,.]+ — Props\.trade$/.test(document.title), null, { timeout: 5_000 });
        await page.goto(`${siteUrl}/#/accounts`);
        await page.waitForFunction(() => document.title === 'Props.trade — Trading workspace', null, { timeout: 5_000 });
      } finally {
        await other.close();
        await page.evaluate(value => value === null ? localStorage.removeItem('props.favorites') : localStorage.setItem('props.favorites', value), before);
      }
    });

    await check('chart: the watchlist\'s candles load right after this market\'s, once per interval and not on ticks, so a watchlist click paints from memory', async () => {
      const asked = []; // the chart's own candle queries; the older history it loads as the view nears its first candle (`from`) is not one
      const seen = request => { const url = new URL(request.url()); if (url.pathname === '/v1/candles' && !url.searchParams.has('from')) asked.push(`${url.searchParams.get('symbol')} ${url.searchParams.get('interval')}`); };
      page.on('request', seen);
      try {
        await page.goto(`${siteUrl}/#/trade/practice`);
        await page.evaluate(() => localStorage.setItem('props.market', '"BTC"'));
        await forgetCandles(page);
        await page.reload();
        const legend = page.locator('.tv-legend-main');
        await legend.getByText('BTC / USD · 1h · Props.trade').waitFor();
        await expectEventually(() => ['ETH 1h', 'SOL 1h', 'XAU 1h'].every(k => asked.includes(k)), `the watchlist's candles were not prefetched: ${asked}`);
        stub.publish({ type: 'price', ticks: [{ symbol: 'BTC', min: '64650', max: '64650', mid: '64650', ts: Date.now() + 2_000, session: 'open' }] });
        await legend.getByText('C64,650.00').waitFor();
        const before = asked.length;
        await page.locator('.watchlist-bar').getByRole('button', { name: /^ETH/ }).click();
        await legend.getByText('ETH / USD · 1h · Props.trade').waitFor();
        await page.locator('.watchlist-bar').getByRole('button', { name: /^BTC/ }).click();
        await legend.getByText('BTC / USD · 1h · Props.trade').waitFor();
        assert.equal(asked.length, before, `a tick or a watchlist click fetched candles again: ${asked.slice(before)}`);
        await page.locator('.timeframes').getByRole('button', { name: '4h', exact: true }).click();
        await legend.getByText('BTC / USD · 4h · Props.trade').waitFor();
        await expectEventually(() => ['ETH 4h', 'SOL 4h', 'XAU 4h'].every(k => asked.includes(k)), `the watchlist's candles were not prefetched for the new interval: ${asked}`);
        assert.equal(asked.filter(k => k === 'ETH 1h').length, 1, `ETH 1h was fetched more than once: ${asked}`);
        await page.locator('.timeframes').getByRole('button', { name: '1h', exact: true }).click();
        await legend.getByText('BTC / USD · 1h · Props.trade').waitFor();
      } finally {
        page.off('request', seen);
      }
    });

    await check('chart: a return visit paints the saved candles before /v1/candles answers, then keeps what the fetch returned, and asks for the watchlist\'s only once it answered', async () => {
      const key = 'props.candles.BTC.1h';
      // Every copy is dated 20 s back: young enough to show (the bound is three days), old enough to be refetched at once
      // (staleTime is 10 s); the watchlist's are refetched too, but not beside this chart's refetch.
      const had = await page.evaluate(k => { let found = false; for (const name of Object.keys(localStorage)) { if (!name.startsWith('props.candles.')) continue; const saved = JSON.parse(localStorage.getItem(name)); saved.at -= 20_000; localStorage.setItem(name, JSON.stringify(saved)); found ||= name === k; } return found; }, key);
      assert.ok(had, 'the last fetch of BTC 1h left no saved copy');
      const candlesUrl = /\/v1\/candles\?symbol=BTC&interval=1h$/;
      let served = null; // the JSON /v1/candles returned once the hold was over
      let asked = 0;
      await page.route(candlesUrl, async route => {
        asked += 1;
        await new Promise(resolve => setTimeout(resolve, 3_000));
        const response = await route.fetch();
        served = await response.json();
        await route.fulfill({ response, json: served });
      });
      const others = []; // the watchlist's /v1/candles requests, each with whether this chart's refetch had answered by then
      const seen = request => { const url = new URL(request.url()); if (url.pathname === '/v1/candles' && url.searchParams.get('symbol') !== 'BTC') others.push([url.searchParams.get('symbol'), served !== null]); };
      page.on('request', seen);
      try {
        const reloadedAt = Date.now();
        await page.reload();
        await page.locator('.tv-legend-main .tv-ohlc').waitFor({ timeout: 2_500 });
        // Candle bodies in the dark palette's up (#0ecb81) or down (#f6465d) colour, on any of the chart's canvases.
        await page.waitForFunction(() => {
          const candle = (d, i) => (Math.abs(d[i] - 14) < 4 && Math.abs(d[i + 1] - 203) < 4 && Math.abs(d[i + 2] - 129) < 4) || (Math.abs(d[i] - 246) < 4 && Math.abs(d[i + 1] - 70) < 4 && Math.abs(d[i + 2] - 93) < 4);
          return [...document.querySelectorAll('.price-chart canvas')].some(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) if (candle(d, i)) return true; return false; });
        }, null, { timeout: 2_000 });
        assert.equal(served, null, 'the candles were painted only once /v1/candles answered');
        assert.equal(asked, 1, 'the copy older than staleTime was not refetched');
        await expectEventually(() => served !== null, 'the held candles were never served', 6_000);
        await page.waitForFunction(([k, at]) => JSON.parse(localStorage.getItem(k) ?? '{}').at >= at, [key, reloadedAt]);
        const stored = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), key);
        assert.deepEqual(stored.candles, served.candles.slice(-300).map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
        await expectEventually(() => others.length >= 3, `the watchlist's candles were not refetched: ${others.map(([symbol]) => symbol)}`);
        assert.ok(others.every(([, after]) => after), `the watchlist's candles were asked for beside this chart's refetch, not after it: ${others.filter(([, after]) => !after).map(([symbol]) => symbol)}`);
      } finally {
        page.off('request', seen);
        await page.unroute(candlesUrl);
      }
    });

    await check('simulated order: submit, fill at the next price, then close', async () => {
      await page.goto(`${siteUrl}/#/trade/evaluation`);
      await page.getByText('Evaluation 25K').first().waitFor();
      await page.getByLabel('Order size in USD').fill('1000');
      await page.locator('.order-panel').getByRole('button', { name: 'Buy / Long BTC' }).click();
      await page.locator('.order-panel').getByText('Awaiting execution…').waitFor();
      await page.locator('.order-panel').getByText('Simulated order filled at the live price.').waitFor({ timeout: 10_000 });
      const row = page.locator('.position-table tbody tr').filter({ hasText: 'BTC / USD' });
      await row.waitFor();
      await row.getByRole('button', { name: /Close/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Confirm close' }).click();
      await row.waitFor({ state: 'detached', timeout: 10_000 });
      await page.getByRole('tab', { name: 'Trade history' }).click();
      await page.locator('.table-scroll tbody tr').filter({ hasText: 'BTC / USD' }).first().waitFor();
    });

    await check('payout request: built with @props/sdk, signed by the wallet, sent, then tracked on its receipt', async () => {
      const before = state.signatures;
      await page.goto(`${siteUrl}/#/payouts`);
      await page.getByRole('button', { name: 'Request a payout' }).click();
      await page.waitForURL('**/#/payout/review');
      await main.getByText('0.001787 SOL').waitFor(); // network fee + PayoutRequest rent, from the built transaction
      await page.getByLabel('I have checked the amount and the receiving address.').check();
      await page.getByRole('button', { name: 'Request payout' }).click();
      await page.waitForURL('**/#/payout/receipt?id=*');
      await main.getByText('Your payout is on its way.').waitFor();
      await main.locator('.badge').getByText('Requested').waitFor();
      assert.equal(sent('requestPayout').length, 1);
      assert.equal(state.signatures, before + 1, 'one wallet signature');
    });

    await check('funded order: simulated, signed by the wallet, sent to the RPC, then executed by the keeper', async () => {
      w.payouts.find(p => p.status === 'requested').status = 'paid';
      const before = { signatures: state.signatures, simulations: state.simulations };
      await page.goto(`${siteUrl}/#/trade/funded`);
      await page.getByText('Funded 25K').first().waitFor();
      await page.getByLabel('Order size in USD').fill('1000');
      await page.locator('.order-panel').getByRole('button', { name: 'Buy / Long BTC' }).click();
      await page.locator('.order-panel').getByText('BTC long executed on the exchange.').waitFor({ timeout: 10_000 });
      const [open] = sent('openPosition');
      assert.ok(open, 'no open_position transaction reached the RPC');
      assert.equal(open.data.args.isLong, true);
      assert.equal(BigInt(open.data.args.sizeDeltaUsd.toString()), 1000n * 10n ** 20n);
      assert.equal(BigInt(open.data.args.collateral.toString()), 200_000_000n); // 1,000 USD at 5×
      assert.ok(BigInt(open.data.args.acceptablePrice.toString()) > 0n);
      assert.equal(state.signatures, before.signatures + 1, 'one wallet signature');
      assert.ok(state.simulations > before.simulations, 'not simulated before signing');
      await page.locator('.position-table tbody tr').filter({ hasText: 'BTC / USD' }).waitFor();
      await page.locator('.order-panel').getByRole('link', { name: 'View transaction' }).waitFor();
    });

    await check('funded order: a rule failure is explained before the wallet is asked, and a retry rebuilds', async () => {
      const before = state.signatures;
      state.simulationLogs = [`Program ${PROGRAM_ID} invoke [1]`, `Program ${PROGRAM_ID} failed: custom program error: 0x1786`];
      await page.locator('.order-panel').getByRole('button', { name: 'Buy / Long BTC' }).click();
      await page.locator('.order-panel').getByRole('alert').getByText('Total exposure above the account limit.').waitFor();
      assert.equal(state.signatures, before, 'the wallet was asked to sign a failing transaction');
      await page.locator('.order-panel').getByRole('button', { name: 'Buy / Long BTC' }).click();
      await page.locator('.order-panel').getByText('BTC long executed on the exchange.').waitFor({ timeout: 10_000 });
      assert.equal(state.signatures, before + 1);
    });

    await check('funded close: a partial close that executed gives the row its Close button back (the request over, the server says whether it is still closing)', async () => {
      const row = page.locator('.position-table tbody tr').filter({ hasText: 'BTC / USD' });
      await row.locator('small', { hasText: /^\$2,000\.00 · / }).waitFor(); // both opens above went into one $2,000 position
      await row.getByRole('button', { name: /Close/ }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('slider').fill('50');
      await dialog.getByRole('button', { name: 'Send close order' }).click();
      await row.getByRole('status').getByText('Closing…').waitFor({ timeout: 5_000 });
      await page.getByText('Close executed by the exchange.').waitFor({ timeout: 10_000 });
      await row.getByRole('button', { name: /Close/ }).waitFor({ timeout: 5_000 }); // still here at half its size, and closable again
      assert.equal(await row.getByRole('status').count(), 0, 'the row still reads Closing…');
      await row.locator('small', { hasText: /^\$1,000\.00 · / }).waitFor();
      const [close] = sent('closePosition');
      assert.equal(BigInt(close.data.args.sizeDeltaUsd.toString()), 1000n * 10n ** 20n, 'half of the $2,000 position');
    });

    await check('checkout: exact fee, buy_evaluation signed and sent, payment tracked until the evaluation is ready', async () => {
      await page.goto(`${siteUrl}/#/get-funded`);
      await page.getByRole('button', { name: '$10K' }).click();
      assert.ok(await page.getByRole('button', { name: '$50K' }).isDisabled(), 'a disabled tier can be chosen');
      await page.getByText('50K and 100K are unavailable for now.').waitFor();
      await page.getByRole('button', { name: 'Choose 10K account' }).click();
      await page.getByRole('button', { name: 'Continue with this account' }).click();
      await page.goto(`${siteUrl}/#/checkout`);
      await main.getByText('79.00 USDC').first().waitFor();
      await main.getByText('0.000005 SOL').waitFor(); // network fee of the built transaction
      await main.getByText('0.002032 SOL').waitFor(); // Evaluation account rent (the profile already exists)
      await page.getByLabel(/I have read the evaluation rules/).check();
      await page.getByRole('button', { name: 'Pay 79.00 USDC' }).click();
      await page.waitForURL('**/#/payment?sig=*');
      await main.getByText('Payment complete').waitFor({ timeout: 15_000 });
      assert.deepEqual(sent('buyEvaluation').map(s => ({ ...s.data, expectedFeeUsdc: s.data.expectedFeeUsdc.toString() })), [{ tierId: 1, index: 2, expectedFeeUsdc: '79000000', expectedTierVersion: 1 }]);
      await main.getByRole('button', { name: 'Open your evaluation' }).click();
      await page.waitForURL('**/#/trade/evaluation');
      await page.locator('.account-strip').getByText('Evaluation 10K').waitFor();
    });

    await check('verify: search finds evidence, the record dialog shows what it establishes, unknown and invalid ids are explained', async () => {
      await page.goto(`${siteUrl}/#/verify`);
      await page.waitForURL('**/#/search'); // the Verify page became Search; its old links still land there
      await page.getByLabel('Search verification records').fill(w.funded);
      await page.getByRole('button', { name: 'Find record' }).click();
      await main.getByText('Funded account activated').waitFor();
      await main.locator('.proof-timeline').getByText('Simulated', { exact: true }).waitFor();
      await main.getByRole('button', { name: 'Inspect record' }).click();
      await page.getByRole('dialog').getByText('The wallet bought this evaluation under terms version 1.').waitFor();
      await page.keyboard.press('Escape');
      await page.getByLabel('Search verification records').fill(keys[2].address.slice(0, 43) + 'z');
      await page.getByRole('button', { name: 'Find record' }).click();
      await main.getByText(/No record matches/).waitFor();
      await page.getByLabel('Search verification records').fill('PT-002841');
      await page.getByRole('button', { name: 'Find record' }).click();
      await main.getByText(/is not a Solana address/).waitFor();
    });

    await check('vault: capital, allocation, series and the onchain ledger', async () => {
      await page.goto(`${siteUrl}/#/vault`);
      await main.getByText('$48,750.00').first().waitFor();
      await main.getByText('2.5%').waitFor(); // 1,250 allocated of 50,000
      await main.locator('.line-graph').waitFor();
      await main.getByText('Seed capital added').waitFor();
      await main.getByRole('button', { name: 'Inspect Seed capital added' }).click();
      await page.getByRole('dialog').getByRole('link', { name: /…/ }).first().waitFor();
      await page.keyboard.press('Escape');
    });

    await check('stage context: a return visit opens the last stage, onboarding rules show the tier, the ticket refuses what the stage cannot trade', async () => {
      await page.goto(`${siteUrl}/#/trade/evaluation`);
      await page.locator('.account-strip').getByText(/^Evaluation/).first().waitFor();
      await page.locator('header').getByRole('link', { name: 'Props.trade home' }).click();
      await page.waitForFunction(() => location.hash === '#/');
      await page.locator('.order-panel .badge').getByText('Evaluation', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('props.stage')), '"evaluation"', 'the saved stage survives');
      // Onboarding: the footer rules are the tier's, and the resume notice names the account in progress.
      await page.goto(`${siteUrl}/#/program`);
      await page.locator('footer').getByRole('button', { name: 'Rules' }).click();
      const rules = page.getByRole('dialog');
      await rules.getByRole('heading', { name: /^Rules for the \w+ evaluation$/ }).waitFor();
      await rules.getByRole('button', { name: 'Back to program details' }).click();
      await page.goto(`${siteUrl}/#/get-funded`);
      await main.getByRole('button', { name: /Resume trading|Continue to activation/ }).waitFor();
      // DOGE is not on the funded allowlist: not in evaluations (their own copy). Practice trades every listed market: each
      // has a USDC-only pool (the markets without one are not listed).
      const pickDoge = async stage => {
        await page.goto(`${siteUrl}/#/trade/${stage}`);
        await page.locator('.order-panel').waitFor();
        await page.keyboard.press('Control+k');
        await page.getByRole('dialog', { name: 'Find a market' }).getByRole('button', { name: /^DOGE/ }).click();
        await page.locator('.market-select strong', { hasText: /^DOGE/ }).waitFor();
      };
      await pickDoge('evaluation');
      await page.locator('.order-panel').getByText('DOGE is not available in evaluations: they trade only the markets funded accounts can.').waitFor();
      assert.ok(await page.locator('.order-panel').getByRole('button', { name: /Buy \/ Long DOGE/ }).isDisabled(), 'evaluation: the order can still be submitted');
      await pickDoge('practice');
      await page.getByLabel('Order size in USD').fill('100');
      await page.locator('.order-panel').getByRole('button', { name: /Buy \/ Long DOGE/ }).and(page.locator(':enabled')).waitFor();
      assert.equal(await page.locator('.order-panel').getByText(/not available|USDC-only pool/).count(), 0, 'practice restricts a listed market');
      await page.goto(`${siteUrl}/#/trade/funded`);
    });

    await check('phone width: notifications and market search stay reachable', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      try {
        await page.goto(`${siteUrl}/#/accounts`);
        const header = page.locator('header');
        await header.getByRole('button', { name: /^Notifications/ }).waitFor({ state: 'visible' });
        await header.getByRole('button', { name: 'Toggle navigation' }).click();
        await header.getByRole('button', { name: 'Search markets' }).click();
        await page.getByRole('dialog', { name: 'Find a market' }).waitFor();
        await page.keyboard.press('Escape');
      } finally {
        await page.setViewportSize({ width: 1920, height: 1080 });
      }
    });

    await check('notifications: listed, filtered by preferences, and marked read', async () => {
      await page.getByRole('button', { name: 'Notifications' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText('Order executed').waitFor();
      await dialog.getByRole('button', { name: 'Mark all as read' }).click();
      await expectEventually(() => w.notifications.every(n => n.read), 'notifications were not marked read');
      await page.keyboard.press('Escape');
      await page.goto(`${siteUrl}/#/settings`);
      await page.locator('.settings-nav').getByRole('button', { name: 'Notifications' }).click();
      await page.getByRole('switch', { name: 'Order updates' }).click();
      await page.locator('header').getByRole('button', { name: 'Notifications' }).click();
      await dialog.getByText('Payout paid').waitFor();
      assert.equal(await dialog.getByText('Order executed').count(), 0, 'a disabled notification kind is still shown');
      await page.keyboard.press('Escape');
    });

    await check('account links: a notification opens the account it names, and a past evaluation keeps its history', async () => {
      const past = w.accounts.find(a => a.stage === 'evaluation' && a.status === 'passed'); // became the funded account
      assert.equal(past.label, w.accounts.find(a => a.id === w.evalActive).label, 'fixture: two evaluations with the same label');
      await page.goto(`${siteUrl}/#/trade/evaluation`);
      const strip = page.locator('.account-strip .active-account small');
      await strip.waitFor();
      const trading = await strip.textContent();
      stub.publish({ type: 'notification', notification: { id: '6f0c5d0e-0000-4000-8000-000000000009', title: 'Close to the loss limit', body: `${past.label} ${past.shortId}: less than a quarter of the loss allowance is left`, href: `/account/evaluation?id=${past.id}`, ts: Date.now(), read: false, kind: 'risk' } }, w.wallet);
      await page.locator('header').getByRole('button', { name: /Notifications, \d+ unread/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: /Close to the loss limit/ }).click();
      await page.waitForURL(`**/#/account/evaluation?id=${past.id}`);
      await main.getByText(`${past.shortId} · Started`).waitFor();
      await page.getByRole('navigation', { name: 'Account sections' }).getByRole('link', { name: 'Activity' }).click();
      await page.waitForURL(`**/#/activity?id=${past.id}`);
      await main.getByText(`Your account, line by line. ${past.shortId}`).waitFor();
      // Past accounts → result → "Review account history" stays on that evaluation.
      await page.goto(`${siteUrl}/#/accounts`);
      await page.getByRole('tab', { name: 'Past accounts' }).click();
      await main.locator('.archived-account', { hasText: past.shortId }).getByRole('button', { name: 'View result' }).click();
      await page.waitForURL(`**/#/result?id=${past.id}`);
      await main.getByRole('link', { name: /Review account history/ }).click();
      await page.waitForURL(`**/#/activity?id=${past.id}`);
      await main.getByText(`Your account, line by line. ${past.shortId}`).waitFor();
      // Viewing a past account does not change what the terminal trades.
      await page.goto(`${siteUrl}/#/trade/evaluation`);
      await page.locator('.account-strip .active-account small', { hasText: trading }).waitFor();
      assert.ok(!trading.includes(past.shortId));
    });

    await check('activity: rows from the API and a CSV export of exactly the shown rows', async () => {
      await page.goto(`${siteUrl}/#/trade/evaluation`);
      await page.getByRole('button', { name: /Evaluation 10K/ }).first().click();
      await page.getByRole('dialog').getByRole('button', { name: /Evaluation 25K/ }).click();
      await page.goto(`${siteUrl}/#/activity`);
      await page.getByRole('tab', { name: 'Trades' }).click();
      const rows = main.locator('tbody tr');
      await rows.first().waitFor();
      const shown = await rows.count();
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
      const csv = readFileSync(await download.path(), 'utf8').trim().split('\n');
      assert.equal(csv.length, shown + 1, 'CSV rows differ from the shown rows');
      assert.match(csv[0], /^Time \(UTC\),Type,Event/);
    });

    await check('positions show where the exchange liquidates them and the margin backing them', async () => {
      await page.goto(`${siteUrl}/#/trade/evaluation`); // Evaluation 25K, selected by the activity check
      const row = page.locator('.position-table tbody tr').filter({ hasText: 'SOL / USD' });
      await row.waitFor();
      assert.deepEqual(await page.locator('.position-table thead th').allTextContents(), ['Market / side', 'Position size', 'Entry price', 'Mark price', 'Liq. price', 'Unrealized P&L', 'Fees accrued', 'TP / SL', '']);
      await row.getByText('98.12', { exact: true }).waitFor();
      await row.getByText('$4,600.00 · $1,533.33 margin').waitFor();
      // Accrued costs with their split as the hover, and the market's rates for the position's side as the market cell's
      // hover: the row keeps two lines (touch screens, without hover, show the rates under the leverage badge).
      const fees = row.locator('td[title^="Borrowing"]');
      assert.equal(await fees.innerText(), '$3.60');
      assert.equal(await fees.getAttribute('title'), "Borrowing $0.62 · funding $0.22 · close fee $2.76: settled at this position's next fill");
      assert.equal(await row.locator('td').first().getByRole('button').getAttribute('title'), 'Long rates per hour: funding +0.0012% · borrow 0.0008%\nFunding: Longs pay when positive, shorts when negative. Per 8h: L +0.0096% · S -0.0072% · per year: L +10.5120% · S -7.8840%');
      assert.equal(await row.locator('.side-rate').count(), 0, 'the rates line is back in the desktop row');
    });

    /** Shows `symbol` in the terminal through the watchlist bar (earlier checks leave other markets selected). */
    const showMarket = async symbol => { await page.locator('.watchlist-bar').getByRole('button', { name: new RegExp(`^${symbol}`) }).click(); await page.locator('.market-select strong', { hasText: new RegExp(`^${symbol}`) }).waitFor(); };
    /** Opens the ticket's Order details disclosure (this browser remembers it open or closed). */
    const openDetails = async () => { const details = page.locator('.order-panel .order-details'); await details.waitFor(); if (!(await details.evaluate(d => d.open))) await details.locator('summary').click(); };

    await check('ticket: three summary rows and a large order button in view at 1440x900; Order details holds the rest (collapsed at first, every row, kept across a reload); the market heading is one row at 1280 and 1440 px', async () => {
      const ticket = page.locator('.order-panel');
      const details = ticket.locator('.order-details');
      const isOpen = () => details.evaluate(d => d.open);
      await page.setViewportSize({ width: 1440, height: 900 });
      try {
        await page.goto(`${siteUrl}/#/trade/evaluation`);
        await showMarket('BTC');
        for (const clear of await ticket.getByRole('button', { name: 'Clear' }).all()) if (await clear.isEnabled()) await clear.click(); // TP/SL empty
        await page.getByLabel('Order size in USD').fill('1000');
        await ticket.getByRole('button', { name: '5×', exact: true }).click();
        await page.waitForFunction(() => /\$\d/.test(document.querySelector('.order-summary')?.innerText.split('Liq. price')[1] ?? ''), null, { timeout: 5_000 });
        assert.deepEqual(await ticket.locator('.order-summary .data-row > span').allInnerTexts(), ['Liq. price', 'Margin', 'Fees']);
        assert.equal(await ticket.getByRole('button', { name: 'About margin' }).getAttribute('title'), 'The exchange takes the fee out of this margin');
        assert.equal(await ticket.getByRole('button', { name: 'About leverage and margin' }).getAttribute('title'), 'Higher leverage needs less margin and brings the liquidation price closer. BTC / USD allows up to 25×.');
        // The Fees row's info button breaks the round trip down: open + close fee = the row, then holding costs and the rest.
        const feesButton = ticket.getByRole('button', { name: 'Fee breakdown' });
        const breakdown = await feesButton.getAttribute('title');
        const [open, close] = [/Open fee \$([\d.]+)/, /Est\. close fee \$([\d.]+)/].map(re => Number(breakdown.match(re)?.[1]));
        const feesRow = Number((await ticket.locator('.order-summary .data-row').nth(2).locator('strong').innerText()).replace(/[$,]/g, ''));
        assert.ok(Math.abs(open + close - feesRow) < 0.011, `open ${open} + close ${close} is not the Fees row ${feesRow}: ${breakdown}`);
        assert.match(breakdown, /Borrow \+ funding .+\/h while open · No Props\.trade fee per order$/);
        await feesButton.click();
        await page.locator('.toast').filter({ hasText: 'Open fee' }).waitFor({ timeout: 3_000 });
        // The order button: at least 48 px tall and whole in the window without scrolling the page or the order panel.
        await page.evaluate(() => scrollTo(0, 0));
        assert.equal(await ticket.evaluate(el => el.scrollTop), 0);
        const button = await ticket.locator('.order-submit').boundingBox();
        assert.ok(button.height >= 48, `the order button is ${button.height}px tall`);
        assert.ok(button.y >= 0 && button.y + button.height <= 900, `the order button spans y ${Math.round(button.y)}–${Math.round(button.y + button.height)} of a 900 px window`);
        // Order details: collapsed on a first visit, with every row the summary leaves out.
        assert.equal(await isOpen(), false, 'Order details starts open');
        assert.equal(await details.locator('.data-row').first().isVisible(), false, 'the detail rows show while collapsed');
        await details.locator('summary').click();
        assert.equal(await isOpen(), true);
        await page.waitForFunction(() => localStorage.getItem('props.orderDetails') === 'true');
        const labels = await details.locator('.data-row > span').allInnerTexts();
        for (const label of ['Estimated entry', 'Order value', 'Open fee', 'Est. close fee', 'Price impact', 'Borrow + funding · long', 'Slippage tolerance']) assert.ok(labels.some(l => l.startsWith(label)), `Order details lacks ${label}: ${labels.join(' | ')}`);
        await details.getByText('+ = better than mark').waitFor();
        await details.getByText('Props.trade charges no fee per order').waitFor();
        await details.getByRole('button', { name: /%/ }).click(); // the slippage setting still opens its dialog
        await page.getByRole('dialog', { name: 'Slippage tolerance' }).waitFor();
        await page.keyboard.press('Escape');
        // The state is this browser's: kept across a reload, open and closed.
        await page.reload();
        await details.locator('summary').waitFor();
        assert.equal(await isOpen(), true, 'Order details closed after a reload');
        await details.locator('summary').click();
        assert.equal(await isOpen(), false);
        await page.waitForFunction(() => localStorage.getItem('props.orderDetails') === 'false');
        await page.reload();
        await details.locator('summary').waitFor();
        assert.equal(await isOpen(), false, 'Order details opened after a reload');
        // The heading: pair, price, the four metrics and the session badge on one row, at most 64 px tall.
        for (const width of [1280, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await page.locator('.market-heading .rate-metric').first().waitFor();
          const heading = page.locator('.market-heading');
          const items = await heading.evaluate(h => [...h.querySelectorAll(':scope > .market-select, :scope > .market-price, .market-metric, :scope > .badge')].filter(e => e.checkVisibility()).map(e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
          assert.equal(items.length, 7, `${width}px: ${items.length} heading items`);
          assert.ok(Math.max(...items.map(i => i.top)) < Math.min(...items.map(i => i.bottom)), `the heading wraps at ${width}px: ${JSON.stringify(items)}`);
          const { height } = await heading.boundingBox();
          assert.ok(height <= 64, `the heading is ${height}px tall at ${width}px`);
        }
      } finally {
        await page.setViewportSize({ width: 1920, height: 1080 });
      }
    });

    await check('ticket: the leverage slider and presets change the margin, buying power and the quote rows without a dialog', async () => {
      await page.goto(`${siteUrl}/#/trade/evaluation`);
      await showMarket('BTC');
      const ticket = page.locator('.order-panel');
      const rowValue = label => ticket.locator('.execution-details .data-row', { has: page.locator('span', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }) }).locator('strong').innerText();
      await openDetails();
      await page.getByLabel('Order size in USD').fill('1000');
      await ticket.getByText('5× leverage').waitFor();
      assert.equal(await rowValue('Margin'), '$200.00');
      await ticket.getByRole('button', { name: '10×', exact: true }).click();
      await ticket.getByText('10× leverage').waitFor();
      assert.equal(await rowValue('Margin'), '$100.00');
      assert.equal(await page.getByRole('dialog').count(), 0, 'a dialog opened');
      await ticket.getByLabel('Leverage', { exact: true }).focus(); // the slider: the arrow keys step it by 1× (Crypto allows up to 25×)
      for (let i = 0; i < 10; i += 1) await page.keyboard.press('ArrowRight');
      await ticket.getByText('20× leverage').waitFor();
      assert.equal(await ticket.getByLabel('Leverage', { exact: true }).getAttribute('aria-valuetext'), '20×');
      assert.equal(await rowValue('Margin'), '$50.00');
      // Page Up / Page Down move to the next label's value either way (not a tenth of the track, stuck at 1×).
      for (const [key, shown] of [['PageDown', '10×'], ['PageDown', '5×'], ['Home', '1×'], ['PageUp', '2×'], ['PageUp', '5×'], ['End', '25×'], ['PageDown', '10×'], ['PageUp', '25×']]) {
        await page.keyboard.press(key);
        await ticket.getByText(`${shown} leverage`).waitFor();
        assert.equal(await ticket.getByLabel('Leverage', { exact: true }).getAttribute('aria-valuetext'), shown, key);
      }
      await ticket.getByRole('button', { name: 'Max 25×' }).click();
      await ticket.getByText('25× leverage').waitFor();
      await ticket.locator('.order-summary').getByText('Liq. price').waitFor();
      await page.waitForFunction(() => /\$\d/.test(document.querySelector('.order-summary')?.innerText.split('Liq. price')[1] ?? ''), null, { timeout: 5_000 });
      const rows = await ticket.locator('.execution-details .data-row span').allInnerTexts();
      for (const label of ['Liq. price', 'Margin', 'Fees', 'Estimated entry', 'Order value', 'Open fee', 'Est. close fee', 'Price impact', 'Borrow + funding · long', 'Slippage tolerance']) assert.ok(rows.some(r => r.startsWith(label)), `missing row ${label}: ${rows.join(' | ')}`);
      await ticket.getByText('Props.trade charges no fee per order').waitFor();
      assert.equal(await rowValue('Fees'), '$1.20'); // round trip: 6 bps a leg on $1,000 in the stub
      assert.match(await rowValue('Borrow + funding · long'), /^≈ \$0\.02\/h · \$0\.48\/day$/); // (0.0012 + 0.0008)% of $1,000
      assert.equal(await ticket.getByText('Network fee').count(), 0, 'a simulated ticket shows a network fee');
    });

    await check('ticket: TP/SL rows show an estimated P&L that flips sign with the side, linked price and % fields, chips, and the chart draws both lines', async () => {
      const ticket = page.locator('.order-panel');
      const guides = () => page.locator('.chart-section .price-chart').getAttribute('data-guides');
      await ticket.getByRole('button', { name: '5×', exact: true }).click();
      await ticket.getByRole('button', { name: '+2%', exact: true }).first().click(); // take profit, 2% above the entry for a long
      const tpPct = ticket.getByLabel('Take profit distance in percent');
      assert.equal(await tpPct.inputValue(), '2.00');
      const tpEst = ticket.locator('.protection-leg').first().locator('.leg-head b');
      await tpEst.filter({ hasText: /^Est\. P&L ≈ \+\$1[0-9]\.\d\d \(\+\d+\.\d% on margin\)$/ }).waitFor(); // $20 of price move less $1.20 of fees and the impact
      await ticket.getByLabel('Stop loss distance in percent').fill('-1');
      const sl = ticket.getByLabel('Stop loss price');
      assert.ok(Math.abs(Number(await sl.inputValue()) / 64600 - 0.99) < 0.0002, `stop loss price ${await sl.inputValue()}`);
      const slEst = ticket.locator('.protection-leg').nth(1).locator('.leg-head b');
      await slEst.filter({ hasText: /^Est\. P&L ≈ −\$1[0-9]\.\d\d/ }).waitFor();
      assert.equal(await ticket.getByText(/correct sides of the current price/).count(), 0);
      await expectEventually(async () => /^TP ≈ \+\$1\d\|SL ≈ −\$1\d$/.test(await guides()), `chart guides: ${await guides()}`);
      // The same prices on a short are on the wrong sides: the copy says so, the order cannot be sent, the estimates flip sign.
      await ticket.getByRole('button', { name: 'Sell / Short' }).click();
      await ticket.getByText('Set take profit and stop loss on the correct sides of the current price.').waitFor();
      await tpEst.filter({ hasText: /^Est\. P&L ≈ −\$2[0-9]\.\d\d/ }).waitFor();
      await slEst.filter({ hasText: /^Est\. P&L ≈ \+\$[0-9]\.\d\d/ }).waitFor();
      assert.ok(await ticket.getByRole('button', { name: 'Sell / Short BTC' }).isDisabled());
      await ticket.getByRole('button', { name: 'Clear' }).first().click();
      await ticket.getByRole('button', { name: 'Clear' }).nth(1).click();
      await expectEventually(async () => (await guides()) === '', `chart guides after clearing: ${await guides()}`);
      await ticket.getByRole('button', { name: 'Buy / Long' }).click();
    });

    await check('ticket: the side\'s leverage and size limits from the market row cap both sliders, a size or margin outside them is explained right above the order button and blocks the order, and a stream update moves them', async () => {
      await page.goto(`${siteUrl}/#/trade/evaluation`);
      await showMarket('ETH'); // the fixture's ETH: $2,500 of room for a new long, shorts up to 10×
      const ticket = page.locator('.order-panel');
      const size = page.getByLabel('Order size in USD');
      const submit = ticket.getByRole('button', { name: /^Buy \/ Long ETH/ });
      const side = name => ticket.getByRole('button', { name, exact: true });
      await ticket.getByRole('button', { name: 'Max 25×' }).click();
      await ticket.getByText('25× leverage').waitFor();
      await size.fill('3000');
      await ticket.getByText('Up to $2,500 can be opened long on ETH right now.').waitFor();
      assert.ok(await submit.isDisabled(), 'an order above the exchange\'s room can be sent');
      // The message sits right above the order button, in the ticket's error style.
      assert.ok(await ticket.locator('p.field-error').evaluate(e => e.checkVisibility() && e.nextElementSibling?.classList.contains('order-submit')), 'the message is not right above the order button');
      // The size slider's 100% is the room (below this account's buying power), and the size input's max.
      await ticket.getByRole('button', { name: '100%', exact: true }).click();
      assert.equal(await size.inputValue(), '2500');
      assert.equal(await size.getAttribute('max'), '2500');
      assert.equal(await ticket.getByText(/can be opened long/).count(), 0);
      await submit.and(page.locator(':enabled')).waitFor();
      await size.fill('4'); // $0.16 of margin at 25×, below the exchange's $1 minimum
      await ticket.getByText('The minimum margin on ETH is $1.00.').waitFor();
      assert.ok(await submit.isDisabled(), 'an order below the minimum margin can be sent');
      // $1.00 at 25×: at the minimum, but the fees come out of it first. The exchange's model refuses it (the quote runs
      // it), and the ticket says so above the order button in the server's words, once.
      await size.fill('25');
      await ticket.getByText('A long on ETH needs at least $1.00 of margin after fees.').waitFor();
      assert.ok(await ticket.locator('p.field-error', { hasText: 'after fees' }).evaluate(e => e.checkVisibility() && e.nextElementSibling?.classList.contains('order-submit')));
      assert.equal(await ticket.locator('p.field-error').count(), 1, (await ticket.locator('p.field-error').allInnerTexts()).join(' | '));
      assert.ok(await submit.isDisabled(), 'an order the exchange refuses can be sent');
      await size.fill('30'); // $1.20: enough after the fees
      await ticket.getByText(/after fees/).waitFor({ state: 'detached' });
      await submit.and(page.locator(':enabled')).waitFor();
      // Shorts are capped at 10×: switching side clamps the chosen leverage, and switching back keeps the clamp.
      await size.fill('1000');
      await side('Sell / Short').click();
      await ticket.getByText('10× leverage').waitFor();
      await ticket.getByRole('button', { name: 'Max 10×' }).waitFor();
      assert.equal(await ticket.getByLabel('Leverage', { exact: true }).getAttribute('aria-valuetext'), '10×');
      await side('Buy / Long').click();
      await ticket.getByRole('button', { name: 'Max 25×' }).waitFor();
      await ticket.getByText('10× leverage').waitFor();
      // A market row from the stream lowers the long limits: the ticket follows at once.
      const eth = state.markets.find(m => m.symbol === 'ETH');
      stub.publish({ type: 'market', market: { ...eth, maxLeverageLong: 8, maxSizeLong: '800' } });
      await ticket.getByRole('button', { name: 'Max 8×' }).waitFor();
      await ticket.getByText('8× leverage').waitFor();
      await ticket.getByText('Up to $800 can be opened long on ETH right now.').waitFor();
      assert.ok(await submit.isDisabled());
      // No room left on the side: the ticket says so as the server does, not "Up to $0".
      stub.publish({ type: 'market', market: { ...eth, maxSizeLong: '0.4' } });
      await ticket.getByText('No new long can be opened on ETH right now.').waitFor();
      assert.ok(await submit.isDisabled());
      stub.publish({ type: 'market', market: eth });
      await ticket.getByRole('button', { name: 'Max 25×' }).waitFor();
      await ticket.getByText(/can be opened long/).waitFor({ state: 'detached' });
      // A funded ticket takes the same limits.
      await page.goto(`${siteUrl}/#/trade/funded`);
      await ticket.locator('.badge').getByText('Funded', { exact: true }).waitFor();
      await size.fill('3000');
      await ticket.getByText('Up to $2,500 can be opened long on ETH right now.').waitFor();
      assert.ok(await submit.isDisabled(), 'a funded order above the exchange\'s room can be sent');
      await size.fill('1000');
      await showMarket('BTC');
      await ticket.getByRole('button', { name: '5×', exact: true }).click();
    });

    await check('ticket: every leverage and size label sits under the thumb at its own value (flush with the track at its ends), and the label rows keep their height and fonts, at 1280 and 390 px', async () => {
      await page.goto(`${siteUrl}/#/trade/evaluation`);
      await showMarket('BTC');
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        try {
          if (width < 800) await page.locator('.mobile-trade-action').click();
          const ticket = page.locator('.order-panel');
          await page.getByLabel('Order size in USD').fill('1000');
          for (const [name, row] of [['Leverage', ticket.locator('.leverage-presets')], ['Percentage of buying power', ticket.locator('.size-presets:not(.leverage-presets)')]]) {
            const slider = ticket.getByLabel(name, { exact: true });
            const labels = row.getByRole('button');
            const count = await labels.count();
            assert.ok(count >= 4, `${name}: ${count} labels`);
            for (let i = 0; i < count; i += 1) {
              const label = labels.nth(i);
              const text = await label.innerText();
              await label.click();
              const at = await slider.evaluate(el => (Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min)));
              const [track, box, thumb] = [await slider.boundingBox(), await label.boundingBox(), await thumbCenter(page, slider)];
              // The first and last labels stay flush with the track's ends (the thumb's outer edge there) and span the thumb's centre.
              const off = at <= 0 ? box.x - track.x : at >= 1 ? box.x + box.width - (track.x + track.width) : box.x + box.width / 2 - thumb;
              assert.ok(Math.abs(off) <= 2, `${width}px ${name} ${text} (at ${at.toFixed(3)}): ${off.toFixed(1)} px from the thumb`);
              assert.ok(thumb >= box.x && thumb <= box.x + box.width, `${width}px ${name} ${text}: the thumb (${thumb}) is not over its label (${box.x}–${box.x + box.width})`);
            }
            const [rowBox, heights, fonts] = [await row.boundingBox(), await labels.evaluateAll(list => list.map(b => b.getBoundingClientRect().height)), await labels.evaluateAll(list => [...new Set(list.map(b => getComputedStyle(b).fontSize))])];
            assert.ok(Math.abs(rowBox.height - Math.max(...heights)) < 0.5, `${width}px ${name}: the label row is ${rowBox.height}px for ${Math.max(...heights)}px labels`);
            assert.deepEqual(fonts, [width <= 800 ? '13px' : '10px'], `${width}px ${name}: label fonts ${fonts}`);
          }
        } finally {
          if (width < 800) await page.getByRole('button', { name: 'Close order form' }).click({ timeout: 2_000 }).catch(() => undefined);
          await page.setViewportSize({ width: 1920, height: 1080 });
        }
      }
      await page.locator('.order-panel').getByRole('button', { name: '5×', exact: true }).click();
    });

    await check('chart: the interval menu lists all 13 by group, a pick asks for its candles, a star pins it to the bar, and both survive a reload', async () => {
      const asked = [];
      const seen = request => { const url = new URL(request.url()); if (url.pathname === '/v1/candles' && !url.searchParams.has('from')) asked.push(url.searchParams.get('interval')); };
      page.on('request', seen);
      try {
        await page.goto(`${siteUrl}/#/trade/practice`);
        await showMarket('BTC');
        const bar = page.locator('.chart-section .timeframes');
        await bar.getByRole('button', { name: '1h', exact: true }).waitFor();
        assert.deepEqual(await bar.getByRole('button').allInnerTexts(), ['5m', '15m', '1h', '4h', '1D', '']);
        await bar.getByRole('button', { name: 'More intervals' }).click();
        const menu = page.getByRole('menu', { name: 'Candle interval' });
        assert.deepEqual(await menu.getByRole('menuitemradio').allInnerTexts(), ['1 minute', '3 minutes', '5 minutes', '15 minutes', '30 minutes', '1 hour', '2 hours', '4 hours', '6 hours', '12 hours', '1 day', '1 week', '1 month']);
        assert.deepEqual(await menu.getByRole('group').evaluateAll(list => list.map(g => g.getAttribute('aria-label'))), ['Minutes', 'Hours', 'Days']);
        await menu.getByRole('menuitemradio', { name: '3 minutes' }).click();
        await page.locator('.tv-legend-main').getByText('BTC / USD · 3m · Props.trade').waitFor();
        assert.ok(asked.includes('3m'), `intervals asked for: ${asked}`);
        assert.deepEqual(await bar.getByRole('button').allInnerTexts(), ['3m', '5m', '15m', '1h', '4h', '1D', ''], 'the chosen interval joins the bar while it is not pinned');
        await bar.getByRole('button', { name: 'More intervals' }).click();
        await menu.getByRole('button', { name: 'Pin 1W' }).click();
        await menu.getByRole('button', { name: 'Unpin 1W' }).waitFor();
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'detached' });
        await page.reload();
        await page.locator('.tv-legend-main').getByText('BTC / USD · 3m · Props.trade').waitFor();
        assert.deepEqual(await bar.getByRole('button').allInnerTexts(), ['3m', '5m', '15m', '1h', '4h', '1D', '1W', '']);
        assert.deepEqual(await page.evaluate(() => [localStorage.getItem('props.chart-interval'), localStorage.getItem('props.chart-intervals')]), ['"3m"', '["5m","15m","1h","4h","1D","1W"]']);
        await bar.getByRole('button', { name: '1h', exact: true }).click();
        await page.locator('.tv-legend-main').getByText('BTC / USD · 1h · Props.trade').waitFor();
      } finally {
        page.off('request', seen);
      }
    });

    await check('positions: the market button of a position, an order and a trade switches the chart; the chart draws the position’s entry, liquidation and TP', async () => {
      await page.goto(`${siteUrl}/#/trade/evaluation`);
      await showMarket('BTC');
      // A take profit typed on BTC belongs to BTC: SOL's ticket starts without it, or its chart would carry BTC's price.
      const ticket = page.locator('.order-panel');
      await ticket.getByRole('button', { name: '+2%', exact: true }).first().click();
      await expectEventually(async () => /TP ≈ \+\$/.test((await page.locator('.chart-section .price-chart').getAttribute('data-guides')) ?? ''), 'the draft take profit is not on the BTC chart');
      const row = page.locator('.position-table tbody tr').filter({ hasText: 'SOL / USD' });
      await row.getByRole('button', { name: 'Show SOL / USD on the chart' }).click();
      await page.locator('.market-select strong', { hasText: /^SOL/ }).waitFor();
      await expectEventually(async () => (await page.locator('.chart-section .price-chart').getAttribute('data-guides')) === 'Long entry|Liq.|TP', 'position guides');
      assert.equal(await ticket.getByLabel('Take profit price').inputValue(), '', "BTC's take profit survived the switch to SOL");
      await page.getByRole('tab', { name: /Open orders/ }).click();
      await page.getByRole('button', { name: 'Show ETH / USD on the chart' }).click();
      await page.locator('.market-select strong', { hasText: /^ETH/ }).waitFor();
      await page.getByRole('tab', { name: 'Trade history' }).click();
      await page.getByRole('button', { name: 'Show XAU / USD on the chart' }).click();
      await page.locator('.market-select strong', { hasText: /^XAU/ }).waitFor();
      // The record dialog itemises the round trip's costs.
      await page.getByRole('button', { name: /^View trade trade-1$/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Record details' });
      const rows = await dialog.locator('.data-row').allInnerTexts();
      for (const expected of ['Open + close fees$2.60', 'Funding$0.31', 'Borrowing$0.21', 'Price impact−$0.45', 'Total costs$3.12', 'Net P&L+$36.20']) assert.ok(rows.some(r => r.replace(/\s+/g, '') === expected.replace(/\s+/g, '')), `missing ${expected}: ${rows.join(' | ')}`);
      await page.keyboard.press('Escape');
      await page.getByRole('tab', { name: /Positions/ }).click();
      await page.getByRole('button', { name: 'Show SOL / USD on the chart' }).click();
      await page.locator('.market-select strong', { hasText: /^SOL/ }).waitFor();
    });

    await check('closing: the row reads Closing… at once with its buttons gone, leaves when the stream drops it, and comes back with the reason when the venue cancels', async () => {
      state.closeDelayMs = 2_500;
      try {
        await page.goto(`${siteUrl}/#/trade/evaluation`);
        await showMarket('SOL');
        await page.getByLabel('Order size in USD').fill('1000');
        await page.locator('.order-panel').getByRole('button', { name: 'Buy / Long SOL' }).click();
        await page.locator('.order-panel').getByText('Simulated order filled at the live price.').waitFor({ timeout: 10_000 });
        const rows = page.locator('.position-table tbody tr').filter({ hasText: 'SOL / USD' });
        await expectEventually(async () => await rows.count() === 2, 'the new SOL position is not listed');
        const row = rows.nth(1); // the one just opened
        state.cancelNextClose = 'The price moved past your slippage tolerance.';
        await row.getByRole('button', { name: /Close/ }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm close' }).click();
        await row.getByRole('status').getByText('Closing…').waitFor({ timeout: 1_500 });
        assert.equal(await row.getByRole('button', { name: /Close/ }).count(), 0, 'the Close button is still there');
        await page.getByRole('tab', { name: /Open orders/ }).click();
        await page.locator('table tbody tr').filter({ hasText: 'SOL / USD' }).filter({ hasText: 'Whole position' }).waitFor();
        await page.getByRole('tab', { name: /Positions/ }).click();
        await page.getByRole('alert').getByText('The position was not closed: The price moved past your slippage tolerance.').waitFor({ timeout: 5_000 });
        await row.getByRole('button', { name: /Close/ }).waitFor();
        assert.equal(await rows.count(), 2, 'the position left although the close was canceled');
        await row.getByRole('button', { name: /Close/ }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm close' }).click();
        await row.getByRole('status').getByText('Closing…').waitFor({ timeout: 1_500 });
        await expectEventually(async () => await rows.count() === 1, 'the closed position stayed', 6_000);
      } finally {
        state.closeDelayMs = 1_000;
        state.cancelNextClose = null;
      }
    });

    await check('market heading: funding and borrow rates per side, with the 8h and yearly figures on hover, at 1200 px and 1440 px', async () => {
      for (const width of [1200, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const metrics = page.locator('.market-heading .rate-metric');
        await metrics.first().waitFor({ state: 'visible' });
        assert.equal(await metrics.count(), 2);
        for (let i = 0; i < 2; i += 1) assert.ok(await metrics.nth(i).isVisible(), `rate metric ${i} hidden at ${width}px`);
        assert.deepEqual(await metrics.allInnerTexts(), ['Funding / h\nL +0.0012% · S -0.0009%', 'Borrow / h\nL 0.0008% · S 0.0000%']);
        assert.equal(await metrics.first().locator('strong').getAttribute('title'), 'Longs pay when positive, shorts when negative. Per 8h: L +0.0096% · S -0.0072% · per year: L +10.5120% · S -7.8840%');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `horizontal overflow of ${overflow}px at ${width}px`);
      }
      await page.setViewportSize({ width: 1920, height: 1080 });
    });

    await check('stream outage: reconnecting, offline, trading paused, then recovery, which re-reads the market rows the outage missed', async () => {
      const catalog = []; // /v1/markets requests: the rows only travel on the stream when they change, so one once it is back
      const seen = request => { if (new URL(request.url()).pathname === '/v1/markets') catalog.push(Date.now()); };
      page.on('request', seen);
      try {
        await page.goto(`${siteUrl}/#/trade/practice`);
        const footer = page.locator('.app-footer');
        await footer.getByText('Live data connected').waitFor();
        state.streamUp = false;
        for (const s of state.streams) s.res.destroy();
        await footer.getByText('Reconnecting to live data…').waitFor();
        await footer.getByText('Offline · retrying').waitFor({ timeout: 10_000 });
        assert.ok(await page.locator('.order-submit').first().isDisabled(), 'orders can be submitted while offline');
        await page.getByText('Price updates paused').first().waitFor();
        const before = catalog.length; // whatever the page load asked for has long been sent
        state.streamUp = true;
        await footer.getByText('Live data connected').waitFor({ timeout: 15_000 });
        await expectEventually(() => catalog.length === before + 1, `the market rows were not re-read once the stream was back (${catalog.length - before} requests)`);
      } finally {
        page.off('request', seen);
      }
    });

    await check('a slow stream start waits for prices without calling them paused', async () => {
      state.streamDelayMs = 3_000;
      await page.reload();
      const footer = page.locator('.app-footer');
      await footer.getByText('Connecting to live data…').waitFor();
      await page.getByText('Waiting for live prices before you can submit.').first().waitFor();
      assert.ok(await page.locator('.order-submit').first().isDisabled(), 'orders can be submitted before prices arrive');
      assert.equal(await page.getByText('Price updates paused').count(), 0, 'a first connection is shown as paused');
      await footer.getByText('Live data connected').waitFor({ timeout: 10_000 });
      assert.equal(await page.getByText('Waiting for live prices before you can submit.').count(), 0);
      state.streamDelayMs = 0;
    });

    await check('search: a trader by wallet address shows accounts, open positions, recent trades and payouts; a position\'s market opens in the terminal', async () => {
      await page.goto(`${siteUrl}/#/search`);
      await page.getByLabel('Search a trader').fill(keys[0].address);
      await page.getByRole('button', { name: 'Search trader' }).click();
      await page.waitForURL(`**/#/search?trader=${keys[0].address}`);
      const results = main.locator('.trader-results');
      const section = name => results.locator('section.surface', { has: page.locator('h2', { hasText: new RegExp(`^${name}$`) }) });
      await section('Accounts').getByText('Funded', { exact: true }).waitFor();
      assert.equal(await results.locator('.trader-address code').innerText(), keys[0].address);
      assert.equal(await section('Accounts').locator('tbody tr').count(), w.accounts.length);
      await section('Open positions').locator('tbody tr').filter({ hasText: 'SOL / USD' }).getByText('+$192.52').waitFor();
      await section('Recent trades').locator('tbody tr').filter({ hasText: 'XAU / USD' }).getByText('+$36.20').waitFor();
      assert.equal(await section('Payouts').locator('tbody tr').filter({ hasText: 'Paid' }).count(), w.payouts.length);
      await section('Payouts').getByRole('link', { name: 'Transaction' }).first().waitFor(); // the fixture payout paid onchain
      await section('Open positions').getByRole('button', { name: /SOL \/ USD/ }).click();
      await page.waitForURL('**/#/trade/*');
      await page.locator('.market-select strong', { hasText: /^SOL/ }).waitFor();
    });

    await check('search: an address nobody traded from says so, and a malformed one is refused before the API is asked', async () => {
      const asked = []; // addresses sent to /v1/traders
      const seen = request => { const url = new URL(request.url()); if (url.pathname.startsWith('/v1/traders/')) asked.push(decodeURIComponent(url.pathname.slice('/v1/traders/'.length))); };
      page.on('request', seen);
      try {
        await page.goto(`${siteUrl}/#/search?trader=${keys[3].address}`);
        await main.getByRole('heading', { name: 'No trader with this address' }).waitFor();
        await page.getByLabel('Search a trader').fill('PT-002841');
        await page.getByRole('button', { name: 'Search trader' }).click();
        await main.getByRole('status').getByText('“PT-002841” is not a Solana address.').waitFor();
        assert.deepEqual(asked, [keys[3].address], 'a malformed address reached the API');
      } finally {
        page.off('request', seen);
      }
    });

    await check('wallet dialog: the whole address, a copy that says so, and its explorer page', async () => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.goto(`${siteUrl}/#/accounts`);
      await page.locator('.wallet-button').click();
      const address = page.getByRole('dialog', { name: 'Your wallet' }).locator('.full-address');
      assert.equal(await address.locator('code').innerText(), keys[0].address);
      assert.equal(await address.getByRole('link', { name: 'Explorer' }).getAttribute('href'), `https://explorer.solana.com/address/${keys[0].address}`);
      await address.getByRole('button', { name: 'Copy', exact: true }).click();
      await address.getByRole('button', { name: 'Copied', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), keys[0].address);
      await page.keyboard.press('Escape');
    });

    await check('markets page: funding and borrow rate columns per side; the picker row shows the funding rates', async () => {
      await page.goto(`${siteUrl}/#/markets`);
      const rows = page.locator('.markets-table tbody tr');
      await rows.first().waitFor();
      const headers = await page.locator('.markets-table thead th').allInnerTexts();
      assert.ok(headers.includes('Funding / h (L/S)') && headers.includes('Borrow / h (L/S)'), `columns: ${headers.join(' | ')}`);
      const btc = rows.filter({ hasText: 'BTC / USD' });
      await btc.getByText('+0.0012% / -0.0009%').waitFor();
      await btc.getByText('0.0008% / 0.0000%').waitFor();
      assert.equal(await btc.locator('.rates-cell').first().getAttribute('title'), 'Longs pay when positive, per hour; ×8 for 8h, ×8760 for a year');
      await page.keyboard.press('Control+k');
      const dialog = page.getByRole('dialog', { name: 'Find a market' });
      await dialog.locator('.picker-row').filter({ hasText: 'BTC / USD' }).getByText('F +0.0012% / -0.0009%').waitFor();
      await page.keyboard.press('Escape');
    });

    await check('white label: no terminal state, tab, dialog or page names the venue (text, title, meta, labelling attributes, links)', async () => {
      const found = [];
      const sweep = async where => { for (const hit of await brandLeaks(page)) found.push(`${where} · ${hit}`); };
      const dialog = page.getByRole('dialog');
      const inDialog = async (where, open) => { await open(); await dialog.first().waitFor(); await sweep(where); await page.keyboard.press('Escape'); await dialog.first().waitFor({ state: 'detached' }); };
      const ticket = page.locator('.order-panel');
      const btc = state.markets.find(m => m.symbol === 'BTC');
      for (const stage of ['evaluation', 'funded']) {
        await page.goto(`${siteUrl}/#/trade/${stage}`);
        await showMarket('BTC');
        const row = page.locator('.position-table tbody tr').first();
        await row.waitFor();
        await page.locator('.price-chart canvas').first().waitFor();
        await openDetails(); // the sweep reads rendered text: the Order details rows too
        await sweep(`${stage} terminal`);
        await page.locator('.trade-feed').getByRole('tab', { name: 'Liquidity' }).click();
        await sweep(`${stage} liquidity`);
        await page.locator('.trade-feed').getByRole('tab', { name: 'Recent trades' }).click();
        await inDialog(`${stage} close`, () => row.getByRole('button', { name: /^Close/ }).click());
        await inDialog(`${stage} protection`, () => row.locator('.position-protection').click());
        await inDialog(`${stage} slippage`, () => ticket.locator('.execution-details').getByRole('button', { name: /%/ }).click());
        await inDialog(`${stage} chart`, () => page.getByRole('button', { name: 'Indicators', exact: true }).click());
        await page.getByRole('tab', { name: /^Open orders/ }).click();
        await sweep(`${stage} open orders`);
        await page.getByRole('tab', { name: 'Trade history' }).click();
        await page.getByRole('button', { name: /^View trade/ }).first().waitFor();
        await sweep(`${stage} trade history`);
        await inDialog(`${stage} trade record`, () => page.getByRole('button', { name: /^View trade/ }).first().click());
        await page.getByRole('tab', { name: /^Positions/ }).click();
        // A price that is not live (the chart's overlay, the funded ticket's refusal), with and without a last update.
        for (const market of [{ ...btc, freshness: 'unavailable', updatedAt: null }, { ...btc, freshness: 'stale', updatedAt: Date.now() - 60_000 }]) {
          stub.publish({ type: 'market', market });
          await page.locator('.stale-overlay').waitFor();
          await sweep(`${stage} ${market.freshness} price`);
        }
        stub.publish({ type: 'market', market: { ...btc, updatedAt: Date.now() } });
        await page.locator('.stale-overlay').waitFor({ state: 'detached' });
        // A market whose session is closed.
        await page.keyboard.press('Control+k');
        await page.getByRole('dialog', { name: 'Find a market' }).getByRole('button', { name: /^NVDA/ }).click();
        await ticket.getByText(/is closed\./).waitFor();
        await sweep(`${stage} closed market`);
        await showMarket('BTC');
      }
      for (const [where, open] of [
        ['market picker', () => page.keyboard.press('Control+k')],
        ['account switcher', () => page.locator('.active-account').click()],
        ['wallet', () => page.locator('.wallet-button').click()],
        ['rules', () => page.locator('footer').getByRole('button', { name: 'Rules' }).click()],
        ['help', () => page.locator('footer').getByRole('button', { name: 'Help' }).click()],
        ['notifications', () => page.locator('header').getByRole('button', { name: /^Notifications/ }).click()],
      ]) await inDialog(where, open);
      await page.goto(`${siteUrl}/#/settings`);
      for (const section of ['Preferences', 'Notifications', 'Wallet & session']) { await page.locator('.settings-nav').getByRole('button', { name: section }).click(); await sweep(`settings ${section}`); }
      await page.goto(`${siteUrl}/#/activity`);
      for (const tab of ['All activity', 'Trades', 'Payouts', 'Account']) { await page.getByRole('tab', { name: tab, exact: true }).click(); await sweep(`activity ${tab}`); }
      await page.goto(`${siteUrl}/#/search?trader=${keys[0].address}`);
      await main.locator('.trader-results').waitFor();
      await sweep('search: a trader');
      await page.getByLabel('Search verification records').fill(w.funded);
      await page.getByRole('button', { name: 'Find record' }).click();
      await main.getByText('Funded account activated').waitFor();
      await sweep('search: a record');
      await inDialog('search: evidence', () => main.getByRole('button', { name: 'Inspect record' }).click());
      await page.goto(`${siteUrl}/#/vault`);
      await inDialog('vault ledger record', () => main.getByRole('button', { name: 'Inspect Seed capital added' }).click());
      await page.goto(`${siteUrl}/#/markets`);
      await page.locator('.markets-table tbody tr').first().waitFor();
      await sweep('markets');
      assert.deepEqual(found, [], `the venue is named:\n${found.join('\n')}`);
    });

    await check('no unexpected console errors during the data and transaction flows', async () => {
      const found = errors.splice(0);
      assert.equal(found.length, 0, `console errors: ${found.join(' | ')}`);
    });
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => site.httpServer.close(resolve));
  stub.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
