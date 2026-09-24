// Read-only report of everything the go-live steps change (docs/runbooks/launch.md): the program and its upgrade
// authority, the Config (admin, authorities, pinned addresses, parameters, pauses), vault, fee vault and SOL treasury
// balances, allocated principal and funded accounts, every tier and market config, and the SOL each authority holds.
// Needs no key and sends nothing. Run it after every step and compare with what the step should have changed.
import { PublicKey } from '@solana/web3.js';
import {
  BPS,
  GMTRADE_PROGRAM_ID,
  GMTRADE_STORE,
  USDC_MINT,
  capitalVaultAddress,
  configPda,
  feeVaultPda,
  formatUnits,
  fromMicro,
  solTreasuryPda,
} from '@props/sdk';
import { connect, main } from './lib.ts';

const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
// Below these an authority may not pay for its next transactions: the risk key pays every keeper and chain-job fee
// (~0.00003 SOL each at the server's priority fee); the KYC key also pays ~0.002 SOL of rent per verified trader.
const LOW_SOL = { risk: 50_000_000n, kyc: 20_000_000n };

const sol = (lamports: bigint | number) => `${formatUnits(BigInt(lamports), 9)} SOL`;
const usdc = (micro: { toString(): string }) => `${fromMicro(BigInt(micro.toString()))} USDC`;
const pct = (bps: number) => `${bps / 100}%`;
const onOff = (paused: boolean) => (paused ? 'PAUSED' : 'open');
const tokenAmount = (data: Buffer | undefined) => (data ? data.readBigUInt64LE(64) : null);

