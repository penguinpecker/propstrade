// The crank.rs instructions (sync, top_up_owner, close_completed_order), happy paths and refusals, compared byte for
// byte (see harness.ts): every remaining-account mismatch of sync (order, count, foreign or read-only accounts, market
// configs of the wrong market or type), GMTrade Position and Order accounts in every state (pending, filled, completed
// or cancelled but left open, closed, refunded by a stranger, not a GMTrade account, truncated), slot release, open
// interest moves, every checked-arithmetic limit (written directly), every account substitution and read-only flag, the
// owner float at, just below and far below its minimum, and the gmtrade_program swapped for SPL Token.
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  GMTRADE_PROGRAM_ID, GMTRADE_STORE, USDC_MINT, configPda, eventAuthorityPda, feeVaultPda, gmOrderEscrow, gmOrderPda, gmPositionPda, gmStoreWallet,
  gmUserPda, marketConfigPda, orderNonce, solTreasuryPda, tierPda,
} from '@props/sdk';
import { compare } from './harness.ts';
import { FUNDED, MARKET_OI, SLOT, STATUS, TRACKED, type Funded, le, otherMint, read, setMarketClosed, setOrderState, setStatus, tokenAccount, write } from './trading.ts';

type Market = 'SOL' | 'BTC' | 'ETH' | 'XAU' | 'NVDA' | 'EUR';
const MAX128 = 2n ** 128n - 1n;

