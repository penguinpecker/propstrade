// Browser check of the production build (npm run test:e2e) against the test stub API + RPC (tests/stub.mjs), served with the
// Content-Security-Policy the Vercel middleware sends, so a console error from anything the policy blocks fails the check.
// 1. Renders every route at 1920x1080 and 390x844, signed in, in both themes (and signed out once), and fails on console
//    errors, horizontal overflow or missing landmarks.
// 2. Drives wallet connect + Sign-In With Solana, account switch, expiry, rejection, disconnect, wrong network, no wallet.
// 3. Drives the data and transaction flows: markets, live candles, a simulated order through fill and close, a funded
//    order built with @props/sdk, signed by the test wallet and sent to the stub RPC, checkout, payout request, verify,
//    vault, notifications, CSV export and the footer's live-stream states.
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
  '/payout/review', '/payout/receipt', '/verify', '/vault', '/settings'];

const stub = await startStub();
const { state } = stub;
const keys = testKeys(3);
const publicAccounts = list => list.map(({ address, publicKey }) => ({ address, publicKey }));
const short = address => `${address.slice(0, 4)}…${address.slice(-4)}`;

// ---------- build + serve the app against the stub ----------
Object.assign(process.env, { VITE_API_URL: stub.url, VITE_RPC_URL: `${stub.url}/rpc`, VITE_CLUSTER: 'mainnet-beta', VITE_PROGRAM_ID: PROGRAM_ID });
await build({ root: appDir, logLevel: 'error', build: { outDir, emptyOutDir: true } });
const csp = contentSecurityPolicy(process.env);
const site = await preview({ root: appDir, logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: 4198, headers: { 'content-security-policy': csp } } });
const siteUrl = site.resolvedUrls.local[0].replace(/\/$/, '');

