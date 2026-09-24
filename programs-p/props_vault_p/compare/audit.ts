// The round-1 audit fixes compared byte for byte (see harness.ts): close_empty_position and collect_claimable (open and
// closed accounts, every refusal, account substitution and read-only flag, GMTrade refusing a Position that is not
// empty), update_order below $1, SPL token accounts and mints with malformed COption tags (also against the state and
// is_initialized bytes), and program accounts whose bool or enum bytes borsh refuses (tier, market config, evaluation,
// funded account slots and orders, payout request, config pauses; offsets checked with the SDK's decoder). Round 2:
// update_order on a resting limit increase in a disabled market or above the market's lowered limits.
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  GMTRADE_PROGRAM_ID, GMTRADE_STORE, USDC_MINT, capitalVaultAddress, configPda, eventAuthorityPda, evaluationPda, feeVaultPda, gmPositionPda,
  marketConfigPda, ownerUsdcAddress, payoutPda, solTreasuryPda, tierPda,
} from '@props/sdk';
import { compare, type Env } from './harness.ts';
import { FUNDED, type Funded, otherMint, setMarketClosed, setStatus, STATUS, tokenAccount, write } from './trading.ts';

type Market = 'SOL' | 'BTC' | 'ETH' | 'XAU' | 'NVDA' | 'EUR';

