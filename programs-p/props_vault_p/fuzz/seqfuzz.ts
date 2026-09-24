// Round-3 audit (lens: account validation + authorization). Stateful sequence fuzz, differential and invariant-checked.
//
// Each seed builds a vault with several funded accounts, then COMMITS a random sequence of: valid instructions (SDK
// builders), hostile mutations of them (account substituted from a pool of every address the run has seen plus foreign
// lookalikes, signer swapped for another key we hold, writable flag flipped, one account duplicated into another slot,
// remaining accounts appended/dropped, a data byte changed), stranger donations, and GMTrade keeper emulation (fills,
// GMTrade-side cancels and completions, liquidations, profit landing, claimable accounts). The same seed runs on the
// Anchor build and on the Pinocchio build in two processes; every step's outcome, inner instructions and the post-state
// of every account the run has touched are compared, and the first divergence per seed is printed.
// Inside each process, after every committed non-emulation step, value-flow invariants (authorization) are checked:
//   - no lamport gain for any wallet an attacker controls (traders, strangers), no USDC gain for their token accounts
//     except the payout's trader ATA in a successful approve_payout, by exactly trader_amount;
//   - owner PDAs stay system-owned and data-less;
//   - capital vault, fee vault, SOL treasury and owner USDC only lose value in the instructions allowed to move it.
//
//   node programs-p/props_vault_p/fuzz/seqfuzz.ts [seeds] [steps]   (FIRST_SEED=n; SANITY=1 self-test; children: FUZZ_DUMP + PROPS_VAULT_SO set by the parent)
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, type AccountMeta,
} from '@solana/web3.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BUILDS = { anchor: join(ROOT, 'target/deploy/props_vault.so'), pinocchio: process.env.PROPS_VAULT_SO || join(ROOT, 'target/deploy/props_vault_p.so') };
const SEEDS = Number(process.argv[2] ?? 20);
const STEPS = Number(process.argv[3] ?? 250);
const FIRST = Number(process.env.FIRST_SEED ?? 1);

type Rec = { seed: number; step: number; label: string; ok: boolean; err: string | null; code: string | null; inner: string; post: string; inv: string[] };

if (!process.env.FUZZ_DUMP) {
  const runs: Record<string, Rec[]> = {};
  const dir = mkdtempSync(join(tmpdir(), 'props-vault-seqfuzz-'));
  for (const [name, so] of Object.entries(BUILDS)) {
    const dump = join(dir, `${name}.json`);
    const t = Date.now();
    const r = spawnSync(process.execPath, [process.argv[1]!, String(SEEDS), String(STEPS)], {
      env: { ...process.env, PROPS_VAULT_SO: so, FUZZ_DUMP: dump }, stdio: ['ignore', 'inherit', 'inherit'], maxBuffer: 1 << 30,
    });
    if (r.status !== 0) throw new Error(`${name} run failed (${r.status})`);
    runs[name] = JSON.parse(readFileSync(dump, 'utf8'));
    console.log(`${name}: ${runs[name]!.length} steps in ${((Date.now() - t) / 1000).toFixed(0)} s`);
  }
  rmSync(dir, { recursive: true, force: true });
  const [a, p] = [runs.anchor!, runs.pinocchio!];
  const bySeed = (rs: Rec[]) => rs.reduce((m, r) => ((m.get(r.seed) ?? m.set(r.seed, []).get(r.seed)!).push(r), m), new Map<number, Rec[]>());
  const [as, ps] = [bySeed(a), bySeed(p)];
  let divergent = 0, compared = 0, okA = 0, txs = 0;
  const differences: string[] = [];
  const stats = new Map<string, { ok: number; fail: number }>();
  for (const [seed, xs] of as) {
    const ys = ps.get(seed) ?? [];
    for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
      const x = xs[i], y = ys[i];
      if (!x || !y || x.label !== y.label) {
        differences.push(`seed ${seed} step ${i}: sequences diverged (${x?.label} / ${y?.label})`);
        console.log(differences.at(-1));
        divergent++;
        break;
      }
      compared++;
      if (x.ok) okA++;
      const base = x.label.split(' ')[0]!;
      if (!base.startsWith('emu:')) txs++;
      const s = stats.get(base) ?? { ok: 0, fail: 0 };
      x.ok ? s.ok++ : s.fail++;
      stats.set(base, s);
      if (x.ok !== y.ok || (x.ok && (x.post !== y.post || x.inner !== y.inner)) || (!x.ok && x.post !== y.post)) {
        divergent++;
        differences.push(`seed ${seed} step ${i} ${x.label}: anchor ok=${x.ok} ${x.code ?? x.err ?? ''} post=${x.post.slice(0, 12)} inner=${x.inner.slice(0, 12)} / pinocchio ok=${y.ok} ${y.code ?? y.err ?? ''} post=${y.post.slice(0, 12)} inner=${y.inner.slice(0, 12)}`);
        console.log(`DIVERGENCE ${differences.at(-1)}`);
        break; // later steps build on a different state
      }
    }
  }
  const inv = (rs: Rec[]) => rs.filter((r) => r.inv.length);
  const violations: string[] = [];
  for (const [name, rs] of [['anchor', a], ['pinocchio', p]] as const) {
    for (const r of inv(rs)) {
      violations.push(`${name} seed ${r.seed} step ${r.step} ${r.label}: ${r.inv.join('; ')}`);
      console.log(`INVARIANT ${violations.at(-1)}`);
    }
  }
  console.log(`${compared} steps compared (${okA} succeeded), ${divergent} divergent seeds, invariant violations: anchor ${inv(a).length}, pinocchio ${inv(p).length}`);
  for (const [k, s] of [...stats].sort()) console.log(`  ${k.padEnd(24)} ok ${String(s.ok).padStart(5)}  fail ${String(s.fail).padStart(5)}`);
  if (process.env.FUZZ_SUMMARY) {
    writeFileSync(process.env.FUZZ_SUMMARY, JSON.stringify({
      fuzzer: 'seqfuzz', seeds: [...as.keys()], records: compared, txs, ok: okA, actions: Object.fromEntries([...stats].sort()), differences, violations,
    }));
  }
  process.exitCode = divergent || inv(a).length || inv(p).length ? 1 : 0;
} else {
  await child(process.env.FUZZ_DUMP);
}

