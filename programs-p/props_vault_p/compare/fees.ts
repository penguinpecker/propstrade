// The order fee (docs/design/order-fee.md), compared byte for byte (see harness.ts): set_order_fee; the fee open_position,
// close_position, set_protection and update_order assess (rounding, max_fee, the balance hold, the exposure-cap base under
// any market limit, a risk authority's close assessed on an active account and free on a breached one, re-assessment on
// every update); its release by cancel_order and by close_completed_order of an order the exchange cancelled; sync and
// close_completed_order of an executed order making it due; settle_order_fees with every refusal, account substitution,
// read-only flag, status, malformed data and settlement count (a replay once the fees due return); the FeesDue gates of
// request_payout and close_funded; and every checked-arithmetic limit (fee totals, the count and the rate written
// directly).
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import {
  CLOSE_ALL, USDC_MINT, capitalVaultAddress, configPda, eventAuthorityPda, feeVaultPda, gmOrderEscrow, gmPositionPda, payoutPda, tierPda,
} from '@props/sdk';
import { compare, type Env } from './harness.ts';
import { STATUS, type Funded, le, otherMint, read, setMarketClosed, setOrderState, setStatus, write } from './trading.ts';

/** FundedAccount `order_fees[j]`, `order_fees_due`, `order_fees_paid` and `order_fee_settlements` byte offsets (checked against the IDL decoder below). */
export const FEES = { order: (j: number) => 1547 + 8 * j, due: 1611, paid: 1619, settlements: 1627 };
const MAX64 = 2n ** 64n - 1n;
const HIGH = 10n ** 30n;
const LOW = 1n;

/** Rewrites Config fields in place: decode, change, encode over the old bytes. */
async function patchConfig(env: Env, f: (c: any) => void): Promise<void> {
  const acc = env.svm.getAccount(configPda())!;
  const c = env.vault.decode('config', acc.data) as any;
  f(c);
  const data = Buffer.from(acc.data);
  (await env.vault.program.coder.accounts.encode('config', c)).copy(data);
  env.svm.setAccount(configPda(), { ...acc, data });
}

