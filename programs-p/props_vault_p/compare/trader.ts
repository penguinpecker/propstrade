// The trader.rs instructions (buy_evaluation, activate_funded, request_payout, cancel_payout), happy paths and refusals,
// compared byte for byte (see harness.ts). Also covers what the suite does not: every account substitution and read-only
// flag, pre-funded profile, evaluation, funded and payout PDAs (Anchor's transfer + allocate + assign path), a payout
// address already in use, an owner PDA already above or below its SOL target, an owner USDC account created by a
// stranger first, a profile created by set_identity, a new principal window, every funded status, and every
// checked-arithmetic limit (counters, terms and the payout sequence written directly).
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, MintLayout, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  USDC_MINT, capitalVaultAddress, configPda, eventAuthorityPda, evaluationPda, feeVaultPda, fundedPda, ownerPda, ownerUsdcAddress, payoutPda,
  solTreasuryPda, tierPda, traderProfilePda, vaultAuthorityPda,
} from '@props/sdk';
import { compare, type Env } from './harness.ts';
import { FUNDED, STATUS, le, setStatus, write } from './trading.ts';

/** FundedAccount `terms.trader_share_bps` (u16) and `payout_seq` (u32) byte offsets (checked against the IDL decoder). */
const SHARE_BPS = 86;
const PAYOUT_SEQ = 1525;

/** Rewrites fields of a props_vault account in place: decode, change, encode over the old bytes. */
async function patch(env: Env, name: 'config' | 'evaluation' | 'traderProfile', address: PublicKey, f: (x: any) => void): Promise<void> {
  const acc = env.svm.getAccount(address)!;
  const x = env.vault.decode(name, acc.data) as any;
  f(x);
  const data = Buffer.from(acc.data);
  (await env.vault.program.coder.accounts.encode(name, x)).copy(data);
  env.svm.setAccount(address, { ...acc, data });
}

/** An initialized SPL mint that is not USDC. */
function otherMint(env: Env): PublicKey {
  const mint = Keypair.generate().publicKey;
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  env.svm.setAccount(mint, { lamports: 1_461_600, data, owner: TOKEN_PROGRAM_ID, executable: false });
  return mint;
}

/** A token account of `mint` owned by `owner`, at its ATA address. */
function tokenAccount(env: Env, mint: PublicKey, owner: PublicKey, amount: bigint): PublicKey {
  const address = env.setUsdc(owner, amount, getAssociatedTokenAddressSync(mint, owner, true));
  const acc = env.svm.getAccount(address)!;
  const data = Buffer.from(acc.data);
  mint.toBuffer().copy(data, 0);
  env.svm.setAccount(address, { ...acc, data });
  return address;
}

/** Sets a token account's state byte (0 uninitialized, 1 initialized, 2 frozen). */
function tokenState(env: Env, address: PublicKey, state: number): void {
  const acc = env.svm.getAccount(address)!;
  const data = Buffer.from(acc.data);
  data[108] = state;
  env.svm.setAccount(address, { ...acc, data });
}