async function child(dump: string): Promise<void> {
  let keySeed = 0;
  (Keypair as unknown as { generate: () => Keypair }).generate = () => {
    const s = new Uint8Array(32);
    new DataView(s.buffer).setUint32(0, keySeed++, true);
    s[31] = 0x5a;
    return Keypair.fromSeed(s);
  };
  Date.now = () => 1_790_000_000_000;
  const E: typeof import('../../../tests/program/src/env.ts') = await import(join(ROOT, 'tests/program/src/env.ts'));
  const T: typeof import('../compare/trading.ts') = await import(new URL('../compare/trading.ts', import.meta.url).href);
  const S = await import('@props/sdk');
  const spl = await import('@solana/spl-token');
  const { Env, MARKETS, USD, usdc, hash32, TIERS, marketParams, LEVERAGE, FailedTransactionMetadata, CONFIG_PARAMS } = E;
  const out: Rec[] = [];

  for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
    keySeed = seed * 1_000_000;
    // mulberry32
    let st = seed >>> 0;
    const rnd = () => {
      st = (st + 0x6d2b79f5) >>> 0;
      let t = st;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)]!;
    const chance = (p: number) => rnd() < p;
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

    const env = new Env();
    await env.setUpVault();
    for (const m of Object.values(MARKETS) as { gm: PublicKey }[]) T.setMarketClosed(env, m.gm, false);
    const v = env.vault;
    const keys = new Map<string, Keypair>();
    const hold = (k: Keypair) => (keys.set(k.publicKey.toBase58(), k), k);
    for (const k of [env.admin, env.risk, env.kyc]) hold(k);
    const payer = hold(Keypair.generate());
    env.svm.airdrop(payer.publicKey, 1_000_000_000_000n);
    const admin = env.admin.publicKey;

    // Watch set: every address the run has used, digested after each step.
    const watch = new Set<string>();
    const see = (...ks: PublicKey[]) => ks.forEach((k) => watch.add(k.toBase58()));
    const marketNames = Object.keys(MARKETS) as (keyof typeof MARKETS)[];
    see(S.configPda(), S.vaultAuthorityPda(), S.feeVaultPda(), S.capitalVaultAddress(), S.solTreasuryPda(), admin, env.risk.publicKey, env.kyc.publicKey);
    for (const n of marketNames) see(S.marketConfigPda(MARKETS[n].token), MARKETS[n].gm);

    type Trader = { kp: Keypair; funded?: PublicKey; owner?: PublicKey; ownerUsdc?: PublicKey };
    const traders: Trader[] = [];
    const attackerWallets = new Set<string>();
    const attackerTokens = new Set<string>();
    const strangers: Keypair[] = [];
    for (let i = 0; i < 2; i++) {
      const s = hold(env.wallet(5));
      strangers.push(s);
      const ata = env.setUsdc(s.publicKey, usdc('1000'));
      attackerWallets.add(s.publicKey.toBase58());
      attackerTokens.add(ata.toBase58());
      see(s.publicKey, ata);
    }
    const addFunded = (t: Trader, x: { funded: PublicKey; owner: PublicKey; ownerUsdc: PublicKey }) => {
      t.funded = x.funded;
      t.owner = x.owner;
      t.ownerUsdc = x.ownerUsdc;
      env.svm.airdrop(x.owner, 1_000_000_000n);
      see(x.funded, x.owner, x.ownerUsdc, S.gmUserPda(x.owner));
      for (const n of marketNames) for (const l of [true, false]) see(S.gmPositionPda(x.owner, MARKETS[n].token, l));
    };
    for (let i = 0; i < 4; i++) {
      const kp = hold(env.wallet(20));
      const t: Trader = { kp };
      traders.push(t);
      attackerWallets.add(kp.publicKey.toBase58());
      if (i < 3) addFunded(t, await env.activeFunded(kp));
      else await env.passedEvaluation(kp);
      const ata = spl.getAssociatedTokenAddressSync(S.USDC_MINT, kp.publicKey, true);
      attackerTokens.add(ata.toBase58());
      see(kp.publicKey, ata, S.traderProfilePda(kp.publicKey), S.evaluationPda(kp.publicKey, 0), S.evaluationPda(kp.publicKey, 1));
    }
    env.setUsdc(admin, usdc('5000'));
    see(spl.getAssociatedTokenAddressSync(S.USDC_MINT, admin, true));
    // Lookalikes at foreign addresses (impossible on mainnet for program-owned accounts; tests owner + PDA checks).
    const lookalike = (a: PublicKey) => {
      const c = Keypair.generate().publicKey;
      const acc = env.svm.getAccount(a);
      if (acc) env.svm.setAccount(c, { ...acc });
      see(c);
      return c;
    };
    const foreign = [lookalike(traders[0]!.funded!), lookalike(S.configPda()), lookalike(S.capitalVaultAddress()), lookalike(traders[1]!.ownerUsdc!), lookalike(S.marketConfigPda(MARKETS.SOL.token))];
    const claimables: { address: PublicKey; owner: PublicKey }[] = [];
    const otherMint = T.otherMint(env);
    see(otherMint);

    const HIGH = 10n ** 30n, LOW = 1n;
    const fundedOf = (t: Trader) => (t.funded && env.svm.getAccount(t.funded) ? env.funded(t.funded) : null);
    const statusOf = (t: Trader) => (t.funded ? S.enumName<string>(env.account('fundedAccount', t.funded).status) : 'none');
    const withFunded = () => traders.filter((t) => t.funded);
    /** Accounts not closed yet (trading targets); cranks sometimes pick a closed one on purpose. */
    const live = () => {
      const xs = traders.filter((t) => t.funded && statusOf(t) !== 'closed');
      return xs.length ? xs : withFunded();
    };
    const anyFunded = () => (chance(0.8) ? live() : withFunded());
    const trackedOrders = (t: Trader) => (fundedOf(t)?.account.orders ?? []).filter((o: { order: PublicKey }) => !o.order.equals(PublicKey.default));
    const ownerPositions = (t: Trader) => {
      const res: PublicKey[] = [];
      for (const n of marketNames) for (const l of [true, false]) {
        const p = S.gmPositionPda(t.owner!, MARKETS[n].token, l);
        const a = env.svm.getAccount(p);
        if (a && a.owner.equals(S.GMTRADE_PROGRAM_ID) && a.data.length > 0) res.push(p);
      }
      return res;
    };
    const signerKeys = () => [...keys.values()];

    // ---------- recording ----------
    const digest = () => {
      const h = createHash('sha256');
      for (const k of [...watch].sort()) {
        if (k === payer.publicKey.toBase58()) continue;
        const a = env.svm.getAccount(new PublicKey(k));
        h.update(k);
        if (a) h.update(String(a.lamports)).update(a.owner.toBytes()).update(a.data).update(a.executable ? '1' : '0');
      }
      return h.digest('hex');
    };
    type Bal = { lamports: bigint; usdc: bigint | null; owner: string; dataLen: number };
    const balances = () => {
      const m = new Map<string, Bal>();
      for (const k of watch) {
        const a = env.svm.getAccount(new PublicKey(k));
        if (!a) continue;
        const isToken = a.owner.equals(spl.TOKEN_PROGRAM_ID) && a.data.length === 165;
        m.set(k, { lamports: BigInt(a.lamports), usdc: isToken ? Buffer.from(a.data).readBigUInt64LE(64) : null, owner: a.owner.toBase58(), dataLen: a.data.length });
      }
      return m;
    };
    let step = 0;
    const send = (label0: string, ixs: TransactionInstruction[], opts: { check?: boolean; payoutAmount?: [string, bigint] } = {}) => {
      let label = label0;
      for (const ix of ixs) see(...ix.keys.map((k) => k.pubkey));
      const need = new Set<string>([payer.publicKey.toBase58()]);
      for (const ix of ixs) for (const k of ix.keys) if (k.isSigner) need.add(k.pubkey.toBase58());
      const ks: Keypair[] = [];
      for (const n of need) {
        const k = keys.get(n);
        if (!k) return null; // cannot sign
        ks.push(k);
      }
      const before = balances();
      // Authorization oracle inputs, as of before the transaction.
      const cfg0 = env.account('config', S.configPda());
      const risk0 = (cfg0.riskAuthorities as PublicKey[]).map((k) => k.toBase58());
      const admin0 = (cfg0.admin as PublicKey).toBase58();
      const kyc0 = (cfg0.kycAuthority as PublicKey).toBase58();
      const traderOf = (k?: PublicKey) => {
        const a = k && env.svm.getAccount(k);
        if (!a || !a.owner.equals(S.PROPS_VAULT_PROGRAM_ID)) return null;
        if (a.data.length === 1547) return env.account('fundedAccount', k!).trader.toBase58();
        if (a.data.length === 164) return env.account('evaluation', k!).trader.toBase58();
        return null;
      };
      const ix0 = ixs[0]!;
      const signer0 = ix0.keys[0]?.isSigner ? ix0.keys[0].pubkey.toBase58() : null;
      const kind0 = label0.split(' ')[0]!;
      const fundedIdx: Record<string, number> = {
        open_position: 2, set_protection: 2, update_order: 2, request_payout: 2, cancel_payout: 1, close_position: 2, cancel_order: 2, activate_funded: 3,
      };
      const owner0 = ix0.programId.equals(S.PROPS_VAULT_PROGRAM_ID) && kind0 in fundedIdx ? traderOf(ix0.keys[fundedIdx[kind0]!]?.pubkey) : null;
      // Round 3: top_up_owner refills only an Active account while trading is live (funded = account 1).
      const topUp0 = kind0 === 'top_up_owner' ? (() => {
        const k = ix0.keys[1]?.pubkey;
        const a = k && env.svm.getAccount(k);
        const status = a && a.owner.equals(S.PROPS_VAULT_PROGRAM_ID) && a.data.length === 1547 ? S.enumName<string>(env.account('fundedAccount', k!).status) : 'not-a-funded-account';
        return `${status}${cfg0.paused.trading ? '/trading-paused' : ''}`;
      })() : null;
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs);
      tx.feePayer = payer.publicKey;
      tx.recentBlockhash = env.svm.latestBlockhash();
      tx.sign(...ks);
      let res;
      try {
        res = env.svm.sendTransaction(tx);
      } catch (e) {
        return null; // client-side refusal (e.g. too large): not sent
      }
      env.svm.expireBlockhash();
      const failed = res instanceof FailedTransactionMetadata;
      const meta = res instanceof FailedTransactionMetadata ? res.meta() : res;
      const logs: string[] = meta.logs();
      const accountKeys = tx.compileMessage().accountKeys;
      const inner = failed ? '' : createHash('sha256').update(meta.innerInstructions().flat().map((i: any) => {
        const ix = i.instruction();
        return `${i.stackHeight()} ${accountKeys[ix.programIdIndex()]!.toBase58()} [${Array.from(ix.accounts(), (x: number) => accountKeys[x]!.toBase58()).join(',')}] ${Buffer.from(ix.data()).toString('hex')}`;
      }).join('\n')).digest('hex');
      const inv: string[] = [];
      if (!failed && ix0.programId.equals(S.PROPS_VAULT_PROGRAM_ID)) {
        const gate: Record<string, () => boolean> = {
          open_position: () => signer0 === owner0,
          set_protection: () => signer0 === owner0,
          update_order: () => signer0 === owner0,
          request_payout: () => signer0 === owner0,
          cancel_payout: () => signer0 === owner0,
          activate_funded: () => signer0 === owner0,
          close_position: () => signer0 === owner0 || (signer0 !== null && risk0.includes(signer0)),
          cancel_order: () => signer0 === owner0 || (signer0 !== null && risk0.includes(signer0)),
          record_evaluation_result: () => signer0 !== null && risk0.includes(signer0),
          approve_payout: () => signer0 !== null && risk0.includes(signer0),
          reject_payout: () => signer0 !== null && risk0.includes(signer0),
          restrict: () => signer0 !== null && risk0.includes(signer0),
          mark_breached: () => signer0 !== null && risk0.includes(signer0),
          close_funded: () => signer0 !== null && risk0.includes(signer0),
          set_identity: () => signer0 === kyc0,
          set_pauses: () => signer0 === admin0, set_params: () => signer0 === admin0, set_authorities: () => signer0 === admin0,
          upsert_market: () => signer0 === admin0, upsert_tier: () => signer0 === admin0, deposit_capital: () => signer0 === admin0,
          withdraw_capital: () => signer0 === admin0, sweep_fees: () => signer0 === admin0, withdraw_sol_treasury: () => signer0 === admin0,
          propose_admin: () => signer0 === admin0,
        };
        const g = gate[kind0];
        if (g && !g()) inv.push(`AUTHZ: ${kind0} succeeded signed by ${signer0?.slice(0, 8)} (owner-trader ${owner0?.slice(0, 8)}, risk ${risk0.map((x) => x.slice(0, 6))}, admin ${admin0.slice(0, 6)}, kyc ${kyc0.slice(0, 6)})`);
        if (topUp0 !== null && topUp0 !== 'active') inv.push(`TOPUP: top_up_owner succeeded for a ${topUp0} account (round 3: Active only, and never while trading is paused)`);
      }
      if (opts.check !== false && !failed) {
        const after = balances();
        const kind = label.split(' ')[0]!;
        for (const [k, b] of after) {
          const a = before.get(k);
          const dl = b.lamports - (a?.lamports ?? 0n);
          const du = (b.usdc ?? 0n) - (a?.usdc ?? 0n);
          if (attackerWallets.has(k) && dl > 0n) inv.push(`attacker wallet ${k.slice(0, 8)} gained ${dl} lamports`);
          if (attackerTokens.has(k) && du > 0n) {
            const allowed = opts.payoutAmount && opts.payoutAmount[0] === k && opts.payoutAmount[1] === du && kind === 'approve_payout';
            if (!allowed) inv.push(`attacker token ${k.slice(0, 8)} gained ${du} USDC`);
          }
        }
        for (const t of withFunded()) {
          const o = env.svm.getAccount(t.owner!);
          if (o && (!o.owner.equals(SystemProgram.programId) || o.data.length > 0)) inv.push(`owner ${t.owner!.toBase58().slice(0, 8)} not a data-less system account`);
          const ou = t.ownerUsdc!.toBase58();
          const du = (after.get(ou)?.usdc ?? 0n) - (before.get(ou)?.usdc ?? 0n);
          if (du < 0n && !['open_position', 'approve_payout', 'close_funded'].includes(kind)) inv.push(`owner usdc ${ou.slice(0, 8)} lost ${-du} in ${kind}`);
        }
        const dec = (addr: PublicKey, field: 'usdc' | 'lamports', allowed: string[], what: string) => {
          const k = addr.toBase58();
          const d = ((after.get(k)?.[field] ?? 0n) as bigint) - ((before.get(k)?.[field] ?? 0n) as bigint);
          if (d < 0n && !allowed.includes(kind)) inv.push(`${what} lost ${-d} in ${kind}`);
        };
        dec(S.capitalVaultAddress(), 'usdc', ['activate_funded', 'withdraw_capital'], 'capital vault');
        dec(S.feeVaultPda(), 'usdc', ['sweep_fees'], 'fee vault');
        dec(S.solTreasuryPda(), 'lamports', ['top_up_owner', 'activate_funded', 'approve_payout', 'withdraw_sol_treasury'], 'sol treasury');
      }
      if (inv.length) {
        const cfg = env.account('config', S.configPda());
        const risks = (cfg.riskAuthorities as PublicKey[]).map((k) => k.toBase58());
        const signed = [...need].map((n) => `${n.slice(0, 8)}${risks.includes(n) ? '(risk)' : ''}${attackerWallets.has(n) ? '(attacker)' : ''}`);
        const accts = ixs[0]!.keys.map((k, i) => `${i}:${k.pubkey.toBase58().slice(0, 8)}${k.isSigner ? 's' : ''}${k.isWritable ? 'w' : ''}`);
        inv.push(`signers ${signed.join(',')} | keys ${accts.join(' ')}`);
      }
      if (!failed && /~(sub|signer)/.test(label)) {
        const cfg = env.account('config', S.configPda());
        const risks = (cfg.riskAuthorities as PublicKey[]).map((k) => k.toBase58());
        const role = (n: string) =>
          n === admin.toBase58() ? 'admin' : n === env.risk.publicKey.toBase58() ? 'risk' : n === env.kyc.publicKey.toBase58() ? 'kyc'
          : strangers.some((x) => x.publicKey.toBase58() === n) ? 'stranger' : traders.findIndex((x) => x.kp.publicKey.toBase58() === n) >= 0 ? `trader${traders.findIndex((x) => x.kp.publicKey.toBase58() === n)}` : n.slice(0, 6);
        const fundedKey = ixs[0]!.keys[2]?.pubkey;
        const fundedTrader = fundedKey && env.svm.getAccount(fundedKey)?.owner.equals(S.PROPS_VAULT_PROGRAM_ID) && env.svm.getAccount(fundedKey)!.data.length === 1547
          ? env.account('fundedAccount', fundedKey).trader.toBase58() : '';
        label += ` [signers ${[...need].filter((n) => n !== payer.publicKey.toBase58()).map((n) => `${role(n)}${risks.includes(n) ? '/inRiskList' : ''}${n === fundedTrader ? '/fundedTrader' : ''}`).join(',')}]`;
      }
      const rec: Rec = {
        seed, step: step++, label, ok: !failed, err: res instanceof FailedTransactionMetadata ? res.err().toString() : null,
        code: logs.map((l) => /Error Code: (\w+)/.exec(l)?.[1]).find(Boolean) ?? null, inner, post: digest(), inv,
      };
      out.push(rec);
      return rec;
    };
    const emulate = (label: string, f: () => void) => {
      f();
      out.push({ seed, step: step++, label: `emu:${label}`, ok: true, err: null, code: null, inner: '', post: digest(), inv: [] });
    };

    // ---------- mutations ----------
    const pool = () => [...watch].map((k) => new PublicKey(k));
    const mutate = (ix: TransactionInstruction): [TransactionInstruction, string] => {
      const ks = ix.keys.map((k) => ({ ...k }));
      const data = Buffer.from(ix.data);
      const r = rnd();
      let what: string;
      if (r < 0.4) {
        const i = int(0, ks.length - 1);
        const c = pick(pool());
        if (c.equals(ks[i]!.pubkey)) return [ix, 'none'];
        ks[i] = { ...ks[i]!, pubkey: c };
        what = `sub[${i}]=${c.toBase58().slice(0, 6)}`;
      } else if (r < 0.55) {
        const signers = ks.map((k, i) => (k.isSigner ? i : -1)).filter((i) => i >= 0);
        if (!signers.length) return [ix, 'none'];
        const i = pick(signers);
        ks[i] = { ...ks[i]!, pubkey: pick(signerKeys()).publicKey };
        what = `signer[${i}]`;
      } else if (r < 0.65) {
        const i = int(0, ks.length - 1);
        ks[i] = { ...ks[i]!, isWritable: !ks[i]!.isWritable };
        what = `flip[${i}]`;
      } else if (r < 0.8) {
        const i = int(0, ks.length - 1), j = int(0, ks.length - 1);
        if (i === j || ks[i]!.pubkey.equals(ks[j]!.pubkey)) return [ix, 'none'];
        ks[i] = { ...ks[i]!, pubkey: ks[j]!.pubkey };
        what = `dup[${i}]=[${j}]`;
      } else if (r < 0.9) {
        if (chance(0.5)) {
          ks.push({ pubkey: pick(pool()), isSigner: false, isWritable: chance(0.5) });
          what = 'append';
        } else {
          ks.pop();
          what = 'pop';
        }
      } else {
        if (data.length <= 8) return [ix, 'none'];
        const i = int(8, data.length - 1);
        data[i] = int(0, 255);
        what = `data[${i}]`;
      }
      return [new TransactionInstruction({ programId: ix.programId, keys: ks as AccountMeta[], data }), what];
    };
    const go = (label: string, ix: TransactionInstruction, opts: { payoutAmount?: [string, bigint] } = {}) => {
      if (chance(0.35)) {
        const [m, what] = mutate(ix);
        // The allowed payout stays the same under a mutation: only the expected trader ATA may gain, and only trader_amount.
        if (what !== 'none') return send(`${label} ~${what}`, [m], opts);
      }
      return send(label, [ix], opts);
    };

    // ---------- actions ----------
    const marketOf = () => pick(marketNames);
    const actions: [number, () => Promise<unknown>][] = [
      [10, async () => { // open
        const t = pick(live());
        const ref = fundedOf(t);
        if (!ref) return;
        const collateral = BigInt(int(1, 40)) * 1_000_000n;
        const lev = BigInt(int(1, 15));
        const isLong = chance(0.6);
        const limit = chance(0.3);
        const o = await v.openPosition({
          trader: t.kp.publicKey, funded: ref, marketToken: MARKETS[marketOf()].token, isLong, orderType: limit ? 'limit' : 'market',
          collateral, sizeDeltaUsd: (collateral * lev * USD) / 1_000_000n, triggerPrice: limit ? BigInt(int(1, 5000)) * 10n ** 11n : undefined,
          acceptablePrice: isLong ? HIGH : LOW,
        });
        see(o.order, S.gmOrderEscrow(o.order));
        go('open_position', o.instruction);
      }],
      [6, async () => { // close
        const t = pick(live());
        const ref = fundedOf(t);
        if (!ref) return;
        const slots = ref.account.slots.filter((s: { marketToken: PublicKey }) => !s.marketToken.equals(PublicKey.default));
        const slot = slots.length && chance(0.85) ? pick(slots) : null;
        const marketToken = slot ? slot.marketToken : MARKETS[marketOf()].token;
        const o = await v.closePosition({
          authority: chance(0.3) ? env.risk.publicKey : t.kp.publicKey, funded: ref, marketToken, isLong: slot ? slot.isLong : chance(0.5),
          sizeDeltaUsd: chance(0.4) ? S.CLOSE_ALL : BigInt(int(1, 400)) * USD, acceptablePrice: slot?.isLong ?? true ? LOW : HIGH,
        });
        see(o.order, S.gmOrderEscrow(o.order));
        go('close_position', o.instruction);
      }],
      [5, async () => { // protect
        const t = pick(live());
        const ref = fundedOf(t);
        if (!ref) return;
        const slots = ref.account.slots.filter((s: { marketToken: PublicKey }) => !s.marketToken.equals(PublicKey.default));
        if (!slots.length) return;
        const slot = pick(slots);
        const o = await v.setProtection({
          trader: t.kp.publicKey, funded: ref, marketToken: slot.marketToken, isLong: slot.isLong, orderType: chance(0.5) ? 'takeProfit' : 'stopLoss',
          triggerPrice: BigInt(int(1, 5000)) * 10n ** 11n, sizeDeltaUsd: chance(0.5) ? S.CLOSE_ALL : BigInt(int(1, 300)) * USD,
        });
        see(o.order, S.gmOrderEscrow(o.order));
        go('set_protection', o.instruction);
      }],
      [5, async () => { // update
        const t = pick(live());
        const ref = fundedOf(t);
        const orders = trackedOrders(t);
        if (!ref || !orders.length) return;
        const o = pick(orders);
        const ix = await v.updateOrder({
          trader: t.kp.publicKey, funded: ref, order: o.order,
          triggerPrice: chance(0.6) ? BigInt(int(1, 5000)) * 10n ** 11n : undefined,
          acceptablePrice: chance(0.3) ? HIGH : undefined,
          sizeDeltaUsd: chance(0.5) ? BigInt(int(1, 300)) * USD : undefined,
        });
        go('update_order', ix);
      }],
      [6, async () => { // cancel
        const t = pick(live());
        const ref = fundedOf(t);
        const orders = trackedOrders(t);
        if (!ref || !orders.length) return;
        const o = pick(orders);
        go('cancel_order', await v.cancelOrder({ authority: chance(0.3) ? env.risk.publicKey : t.kp.publicKey, funded: ref, order: o.order }));
      }],
      [8, async () => { // sync
        const t = pick(anyFunded());
        const ref = fundedOf(t);
        if (!ref) return;
        go('sync', await v.sync({ funded: ref }));
      }],
      [3, async () => { // top up
        const t = pick(anyFunded());
        go('top_up_owner', await v.topUpOwner({ funded: t.funded! }));
      }],
      [4, async () => { // close completed
        const t = pick(anyFunded());
        const orders = trackedOrders(t);
        if (!orders.length) return;
        go('close_completed_order', await v.closeCompletedOrder({ funded: t.funded!, order: pick(orders).order }));
      }],
      [4, async () => { // close empty position
        const t = pick(anyFunded());
        const ps = ownerPositions(t);
        if (!ps.length) return;
        go('close_empty_position', await v.closeEmptyPosition({ funded: t.funded!, position: pick(ps) }));
      }],
      [3, async () => { // collect claimable
        if (!claimables.length) return;
        const c = pick(claimables);
        const t = withFunded().find((x) => x.owner!.equals(c.owner)) ?? pick(withFunded());
        const ref = fundedOf(t);
        if (!ref) return;
        go('collect_claimable', await v.collectClaimable({ funded: ref, claimable: c.address }));
      }],
      [4, async () => { // request payout
        const t = pick(live());
        const ref = fundedOf(t);
        if (!ref) return;
        const seq = ref.account.payoutSeq;
        see(S.payoutPda(t.funded!, seq));
        go('request_payout', await v.requestPayout({ trader: t.kp.publicKey, funded: t.funded!, payoutSeq: seq }));
      }],
      [2, async () => { // cancel payout
        const t = pick(live());
        const ref = fundedOf(t);
        if (!ref || ref.account.payoutSeq === 0) return;
        go('cancel_payout', await v.cancelPayout({ trader: t.kp.publicKey, funded: t.funded!, payout: S.payoutPda(t.funded!, ref.account.payoutSeq - 1) }));
      }],
      [4, async () => { // approve payout
        const t = pick(live());
        const ref = fundedOf(t);
        if (!ref || ref.account.payoutSeq === 0) return;
        const payout = S.payoutPda(t.funded!, ref.account.payoutSeq - 1);
        const pr = env.svm.getAccount(payout) ? env.account('payoutRequest', payout) : null;
        const traderAta = spl.getAssociatedTokenAddressSync(S.USDC_MINT, ref.account.trader, true);
        see(traderAta);
        go('approve_payout', await v.approvePayout({ riskAuthority: env.risk.publicKey, funded: ref, payout, positions: ownerPositions(t) }),
          { payoutAmount: pr ? [traderAta.toBase58(), BigInt(pr.traderAmount.toString())] : undefined });
      }],
      [2, async () => { // reject payout
        const t = pick(live());
        const ref = fundedOf(t);
        if (!ref || ref.account.payoutSeq === 0) return;
        go('reject_payout', await v.rejectPayout({ riskAuthority: env.risk.publicKey, funded: t.funded!, payout: S.payoutPda(t.funded!, ref.account.payoutSeq - 1), reasonCode: int(0, 9) }));
      }],
      [2, async () => { // restrict
        const t = pick(live());
        go('restrict', await v.restrict({ riskAuthority: env.risk.publicKey, funded: t.funded!, restricted: chance(0.5) }));
      }],
      [1, async () => { // breach
        const t = pick(live());
        go('mark_breached', await v.markBreached({ riskAuthority: env.risk.publicKey, funded: t.funded! }));
      }],
      [1, async () => { // close funded
        const t = pick(live());
        const ref = fundedOf(t);
        if (!ref) return;
        go('close_funded', await v.closeFunded({ riskAuthority: env.risk.publicKey, funded: ref, positions: ownerPositions(t) }));
      }],
      [4, async () => { // buy evaluation + (maybe) identity + result + activate (a trader whose account is closed or who has none)
        const idle = traders.filter((x) => !x.funded || statusOf(x) === 'closed');
        const t = idle.length && chance(0.8) ? pick(idle) : pick(traders);
        const profile = S.traderProfilePda(t.kp.publicKey);
        const index = env.svm.getAccount(profile) ? env.account('traderProfile', profile).evaluationCount : 0;
        if (env.usdcBalance(spl.getAssociatedTokenAddressSync(S.USDC_MINT, t.kp.publicKey)) < usdc('500')) env.setUsdc(t.kp.publicKey, usdc('1000'));
        see(S.evaluationPda(t.kp.publicKey, index));
        const r = go('buy_evaluation', await v.buyEvaluation({ trader: t.kp.publicKey, tierId: TIERS.t10k.id, index, ...env.reviewed(TIERS.t10k.id) }));
        if (!r?.ok) return;
        const evaluation = S.evaluationPda(t.kp.publicKey, index);
        go('record_evaluation_result', await v.recordEvaluationResult({ riskAuthority: env.risk.publicKey, evaluation, passed: chance(0.8), finalEquity: usdc('10900'), tradesRoot: hash32('f') }));
        const funded = S.fundedPda(evaluation);
        see(funded, S.ownerPda(funded), S.ownerUsdcAddress(funded));
        const a = go('activate_funded', await v.activateFunded({ trader: t.kp.publicKey, evaluation }));
        if (a?.ok && !a.label.includes('~') && env.svm.getAccount(funded)) addFunded(t, { funded, owner: S.ownerPda(funded), ownerUsdc: S.ownerUsdcAddress(funded) });
      }],
      [1, async () => { // set identity for a stranger wallet (new profile) or an existing trader
        const w = chance(0.5) ? pick(strangers).publicKey : pick(traders).kp.publicKey;
        const h = hash32(`id:${seed}:${step}`);
        see(S.traderProfilePda(w), S.identityLockPda(h));
        go('set_identity', await v.setIdentity({ kycAuthority: env.kyc.publicKey, wallet: w, identityHash: h }));
      }],
      [2, async () => { // admin: pauses / market / authorities / capital / fees / sol
        const r = rnd();
        if (r < 0.25) go('set_pauses', await v.setPauses({ admin, paused: { newEvaluations: chance(0.2), trading: chance(0.2), payouts: chance(0.2) } }));
        else if (r < 0.45) {
          const n = marketOf();
          go('upsert_market', await v.upsertMarket({ admin, marketToken: MARKETS[n].token, params: marketParams(n, pick([LEVERAGE.crypto, LEVERAGE.fx, 100_000]), { enabled: chance(0.8) }) }));
        } else if (r < 0.6) {
          const risks = [env.risk.publicKey, ...(chance(0.3) ? [pick(traders).kp.publicKey] : [])];
          go('set_authorities', await v.setAuthorities({ admin, riskAuthorities: risks, kycAuthority: env.kyc.publicKey }));
        } else if (r < 0.7) go('deposit_capital', await v.depositCapital({ admin, amount: usdc(String(int(1, 50))) }));
        else if (r < 0.8) go('withdraw_capital', await v.withdrawCapital({ admin, amount: usdc(String(int(1, 50))) }));
        else if (r < 0.9) go('sweep_fees', await v.sweepFees({ admin }));
        else go('withdraw_sol_treasury', await v.withdrawSolTreasury({ admin, lamports: BigInt(int(1, 100)) * 1_000_000n }));
      }],
      [3, async () => { // stranger donations: SOL and USDC to any watched account
        const s = pick(strangers);
        const to = pick(pool());
        if (chance(0.5)) send('donate_sol', [SystemProgram.transfer({ fromPubkey: s.publicKey, toPubkey: to, lamports: int(1, 3_000_000) })], { check: false });
        else {
          const acc = env.svm.getAccount(to);
          if (!acc || !acc.owner.equals(spl.TOKEN_PROGRAM_ID) || acc.data.length !== 165) return;
          send('donate_usdc', [spl.createTransferInstruction(spl.getAssociatedTokenAddressSync(S.USDC_MINT, s.publicKey, true), to, s.publicKey, BigInt(int(1, 5_000_000)))], { check: false });
        }
      }],
      [9, async () => { // GMTrade keeper emulation
        const t = pick(live());
        const ref = fundedOf(t);
        if (!ref) return;
        const orders = trackedOrders(t);
        const r = rnd();
        if (orders.length && r < 0.45) {
          const o = pick(orders);
          const acc = env.svm.getAccount(o.order);
          if (!acc || !acc.owner.equals(S.GMTRADE_PROGRAM_ID) || acc.data[9] !== 0) return;
          const slot = ref.account.slots[o.slot];
          const pos = slot?.gmPosition;
          const kind = S.enumName<string>(o.orderType);
          const q = rnd();
          if (q < 0.55 && pos && env.svm.getAccount(pos)?.owner.equals(S.GMTRADE_PROGRAM_ID)) {
            emulate(`fill ${kind}`, () => {
              const p = S.decodeGmPosition(env.svm.getAccount(pos)!.data);
              const size = BigInt(p.sizeInUsd.toString()), col = BigInt(p.collateralAmount.toString());
              const escrow = S.gmOrderEscrow(o.order);
              if (kind === 'market' || kind === 'limit') {
                env.executeOrder(o.order, escrow);
                env.setPosition(pos, size + BigInt(o.sizeUsd.toString()), col + BigInt(o.collateral.toString()));
              } else {
                const cut = BigInt(o.sizeUsd.toString()) >= size ? size : BigInt(o.sizeUsd.toString());
                const back = size === 0n ? 0n : (col * cut) / size;
                env.executeOrder(o.order, escrow);
                env.setPosition(pos, size - cut, col - back);
                const pnl = chance(0.5) ? back + BigInt(int(0, 200)) * 1_000_000n : back / 2n;
                env.setUsdcBalance(t.ownerUsdc!, env.usdcBalance(t.ownerUsdc!) + pnl);
              }
            });
          } else if (q < 0.8) emulate(`gm_state ${kind}`, () => T.setOrderState(env, o.order, chance(0.5) ? 1 : 2));
          else emulate(`gm_close ${kind}`, () => {
            const escrow = S.gmOrderEscrow(o.order);
            const held = env.usdcBalance(escrow);
            env.executeOrder(o.order, escrow);
            env.setUsdcBalance(t.ownerUsdc!, env.usdcBalance(t.ownerUsdc!) + held);
          });
        } else if (r < 0.65) {
          const ps = ownerPositions(t);
          if (!ps.length) return;
          const p = pick(ps);
          emulate('liquidate', () => env.setPosition(p, 0n, 0n));
        } else if (r < 0.75) {
          const ps = ownerPositions(t).filter((p) => BigInt(S.decodeGmPosition(env.svm.getAccount(p)!.data).sizeInUsd.toString()) === 0n);
          if (!ps.length) return;
          const p = pick(ps);
          emulate('gm_close_position', () => env.remove(p));
        } else if (r < 0.9) {
          emulate('profit', () => env.setUsdcBalance(t.ownerUsdc!, env.usdcBalance(t.ownerUsdc!) + BigInt(int(1, 300)) * 1_000_000n));
        } else {
          emulate('claimable', () => {
            const address = Keypair.generate().publicKey;
            const data = Buffer.alloc(spl.AccountLayout.span);
            const amount = BigInt(int(1, 50)) * 1_000_000n;
            spl.AccountLayout.encode({
              mint: chance(0.9) ? S.USDC_MINT : otherMint, owner: S.GMTRADE_STORE, amount, delegateOption: 1, delegate: chance(0.85) ? t.owner! : pick(strangers).publicKey,
              state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: chance(0.8) ? amount : amount / 2n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
            }, data);
            env.svm.setAccount(address, { lamports: 2_039_280, data, owner: spl.TOKEN_PROGRAM_ID, executable: false });
            claimables.push({ address, owner: t.owner! });
            see(address);
          });
        }
      }],
    ];
    actions.push(
      [5, async () => { // payout cycle: GMTrade ends every order and position, sync, profit lands, request, then a decision
        const t = pick(live());
        if (statusOf(t) !== 'active') return;
        emulate('flatten', () => {
          for (const o of trackedOrders(t)) {
            const escrow = S.gmOrderEscrow(o.order);
            const held = env.usdcBalance(escrow);
            env.executeOrder(o.order, escrow);
            env.setUsdcBalance(t.ownerUsdc!, env.usdcBalance(t.ownerUsdc!) + held);
          }
          for (const p of ownerPositions(t)) env.setPosition(p, 0n, 0n);
          env.setUsdcBalance(t.ownerUsdc!, env.usdcBalance(t.ownerUsdc!) + BigInt(int(100, 900)) * 1_000_000n);
        });
        const ref = fundedOf(t);
        if (!ref) return;
        go('sync', await v.sync({ funded: ref }));
        const seq = fundedOf(t)!.account.payoutSeq;
        see(S.payoutPda(t.funded!, seq));
        const r = go('request_payout', await v.requestPayout({ trader: t.kp.publicKey, funded: t.funded!, payoutSeq: seq }));
        if (!r?.ok) return;
        const payout = S.payoutPda(t.funded!, seq);
        const q = rnd();
        if (q < 0.6) {
          const pr = env.account('payoutRequest', payout);
          const traderAta = spl.getAssociatedTokenAddressSync(S.USDC_MINT, t.kp.publicKey, true);
          see(traderAta);
          if (chance(0.3)) env.remove(traderAta); // the trader closed their USDC ATA: the treasury re-creates it
          go('approve_payout', await v.approvePayout({ riskAuthority: env.risk.publicKey, funded: fundedOf(t)!, payout, positions: ownerPositions(t) }),
            { payoutAmount: [traderAta.toBase58(), BigInt(pr.traderAmount.toString())] });
        } else if (q < 0.8) go('reject_payout', await v.rejectPayout({ riskAuthority: env.risk.publicKey, funded: t.funded!, payout, reasonCode: 1 }));
        else go('cancel_payout', await v.cancelPayout({ trader: t.kp.publicKey, funded: t.funded!, payout }));
      }],
      [2, async () => { // the owner's float ran low (GMTrade rents), then a top-up
        const t = pick(anyFunded());
        const o = env.svm.getAccount(t.owner!);
        if (!o) return;
        emulate('drain_owner', () => env.svm.setAccount(t.owner!, { ...o, lamports: int(700_000, 90_000_000) }));
        go('top_up_owner', await v.topUpOwner({ funded: t.funded! }));
      }],
    );
    actions.push([8, async () => { // impersonation: a whole instruction built for someone else's accounts, signed by any key we hold
      const x = pick(signerKeys());
      const X = x.publicKey;
      const t = pick(anyFunded());
      const ref = fundedOf(t);
      if (!ref) return;
      const slots = ref.account.slots.filter((s: { marketToken: PublicKey }) => !s.marketToken.equals(PublicKey.default));
      const orders = trackedOrders(t);
      const seq = ref.account.payoutSeq;
      const r = int(0, 20);
      const tag = `imp`;
      if (r === 0) {
        const o = await v.openPosition({ trader: X, funded: ref, marketToken: MARKETS[marketOf()].token, isLong: true, orderType: 'market', collateral: 5_000_000n, sizeDeltaUsd: 20n * USD, acceptablePrice: HIGH });
        send(`open_position ${tag}`, [o.instruction]);
      } else if (r === 1 && slots.length) {
        const s = pick(slots);
        send(`close_position ${tag}`, [(await v.closePosition({ authority: X, funded: ref, marketToken: s.marketToken, isLong: s.isLong, sizeDeltaUsd: S.CLOSE_ALL, acceptablePrice: s.isLong ? LOW : HIGH })).instruction]);
      } else if (r === 2 && slots.length) {
        const s = pick(slots);
        send(`set_protection ${tag}`, [(await v.setProtection({ trader: X, funded: ref, marketToken: s.marketToken, isLong: s.isLong, orderType: 'stopLoss', triggerPrice: 10n ** 12n, sizeDeltaUsd: S.CLOSE_ALL })).instruction]);
      } else if (r === 3 && orders.length) {
        send(`update_order ${tag}`, [await v.updateOrder({ trader: X, funded: ref, order: pick(orders).order, triggerPrice: 10n ** 12n })]);
      } else if (r === 4 && orders.length) {
        send(`cancel_order ${tag}`, [await v.cancelOrder({ authority: X, funded: ref, order: pick(orders).order })]);
      } else if (r === 5) {
        see(S.payoutPda(t.funded!, seq));
        send(`request_payout ${tag}`, [await v.requestPayout({ trader: X, funded: t.funded!, payoutSeq: seq })]);
      } else if (r === 6 && seq > 0) {
        send(`cancel_payout ${tag}`, [await v.cancelPayout({ trader: X, funded: t.funded!, payout: S.payoutPda(t.funded!, seq - 1) })]);
      } else if (r === 7 && seq > 0) {
        const payout = S.payoutPda(t.funded!, seq - 1);
        const pr = env.svm.getAccount(payout) ? env.account('payoutRequest', payout) : null;
        const traderAta = spl.getAssociatedTokenAddressSync(S.USDC_MINT, ref.account.trader, true);
        send(`approve_payout ${tag}`, [await v.approvePayout({ riskAuthority: X, funded: ref, payout, positions: ownerPositions(t) })],
          { payoutAmount: pr ? [traderAta.toBase58(), BigInt(pr.traderAmount.toString())] : undefined });
      } else if (r === 8 && seq > 0) {
        send(`reject_payout ${tag}`, [await v.rejectPayout({ riskAuthority: X, funded: t.funded!, payout: S.payoutPda(t.funded!, seq - 1), reasonCode: 2 })]);
      } else if (r === 9) {
        send(`restrict ${tag}`, [await v.restrict({ riskAuthority: X, funded: t.funded!, restricted: chance(0.5) })]);
      } else if (r === 10) {
        send(`mark_breached ${tag}`, [await v.markBreached({ riskAuthority: X, funded: t.funded! })]);
      } else if (r === 11) {
        send(`close_funded ${tag}`, [await v.closeFunded({ riskAuthority: X, funded: ref, positions: ownerPositions(t) })]);
      } else if (r === 12) {
        const who = pick(traders).kp.publicKey;
        const profile = S.traderProfilePda(who);
        const n = env.svm.getAccount(profile) ? env.account('traderProfile', profile).evaluationCount : 0;
        if (n > 0) send(`record_evaluation_result ${tag}`, [await v.recordEvaluationResult({ riskAuthority: X, evaluation: S.evaluationPda(who, n - 1), passed: true, finalEquity: 1n, tradesRoot: hash32('x') })]);
      } else if (r === 13) {
        const h = hash32(`imp:${seed}:${step}`);
        see(S.identityLockPda(h));
        send(`set_identity ${tag}`, [await v.setIdentity({ kycAuthority: X, wallet: pick(strangers).publicKey, identityHash: h })]);
      } else if (r === 14) {
        const who = pick(traders);
        const profile = S.traderProfilePda(who.kp.publicKey);
        const n = env.svm.getAccount(profile) ? env.account('traderProfile', profile).evaluationCount : 0;
        if (n > 0) {
          const evaluation = S.evaluationPda(who.kp.publicKey, n - 1);
          const funded = S.fundedPda(evaluation);
          see(funded, S.ownerPda(funded), S.ownerUsdcAddress(funded));
          send(`activate_funded ${tag}`, [await v.activateFunded({ trader: X, evaluation })]);
        }
      } else if (r === 15) send(`set_pauses ${tag}`, [await v.setPauses({ admin: X, paused: { newEvaluations: false, trading: false, payouts: false } })]);
      else if (r === 16) send(`withdraw_capital ${tag}`, [await v.withdrawCapital({ admin: X, amount: 1_000_000n, adminUsdc: env.setUsdc(X, 0n) })]);
      else if (r === 17) send(`withdraw_sol_treasury ${tag}`, [await v.withdrawSolTreasury({ admin: X, lamports: 1_000_000n })]);
      else if (r === 18) send(`set_authorities ${tag}`, [await v.setAuthorities({ admin: X, riskAuthorities: [X], kycAuthority: X })]);
      else if (r === 19) send(`sweep_fees ${tag}`, [await v.sweepFees({ admin: X })]);
      else if (r === 20) send(`propose_admin ${tag}`, [await v.proposeAdmin({ admin: X, newAdmin: X })]);
    }]);
    if (process.env.SANITY) {
      // Detector self-test: a real USDC transfer to an attacker token account, and a gated kind signed by the wrong key.
      const adminAta = spl.getAssociatedTokenAddressSync(S.USDC_MINT, admin, true);
      const sAta = spl.getAssociatedTokenAddressSync(S.USDC_MINT, strangers[0]!.publicKey, true);
      send('sanity_transfer', [spl.createTransferInstruction(adminAta, sAta, admin, 1n)]);
      send('close_funded sanity-mislabel', [await v.setPauses({ admin, paused: { newEvaluations: false, trading: false, payouts: false } })]);
      // ... and the round-3 top-up rule: a success labelled top_up_owner whose account 1 is not an Active funded account.
      send('top_up_owner sanity-mislabel', [await v.setPauses({ admin, paused: { newEvaluations: false, trading: false, payouts: false } })]);
    }
    const total = actions.reduce((s, [w]) => s + w, 0);
    for (let i = 0; i < STEPS; i++) {
      let r = rnd() * total;
      const [, f] = actions.find(([w]) => (r -= w) < 0) ?? actions[0]!;
      try {
        await f();
      } catch (e) {
        // A builder refused (e.g. the SDK throws for an order it does not track): record nothing.
      }
    }
    void foreign;
    void CONFIG_PARAMS;
    process.stderr.write(`seed ${seed}: ${out.filter((x) => x.seed === seed).length} records\n`);
  }
  writeFileSync(dump, JSON.stringify(out));
}