await compare(async ({ env: { Env, LEVERAGE, MARKETS, USD, bn, marketParams, swapKey, usdc }, send, snap, raw }) => {
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
  /** `ix` without the last byte of its data. */
  const short = (ix: TransactionInstruction) => raw(ix, (k, d) => [k, d.subarray(0, d.length - 1)]);
  const ref = (x: Funded) => env.funded(x.funded);
  const pauses = (on: boolean) => v.setPauses({ admin, paused: { newEvaluations: on, trading: on, payouts: on } });
  const funded = async () => {
    const x = await env.activeFunded();
    env.svm.airdrop(x.owner, 2_000_000_000n); // GMTrade rents for more than four orders
    return x;
  };
  const open = (x: Funded, market: 'SOL' | 'ETH' | 'BTC', p: { collateral: bigint; size: bigint; limit?: bigint; maxFee?: bigint }) =>
    v.openPosition({
      trader: x.trader.publicKey, funded: ref(x), marketToken: MARKETS[market].token, isLong: true, orderType: p.limit ? 'limit' : 'market',
      collateral: p.collateral, sizeDeltaUsd: p.size, triggerPrice: p.limit, acceptablePrice: HIGH, maxFee: p.maxFee,
    });
  const close = (x: Funded, p: { size: bigint; authority?: PublicKey; maxFee?: bigint }) =>
    v.closePosition({ authority: p.authority ?? x.trader.publicKey, funded: ref(x), marketToken: MARKETS.SOL.token, isLong: true, sizeDeltaUsd: p.size, acceptablePrice: LOW, maxFee: p.maxFee });
  const protect = (x: Funded, p: { size: bigint; type?: 'takeProfit' | 'stopLoss'; trigger?: bigint; maxFee?: bigint }) =>
    v.setProtection({
      trader: x.trader.publicKey, funded: ref(x), marketToken: MARKETS.SOL.token, isLong: true, orderType: p.type ?? 'takeProfit',
      triggerPrice: p.trigger ?? 150n * 10n ** 11n, sizeDeltaUsd: p.size, maxFee: p.maxFee,
    });
  const update = (x: Funded, order: PublicKey, p: { triggerPrice?: bigint; sizeDeltaUsd?: bigint; maxFee?: bigint }) =>
    v.updateOrder({ trader: x.trader.publicKey, funded: ref(x), order, ...p });
  const cancel = (x: Funded, order: PublicKey, authority = x.trader.publicKey) => v.cancelOrder({ authority, funded: ref(x), order });
  const sync = (x: Funded) => v.sync({ funded: ref(x) });
  const due = (x: Funded) => BigInt(env.account('fundedAccount', x.funded).orderFeesDue.toString());
  const count = (x: Funded) => BigInt(env.account('fundedAccount', x.funded).orderFeeSettlements.toString());
  const settle = (x: Funded, charge: bigint, waive: bigint, expectedDue = due(x), riskAuthority = risk.publicKey, expectedSettlements = count(x)) =>
    v.settleOrderFees({ riskAuthority, funded: x.funded, charge, waive, expectedDue, expectedSettlements });
  const accounts = (x: Funded, ...extra: PublicKey[]) => [x.funded, x.owner, x.ownerUsdc, feeVaultPda(), capitalVaultAddress(), configPda(), ...extra];
  /** A keeper filled a market long on SOL: `size` / `collateral` on the position, the order account gone. */
  const fill = (x: Funded, order: PublicKey, size: bigint, collateral: bigint) => {
    env.executeOrder(order, gmOrderEscrow(order));
    env.setPosition(gmPositionPda(x.owner, MARKETS.SOL.token, true), size, collateral);
  };

  const f = await funded(); // 10K tier: 500 USDC principal
  const g = await funded();
  write(env, f.funded, FEES.order(3), le(11n, 8));
  write(env, f.funded, FEES.due, le(22n, 8));
  write(env, f.funded, FEES.paid, le(33n, 8));
  write(env, f.funded, FEES.settlements, le(44n, 8));
  const decoded = env.account('fundedAccount', f.funded);
  if ([decoded.orderFees[3], decoded.orderFeesDue, decoded.orderFeesPaid, decoded.orderFeeSettlements].map(String).join() !== '11,22,33,44') throw new Error('FEES offsets do not match the IDL');
  for (const offset of [FEES.order(3), FEES.due, FEES.paid, FEES.settlements]) write(env, f.funded, offset, le(0n, 8));

  // ---------- set_order_fee ----------
  const setFee = (feeUsdc: bigint, feeBps: number, who = admin) => v.setOrderFee({ admin: who, feeUsdc, feeBps });
  const rate = await setFee(500_000n, 7); // $0.50 + 7 bps
  send(env, 'fee short data', short(rate), [env.admin]);
  send(env, 'fee missing accounts', raw(rate, (k, d) => [k.slice(0, 3), d]), [env.admin]);
  send(env, 'fee not signer', at(rate, 0, { isSigner: false }), [stranger]);
  send(env, 'fee config readonly', at(rate, 1, { isWritable: false }), [env.admin]);
  send(env, 'fee config is a tier', swapKey(rate, configPda(), tierPda(1)), [env.admin]);
  send(env, 'fee wrong event authority', swapKey(rate, eventAuthorityPda(), stranger.publicKey), [env.admin]);
  send(env, 'fee by a stranger', await setFee(1n, 1, stranger.publicKey), [stranger]);
  send(env, 'fee by a risk authority', await setFee(1n, 1, risk.publicKey), [risk]);
  send(env, 'fee above the flat cap', await setFee(2_000_001n, 0), [env.admin]);
  send(env, 'fee above the bps cap', await setFee(0n, 11), [env.admin]);
  send(env, 'fee at the caps', await setFee(2_000_000n, 10), [env.admin]);
  send(env, 'pause all', await pauses(true), [env.admin]);
  send(env, 'fee while paused', rate, [env.admin]);
  send(env, 'resume', await pauses(false), [env.admin]);
  snap(env, 'after fee', [configPda()]);

  // ---------- open_position ----------
  const size = 1_234_567_891_234n * 10n ** 11n; // 1,234,567,891 micro-USD: 7 bps = 864,197.52
  const f1 = 500_000n + 864_197n;
  send(env, 'open fee above max', (await open(f, 'ETH', { collateral: usdc('100'), size, maxFee: f1 - 1n })).instruction, [f.trader]);
  const o1 = await open(f, 'ETH', { collateral: usdc('100'), size, maxFee: f1 });
  send(env, 'open short data', short(o1.instruction), [f.trader]);
  send(env, 'open fee at max', o1.instruction, [f.trader]);
  const exact = usdc('400') - 1_200_000n - f1; // collateral + its $1,000 fee + the held fee = the 400 USDC left
  send(env, 'open above balance with fees', (await open(f, 'BTC', { collateral: exact + 1n, size: 1_000n * USD })).instruction, [f.trader]);
  const o2 = await open(f, 'BTC', { collateral: exact, size: 1_000n * USD });
  send(env, 'open exactly the balance with fees', o2.instruction, [f.trader]);
  const margin = await open(f, 'ETH', { collateral: f1 + 1_200_000n, size: 0n, maxFee: 0n });
  send(env, 'open margin while fees are held', margin.instruction, [f.trader]);
  snap(env, 'after opens', accounts(f, o1.order, o2.order, margin.order));
  env.setUsdcBalance(f.ownerUsdc, usdc('100'));
  write(env, f.funded, FEES.due, le(MAX64, 8));
  send(env, 'open with fees due at u64 max', (await open(f, 'SOL', { collateral: usdc('10'), size: 100n * USD })).instruction, [f.trader]);
  write(env, f.funded, FEES.due, le(0n, 8));
  write(env, f.funded, FEES.order(0), le(MAX64, 8));
  send(env, 'open with a held fee at u64 max', (await open(f, 'SOL', { collateral: usdc('10'), size: 100n * USD })).instruction, [f.trader]);
  write(env, f.funded, FEES.order(0), le(f1, 8));
  await patchConfig(env, (c) => { c.orderFeeUsdc = bn(MAX64); });
  send(env, 'open fee overflow', (await open(f, 'SOL', { collateral: usdc('10'), size: 100n * USD })).instruction, [f.trader]);
  send(env, 'open margin with an overflowing rate', (await open(f, 'ETH', { collateral: usdc('1'), size: 0n })).instruction, [f.trader]);
  await patchConfig(env, (c) => { c.orderFeeUsdc = bn(500_000n); });

  // ---------- close_position, set_protection ----------
  const go = await open(g, 'SOL', { collateral: usdc('100'), size: 1_000n * USD });
  send(env, 'g opens', go.instruction, [g.trader]);
  fill(g, go.order, 1_000n * USD, usdc('100'));
  send(env, 'g sync: the open is due', await sync(g), [risk]);
  env.setUsdcBalance(g.ownerUsdc, 0n); // decreases need no free USDC
  const closeFee = 500_000n + 280_000n; // $400
  send(env, 'close fee above max', (await close(g, { size: 400n * USD, maxFee: closeFee - 1n })).instruction, [g.trader]);
  const c1 = await close(g, { size: 400n * USD, maxFee: closeFee });
  send(env, 'close short data', short(c1.instruction), [g.trader]);
  send(env, 'close sized', c1.instruction, [g.trader]);
  const allFee = 500_000n + 7_000_000n; // close-all: the 10K account's $10,000 exposure cap
  send(env, 'take profit fee above max', (await protect(g, { size: CLOSE_ALL, maxFee: allFee - 1n })).instruction, [g.trader]);
  const tp = await protect(g, { size: CLOSE_ALL, maxFee: allFee });
  send(env, 'protect short data', short(tp.instruction), [g.trader]);
  send(env, 'take profit close-all', tp.instruction, [g.trader]);
  const sl = await protect(g, { size: 300n * USD, type: 'stopLoss', trigger: 90n * 10n ** 11n });
  send(env, 'stop loss sized', sl.instruction, [g.trader]);
  send(env, 'risk close of an active account above max', (await close(g, { size: CLOSE_ALL, authority: risk.publicKey, maxFee: allFee - 1n })).instruction, [risk]);
  const forced = await close(g, { size: CLOSE_ALL, authority: risk.publicKey });
  send(env, 'risk close of an active account is assessed', forced.instruction, [risk]);
  send(env, 'market limit 2000', await v.upsertMarket({ admin, marketToken: MARKETS.SOL.token, params: marketParams('SOL', LEVERAGE.crypto, { maxPositionUsd: usdc('2000') }) }), [env.admin]);
  const tp2 = await protect(g, { size: CLOSE_ALL, trigger: 200n * 10n ** 11n });
  send(env, 'take profit under a smaller limit', tp2.instruction, [g.trader]);
  send(env, 'market limit below the position', await v.upsertMarket({ admin, marketToken: MARKETS.SOL.token, params: marketParams('SOL', LEVERAGE.crypto, { maxPositionUsd: usdc('500') }) }), [env.admin]);
  send(env, 'close sized above a lowered limit', (await close(g, { size: 1_000n * USD, maxFee: 1_200_000n - 1n })).instruction, [g.trader]);
  send(env, 'market limit above the exposure cap', await v.upsertMarket({ admin, marketToken: MARKETS.SOL.token, params: marketParams('SOL', LEVERAGE.crypto, { maxPositionUsd: usdc('50000') }) }), [env.admin]);
  const tp3 = await protect(g, { size: CLOSE_ALL, maxFee: allFee });
  send(env, 'take profit under a limit above the cap', tp3.instruction, [g.trader]);
  send(env, 'market limit back', await v.upsertMarket({ admin, marketToken: MARKETS.SOL.token, params: marketParams('SOL', LEVERAGE.crypto) }), [env.admin]);
  await patchConfig(env, (c) => { c.orderFeeUsdc = bn(MAX64); });
  send(env, 'close fee overflow', (await close(g, { size: 100n * USD })).instruction, [g.trader]);
  const forced2 = await close(g, { size: 100n * USD, authority: risk.publicKey });
  send(env, 'risk close with an overflowing rate', forced2.instruction, [risk]);
  await patchConfig(env, (c) => { c.orderFeeUsdc = bn(500_000n); });
  snap(env, 'after decreases', accounts(g, c1.order, tp.order, sl.order, forced.order, tp2.order, forced2.order, tp3.order));

  // ---------- update_order ----------
  env.setUsdcBalance(g.ownerUsdc, usdc('200'));
  const lim = await open(g, 'ETH', { collateral: usdc('100'), size: 1_000n * USD, limit: 2_000n * 10n ** 11n });
  send(env, 'limit increase', lim.instruction, [g.trader]);
  // Held: the open's 1.2 due + this 1.2; resized to $2,000 (fee 1.9) the account must hold 3.1.
  const u1 = await update(g, lim.order, { sizeDeltaUsd: 2_000n * USD, maxFee: 1_900_000n });
  send(env, 'update short data', short(u1), [g.trader]);
  send(env, 'update owner usdc of a stranger', swapKey(u1, g.ownerUsdc, strangerUsdc), [g.trader]);
  send(env, 'update owner usdc of the other account', swapKey(u1, g.ownerUsdc, f.ownerUsdc), [g.trader]);
  send(env, 'update owner usdc is a wallet', swapKey(u1, g.ownerUsdc, stranger.publicKey), [g.trader]);
  send(env, 'update owner usdc is the fee vault', swapKey(u1, g.ownerUsdc, feeVaultPda()), [g.trader]);
  env.setUsdcBalance(g.ownerUsdc, 3_099_999n);
  send(env, 'update limit fee above balance', u1, [g.trader]);
  env.setUsdcBalance(g.ownerUsdc, 3_100_000n);
  send(env, 'update limit fee above max', await update(g, lim.order, { sizeDeltaUsd: 2_000n * USD, maxFee: 1_899_999n }), [g.trader]);
  send(env, 'update limit fee = balance', u1, [g.trader]);
  env.setUsdcBalance(g.ownerUsdc, 0n);
  send(env, 'update limit down with no usdc', await update(g, lim.order, { sizeDeltaUsd: 500n * USD }), [g.trader]);
  send(env, 'update stop loss size', await update(g, sl.order, { sizeDeltaUsd: 500n * USD }), [g.trader]);
  send(env, 'rate change', await setFee(1_000_000n, 10), [env.admin]);
  send(env, 'update trigger fee above max', await update(g, tp.order, { triggerPrice: 160n * 10n ** 11n, maxFee: allFee }), [g.trader]);
  send(env, 'update trigger re-assessed', await update(g, tp.order, { triggerPrice: 160n * 10n ** 11n }), [g.trader]);
  send(env, 'update limit trigger, higher fee, no usdc', await update(g, lim.order, { triggerPrice: 2_100n * 10n ** 11n }), [g.trader]);
  env.setUsdcBalance(g.ownerUsdc, usdc('10'));
  const gDue = read(env, g.funded, FEES.due, 8);
  write(env, g.funded, FEES.due, le(MAX64, 8));
  send(env, 'update limit with fees due at u64 max', await update(g, lim.order, { triggerPrice: 2_100n * 10n ** 11n }), [g.trader]);
  write(env, g.funded, FEES.due, gDue);
  send(env, 'update limit trigger, higher fee', await update(g, lim.order, { triggerPrice: 2_100n * 10n ** 11n }), [g.trader]);
  send(env, 'rate back', rate, [env.admin]);
  snap(env, 'after update', accounts(g, lim.order, tp.order, sl.order));

  // ---------- cancel_order ----------
  send(env, 'cancel the limit', await cancel(g, lim.order), [g.trader]);
  send(env, 'risk cancels the stop loss', await cancel(g, sl.order, risk.publicKey), [risk]);
  snap(env, 'after cancel', accounts(g, lim.order, sl.order));

  // ---------- sync, close_completed_order ----------
  env.executeOrder(c1.order, gmOrderEscrow(c1.order)); // the close executed
  env.setPosition(gmPositionPda(g.owner, MARKETS.SOL.token, true), 600n * USD, usdc('60'));
  setOrderState(env, tp2.order, 2); // cancelled by the exchange, left open
  setOrderState(env, forced.order, 1); // executed, left open
  send(env, 'sync drops the close', await sync(g), [risk]);
  env.executeOrder(tp.order, gmOrderEscrow(tp.order));
  const gDue2 = read(env, g.funded, FEES.due, 8);
  write(env, g.funded, FEES.due, le(MAX64, 8));
  send(env, 'sync with fees due at u64 max', await sync(g), [risk]);
  send(env, 'close completed with fees due at u64 max', await v.closeCompletedOrder({ funded: g.funded, order: forced.order }), [risk]);
  send(env, 'close cancelled with fees due at u64 max', await v.closeCompletedOrder({ funded: g.funded, order: tp2.order }), [risk]);
  write(env, g.funded, FEES.due, gDue2);
  send(env, 'close completed order', await v.closeCompletedOrder({ funded: g.funded, order: forced.order }), [risk]);
  send(env, 'close cancelled order again', await v.closeCompletedOrder({ funded: g.funded, order: tp2.order }), [risk]);
  send(env, 'sync drops the take profit', await sync(g), [risk]);
  snap(env, 'after sync', accounts(g, c1.order, tp.order, tp2.order, forced.order));

  // ---------- settle_order_fees ----------
  env.setUsdcBalance(g.ownerUsdc, usdc('100'));
  const owed = due(g);
  const st = await settle(g, 1_000_000n, 0n);
  send(env, 'settle short data', short(st), [risk]);
  send(env, 'settle missing accounts', raw(st, (k, d) => [k.slice(0, 9), d]), [risk]);
  send(env, 'settle not signer', at(st, 0, { isSigner: false }), [stranger]);
  for (const [i, name] of [[2, 'funded'], [4, 'owner usdc'], [5, 'fee vault']] as const) send(env, `settle ${name} readonly`, at(st, i, { isWritable: false }), [risk]);
  send(env, 'settle by the trader', await settle(g, 1n, 0n, owed, g.trader.publicKey), [g.trader]);
  send(env, 'settle by a stranger', await settle(g, 1n, 0n, owed, stranger.publicKey), [stranger]);
  send(env, 'settle by the admin', await settle(g, 1n, 0n, owed, admin), [env.admin]);
  send(env, 'settle config is a tier', swapKey(st, configPda(), tierPda(1)), [risk]);
  send(env, 'settle funded of another trader', swapKey(st, g.funded, f.funded), [risk]);
  send(env, 'settle owner of another account', swapKey(st, g.owner, f.owner), [risk]);
  send(env, 'settle owner usdc of another account', swapKey(st, g.ownerUsdc, f.ownerUsdc), [risk]);
  send(env, 'settle owner usdc of a stranger', swapKey(st, g.ownerUsdc, strangerUsdc), [risk]);
  send(env, 'settle fee vault is the capital vault', swapKey(st, feeVaultPda(), capitalVaultAddress()), [risk]);
  send(env, 'settle fee vault is a stranger', swapKey(st, feeVaultPda(), strangerUsdc), [risk]);
  send(env, 'settle fee vault is the owner usdc', swapKey(st, feeVaultPda(), g.ownerUsdc), [risk]);
  send(env, 'settle other mint', swapKey(st, USDC_MINT, mint), [risk]);
  send(env, 'settle wrong token program', swapKey(st, TOKEN_PROGRAM_ID, SystemProgram.programId), [risk]);
  send(env, 'settle wrong event authority', swapKey(st, eventAuthorityPda(), stranger.publicKey), [risk]);
  send(env, 'settle nothing', await settle(g, 0n, 0n), [risk]);
  send(env, 'settle above the fees due', await settle(g, owed, 1n), [risk]);
  send(env, 'settle stale', await settle(g, 1n, 0n, owed + 1n), [risk]);
  send(env, 'settle another count', await settle(g, 1n, 0n, owed, risk.publicKey, 1n), [risk]);
  send(env, 'settle total overflow', await settle(g, MAX64, 1n), [risk]);
  env.setUsdcBalance(g.ownerUsdc, 999_999n);
  send(env, 'settle charge above the balance', st, [risk]);
  env.setUsdcBalance(g.ownerUsdc, usdc('100'));
  send(env, 'settle', st, [risk]);
  snap(env, 'after settle', accounts(g));
  send(env, 'settle replayed', st, [risk]);
  const gDue3 = read(env, g.funded, FEES.due, 8);
  write(env, g.funded, FEES.due, le(owed, 8)); // the fees due back at the value the settlement was computed from
  send(env, 'settle replayed with the fees due restored', st, [risk]);
  write(env, g.funded, FEES.due, gDue3);
  const gCount = read(env, g.funded, FEES.settlements, 8);
  write(env, g.funded, FEES.settlements, le(MAX64, 8));
  send(env, 'settle count overflow', await settle(g, 1n, 0n), [risk]);
  write(env, g.funded, FEES.settlements, gCount);
  const gPaid = read(env, g.funded, FEES.paid, 8);
  write(env, g.funded, FEES.paid, le(MAX64, 8));
  send(env, 'settle paid overflow', await settle(g, 1n, 0n), [risk]);
  write(env, g.funded, FEES.paid, gPaid);
  for (const [status, name] of [[STATUS.restricted, 'restricted'], [STATUS.breached, 'breached'], [STATUS.payoutPending, 'payout pending'], [STATUS.closed, 'closed']] as const) {
    setStatus(env, g.funded, status);
    send(env, `settle ${name}`, await settle(g, 1n, 1n), [risk]);
  }
  setStatus(env, g.funded, STATUS.active);
  send(env, 'pause all again', await pauses(true), [env.admin]);
  send(env, 'settle while paused', await settle(g, 2n, 0n), [risk]);
  send(env, 'resume again', await pauses(false), [env.admin]);
  send(env, 'settle waive only', await settle(g, 0n, due(g)), [risk]);
  snap(env, 'after settlements', accounts(g));

  // ---------- request_payout, close_funded ----------
  const h = await funded();
  const ho = await open(h, 'SOL', { collateral: usdc('100'), size: 1_000n * USD });
  send(env, 'h opens', ho.instruction, [h.trader]);
  fill(h, ho.order, 1_000n * USD, usdc('100'));
  send(env, 'h sync', await sync(h), [risk]);
  const hc = await close(h, { size: CLOSE_ALL });
  send(env, 'h closes all', hc.instruction, [h.trader]);
  env.executeOrder(hc.order, gmOrderEscrow(hc.order));
  env.remove(gmPositionPda(h.owner, MARKETS.SOL.token, true));
  env.setUsdcBalance(h.ownerUsdc, usdc('700'));
  send(env, 'h sync flat', await sync(h), [risk]);
  const request = async () => v.requestPayout({ trader: h.trader.publicKey, funded: h.funded, payoutSeq: env.account('fundedAccount', h.funded).payoutSeq });
  send(env, 'request with fees due', await request(), [h.trader]);
  send(env, 'h settle', await settle(h, 2_400_000n, due(h) - 2_400_000n), [risk]);
  send(env, 'request after settlement', await request(), [h.trader]);
  send(env, 'approve', await v.approvePayout({ riskAuthority: risk.publicKey, funded: ref(h), payout: payoutPda(h.funded, 0) }), [risk]);
  snap(env, 'after payout', accounts(h, payoutPda(h.funded, 0)));

  const k = await funded();
  const ko = await open(k, 'SOL', { collateral: usdc('100'), size: 1_000n * USD });
  send(env, 'k opens', ko.instruction, [k.trader]);
  fill(k, ko.order, 1_000n * USD, usdc('100'));
  send(env, 'k sync', await sync(k), [risk]);
  send(env, 'k breached', await v.markBreached({ riskAuthority: risk.publicKey, funded: k.funded }), [risk]);
  const kf = await close(k, { size: CLOSE_ALL, authority: risk.publicKey, maxFee: 0n });
  await patchConfig(env, (c) => { c.orderFeeUsdc = bn(MAX64); });
  send(env, 'k forced close is free, even with an overflowing rate', kf.instruction, [risk]);
  await patchConfig(env, (c) => { c.orderFeeUsdc = bn(500_000n); });
  env.executeOrder(kf.order, gmOrderEscrow(kf.order));
  env.remove(gmPositionPda(k.owner, MARKETS.SOL.token, true));
  env.setUsdcBalance(k.ownerUsdc, usdc('450'));
  send(env, 'k sync flat', await sync(k), [risk]);
  const closeFunded = async () => v.closeFunded({ riskAuthority: risk.publicKey, funded: ref(k) });
  send(env, 'close with fees due', await closeFunded(), [risk]);
  send(env, 'settle and close', [await settle(k, due(k), 0n), await closeFunded()], [risk]);
  snap(env, 'after closure', accounts(k));
  send(env, 'settle after closure', await settle(k, 0n, 1n, 0n), [risk]);
  send(env, 'stranger re-creates the owner usdc', createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, k.ownerUsdc, k.owner, USDC_MINT), [stranger]);
  send(env, 'settle closed with a re-created usdc account', await settle(k, 0n, 1n, 0n), [risk]);
  snap(env, 'final', [...accounts(f), ...accounts(g), ...accounts(h), ...accounts(k), Keypair.generate().publicKey]);
});