await compare(async ({ env: { Env, LEVERAGE, MAINNET_POSITIONS, MARKETS, TIERS, USD, hash32, marketParams, swapKey, tierParams, usdc }, send, snap, raw }) => {
  const env = new Env();
  await env.setUpVault();
  for (const m of Object.values(MARKETS)) setMarketClosed(env, m.gm, false);
  const v = env.vault;
  const admin = env.admin.publicKey;
  const risk = env.risk;
  const stranger = env.wallet();
  const strangerUsdc = env.setUsdc(stranger.publicKey, usdc('1000'));
  const mint = otherMint(env);
  /** `ix` with account `i` changed (key or flags). */
  const at = (ix: TransactionInstruction, i: number, f: Partial<AccountMeta>) => raw(ix, (k, d) => [k.map((x, j) => (j === i ? { ...x, ...f } : x)), d]);
  const ref = (x: Funded) => env.funded(x.funded);
  const label = (x: Funded) => (x === f ? 'f' : x === g ? 'g' : x === k ? 'k' : 'h');
  const open = async (x: Funded, market: Market, isLong: boolean, collateral: string, size: bigint) => {
    const o = await v.openPosition({
      trader: x.trader.publicKey, funded: ref(x), marketToken: MARKETS[market].token, isLong, orderType: 'market',
      collateral: usdc(collateral), sizeDeltaUsd: size, acceptablePrice: isLong ? 10n ** 30n : 1n,
    });
    send(env, `${label(x)} opens ${market} ${isLong ? 'long' : 'short'}`, o.instruction, [x.trader]);
    return o.order;
  };
  const cancel = async (x: Funded, order: PublicKey) =>
    send(env, `${label(x)} cancels`, await v.cancelOrder({ authority: x.trader.publicKey, funded: ref(x), order }), [x.trader]);
  const sync = async (x: Funded) => send(env, `sync ${label(x)}`, await v.sync({ funded: ref(x) }), [stranger]);
  /** Writes `value` at `at` and checks the SDK's borsh decoder now refuses the account (the byte is a bool or enum). */
  const corrupt = (address: PublicKey, name: Parameters<typeof v.decode>[0], offset: number, value: number) => {
    write(env, address, offset, [value]);
    assert.throws(() => v.decode(name, env.svm.getAccount(address)!.data), `${name} byte ${offset} is not a bool or enum`);
  };

  const f = await env.activeFunded();
  const g = await env.activeFunded();
  let k: Funded | undefined;

  // ---------- close_empty_position ----------
  const sol = gmPositionPda(f.owner, MARKETS.SOL.token, true);
  await cancel(f, await open(f, 'SOL', true, '1', 2n * USD));
  const ce = await v.closeEmptyPosition({ funded: f.funded, position: sol });
  send(env, 'close empty slot still used', ce, [stranger]);
  await sync(f);
  send(env, 'close empty missing accounts', raw(ce, (x, d) => [x.slice(0, 9), d]), [stranger]);
  send(env, 'close empty config is a tier', swapKey(ce, configPda(), tierPda(1)), [stranger]);
  const fundedCopy = Keypair.generate().publicKey;
  env.svm.setAccount(fundedCopy, { ...env.svm.getAccount(f.funded)! });
  send(env, 'close empty funded copy', swapKey(ce, f.funded, fundedCopy), [stranger]);
  send(env, 'close empty funded of another account', swapKey(ce, f.funded, g.funded), [stranger]);
  send(env, 'close empty owner of another account', swapKey(ce, f.owner, g.owner), [stranger]);
  send(env, 'close empty owner not system', swapKey(ce, f.owner, feeVaultPda()), [stranger]);
  send(env, 'close empty owner readonly', at(ce, 2, { isWritable: false }), [stranger]);
  send(env, 'close empty wrong store', swapKey(ce, GMTRADE_STORE, stranger.publicKey), [stranger]);
  send(env, 'close empty position readonly', at(ce, 4, { isWritable: false }), [stranger]);
  send(env, 'close empty treasury readonly', at(ce, 5, { isWritable: false }), [stranger]);
  send(env, 'close empty wrong treasury', swapKey(ce, solTreasuryPda(), stranger.publicKey), [stranger]);
  send(env, 'close empty treasury not system', swapKey(ce, solTreasuryPda(), feeVaultPda()), [stranger]);
  send(env, 'close empty gmtrade is spl token', swapKey(ce, GMTRADE_PROGRAM_ID, TOKEN_PROGRAM_ID), [stranger]);
  send(env, 'close empty wrong system program', swapKey(ce, SystemProgram.programId, TOKEN_PROGRAM_ID), [stranger]);
  send(env, 'close empty wrong event authority', swapKey(ce, eventAuthorityPda(), stranger.publicKey), [stranger]);
  send(env, 'close empty wrong program account', at(ce, 9, { pubkey: stranger.publicKey }), [stranger]);
  send(env, 'close empty foreign position', swapKey(ce, sol, MAINNET_POSITIONS.flat), [stranger]);
  send(env, 'close empty absent position', await v.closeEmptyPosition({ funded: f.funded, position: gmPositionPda(f.owner, MARKETS.ETH.token, true) }), [stranger]);
  send(env, 'close empty position of the other account', swapKey(swapKey(ce, f.funded, g.funded), f.owner, g.owner), [stranger]);
  env.setPosition(sol, USD, 1n);
  send(env, 'close empty not empty', ce, [stranger]);
  env.setPosition(sol, 0n, 5n); // size 0 but collateral left: GMTrade itself refuses
  send(env, 'close empty with collateral left', ce, [stranger]);
  env.setPosition(sol, 0n, 0n);
  snap(env, 'before close empty', [f.funded, f.owner, sol, solTreasuryPda()]);
  send(env, 'close empty', ce, [stranger]);
  snap(env, 'after close empty', [f.funded, f.owner, sol, solTreasuryPda()]);
  send(env, 'close empty again', ce, [stranger]);
  // The (market, side) used again: a new Position, reclaimed again.
  await cancel(f, await open(f, 'SOL', true, '1', 2n * USD));
  await sync(f);
  send(env, 'close empty reopened', ce, [stranger]);
  // Breached, then closed: what is left is still reclaimed.
  const btc = gmPositionPda(f.owner, MARKETS.BTC.token, false);
  await cancel(f, await open(f, 'BTC', false, '1', 2n * USD));
  await sync(f);
  const ceBtc = await v.closeEmptyPosition({ funded: f.funded, position: btc });
  setStatus(env, f.funded, STATUS.breached);
  send(env, 'close empty breached', ceBtc, [stranger]);
  const eth = gmPositionPda(f.owner, MARKETS.ETH.token, true);
  setStatus(env, f.funded, STATUS.active);
  await cancel(f, await open(f, 'ETH', true, '1', 2n * USD));
  await sync(f);
  send(env, 'f breached', await v.markBreached({ riskAuthority: risk.publicKey, funded: f.funded }), [risk]);
  send(env, 'close f', await v.closeFunded({ riskAuthority: risk.publicKey, funded: ref(f), positions: [eth] }), [risk]);
  snap(env, 'closed with an empty position', [f.funded, f.owner, eth, solTreasuryPda()]);
  send(env, 'close empty closed', await v.closeEmptyPosition({ funded: f.funded, position: eth }), [stranger]);
  snap(env, 'closed reclaimed', [f.funded, f.owner, eth, btc, sol, solTreasuryPda()]);

  // ---------- collect_claimable ----------
  k = await env.activeFunded();
  /** A claimable account as GMTrade leaves it once a keeper unlocked it for `owner` (token authority: the store). */
  const claimable = (owner: PublicKey, amount: bigint, p: { delegate?: PublicKey; authority?: PublicKey; delegated?: bigint; mint?: PublicKey; state?: number } = {}) => {
    const address = Keypair.generate().publicKey;
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint: p.mint ?? USDC_MINT, owner: p.authority ?? GMTRADE_STORE, amount, delegateOption: 1, delegate: p.delegate ?? owner,
        state: p.state ?? 1, isNativeOption: 0, isNative: 0n, delegatedAmount: p.delegated ?? amount, closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      data,
    );
    env.svm.setAccount(address, { lamports: 2_039_280, data, owner: TOKEN_PROGRAM_ID, executable: false });
    return address;
  };
  const collect = async (x: Funded, account: PublicKey) => v.collectClaimable({ funded: ref(x), claimable: account });
  const parked = claimable(k.owner, usdc('174.68'));
  const cc = await collect(k, parked);
  send(env, 'collect missing accounts', raw(cc, (x, d) => [x.slice(0, 8), d]), [stranger]);
  send(env, 'collect config is a tier', swapKey(cc, configPda(), tierPda(1)), [stranger]);
  send(env, 'collect funded copy', swapKey(cc, k.funded, fundedCopy), [stranger]);
  send(env, 'collect funded of another account', swapKey(cc, k.funded, g.funded), [stranger]);
  send(env, 'collect owner of another account', swapKey(cc, k.owner, g.owner), [stranger]);
  send(env, 'collect owner not system', swapKey(cc, k.owner, feeVaultPda()), [stranger]);
  send(env, 'collect claimable readonly', at(cc, 3, { isWritable: false }), [stranger]);
  send(env, 'collect claimable not a token account', swapKey(cc, parked, stranger.publicKey), [stranger]);
  send(env, 'collect claimable of a stranger', swapKey(cc, parked, strangerUsdc), [stranger]);
  send(env, 'collect delegated to another owner', swapKey(cc, parked, claimable(g.owner, usdc('5'))), [stranger]);
  send(env, 'collect delegated to a stranger', swapKey(cc, parked, claimable(k.owner, usdc('5'), { delegate: stranger.publicKey })), [stranger]);
  send(env, 'collect not the store', swapKey(cc, parked, claimable(k.owner, usdc('5'), { authority: stranger.publicKey })), [stranger]);
  send(env, 'collect other mint', swapKey(cc, parked, claimable(k.owner, usdc('5'), { mint })), [stranger]);
  send(env, 'collect nothing delegated', swapKey(cc, parked, claimable(k.owner, usdc('5'), { delegated: 0n })), [stranger]);
  send(env, 'collect empty', swapKey(cc, parked, claimable(k.owner, 0n, { delegated: usdc('5') })), [stranger]);
  send(env, 'collect frozen', swapKey(cc, parked, claimable(k.owner, usdc('5'), { state: 2 })), [stranger]);
  send(env, 'collect destination readonly', at(cc, 4, { isWritable: false }), [stranger]);
  send(env, 'collect to a stranger', swapKey(cc, k.ownerUsdc, strangerUsdc), [stranger]);
  send(env, 'collect to the capital vault while open', swapKey(cc, k.ownerUsdc, capitalVaultAddress()), [stranger]);
  send(env, 'collect to another owner', swapKey(cc, k.ownerUsdc, g.ownerUsdc), [stranger]);
  send(env, 'collect to a wallet', swapKey(cc, k.ownerUsdc, stranger.publicKey), [stranger]);
  send(env, 'collect other mint account', swapKey(swapKey(cc, USDC_MINT, mint), k.ownerUsdc, tokenAccount(env, mint, k.owner, 0n)), [stranger]);
  send(env, 'collect mint not a mint', swapKey(cc, USDC_MINT, strangerUsdc), [stranger]);
  send(env, 'collect wrong token program', swapKey(cc, TOKEN_PROGRAM_ID, SystemProgram.programId), [stranger]);
  send(env, 'collect wrong event authority', swapKey(cc, eventAuthorityPda(), stranger.publicKey), [stranger]);
  snap(env, 'before collect', [k.funded, k.ownerUsdc, parked]);
  send(env, 'collect', cc, [stranger]);
  snap(env, 'after collect', [k.funded, k.ownerUsdc, parked]);
  send(env, 'collect again', cc, [stranger]);
  const partial = claimable(k.owner, usdc('100'), { delegated: usdc('60') });
  send(env, 'collect partial', await collect(k, partial), [stranger]);
  const more = claimable(k.owner, usdc('20'), { delegated: usdc('70') });
  send(env, 'collect over-delegated', await collect(k, more), [stranger]);
  for (const [name, status] of [['restricted', STATUS.restricted], ['payout pending', STATUS.payoutPending], ['breached', STATUS.breached]] as const) {
    setStatus(env, k.funded, status);
    send(env, `collect ${name}`, await collect(k, claimable(k.owner, usdc('1'))), [stranger]);
  }
  setStatus(env, k.funded, STATUS.active);
  snap(env, 'collected', [k.funded, k.ownerUsdc, partial, more]);
  send(env, 'k breached', await v.markBreached({ riskAuthority: risk.publicKey, funded: k.funded }), [risk]);
  send(env, 'close k', await v.closeFunded({ riskAuthority: risk.publicKey, funded: ref(k) }), [risk]);
  const late = claimable(k.owner, usdc('12.5'));
  const ccLate = await collect(k, late);
  send(env, 'collect after close to the closed owner usdc', swapKey(ccLate, capitalVaultAddress(), ownerUsdcAddress(k.funded)), [stranger]);
  env.setUsdc(k.owner, 0n); // a stranger recreates the closed account's USDC ATA
  send(env, 'collect after close to a recreated owner usdc', swapKey(ccLate, capitalVaultAddress(), ownerUsdcAddress(k.funded)), [stranger]);
  send(env, 'collect after close', ccLate, [stranger]);
  snap(env, 'collected after close', [k.funded, k.owner, late, capitalVaultAddress()]);

  // ---------- update_order below $1 ----------
  const h = await env.activeFunded();
  await open(h, 'SOL', true, '10', 100n * USD);
  const tp = await v.setProtection({
    trader: h.trader.publicKey, funded: ref(h), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'takeProfit',
    triggerPrice: 150n * 10n ** 11n, sizeDeltaUsd: USD,
  });
  send(env, 'h take profit $1', tp.instruction, [h.trader]);
  const resize = async (size: bigint) => v.updateOrder({ trader: h.trader.publicKey, funded: ref(h), order: tp.order, sizeDeltaUsd: size });
  send(env, 'update take profit to 1', await resize(1n), [h.trader]);
  send(env, 'update take profit below $1', await resize(USD - 1n), [h.trader]);
  send(env, 'update take profit to $1', await resize(USD), [h.trader]);
  send(env, 'update take profit to close all', await resize(2n ** 128n - 1n), [h.trader]);
  snap(env, 'after resize', [h.funded, tp.order]);

  // ---------- update_order on a resting limit increase after the admin changes its market (round 2) ----------
  const r = await env.activeFunded();
  const rMarket = marketConfigPda(MARKETS.SOL.token);
  const rLimit = await v.openPosition({
    trader: r.trader.publicKey, funded: ref(r), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'limit', triggerPrice: 1n,
    collateral: usdc('10'), sizeDeltaUsd: 250n * USD, acceptablePrice: 10n ** 30n,
  });
  send(env, 'r parks a 25x SOL limit', rLimit.instruction, [r.trader]);
  const rtp = await v.setProtection({
    trader: r.trader.publicKey, funded: ref(r), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'takeProfit',
    triggerPrice: 150n * 10n ** 11n, sizeDeltaUsd: USD,
  });
  send(env, 'r take profit', rtp.instruction, [r.trader]);
  const moveLimit = async (p: { triggerPrice?: bigint; acceptablePrice?: bigint; sizeDeltaUsd?: bigint }) =>
    v.updateOrder({ trader: r.trader.publicKey, funded: ref(r), order: rLimit.order, ...p });
  const setSol = async (label: string, lev: number, o: Parameters<typeof marketParams>[2] = {}) =>
    send(env, label, await v.upsertMarket({ admin, marketToken: MARKETS.SOL.token, params: marketParams('SOL', lev, o) }), [env.admin]);
  const pauseTrading = async (paused: boolean) =>
    v.setPauses({ admin, paused: { newEvaluations: false, trading: paused, payouts: false } });
  await setSol('disable SOL', LEVERAGE.crypto, { enabled: false });
  send(env, 'limit trigger in a disabled market', await moveLimit({ triggerPrice: 10n ** 30n }), [r.trader]);
  send(env, 'limit resize in a disabled market', await moveLimit({ sizeDeltaUsd: 200n * USD }), [r.trader]);
  send(env, 'limit acceptable price in a disabled market', await moveLimit({ acceptablePrice: 10n ** 29n }), [r.trader]);
  send(env, 'pause trading (disabled market)', await pauseTrading(true), [env.admin]);
  send(env, 'limit trigger paused and disabled', await moveLimit({ triggerPrice: 10n ** 30n }), [r.trader]);
  send(env, 'resume trading (disabled market)', await pauseTrading(false), [env.admin]);
  setStatus(env, r.funded, STATUS.restricted);
  send(env, 'limit trigger restricted and disabled', await moveLimit({ triggerPrice: 10n ** 30n }), [r.trader]);
  setStatus(env, r.funded, STATUS.active);
  send(env, 'take profit trigger in a disabled market', await v.updateOrder({ trader: r.trader.publicKey, funded: ref(r), order: rtp.order, triggerPrice: 160n * 10n ** 11n }), [r.trader]);
  await setSol('SOL at 5x', 50_000);
  send(env, 'limit trigger above the lowered leverage', await moveLimit({ triggerPrice: 10n ** 30n }), [r.trader]);
  send(env, 'limit same size above the lowered leverage', await moveLimit({ sizeDeltaUsd: 250n * USD }), [r.trader]);
  await setSol('SOL position cap $200', LEVERAGE.crypto, { maxPositionUsd: usdc('200') });
  send(env, 'limit trigger above the lowered position cap', await moveLimit({ triggerPrice: 10n ** 30n }), [r.trader]);
  await setSol('SOL open interest cap $300', LEVERAGE.crypto, { maxPositionUsd: usdc('300'), maxTotalOiUsd: usdc('300') }); // h's $100 + r's $250 long
  send(env, 'limit acceptable price above the lowered open interest cap', await moveLimit({ acceptablePrice: 10n ** 29n }), [r.trader]);
  await setSol('SOL at 5x again', 50_000);
  snap(env, 'before limit update', [r.funded, rLimit.order, rMarket]);
  send(env, 'limit resize and trigger at 5x', await moveLimit({ sizeDeltaUsd: 50n * USD, triggerPrice: 10n ** 30n }), [r.trader]);
  snap(env, 'after limit update', [r.funded, rLimit.order, rMarket]);
  send(env, 'limit trigger only at 5x', await moveLimit({ triggerPrice: 10n ** 29n }), [r.trader]);
  await setSol('disable SOL again', 50_000, { enabled: false });
  send(env, 'cancel the limit in a disabled market', await v.cancelOrder({ authority: r.trader.publicKey, funded: ref(r), order: rLimit.order }), [r.trader]);
  await setSol('enable SOL', LEVERAGE.crypto);
  snap(env, 'after limit cancel', [r.funded, r.ownerUsdc, rMarket]);

  // ---------- COption tags of SPL token accounts and mints ----------
  const adminUsdc = env.setUsdc(admin, usdc('10'));
  const deposit = async (amount: bigint) => v.depositCapital({ admin, amount });
  for (const [what, address, offset] of [['delegate', adminUsdc, 72], ['is_native', adminUsdc, 109], ['close authority', adminUsdc, 129], ['mint authority', USDC_MINT, 0], ['freeze authority', USDC_MINT, 46]] as const) {
    const original = env.svm.getAccount(address)!;
    for (const tag of [2, 255]) {
      write(env, address, offset, [tag]);
      send(env, `deposit ${what} tag ${tag}`, await deposit(1n), [env.admin]);
      send(env, `deposit 0 ${what} tag ${tag}`, await deposit(0n), [env.admin]);
    }
    env.svm.setAccount(address, original);
    write(env, address, offset + 1, [1]); // [0 or 1, 1, 0, 0]: not a tag either
    send(env, `deposit ${what} tag high byte`, await deposit(1n), [env.admin]);
    env.svm.setAccount(address, original);
  }
  // A bad tag on an uninitialized account is InvalidAccountData, not UninitializedAccount (spl-token checks tags first).
  const originalUsdc = env.svm.getAccount(adminUsdc)!;
  write(env, adminUsdc, 108, [0]);
  send(env, 'deposit from uninitialized', await deposit(1n), [env.admin]);
  write(env, adminUsdc, 72, [2]);
  send(env, 'deposit from uninitialized bad tag', await deposit(1n), [env.admin]);
  env.svm.setAccount(adminUsdc, originalUsdc);
  const originalMint = env.svm.getAccount(USDC_MINT)!;
  write(env, USDC_MINT, 45, [0]);
  send(env, 'deposit uninitialized mint', await deposit(1n), [env.admin]);
  write(env, USDC_MINT, 46, [2]);
  send(env, 'deposit uninitialized mint bad tag', await deposit(1n), [env.admin]);
  env.svm.setAccount(USDC_MINT, originalMint);
  send(env, 'deposit', await deposit(1n), [env.admin]);

  // ---------- bool and enum bytes borsh refuses ----------
  const trader = env.wallet();
  env.setUsdc(trader.publicKey, usdc('1000'));
  const t50k = TIERS.t50k.id; // disabled
  const buy = await v.buyEvaluation({ trader: trader.publicKey, tierId: t50k, index: 0, ...env.reviewed(t50k) });
  const tier = env.svm.getAccount(tierPda(t50k))!;
  send(env, 'buy disabled tier', buy, [trader]);
  corrupt(tierPda(t50k), 'tier', 32, 2);
  send(env, 'buy tier enabled 2', buy, [trader]);
  send(env, 'upsert tier enabled 2', await v.upsertTier({ admin, id: t50k, params: tierParams(TIERS.t50k) }), [env.admin]);
  env.svm.setAccount(tierPda(t50k), tier);

  const q = await env.activeFunded();
  const solConfig = marketConfigPda(MARKETS.SOL.token);
  const market = env.svm.getAccount(solConfig)!;
  const openQ = await v.openPosition({
    trader: q.trader.publicKey, funded: ref(q), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'market',
    collateral: usdc('10'), sizeDeltaUsd: 100n * USD, acceptablePrice: 10n ** 30n,
  });
  corrupt(solConfig, 'marketConfig', 72, 2);
  send(env, 'open market enabled 2', openQ.instruction, [q.trader]);
  env.svm.setAccount(solConfig, market);
  corrupt(solConfig, 'marketConfig', 145, 3);
  send(env, 'open market session flag 3', openQ.instruction, [q.trader]);
  env.svm.setAccount(solConfig, market);
  send(env, 'q opens SOL', openQ.instruction, [q.trader]);
  const syncQ = await v.sync({ funded: ref(q) });
  const funded = env.svm.getAccount(q.funded)!;
  for (const [what, offset, value] of [['status', FUNDED.status, 5], ['slot side', FUNDED.slot(0) + 64, 2], ['order type', FUNDED.order(0) + 33, 5], ['order placed by risk', FUNDED.order(0) + 58, 2]] as const) {
    corrupt(q.funded, 'fundedAccount', offset, value);
    send(env, `sync funded ${what} ${value}`, syncQ, [stranger]);
    env.svm.setAccount(q.funded, funded);
  }
  send(env, 'sync q', syncQ, [stranger]);

  const other = env.wallet();
  env.setUsdc(other.publicKey, usdc('1000'));
  send(env, 'buy for a result', await v.buyEvaluation({ trader: other.publicKey, tierId: TIERS.t10k.id, index: 0, ...env.reviewed(TIERS.t10k.id) }), [other]);
  const evaluation = evaluationPda(other.publicKey, 0);
  const result = await v.recordEvaluationResult({ riskAuthority: risk.publicKey, evaluation, passed: true, finalEquity: usdc('10900'), tradesRoot: hash32('fills') });
  corrupt(evaluation, 'evaluation', 106, 4);
  send(env, 'record evaluation status 4', result, [risk]);
  write(env, evaluation, 106, [0]);
  send(env, 'record evaluation', result, [risk]);

  const p = await env.activeFunded();
  env.setUsdcBalance(p.ownerUsdc, usdc('600'));
  send(env, 'request payout', await v.requestPayout({ trader: p.trader.publicKey, funded: p.funded, payoutSeq: 0 }), [p.trader]);
  const reject = await v.rejectPayout({ riskAuthority: risk.publicKey, funded: p.funded, payout: payoutPda(p.funded, 0), reasonCode: 7 });
  corrupt(payoutPda(p.funded, 0), 'payoutRequest', 108, 4);
  send(env, 'reject payout status 4', reject, [risk]);
  write(env, payoutPda(p.funded, 0), 108, [0]);
  send(env, 'reject payout', reject, [risk]);

  // Config pauses: pending admin None, one risk authority, then the tail (5 keys, share bps, 6 u64/i64 fields).
  const paused = 8 + 32 + 1 + 4 + 32 + 5 * 32 + 2 + 6 * 8;
  const config = env.svm.getAccount(configPda())!;
  const pauses = await v.setPauses({ admin, paused: { newEvaluations: false, trading: false, payouts: false } });
  for (const i of [0, 1, 2]) {
    corrupt(configPda(), 'config', paused + i, 2);
    send(env, `set pauses with pause ${i} = 2`, pauses, [env.admin]);
    env.svm.setAccount(configPda(), config);
  }
  send(env, 'set pauses', pauses, [env.admin]);
  snap(env, 'final', [configPda(), tierPda(t50k), solConfig, q.funded, evaluation, payoutPda(p.funded, 0), f.funded, k.funded, h.funded, solTreasuryPda(), capitalVaultAddress()]);
});