await compare(async ({ env: { Env, MAINNET_POSITIONS, MARKETS, USD, swapKey, usdc }, send, snap, raw }) => {
  const env = new Env();
  await env.setUpVault();
  for (const m of Object.values(MARKETS)) setMarketClosed(env, m.gm, false);
  const v = env.vault;
  const stranger = env.wallet();
  const strangerUsdc = env.setUsdc(stranger.publicKey, usdc('1000'));
  const mint = otherMint(env);
  /** `ix` with account `i` changed (key or flags). */
  const at = (ix: TransactionInstruction, i: number, f: Partial<AccountMeta>) => raw(ix, (k, d) => [k.map((x, j) => (j === i ? { ...x, ...f } : x)), d]);
  const ref = (x: Funded) => env.funded(x.funded);
  const open = async (x: Funded, market: Market, p: { isLong?: boolean; collateral: string; size: bigint; limit?: bigint }) => {
    const isLong = p.isLong ?? true;
    const o = await v.openPosition({
      trader: x.trader.publicKey, funded: ref(x), marketToken: MARKETS[market].token, isLong, orderType: p.limit ? 'limit' : 'market',
      collateral: usdc(p.collateral), sizeDeltaUsd: p.size, triggerPrice: p.limit, acceptablePrice: isLong ? 10n ** 30n : 1n,
    });
    send(env, `${x === f ? 'f' : x === g ? 'g' : 'k'} opens ${market} ${isLong ? 'long' : 'short'}`, o.instruction, [x.trader]);
    return { order: o.order, position: gmPositionPda(x.owner, MARKETS[market].token, isLong) };
  };
  const sync = (x: Funded) => v.sync({ funded: ref(x) });
  /** `ix` (a sync) with `remaining` in place of its remaining accounts. */
  const withRemaining = (ix: TransactionInstruction, remaining: AccountMeta[]) =>
    new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: [...ix.keys.slice(0, 4), ...remaining] });
  const swap = <T>(list: T[], i: number, j: number) => list.map((x, n) => (n === i ? list[j]! : n === j ? list[i]! : x));
  const markets = (...names: Market[]) => names.map((n) => marketConfigPda(MARKETS[n].token));
  const all = (x: Funded, ...extra: PublicKey[]) => [x.funded, x.owner, x.ownerUsdc, ...extra, ...markets('SOL', 'BTC', 'ETH', 'XAU')];

  const f = await env.activeFunded();
  env.svm.airdrop(f.owner, 1_000_000_000n); // GMTrade rents for 4 positions and 5 orders exceed one float
  const g = await env.activeFunded();

  // ---------- sync: accounts, status, a flat account ----------
  const s0 = await sync(f);
  send(env, 'sync missing accounts', raw(s0, (k, d) => [k.slice(0, 3), d]), [stranger]);
  send(env, 'sync config is a tier', swapKey(s0, configPda(), tierPda(1)), [stranger]);
  send(env, 'sync config missing', swapKey(s0, configPda(), Keypair.generate().publicKey), [stranger]);
  send(env, 'sync funded readonly', at(s0, 1, { isWritable: false }), [stranger]);
  send(env, 'sync funded is a market config', swapKey(s0, f.funded, marketConfigPda(MARKETS.SOL.token)), [stranger]);
  const fundedCopy = Keypair.generate().publicKey;
  env.svm.setAccount(fundedCopy, { ...env.svm.getAccount(f.funded)! });
  send(env, 'sync funded copy', swapKey(s0, f.funded, fundedCopy), [stranger]);
  send(env, 'sync wrong event authority', swapKey(s0, eventAuthorityPda(), stranger.publicKey), [stranger]);
  send(env, 'sync wrong program account', at(s0, 3, { pubkey: stranger.publicKey }), [stranger]);
  send(env, 'sync flat with an extra account', withRemaining(s0, [{ pubkey: marketConfigPda(MARKETS.SOL.token), isSigner: false, isWritable: true }]), [stranger]);
  setStatus(env, f.funded, STATUS.closed);
  send(env, 'sync closed', s0, [stranger]);
  setStatus(env, f.funded, STATUS.payoutPending);
  send(env, 'sync payout pending', s0, [stranger]);
  setStatus(env, f.funded, STATUS.active);
  send(env, 'sync flat', s0, [stranger]);
  snap(env, 'flat', [f.funded]);

  // ---------- sync: pending orders and every remaining-account mismatch ----------
  const solL = await open(f, 'SOL', { collateral: '100', size: 1000n * USD });
  const solS = await open(f, 'SOL', { isLong: false, collateral: '30', size: 300n * USD });
  const btc = await open(f, 'BTC', { collateral: '50', size: 500n * USD });
  const eth = await open(f, 'ETH', { collateral: '40', size: 400n * USD, limit: 3000n * 10n ** 11n });
  const s1 = await sync(f);
  // positions (slots 0-3), orders (0-3), markets SOL, BTC, ETH
  const rem = s1.keys.slice(4);
  send(env, 'sync remaining short', withRemaining(s1, rem.slice(0, -1)), [stranger]);
  send(env, 'sync remaining extra', withRemaining(s1, [...rem, rem[8]!]), [stranger]);
  send(env, 'sync no remaining', withRemaining(s1, []), [stranger]);
  send(env, 'sync positions swapped', withRemaining(s1, swap(rem, 0, 1)), [stranger]);
  send(env, 'sync orders swapped', withRemaining(s1, swap(rem, 4, 5)), [stranger]);
  send(env, 'sync markets swapped', withRemaining(s1, swap(rem, 8, 9)), [stranger]);
  send(env, 'sync position and order swapped', withRemaining(s1, swap(rem, 3, 4)), [stranger]);
  const readonly = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
  const writable = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
  send(env, 'sync foreign position', withRemaining(s1, rem.map((m, i) => (i === 0 ? readonly(MAINNET_POSITIONS.long) : m))), [stranger]);
  send(env, 'sync foreign order', withRemaining(s1, rem.map((m, i) => (i === 4 ? readonly(gmOrderPda(f.owner, orderNonce(99n))) : m))), [stranger]);
  send(env, 'sync market readonly', withRemaining(s1, rem.map((m, i) => (i === 9 ? { ...m, isWritable: false } : m))), [stranger]);
  send(env, 'sync market of another market', withRemaining(s1, rem.map((m, i) => (i === 8 ? writable(marketConfigPda(MARKETS.ETH.token)) : m))), [stranger]);
  send(env, 'sync market is the config', withRemaining(s1, rem.map((m, i) => (i === 8 ? writable(configPda()) : m))), [stranger]);
  send(env, 'sync market is a funded account', withRemaining(s1, rem.map((m, i) => (i === 8 ? writable(g.funded) : m))), [stranger]);
  send(env, 'sync market missing', withRemaining(s1, rem.map((m, i) => (i === 8 ? writable(Keypair.generate().publicKey) : m))), [stranger]);
  send(env, 'sync market not ours', withRemaining(s1, rem.map((m, i) => (i === 8 ? writable(USDC_MINT) : m))), [stranger]);
  send(env, 'sync pending', s1, [stranger]);
  snap(env, 'pending', all(f));

  // GMTrade accounts in states sync refuses.
  const position = env.svm.getAccount(solS.position)!;
  env.svm.setAccount(solS.position, { ...position, owner: TOKEN_PROGRAM_ID });
  send(env, 'sync position owned by another program', s1, [stranger]);
  env.svm.setAccount(solS.position, { ...position, data: position.data.slice(0, 679) });
  send(env, 'sync position truncated', s1, [stranger]);
  env.svm.setAccount(solS.position, position);
  write(env, solS.position, 0, new Uint8Array(8));
  send(env, 'sync position not a position', s1, [stranger]);
  env.svm.setAccount(solS.position, position);
  env.setPosition(solS.position, 300n * USD, 2n ** 64n);
  send(env, 'sync position collateral beyond u64', s1, [stranger]);
  env.svm.setAccount(solS.position, position);
  const order = env.svm.getAccount(btc.order)!;
  write(env, btc.order, 0, new Uint8Array(8));
  send(env, 'sync order not an order', s1, [stranger]);
  env.svm.setAccount(btc.order, { ...order, data: order.data.slice(0, 9) });
  send(env, 'sync order truncated', s1, [stranger]);
  env.svm.setAccount(btc.order, order);

  // ---------- sync: fills, orders GMTrade left open, partial decreases, liquidation, slot release ----------
  env.executeOrder(solL.order, gmOrderEscrow(solL.order));
  env.setPosition(solL.position, 1000n * USD, usdc('99.9'));
  send(env, 'sync after a fill', (await sync(f)), [stranger]);
  snap(env, 'filled', all(f));
  setOrderState(env, btc.order, 1); // completed, escrow drained, left open
  env.setUsdcBalance(gmOrderEscrow(btc.order), 0n);
  env.setPosition(btc.position, 500n * USD, usdc('50'));
  setOrderState(env, solS.order, 2); // cancelled, 30 USDC still in escrow, left open
  send(env, 'sync finished orders kept', (await sync(f)), [stranger]);
  snap(env, 'finished', all(f));
  env.executeOrder(eth.order, gmOrderEscrow(eth.order));
  env.svm.airdrop(eth.order, 1_000_000n); // a stranger sends lamports to the closed order address
  setStatus(env, f.funded, STATUS.breached);
  send(env, 'sync order refunded by a stranger', (await sync(f)), [stranger]);
  setStatus(env, f.funded, STATUS.active);
  snap(env, 'refunded', all(f, eth.order));
  env.setPosition(solL.position, 600n * USD, usdc('60'));
  send(env, 'sync partial decrease', (await sync(f)), [stranger]);
  env.remove(solL.position);
  setStatus(env, f.funded, STATUS.restricted);
  send(env, 'sync liquidated', (await sync(f)), [stranger]);
  setStatus(env, f.funded, STATUS.active);
  snap(env, 'liquidated', all(f, solL.position));

  // ---------- sync: checked-arithmetic limits ----------
  const a = await open(g, 'SOL', { collateral: '10', size: 100n * USD });
  const b = await open(g, 'SOL', { collateral: '10', size: 100n * USD });
  const s2 = await sync(g);
  write(env, g.funded, FUNDED.order(0) + TRACKED.sizeUsd, le(MAX128 - 10n, 16));
  send(env, 'sync pending sum overflow', s2, [stranger]);
  write(env, g.funded, FUNDED.order(0) + TRACKED.sizeUsd, le(100n * USD, 16));
  write(env, g.funded, FUNDED.slot(0) + SLOT.sizeUsd, le(MAX128, 16));
  send(env, 'sync committed before overflow', s2, [stranger]);
  write(env, g.funded, FUNDED.slot(0) + SLOT.sizeUsd, le(0n, 16));
  env.setPosition(a.position, MAX128, 0n);
  send(env, 'sync committed after overflow', s2, [stranger]);
  env.setPosition(a.position, 0n, 0n);
  const solConfig = marketConfigPda(MARKETS.SOL.token);
  const solOi = read(env, solConfig, MARKET_OI.long, 16);
  write(env, solConfig, MARKET_OI.long, le(MAX128 - 100n * USD, 16));
  send(env, 'sync open interest overflow', s2, [stranger]);
  write(env, solConfig, MARKET_OI.long, le(0n, 16));
  setOrderState(env, a.order, 1); // finished: the slot's committed size drops from 200 to 100
  send(env, 'sync open interest underflow', s2, [stranger]);
  write(env, solConfig, MARKET_OI.long, solOi);
  send(env, 'sync g', s2, [stranger]);
  setOrderState(env, a.order, 0);
  snap(env, 'g synced', all(g, a.order, b.order));

  // A full account: 8 slots, 8 orders, 4 markets.
  const k = await env.activeFunded();
  env.svm.airdrop(k.owner, 1_000_000_000n);
  for (const [m, isLong] of [['SOL', true], ['SOL', false], ['BTC', true], ['BTC', false], ['ETH', true], ['ETH', false], ['XAU', true], ['XAU', false]] as const) {
    await open(k, m, { isLong, collateral: '5', size: 20n * USD });
  }
  send(env, 'sync full account', (await sync(k)), [stranger]);
  snap(env, 'full', all(k));

  // ---------- top_up_owner ----------
  const h = await env.activeFunded();
  const setOwnerLamports = (lamports: bigint) => env.svm.setAccount(h.owner, { ...env.svm.getAccount(h.owner)!, lamports: Number(lamports) });
  const t = await v.topUpOwner({ funded: h.funded });
  send(env, 'top up above the minimum', t, [stranger]);
  setOwnerLamports(100_000_000n); // owner_sol_min
  send(env, 'top up at the minimum', t, [stranger]);
  setOwnerLamports(99_999_999n);
  send(env, 'top up just below the minimum', t, [stranger]);
  snap(env, 'topped up', [h.funded, h.owner, solTreasuryPda()]);
  setOwnerLamports(10_000_000n);
  send(env, 'top up missing accounts', raw(t, (k2, d) => [k2.slice(0, 6), d]), [stranger]);
  send(env, 'top up config is a tier', swapKey(t, configPda(), tierPda(1)), [stranger]);
  send(env, 'top up funded is a market config', swapKey(t, h.funded, marketConfigPda(MARKETS.SOL.token)), [stranger]);
  send(env, 'top up funded copy', swapKey(t, h.funded, fundedCopy), [stranger]);
  send(env, 'top up funded of another account', swapKey(t, h.funded, g.funded), [stranger]);
  send(env, 'top up owner not system', swapKey(t, h.owner, feeVaultPda()), [stranger]);
  send(env, 'top up owner of another account', swapKey(t, h.owner, g.owner), [stranger]);
  send(env, 'top up owner readonly', at(t, 2, { isWritable: false }), [stranger]);
  send(env, 'top up treasury not system', swapKey(t, solTreasuryPda(), feeVaultPda()), [stranger]);
  send(env, 'top up wrong treasury', swapKey(t, solTreasuryPda(), stranger.publicKey), [stranger]);
  send(env, 'top up treasury readonly', at(t, 3, { isWritable: false }), [stranger]);
  send(env, 'top up wrong system program', swapKey(t, SystemProgram.programId, TOKEN_PROGRAM_ID), [stranger]);
  send(env, 'top up wrong event authority', swapKey(t, eventAuthorityPda(), stranger.publicKey), [stranger]);
  send(env, 'top up wrong program account', at(t, 6, { pubkey: stranger.publicKey }), [stranger]);
  setStatus(env, h.funded, STATUS.closed);
  send(env, 'top up closed', t, [stranger]);
  setStatus(env, h.funded, STATUS.breached);
  const treasury = env.svm.getAccount(solTreasuryPda())!;
  env.svm.setAccount(solTreasuryPda(), { ...treasury, lamports: 100_000_000 });
  send(env, 'top up treasury short', t, [stranger]);
  env.svm.setAccount(solTreasuryPda(), treasury);
  send(env, 'top up funded readonly', at(t, 1, { isWritable: false }), [stranger]);
  env.remove(h.owner);
  setStatus(env, h.funded, STATUS.restricted);
  send(env, 'top up an emptied owner', t, [stranger]);
  snap(env, 'emptied topped up', [h.funded, h.owner, solTreasuryPda()]);

  // ---------- close_completed_order ----------
  // f tracks btc (completed, escrow drained) and solS (cancelled, 30 USDC in escrow).
  const cc = await v.closeCompletedOrder({ funded: f.funded, order: btc.order });
  send(env, 'close completed missing accounts', raw(cc, (k2, d) => [k2.slice(0, 16), d]), [stranger]);
  for (const [i, name] of [[1, 'funded'], [2, 'owner'], [3, 'owner usdc'], [5, 'gm store'], [6, 'store wallet'], [7, 'gm user'], [8, 'gm order'], [9, 'order escrow']] as const) {
    send(env, `close completed ${name} readonly`, at(cc, i, { isWritable: false }), [stranger]);
  }
  send(env, 'close completed config is a tier', swapKey(cc, configPda(), tierPda(1)), [stranger]);
  send(env, 'close completed funded of another trader', swapKey(cc, f.funded, g.funded), [stranger]);
  send(env, 'close completed funded copy', swapKey(cc, f.funded, fundedCopy), [stranger]);
  send(env, 'close completed owner not system', swapKey(cc, f.owner, feeVaultPda()), [stranger]);
  send(env, 'close completed owner of another account', swapKey(cc, f.owner, g.owner), [stranger]);
  send(env, 'close completed owner usdc of a stranger', swapKey(cc, f.ownerUsdc, strangerUsdc), [stranger]);
  send(env, 'close completed owner usdc not the ata', swapKey(cc, f.ownerUsdc, env.setUsdc(f.owner, 0n, Keypair.generate().publicKey)), [stranger]);
  send(env, 'close completed owner usdc is a wallet', swapKey(cc, f.ownerUsdc, stranger.publicKey), [stranger]);
  const ownerOther = tokenAccount(env, mint, f.owner, 0n);
  send(env, 'close completed other mint', swapKey(swapKey(cc, f.ownerUsdc, ownerOther), USDC_MINT, mint), [stranger]);
  send(env, 'close completed mint not a mint', swapKey(cc, USDC_MINT, strangerUsdc), [stranger]);
  send(env, 'close completed wrong store', swapKey(cc, GMTRADE_STORE, stranger.publicKey), [stranger]);
  send(env, 'close completed wrong store wallet', swapKey(cc, gmStoreWallet(), stranger.publicKey), [stranger]);
  send(env, 'close completed wrong gm user', swapKey(cc, gmUserPda(f.owner), gmUserPda(g.owner)), [stranger]);
  send(env, 'close completed wrong escrow', swapKey(cc, gmOrderEscrow(btc.order), strangerUsdc), [stranger]);
  send(env, 'close completed gmtrade is spl token', swapKey(cc, GMTRADE_PROGRAM_ID, TOKEN_PROGRAM_ID), [stranger]);
  send(env, 'close completed wrong token program', swapKey(cc, TOKEN_PROGRAM_ID, SystemProgram.programId), [stranger]);
  send(env, 'close completed wrong ata program', swapKey(cc, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID), [stranger]);
  send(env, 'close completed wrong system program', swapKey(cc, SystemProgram.programId, TOKEN_PROGRAM_ID), [stranger]);
  send(env, 'close completed wrong event authority', swapKey(cc, eventAuthorityPda(), stranger.publicKey), [stranger]);
  send(env, 'close completed wrong gm event authority', at(cc, 10, { pubkey: stranger.publicKey }), [stranger]);
  setStatus(env, f.funded, STATUS.closed);
  send(env, 'close completed on a closed account', cc, [stranger]);
  setStatus(env, f.funded, STATUS.breached);
  const untracked = gmOrderPda(f.owner, orderNonce(99n));
  send(env, 'close completed untracked order', swapKey(swapKey(cc, btc.order, untracked), gmOrderEscrow(btc.order), gmOrderEscrow(untracked)), [stranger]);
  setStatus(env, f.funded, STATUS.active);
  const pending = await open(f, 'XAU', { collateral: '10', size: 100n * USD });
  setStatus(env, f.funded, STATUS.breached);
  send(env, 'close completed pending order', await v.closeCompletedOrder({ funded: f.funded, order: pending.order }), [stranger]);
  const btcOrder = env.svm.getAccount(btc.order)!;
  write(env, btc.order, 0, new Uint8Array(8));
  send(env, 'close completed order that is not an order', cc, [stranger]);
  env.svm.setAccount(btc.order, { ...btcOrder, data: btcOrder.data.slice(0, 100) });
  send(env, 'close completed truncated order', cc, [stranger]);
  env.svm.setAccount(btc.order, btcOrder);
  env.executeOrder(pending.order, gmOrderEscrow(pending.order));
  send(env, 'close completed order account gone', await v.closeCompletedOrder({ funded: f.funded, order: pending.order }), [stranger]);
  snap(env, 'before close completed', all(f, btc.order, gmOrderEscrow(btc.order), solS.order, gmOrderEscrow(solS.order)));
  send(env, 'close completed', cc, [stranger]);
  setStatus(env, f.funded, STATUS.active);
  send(env, 'close cancelled', await v.closeCompletedOrder({ funded: f.funded, order: solS.order }), [stranger]);
  snap(env, 'after close completed', all(f, btc.order, gmOrderEscrow(btc.order), solS.order, gmOrderEscrow(solS.order)));
  send(env, 'close completed again', cc, [stranger]);
  send(env, 'sync after close completed', (await sync(f)), [stranger]);
  snap(env, 'final', [...all(f), g.funded, k.funded, h.funded]);
});
