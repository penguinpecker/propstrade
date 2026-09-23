// The trading.rs instructions (open_position, close_position, set_protection, update_order, cancel_order), happy paths
// and refusals, compared byte for byte (see harness.ts): every GMTrade CPI (escrow ATA, prepare_user, prepare_position,
// create_order_v2, update_order_v2, close_order_v2) and event, every account substitution and read-only flag, malformed
// data, every funded status (written directly), the
// gmtrade_program swapped for SPL Token on each instruction, a trader who is also a risk authority, and every
// checked-arithmetic limit (slot sums, the order counter and open interest written directly).
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, MintLayout, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  CLOSE_ALL, GMTRADE_PROGRAM_ID, GMTRADE_STORE, USDC_MINT, configPda, eventAuthorityPda, feeVaultPda, gmOrderEscrow, gmOrderPda, gmPositionPda,
  gmStoreWallet, gmUserPda, marketConfigPda, orderNonce, tierPda,
} from '@props/sdk';
import { compare, type Env } from './harness.ts';

export type Funded = { trader: Keypair; funded: PublicKey; owner: PublicKey; ownerUsdc: PublicKey };
type Market = 'SOL' | 'BTC' | 'ETH' | 'XAU' | 'NVDA' | 'EUR';

const HIGH = 10n ** 30n; // acceptable price for buys
const LOW = 1n; // acceptable price for sells
const MAX64 = 2n ** 64n - 1n;
const MAX128 = 2n ** 128n - 1n;
/** FundedAccount / MarketConfig byte offsets (discriminator included; checked against the IDL decoder). */
export const FUNDED = { status: 132, slot: (i: number) => 133 + 113 * i, order: (j: number) => 1037 + 59 * j, orderSeq: 1509 };
export const SLOT = { sizeUsd: 73, pendingUsd: 89 };
export const TRACKED = { sizeUsd: 34 };
export const MARKET_OI = { long: 113, short: 129 };
export const STATUS = { active: 0, restricted: 1, payoutPending: 2, breached: 3, closed: 4 };

/** `v` as `n` little-endian bytes. */
export const le = (v: bigint, n: number) => Buffer.from(Array.from({ length: n }, (_, i) => Number((v >> BigInt(8 * i)) & 255n)));

/** Overwrites `bytes` at `at` in an account's data. */
export function write(env: Env, address: PublicKey, at: number, bytes: Uint8Array | number[]): void {
  const acc = env.svm.getAccount(address)!;
  const data = Buffer.from(acc.data);
  Buffer.from(bytes).copy(data, at);
  env.svm.setAccount(address, { ...acc, data });
}

/** `n` bytes of an account's data at `at`. */
export const read = (env: Env, address: PublicKey, at: number, n: number) => Buffer.from(env.svm.getAccount(address)!.data.slice(at, at + n));

export const setStatus = (env: Env, funded: PublicKey, status: number) => write(env, funded, FUNDED.status, [status]);
/** GMTrade Order ActionState (byte 9): 0 pending, 1 completed, 2 cancelled. */
export const setOrderState = (env: Env, order: PublicKey, state: number) => write(env, order, 9, [state]);

export function setMarketClosed(env: Env, gm: PublicKey, closed: boolean): void {
  const data = read(env, gm, 10, 1);
  write(env, gm, 10, [closed ? data[0]! | (1 << 5) : data[0]! & ~(1 << 5)]);
}

/** An initialized SPL mint that is not USDC. */
export function otherMint(env: Env): PublicKey {
  const mint = Keypair.generate().publicKey;
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  env.svm.setAccount(mint, { lamports: 1_461_600, data, owner: TOKEN_PROGRAM_ID, executable: false });
  return mint;
}

/** A token account of `mint` owned by `owner`, at its ATA address. */
export function tokenAccount(env: Env, mint: PublicKey, owner: PublicKey, amount: bigint): PublicKey {
  const address = env.setUsdc(owner, amount, getAssociatedTokenAddressSync(mint, owner, true));
  write(env, address, 0, mint.toBytes());
  return address;
}

