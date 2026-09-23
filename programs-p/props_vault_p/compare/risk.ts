// The risk.rs instructions (set_identity, record_evaluation_result, approve_payout, reject_payout, restrict,
// mark_breached, close_funded), happy paths and refusals, compared byte for byte (see harness.ts). Also covers what the
// suite does not: pre-funded profile and identity-lock PDAs (Anchor's transfer + allocate + assign path), a profile
// created by a purchase, the default wallet, an unset KYC authority, an empty and a full risk-authority list, accounts
// copied to another address, malformed data and account lists, every account substitution and read-only flag, every
// funded and payout status, the flatness re-check against GMTrade Position accounts in every state (flat, live, another
// owner's, absent, truncated, not a Position, collateral beyond u64, another bump), the trader's USDC account missing,
// pre-funded or in place, zero amounts that move nothing, an emptied owner PDA, and every checked-arithmetic limit
// (config and account totals written directly).
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  USDC_MINT, capitalVaultAddress, configPda, eventAuthorityPda, evaluationPda, feeVaultPda, gmOrderEscrow, gmPositionPda, identityLockPda,
  payoutPda, solTreasuryPda, tierPda, traderProfilePda,
} from '@props/sdk';
import { compare, type Env } from './harness.ts';
import { FUNDED, STATUS, type Funded, le, otherMint, setStatus, tokenAccount, write } from './trading.ts';

/** FundedAccount `terms.trader_share_bps` (u16) and `payouts_paid` (u64), PayoutRequest `funded` and `trader_amount`
 * byte offsets (checked against the IDL decoder). */
const SHARE_BPS = 86;
const PAYOUTS_PAID = 1517;
const PAYOUT_FUNDED = 8;
const PAYOUT_TRADER_AMOUNT = 92;

/** Rewrites Config fields in place: decode, change, encode over the old bytes. */
async function patchConfig(env: Env, f: (c: any) => void): Promise<void> {
  const acc = env.svm.getAccount(configPda())!;
  const c = env.vault.decode('config', acc.data) as any;
  f(c);
  const data = Buffer.from(acc.data);
  (await env.vault.program.coder.accounts.encode('config', c)).copy(data);
  env.svm.setAccount(configPda(), { ...acc, data });
}