// Expected console noise, all caused on purpose by the stub: anonymous /v1/me (401), the stream outage (503) and the
// candles of a saved market that is not in the catalog (404).
const expected = msg => /status of 401/.test(msg.text()) && msg.location().url.endsWith('/v1/me')
  || /503|ERR_INCOMPLETE_CHUNKED_ENCODING/.test(msg.text()) && (msg.location().url.endsWith('/v1/stream') || /EventSource/.test(msg.text()))
  || /status of 404/.test(msg.text()) && msg.location().url.includes('/v1/candles?symbol=ZZZ');
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
      await page.getByLabel('Search market directory').fill('fart');
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
      assert.deepEqual(await pairs(), ['BTC / USD', 'FARTCOIN / USD']);
      await chips.filter({ hasText: 'Meme' }).click();
      assert.deepEqual([await chips.filter({ hasText: 'Meme' }).getAttribute('aria-pressed'), await chips.first().getAttribute('aria-pressed')], ['true', 'false']);
      assert.deepEqual(await pairs(), ['FARTCOIN / USD']);
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
        assert.deepEqual(await position(), [0, true], 'a new chip opens at its top');
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

    await check('chart: GMTrade candles, OHLC of the last candle, and live ticks move it', async () => {
      await page.goto(`${siteUrl}/#/trade/practice`);
      await page.locator('.price-chart canvas').first().waitFor();
      await page.mouse.move(0, 0); // no crosshair: the legend shows the latest candle
      const legend = page.locator('.tv-legend-main');
      await legend.getByText('C64,482.00').waitFor();
      stub.publish({ type: 'price', ticks: [{ symbol: 'BTC', min: '64600', max: '64600', mid: '64600', ts: Date.now() + 1_000, session: 'open' }] });
      await legend.getByText('C64,600.00').waitFor();
      await page.locator('.market-price').getByText('64,600.00').waitFor();
      for (const interval of ['5m', '4h', '1D']) {
        await page.locator('.timeframes').getByRole('button', { name: interval, exact: true }).click();
        await legend.getByText(`BTC / USD · ${interval} · GMTrade`).waitFor();
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
      await page.locator('.tv-legend-main').getByText('BTC / USD · 1D · GMTrade').waitFor();
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
        await source.getByText("saved copy while GMTrade's charts recover").waitFor();
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
        await page.locator('.tv-legend-main').getByText('ETH / USD · 1h · GMTrade').waitFor({ timeout: 8_000 });
        assert.equal(await candles, 'ETH');
        await page.evaluate(() => localStorage.setItem('props.market', '"ZZZ"'));
        await page.reload();
        await page.locator('.tv-legend-main').getByText('BTC / USD · 1h · GMTrade').waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem('props.market')), '"BTC"');
      } finally {
        page.off('request', seen);
        await page.unroute('**/v1/markets');
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
        await legend.getByText('BTC / USD · 1h · GMTrade').waitFor();
        await expectEventually(() => ['ETH 1h', 'SOL 1h', 'XAU 1h'].every(k => asked.includes(k)), `the watchlist's candles were not prefetched: ${asked}`);
        stub.publish({ type: 'price', ticks: [{ symbol: 'BTC', min: '64650', max: '64650', mid: '64650', ts: Date.now() + 2_000, session: 'open' }] });
        await legend.getByText('C64,650.00').waitFor();
        const before = asked.length;
        await page.locator('.watchlist-bar').getByRole('button', { name: /^ETH/ }).click();
        await legend.getByText('ETH / USD · 1h · GMTrade').waitFor();
        await page.locator('.watchlist-bar').getByRole('button', { name: /^BTC/ }).click();
        await legend.getByText('BTC / USD · 1h · GMTrade').waitFor();
        assert.equal(asked.length, before, `a tick or a watchlist click fetched candles again: ${asked.slice(before)}`);
        await page.locator('.timeframes').getByRole('button', { name: '4h', exact: true }).click();
        await legend.getByText('BTC / USD · 4h · GMTrade').waitFor();
        await expectEventually(() => ['ETH 4h', 'SOL 4h', 'XAU 4h'].every(k => asked.includes(k)), `the watchlist's candles were not prefetched for the new interval: ${asked}`);
        assert.equal(asked.filter(k => k === 'ETH 1h').length, 1, `ETH 1h was fetched more than once: ${asked}`);
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
      await page.locator('.order-panel').getByText('Simulated order filled at the live GMTrade price.').waitFor({ timeout: 10_000 });
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
      await page.locator('.order-panel').getByText('BTC long executed on GMTrade.').waitFor({ timeout: 10_000 });
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
      await page.locator('.order-panel').getByText('BTC long executed on GMTrade.').waitFor({ timeout: 10_000 });
      assert.equal(state.signatures, before + 1);
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
      // FARTCOIN has no USDC-only pool: not in evaluations (their own copy), not in practice either.
      for (const [stage, copy] of [['evaluation', 'FARTCOIN is not available in evaluations: they trade only the markets funded accounts can.'], ['practice', 'FARTCOIN has no USDC-only pool on GMTrade, so it cannot be traded here.']]) {
        await page.goto(`${siteUrl}/#/trade/${stage}`);
        await page.locator('.order-panel').waitFor();
        await page.keyboard.press('Control+k');
        await page.getByRole('dialog', { name: 'Find a market' }).getByRole('button', { name: /^FARTCOIN/ }).click();
        await page.locator('.order-panel').getByText(copy).waitFor();
        assert.ok(await page.locator('.order-panel').getByRole('button', { name: /Buy \/ Long FARTCOIN/ }).isDisabled(), `${stage}: the order can still be submitted`);
      }
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

    await check('positions show where GMTrade liquidates them and the margin backing them', async () => {
      await page.goto(`${siteUrl}/#/trade/evaluation`); // Evaluation 25K, selected by the activity check
      const row = page.locator('.position-table tbody tr').filter({ hasText: 'SOL / USD' });
      await row.waitFor();
      assert.deepEqual(await page.locator('.position-table thead th').allTextContents(), ['Market / side', 'Position size', 'Entry price', 'Mark price', 'Liq. price', 'Unrealized P&L', 'TP / SL', '']);
      await row.getByText('98.12', { exact: true }).waitFor();
      await row.getByText('$4,600.00 · $1,533.33 margin').waitFor();
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