await compare(async ({ env: { CONFIG_PARAMS, Env, TIERS, bn, hash32, swapKey, tierParams, usdc }, send, snap, raw }) => {
  const env = new Env();
  await env.setUpVault();
  const v = env.vault;
  const admin = env.admin.publicKey;
  const MAX64 = 2n ** 64n - 1n;
  const [stranger, alice, bob, carol, dave, thief] = [env.wallet(), env.wallet(), env.wallet(), env.wallet(), env.wallet(), env.wallet()];
  /** `ix` with account `i` changed (key or flags). */
  const at = (ix: TransactionInstruction, i: number, f: Partial<AccountMeta>) => raw(ix, (k, d) => [k.map((x, j) => (j === i ? { ...x, ...f } : x)), d]);
  const buy = (trader: Keypair, index: number, tierId = TIERS.t10k.id) => v.buyEvaluation({ trader: trader.publicKey, tierId, index, ...env.reviewed(tierId) });
  const identity = (trader: Keypair) => v.setIdentity({ kycAuthority: env.kyc.publicKey, wallet: trader.publicKey, identityHash: hash32(`passport:${trader.publicKey.toBase58()}`) });
  const result = (evaluation: PublicKey, passed = true) =>
    v.recordEvaluationResult({ riskAuthority: env.risk.publicKey, evaluation, passed, finalEquity: usdc('10900'), tradesRoot: hash32('fills') });
  const pauses = (p: { newEvaluations?: boolean; trading?: boolean }) =>
    v.setPauses({ admin, paused: { newEvaluations: p.newEvaluations ?? false, trading: p.trading ?? false, payouts: false } });
  const accounts = (t: Keypair, evaluation: PublicKey) => {
    const funded = fundedPda(evaluation);
    return [configPda(), traderProfilePda(t.publicKey), evaluation, funded, ownerPda(funded), ownerUsdcAddress(funded), capitalVaultAddress(), solTreasuryPda(), feeVaultPda(), t.publicKey];
  };

  // ---------- buy_evaluation ----------
  const aliceUsdc = env.setUsdc(alice.publicKey, usdc('1000'));
  const strangerUsdc = env.setUsdc(stranger.publicKey, usdc('1000'));
  const mint = otherMint(env);
  const aliceOther = tokenAccount(env, mint, alice.publicKey, usdc('1000'));
  const b = await buy(alice, 0);
  send(env, 'buy short data', raw(b, (k, d) => [k, d.subarray(0, 8 + 2 + 4 + 8 + 3)]), [alice]);
  send(env, 'buy missing accounts', raw(b, (k, d) => [k.slice(0, 11), d]), [alice]);
  send(env, 'buy not signer', at(b, 0, { isSigner: false }), [stranger]);
  send(env, 'buy trader readonly', at(b, 0, { isWritable: false }), [stranger, alice]);
  send(env, 'buy config is a tier', swapKey(b, configPda(), tierPda(2)), [alice]);
  send(env, 'buy config missing', swapKey(b, configPda(), Keypair.generate().publicKey), [alice]);
  send(env, 'buy config readonly', at(b, 1, { isWritable: false }), [alice]);
  send(env, 'buy tier missing', await v.buyEvaluation({ trader: alice.publicKey, tierId: 9, index: 0, feeUsdc: usdc('79'), tierVersion: 1 }), [alice]);
  send(env, 'buy tier is config', swapKey(b, tierPda(1), configPda()), [alice]);
  send(env, 'buy wrong tier', swapKey(b, tierPda(1), tierPda(2)), [alice]);
  send(env, 'buy wrong profile', swapKey(b, traderProfilePda(alice.publicKey), traderProfilePda(stranger.publicKey)), [alice]);
  send(env, 'buy profile readonly', at(b, 3, { isWritable: false }), [alice]);
  send(env, 'buy wrong evaluation', swapKey(b, evaluationPda(alice.publicKey, 0), evaluationPda(alice.publicKey, 1)), [alice]);
  send(env, 'buy evaluation readonly', at(b, 4, { isWritable: false }), [alice]);
  send(env, 'buy usdc of stranger', swapKey(b, aliceUsdc, strangerUsdc), [alice]);
  send(env, 'buy usdc of other mint', swapKey(b, aliceUsdc, aliceOther), [alice]);
  send(env, 'buy usdc is a wallet', at(b, 5, { pubkey: stranger.publicKey }), [alice]);
  send(env, 'buy usdc readonly', at(b, 5, { isWritable: false }), [alice]);
  send(env, 'buy fee vault swapped', swapKey(b, feeVaultPda(), capitalVaultAddress()), [alice]);
  send(env, 'buy fee vault readonly', at(b, 6, { isWritable: false }), [alice]);
  send(env, 'buy other mint', swapKey(swapKey(b, aliceUsdc, aliceOther), USDC_MINT, mint), [alice]);
  send(env, 'buy mint not a mint', swapKey(b, USDC_MINT, strangerUsdc), [alice]);
  send(env, 'buy wrong token program', swapKey(b, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID), [alice]);
  send(env, 'buy wrong system program', swapKey(b, SystemProgram.programId, TOKEN_PROGRAM_ID), [alice]);
  send(env, 'buy wrong event authority', swapKey(b, eventAuthorityPda(), stranger.publicKey), [alice]);
  send(env, 'buy wrong program account', at(b, 11, { pubkey: stranger.publicKey }), [alice]);
  for (const [state, label] of [[0, 'uninitialized'], [2, 'frozen'], [3, 'bad state']] as const) {
    tokenState(env, aliceUsdc, state);
    send(env, `buy usdc ${label}`, b, [alice]);
  }
  tokenState(env, aliceUsdc, 1);
  send(env, 'pause sales', await pauses({ newEvaluations: true }), [env.admin]);
  send(env, 'buy paused', b, [alice]);
  send(env, 'resume sales', await pauses({}), [env.admin]);
  send(env, 'buy disabled tier', await buy(alice, 0, TIERS.t50k.id), [alice]);
  send(env, 'buy wrong index', await buy(alice, 1), [alice]);
  send(env, 'buy stale fee', await v.buyEvaluation({ trader: alice.publicKey, tierId: 1, index: 0, feeUsdc: usdc('78'), tierVersion: 1 }), [alice]);
  send(env, 'buy stale version', await v.buyEvaluation({ trader: alice.publicKey, tierId: 1, index: 0, feeUsdc: usdc('79'), tierVersion: 2 }), [alice]);
  const poor = env.wallet();
  env.setUsdc(poor.publicKey, usdc('78.999999'));
  send(env, 'buy insufficient funds', await buy(poor, 0), [poor]);
  send(env, 'buy', b, [alice]);
  snap(env, 'after buy', [configPda(), traderProfilePda(alice.publicKey), evaluationPda(alice.publicKey, 0), aliceUsdc, feeVaultPda(), alice.publicKey]);
  send(env, 'buy same index', await buy(alice, 0), [alice]);
  send(env, 'buy second', await buy(alice, 1, TIERS.t25k.id), [alice]);
  snap(env, 'after second', [configPda(), traderProfilePda(alice.publicKey), evaluationPda(alice.publicKey, 1)]);

  // Pre-funded profile and evaluation PDAs, below and above the rent-exempt minimum (a transfer below the zero-data
  // minimum, 890,880, would fail); a profile set_identity created.
  env.setUsdc(bob.publicKey, usdc('1000'));
  env.svm.airdrop(traderProfilePda(bob.publicKey), 1_000_000n);
  env.svm.airdrop(evaluationPda(bob.publicKey, 0), 10_000_000n);
  send(env, 'buy prefunded', await buy(bob, 0), [bob]);
  snap(env, 'bob', [traderProfilePda(bob.publicKey), evaluationPda(bob.publicKey, 0), bob.publicKey]);
  env.setUsdc(carol.publicKey, usdc('1000'));
  send(env, 'carol identity', await identity(carol), [env.kyc]);
  send(env, 'buy verified', await buy(carol, 0), [carol]);
  snap(env, 'carol', [traderProfilePda(carol.publicKey), evaluationPda(carol.publicKey, 0)]);

  // Counters at their limits: MathOverflow, nothing charged.
  await patch(env, 'traderProfile', traderProfilePda(carol.publicKey), (p) => { p.evaluationCount = 4294967295; });
  send(env, 'buy count overflow', await buy(carol, 4294967295), [carol]);
  await patch(env, 'traderProfile', traderProfilePda(carol.publicKey), (p) => { p.evaluationCount = 1; });
  const c0 = env.account('config', configPda());
  await patch(env, 'config', configPda(), (c) => { c.feesCollected = bn(2n ** 64n - usdc('79')); });
  send(env, 'buy fees overflow', await buy(carol, 1), [carol]);
  await patch(env, 'config', configPda(), (c) => { c.feesCollected = bn(MAX64 - usdc('79')); c.evaluationsSold = bn(MAX64); });
  send(env, 'buy sold overflow', await buy(carol, 1), [carol]);
  await patch(env, 'config', configPda(), (c) => { c.feesCollected = c0.feesCollected; c.evaluationsSold = c0.evaluationsSold; });
  snap(env, 'after limits', [configPda(), traderProfilePda(carol.publicKey), getAssociatedTokenAddressSync(USDC_MINT, carol.publicKey)]);

  // ---------- activate_funded ----------
  // alice: evaluation 0 (10K) and 1 (25K), both active; not verified.
  const e0 = evaluationPda(alice.publicKey, 0);
  const funded = fundedPda(e0);
  const a = await v.activateFunded({ trader: alice.publicKey, evaluation: e0 });
  send(env, 'activate active evaluation', a, [alice]);
  send(env, 'pass alice', await result(e0), [env.risk]);
  send(env, 'activate unverified', a, [alice]);
  send(env, 'identity alice', await identity(alice), [env.kyc]);
  send(env, 'activate missing accounts', raw(a, (k, d) => [k.slice(0, 15), d]), [alice]);
  send(env, 'activate not signer', at(a, 0, { isSigner: false }), [stranger]);
  send(env, 'activate trader readonly', at(a, 0, { isWritable: false }), [stranger, alice]);
  for (const [i, name] of [[1, 'config'], [2, 'profile'], [3, 'evaluation'], [5, 'owner'], [6, 'owner usdc'], [8, 'capital vault'], [9, 'treasury']] as const) {
    send(env, `activate ${name} readonly`, at(a, i, { isWritable: false }), [alice]);
  }
  send(env, 'activate config is a tier', swapKey(a, configPda(), tierPda(1)), [alice]);
  send(env, 'activate profile missing', swapKey(a, traderProfilePda(alice.publicKey), traderProfilePda(stranger.publicKey)), [alice]);
  send(env, 'activate wrong profile', swapKey(a, traderProfilePda(alice.publicKey), traderProfilePda(carol.publicKey)), [alice]);
  send(env, 'activate evaluation is a profile', swapKey(a, e0, traderProfilePda(carol.publicKey)), [alice]);
  send(env, 'identity thief', await identity(thief), [env.kyc]);
  send(env, 'activate thief', await v.activateFunded({ trader: thief.publicKey, evaluation: e0 }), [thief]);
  send(env, 'activate wrong funded', swapKey(a, funded, fundedPda(evaluationPda(alice.publicKey, 1))), [alice]);
  send(env, 'activate owner not system', swapKey(a, ownerPda(funded), feeVaultPda()), [alice]);
  send(env, 'activate wrong owner', swapKey(a, ownerPda(funded), Keypair.generate().publicKey), [alice]);
  send(env, 'activate wrong owner usdc', swapKey(a, ownerUsdcAddress(funded), getAssociatedTokenAddressSync(USDC_MINT, stranger.publicKey)), [alice]);
  send(env, 'activate wrong vault', swapKey(a, vaultAuthorityPda(), stranger.publicKey), [alice]);
  send(env, 'activate capital vault swapped', swapKey(a, capitalVaultAddress(), feeVaultPda()), [alice]);
  send(env, 'activate capital vault is a wallet', swapKey(a, capitalVaultAddress(), stranger.publicKey), [alice]);
  send(env, 'activate wrong treasury', swapKey(a, solTreasuryPda(), stranger.publicKey), [alice]);
  send(env, 'activate treasury not system', swapKey(a, solTreasuryPda(), feeVaultPda()), [alice]);
  send(env, 'activate other mint', swapKey(swapKey(a, ownerUsdcAddress(funded), getAssociatedTokenAddressSync(mint, ownerPda(funded), true)), USDC_MINT, mint), [alice]);
  send(env, 'activate wrong token program', swapKey(a, TOKEN_PROGRAM_ID, SystemProgram.programId), [alice]);
  send(env, 'activate wrong ata program', swapKey(a, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID), [alice]);
  send(env, 'activate wrong system program', swapKey(a, SystemProgram.programId, TOKEN_PROGRAM_ID), [alice]);
  send(env, 'activate wrong event authority', swapKey(a, eventAuthorityPda(), stranger.publicKey), [alice]);
  send(env, 'activate wrong program account', at(a, 15, { pubkey: stranger.publicKey }), [alice]);
  send(env, 'activate capital vault is the mint', swapKey(a, capitalVaultAddress(), USDC_MINT), [alice]);
  await patch(env, 'evaluation', e0, (e) => { e.trader = stranger.publicKey; });
  send(env, 'activate evaluation of another trader', a, [alice]);
  await patch(env, 'evaluation', e0, (e) => { e.trader = alice.publicKey; });
  send(env, 'pause trading', await pauses({ trading: true }), [env.admin]);
  send(env, 'activate paused', a, [alice]);
  send(env, 'resume trading', await pauses({}), [env.admin]);
  const spare = usdc('100000') - usdc('499.999999');
  send(env, 'withdraw capital', await v.withdrawCapital({ admin, amount: spare }), [env.admin]);
  send(env, 'activate uncovered', a, [alice]);
  send(env, 'deposit capital', await v.depositCapital({ admin, amount: spare }), [env.admin]);
  send(env, 'daily limit below principal', await v.setParams({ admin, params: { ...CONFIG_PARAMS, maxDailyPrincipal: bn(usdc('499.999999')) } }), [env.admin]);
  send(env, 'activate over daily limit', a, [alice]);
  send(env, 'daily limit back', await v.setParams({ admin, params: CONFIG_PARAMS }), [env.admin]);
  const c1 = env.account('config', configPda());
  const now = env.svm.getClock().unixTimestamp;
  const full = bn(usdc('100000'));
  for (const [label, f] of [
    ['window overflow', (c: any) => { c.principalWindowStart = bn(now); c.principalInWindow = bn(MAX64); }],
    ['allocated overflow', (c: any) => { c.allocatedPrincipal = bn(MAX64 - usdc('500') + 1n); }],
    ['activated overflow', (c: any) => { c.fundedActivated = bn(MAX64); }],
    ['active overflow', (c: any) => { c.fundedActive = 4294967295; }],
    // A full window that started a day ago is over (the allocated counter then overflows); a second later it is not.
    ['window ended', (c: any) => { c.principalWindowStart = bn(now - 86_400n); c.principalInWindow = full; c.allocatedPrincipal = bn(MAX64); }],
    ['window full', (c: any) => { c.principalWindowStart = bn(now - 86_399n); c.principalInWindow = full; }],
    ['window starts at i64 max', (c: any) => { c.principalWindowStart = bn(2n ** 63n - 1n); c.principalInWindow = full; }],
  ] as const) {
    await patch(env, 'config', configPda(), f);
    send(env, `activate ${label}`, a, [alice]);
    await patch(env, 'config', configPda(), (c) => Object.assign(c, c1));
  }
  // Principal 0 (a 1 micro-USD tier) and principal beyond u64 (terms written directly).
  send(env, 'tier 4', await v.upsertTier({ admin, id: 4, params: { ...tierParams({ size: '0.000001', fee: '0.000001', enabled: true }) } }), [env.admin]);
  send(env, 'buy tier 4', await buy(alice, 2, 4), [alice]);
  send(env, 'pass tier 4', await result(evaluationPda(alice.publicKey, 2)), [env.risk]);
  send(env, 'activate zero principal', await v.activateFunded({ trader: alice.publicKey, evaluation: evaluationPda(alice.publicKey, 2) }), [alice]);
  const e1 = evaluationPda(alice.publicKey, 1);
  send(env, 'pass alice 25k', await result(e1), [env.risk]);
  await patch(env, 'evaluation', e1, (e) => { e.terms.sizeUsd = bn(MAX64); e.terms.maxDrawdownBps = 65535; });
  send(env, 'activate principal overflow', await v.activateFunded({ trader: alice.publicKey, evaluation: e1 }), [alice]);
  snap(env, 'before activate', accounts(alice, e0));
  send(env, 'activate', a, [alice]);
  snap(env, 'after activate', accounts(alice, e0));
  send(env, 'activate again', a, [alice]);
  send(env, 'activate second', await v.activateFunded({ trader: alice.publicKey, evaluation: e1 }), [alice]);
  send(env, 'result on funded evaluation', await result(e0), [env.risk]);

  // bob: owner PDA already above its SOL target (no top-up), failed evaluation first.
  const eb = evaluationPda(bob.publicKey, 0);
  send(env, 'identity bob', await identity(bob), [env.kyc]);
  send(env, 'fail bob', await result(eb, false), [env.risk]);
  send(env, 'activate failed evaluation', await v.activateFunded({ trader: bob.publicKey, evaluation: eb }), [bob]);
  send(env, 'bob buys again', await buy(bob, 1), [bob]);
  const eb1 = evaluationPda(bob.publicKey, 1);
  send(env, 'pass bob', await result(eb1), [env.risk]);
  env.svm.airdrop(ownerPda(fundedPda(eb1)), BigInt(LAMPORTS_PER_SOL));
  send(env, 'activate owner above target', await v.activateFunded({ trader: bob.publicKey, evaluation: eb1 }), [bob]);
  snap(env, 'bob activated', accounts(bob, eb1));

  // carol: pre-funded funded PDA, owner below target, owner USDC account created by a stranger, a new principal window.
  const ec = evaluationPda(carol.publicKey, 0);
  const fc = fundedPda(ec);
  send(env, 'pass carol', await result(ec), [env.risk]);
  env.svm.airdrop(fc, 1_000_000n);
  env.svm.airdrop(ownerPda(fc), 100_000_000n);
  send(env, 'grief owner usdc', createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, ownerUsdcAddress(fc), ownerPda(fc), USDC_MINT), [stranger]);
  const clock = env.svm.getClock();
  clock.unixTimestamp += 86_400n;
  env.svm.setClock(clock);
  send(env, 'activate prefunded', await v.activateFunded({ trader: carol.publicKey, evaluation: ec }), [carol]);
  snap(env, 'carol activated', accounts(carol, ec));

  // dave: the whole chain on a verified profile, 25K tier; lamports already sit at the owner USDC address.
  env.setUsdc(dave.publicKey, usdc('1000'));
  send(env, 'identity dave', await identity(dave), [env.kyc]);
  send(env, 'dave buys', await buy(dave, 0, TIERS.t25k.id), [dave]);
  send(env, 'pass dave', await result(evaluationPda(dave.publicKey, 0)), [env.risk]);
  env.svm.airdrop(ownerUsdcAddress(fundedPda(evaluationPda(dave.publicKey, 0))), 1_000_000n);
  send(env, 'activate dave', await v.activateFunded({ trader: dave.publicKey, evaluation: evaluationPda(dave.publicKey, 0) }), [dave]);
  snap(env, 'final', [...accounts(dave, evaluationPda(dave.publicKey, 0)), tierPda(4), evaluationPda(alice.publicKey, 2), e1]);

  // ---------- request_payout ----------
  // dave: 25K tier, principal 1,250, flat. Profit = owner USDC above the principal, 80 % of it to the trader.
  const fd = fundedPda(evaluationPda(dave.publicKey, 0));
  const dOwner = ownerPda(fd);
  const dOwnerUsdc = ownerUsdcAddress(fd);
  const payouts = (paused: boolean) => v.setPauses({ admin, paused: { newEvaluations: false, trading: false, payouts: paused } });
  const request = (t: Keypair, f: PublicKey, seq = env.account('fundedAccount', f).payoutSeq) => v.requestPayout({ trader: t.publicKey, funded: f, payoutSeq: seq });
  env.setUsdcBalance(dOwnerUsdc, usdc('1650')); // profit 400: trader 320, vault 80
  const rq = await request(dave, fd);
  send(env, 'request missing accounts', raw(rq, (k, d) => [k.slice(0, 9), d]), [dave]);
  send(env, 'request not signer', at(rq, 0, { isSigner: false }), [stranger]);
  send(env, 'request trader readonly', at(rq, 0, { isWritable: false }), [stranger, dave]);
  send(env, 'request config is a tier', swapKey(rq, configPda(), tierPda(1)), [dave]);
  send(env, 'request config missing', swapKey(rq, configPda(), Keypair.generate().publicKey), [dave]);
  const configCopy = Keypair.generate().publicKey;
  env.svm.setAccount(configCopy, { ...env.svm.getAccount(configPda())! });
  send(env, 'request config copy', swapKey(rq, configPda(), configCopy), [dave]);
  send(env, 'request funded is a profile', swapKey(rq, fd, traderProfilePda(dave.publicKey)), [dave]);
  const fundedCopy = Keypair.generate().publicKey;
  env.svm.setAccount(fundedCopy, { ...env.svm.getAccount(fd)! });
  send(env, 'request funded copy', swapKey(rq, fd, fundedCopy), [dave]);
  send(env, 'request funded of another trader', swapKey(rq, fd, funded), [dave]);
  send(env, 'request funded readonly', at(rq, 2, { isWritable: false }), [dave]);
  send(env, 'request owner not system', swapKey(rq, dOwner, feeVaultPda()), [dave]);
  send(env, 'request owner of another account', swapKey(rq, dOwner, ownerPda(funded)), [dave]);
  send(env, 'request owner usdc of a stranger', swapKey(rq, dOwnerUsdc, strangerUsdc), [dave]);
  send(env, 'request owner usdc not the ata', swapKey(rq, dOwnerUsdc, env.setUsdc(dOwner, usdc('1650'), Keypair.generate().publicKey)), [dave]);
  send(env, 'request owner usdc is a wallet', swapKey(rq, dOwnerUsdc, stranger.publicKey), [dave]);
  const dOwnerOther = tokenAccount(env, mint, dOwner, usdc('1650'));
  send(env, 'request owner usdc of another mint', swapKey(rq, dOwnerUsdc, dOwnerOther), [dave]);
  send(env, 'request other mint', swapKey(swapKey(rq, dOwnerUsdc, dOwnerOther), USDC_MINT, mint), [dave]);
  send(env, 'request mint not a mint', swapKey(rq, USDC_MINT, strangerUsdc), [dave]);
  send(env, 'request wrong payout', swapKey(rq, payoutPda(fd, 0), payoutPda(fd, 1)), [dave]);
  send(env, 'request payout readonly', at(rq, 6, { isWritable: false }), [dave]);
  send(env, 'request wrong system program', swapKey(rq, SystemProgram.programId, TOKEN_PROGRAM_ID), [dave]);
  send(env, 'request wrong event authority', swapKey(rq, eventAuthorityPda(), stranger.publicKey), [dave]);
  send(env, 'request by a stranger', await request(stranger, fd), [stranger]);
  send(env, 'request by another trader', await request(alice, fd), [alice]);
  send(env, 'pause payouts', await payouts(true), [env.admin]);
  send(env, 'request paused', rq, [dave]);
  send(env, 'resume payouts', await payouts(false), [env.admin]);
  for (const [name, status] of [['restricted', STATUS.restricted], ['payout pending', STATUS.payoutPending], ['breached', STATUS.breached], ['closed', STATUS.closed]] as const) {
    setStatus(env, fd, status);
    send(env, `request ${name}`, rq, [dave]);
  }
  setStatus(env, fd, STATUS.active);
  const used = new Uint8Array(32).fill(7);
  write(env, fd, FUNDED.slot(7), used);
  send(env, 'request with a used slot', rq, [dave]);
  write(env, fd, FUNDED.slot(7), new Uint8Array(32));
  write(env, fd, FUNDED.order(7), used);
  send(env, 'request with a tracked order', rq, [dave]);
  write(env, fd, FUNDED.order(7), new Uint8Array(32));
  env.setUsdcBalance(dOwnerUsdc, usdc('1250'));
  send(env, 'request no profit', rq, [dave]);
  env.setUsdcBalance(dOwnerUsdc, usdc('1000'));
  send(env, 'request at a loss', rq, [dave]);
  env.setUsdcBalance(dOwnerUsdc, usdc('1312.499999')); // trader share 49.999999 < 50
  send(env, 'request below min payout', rq, [dave]);
  // A trader share written above 100 %: the vault share underflows, or the trader share leaves u64.
  write(env, fd, SHARE_BPS, le(65_535n, 2));
  env.setUsdcBalance(dOwnerUsdc, usdc('1650'));
  send(env, 'request share above 100 %', rq, [dave]);
  env.setUsdcBalance(dOwnerUsdc, MAX64);
  send(env, 'request share beyond u64', rq, [dave]);
  write(env, fd, SHARE_BPS, le(8000n, 2));
  env.setUsdcBalance(dOwnerUsdc, usdc('1650'));
  write(env, fd, PAYOUT_SEQ, le(0xffff_ffffn, 4));
  send(env, 'request sequence overflow', await request(dave, fd, 4294967295), [dave]);
  write(env, fd, PAYOUT_SEQ, le(0n, 4));
  env.svm.airdrop(payoutPda(fd, 0), 1_000_000n); // pre-funded below rent: Anchor's transfer + allocate + assign
  snap(env, 'before request', [fd, payoutPda(fd, 0), dOwner, dOwnerUsdc, dave.publicKey]);
  send(env, 'request', rq, [dave]);
  snap(env, 'after request', [fd, payoutPda(fd, 0), dave.publicKey]);
  send(env, 'request again', rq, [dave]);
  send(env, 'request while pending', await request(dave, fd), [dave]);

  // ---------- cancel_payout ----------
  const dp = payoutPda(fd, 0);
  const cancel = (t: Keypair, payout = dp) => v.cancelPayout({ trader: t.publicKey, funded: fd, payout });
  const cp = await cancel(dave);
  env.setUsdcBalance(ownerUsdcAddress(funded), usdc('800'));
  send(env, 'alice requests', await request(alice, funded), [alice]);
  send(env, 'cancel payout missing accounts', raw(cp, (k, d) => [k.slice(0, 4), d]), [dave]);
  send(env, 'cancel payout not signer', at(cp, 0, { isSigner: false }), [stranger]);
  send(env, 'cancel payout by a stranger', await cancel(stranger), [stranger]);
  send(env, 'cancel payout by another trader', await cancel(alice), [alice]);
  send(env, 'cancel payout by the risk authority', await cancel(env.risk), [env.risk]);
  send(env, 'cancel payout funded is the payout', swapKey(cp, fd, dp), [dave]);
  send(env, 'cancel payout payout is the funded', swapKey(cp, dp, fd), [dave]);
  send(env, 'cancel payout funded missing', swapKey(cp, fd, Keypair.generate().publicKey), [dave]);
  send(env, 'cancel payout funded copy', swapKey(cp, fd, fundedCopy), [dave]);
  send(env, 'cancel payout funded readonly', at(cp, 1, { isWritable: false }), [dave]);
  send(env, 'cancel payout of another account', swapKey(cp, dp, payoutPda(funded, 0)), [dave]);
  const payoutCopy = Keypair.generate().publicKey;
  env.svm.setAccount(payoutCopy, { ...env.svm.getAccount(dp)! });
  send(env, 'cancel payout payout copy', swapKey(cp, dp, payoutCopy), [dave]);
  send(env, 'cancel payout payout readonly', at(cp, 2, { isWritable: false }), [dave]);
  write(env, dp, 8, funded.toBytes());
  send(env, 'cancel payout naming another account', cp, [dave]);
  write(env, dp, 8, fd.toBytes());
  send(env, 'cancel payout wrong event authority', swapKey(cp, eventAuthorityPda(), stranger.publicKey), [dave]);
  setStatus(env, fd, STATUS.active);
  send(env, 'cancel payout account not pending', cp, [dave]);
  setStatus(env, fd, STATUS.payoutPending);
  send(env, 'pause payouts again', await payouts(true), [env.admin]);
  send(env, 'cancel payout', cp, [dave]); // pauses never block a cancellation
  send(env, 'resume payouts again', await payouts(false), [env.admin]);
  snap(env, 'after cancel payout', [fd, dp, dave.publicKey]);
  send(env, 'cancel payout again', cp, [dave]);
  // The request's address reused (sequence written back): the system program refuses it.
  write(env, fd, PAYOUT_SEQ, le(0n, 4));
  send(env, 'request over a used payout address', rq, [dave]);
  write(env, fd, PAYOUT_SEQ, le(1n, 4));
  env.svm.airdrop(payoutPda(fd, 1), 5_000_000n); // pre-funded above rent: nothing to transfer
  send(env, 'request prefunded above rent', await request(dave, fd), [dave]);
  // The event self-CPI needs the program among the instruction's accounts (runtime MissingAccount otherwise).
  send(env, 'cancel payout with a wrong program account', at(await cancel(dave, payoutPda(fd, 1)), 4, { pubkey: stranger.publicKey }), [dave]);
  send(env, 'cancel payout with trailing data', raw(await cancel(dave, payoutPda(fd, 1)), (k, d) => [k, Buffer.concat([d, Buffer.from([1, 2, 3])])]), [dave]);
  send(env, 'request third', await request(dave, fd), [dave]);
  snap(env, 'payouts', [configPda(), fd, dp, payoutPda(fd, 1), payoutPda(fd, 2), funded, payoutPda(funded, 0), dOwnerUsdc]);
});
