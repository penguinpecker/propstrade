// Seeded random-sequence fuzzer for props_vault: runs the SAME random action sequence on the Anchor build and the
// Pinocchio build (each in its own process, deterministic keys/clock), checks money invariants after every step in
// each run, and diffs every transaction outcome + every tracked account byte for byte between the two builds.
//
//   FUZZ_SEED=1 FUZZ_STEPS=400 node programs-p/props_vault_p/fuzz/invariants.ts   (exit 1 on any invariant violation or build difference;
//   FUZZ_SELFTEST=1 proves the detectors fire, FUZZ_CODES=1 prints the error codes per action)
//
// Invariants (checked in both runs):
//  I1 per-tx USDC conservation over the tx's own accounts (no USDC created or destroyed by the program)
//  I2 per-tx lamport conservation over the tx's own accounts (sum before - sum after == signature fees)
//  I3 capital vault == deposits - withdrawals - principal posted + USDC returned at close + vault share of payouts
//  I4 config.allocated_principal == sum of principal of non-closed funded accounts; funded_active == their count
//  I5 owner PDAs stay data-less + system-owned (or gone); a closed account's owner has 0 lamports and no USDC ATA
//  I6 a paid payout came only from realized profit: owner USDC after >= principal, trader gain == payout.trader_amount
//     == floor(profit * share), vault gain == vault_amount, profit == balance_at_request - principal
//  I7 attacker (stranger) and risk wallets never gain USDC or lamports from a program transaction
//  I8 trader ATAs gain USDC only through approve_payout; sum of those gains == config.payouts_paid
//  I9 the fee vault holds exactly the evaluation fees plus the order fees charged (OrderFeesSettled) since the last
//     sweep, and sum of order_fees_paid over accounts == sum of charged; a settlement moves exactly `charged` out of the
//     account's USDC
//  I10 order_fees[j] == 0 whenever orders[j] is free or was placed by a risk authority on a breached account (a risk
//      authority's close of any other account is assessed like the trader's: the session guard)
//  I11 per account, order_fees_due + sum of order_fees changes only by +fee (OrderRequested, ProtectionSet), new - old
//      (OrderUpdated), -old (OrderCancelled, and CompletedOrderClosed of an order the exchange cancelled) and
//      -(charged + waived) (OrderFeesSettled): sync and close_completed_order of an executed order move fees from
//      pending to due and keep it
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { Clock, FailedTransactionMetadata } from 'litesvm';
import {
  CLOSE_ALL, PROPS_VAULT_PROGRAM_ID, USDC_MINT, capitalVaultAddress, configPda, enumName, feeVaultPda, gmOrderEscrow, gmPositionPda,
  gmUserPda, marketConfigPda, payoutPda, solTreasuryPda, traderProfilePda,
} from '@props/sdk';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BUILDS = { anchor: join(ROOT, 'target/deploy/props_vault.so'), pinocchio: process.env.PROPS_VAULT_SO || join(ROOT, 'target/deploy/props_vault_p.so') };
const SEED = Number(process.env.FUZZ_SEED ?? 1);
const STEPS = Number(process.env.FUZZ_STEPS ?? 300);

type Rec = { label: string; ok?: boolean; err?: string | null; code?: string | null; inner?: string[]; errors?: string[]; accounts?: unknown[]; violation?: string };