main(async () => {
  const ctx = connect('node scripts/admin/status.ts [--cluster ...]');
  const { connection, vault } = ctx;
  const programId = vault.program.programId;
  const warnings: string[] = [];
  const slot = await connection.getSlot();
  console.log(`props_vault ${programId.toBase58()} on ${ctx.cluster} at slot ${slot}\n`);

  // ---------- program ----------
  const programData = PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];
  const header = await connection.getAccountInfo(programData, { dataSlice: { offset: 0, length: 45 } });
  if (!header) {
    console.log('program       not deployed');
    return;
  }
  // ProgramData: u32 variant (3), u64 last-deploy slot, Option<Pubkey> upgrade authority.
  const authority = header.data[12] === 1 ? new PublicKey(header.data.subarray(13, 45)).toBase58() : 'none (immutable)';
  console.log(`program       upgrade authority ${authority}, last deployed at slot ${header.data.readBigUInt64LE(4)}`);
  // Anchor's IDL account: createWithSeed(PDA([], program), "anchor:idl", program); data = discriminator, authority, …
  // Informational only: the onchain IDL is optional (the server decodes with the IDL bundled in @props/sdk) and the
  // deployed Pinocchio build has no IDL instructions to publish one with (programs-p/props_vault_p/PORTING.md).
  const idlAddress = await PublicKey.createWithSeed(PublicKey.findProgramAddressSync([], programId)[0], 'anchor:idl', programId);
  const idl = await connection.getAccountInfo(idlAddress, { dataSlice: { offset: 8, length: 32 } });
  console.log(`idl           ${idlAddress.toBase58()} ${idl ? `authority ${new PublicKey(idl.data).toBase58()}` : 'missing (optional: the server decodes with the IDL bundled in @props/sdk)'}`);

  // ---------- config + vault balances (one read, one slot) ----------
  const [configInfo, capitalInfo, feeInfo, treasuryInfo] = await connection.getMultipleAccountsInfo(
    [configPda(), capitalVaultAddress(), feeVaultPda(), solTreasuryPda()],
  );
  if (!configInfo) {
    console.log(`config        ${configPda().toBase58()} does not exist: run scripts/admin/initialize.ts`);
    console.log(`sol treasury  ${solTreasuryPda().toBase58()} ${sol(treasuryInfo?.lamports ?? 0)}`);
    if (warnings.length) console.log(`\nwarnings\n${warnings.map((w) => `  - ${w}`).join('\n')}`);
    return;
  }
  const c = vault.decode('config', configInfo.data);
  const authorities = [...c.riskAuthorities, c.kycAuthority];
  const balances = await connection.getMultipleAccountsInfo(authorities);
  const balanceOf = (i: number) => BigInt(balances[i]?.lamports ?? 0);

  console.log(`config        ${configPda().toBase58()}`);
  console.log(`  admin               ${c.admin.toBase58()}${c.pendingAdmin ? ` (pending: ${c.pendingAdmin.toBase58()})` : ''}`);
  if (c.riskAuthorities.length === 0) warnings.push('no risk authority: evaluations cannot be resolved and the keeper cannot act');
  c.riskAuthorities.forEach((k, i) => {
    console.log(`  risk authority      ${k.toBase58()} ${sol(balanceOf(i))}`);
    if (balanceOf(i) < LOW_SOL.risk) warnings.push(`risk authority ${k.toBase58()} holds under ${sol(LOW_SOL.risk)}: fund it`);
  });
  const kycIndex = authorities.length - 1;
  if (c.kycAuthority.equals(PublicKey.default)) warnings.push('no KYC authority set: identities cannot be verified');
  else {
    console.log(`  kyc authority       ${c.kycAuthority.toBase58()} ${sol(balanceOf(kycIndex))}`);
    if (balanceOf(kycIndex) < LOW_SOL.kyc) warnings.push(`KYC authority holds under ${sol(LOW_SOL.kyc)}: fund it`);
  }
  for (const [name, actual, expected] of [
    ['USDC mint', c.usdcMint, USDC_MINT], ['GMTrade program', c.gmtradeProgram, GMTRADE_PROGRAM_ID], ['GMTrade store', c.gmtradeStore, GMTRADE_STORE],
    ['capital vault', c.capitalVault, capitalVaultAddress()],
  ] as const) if (!actual.equals(expected)) warnings.push(`${name} is ${actual.toBase58()}, the SDK expects ${expected.toBase58()}`);
  console.log(`  pinned              USDC ${c.usdcMint.toBase58()}, GMTrade ${c.gmtradeProgram.toBase58()} store ${c.gmtradeStore.toBase58()}`);
  console.log(`  parameters          trader share ${pct(c.traderShareBps)}, min payout ${usdc(c.minPayout)}, owner float ${sol(BigInt(c.ownerSolTarget.toString()))} (top-up below ${sol(BigInt(c.ownerSolMin.toString()))}), max ${usdc(c.maxDailyPrincipal)} principal a day`);
  console.log(`  pauses              new evaluations ${onOff(c.paused.newEvaluations)}, trading ${onOff(c.paused.trading)}, payouts ${onOff(c.paused.payouts)}`);

  const capital = tokenAmount(capitalInfo?.data);
  const treasury = BigInt(treasuryInfo?.lamports ?? 0);
  console.log(`\nvault`);
  console.log(`  capital vault       ${capitalVaultAddress().toBase58()} ${capital === null ? 'missing' : usdc(capital)} (unallocated)`);
  console.log(`  allocated principal ${usdc(c.allocatedPrincipal)} in ${c.fundedActive} open funded accounts (${c.fundedActivated} activated in total)`);
  console.log(`  fee vault           ${feeVaultPda().toBase58()} ${tokenAmount(feeInfo?.data) === null ? 'missing' : usdc(tokenAmount(feeInfo?.data)!)}`);
  console.log(`  sol treasury        ${solTreasuryPda().toBase58()} ${sol(treasury)}`);
  console.log(`  totals              ${c.evaluationsSold} evaluations sold, fees ${usdc(c.feesCollected)}, payouts ${usdc(c.payoutsPaid)}, vault profit share ${usdc(c.profitToVault)}`);
  if (treasury < BigInt(c.ownerSolTarget.toString())) warnings.push(`the SOL treasury holds less than one owner float (${sol(BigInt(c.ownerSolTarget.toString()))}): the next activation fails; run scripts/admin/fund-sol-treasury.ts`);

  // ---------- tiers ----------
  const tiers = (await vault.program.account.tier.all()).map((t) => t.account).sort((a, b) => a.id - b.id);
  console.log(`\ntiers (${tiers.length})`);
  if (tiers.length) console.log('  id  size USD   fee USDC  target  loss  exposure  enabled  version  principal  capital covers  terms hash');
  for (const t of tiers) {
    const principal = (BigInt(t.sizeUsd.toString()) * BigInt(t.maxDrawdownBps)) / BigInt(BPS);
    const covers = capital === null || principal === 0n ? 0n : capital / principal;
    console.log(`  ${String(t.id).padEnd(4)}${fromMicro(BigInt(t.sizeUsd.toString())).padEnd(11)}${fromMicro(BigInt(t.feeUsdc.toString())).padEnd(10)}${pct(t.profitTargetBps).padEnd(8)}${pct(t.maxDrawdownBps).padEnd(6)}${pct(t.maxExposureBps).padEnd(10)}${(t.enabled ? 'yes' : 'no').padEnd(9)}${String(t.version).padEnd(9)}${fromMicro(principal).padEnd(11)}${String(covers).padEnd(16)}${Buffer.from(t.termsHash).toString('hex')}`);
    if (t.enabled && covers === 0n) warnings.push(`tier ${t.id} is enabled but the capital vault cannot fund one account of it (${fromMicro(principal)} USDC principal)`);
  }

  // ---------- markets ----------
  const markets = (await vault.program.account.marketConfig.all())
    .map((m) => ({ ...m.account, symbol: Buffer.from(m.account.indexSymbol).toString('utf8').replace(/\0+$/, '') }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const gmUsd = (v: { toString(): string }) => formatUnits(BigInt(v.toString()), 20);
  console.log(`\nmarkets (${markets.filter((m) => m.enabled).length} enabled of ${markets.length} configured)`);
  if (markets.length) console.log('  symbol    enabled  max lev  closed  max position USD  max OI/side USD  OI long USD  OI short USD  session  market token');
  for (const m of markets) {
    console.log(`  ${m.symbol.padEnd(10)}${(m.enabled ? 'yes' : 'no').padEnd(9)}${`${m.maxLeverageBps / BPS}×`.padEnd(9)}${`${m.closedMaxLeverageBps / BPS}×`.padEnd(8)}${fromMicro(BigInt(m.maxPositionUsd.toString())).padEnd(18)}${fromMicro(BigInt(m.maxTotalOiUsd.toString())).padEnd(17)}${gmUsd(m.oiLongUsd).padEnd(13)}${gmUsd(m.oiShortUsd).padEnd(14)}${(m.sessionRestricted ? 'yes' : 'no').padEnd(9)}${m.marketToken.toBase58()}`);
  }

  console.log(warnings.length ? `\nwarnings\n${warnings.map((w) => `  - ${w}`).join('\n')}` : '\nno warnings');
});
