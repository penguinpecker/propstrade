// Full-stack rehearsal: the production app build in Chrome, driven by a Wallet Standard test wallet, against the real
// server, Postgres and a solana-test-validator running the mainnet GMTrade binary (scripts/local-stack.ts). Every step
// asserts what the UI shows against the database rows and onchain accounts behind it.
//
//   export PATH=$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH
//   LOCAL_STACK_DATABASE_URL=postgres://…/props_fullstack_test node app/tests/fullstack.e2e.mjs   (LOCAL_STACK_PORT moves the ports)
//
// The evaluation is decided on a pinned BTC price path (the server's NODE_ENV=test price hook): live prices cannot make
// a pass deterministic. Everything else trades at live GMTrade prices. GMTrade keepers do not run locally, so the
// funded order stays pending until it is canceled. FULLSTACK_SHOTS=<dir> saves a screenshot after every step.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  PropsVaultClient, USDC_MINT, capitalVaultAddress, enumName, evaluationPda, feeVaultPda, fundedPda, isPendingGmOrder, ownerUsdcAddress,
  solTreasuryPda, toMicro, traderProfilePda,
} from '@props/sdk';
import postgres from 'postgres';
import { chromium } from 'playwright';
import { startLocalStack, TEST_TIER } from '../../scripts/local-stack.ts';
import { exposeSigner, installTestWallet, testKeys } from './wallet.mjs';

const databaseUrl = process.env.LOCAL_STACK_DATABASE_URL;
if (!databaseUrl) throw new Error('set LOCAL_STACK_DATABASE_URL to a disposable Postgres database (its name must contain _test)');

const [trader] = testKeys(1);
const adminToken = randomBytes(32).toString('hex');
const short = address => `${address.slice(0, 4)}…${address.slice(-4)}`;
/** Micro-USD (bigint) as the app formats dollars. */
const usd = micro => `$${(Number(micro) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(what, fn, timeout = 30_000) {
  for (const end = Date.now() + timeout; ; await sleep(500)) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
}

const stack = await startLocalStack({ databaseUrl, trader: new PublicKey(trader.address), adminToken, log: line => console.log(`  [stack] ${line}`) });
const sql = postgres(stack.databaseUrl, { max: 2, onnotice: () => {} });
const connection = new Connection(stack.rpcUrl, 'confirmed');
const vault = new PropsVaultClient(connection);
const api = async (method, path, body) => {
  const res = await fetch(stack.apiUrl + path, {
    method, headers: { authorization: `Bearer ${adminToken}`, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
};
const tokenBalance = async address => BigInt((await connection.getTokenAccountBalance(address)).value.amount);
const walletUsdc = (await connection.getTokenAccountsByOwner(new PublicKey(trader.address), { mint: USDC_MINT })).value[0].pubkey;

const browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await exposeSigner(context, [trader]);
await context.addInitScript(installTestWallet, { accounts: [{ address: trader.address, publicKey: trader.publicKey }] });
const page = await context.newPage();
const errors = [];
// Expected: the signed-out /v1/me (401), and GMTrade's own candle and trade services failing upstream now and then (the
// server answers 503 for candles it has nothing to show for after 4 s, 502 for trades after 5 s; the app shows its
// unavailable state).
const expected = msg => /status of 401/.test(msg.text()) && msg.location().url.endsWith('/v1/me')
  || /status of 50[23]/.test(msg.text()) && /\/v1\/(candles|markets\/\w+\/trades)\b/.test(msg.location().url);
page.on('console', msg => { if (msg.type() === 'error' && !expected(msg)) errors.push(`${msg.text()} (${msg.location().url})`); });
page.on('pageerror', error => errors.push(error.message));
const main = page.locator('#main');
const app = stack.appUrl;
const evaluation = evaluationPda(new PublicKey(trader.address), 0);
const funded = fundedPda(evaluation);
const facts = {};

let failed = false;
async function step(name, fn) {
  if (failed) return;
  const started = Date.now();
  const shot = outcome => process.env.FULLSTACK_SHOTS
    && page.screenshot({ path: `${process.env.FULLSTACK_SHOTS}/${outcome}-${name.replace(/\W+/g, '-').slice(0, 50)}.png`, fullPage: true }).catch(() => undefined);
  try {
    await fn();
    console.log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    await shot('pass');
  } catch (error) {
    failed = true;
    console.log(`FAIL ${name}\n     ${error.stack.split('\n').slice(0, 6).join('\n     ')}`);
    await shot('fail');
    console.log(`     server log (last lines of ${stack.serverLog}):\n${readFileSync(stack.serverLog, 'utf8').trim().split('\n').slice(-15).map(l => `       ${l.slice(0, 400)}`).join('\n')}`);
  }
}
/** Chooses a market from the market directory; the trading page for `stage` then shows it. */
async function selectMarket(symbol, stage) {
  await page.goto(`${app}/#/markets`);
  await page.getByLabel('Search market directory').fill(symbol);
  await page.locator('.markets-table tbody tr').filter({ hasText: `${symbol} / USD` }).locator('.market-name-button').click();
  await page.goto(`${app}/#/trade/${stage}`);
  await page.locator('.market-select').getByText(`${symbol} / USD`).waitFor();
}