async function run(): Promise<Rec[]> {
  let kseed = 1;
  (Keypair as unknown as { generate: () => Keypair }).generate = () => {
    const s = new Uint8Array(32);
    s[0] = kseed & 255; s[1] = kseed >> 8; s[2] = 0xf5;
    kseed++;
    return Keypair.fromSeed(s);
  };
  Date.now = () => 1_790_000_000_000;
  const { Env, MARKETS, TIERS, USD, usdc }: typeof import('../../../tests/program/src/env.ts') = await import(join(ROOT, 'tests/program/src/env.ts'));
  const out: Rec[] = [];
  let r = SEED >>> 0 || 1;
  const rnd = () => { r ^= r << 13; r >>>= 0; r ^= r >>> 17; r ^= r << 5; r >>>= 0; return r / 4294967296; };
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const pick = <T>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(rnd() * xs.length)] : undefined);
  const chance = (p: number) => rnd() < p;

  const env = new Env();
  await env.setUpVault();
  // Fixture markets are flagged closed; open them (same as compare/crank.ts).
  for (const m of Object.values(MARKETS) as { gm: PublicKey }[]) {
    const a = env.svm.getAccount(m.gm)!; const d = Buffer.from(a.data); d[10] = d[10]! & ~(1 << 5); env.svm.setAccount(m.gm, { ...a, data: d });
  }
  const v = env.vault;
  const admin = env.admin; const risk = env.risk;
  const adminUsdc = getAssociatedTokenAddressSync(USDC_MINT, admin.publicKey);
  const stranger = env.wallet(50);
  const strangerUsdc = env.setUsdc(stranger.publicKey, usdc('1000'));
  const riskUsdc = env.setUsdc(risk.publicKey, 0n);
  const vaultAddr = capitalVaultAddress();

  type F = { trader: Keypair; funded: PublicKey; owner: PublicKey; ownerUsdc: PublicKey; traderUsdc: PublicKey };
  const fs: F[] = [];
  const shadow = new Map<string, { size: bigint; coll: bigint }>(); // GMTrade position key -> keeper state
  const orders = new Set<string>(); // every GMTrade order address ever created
  const payouts: PublicKey[] = [];
  let expVault = env.usdcBalance(vaultAddr);
  let traderGains = 0n;
  let expFeeVault = env.usdcBalance(feeVaultPda());
  let charged = 0n;

  const violation = (msg: string) => { out.push({ label: `VIOLATION ${msg}`, violation: msg }); console.error(`[${process.env.BUILD}] VIOLATION ${msg}`); };
  const usdcOf = (k: PublicKey): bigint | null => {
    const a = env.svm.getAccount(k);
    if (!a || !a.owner.equals(TOKEN_PROGRAM_ID) || a.data.length !== 165) return null;
    const t = AccountLayout.decode(a.data);
    return t.mint.equals(USDC_MINT) ? t.amount : null;
  };
  const acct = (f: F) => env.account('fundedAccount', f.funded) as any;
  /** Per account: order_fees_due + sum of order_fees, and each tracked order's fee. */
  const feeLedger = () => new Map(fs.filter((f) => env.exists(f.funded)).map((f) => {
    const a = acct(f);
    const byOrder = new Map<string, bigint>((a.orders as any[]).map((o, j) => [o.order.toBase58(), BigInt(a.orderFees[j].toString())]));
    return [f.funded.toBase58(), { total: (a.orderFees as any[]).reduce((s: bigint, x: any) => s + BigInt(x.toString()), BigInt(a.orderFeesDue.toString())), byOrder }] as const;
  }));
  const ref = (f: F) => env.funded(f.funded);
  const isFree = (k: PublicKey) => k.equals(PublicKey.default);
  /** Orders a risk authority placed on a breached account: free for as long as they are tracked (I10). */
  const breachCloses = new Set<string>();

  /** Sends, records the outcome, and checks I1/I2/I7/I8 across the transaction. */
  const send = (label: string, ixs: TransactionInstruction[], signers: Keypair[]): boolean => {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs);
    tx.feePayer = signers[0]!.publicKey;
    tx.recentBlockhash = env.svm.latestBlockhash();
    try { tx.sign(...signers); } catch (e) { out.push({ label: `${label} (unsignable)` }); return false; }
    const keys = tx.compileMessage().accountKeys;
    const lamBefore = keys.map((k) => env.lamports(k));
    const usdcBefore = keys.map(usdcOf);
    const watch = [strangerUsdc, riskUsdc, ...fs.map((f) => f.traderUsdc)];
    const watchBefore = watch.map((k) => usdcOf(k) ?? 0n);
    const solWatch = [stranger.publicKey, risk.publicKey];
    const solBefore = solWatch.map((k) => env.lamports(k));
    const ledgerBefore = feeLedger();
    const statusBefore = new Map(fs.filter((f) => env.exists(f.funded)).map((f) => [f.funded.toBase58(), enumName(acct(f).status)]));
    const res = env.svm.sendTransaction(tx);
    env.svm.expireBlockhash();
    const failed = res instanceof FailedTransactionMetadata;
    const meta = failed ? res.meta() : res;
    const logs = meta.logs();
    out.push({
      label, ok: !failed, err: failed ? res.err().toString() : null,
      code: logs.map((l) => /Error Code: (\w+)/.exec(l)?.[1]).find(Boolean) ?? null,
      inner: failed ? [] : meta.innerInstructions().flat().map((i) => {
        const ix = i.instruction();
        return `${i.stackHeight()} ${keys[ix.programIdIndex()]!.toBase58()} [${Array.from(ix.accounts(), (a) => keys[a]!.toBase58()).join(',')}] ${Buffer.from(ix.data()).toString('hex')}`;
      }),
      errors: logs.filter((l) => /rror|already in use/.test(l)).map((l) => l.replace(/^(Program log: (?:Anchor|Program)Error) (?:caused by account: \w+|thrown in \S+:\d+)\./, '$1 occurred.')),
    });
    const fee = 5000n * BigInt(tx.signatures.length);
    const lamAfter = keys.map((k) => env.lamports(k));
    const dl = lamBefore.reduce((a, b) => a + b, 0n) - lamAfter.reduce((a, b) => a + b, 0n);
    if (failed ? dl !== fee && dl !== 0n : dl !== fee) violation(`I2 ${label}: lamports before-after=${dl}, fee=${fee}`);
    if (!failed) {
      const usdcAfter = keys.map(usdcOf);
      const sb = usdcBefore.reduce((a: bigint, b) => a + (b ?? 0n), 0n);
      const sa = usdcAfter.reduce((a: bigint, b) => a + (b ?? 0n), 0n);
      if (sb !== sa) violation(`I1 ${label}: USDC over tx accounts ${sb} -> ${sa}`);
      watch.forEach((k, i) => {
        const d = (usdcOf(k) ?? 0n) - watchBefore[i]!;
        if (i < 2 && d > 0n) violation(`I7 ${label}: ${i === 0 ? 'stranger' : 'risk'} gained ${d} USDC`);
        if (i >= 2 && d !== 0n) {
          if (!label.startsWith('approve')) violation(`I8 ${label}: trader ATA ${k.toBase58()} moved ${d} outside approve_payout`);
          traderGains += d;
        }
      });
      solWatch.forEach((k, i) => {
        const d = env.lamports(k) - solBefore[i]!;
        const paid = k.equals(tx.feePayer!) ? fee : 0n;
        if (d + paid > 0n) violation(`I7 ${label}: ${i === 0 ? 'stranger' : 'risk'} gained ${d + paid} lamports`);
      });
      const events = v.parseEvents(meta.innerInstructions().flat().map((i) => ({ programId: keys[i.instruction().programIdIndex()]!, data: i.instruction().data() })));
      const big = (x: unknown) => BigInt(String(x));
      const expected = new Map<string, bigint>();
      const add = (funded: unknown, d: bigint) => expected.set(String(funded), (expected.get(String(funded)) ?? 0n) + d);
      const before = (funded: unknown, order: unknown) => ledgerBefore.get(String(funded))?.byOrder.get(String(order)) ?? 0n;
      for (const e of events) {
        const d = e.data;
        if (e.name === 'orderRequested' || e.name === 'protectionSet') {
          add(d.funded, big(d.fee));
          const f = fs.find((x) => x.funded.equals(d.funded as PublicKey));
          if (e.name === 'orderRequested' && f && !(d.by as PublicKey).equals(f.trader.publicKey) && statusBefore.get(String(d.funded)) === 'breached') {
            breachCloses.add(String(d.order));
            if (big(d.fee) !== 0n) violation(`I10 ${label}: a breach close was assessed ${d.fee}`);
          }
        } else if (e.name === 'orderUpdated') add(d.funded, big(d.fee) - before(d.funded, d.order));
        else if (e.name === 'orderCancelled') add(d.funded, -before(d.funded, d.order));
        else if (e.name === 'completedOrderClosed' && d.cancelled) add(d.funded, -before(d.funded, d.order));
        else if (e.name === 'orderFeesSettled') {
          add(d.funded, -(big(d.charged) + big(d.waived)));
          charged += big(d.charged);
          expFeeVault += big(d.charged);
          const f = fs.find((x) => x.funded.equals(d.funded as PublicKey));
          const i = f ? keys.findIndex((k) => k.equals(f.ownerUsdc)) : -1;
          if (i < 0 || (usdcBefore[i] ?? 0n) - (usdcOf(f!.ownerUsdc) ?? 0n) !== big(d.charged)) violation(`I9 ${label}: the account's USDC did not lose exactly the ${d.charged} charged`);
        }
      }
      for (const [k, after] of feeLedger()) {
        const d = after.total - (ledgerBefore.get(k)?.total ?? 0n);
        if (d !== (expected.get(k) ?? 0n)) violation(`I11 ${label}: ${k.slice(0, 8)} fees due + held moved by ${d}, events say ${expected.get(k) ?? 0n}`);
      }
    }
    return !failed;
  };

  /** Adversarial mutation: swap one non-signer account for a pool account, or flip a writable flag. */
  const pool = () => [strangerUsdc, stranger.publicKey, vaultAddr, feeVaultPda(), solTreasuryPda(), adminUsdc, riskUsdc, configPda(),
    ...fs.flatMap((f) => [f.funded, f.owner, f.ownerUsdc, f.traderUsdc]), ...[...orders].map((o) => new PublicKey(o)).slice(-6)];
  const mutate = (ix: TransactionInstruction): [TransactionInstruction, string] => {
    const idx = ix.keys.map((k, i) => [k, i] as const).filter(([k]) => !k.isSigner).map(([, i]) => i);
    const i = pick(idx);
    if (i === undefined) return [ix, ''];
    const keys = ix.keys.map((k) => ({ ...k }));
    let tag: string;
    if (chance(0.25)) { keys[i]!.isWritable = !keys[i]!.isWritable; tag = `flip#${i}`; }
    else { const p = pick(pool())!; keys[i]!.pubkey = p; tag = `swap#${i}`; }
    return [new TransactionInstruction({ programId: ix.programId, keys, data: ix.data }), tag];
  };
  const maybeMutate = (label: string, ix: TransactionInstruction): [string, TransactionInstruction] => {
    if (!chance(0.2)) return [label, ix];
    const [m, tag] = mutate(ix);
    return [`${label} MUT ${tag}`, m];
  };

  const checkState = (label: string) => {
    const vb = env.usdcBalance(vaultAddr);
    if (vb !== expVault) violation(`I3 after ${label}: capital vault ${vb} != expected ${expVault}`);
    const c = env.account('config', configPda()) as any;
    let principal = 0n; let active = 0;
    for (const f of fs) {
      const a = acct(f);
      const closed = enumName(a.status) === 'closed';
      if (!closed) { principal += BigInt(a.principal.toString()); active++; }
      const o = env.svm.getAccount(f.owner);
      if (o && o.lamports > 0) {
        if (!o.owner.equals(SystemProgram.programId) || o.data.length !== 0) violation(`I5 after ${label}: owner ${f.owner.toBase58()} owner=${o.owner.toBase58()} len=${o.data.length}`);
        if (closed) violation(`I5 after ${label}: closed account's owner still holds ${o.lamports} lamports`);
      }
      if (closed && env.exists(f.ownerUsdc)) violation(`I5 after ${label}: closed account's owner USDC ATA still exists`);
    }
    if (BigInt(c.allocatedPrincipal.toString()) !== principal) violation(`I4 after ${label}: allocated ${c.allocatedPrincipal} != sum ${principal}`);
    if (c.fundedActive !== active) violation(`I4 after ${label}: funded_active ${c.fundedActive} != ${active}`);
    if (BigInt(c.payoutsPaid.toString()) !== traderGains) violation(`I8 after ${label}: payouts_paid ${c.payoutsPaid} != trader ATA gains ${traderGains}`);
    const feeVault = env.usdcBalance(feeVaultPda());
    if (feeVault !== expFeeVault) violation(`I9 after ${label}: fee vault ${feeVault} != evaluation fees + charged ${expFeeVault}`);
    const paid = fs.reduce((s, f) => s + BigInt(acct(f).orderFeesPaid.toString()), 0n);
    if (paid !== charged) violation(`I9 after ${label}: sum of order_fees_paid ${paid} != charged ${charged}`);
    for (const f of fs) {
      const a = acct(f);
      (a.orders as any[]).forEach((o, j) => {
        if ((isFree(o.order) || breachCloses.has(o.order.toBase58())) && BigInt(a.orderFees[j].toString()) !== 0n) violation(`I10 after ${label}: order_fees[${j}] = ${a.orderFees[j]} for a ${isFree(o.order) ? 'free' : 'breach-close'} entry`);
      });
    }
  };

  const snapshot = (label: string) => {
    const addrs = [configPda(), vaultAddr, feeVaultPda(), solTreasuryPda(), adminUsdc, strangerUsdc, stranger.publicKey,
      ...Object.values(MARKETS).map((m: any) => marketConfigPda(m.token)),
      ...fs.flatMap((f) => [f.funded, f.owner, f.ownerUsdc, f.traderUsdc, traderProfilePda(f.trader.publicKey), gmUserPda(f.owner)]),
      ...[...orders].flatMap((o) => [new PublicKey(o), gmOrderEscrow(new PublicKey(o))]),
      ...[...shadow.keys()].map((p) => new PublicKey(p)), ...payouts];
    out.push({
      label: `snapshot ${label}`,
      accounts: addrs.map((a) => {
        const x = env.svm.getAccount(a);
        return x ? { a: a.toBase58(), l: String(x.lamports), o: x.owner.toBase58(), d: Buffer.from(x.data).toString('hex') } : { a: a.toBase58(), missing: true };
      }),
    });
  };

  const marketNames = Object.keys(MARKETS);
  const openFs = () => fs.filter((f) => enumName(acct(f).status) !== 'closed');
  const trackedOrders = (f: F) => (acct(f).orders as any[]).filter((o) => !isFree(o.order));
  const usedSlots = (f: F) => (acct(f).slots as any[]).map((s, i) => ({ ...s, i })).filter((s) => !isFree(s.marketToken));
  /** The fee a trader agrees to: none (no limit) mostly, else a random bound the order's fee may exceed. */
  const maxFee = () => (chance(0.25) ? BigInt(int(0, 12_000_000)) : undefined);
  /** The keeper's settlement: charge what the account's USDC covers (at most the fees due), waive the rest. */
  const settleAll = async (f: F, label: string) => {
    const due = BigInt(acct(f).orderFeesDue.toString());
    if (due === 0n || !env.exists(f.ownerUsdc)) return;
    const balance = usdcOf(f.ownerUsdc) ?? 0n;
    const charge = balance < due ? balance : due;
    const expectedSettlements = BigInt(acct(f).orderFeeSettlements.toString());
    send(label, [await v.settleOrderFees({ riskAuthority: risk.publicKey, funded: f.funded, charge, waive: due - charge, expectedDue: due, expectedSettlements })], [risk]);
  };
  const positionsOf = (f: F) => [...shadow.keys()].map((k) => new PublicKey(k)).filter((p) => env.exists(p) && marketNames.some((n) => [true, false].some((l) => gmPositionPda(f.owner, (MARKETS as any)[n].token, l).equals(p))));

  const actions: [number, string, () => Promise<void>][] = [
    [3, 'activate', async () => {
      if (openFs().length >= 4) return;
      const trader = env.wallet(20);
      let evaluation: PublicKey;
      try { evaluation = await env.passedEvaluation(trader); } catch { out.push({ label: 'passedEvaluation failed' }); return; }
      expFeeVault += usdc(TIERS.t10k.fee);
      const ix = await v.activateFunded({ trader: trader.publicKey, evaluation });
      const { fundedPda, ownerPda, ownerUsdcAddress } = await import('@props/sdk');
      const funded = fundedPda(evaluation);
      const f: F = { trader, funded, owner: ownerPda(funded), ownerUsdc: ownerUsdcAddress(funded), traderUsdc: getAssociatedTokenAddressSync(USDC_MINT, trader.publicKey) };
      if (send('activate', [ix], [trader])) {
        fs.push(f);
        expVault -= BigInt(acct(f).principal.toString());
        env.svm.airdrop(f.owner, 2n * BigInt(LAMPORTS_PER_SOL)); // GMTrade rent for many positions/orders
      }
    }],
    [8, 'open', async () => {
      const f = pick(openFs()); if (!f) return;
      const m = pick(marketNames)!; const isLong = chance(0.5); const limit = chance(0.3);
      const coll = BigInt(int(1, 250)) * 1_000_000n;
      const lev = BigInt(int(1, 30));
      const signer = chance(0.1) ? stranger : f.trader;
      const o = await v.openPosition({
        trader: signer.publicKey, funded: ref(f), marketToken: (MARKETS as any)[m].token, isLong, orderType: limit ? 'limit' : 'market',
        collateral: coll, sizeDeltaUsd: coll * lev * 10n ** 14n, triggerPrice: limit ? BigInt(int(1, 5000)) * 10n ** 11n : undefined,
        acceptablePrice: isLong ? 10n ** 30n : 1n, maxFee: maxFee(),
      });
      orders.add(o.order.toBase58());
      const pos = gmPositionPda(f.owner, (MARKETS as any)[m].token, isLong);
      if (!shadow.has(pos.toBase58())) shadow.set(pos.toBase58(), { size: 0n, coll: 0n });
      const [label, ix] = maybeMutate(`open ${m} ${isLong ? 'L' : 'S'} ${limit ? 'limit' : 'mkt'} ${coll}x${lev}`, o.instruction);
      send(label, [ix], [signer]);
    }],
    [4, 'close', async () => {
      const f = pick(openFs()); if (!f) return;
      const s = pick(usedSlots(f)); if (!s) return;
      const auth = chance(0.3) ? risk : chance(0.1) ? stranger : f.trader;
      const size = chance(0.5) ? CLOSE_ALL : BigInt(int(1, 3000)) * USD;
      const o = await v.closePosition({ authority: auth.publicKey, funded: ref(f), marketToken: s.marketToken, isLong: s.isLong, sizeDeltaUsd: size, acceptablePrice: s.isLong ? 1n : 10n ** 30n, maxFee: maxFee() });
      orders.add(o.order.toBase58());
      const [label, ix] = maybeMutate('close', o.instruction);
      send(label, [ix], [auth]);
    }],
    [3, 'protect', async () => {
      const f = pick(openFs()); if (!f) return;
      const s = pick(usedSlots(f)); if (!s) return;
      const o = await v.setProtection({ trader: f.trader.publicKey, funded: ref(f), marketToken: s.marketToken, isLong: s.isLong, orderType: chance(0.5) ? 'stopLoss' : 'takeProfit', triggerPrice: BigInt(int(1, 5000)) * 10n ** 11n, sizeDeltaUsd: chance(0.3) ? CLOSE_ALL : BigInt(int(1, 3000)) * USD, maxFee: maxFee() });
      orders.add(o.order.toBase58());
      const [label, ix] = maybeMutate('protect', o.instruction);
      send(label, [ix], [f.trader]);
    }],
    [2, 'update', async () => {
      const f = pick(openFs()); if (!f) return;
      const o = pick(trackedOrders(f)); if (!o) return;
      const ix = await v.updateOrder({ trader: f.trader.publicKey, funded: ref(f), order: o.order, triggerPrice: BigInt(int(1, 5000)) * 10n ** 11n, sizeDeltaUsd: chance(0.5) ? BigInt(int(1, 3000)) * USD : undefined, maxFee: maxFee() });
      const [label, m] = maybeMutate('update', ix);
      send(label, [m], [f.trader]);
    }],
    [4, 'cancel', async () => {
      const f = pick(openFs()); if (!f) return;
      const o = pick(trackedOrders(f)); if (!o) return;
      const auth = chance(0.2) ? risk : chance(0.1) ? stranger : f.trader;
      const ix = await v.cancelOrder({ authority: auth.publicKey, funded: ref(f), order: o.order });
      const [label, m] = maybeMutate('cancel', ix);
      send(label, [m], [auth]);
    }],
    [8, 'keeper-exec', async () => {
      // A keeper executes (or completes-but-leaves-open, or cancels-and-leaves-open) a pending order; USDC in/out of the
      // owner is external.
      const f = pick(openFs()); if (!f) return;
      const o = pick(trackedOrders(f)); if (!o) return;
      const acc = env.svm.getAccount(o.order); if (!acc || acc.data.length < 10 || acc.data[9] !== 0) return;
      const slot = acct(f).slots[o.slot];
      const pos = slot.gmPosition.toBase58();
      const sh = shadow.get(pos) ?? { size: 0n, coll: 0n };
      const type = enumName(o.orderType);
      const esc = gmOrderEscrow(o.order);
      if (chance(0.15)) { // cancelled by the exchange and left open: nothing executed, the escrow keeps the collateral
        const a = env.svm.getAccount(o.order)!; const dd = Buffer.from(a.data); dd[9] = 2; env.svm.setAccount(o.order, { ...a, data: dd });
        out.push({ label: `keeper cancel ${type}` });
        return;
      }
      if (type === 'market' || type === 'limit') {
        sh.size += BigInt(o.sizeUsd.toString()); sh.coll += BigInt(o.collateral.toString());
      } else {
        const want = BigInt(o.sizeUsd.toString());
        const d = want > sh.size ? sh.size : want;
        const rel = sh.size === 0n ? 0n : (sh.coll * d) / sh.size;
        sh.size -= d; sh.coll -= rel;
        const pnl = BigInt(int(-100, 300)) * rel / 100n;
        const back = rel + pnl > 0n ? rel + pnl : 0n;
        env.setUsdcBalance(f.ownerUsdc, env.usdcBalance(f.ownerUsdc) + back);
      }
      shadow.set(pos, sh);
      if (env.exists(slot.gmPosition)) env.setPosition(slot.gmPosition, sh.size, sh.coll);
      if (chance(0.3)) { // completed but left open, escrow drained
        const a = env.svm.getAccount(o.order)!; const dd = Buffer.from(a.data); dd[9] = 1; env.svm.setAccount(o.order, { ...a, data: dd });
        if (env.exists(esc)) env.setUsdcBalance(esc, 0n);
      } else env.executeOrder(o.order, esc);
      out.push({ label: `keeper exec ${type}` });
    }],
    [2, 'keeper-liquidate', async () => {
      const f = pick(openFs()); if (!f) return;
      const s = pick(usedSlots(f)); if (!s || !env.exists(s.gmPosition)) return;
      shadow.set(s.gmPosition.toBase58(), { size: 0n, coll: 0n });
      if (chance(0.5)) env.remove(s.gmPosition); else env.setPosition(s.gmPosition, 0n, 0n);
      out.push({ label: 'keeper liquidate' });
    }],
    [3, 'windfall', async () => {
      const f = pick(openFs()); if (!f || !env.exists(f.ownerUsdc)) return;
      const b = env.usdcBalance(f.ownerUsdc);
      const d = BigInt(int(-200, 400)) * 1_000_000n;
      env.setUsdcBalance(f.ownerUsdc, b + d > 0n ? b + d : 0n);
      out.push({ label: 'pnl lands on owner' });
    }],
    [8, 'sync', async () => {
      const f = pick(openFs()); if (!f) return;
      const [label, ix] = maybeMutate('sync', await v.sync({ funded: ref(f) }));
      send(label, [ix], [stranger]);
    }],
    [5, 'request', async () => {
      const f = pick(openFs()); if (!f) return;
      const seq = acct(f).payoutSeq;
      const ix = await v.requestPayout({ trader: f.trader.publicKey, funded: f.funded, payoutSeq: seq });
      const [label, m] = maybeMutate('request', ix);
      const bal = usdcOf(f.ownerUsdc);
      if (send(label, [m], [f.trader])) {
        payouts.push(payoutPda(f.funded, seq));
        const p = env.account('payoutRequest', payoutPda(f.funded, seq)) as any;
        if (BigInt(p.balanceAtRequest.toString()) !== bal) violation(`I6 request: balance_at_request ${p.balanceAtRequest} != owner USDC ${bal}`);
        if (!(acct(f).slots as any[]).every((s) => isFree(s.marketToken))) violation('I6 request accepted with an open slot');
      }
    }],
    [5, 'resolve', async () => {
      const f = pick(openFs()); if (!f) return;
      const seq = acct(f).payoutSeq; if (seq === 0) return;
      const payout = payoutPda(f.funded, seq - 1);
      const k = int(0, 3);
      if (k === 0) { send('cancel payout', [await v.cancelPayout({ trader: f.trader.publicKey, funded: f.funded, payout })], [f.trader]); return; }
      if (k === 1) { send('reject payout', [await v.rejectPayout({ riskAuthority: risk.publicKey, funded: f.funded, payout, reasonCode: 7 })], [risk]); return; }
      const ix = await v.approvePayout({ riskAuthority: risk.publicKey, funded: ref(f), payout, positions: positionsOf(f) });
      const [label, m] = maybeMutate('approve', ix);
      const ownerBefore = usdcOf(f.ownerUsdc) ?? 0n;
      const traderBefore = usdcOf(f.traderUsdc) ?? 0n;
      const vaultBefore = env.usdcBalance(vaultAddr);
      if (send(label, [m], [risk])) {
        const p = env.account('payoutRequest', payout) as any;
        const a = acct(f);
        const principal = BigInt(a.principal.toString());
        const [ta, va, profit, bar] = [p.traderAmount, p.vaultAmount, p.profit, p.balanceAtRequest].map((x: any) => BigInt(x.toString())) as [bigint, bigint, bigint, bigint];
        const ownerAfter = usdcOf(f.ownerUsdc) ?? 0n;
        if (ownerAfter < principal) violation(`I6 approve: owner USDC after ${ownerAfter} < principal ${principal}`);
        if ((usdcOf(f.traderUsdc) ?? 0n) - traderBefore !== ta) violation('I6 approve: trader gain != trader_amount');
        if (env.usdcBalance(vaultAddr) - vaultBefore !== va) violation('I6 approve: vault gain != vault_amount');
        if (ta !== (profit * BigInt(a.terms.traderShareBps)) / 10_000n || ta + va !== profit) violation('I6 approve: split wrong');
        if (profit !== bar - principal || bar > ownerBefore) violation(`I6 approve: profit ${profit} bar ${bar} principal ${principal} ownerBefore ${ownerBefore}`);
        expVault += va;
      }
    }],
    [5, 'flatten', async () => {
      // Wind an account down the way the server would: cancel / close every tracked order, keeper closes positions
      // (collateral + PnL land on the owner), sync, then maybe a windfall and a payout request.
      const f = pick(openFs()); if (!f) return;
      for (const o of trackedOrders(f)) {
        const acc = env.svm.getAccount(o.order);
        if (acc && acc.data.length > 9 && acc.data[9] === 0) send('flatten cancel', [await v.cancelOrder({ authority: f.trader.publicKey, funded: ref(f), order: o.order })], [f.trader]);
        else if (acc) send('flatten closeCompleted', [await v.closeCompletedOrder({ funded: f.funded, order: o.order })], [stranger]);
      }
      for (const s of usedSlots(f)) {
        const sh = shadow.get(s.gmPosition.toBase58()) ?? { size: 0n, coll: 0n };
        const back = sh.coll + (BigInt(int(-100, 200)) * sh.coll) / 100n;
        if (back > 0n && env.exists(f.ownerUsdc)) env.setUsdcBalance(f.ownerUsdc, env.usdcBalance(f.ownerUsdc) + back);
        shadow.set(s.gmPosition.toBase58(), { size: 0n, coll: 0n });
        if (env.exists(s.gmPosition)) { if (chance(0.5)) env.remove(s.gmPosition); else env.setPosition(s.gmPosition, 0n, 0n); }
      }
      send('flatten sync', [await v.sync({ funded: ref(f) })], [stranger]);
      if (chance(0.6) && env.exists(f.ownerUsdc)) env.setUsdcBalance(f.ownerUsdc, env.usdcBalance(f.ownerUsdc) + BigInt(int(0, 500)) * 1_000_000n);
      if (chance(0.8)) await settleAll(f, 'settle (flat)');
      if (chance(0.7)) {
        const seq = acct(f).payoutSeq;
        const bal = usdcOf(f.ownerUsdc);
        if (send('request (flat)', [await v.requestPayout({ trader: f.trader.publicKey, funded: f.funded, payoutSeq: seq })], [f.trader])) {
          payouts.push(payoutPda(f.funded, seq));
          const p = env.account('payoutRequest', payoutPda(f.funded, seq)) as any;
          if (BigInt(p.balanceAtRequest.toString()) !== bal) violation(`I6 request: balance_at_request ${p.balanceAtRequest} != owner USDC ${bal}`);
        }
      }
    }],
    [3, 'risk', async () => {
      const f = pick(openFs()); if (!f) return;
      const k = chance(0.15) ? 2 : int(0, 1);
      if (k === 0) send('restrict', [await v.restrict({ riskAuthority: risk.publicKey, funded: f.funded, restricted: true })], [risk]);
      else if (k === 1) send('unrestrict', [await v.restrict({ riskAuthority: risk.publicKey, funded: f.funded, restricted: false })], [risk]);
      else send('breach', [await v.markBreached({ riskAuthority: risk.publicKey, funded: f.funded })], [risk]);
    }],
    [4, 'closeFunded', async () => {
      const f = pick(openFs()); if (!f) return;
      if (chance(0.7)) await settleAll(f, 'settle (closure)');
      const ix = await v.closeFunded({ riskAuthority: risk.publicKey, funded: ref(f), positions: positionsOf(f) });
      const [label, m] = maybeMutate('closeFunded', ix);
      const bal = usdcOf(f.ownerUsdc) ?? 0n;
      if (send(label, [m], [risk])) expVault += bal;
    }],
    [2, 'crank', async () => {
      const f = pick(fs); if (!f) return;
      if (chance(0.5)) { send('topUp', [await v.topUpOwner({ funded: f.funded })], [stranger]); return; }
      const o = pick([...orders]); if (!o) return;
      const [label, m] = maybeMutate('closeCompleted', await v.closeCompletedOrder({ funded: f.funded, order: new PublicKey(o) }));
      send(label, [m], [stranger]);
    }],
    [2, 'admin', async () => {
      const k = int(0, 3);
      if (k === 0) {
        const amt = BigInt(int(1, 5000)) * 1_000_000n;
        env.setUsdc(admin.publicKey, (usdcOf(adminUsdc) ?? 0n) + amt);
        if (send('deposit', [await v.depositCapital({ admin: admin.publicKey, amount: amt })], [admin])) expVault += amt;
      } else if (k === 1) {
        const amt = BigInt(int(1, 150_000)) * 1_000_000n;
        if (send('withdraw', [await v.withdrawCapital({ admin: admin.publicKey, amount: amt })], [admin])) expVault -= amt;
      } else if (k === 2) { const fee = env.usdcBalance(feeVaultPda()); if (send('sweep', [await v.sweepFees({ admin: admin.publicKey })], [admin])) { expVault += fee; expFeeVault = 0n; } }
      else send('withdrawSol', [await v.withdrawSolTreasury({ admin: admin.publicKey, lamports: BigInt(int(1, 30)) * 100_000_000n })], [admin]);
    }],
    [2, 'setfee', async () => {
      const feeUsdc = BigInt(int(0, 2_000_001)); const feeBps = int(0, 11);
      send(`setfee ${feeUsdc} ${feeBps}`, [await v.setOrderFee({ admin: admin.publicKey, feeUsdc, feeBps })], [admin]);
    }],
    [5, 'settle', async () => {
      // The keeper settles within the bounds and against the current fees due; sometimes stale, over or unsigned.
      const f = pick(openFs()); if (!f) return;
      const due = BigInt(acct(f).orderFeesDue.toString());
      const balance = usdcOf(f.ownerUsdc) ?? 0n;
      const room = due < balance ? due : balance;
      const charge = chance(0.9) ? (room * BigInt(int(0, 100))) / 100n : room + 1n;
      const waive = chance(0.9) ? ((due - (charge < due ? charge : due)) * BigInt(int(0, 100))) / 100n : due + 1n;
      const expectedDue = chance(0.9) ? due : due + 1n;
      const count = BigInt(acct(f).orderFeeSettlements.toString());
      const expectedSettlements = chance(0.9) || count === 0n ? count : count - 1n; // sometimes a replayed count
      const signer = chance(0.1) ? stranger : risk;
      const [label, m] = maybeMutate(`settle ${charge}+${waive}/${due}`, await v.settleOrderFees({ riskAuthority: signer.publicKey, funded: f.funded, charge, waive, expectedDue, expectedSettlements }));
      send(label, [m], [signer]);
    }],
    [2, 'warp', async () => {
      const c = env.svm.getClock();
      env.svm.setClock(new Clock(c.slot + 100n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, c.unixTimestamp + BigInt(int(60, 2 * 86_400))));
      out.push({ label: 'warp' });
    }],
  ];
  // Most seeds trade with an order fee from the start (at most $2 + 10 bps).
  if (chance(0.75)) send('setfee initial', [await v.setOrderFee({ admin: admin.publicKey, feeUsdc: BigInt(int(0, 2_000_000)), feeBps: int(0, 10) })], [admin]);
  const total = actions.reduce((a, [w]) => a + w, 0);
  const counts: Record<string, number> = {};
  for (let step = 0; step < STEPS; step++) {
    let x = rnd() * total; let chosen = actions[0]!;
    for (const a of actions) { x -= a[0]; if (x < 0) { chosen = a; break; } }
    counts[chosen[1]] = (counts[chosen[1]] ?? 0) + 1;
    await chosen[2]();
    checkState(`step ${step} ${chosen[1]}`);
    // Self-test: a wrong I3 expectation must fire on both builds, and one extra lamport on the Pinocchio side must show as a build difference.
    if (process.env.FUZZ_SELFTEST && step === 50) { expVault += 1n; checkState('selftest'); expVault -= 1n; if (process.env.BUILD === 'pinocchio') env.svm.airdrop(stranger.publicKey, 1n); }
    snapshot(`step ${step}`);
  }
  const txs = out.filter((o) => o.ok !== undefined);
  const byLabel: Record<string, string> = {};
  for (const t of txs) { const k = t.label.split(' ')[0]! + (t.label.includes('MUT') ? '*' : ''); const [o, n] = (byLabel[k] ?? '0/0').split('/').map(Number); byLabel[k] = `${o! + (t.ok ? 1 : 0)}/${n! + 1}`; }
  if (process.env.BUILD === 'anchor') console.error(`ok/total by action: ${JSON.stringify(byLabel)}`);
  if (process.env.BUILD === 'anchor' && process.env.FUZZ_CODES) { const c: Record<string, number> = {}; for (const t of txs) if (!t.ok) { const k = `${t.label.split(' ')[0]}${t.label.includes('MUT') ? '*' : ''}:${t.code ?? t.err}`; c[k] = (c[k] ?? 0) + 1; } console.error(JSON.stringify(c, null, 0)); }
  console.error(`[${process.env.BUILD}] seed ${SEED}: ${STEPS} steps, ${txs.length} txs (${txs.filter((t) => t.ok).length} ok), funded ${fs.length}, payouts paid ${traderGains}, actions ${JSON.stringify(counts)}`);
  return out;
}