if (import.meta.main) await compare(async ({ env: { Env, LEVERAGE, MAINNET_POSITIONS, MARKETS, USD, marketParams, swapKey, usdc }, send, snap, raw }) => {
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
  /** `ix` with instruction data byte `i` set to `b`. */
  const poke = (ix: TransactionInstruction, i: number, b: number) => raw(ix, (k, d) => { d[i] = b; return [k, d]; });
  /** `ix` without the last byte of its data. */
  const short = (ix: TransactionInstruction) => raw(ix, (k, d) => [k, d.subarray(0, d.length - 1)]);
  const ref = (x: Funded) => env.funded(x.funded);
  const pauses = (trading: boolean, all = false) => v.setPauses({ admin, paused: { newEvaluations: all, trading, payouts: all } });
  const open = (x: Funded, market: Market, p: { isLong?: boolean; collateral: string; size: bigint; limit?: bigint; trigger?: bigint; acceptable?: bigint; signer?: PublicKey }) => {
    const isLong = p.isLong ?? true;
    return v.openPosition({
      trader: p.signer ?? x.trader.publicKey,
      funded: ref(x),
      marketToken: MARKETS[market].token,
      isLong,
      orderType: p.limit ? 'limit' : 'market',
      collateral: usdc(p.collateral),
      sizeDeltaUsd: p.size,
      triggerPrice: p.limit ?? p.trigger,
      acceptablePrice: p.acceptable ?? (isLong ? HIGH : LOW),
    });
  };
  const close = (x: Funded, authority: PublicKey, p: { market?: Market; isLong?: boolean; size?: bigint; acceptable?: bigint } = {}) =>
    v.closePosition({ authority, funded: ref(x), marketToken: MARKETS[p.market ?? 'SOL'].token, isLong: p.isLong ?? true, sizeDeltaUsd: p.size ?? 400n * USD, acceptablePrice: p.acceptable ?? LOW });
  const protect = (x: Funded, trader: PublicKey, p: { market?: Market; type?: 'takeProfit' | 'stopLoss'; trigger?: bigint; size?: bigint } = {}) =>
    v.setProtection({ trader, funded: ref(x), marketToken: MARKETS[p.market ?? 'SOL'].token, isLong: true, orderType: p.type ?? 'takeProfit', triggerPrice: p.trigger ?? 150n * 10n ** 11n, sizeDeltaUsd: p.size ?? 1000n * USD });
  const update = (x: Funded, order: PublicKey, p: { triggerPrice?: bigint; acceptablePrice?: bigint; sizeDeltaUsd?: bigint }, trader = x.trader.publicKey) =>
    v.updateOrder({ trader, funded: ref(x), order, ...p });
  const cancel = (x: Funded, order: PublicKey, authority = x.trader.publicKey) => v.cancelOrder({ authority, funded: ref(x), order });
  /** A keeper filled `order`: escrow and order closed, the position holds `size` / `collateral`. */
  const fill = (order: PublicKey, position: PublicKey, size: bigint, collateral: string) => {
    env.executeOrder(order, gmOrderEscrow(order));
    env.setPosition(position, size, usdc(collateral));
  };
  const accounts = (x: Funded, ...extra: PublicKey[]) => [x.funded, x.owner, x.ownerUsdc, ...extra];
  const markets = (...names: Market[]) => names.map((n) => marketConfigPda(MARKETS[n].token));
  const slotIndex = (x: Funded, market: Market, isLong: boolean) =>
    env.account('fundedAccount', x.funded).slots.findIndex((s) => s.marketToken.equals(MARKETS[market].token) && s.isLong === isLong);

  const f = await env.activeFunded(); // 10K tier: 500 USDC principal, exposure cap $10,000
  env.svm.airdrop(f.owner, 1_000_000_000n); // GMTrade rents for its 4 positions and up to 8 orders exceed one float
  const g = await env.activeFunded();

  // ---------- open_position: malformed data and accounts ----------
  const o = await open(f, 'SOL', { collateral: '100', size: 1000n * USD });
  const solLong = gmPositionPda(f.owner, MARKETS.SOL.token, true);
  send(env, 'open short data', short(o.instruction), [f.trader]);
  send(env, 'open bad bool', poke(o.instruction, 8, 2), [f.trader]);
  send(env, 'open bad order type', poke(o.instruction, 9, 5), [f.trader]);
  send(env, 'open missing accounts', raw(o.instruction, (k, d) => [k.slice(0, 19), d]), [f.trader]);
  send(env, 'open not signer', at(o.instruction, 0, { isSigner: false }), [stranger]);
  for (const [i, name] of [[2, 'funded'], [3, 'owner'], [4, 'owner usdc'], [5, 'market config'], [8, 'gm market'], [9, 'gm user'], [10, 'gm position'], [11, 'gm order'], [12, 'order escrow']] as const) {
    send(env, `open ${name} readonly`, at(o.instruction, i, { isWritable: false }), [f.trader]);
  }
  send(env, 'open config is a tier', swapKey(o.instruction, configPda(), tierPda(1)), [f.trader]);
  send(env, 'open config missing', swapKey(o.instruction, configPda(), Keypair.generate().publicKey), [f.trader]);
  send(env, 'open funded of another trader', swapKey(o.instruction, f.funded, g.funded), [f.trader]);
  send(env, 'open funded is a market config', swapKey(o.instruction, f.funded, marketConfigPda(MARKETS.BTC.token)), [f.trader]);
  const fundedCopy = Keypair.generate().publicKey;
  env.svm.setAccount(fundedCopy, { ...env.svm.getAccount(f.funded)! });
  send(env, 'open funded copy', swapKey(o.instruction, f.funded, fundedCopy), [f.trader]);
  send(env, 'open owner not system', swapKey(o.instruction, f.owner, feeVaultPda()), [f.trader]);
  send(env, 'open owner of another account', swapKey(o.instruction, f.owner, g.owner), [f.trader]);
  send(env, 'open owner usdc of a stranger', swapKey(o.instruction, f.ownerUsdc, strangerUsdc), [f.trader]);
  send(env, 'open owner usdc of the other account', swapKey(o.instruction, f.ownerUsdc, g.ownerUsdc), [f.trader]);
  const notAta = env.setUsdc(f.owner, usdc('500'), Keypair.generate().publicKey);
  send(env, 'open owner usdc not the ata', swapKey(o.instruction, f.ownerUsdc, notAta), [f.trader]);
  send(env, 'open owner usdc is a wallet', swapKey(o.instruction, f.ownerUsdc, stranger.publicKey), [f.trader]);
  const ownerOther = tokenAccount(env, mint, f.owner, usdc('500'));
  send(env, 'open owner usdc of another mint', swapKey(o.instruction, f.ownerUsdc, ownerOther), [f.trader]);
  send(env, 'open other mint', swapKey(swapKey(o.instruction, f.ownerUsdc, ownerOther), USDC_MINT, mint), [f.trader]);
  send(env, 'open mint not a mint', swapKey(o.instruction, USDC_MINT, strangerUsdc), [f.trader]);
  send(env, 'open wrong market config', swapKey(o.instruction, marketConfigPda(MARKETS.SOL.token), marketConfigPda(MARKETS.BTC.token)), [f.trader]);
  send(env, 'open market config is a tier', swapKey(o.instruction, marketConfigPda(MARKETS.SOL.token), tierPda(2)), [f.trader]);
  send(env, 'open market config missing', swapKey(o.instruction, marketConfigPda(MARKETS.SOL.token), marketConfigPda(mint)), [f.trader]);
  send(env, 'open wrong store', swapKey(o.instruction, GMTRADE_STORE, stranger.publicKey), [f.trader]);
  send(env, 'open wrong gm market', swapKey(o.instruction, MARKETS.SOL.gm, MARKETS.BTC.gm), [f.trader]);
  send(env, 'open wrong escrow', swapKey(o.instruction, gmOrderEscrow(o.order), strangerUsdc), [f.trader]);
  send(env, 'open escrow of another order', swapKey(o.instruction, gmOrderEscrow(o.order), gmOrderEscrow(gmOrderPda(f.owner, orderNonce(1n)))), [f.trader]);
  send(env, 'open gmtrade is spl token', swapKey(o.instruction, GMTRADE_PROGRAM_ID, TOKEN_PROGRAM_ID), [f.trader]);
  send(env, 'open wrong token program', swapKey(o.instruction, TOKEN_PROGRAM_ID, SystemProgram.programId), [f.trader]);
  send(env, 'open wrong ata program', swapKey(o.instruction, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID), [f.trader]);
  send(env, 'open wrong system program', swapKey(o.instruction, SystemProgram.programId, TOKEN_PROGRAM_ID), [f.trader]);
  send(env, 'open wrong event authority', swapKey(o.instruction, eventAuthorityPda(), stranger.publicKey), [f.trader]);
  send(env, 'open wrong program account', at(o.instruction, 19, { pubkey: stranger.publicKey }), [f.trader]);
  send(env, 'open wrong gm event authority', at(o.instruction, 13, { pubkey: stranger.publicKey }), [f.trader]);
  send(env, 'open wrong gm user', swapKey(o.instruction, gmUserPda(f.owner), gmUserPda(g.owner)), [f.trader]);
  const chosen = gmOrderPda(f.owner, orderNonce(7n));
  send(env, 'open chosen order address', swapKey(swapKey(o.instruction, o.order, chosen), gmOrderEscrow(o.order), gmOrderEscrow(chosen)), [f.trader]);
  send(env, 'open foreign position (new slot)', swapKey(o.instruction, solLong, MAINNET_POSITIONS.long), [f.trader]);
  send(env, 'open by a stranger', (await open(f, 'SOL', { collateral: '100', size: 1000n * USD, signer: stranger.publicKey })).instruction, [stranger]);
  send(env, 'open by the other trader', (await open(f, 'SOL', { collateral: '100', size: 1000n * USD, signer: g.trader.publicKey })).instruction, [g.trader]);

  // ---------- open_position: refusals of the handler ----------
  send(env, 'pause trading', await pauses(true), [env.admin]);
  send(env, 'open paused', o.instruction, [f.trader]);
  send(env, 'resume trading', await pauses(false), [env.admin]);
  for (const [name, status] of [['restricted', STATUS.restricted], ['payout pending', STATUS.payoutPending], ['breached', STATUS.breached], ['closed', STATUS.closed]] as const) {
    setStatus(env, f.funded, status);
    send(env, `open ${name}`, o.instruction, [f.trader]);
  }
  setStatus(env, f.funded, STATUS.active);
  send(env, 'disable SOL', await v.upsertMarket({ admin, marketToken: MARKETS.SOL.token, params: marketParams('SOL', LEVERAGE.crypto, { enabled: false }) }), [env.admin]);
  send(env, 'open disabled market', o.instruction, [f.trader]);
  send(env, 'enable SOL', await v.upsertMarket({ admin, marketToken: MARKETS.SOL.token, params: marketParams('SOL', LEVERAGE.crypto) }), [env.admin]);
  for (const [t, name] of [[2, 'close'], [3, 'take profit'], [4, 'stop loss']] as const) send(env, `open order type ${name}`, poke(o.instruction, 9, t), [f.trader]);
  send(env, 'open zero acceptable price', (await open(f, 'SOL', { collateral: '100', size: 1000n * USD, acceptable: 0n })).instruction, [f.trader]);
  send(env, 'open market with trigger', (await open(f, 'SOL', { collateral: '100', size: 1000n * USD, trigger: 5n })).instruction, [f.trader]);
  send(env, 'open limit without trigger', poke(o.instruction, 9, 1), [f.trader]);
  send(env, 'open zero collateral', (await open(f, 'SOL', { collateral: '0', size: 0n })).instruction, [f.trader]);
  send(env, 'open over balance', (await open(f, 'SOL', { collateral: '500.000001', size: 1000n * USD })).instruction, [f.trader]);
  send(env, 'open over leverage', (await open(f, 'SOL', { collateral: '10', size: 251n * USD })).instruction, [f.trader]);
  send(env, 'open stock over leverage', (await open(f, 'NVDA', { collateral: '10', size: 81n * USD })).instruction, [f.trader]);
  send(env, 'open position too large', (await open(f, 'ETH', { collateral: '450', size: 10_001n * USD })).instruction, [f.trader]);
  send(env, 'open size overflow', (await open(f, 'SOL', { collateral: '10', size: MAX128 })).instruction, [f.trader]);
  setMarketClosed(env, MARKETS.NVDA.gm, true);
  send(env, 'open closed market', (await open(f, 'NVDA', { collateral: '10', size: 50n * USD })).instruction, [f.trader]);
  setMarketClosed(env, MARKETS.NVDA.gm, false);

  // ---------- open_position: success paths and the account exposure cap ----------
  // A stranger pre-creates the next order address and its escrow: the order still opens there.
  send(env, 'grief next order', [
    SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: o.order, lamports: 5_000_000 }),
    createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, gmOrderEscrow(o.order), o.order, USDC_MINT),
  ], [stranger]);
  snap(env, 'before open', [...accounts(f, o.order, gmOrderEscrow(o.order), solLong, gmUserPda(f.owner)), ...markets('SOL')]);
  send(env, 'open', o.instruction, [f.trader]); // order 0
  snap(env, 'after open', [...accounts(f, o.order, gmOrderEscrow(o.order), solLong, gmUserPda(f.owner)), ...markets('SOL')]);
  send(env, 'open again same order', o.instruction, [f.trader]);
  const again = await open(f, 'SOL', { collateral: '10', size: 250n * USD }); // exactly 25x, existing slot
  send(env, 'open existing slot foreign position', swapKey(again.instruction, solLong, MAINNET_POSITIONS.long), [f.trader]);
  send(env, 'open existing slot other side position', swapKey(again.instruction, solLong, gmPositionPda(f.owner, MARKETS.SOL.token, false)), [f.trader]);
  send(env, 'open existing slot', again.instruction, [f.trader]); // order 1
  const limit = await open(f, 'BTC', { isLong: false, collateral: '50', size: 500n * USD, limit: 90_000n * 10n ** 12n });
  send(env, 'open limit short', limit.instruction, [f.trader]); // order 2
  snap(env, 'after limit', [...accounts(f, again.order, limit.order, gmPositionPda(f.owner, MARKETS.BTC.token, false)), ...markets('SOL', 'BTC')]);
  const eth = await open(f, 'ETH', { collateral: '240', size: 6_000n * USD });
  send(env, 'open eth', eth.instruction, [f.trader]); // order 3; 7,750 committed, 100 USDC left
  send(env, 'open over exposure', (await open(f, 'BTC', { collateral: '100', size: 2_251n * USD })).instruction, [f.trader]);
  const btcLong = await open(f, 'BTC', { collateral: '100', size: 2_250n * USD });
  send(env, 'open to the exposure cap', btcLong.instruction, [f.trader]); // order 4

  // Market position size and open interest caps across accounts.
  send(env, 'cap XAU', await v.upsertMarket({ admin, marketToken: MARKETS.XAU.token, params: marketParams('XAU', LEVERAGE.metals, { maxPositionUsd: usdc('2000'), maxTotalOiUsd: usdc('2000') }) }), [env.admin]);
  send(env, 'g over XAU position size', (await open(g, 'XAU', { collateral: '150', size: 2_001n * USD })).instruction, [g.trader]);
  send(env, 'g opens XAU', (await open(g, 'XAU', { collateral: '100', size: 1_500n * USD })).instruction, [g.trader]);
  const q = await env.activeFunded();
  send(env, 'open over open interest', (await open(q, 'XAU', { collateral: '100', size: 501n * USD })).instruction, [q.trader]);
  send(env, 'open to the open interest cap', (await open(q, 'XAU', { collateral: '100', size: 500n * USD })).instruction, [q.trader]);
  send(env, 'open short side of XAU', (await open(q, 'XAU', { isLong: false, collateral: '100', size: 600n * USD })).instruction, [q.trader]);
  send(env, 'uncap XAU', await v.upsertMarket({ admin, marketToken: MARKETS.XAU.token, params: marketParams('XAU', LEVERAGE.metals) }), [env.admin]);
  snap(env, 'after caps', [f.funded, g.funded, q.funded, ...markets('XAU', 'ETH', 'BTC')]);

  // Checked-arithmetic limits: collateral × leverage, slot, account and market sums, the order counter.
  const h = await env.activeFunded();
  env.setUsdcBalance(h.ownerUsdc, MAX64);
  send(env, 'max leverage', await v.upsertMarket({ admin, marketToken: MARKETS.EUR.token, params: { ...marketParams('EUR', LEVERAGE.fx), maxLeverageBps: 4_294_967_295, closedMaxLeverageBps: 0 } }), [env.admin]);
  send(env, 'open collateral x leverage overflow', (await open(h, 'EUR', { collateral: '18446744073709.551615', size: USD })).instruction, [h.trader]);
  send(env, 'restore EUR', await v.upsertMarket({ admin, marketToken: MARKETS.EUR.token, params: marketParams('EUR', LEVERAGE.fx) }), [env.admin]);
  env.setUsdcBalance(h.ownerUsdc, usdc('500'));
  send(env, 'h opens SOL', (await open(h, 'SOL', { collateral: '10', size: 100n * USD })).instruction, [h.trader]);
  write(env, h.funded, FUNDED.slot(0) + SLOT.sizeUsd, le(MAX128 - 50n * USD, 16));
  send(env, 'open slot committed overflow', (await open(h, 'SOL', { collateral: '10', size: 100n * USD })).instruction, [h.trader]);
  send(env, 'open account exposure overflow', (await open(h, 'BTC', { collateral: '10', size: 100n * USD })).instruction, [h.trader]);
  write(env, h.funded, FUNDED.slot(0) + SLOT.sizeUsd, le(0n, 16));
  const btcConfig = marketConfigPda(MARKETS.BTC.token);
  const btcOiLong = read(env, btcConfig, MARKET_OI.long, 16);
  write(env, btcConfig, MARKET_OI.long, le(MAX128 - 50n * USD, 16));
  send(env, 'open market open interest overflow', (await open(h, 'BTC', { collateral: '10', size: 100n * USD })).instruction, [h.trader]);
  write(env, btcConfig, MARKET_OI.long, btcOiLong);
  write(env, h.funded, FUNDED.orderSeq, le(MAX64, 8));
  send(env, 'open order counter overflow', (await open(h, 'BTC', { collateral: '10', size: 100n * USD })).instruction, [h.trader]);
  // GMTrade executed and closed order 0, nobody synced, and the counter is back at 0: the new order lands at the same,
  // still tracked, address.
  const hSol = env.account('fundedAccount', h.funded).orders[0]!.order;
  env.executeOrder(hSol, gmOrderEscrow(hSol));
  write(env, h.funded, FUNDED.orderSeq, le(0n, 8));
  send(env, 'open over a tracked order address', (await open(h, 'BTC', { collateral: '10', size: 100n * USD })).instruction, [h.trader]);
  write(env, h.funded, FUNDED.orderSeq, le(1n, 8));
  snap(env, 'after limits', [h.funded, ...markets('SOL', 'BTC', 'EUR')]);

  // 8 slots, then 8 tracked orders.
  const k = await env.activeFunded();
  env.svm.airdrop(k.owner, 1_000_000_000n); // GMTrade rents for 8 positions + 8 orders exceed one float
  for (const [m, isLong] of [['SOL', true], ['SOL', false], ['BTC', true], ['BTC', false], ['ETH', true], ['ETH', false], ['XAU', true], ['XAU', false]] as const) {
    send(env, `k opens ${m} ${isLong ? 'long' : 'short'}`, (await open(k, m, { isLong, collateral: '5', size: 20n * USD })).instruction, [k.trader]);
  }
  send(env, 'open no free slot', (await open(k, 'EUR', { collateral: '5', size: 20n * USD })).instruction, [k.trader]);
  send(env, 'open too many orders', (await open(k, 'SOL', { collateral: '5', size: 20n * USD })).instruction, [k.trader]);
  snap(env, 'eight', [...accounts(k), ...markets('SOL', 'BTC', 'ETH', 'XAU')]);

  // ---------- close_position ----------
  // f's SOL long ($1,250) fills; sync drops orders 0 and 1.
  fill(o.order, solLong, 1000n * USD, '99.9');
  fill(again.order, solLong, 1250n * USD, '109.8');
  send(env, 'sync f', await v.sync({ funded: ref(f) }), [risk]);
  const c = await close(f, f.trader.publicKey);
  send(env, 'close short data', short(c.instruction), [f.trader]);
  send(env, 'close bad bool', poke(c.instruction, 8, 2), [f.trader]);
  send(env, 'close missing accounts', raw(c.instruction, (k2, d) => [k2.slice(0, 18), d]), [f.trader]);
  send(env, 'close not signer', at(c.instruction, 0, { isSigner: false }), [stranger]);
  for (const [i, name] of [[2, 'funded'], [3, 'owner'], [7, 'gm market'], [8, 'gm user'], [9, 'gm position'], [10, 'gm order'], [11, 'order escrow']] as const) {
    send(env, `close ${name} readonly`, at(c.instruction, i, { isWritable: false }), [f.trader]);
  }
  send(env, 'close config is a tier', swapKey(c.instruction, configPda(), tierPda(1)), [f.trader]);
  send(env, 'close funded of another trader', swapKey(c.instruction, f.funded, g.funded), [f.trader]);
  send(env, 'close another account', swapKey(swapKey(c.instruction, f.funded, g.funded), f.owner, g.owner), [f.trader]);
  send(env, 'close funded copy', swapKey(c.instruction, f.funded, fundedCopy), [f.trader]);
  send(env, 'close owner not system', swapKey(c.instruction, f.owner, feeVaultPda()), [f.trader]);
  send(env, 'close wrong market config', swapKey(c.instruction, marketConfigPda(MARKETS.SOL.token), marketConfigPda(MARKETS.BTC.token)), [f.trader]);
  send(env, 'close market config is funded', swapKey(c.instruction, marketConfigPda(MARKETS.SOL.token), g.funded), [f.trader]);
  send(env, 'close other market', swapKey(swapKey(c.instruction, marketConfigPda(MARKETS.SOL.token), marketConfigPda(MARKETS.ETH.token)), MARKETS.SOL.gm, MARKETS.ETH.gm), [f.trader]);
  send(env, 'close other mint', swapKey(c.instruction, USDC_MINT, mint), [f.trader]);
  send(env, 'close mint not a mint', swapKey(c.instruction, USDC_MINT, strangerUsdc), [f.trader]);
  send(env, 'close wrong store', swapKey(c.instruction, GMTRADE_STORE, stranger.publicKey), [f.trader]);
  send(env, 'close wrong gm market', swapKey(c.instruction, MARKETS.SOL.gm, MARKETS.BTC.gm), [f.trader]);
  send(env, 'close wrong escrow', swapKey(c.instruction, gmOrderEscrow(c.order), strangerUsdc), [f.trader]);
  send(env, 'close gmtrade is spl token', swapKey(c.instruction, GMTRADE_PROGRAM_ID, TOKEN_PROGRAM_ID), [f.trader]);
  send(env, 'close wrong token program', swapKey(c.instruction, TOKEN_PROGRAM_ID, SystemProgram.programId), [f.trader]);
  send(env, 'close wrong ata program', swapKey(c.instruction, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID), [f.trader]);
  send(env, 'close wrong system program', swapKey(c.instruction, SystemProgram.programId, TOKEN_PROGRAM_ID), [f.trader]);
  send(env, 'close wrong event authority', swapKey(c.instruction, eventAuthorityPda(), stranger.publicKey), [f.trader]);
  send(env, 'close foreign position', swapKey(c.instruction, solLong, MAINNET_POSITIONS.long), [f.trader]);
  send(env, 'close chosen order address', swapKey(swapKey(c.instruction, c.order, chosen), gmOrderEscrow(c.order), gmOrderEscrow(chosen)), [f.trader]);
  send(env, 'close by a stranger', (await close(f, stranger.publicKey)).instruction, [stranger]);
  send(env, 'close by the other trader', (await close(f, g.trader.publicKey)).instruction, [g.trader]);
  send(env, 'close zero acceptable price', (await close(f, f.trader.publicKey, { acceptable: 0n })).instruction, [f.trader]);
  send(env, 'close zero size', (await close(f, f.trader.publicKey, { size: 0n })).instruction, [f.trader]);
  send(env, 'close below $1', (await close(f, f.trader.publicKey, { size: USD - 1n })).instruction, [f.trader]);
  send(env, 'close no position', (await close(f, f.trader.publicKey, { market: 'NVDA' })).instruction, [f.trader]);
  send(env, 'close no position on that side', (await close(f, f.trader.publicKey, { isLong: false })).instruction, [f.trader]);
  setStatus(env, f.funded, STATUS.closed);
  send(env, 'close closed account', c.instruction, [f.trader]);
  send(env, 'force close closed account', (await close(f, risk.publicKey)).instruction, [risk]);
  // Pauses and every other status never block a close.
  send(env, 'pause all', await pauses(true, true), [env.admin]);
  setStatus(env, f.funded, STATUS.restricted);
  send(env, 'close market config readonly', at(c.instruction, 4, { isWritable: false }), [f.trader]); // order 0
  snap(env, 'after close', [...accounts(f, c.order, gmOrderEscrow(c.order), solLong), ...markets('SOL')]);
  setStatus(env, f.funded, STATUS.breached);
  const forced = await close(f, risk.publicKey, { size: CLOSE_ALL });
  send(env, 'force close', forced.instruction, [risk]); // order 1
  setStatus(env, f.funded, STATUS.payoutPending);
  const pp = await close(f, f.trader.publicKey, { size: USD });
  send(env, 'close while payout pending', pp.instruction, [f.trader]); // order 5
  setStatus(env, f.funded, STATUS.active);
  send(env, 'trader is a risk authority', await v.setAuthorities({ admin, riskAuthorities: [risk.publicKey, f.trader.publicKey], kycAuthority: env.kyc.publicKey }), [env.admin]);
  const both = await close(f, f.trader.publicKey, { size: 2n * USD });
  send(env, 'close by a trader who is a risk authority', both.instruction, [f.trader]); // order 6
  send(env, 'authorities back', await v.setAuthorities({ admin, riskAuthorities: [risk.publicKey], kycAuthority: env.kyc.publicKey }), [env.admin]);
  snap(env, 'after forced', [...accounts(f, forced.order, pp.order, both.order), ...markets('SOL')]);
  // Pending increases cancelled while paused: by the trader, and by a risk authority.
  send(env, 'cancel eth', await cancel(f, eth.order), [f.trader]); // frees order 3
  send(env, 'risk cancels btc long', await cancel(f, btcLong.order, risk.publicKey), [risk]); // frees order 4
  snap(env, 'after cancels', [...accounts(f, eth.order, btcLong.order, gmOrderEscrow(eth.order)), ...markets('ETH', 'BTC')]);

  // ---------- set_protection ----------
  const tp = await protect(f, f.trader.publicKey);
  send(env, 'protect short data', short(tp.instruction), [f.trader]);
  send(env, 'protect bad order type', poke(tp.instruction, 9, 5), [f.trader]);
  send(env, 'protect missing accounts', raw(tp.instruction, (k2, d) => [k2.slice(0, 18), d]), [f.trader]);
  send(env, 'protect not signer', at(tp.instruction, 0, { isSigner: false }), [stranger]);
  send(env, 'protect funded readonly', at(tp.instruction, 2, { isWritable: false }), [f.trader]);
  send(env, 'protect gmtrade is spl token', swapKey(tp.instruction, GMTRADE_PROGRAM_ID, TOKEN_PROGRAM_ID), [f.trader]);
  send(env, 'protect wrong gm market', swapKey(tp.instruction, MARKETS.SOL.gm, MARKETS.BTC.gm), [f.trader]);
  send(env, 'protect by a risk authority', (await protect(f, risk.publicKey)).instruction, [risk]);
  send(env, 'protect by a stranger', (await protect(f, stranger.publicKey)).instruction, [stranger]);
  for (const [t, name] of [[0, 'market'], [1, 'limit'], [2, 'close']] as const) send(env, `protect order type ${name}`, poke(tp.instruction, 9, t), [f.trader]);
  send(env, 'protect zero trigger', (await protect(f, f.trader.publicKey, { trigger: 0n })).instruction, [f.trader]);
  send(env, 'protect below $1', (await protect(f, f.trader.publicKey, { size: USD - 1n })).instruction, [f.trader]);
  send(env, 'protect no position', (await protect(f, f.trader.publicKey, { market: 'EUR' })).instruction, [f.trader]);
  setStatus(env, f.funded, STATUS.payoutPending);
  send(env, 'protect payout pending', tp.instruction, [f.trader]);
  setStatus(env, f.funded, STATUS.closed);
  send(env, 'protect closed', tp.instruction, [f.trader]);
  setStatus(env, f.funded, STATUS.breached);
  send(env, 'take profit', tp.instruction, [f.trader]); // order 3
  setStatus(env, f.funded, STATUS.restricted);
  const sl = await protect(f, f.trader.publicKey, { type: 'stopLoss', trigger: 100n * 10n ** 11n });
  send(env, 'stop loss', sl.instruction, [f.trader]); // order 4
  setStatus(env, f.funded, STATUS.active);
  const tp2 = await protect(f, f.trader.publicKey, { trigger: 200n * 10n ** 11n, size: 500n * USD });
  send(env, 'second take profit', tp2.instruction, [f.trader]); // order 7: 8 tracked
  send(env, 'protect too many orders', (await protect(f, f.trader.publicKey, { type: 'stopLoss', trigger: 90n * 10n ** 11n })).instruction, [f.trader]);
  send(env, 'close too many orders', (await close(f, risk.publicKey, { size: CLOSE_ALL })).instruction, [risk]);
  snap(env, 'after protect', [...accounts(f, tp.order, sl.order, tp2.order, gmOrderEscrow(sl.order)), ...markets('SOL')]);
  send(env, 'resume all', await pauses(false), [env.admin]);

  // ---------- update_order ----------
  const u = await update(f, tp.order, { triggerPrice: 160n * 10n ** 11n });
  send(env, 'update short data', short(u), [f.trader]);
  send(env, 'update bad option tag', poke(u, 8, 2), [f.trader]);
  send(env, 'update missing accounts', raw(u, (k2, d) => [k2.slice(0, 11), d]), [f.trader]);
  send(env, 'update not signer', at(u, 0, { isSigner: false }), [stranger]);
  for (const [i, name] of [[2, 'funded'], [4, 'market config'], [6, 'gm market'], [7, 'gm order']] as const) send(env, `update ${name} readonly`, at(u, i, { isWritable: false }), [f.trader]);
  send(env, 'update config is a tier', swapKey(u, configPda(), tierPda(1)), [f.trader]);
  send(env, 'update by a stranger', await update(f, tp.order, { triggerPrice: 1n }, stranger.publicKey), [stranger]);
  send(env, 'update by the other trader', await update(f, tp.order, { triggerPrice: 1n }, g.trader.publicKey), [g.trader]);
  send(env, 'update funded of another trader', swapKey(u, f.funded, g.funded), [f.trader]);
  send(env, 'update owner not system', swapKey(u, f.owner, feeVaultPda()), [f.trader]);
  send(env, 'update owner of another account', swapKey(u, f.owner, g.owner), [f.trader]);
  send(env, 'update wrong market config', swapKey(u, marketConfigPda(MARKETS.SOL.token), marketConfigPda(MARKETS.BTC.token)), [f.trader]);
  send(env, 'update other market', swapKey(swapKey(u, marketConfigPda(MARKETS.SOL.token), marketConfigPda(MARKETS.BTC.token)), MARKETS.SOL.gm, MARKETS.BTC.gm), [f.trader]);
  send(env, 'update wrong store', swapKey(u, GMTRADE_STORE, stranger.publicKey), [f.trader]);
  send(env, 'update wrong gm market', swapKey(u, MARKETS.SOL.gm, MARKETS.BTC.gm), [f.trader]);
  send(env, 'update gmtrade is spl token', swapKey(u, GMTRADE_PROGRAM_ID, TOKEN_PROGRAM_ID), [f.trader]);
  send(env, 'update wrong event authority', swapKey(u, eventAuthorityPda(), stranger.publicKey), [f.trader]);
  send(env, 'update wrong gm event authority', at(u, 8, { pubkey: stranger.publicKey }), [f.trader]);
  send(env, 'update untracked order', swapKey(u, tp.order, gmOrderPda(f.owner, orderNonce(99n))), [f.trader]);
  send(env, 'update forced close', await update(f, forced.order, { acceptablePrice: 2n }), [f.trader]);
  send(env, 'update market close', await update(f, c.order, { acceptablePrice: 2n }), [f.trader]);
  send(env, 'update nothing', await update(f, tp.order, {}), [f.trader]);
  send(env, 'update zero acceptable price', await update(f, tp.order, { acceptablePrice: 0n }), [f.trader]);
  send(env, 'update zero trigger', await update(f, tp.order, { triggerPrice: 0n }), [f.trader]);
  send(env, 'update decrease to zero', await update(f, tp.order, { sizeDeltaUsd: 0n }), [f.trader]);
  setStatus(env, f.funded, STATUS.closed);
  send(env, 'update closed', u, [f.trader]);
  setStatus(env, f.funded, STATUS.restricted);
  send(env, 'update take profit trigger', u, [f.trader]);
  send(env, 'update limit while restricted', await update(f, limit.order, { triggerPrice: 95_000n * 10n ** 12n }), [f.trader]);
  setStatus(env, f.funded, STATUS.breached);
  send(env, 'update limit while breached', await update(f, limit.order, { triggerPrice: 95_000n * 10n ** 12n }), [f.trader]);
  setStatus(env, f.funded, STATUS.active);
  send(env, 'pause trading again', await pauses(true), [env.admin]);
  send(env, 'update limit while paused', await update(f, limit.order, { triggerPrice: 95_000n * 10n ** 12n }), [f.trader]);
  send(env, 'update take profit while paused', await update(f, tp.order, { triggerPrice: 170n * 10n ** 11n }), [f.trader]);
  send(env, 'resume trading again', await pauses(false), [env.admin]);
  send(env, 'update stop loss all fields', await update(f, sl.order, { triggerPrice: 95n * 10n ** 11n, acceptablePrice: 5n, sizeDeltaUsd: 800n * USD }), [f.trader]);
  // BTC short limit, 50 USDC collateral at 25x: at most $1,250.
  send(env, 'update limit over leverage', await update(f, limit.order, { sizeDeltaUsd: 1_251n * USD }), [f.trader]);
  send(env, 'update limit size overflow', await update(f, limit.order, { sizeDeltaUsd: MAX128 }), [f.trader]);
  const btcShort = slotIndex(f, 'BTC', false);
  const solSlot = slotIndex(f, 'SOL', true);
  write(env, f.funded, FUNDED.slot(btcShort) + SLOT.sizeUsd, le(9_000n * USD, 16));
  send(env, 'update limit over position size', await update(f, limit.order, { sizeDeltaUsd: 1_250n * USD }), [f.trader]);
  write(env, f.funded, FUNDED.slot(btcShort) + SLOT.sizeUsd, le(0n, 16));
  write(env, f.funded, FUNDED.slot(solSlot) + SLOT.sizeUsd, le(8_800n * USD, 16));
  send(env, 'update limit over exposure', await update(f, limit.order, { sizeDeltaUsd: 1_250n * USD }), [f.trader]);
  write(env, f.funded, FUNDED.slot(solSlot) + SLOT.sizeUsd, le(1_250n * USD, 16));
  const btcOiShort = read(env, btcConfig, MARKET_OI.short, 16);
  const oiShort = btcOiShort.readBigUInt64LE(0) + (btcOiShort.readBigUInt64LE(8) << 64n);
  write(env, btcConfig, MARKET_OI.short, le(99_300n * USD, 16));
  send(env, 'update limit over open interest', await update(f, limit.order, { sizeDeltaUsd: 1_250n * USD }), [f.trader]);
  write(env, btcConfig, MARKET_OI.short, le(oiShort, 16));
  send(env, 'update limit resize', await update(f, limit.order, { sizeDeltaUsd: 1_250n * USD, triggerPrice: 91_000n * 10n ** 12n }), [f.trader]);
  send(env, 'update limit shrink', await update(f, limit.order, { sizeDeltaUsd: 300n * USD }), [f.trader]);
  snap(env, 'after update', [...accounts(f, tp.order, sl.order, limit.order), ...markets('SOL', 'BTC')]);
  // The slot's pending sum below the order's size once the update went through: MathOverflow after the CPI.
  write(env, f.funded, FUNDED.slot(btcShort) + SLOT.sizeUsd, le(1_000n * USD, 16));
  write(env, f.funded, FUNDED.slot(btcShort) + SLOT.pendingUsd, le(0n, 16));
  send(env, 'update pending underflow', await update(f, limit.order, { sizeDeltaUsd: 400n * USD }), [f.trader]);
  write(env, f.funded, FUNDED.slot(btcShort) + SLOT.sizeUsd, le(0n, 16));
  write(env, f.funded, FUNDED.slot(btcShort) + SLOT.pendingUsd, le(300n * USD, 16));
  // GMTrade refuses to update an order it already finished.
  setOrderState(env, sl.order, 1);
  send(env, 'update completed order', await update(f, sl.order, { triggerPrice: 96n * 10n ** 11n }), [f.trader]);
  setOrderState(env, sl.order, 0);

  // ---------- cancel_order ----------
  const x = await cancel(f, limit.order);
  send(env, 'cancel missing accounts', raw(x, (k2, d) => [k2.slice(0, 18), d]), [f.trader]);
  send(env, 'cancel not signer', at(x, 0, { isSigner: false }), [stranger]);
  for (const [i, name] of [[2, 'funded'], [3, 'owner'], [4, 'owner usdc'], [5, 'market config'], [7, 'gm store'], [8, 'store wallet'], [9, 'gm user'], [10, 'gm order'], [11, 'order escrow']] as const) {
    send(env, `cancel ${name} readonly`, at(x, i, { isWritable: false }), [f.trader]);
  }
  send(env, 'cancel config is a tier', swapKey(x, configPda(), tierPda(1)), [f.trader]);
  send(env, 'cancel funded of another trader', swapKey(x, f.funded, g.funded), [f.trader]);
  send(env, 'cancel funded copy', swapKey(x, f.funded, fundedCopy), [f.trader]);
  send(env, 'cancel owner not system', swapKey(x, f.owner, feeVaultPda()), [f.trader]);
  send(env, 'cancel owner of another account', swapKey(x, f.owner, g.owner), [f.trader]);
  send(env, 'cancel owner usdc of a stranger', swapKey(x, f.ownerUsdc, strangerUsdc), [f.trader]);
  send(env, 'cancel owner usdc not the ata', swapKey(x, f.ownerUsdc, notAta), [f.trader]);
  send(env, 'cancel owner usdc is a wallet', swapKey(x, f.ownerUsdc, stranger.publicKey), [f.trader]);
  send(env, 'cancel other mint', swapKey(swapKey(x, f.ownerUsdc, ownerOther), USDC_MINT, mint), [f.trader]);
  send(env, 'cancel mint not a mint', swapKey(x, USDC_MINT, strangerUsdc), [f.trader]);
  send(env, 'cancel wrong market config', swapKey(x, marketConfigPda(MARKETS.BTC.token), marketConfigPda(MARKETS.SOL.token)), [f.trader]);
  send(env, 'cancel market config is a tier', swapKey(x, marketConfigPda(MARKETS.BTC.token), tierPda(1)), [f.trader]);
  send(env, 'cancel wrong store', swapKey(x, GMTRADE_STORE, stranger.publicKey), [f.trader]);
  send(env, 'cancel wrong store wallet', swapKey(x, gmStoreWallet(), stranger.publicKey), [f.trader]);
  send(env, 'cancel wrong gm user', swapKey(x, gmUserPda(f.owner), gmUserPda(g.owner)), [f.trader]);
  send(env, 'cancel wrong escrow', swapKey(x, gmOrderEscrow(limit.order), strangerUsdc), [f.trader]);
  send(env, 'cancel gmtrade is spl token', swapKey(x, GMTRADE_PROGRAM_ID, TOKEN_PROGRAM_ID), [f.trader]);
  send(env, 'cancel wrong token program', swapKey(x, TOKEN_PROGRAM_ID, SystemProgram.programId), [f.trader]);
  send(env, 'cancel wrong ata program', swapKey(x, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID), [f.trader]);
  send(env, 'cancel wrong system program', swapKey(x, SystemProgram.programId, TOKEN_PROGRAM_ID), [f.trader]);
  send(env, 'cancel wrong event authority', swapKey(x, eventAuthorityPda(), stranger.publicKey), [f.trader]);
  send(env, 'cancel wrong gm event authority', at(x, 12, { pubkey: stranger.publicKey }), [f.trader]);
  const untracked = gmOrderPda(f.owner, orderNonce(99n));
  send(env, 'cancel untracked order', swapKey(swapKey(x, limit.order, untracked), gmOrderEscrow(limit.order), gmOrderEscrow(untracked)), [f.trader]);
  send(env, 'cancel by a stranger', await cancel(f, limit.order, stranger.publicKey), [stranger]);
  send(env, 'cancel by the other trader', await cancel(f, limit.order, g.trader.publicKey), [g.trader]);
  send(env, 'trader cancels a forced close', await cancel(f, forced.order), [f.trader]);
  setOrderState(env, limit.order, 1);
  send(env, 'cancel completed order', x, [f.trader]);
  setOrderState(env, limit.order, 2);
  send(env, 'cancel cancelled order', x, [f.trader]);
  setOrderState(env, limit.order, 0);
  const orderAccount = env.svm.getAccount(limit.order)!;
  write(env, limit.order, 0, new Uint8Array(8));
  send(env, 'cancel order that is not an order', x, [f.trader]);
  env.svm.setAccount(limit.order, orderAccount);
  // The slot's pending sum and the market's open interest below the order's size: MathOverflow after the CPI.
  write(env, f.funded, FUNDED.slot(btcShort) + SLOT.pendingUsd, le(0n, 16));
  send(env, 'cancel pending underflow', x, [f.trader]);
  write(env, f.funded, FUNDED.slot(btcShort) + SLOT.pendingUsd, le(300n * USD, 16));
  const btcShortOi = read(env, btcConfig, MARKET_OI.short, 16);
  write(env, btcConfig, MARKET_OI.short, le(0n, 16));
  send(env, 'cancel open interest underflow', x, [f.trader]);
  write(env, btcConfig, MARKET_OI.short, btcShortOi);
  snap(env, 'before cancel', [...accounts(f, limit.order, gmOrderEscrow(limit.order)), ...markets('BTC')]);
  send(env, 'cancel limit', x, [f.trader]);
  snap(env, 'after cancel', [...accounts(f, limit.order, gmOrderEscrow(limit.order)), ...markets('BTC')]);
  send(env, 'cancel again', x, [f.trader]);
  send(env, 'risk cancels a take profit', await cancel(f, tp.order, risk.publicKey), [risk]);
  send(env, 'risk cancels a forced close', await cancel(f, forced.order, risk.publicKey), [risk]);
  setStatus(env, f.funded, STATUS.closed);
  send(env, 'cancel a stop loss on a closed account', await cancel(f, sl.order), [f.trader]);
  setStatus(env, f.funded, STATUS.active);
  send(env, 'cancel a market close', await cancel(f, c.order), [f.trader]);
  send(env, 'trader who is not a risk authority cancels its own close', await cancel(f, both.order), [f.trader]);
  env.executeOrder(pp.order, gmOrderEscrow(pp.order));
  send(env, 'cancel order GMTrade closed', await cancel(f, pp.order), [f.trader]);
  env.svm.airdrop(pp.order, 1_000_000n);
  send(env, 'cancel closed order refunded by a stranger', await cancel(f, pp.order), [f.trader]);
  snap(env, 'final', [...accounts(f), ...accounts(g), ...accounts(q), ...accounts(h), ...accounts(k), ...markets('SOL', 'BTC', 'ETH', 'XAU', 'NVDA', 'EUR')]);
});