try {
  await step('1 connect a wallet and Sign-In With Solana', async () => {
    await page.goto(`${app}/#/connect`);
    await page.getByRole('button', { name: /Props Test Wallet/ }).click();
    await page.waitForURL('**/#/checkout');
    await page.locator('.wallet-button').getByText(short(trader.address)).waitFor();
    const sessions = await sql`select n.message, n.used_at from sessions s join auth_nonces n on n.wallet = s.wallet where s.wallet = ${trader.address}`;
    assert.equal(sessions.length, 1, 'one session, from a used sign-in nonce');
    assert.ok(sessions[0].used_at);
    assert.ok(sessions[0].message.startsWith(`${new URL(app).host} wants you to sign in with your Solana account:\n${trader.address}\n`));
    assert.match(sessions[0].message, /^Chain ID: localnet$/m);
    await main.getByText(`Props Test Wallet · ${short(trader.address)}`).waitFor();
  });

  await step('2 markets list shows the live GMTrade markets and the onchain allowlist', async () => {
    await page.goto(`${app}/#/markets`);
    const rows = page.locator('.markets-table tbody tr');
    await rows.first().waitFor();
    // The keeper stream takes a moment after startup (prices are polled meanwhile, shown as delayed).
    const markets = await until('streamed GMTrade prices', async () => {
      const list = await (await fetch(`${stack.apiUrl}/v1/markets`)).json();
      const live = list.filter(m => m.freshness === 'live' && Date.now() - m.updatedAt < 60_000 && Number(m.price) > 0);
      return live.length >= list.length / 2 && list;
    }, 60_000);
    assert.ok(markets.length >= 55, `${markets.length} markets`);
    assert.equal(await rows.count(), markets.length);
    assert.deepEqual(markets.filter(m => m.tradable).map(m => m.symbol).sort(), ['BTC', 'ETH', 'SOL', 'XAU']);
    const sol = rows.filter({ hasText: 'SOL / USD' }).first();
    await sol.getByText('Crypto', { exact: false }).waitFor();
    // A fresh wallet has only a practice account, so the terminal is in the practice stage, where every listed market
    // (all have a USDC-only pool) is tradable: no restriction label. The funded-stage labels are checked in step 7.
    const doge = rows.filter({ hasText: 'DOGE / USD' });
    await doge.getByText('Dogecoin', { exact: false }).waitFor();
    assert.equal(await doge.getByText('Not available', { exact: false }).count(), 0, 'a practice-stage market shows a funded restriction');
  });

  await step('3 practice market order fills at a live price, then closes', async () => {
    // The exchange's pools are the counterparty on every stage: when SOL longs have no room (capacity 0, as on 2026-10-05) the
    // practice order goes short instead; a $100 order fits the 1,000 USD practice account either way.
    const sol = await (await fetch(`${stack.apiUrl}/v1/markets/SOL`)).json();
    const side = Number(sol.maxSizeLong ?? 0) >= 100 ? 'Buy / Long' : 'Sell / Short';
    assert.ok(side === 'Buy / Long' || Number(sol.maxSizeShort ?? 0) >= 100, 'SOL has no room either way for a $100 order right now');
    await selectMarket('SOL', 'practice');
    await page.getByLabel('Order size in USD').fill('100');
    await page.locator('.order-panel').getByRole('button', { name: `${side} SOL` }).click();
    await page.locator('.order-panel').getByText('Simulated order filled at the live price.').waitFor({ timeout: 20_000 });
    const [fill] = await sql`select f.price from sim_fills f where f.account_id = ${`practice:${trader.address}`} and f.is_increase`;
    const live = await (await fetch(`${stack.apiUrl}/v1/markets/SOL`)).json();
    assert.ok(Math.abs(Number(fill.price) / Number(live.price) - 1) < 0.01, `filled at ${fill.price}, live ${live.price}`);
    const row = page.locator('.position-table tbody tr').filter({ hasText: 'SOL / USD' });
    await row.getByRole('button', { name: /Close/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm close' }).click();
    await row.waitFor({ state: 'detached', timeout: 20_000 });
    const [trade] = await sql`select net_pnl from closed_trades where account_id = ${`practice:${trader.address}`}`;
    assert.ok(trade, 'round trip recorded');
    await page.getByRole('tab', { name: 'Trade history' }).click();
    await page.locator('.table-scroll tbody tr').filter({ hasText: 'SOL / USD' }).first().waitFor();
  });

  await step('4 checkout: buy_evaluation confirms, the indexer creates the evaluation, the UI shows it', async () => {
    const feeVaultBefore = await tokenBalance(feeVaultPda());
    await page.goto(`${app}/#/get-funded`);
    await page.getByRole('button', { name: '$1K' }).last().click(); // tiers are listed by id: the spec 1K tier (id 1) then the 1,000 USD rehearsal tier (TEST_TIER, id 9), both labelled by size
    await page.getByRole('button', { name: 'Choose 1K account' }).click();
    await page.getByRole('button', { name: 'Continue with this account' }).click();
    await page.goto(`${app}/#/checkout`);
    await main.getByText('1.00 USDC').first().waitFor();
    await page.getByLabel(/I have read the evaluation rules/).check();
    await page.getByRole('button', { name: 'Pay 1.00 USDC' }).click();
    await page.waitForURL('**/#/payment?sig=*');
    await main.getByText('Payment complete').waitFor({ timeout: 30_000 });
    const onchain = await vault.fetch('evaluation', evaluation);
    assert.equal(enumName(onchain.status), 'active');
    assert.equal(onchain.tierId, TEST_TIER.id);
    assert.equal(await tokenBalance(feeVaultPda()) - feeVaultBefore, toMicro(TEST_TIER.feeUsdc));
    assert.equal(await tokenBalance(walletUsdc), toMicro('99'));
    const [row] = await sql`select e.status, a.stage, a.label from evaluations e join accounts a on a.id = e.address where e.address = ${evaluation.toBase58()}`;
    assert.deepEqual({ ...row }, { status: 'active', stage: 'evaluation', label: 'Evaluation 1K' });
    await main.getByRole('button', { name: 'Open your evaluation' }).click();
    await page.waitForURL('**/#/trade/evaluation');
    await page.locator('.account-strip').getByText('Evaluation 1K').waitFor();
  });

  await step('5 the evaluation trades to a pass and record_evaluation_result lands onchain', async () => {
    // The exchange's pools are the counterparty: a side with no room (capacity 0, as BTC longs on 2026-10-03) refuses
    // the order on every stage, so the step trades the launch market with the most room for a long.
    const launch = (await (await fetch(`${stack.apiUrl}/v1/markets`)).json()).filter(m => ['BTC', 'ETH', 'SOL', 'XAU'].includes(m.symbol) && Number(m.maxSizeLong ?? 0) >= 1_000);
    assert.ok(launch.length, 'no launch market has room for a $200 long right now');
    const sym = launch.sort((x, y) => Number(y.maxSizeLong) - Number(x.maxSizeLong))[0].symbol;
    const entry = Math.round(Number(launch[0].price));
    await api('PUT', `/v1/test/prices/${sym}`, { price: String(entry) });
    await selectMarket(sym, 'evaluation');
    await page.getByLabel('Order size in USD').fill('200');
    await page.locator('.order-panel').getByRole('button', { name: `Buy / Long ${sym}` }).click();
    await page.locator('.order-panel').getByText('Simulated order filled at the live price.').waitFor({ timeout: 20_000 });
    const [open] = await sql`select price from sim_fills where account_id = ${evaluation.toBase58()} and is_increase`;
    assert.ok(Math.abs(Number(open.price) / entry - 1) < 0.001, `opened at ${open.price}, pinned ${entry}`);
    await api('PUT', `/v1/test/prices/${sym}`, { price: String(Math.round(entry * 1.01)) });
    const row = page.locator('.position-table tbody tr').filter({ hasText: `${sym} / USD` });
    await row.getByRole('button', { name: /Close/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm close' }).click();
    await row.waitFor({ state: 'detached', timeout: 20_000 });
    await api('PUT', `/v1/test/prices/${sym}`, { price: null });
    const [result] = await until('the evaluation result', () => sql`select passed, final_equity, recorded_signature from sim_results where evaluation = ${evaluation.toBase58()} and recorded_signature is not null`.then(r => r.length && r), 60_000);
    assert.equal(result.passed, true);
    const [job] = await sql`select status, signature from chain_jobs where kind = 'record_evaluation_result' and subject = ${evaluation.toBase58()}`;
    assert.equal(job.status, 'confirmed');
    const onchain = await vault.fetch('evaluation', evaluation);
    assert.equal(enumName(onchain.status), 'passed');
    assert.equal(BigInt(onchain.finalEquity.toString()), toMicro(result.final_equity));
    assert.ok(BigInt(onchain.finalEquity.toString()) >= toMicro('1001'), 'final equity reached the 1 USD target');
    facts.resultSignature = job.signature;
    // Notices name the account they are about: its route carries the id, its text the label and short id.
    const notices = await sql`select title, body, href from notifications where wallet = ${trader.address} and title in (${'Long ' + sym + ' opened'}, 'Evaluation passed')`;
    const byTitle = Object.fromEntries(notices.map(n => [n.title, n]));
    assert.equal(byTitle[`Long ${sym} opened`].href, `/account/evaluation?id=${evaluation.toBase58()}`);
    assert.match(byTitle[`Long ${sym} opened`].body, new RegExp(`^Evaluation 1K PT-${evaluation.toBase58().slice(0, 4)}…: \\$200\\.00 at [\\d,]+\\.\\d+, P&L [+−]\\$\\d+\\.\\d{2} \\(simulated\\)$`));
    assert.equal(byTitle['Evaluation passed'].href, `/result?id=${evaluation.toBase58()}`);
    await page.goto(`${app}/#/result`);
    await main.getByText('Evaluation passed', { exact: true }).waitFor();
    await main.getByText('Result recorded', { exact: true }).waitFor();
    // Only once the indexer has the record_evaluation_result transaction, linked.
    const recorded = main.locator('.result-check').filter({ hasText: 'Result recorded' });
    await recorded.getByText('Written to the evaluation account onchain').waitFor({ timeout: 20_000 });
    assert.ok((await recorded.getByRole('link', { name: /View transaction/ }).getAttribute('href')).includes(job.signature));
    await main.getByText(usd(BigInt(onchain.finalEquity.toString())), { exact: true }).waitFor();
  });

  await step('6 KYC: start, admin approves an identity hash, set_identity lands onchain', async () => {
    await page.goto(`${app}/#/activate`);
    await page.getByLabel('Country of residence').selectOption('DE');
    await page.getByRole('button', { name: 'Start identity review' }).click();
    const identity = main.locator('.data-row').filter({ hasText: 'Identity review' });
    await identity.getByText('In review', { exact: true }).waitFor();
    const [request] = (await api('GET', '/v1/admin/kyc?status=pending')).filter(r => r.wallet === trader.address);
    assert.equal(request.country, 'DE');
    const identityHash = createHash('sha256').update(`fullstack-identity:${trader.address}`).digest('hex');
    await api('POST', `/v1/admin/kyc/${request.id}/approve`, { identityHash, country: 'DE' });
    await until('set_identity to confirm', () => sql`select 1 from chain_jobs where kind = 'set_identity' and status = 'confirmed' and payload->>'wallet' = ${trader.address}`.then(r => r.length), 60_000);
    const profile = await vault.fetch('traderProfile', traderProfilePda(new PublicKey(trader.address)));
    assert.equal(Buffer.from(profile.identityHash).toString('hex'), identityHash);
    // The indexed identitySet event notifies the trader; the page follows without a reload.
    await identity.getByText('Verified', { exact: true }).waitFor({ timeout: 20_000 });
    const [notice] = await sql`select href from notifications where wallet = ${trader.address} and title = 'Identity verified'`;
    assert.equal(notice.href, '/activate');
  });

  await step('7 activation: activate_funded confirms and the funded account appears with its principal posted', async () => {
    const capitalBefore = await tokenBalance(capitalVaultAddress());
    await page.getByRole('button', { name: 'Activate funded account' }).click();
    await page.waitForURL('**/#/account/funded', { timeout: 60_000 }); // the page opens the new account once it is indexed
    await main.getByRole('heading', { name: 'Funded 1K' }).waitFor();
    const principal = toMicro(TEST_TIER.sizeUsd) * 1000n / 10_000n; // the 10 % allowance every tier shares (upsert-tiers.ts RULES)
    const account = await vault.fetchFunded(funded);
    assert.equal(enumName(account.status), 'active');
    assert.equal(BigInt(account.principal.toString()), principal);
    assert.equal(await tokenBalance(ownerUsdcAddress(funded)), principal);
    assert.equal(capitalBefore - await tokenBalance(capitalVaultAddress()), principal);
    const [row] = await sql`select principal, status, activation_signature from funded_accounts where address = ${funded.toBase58()}`;
    assert.equal(Number(row.principal), 100);
    assert.equal(row.status, 'active');
    facts.activationSignature = row.activation_signature;
    const stat = label => main.locator('.stat').filter({ has: page.locator('.stat-label', { hasText: label }) }).locator('strong');
    await stat('Remaining loss allowance').getByText('$100.00').waitFor(); // the 10 % allowance of the 1,000 USD test tier
    await stat('Account equity').getByText('$1,000.00').waitFor();
    // In the funded stage the markets page shows the onchain allowlist: DOGE has no MarketConfig, SOL does.
    await page.goto(`${app}/#/markets`);
    const marketRows = page.locator('.markets-table tbody tr');
    await marketRows.filter({ hasText: 'DOGE / USD' }).getByText('Not available for funded trading').waitFor();
    assert.equal(await marketRows.filter({ hasText: 'SOL / USD' }).first().getByText('Not available', { exact: false }).count(), 0);
    await page.goto(`${app}/#/account/funded`);
    await main.getByRole('heading', { name: 'Funded 1K' }).waitFor();
  });

  await step('8 funded open with TP + SL creates real GMTrade orders; canceled through the UI, the keeper and indexer clear them', async () => {
    await selectMarket('SOL', 'funded');
    const sol = await (await fetch(`${stack.apiUrl}/v1/markets/SOL`)).json();
    const price = Number(sol.price);
    const long = Number(sol.maxSizeLong ?? 0) >= 50; // the side with room on the exchange (SOL longs had none on 2026-10-05)
    await page.getByLabel('Order size in USD').fill('50');
    await page.locator('.order-panel').getByLabel('Take profit price').fill(String(Math.round(price * (long ? 1.2 : 0.8))));
    await page.locator('.order-panel').getByLabel('Stop loss price').fill(String(Math.round(price * (long ? 0.8 : 1.2))));
    await page.locator('.order-panel').getByRole('button', { name: `${long ? 'Buy / Long' : 'Sell / Short'} SOL` }).click();
    await page.locator('.order-panel').getByRole('status').getByText('Awaiting execution…').waitFor({ timeout: 30_000 });
    const tracked = (await vault.fetchFunded(funded)).orders.filter(o => !o.order.equals(PublicKey.default));
    assert.equal(tracked.length, 3, 'open + take profit + stop loss tracked onchain');
    for (const o of tracked) {
      const info = await connection.getAccountInfo(o.order);
      assert.ok(info && isPendingGmOrder(info.data), `GMTrade holds ${o.order.toBase58()} as pending`);
    }
    await until('the indexer to record the orders', () => sql`select count(*)::int as n from gm_orders where funded_account = ${funded.toBase58()}`.then(([r]) => r.n === 3));
    await page.getByRole('tab', { name: /Open orders/ }).click();
    const orderRows = page.locator('.positions-panel tbody tr');
    await until('three open orders in the UI', async () => (await orderRows.count()) === 3);
    await orderRows.filter({ hasText: `${long ? 'Long' : 'Short'} · Market` }).getByRole('button', { name: 'Cancel' }).click();
    await page.getByText('Order canceled on the exchange.').waitFor({ timeout: 30_000 });
    await page.locator('.order-panel').getByRole('status').waitFor({ state: 'detached' }); // the ticket stops waiting for an execution
    assert.equal(await page.locator('.order-panel').getByText(/did not execute/).count(), 0, 'a trader cancel is not reported as a venue failure');
    await until('every tracked order to be gone onchain', async () => (await vault.fetchFunded(funded)).orders.every(o => o.order.equals(PublicKey.default)), 90_000);
    for (const o of tracked) assert.equal(await connection.getAccountInfo(o.order), null, `order ${o.order.toBase58()} closed`);
    await main.getByText('No working orders').waitFor({ timeout: 30_000 });
    assert.equal(await tokenBalance(ownerUsdcAddress(funded)), toMicro('100'), 'the collateral came back to the owner account'); // the whole 100 USDC principal
    const statuses = await sql`select kind, status from gm_orders where funded_account = ${funded.toBase58()} order by kind`;
    assert.ok(statuses.every(s => s.status === 'canceled'), JSON.stringify(statuses));
  });

  await step('9 verify finds the evaluation, the funded account and their transactions', async () => {
    const [e] = await sql`select purchase_signature, result_signature from evaluations where address = ${evaluation.toBase58()}`;
    const search = async (q, kind, badge, signatures) => {
      const result = await (await fetch(`${stack.apiUrl}/v1/verify?q=${q}`)).json();
      assert.equal(result.kind, kind, q);
      const confirmed = result.items.filter(i => i.state === 'confirmed');
      for (const signature of signatures) assert.ok(confirmed.some(i => i.signature === signature), `${q}: no confirmed record of ${signature}`);
      await page.goto(`${app}/#/verify`);
      await page.getByLabel('Search verification records').fill(q);
      await page.getByRole('button', { name: 'Find record' }).click();
      await main.locator('.verify-search-result').getByText(`${result.items.length} ${result.items.length === 1 ? 'record' : 'records'} · ${confirmed.length} confirmed onchain`).waitFor();
      await main.locator('.verification-record .badge').getByText(badge, { exact: true }).waitFor();
      for (const item of result.items) await main.locator('.proof-timeline h3').getByText(item.title, { exact: true }).first().waitFor();
    };
    await search(evaluation.toBase58(), 'evaluation', 'Evaluation', [e.purchase_signature, e.result_signature]);
    // The trades root recorded onchain, recomputed in the browser from the evaluation's public fill list.
    const passed = main.locator('.proof-timeline > div').filter({ has: page.locator('h3', { hasText: 'Evaluation passed' }) });
    await passed.getByRole('button', { name: /Recompute trades root/ }).click();
    await passed.getByText(/^Matches the recorded trades root: recomputed here from 2 fills\.$/).waitFor({ timeout: 20_000 });
    const anonymous = await fetch(`${stack.apiUrl}/v1/sim/${evaluation.toBase58()}/fills`);
    assert.equal(anonymous.status, 200, 'the fill list is public once the result is onchain');
    await search(funded.toBase58(), 'funded', 'Funded account', [facts.activationSignature]);
    await search(facts.activationSignature, 'transaction', 'Transaction', [facts.activationSignature]);
  });

  await step('10 vault page matches the onchain balances', async () => {
    const [capital, fee, config] = await Promise.all([tokenBalance(capitalVaultAddress()), tokenBalance(feeVaultPda()), vault.fetchConfig()]);
    const allocated = BigInt(config.allocatedPrincipal.toString());
    await page.goto(`${app}/#/vault`);
    const stat = label => main.locator('.stat').filter({ has: page.locator('.stat-label', { hasText: label }) }).locator('strong');
    await stat('Capital vault').getByText(usd(capital + allocated)).waitFor();
    await stat('Allocated margin').getByText(usd(allocated)).waitFor();
    await stat('Unallocated reserve').getByText(usd(capital)).waitFor();
    await main.locator('.vault-allocation .data-row').filter({ hasText: 'Fee vault' }).getByText(usd(fee), { exact: true }).waitFor();
    const treasury = await connection.getBalance(solTreasuryPda());
    await main.locator('.vault-allocation .data-row').filter({ hasText: 'SOL treasury' }).getByText(`${(treasury / 1e9).toFixed(4)} SOL`, { exact: true }).waitFor();
    for (const [event, amount] of [['Capital deposited', '+1,000.00 USDC'], ['Evaluation fee', '+1.00 USDC'], ['Principal allocated', '−100.00 USDC']]) {
      await main.locator('tbody tr').filter({ hasText: event }).getByText(amount, { exact: true }).waitFor();
    }
    assert.equal(allocated, toMicro('100'));
    assert.equal(capital, toMicro('900')); // 1,000 deposited less the 100 USDC principal
  });

  await step('no unexpected console errors', async () => {
    assert.equal(errors.length, 0, `console errors: ${errors.join(' | ')}`);
  });
} finally {
  await browser.close();
  await sql.end();
  await stack.stop();
}

console.log(failed ? '\nThe full-stack journey failed' : '\nFull-stack journey passed');
process.exit(failed ? 1 : 0);