if (process.env.FUZZ_DUMP) {
  writeFileSync(process.env.FUZZ_DUMP, JSON.stringify(await run()));
} else {
  const dir = mkdtempSync(join(tmpdir(), 'pv-fuzz-'));
  const runs: Record<string, Rec[]> = {};
  for (const [name, so] of Object.entries(BUILDS)) {
    const dump = join(dir, `${name}.json`);
    const r = spawnSync(process.execPath, [process.argv[1]!], { env: { ...process.env, PROPS_VAULT_SO: so, FUZZ_DUMP: dump, BUILD: name }, stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) throw new Error(`${name} run failed`);
    runs[name] = JSON.parse(readFileSync(dump, 'utf8'));
  }
  rmSync(dir, { recursive: true, force: true });
  const [a, p] = [runs.anchor!, runs.pinocchio!];
  let diffs = 0;
  const differences: string[] = [];
  for (let i = 0; i < Math.max(a.length, p.length); i++) {
    const x = a[i]; const y = p[i];
    if (JSON.stringify(x) !== JSON.stringify(y)) {
      diffs++;
      if (diffs <= 5) {
        differences.push(`seed ${SEED} record ${i} ${x?.label}: anchor ${JSON.stringify(x)?.slice(0, 300)} / pinocchio ${JSON.stringify(y)?.slice(0, 300)}`);
        console.log(`DIFF at record ${i}\n  anchor:    ${JSON.stringify(x)?.slice(0, 600)}\n  pinocchio: ${JSON.stringify(y)?.slice(0, 600)}`);
      }
      if (x?.label !== y?.label) { console.log('  (sequences diverged)'); break; }
    }
  }
  const violations = [...a.filter((r) => r.violation).map((r) => `anchor seed ${SEED}: ${r.violation}`), ...p.filter((r) => r.violation).map((r) => `pinocchio seed ${SEED}: ${r.violation}`)];
  const va = a.filter((r) => r.violation).length; const vp = p.filter((r) => r.violation).length;
  console.log(`seed ${SEED}: ${a.length} records; anchor violations ${va}, pinocchio violations ${vp}, build differences ${diffs}`);
  if (process.env.FUZZ_SUMMARY) {
    const txs = a.filter((r) => r.ok !== undefined);
    const actions: Record<string, { ok: number; fail: number }> = {};
    for (const t of txs) {
      const k = t.label.split(' ')[0]! + (t.label.includes('MUT') ? '*' : '');
      const s = actions[k] ?? (actions[k] = { ok: 0, fail: 0 });
      t.ok ? s.ok++ : s.fail++;
    }
    writeFileSync(process.env.FUZZ_SUMMARY, JSON.stringify({
      fuzzer: 'invariants', seeds: [SEED], records: a.length, txs: txs.length, ok: txs.filter((t) => t.ok).length, actions, differences, violations,
    }));
  }
  process.exitCode = diffs || va || vp ? 1 : 0;
}