await compare(async ({ env: { Env, MAINNET_POSITIONS, MARKETS, TIERS, USD, bn, hash32, swapKey, usdc }, send, snap, raw }) => {
  const env = new Env();
  await env.setUpVault();
  const v = env.vault;
  const [admin, kyc, risk] = [env.admin.publicKey, env.kyc.publicKey, env.risk.publicKey];
  const [stranger, alice, bob, carol, dave] = [env.wallet(), env.wallet(), env.wallet(), env.wallet(), env.wallet()];
  /** `ix` with account `i` changed (key or flags). */
  const at = (ix: TransactionInstruction, i: number, f: Partial<AccountMeta>) => raw(ix, (k, d) => [k.map((x, j) => (j === i ? { ...x, ...f } : x)), d]);
  const identity = (wallet: PublicKey, identityHash: Uint8Array, kycAuthority = kyc) => v.setIdentity({ kycAuthority, wallet, identityHash });

  // ---------- set_identity ----------
  const aliceId = hash32('passport:alice');
  const id = await identity(alice.publicKey, aliceId);
  send(env, 'identity short data', raw(id, (k, d) => [k, d.subarray(0, 8 + 32 + 31)]), [env.kyc]);
  send(env, 'identity missing accounts', raw(id, (k, d) => [k.slice(0, 6), d]), [env.kyc]);
  send(env, 'identity kyc not signer', at(id, 0, { isSigner: false }), [stranger]);
  send(env, 'identity kyc readonly', at(id, 0, { isWritable: false }), [stranger, env.kyc]);
  send(env, 'identity by risk', await identity(alice.publicKey, aliceId, risk), [env.risk]);
  send(env, 'identity by stranger', await identity(alice.publicKey, aliceId, stranger.publicKey), [stranger]);
  send(env, 'identity zero hash', await identity(alice.publicKey, new Uint8Array(32)), [env.kyc]);
  send(env, 'identity wrong profile', swapKey(id, traderProfilePda(alice.publicKey), traderProfilePda(bob.publicKey)), [env.kyc]);
  send(env, 'identity profile is config', swapKey(id, traderProfilePda(alice.publicKey), configPda()), [env.kyc]);
  send(env, 'identity wrong lock', swapKey(id, identityLockPda(aliceId), identityLockPda(hash32('passport:other'))), [env.kyc]);
  send(env, 'identity config is a tier', swapKey(id, configPda(), tierPda(1)), [env.kyc]);
  send(env, 'identity config missing', swapKey(id, configPda(), Keypair.generate().publicKey), [env.kyc]);
  send(env, 'identity config not ours', swapKey(id, configPda(), USDC_MINT), [env.kyc]);
  send(env, 'identity wrong system program', swapKey(id, SystemProgram.programId, TOKEN_PROGRAM_ID), [env.kyc]);
  send(env, 'identity wrong event authority', swapKey(id, eventAuthorityPda(), stranger.publicKey), [env.kyc]);
  send(env, 'identity wrong program account', at(id, 6, { pubkey: stranger.publicKey }), [env.kyc]);
  send(env, 'identity', id, [env.kyc]);
  snap(env, 'after identity', [traderProfilePda(alice.publicKey), identityLockPda(aliceId), kyc]);
  send(env, 'identity second wallet', await identity(bob.publicKey, aliceId), [env.kyc]);
  send(env, 'identity again', await identity(alice.publicKey, hash32('passport:alice2')), [env.kyc]);

  // A profile the trader's purchase created keeps its wallet and bump.
  env.setUsdc(carol.publicKey, usdc('1000'));
  send(env, 'carol buys', await v.buyEvaluation({ trader: carol.publicKey, tierId: TIERS.t10k.id, index: 0, ...env.reviewed(TIERS.t10k.id) }), [carol]);
  send(env, 'identity after purchase', await identity(carol.publicKey, hash32('passport:carol')), [env.kyc]);
  snap(env, 'carol', [traderProfilePda(carol.publicKey), identityLockPda(hash32('passport:carol'))]);

  // Pre-funded PDAs, below and above the rent-exempt minimum (a transfer below the zero-data minimum, 890,880, would fail).
  const daveId = hash32('passport:dave');
  env.svm.airdrop(traderProfilePda(dave.publicKey), 1_000_000n);
  env.svm.airdrop(identityLockPda(daveId), 5_000_000n);
  send(env, 'identity prefunded', await identity(dave.publicKey, daveId), [env.kyc]);
  snap(env, 'dave', [traderProfilePda(dave.publicKey), identityLockPda(daveId), kyc]);
  send(env, 'identity default wallet', await identity(PublicKey.default, hash32('passport:nobody')), [env.kyc]);
  snap(env, 'default wallet', [traderProfilePda(PublicKey.default), identityLockPda(hash32('passport:nobody'))]);

  // ---------- record_evaluation_result ----------
  const evaluation = evaluationPda(carol.publicKey, 0);
  const result = (riskAuthority = risk, passed = false) =>
    v.recordEvaluationResult({ riskAuthority, evaluation, passed, finalEquity: usdc('9480'), tradesRoot: hash32('fills') });
  const r = await result();
  send(env, 'result short data', raw(r, (k, d) => [k, d.subarray(0, 8 + 1 + 8 + 31)]), [env.risk]);
  send(env, 'result bad bool', raw(r, (k, d) => { d[8] = 2; return [k, d]; }), [env.risk]);
  send(env, 'result missing accounts', raw(r, (k, d) => [k.slice(0, 4), d]), [env.risk]);
  send(env, 'result not signer', at(r, 0, { isSigner: false }), [stranger]);
  send(env, 'result by stranger', await result(stranger.publicKey), [stranger]);
  send(env, 'result by kyc', await result(kyc), [env.kyc]);
  send(env, 'result config is a tier', swapKey(r, configPda(), tierPda(1)), [env.risk]);
  send(env, 'result evaluation is a profile', swapKey(r, evaluation, traderProfilePda(carol.publicKey)), [env.risk]);
  send(env, 'result evaluation missing', swapKey(r, evaluation, evaluationPda(carol.publicKey, 5)), [env.risk]);
  send(env, 'result evaluation readonly', at(r, 2, { isWritable: false }), [env.risk]);
  const copy = Keypair.generate().publicKey;
  env.svm.setAccount(copy, { ...env.svm.getAccount(evaluation)! });
  send(env, 'result evaluation copy', swapKey(r, evaluation, copy), [env.risk]);
  send(env, 'result wrong event authority', swapKey(r, eventAuthorityPda(), stranger.publicKey), [env.risk]);
  send(env, 'result wrong program account', at(r, 4, { pubkey: stranger.publicKey }), [env.risk]);
  send(env, 'result fail', r, [env.risk]);
  snap(env, 'after fail', [evaluation, copy]);
  send(env, 'result again', await result(risk, true), [env.risk]);

  // No KYC authority and no risk authority: everyone is refused. Then four risk authorities, the signer last.
  send(env, 'authorities none', await v.setAuthorities({ admin, riskAuthorities: [], kycAuthority: PublicKey.default }), [env.admin]);
  send(env, 'identity without kyc', await identity(bob.publicKey, hash32('passport:bob')), [env.kyc]);
  send(env, 'carol buys again', await v.buyEvaluation({ trader: carol.publicKey, tierId: TIERS.t25k.id, index: 1, ...env.reviewed(TIERS.t25k.id) }), [carol]);
  const second = evaluationPda(carol.publicKey, 1);
  const pass = await v.recordEvaluationResult({ riskAuthority: risk, evaluation: second, passed: true, finalEquity: -usdc('12.5'), tradesRoot: hash32('fills 2') });
  send(env, 'result without risk authorities', pass, [env.risk]);
  const others = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
  send(env, 'authorities four', await v.setAuthorities({ admin, riskAuthorities: [...others, risk], kycAuthority: kyc }), [env.admin]);
  send(env, 'result pass', pass, [env.risk]);
  send(env, 'identity bob', await identity(bob.publicKey, hash32('passport:bob')), [env.kyc]);
  snap(env, 'final', [configPda(), evaluation, second, traderProfilePda(bob.publicKey), traderProfilePda(carol.publicKey), identityLockPda(hash32('passport:bob'))]);

  // ---------- approve_payout ----------
  const MAX64 = 2n ** 64n - 1n;
  const ref = (x: Funded) => env.funded(x.funded);
  const strangerUsdc = env.setUsdc(stranger.publicKey, usdc('1000'));
  const mint = otherMint(env);
  const used = new Uint8Array(32).fill(7);
  const payouts = (paused: boolean) => v.setPauses({ admin, paused: { newEvaluations: false, trading: false, payouts: paused } });
  /** A $1,000 SOL long opened, filled and closed at `pnl` USDC: flat, its flat Position account kept, owner USDC 500 + pnl. */
  const roundTrip = async (x: Funded, label: string, pnl: string) => {
    const o = await v.openPosition({
      trader: x.trader.publicKey, funded: ref(x), marketToken: MARKETS.SOL.token, isLong: true, orderType: 'market', collateral: usdc('100'),
      sizeDeltaUsd: 1000n * USD, acceptablePrice: 10n ** 30n,
    });
    send(env, `${label} opens`, o.instruction, [x.trader]);
    const position = gmPositionPda(x.owner, MARKETS.SOL.token, true);
    env.executeOrder(o.order, gmOrderEscrow(o.order));
    env.setPosition(position, 1000n * USD, usdc('99.9'));
    send(env, `${label} syncs the fill`, await v.sync({ funded: ref(x) }), [x.trader]);
    env.setPosition(position, 0n, 0n);
    env.setUsdcBalance(x.ownerUsdc, usdc('500') + usdc(pnl));
    send(env, `${label} syncs the close`, await v.sync({ funded: ref(x) }), [x.trader]);
    return position;
  };
  const request = async (x: Funded, label: string) => {
    const seq = env.account('fundedAccount', x.funded).payoutSeq;
    send(env, label, await v.requestPayout({ trader: x.trader.publicKey, funded: x.funded, payoutSeq: seq }), [x.trader]);
    return payoutPda(x.funded, seq);
  };
  const approve = (x: Funded, payout: PublicKey, positions: PublicKey[] = [], riskAuthority = risk) =>
    v.approvePayout({ riskAuthority, funded: ref(x), payout, positions });
  const f = await env.activeFunded();
  const g = await env.activeFunded();
  const fPosition = await roundTrip(f, 'f', '300'); // profit 300: trader 240, vault 60
  const gPosition = await roundTrip(g, 'g', '400'); // profit 400: trader 320, vault 80
  const fp = await request(f, 'f requests');
  const gp = await request(g, 'g requests');
  const fTraderUsdc = getAssociatedTokenAddressSync(USDC_MINT, f.trader.publicKey);
  const ap = await approve(f, fp, [fPosition]);
  send(env, 'approve missing accounts', raw(ap, (k, d) => [k.slice(0, 15), d]), [env.risk]);
  send(env, 'approve not signer', at(ap, 0, { isSigner: false }), [stranger]);
  send(env, 'approve by a stranger', await approve(f, fp, [fPosition], stranger.publicKey), [stranger]);
  send(env, 'approve by the kyc authority', await approve(f, fp, [fPosition], kyc), [env.kyc]);
  send(env, 'approve by the trader', await approve(f, fp, [fPosition], f.trader.publicKey), [f.trader]);
  send(env, 'approve config is a tier', swapKey(ap, configPda(), tierPda(1)), [env.risk]);
  const configCopy = Keypair.generate().publicKey;
  env.svm.setAccount(configCopy, { ...env.svm.getAccount(configPda())! });
  send(env, 'approve config copy', swapKey(ap, configPda(), configCopy), [env.risk]);
  send(env, 'approve config readonly', at(ap, 1, { isWritable: false }), [env.risk]);
  send(env, 'approve funded is a payout', swapKey(ap, f.funded, fp), [env.risk]);
  const fundedCopy = Keypair.generate().publicKey;
  env.svm.setAccount(fundedCopy, { ...env.svm.getAccount(f.funded)! });
  send(env, 'approve funded copy', swapKey(ap, f.funded, fundedCopy), [env.risk]);
  send(env, 'approve funded readonly', at(ap, 2, { isWritable: false }), [env.risk]);
  send(env, 'approve payout of another account', swapKey(ap, fp, gp), [env.risk]);
  send(env, 'approve payout missing', swapKey(ap, fp, payoutPda(f.funded, 1)), [env.risk]);
  const payoutCopy = Keypair.generate().publicKey;
  env.svm.setAccount(payoutCopy, { ...env.svm.getAccount(fp)! });
  send(env, 'approve payout copy', swapKey(ap, fp, payoutCopy), [env.risk]);
  send(env, 'approve payout readonly', at(ap, 3, { isWritable: false }), [env.risk]);
  write(env, fp, PAYOUT_FUNDED, g.funded.toBytes());
  send(env, 'approve payout naming another account', ap, [env.risk]);
  write(env, fp, PAYOUT_FUNDED, f.funded.toBytes());
  send(env, 'approve owner not system', swapKey(ap, f.owner, feeVaultPda()), [env.risk]);
  send(env, 'approve owner of another account', swapKey(ap, f.owner, g.owner), [env.risk]);
  send(env, 'approve owner readonly', at(ap, 4, { isWritable: false }), [env.risk]);
  send(env, 'approve owner usdc of a stranger', swapKey(ap, f.ownerUsdc, strangerUsdc), [env.risk]);
  const notAta = env.setUsdc(f.owner, usdc('800'), Keypair.generate().publicKey);
  send(env, 'approve owner usdc not the ata', swapKey(ap, f.ownerUsdc, notAta), [env.risk]);
  send(env, 'approve owner usdc is a wallet', swapKey(ap, f.ownerUsdc, stranger.publicKey), [env.risk]);
  send(env, 'approve owner usdc readonly', at(ap, 5, { isWritable: false }), [env.risk]);
  const fOwnerOther = tokenAccount(env, mint, f.owner, usdc('800'));
  send(env, 'approve owner usdc of another mint', swapKey(ap, f.ownerUsdc, fOwnerOther), [env.risk]);
  send(env, 'approve other mint', swapKey(swapKey(ap, f.ownerUsdc, fOwnerOther), USDC_MINT, mint), [env.risk]);
  send(env, 'approve mint not a mint', swapKey(ap, USDC_MINT, strangerUsdc), [env.risk]);
  send(env, 'approve another trader', swapKey(ap, f.trader.publicKey, stranger.publicKey), [env.risk]);
  send(env, 'approve trader usdc of a stranger', swapKey(ap, fTraderUsdc, strangerUsdc), [env.risk]);
  send(env, 'approve trader usdc readonly', at(ap, 7, { isWritable: false }), [env.risk]);
  send(env, 'approve capital vault swapped', swapKey(ap, capitalVaultAddress(), feeVaultPda()), [env.risk]);
  send(env, 'approve capital vault is a wallet', swapKey(ap, capitalVaultAddress(), stranger.publicKey), [env.risk]);
  send(env, 'approve capital vault readonly', at(ap, 8, { isWritable: false }), [env.risk]);
  send(env, 'approve wrong treasury', swapKey(ap, solTreasuryPda(), stranger.publicKey), [env.risk]);
  send(env, 'approve treasury not system', swapKey(ap, solTreasuryPda(), feeVaultPda()), [env.risk]);
  send(env, 'approve treasury readonly', at(ap, 9, { isWritable: false }), [env.risk]);
  send(env, 'approve wrong token program', swapKey(ap, TOKEN_PROGRAM_ID, SystemProgram.programId), [env.risk]);
  send(env, 'approve wrong ata program', swapKey(ap, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID), [env.risk]);
  send(env, 'approve wrong system program', swapKey(ap, SystemProgram.programId, TOKEN_PROGRAM_ID), [env.risk]);
  send(env, 'approve wrong event authority', swapKey(ap, eventAuthorityPda(), stranger.publicKey), [env.risk]);
  send(env, 'pause payouts', await payouts(true), [env.admin]);
  send(env, 'approve paused', ap, [env.risk]);
  send(env, 'resume payouts', await payouts(false), [env.admin]);
  setStatus(env, f.funded, STATUS.active);
  send(env, 'approve account not payout pending', ap, [env.risk]);
  setStatus(env, f.funded, STATUS.payoutPending);
  write(env, f.funded, FUNDED.slot(7), used);
  send(env, 'approve with a used slot', ap, [env.risk]);
  write(env, f.funded, FUNDED.slot(7), new Uint8Array(32));
  write(env, f.funded, FUNDED.order(7), used);
  send(env, 'approve with a tracked order', ap, [env.risk]);
  write(env, f.funded, FUNDED.order(7), new Uint8Array(32));
  env.setPosition(fPosition, 100n * USD, usdc('10'));
  send(env, 'approve with a live position', ap, [env.risk]);
  env.setPosition(fPosition, 0n, 0n);
  send(env, 'approve foreign position', await approve(f, fp, [fPosition, MAINNET_POSITIONS.flat]), [env.risk]);
  send(env, 'approve position of another owner', await approve(f, fp, [gPosition]), [env.risk]);
  send(env, 'approve absent position', await approve(f, fp, [gmPositionPda(f.owner, MARKETS.BTC.token, true)]), [env.risk]);
  send(env, 'approve position not a gmtrade account', await approve(f, fp, [f.ownerUsdc]), [env.risk]);
  const position = env.svm.getAccount(fPosition)!;
  env.svm.setAccount(fPosition, { ...position, data: position.data.slice(0, 679) });
  send(env, 'approve position truncated', ap, [env.risk]);
  env.svm.setAccount(fPosition, position);
  write(env, fPosition, 0, new Uint8Array(8));
  send(env, 'approve position not a position', ap, [env.risk]);
  env.svm.setAccount(fPosition, position);
  env.setPosition(fPosition, 0n, 2n ** 64n);
  send(env, 'approve position collateral beyond u64', ap, [env.risk]);
  env.svm.setAccount(fPosition, position);
  write(env, fPosition, 9, [position.data[9]! - 1]);
  send(env, 'approve position with another bump', ap, [env.risk]);
  env.svm.setAccount(fPosition, position);
  env.setUsdcBalance(f.ownerUsdc, usdc('799.999999'));
  send(env, 'approve balance dropped', ap, [env.risk]);
  env.setUsdcBalance(f.ownerUsdc, usdc('800'));
  // The trader's USDC account is missing and the treasury cannot pay its rent.
  env.remove(fTraderUsdc);
  const treasury = env.svm.getAccount(solTreasuryPda())!;
  env.svm.setAccount(solTreasuryPda(), { ...treasury, lamports: 1_000_000 });
  send(env, 'approve treasury short', ap, [env.risk]);
  env.svm.setAccount(solTreasuryPda(), treasury);
  const paying = [configPda(), f.funded, fp, f.owner, f.ownerUsdc, fTraderUsdc, capitalVaultAddress(), solTreasuryPda()];
  snap(env, 'before approve', paying);
  send(env, 'approve', ap, [env.risk]); // creates the trader's USDC account, paid by the treasury
  snap(env, 'after approve', paying);
  send(env, 'approve again', ap, [env.risk]);

  // ---------- reject_payout ----------
  const reject = (riskAuthority = risk, payout = gp) => v.rejectPayout({ riskAuthority, funded: g.funded, payout, reasonCode: 65_535 });
  const rj = await reject();
  send(env, 'reject short data', raw(rj, (k, d) => [k, d.subarray(0, 9)]), [env.risk]);
  send(env, 'reject missing accounts', raw(rj, (k, d) => [k.slice(0, 5), d]), [env.risk]);
  send(env, 'reject not signer', at(rj, 0, { isSigner: false }), [stranger]);
  send(env, 'reject by a stranger', await reject(stranger.publicKey), [stranger]);
  send(env, 'reject by the trader', await reject(g.trader.publicKey), [g.trader]);
  send(env, 'reject config is a tier', swapKey(rj, configPda(), tierPda(1)), [env.risk]);
  send(env, 'reject config copy', swapKey(rj, configPda(), configCopy), [env.risk]);
  send(env, 'reject funded is a payout', swapKey(rj, g.funded, gp), [env.risk]);
  send(env, 'reject funded copy', swapKey(rj, g.funded, fundedCopy), [env.risk]);
  send(env, 'reject funded readonly', at(rj, 2, { isWritable: false }), [env.risk]);
  send(env, 'reject payout of another account', swapKey(rj, gp, fp), [env.risk]);
  send(env, 'reject payout copy', swapKey(rj, gp, payoutCopy), [env.risk]);
  send(env, 'reject payout readonly', at(rj, 3, { isWritable: false }), [env.risk]);
  write(env, gp, PAYOUT_FUNDED, f.funded.toBytes());
  send(env, 'reject payout naming another account', rj, [env.risk]);
  write(env, gp, PAYOUT_FUNDED, g.funded.toBytes());
  send(env, 'reject wrong event authority', swapKey(rj, eventAuthorityPda(), stranger.publicKey), [env.risk]);
  send(env, 'reject a paid payout', await v.rejectPayout({ riskAuthority: risk, funded: f.funded, payout: fp, reasonCode: 1 }), [env.risk]);
  setStatus(env, g.funded, STATUS.restricted);
  send(env, 'reject account not payout pending', rj, [env.risk]);
  setStatus(env, g.funded, STATUS.payoutPending);
  send(env, 'pause payouts again', await payouts(true), [env.admin]);
  send(env, 'reject', rj, [env.risk]); // pauses never block a rejection
  send(env, 'resume payouts again', await payouts(false), [env.admin]);
  snap(env, 'after reject', [g.funded, gp, g.ownerUsdc]);
  send(env, 'reject again', rj, [env.risk]);
  send(env, 'approve a rejected payout', await approve(g, gp, [gPosition]), [env.risk]);

  // approve_payout: account and config totals at their limits (MathOverflow after the transfers), then paid into the
  // trader's existing USDC account.
  const gp1 = await request(g, 'g requests again');
  const ag = await approve(g, gp1, [gPosition]);
  write(env, g.funded, PAYOUTS_PAID, le(MAX64 - usdc('320') + 1n, 8));
  send(env, 'approve account payouts overflow', ag, [env.risk]);
  write(env, g.funded, PAYOUTS_PAID, le(0n, 8));
  const c0 = env.account('config', configPda());
  await patchConfig(env, (c) => { c.payoutsPaid = bn(MAX64 - usdc('320') + 1n); });
  send(env, 'approve vault payouts overflow', ag, [env.risk]);
  await patchConfig(env, (c) => { c.payoutsPaid = c0.payoutsPaid; c.profitToVault = bn(MAX64 - usdc('80') + 1n); });
  send(env, 'approve vault profit overflow', ag, [env.risk]);
  await patchConfig(env, (c) => { c.profitToVault = c0.profitToVault; });
  send(env, 'approve into an existing trader account', ag, [env.risk]);
  snap(env, 'g paid', [configPda(), g.funded, gp1, g.ownerUsdc, getAssociatedTokenAddressSync(USDC_MINT, g.trader.publicKey), capitalVaultAddress(), solTreasuryPda()]);

  // k: a 100 % trader share (written), so the vault share is 0 and not moved; the trader's USDC address holds lamports
  // only. Then a payout whose trader amount is written to 0: nothing moves at all.
  const k = await env.activeFunded();
  const kTraderUsdc = getAssociatedTokenAddressSync(USDC_MINT, k.trader.publicKey);
  write(env, k.funded, SHARE_BPS, le(10_000n, 2));
  env.setUsdcBalance(k.ownerUsdc, usdc('600'));
  const kp = await request(k, 'k requests');
  env.remove(kTraderUsdc);
  env.svm.airdrop(kTraderUsdc, 1_000_000n);
  send(env, 'approve all to the trader', await approve(k, kp), [env.risk]);
  snap(env, 'k paid', [configPda(), k.funded, kp, k.ownerUsdc, kTraderUsdc, capitalVaultAddress(), solTreasuryPda()]);
  env.setUsdcBalance(k.ownerUsdc, usdc('600'));
  const kp1 = await request(k, 'k requests again');
  write(env, kp1, PAYOUT_TRADER_AMOUNT, le(0n, 8));
  send(env, 'approve nothing to move', await approve(k, kp1), [env.risk]);
  snap(env, 'k paid nothing', [configPda(), k.funded, kp1, k.ownerUsdc, kTraderUsdc]);

  // ---------- restrict, mark_breached ----------
  const h = await env.activeFunded();
  const restrict = (restricted: boolean, riskAuthority = risk) => v.restrict({ riskAuthority, funded: h.funded, restricted });
  const breach = (riskAuthority = risk, funded = h.funded) => v.markBreached({ riskAuthority, funded });
  const on = await restrict(true);
  const off = await restrict(false);
  send(env, 'restrict short data', raw(on, (k2, d) => [k2, d.subarray(0, 8)]), [env.risk]);
  send(env, 'restrict bad bool', raw(on, (k2, d) => { d[8] = 2; return [k2, d]; }), [env.risk]);
  send(env, 'restrict missing accounts', raw(on, (k2, d) => [k2.slice(0, 4), d]), [env.risk]);
  send(env, 'restrict not signer', at(on, 0, { isSigner: false }), [stranger]);
  send(env, 'restrict by a stranger', await restrict(true, stranger.publicKey), [stranger]);
  send(env, 'restrict by the kyc authority', await restrict(true, kyc), [env.kyc]);
  send(env, 'restrict by the trader', await restrict(true, h.trader.publicKey), [h.trader]);
  send(env, 'restrict config is a tier', swapKey(on, configPda(), tierPda(1)), [env.risk]);
  send(env, 'restrict config missing', swapKey(on, configPda(), Keypair.generate().publicKey), [env.risk]);
  send(env, 'restrict config copy', swapKey(on, configPda(), configCopy), [env.risk]);
  send(env, 'restrict funded is a profile', swapKey(on, h.funded, traderProfilePda(h.trader.publicKey)), [env.risk]);
  send(env, 'restrict funded missing', swapKey(on, h.funded, Keypair.generate().publicKey), [env.risk]);
  send(env, 'restrict funded copy', swapKey(on, h.funded, fundedCopy), [env.risk]);
  send(env, 'restrict funded readonly', at(on, 2, { isWritable: false }), [env.risk]);
  send(env, 'restrict wrong event authority', swapKey(on, eventAuthorityPda(), stranger.publicKey), [env.risk]);
  send(env, 'restrict wrong program account', at(on, 4, { pubkey: stranger.publicKey }), [env.risk]);
  send(env, 'lift an active account', off, [env.risk]);
  send(env, 'restrict', on, [env.risk]);
  snap(env, 'restricted', [h.funded]);
  send(env, 'restrict a restricted account', on, [env.risk]);
  send(env, 'lift with trailing data', raw(off, (k2, d) => [k2, Buffer.concat([d, Buffer.from([1, 2, 3])])]), [env.risk]);
  snap(env, 'lifted', [h.funded]);
  for (const [name, status] of [['payout pending', STATUS.payoutPending], ['breached', STATUS.breached], ['closed', STATUS.closed]] as const) {
    setStatus(env, h.funded, status);
    send(env, `restrict ${name}`, on, [env.risk]);
    send(env, `lift ${name}`, off, [env.risk]);
    send(env, `breach ${name}`, await breach(), [env.risk]);
  }
  setStatus(env, h.funded, STATUS.active);
  const mb = await breach();
  send(env, 'breach missing accounts', raw(mb, (k2, d) => [k2.slice(0, 4), d]), [env.risk]);
  send(env, 'breach not signer', at(mb, 0, { isSigner: false }), [stranger]);
  send(env, 'breach by a stranger', await breach(stranger.publicKey), [stranger]);
  send(env, 'breach by the trader', await breach(h.trader.publicKey), [h.trader]);
  send(env, 'breach config is a tier', swapKey(mb, configPda(), tierPda(1)), [env.risk]);
  send(env, 'breach config copy', swapKey(mb, configPda(), configCopy), [env.risk]);
  send(env, 'breach funded is a payout', swapKey(mb, h.funded, gp), [env.risk]);
  send(env, 'breach funded copy', swapKey(mb, h.funded, fundedCopy), [env.risk]);
  send(env, 'breach funded readonly', at(mb, 2, { isWritable: false }), [env.risk]);
  send(env, 'breach wrong event authority', swapKey(mb, eventAuthorityPda(), stranger.publicKey), [env.risk]);
  send(env, 'restrict h', on, [env.risk]);
  send(env, 'breach a restricted account', mb, [env.risk]);
  snap(env, 'breached', [h.funded]);
  send(env, 'breach again', mb, [env.risk]);
  send(env, 'lift a breached account', off, [env.risk]);
  send(env, 'breach an active account', await breach(risk, k.funded), [env.risk]);

  // ---------- close_funded ----------
  // f: active, 500 USDC, its flat SOL Position account passed; g: restricted, owner PDA emptied; h: breached, no USDC.
  const close = (x: Funded, positions: PublicKey[] = [], riskAuthority = risk) => v.closeFunded({ riskAuthority, funded: ref(x), positions });
  const cf = await close(f, [fPosition]);
  const fProfile = traderProfilePda(f.trader.publicKey);
  send(env, 'close missing accounts', raw(cf, (k2, d) => [k2.slice(0, 12), d]), [env.risk]);
  send(env, 'close not signer', at(cf, 0, { isSigner: false }), [stranger]);
  send(env, 'close by a stranger', await close(f, [fPosition], stranger.publicKey), [stranger]);
  send(env, 'close by the trader', await close(f, [fPosition], f.trader.publicKey), [f.trader]);
  send(env, 'close config is a tier', swapKey(cf, configPda(), tierPda(1)), [env.risk]);
  send(env, 'close config copy', swapKey(cf, configPda(), configCopy), [env.risk]);
  send(env, 'close config readonly', at(cf, 1, { isWritable: false }), [env.risk]);
  send(env, 'close funded is a profile', swapKey(cf, f.funded, traderProfilePda(g.trader.publicKey)), [env.risk]);
  send(env, 'close funded copy', swapKey(cf, f.funded, fundedCopy), [env.risk]);
  send(env, 'close funded readonly', at(cf, 2, { isWritable: false }), [env.risk]);
  send(env, 'close profile of another trader', swapKey(cf, fProfile, traderProfilePda(g.trader.publicKey)), [env.risk]);
  send(env, 'close profile missing', swapKey(cf, fProfile, traderProfilePda(stranger.publicKey)), [env.risk]);
  send(env, 'close profile is a funded account', swapKey(cf, fProfile, g.funded), [env.risk]);
  send(env, 'close profile readonly', at(cf, 3, { isWritable: false }), [env.risk]);
  send(env, 'close owner not system', swapKey(cf, f.owner, feeVaultPda()), [env.risk]);
  send(env, 'close owner of another account', swapKey(cf, f.owner, g.owner), [env.risk]);
  send(env, 'close owner readonly', at(cf, 4, { isWritable: false }), [env.risk]);
  send(env, 'close owner usdc of a stranger', swapKey(cf, f.ownerUsdc, strangerUsdc), [env.risk]);
  send(env, 'close owner usdc not the ata', swapKey(cf, f.ownerUsdc, notAta), [env.risk]);
  send(env, 'close owner usdc is a wallet', swapKey(cf, f.ownerUsdc, stranger.publicKey), [env.risk]);
  send(env, 'close owner usdc readonly', at(cf, 5, { isWritable: false }), [env.risk]);
  send(env, 'close owner usdc of another mint', swapKey(cf, f.ownerUsdc, fOwnerOther), [env.risk]);
  send(env, 'close other mint', swapKey(swapKey(cf, f.ownerUsdc, fOwnerOther), USDC_MINT, mint), [env.risk]);
  send(env, 'close mint not a mint', swapKey(cf, USDC_MINT, strangerUsdc), [env.risk]);
  send(env, 'close capital vault swapped', swapKey(cf, capitalVaultAddress(), feeVaultPda()), [env.risk]);
  send(env, 'close capital vault is a wallet', swapKey(cf, capitalVaultAddress(), stranger.publicKey), [env.risk]);
  send(env, 'close capital vault readonly', at(cf, 6, { isWritable: false }), [env.risk]);
  send(env, 'close wrong treasury', swapKey(cf, solTreasuryPda(), stranger.publicKey), [env.risk]);
  send(env, 'close treasury not system', swapKey(cf, solTreasuryPda(), feeVaultPda()), [env.risk]);
  send(env, 'close treasury readonly', at(cf, 7, { isWritable: false }), [env.risk]);
  send(env, 'close wrong token program', swapKey(cf, TOKEN_PROGRAM_ID, SystemProgram.programId), [env.risk]);
  send(env, 'close wrong system program', swapKey(cf, SystemProgram.programId, TOKEN_PROGRAM_ID), [env.risk]);
  send(env, 'close wrong event authority', swapKey(cf, eventAuthorityPda(), stranger.publicKey), [env.risk]);
  for (const [name, status] of [['payout pending', STATUS.payoutPending], ['closed', STATUS.closed]] as const) {
    setStatus(env, f.funded, status);
    send(env, `close ${name}`, cf, [env.risk]);
  }
  setStatus(env, f.funded, STATUS.active);
  write(env, f.funded, FUNDED.slot(7), used);
  send(env, 'close with a used slot', cf, [env.risk]);
  write(env, f.funded, FUNDED.slot(7), new Uint8Array(32));
  write(env, f.funded, FUNDED.order(7), used);
  send(env, 'close with a tracked order', cf, [env.risk]);
  write(env, f.funded, FUNDED.order(7), new Uint8Array(32));
  env.setPosition(fPosition, 100n * USD, usdc('10'));
  send(env, 'close with a live position', cf, [env.risk]);
  env.setPosition(fPosition, 0n, 0n);
  send(env, 'close foreign position', await close(f, [MAINNET_POSITIONS.flat]), [env.risk]);
  send(env, 'close absent position', await close(f, [fPosition, gmPositionPda(f.owner, MARKETS.BTC.token, true)]), [env.risk]);
  write(env, f.ownerUsdc, 108, [2]); // frozen: SPL Token refuses the transfer
  send(env, 'close frozen owner usdc', cf, [env.risk]);
  write(env, f.ownerUsdc, 108, [1]);
  const c1 = env.account('config', configPda());
  await patchConfig(env, (c) => { c.allocatedPrincipal = bn(usdc('499.999999')); });
  send(env, 'close allocated underflow', cf, [env.risk]);
  await patchConfig(env, (c) => { c.allocatedPrincipal = c1.allocatedPrincipal; c.fundedActive = 0; });
  send(env, 'close active count underflow', cf, [env.risk]);
  await patchConfig(env, (c) => { c.fundedActive = c1.fundedActive; });
  const closing = (x: Funded) => [configPda(), x.funded, traderProfilePda(x.trader.publicKey), x.owner, x.ownerUsdc, capitalVaultAddress(), solTreasuryPda()];
  snap(env, 'before close', closing(f));
  send(env, 'close', cf, [env.risk]);
  snap(env, 'after close', closing(f));
  send(env, 'close again', cf, [env.risk]);
  send(env, 'restrict a closed account', await v.restrict({ riskAuthority: risk, funded: f.funded, restricted: true }), [env.risk]);
  send(env, 'breach a closed account', await breach(risk, f.funded), [env.risk]);
  send(env, 'restrict g', await v.restrict({ riskAuthority: risk, funded: g.funded, restricted: true }), [env.risk]);
  env.remove(g.owner);
  snap(env, 'before closing g', closing(g));
  send(env, 'close with an emptied owner', await close(g, [gPosition]), [env.risk]);
  snap(env, 'g closed', closing(g));
  env.setUsdcBalance(h.ownerUsdc, 0n);
  send(env, 'close without usdc', await close(h), [env.risk]);
  snap(env, 'h closed', closing(h));
  send(env, 'close a breached account', await close(k), [env.risk]); // k: 600 USDC, no position account
  snap(env, 'final payouts', [...closing(k), kp1, fp, gp, gp1]);
});
