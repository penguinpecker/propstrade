// The admin.rs instructions, happy paths and refusals, compared byte for byte (see harness.ts). Also covers what the
// suite does not: pre-funded PDAs (Anchor's transfer + allocate + assign path), Config's variable layout (pending admin
// Some/None, 0-4 risk authorities, stale bytes after a shorter write), malformed data and account lists, the event
// self-CPI and dispatch edge cases.
import { Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  GMTRADE_STORE, PROPS_VAULT_IDL, PROPS_VAULT_PROGRAM_ID, USDC_MINT, capitalVaultAddress, configPda, eventAuthorityPda,
  feeVaultPda, marketConfigPda, solTreasuryPda, tierPda, vaultAuthorityPda,
} from '@props/sdk';
import { compare } from './harness.ts';

await compare(async ({ env: { CONFIG_PARAMS, Env, LEVERAGE, MARKETS, NON_PURE_MARKET_TOKEN, TIERS, bn, marketParams, swapKey, tierParams, usdc }, send, snap, raw }) => {
  const env = new Env();
  const v = env.vault;
  const admin = env.admin.publicKey;
  const stranger = env.wallet();
  const all = () => [configPda(), feeVaultPda(), capitalVaultAddress(), solTreasuryPda(), tierPda(1), tierPda(2), tierPda(3), tierPda(9), ...Object.values(MARKETS).map((m) => marketConfigPda(m.token)), admin, getAssociatedTokenAddressSync(USDC_MINT, admin, true), eventAuthorityPda()];

  send(env, 'init stranger', await v.initialize({ admin: stranger.publicKey, params: CONFIG_PARAMS }), [stranger]);
  const init = await v.initialize({ admin, params: CONFIG_PARAMS });
  send(env, 'init bad store', swapKey(init, GMTRADE_STORE, MARKETS.SOL.token), [env.admin]);
  send(env, 'init bad share', await v.initialize({ admin, params: { ...CONFIG_PARAMS, traderShareBps: 10_001 } }), [env.admin]);
  send(env, 'init bad float', await v.initialize({ admin, params: { ...CONFIG_PARAMS, ownerSolMin: bn(1000) } }), [env.admin]);
  send(env, 'init missing accounts', raw(init, (k, d) => [k.slice(0, 10), d]), [env.admin]);
  send(env, 'init short data', raw(init, (k, d) => [k, d.subarray(0, 12)]), [env.admin]);
  send(env, 'init wrong system program', swapKey(init, new PublicKey('11111111111111111111111111111111'), stranger.publicKey), [env.admin]);
  send(env, 'init wrong event authority', swapKey(init, eventAuthorityPda(), stranger.publicKey), [env.admin]);
  send(env, 'init', init, [env.admin]);
  snap(env, 'after init', all());
  send(env, 'init again', await v.initialize({ admin, params: CONFIG_PARAMS }), [env.admin]);

  const five = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
  send(env, 'auth five', await v.setAuthorities({ admin, riskAuthorities: five, kycAuthority: admin }), [env.admin]);
  send(env, 'auth default', await v.setAuthorities({ admin, riskAuthorities: [PublicKey.default], kycAuthority: admin }), [env.admin]);
  send(env, 'auth stranger', await v.setAuthorities({ admin: stranger.publicKey, riskAuthorities: [], kycAuthority: admin }), [stranger]);
  const four = await v.setAuthorities({ admin, riskAuthorities: five.slice(0, 4), kycAuthority: env.kyc.publicKey });
  send(env, 'auth truncated vec', raw(four, (k, d) => [k, d.subarray(0, 8 + 4 + 64)]), [env.admin]);
  send(env, 'auth config readonly', raw(four, (k, d) => [k.map((x, i) => (i === 1 ? { ...x, isWritable: false } : x)), d]), [env.admin]);
  send(env, 'auth four', four, [env.admin]);
  snap(env, 'after four', [configPda()]);
  send(env, 'params', await v.setParams({ admin, params: { ...CONFIG_PARAMS, traderShareBps: 7000 } }), [env.admin]);
  send(env, 'params bad', await v.setParams({ admin, params: { ...CONFIG_PARAMS, minPayout: bn(0) } }), [env.admin]);
  send(env, 'pauses', await v.setPauses({ admin, paused: { newEvaluations: true, trading: false, payouts: true } }), [env.admin]);

  // Pre-funded tier PDAs, below and above the rent-exempt minimum.
  env.svm.airdrop(tierPda(1), 1n);
  env.svm.airdrop(tierPda(2), 5_000_000n);
  for (const t of Object.values(TIERS)) send(env, `tier ${t.id}`, await v.upsertTier({ admin, id: t.id, params: tierParams(t) }), [env.admin]);
  send(env, 'tier update', await v.upsertTier({ admin, id: 1, params: { ...tierParams(TIERS.t10k), feeUsdc: bn(usdc('89')) } }), [env.admin]);
  send(env, 'tier bad drawdown', await v.upsertTier({ admin, id: 9, params: { ...tierParams(TIERS.t10k), maxDrawdownBps: 0 } }), [env.admin]);
  send(env, 'tier bad hash', await v.upsertTier({ admin, id: 9, params: { ...tierParams(TIERS.t10k), termsHash: Array(32).fill(0) } }), [env.admin]);
  send(env, 'tier stranger', await v.upsertTier({ admin: stranger.publicKey, id: 9, params: tierParams(TIERS.t10k) }), [stranger]);
  send(env, 'tier wrong pda', swapKey(await v.upsertTier({ admin, id: 9, params: tierParams(TIERS.t10k) }), tierPda(9), tierPda(8)), [env.admin]);
  send(env, 'tier bad bool', raw(await v.upsertTier({ admin, id: 9, params: tierParams(TIERS.t10k) }), (k, d) => { d[8 + 2 + 8 + 8 + 6] = 2; return [k, d]; }), [env.admin]);

  const lev = (name: string) => (name === 'NVDA' ? LEVERAGE.stocks : name === 'EUR' ? LEVERAGE.fx : name === 'XAU' ? LEVERAGE.metals : LEVERAGE.crypto);
  env.svm.airdrop(marketConfigPda(MARKETS.BTC.token), 3_000_000n);
  for (const [name, m] of Object.entries(MARKETS)) send(env, `market ${name}`, await v.upsertMarket({ admin, marketToken: m.token, params: marketParams(name, lev(name)) }), [env.admin]);
  send(env, 'market non pure', await v.upsertMarket({ admin, marketToken: NON_PURE_MARKET_TOKEN, params: marketParams('SOLX', LEVERAGE.crypto) }), [env.admin]);
  const sol = await v.upsertMarket({ admin, marketToken: MARKETS.SOL.token, params: marketParams('SOL', LEVERAGE.crypto) });
  send(env, 'market wrong gm', swapKey(sol, MARKETS.SOL.gm, MARKETS.BTC.gm), [env.admin]);
  send(env, 'market bad params', await v.upsertMarket({ admin, marketToken: MARKETS.SOL.token, params: marketParams('SOL', 5_000) }), [env.admin]);
  send(env, 'market update', await v.upsertMarket({ admin, marketToken: MARKETS.SOL.token, params: marketParams('SOL', LEVERAGE.fx, { enabled: false }) }), [env.admin]);

  env.setUsdc(admin, usdc('5000'));
  send(env, 'deposit 0', await v.depositCapital({ admin, amount: 0n }), [env.admin]);
  send(env, 'deposit', await v.depositCapital({ admin, amount: usdc('5000') }), [env.admin]);
  send(env, 'deposit into fee vault', swapKey(await v.depositCapital({ admin, amount: 1n }), capitalVaultAddress(), feeVaultPda()), [env.admin]);
  env.setUsdc(stranger.publicKey, usdc('10'));
  send(env, 'withdraw too much', await v.withdrawCapital({ admin, amount: usdc('5000.000001') }), [env.admin]);
  send(env, 'withdraw stranger', await v.withdrawCapital({ admin: stranger.publicKey, amount: 1n }), [stranger]);
  send(env, 'withdraw to stranger usdc', await v.withdrawCapital({ admin, amount: 1n, adminUsdc: getAssociatedTokenAddressSync(USDC_MINT, stranger.publicKey) }), [env.admin]);
  send(env, 'withdraw', await v.withdrawCapital({ admin, amount: usdc('1000') }), [env.admin]);
  send(env, 'sweep empty', await v.sweepFees({ admin }), [env.admin]);
  env.setUsdcBalance(feeVaultPda(), usdc('79'));
  send(env, 'sweep stranger', await v.sweepFees({ admin: stranger.publicKey }), [stranger]);
  send(env, 'sweep', await v.sweepFees({ admin }), [env.admin]);
  env.svm.airdrop(solTreasuryPda(), BigInt(20 * LAMPORTS_PER_SOL));
  send(env, 'sol stranger', await v.withdrawSolTreasury({ admin: stranger.publicKey, lamports: 1n }), [stranger]);
  send(env, 'sol 0', await v.withdrawSolTreasury({ admin, lamports: 0n }), [env.admin]);
  send(env, 'sol', await v.withdrawSolTreasury({ admin, lamports: BigInt(LAMPORTS_PER_SOL) }), [env.admin]);
  snap(env, 'after money', all());

  const next = env.wallet();
  const other = env.wallet();
  send(env, 'propose', await v.proposeAdmin({ admin, newAdmin: next.publicKey }), [env.admin]);
  snap(env, 'after propose', [configPda()]);
  send(env, 'propose other', await v.proposeAdmin({ admin, newAdmin: other.publicKey }), [env.admin]);
  send(env, 'propose next', await v.proposeAdmin({ admin, newAdmin: next.publicKey }), [env.admin]);
  send(env, 'accept stranger', await v.acceptAdmin({ newAdmin: stranger.publicKey }), [stranger]);
  send(env, 'accept', await v.acceptAdmin({ newAdmin: next.publicKey }), [next]);
  snap(env, 'after accept', [configPda()]);
  send(env, 'old admin', await v.setPauses({ admin, paused: { newEvaluations: false, trading: false, payouts: false } }), [env.admin]);
  send(env, 'auth one', await v.setAuthorities({ admin: next.publicKey, riskAuthorities: [env.risk.publicKey], kycAuthority: env.kyc.publicKey }), [next]);
  snap(env, 'after one', [configPda()]);
  send(env, 'auth none', await v.setAuthorities({ admin: next.publicKey, riskAuthorities: [], kycAuthority: PublicKey.default }), [next]);
  send(env, 'propose again', await v.proposeAdmin({ admin: next.publicKey, newAdmin: other.publicKey }), [next]);
  send(env, 'auth four again', await v.setAuthorities({ admin: next.publicKey, riskAuthorities: five.slice(0, 4), kycAuthority: env.kyc.publicKey }), [next]);
  snap(env, 'final', all());

  const tag = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
  const disc = Buffer.from(PROPS_VAULT_IDL.events.find((e) => e.name === 'FundedActivated')!.discriminator);
  const direct = (keys: TransactionInstruction['keys'], data: Buffer) => new TransactionInstruction({ programId: PROPS_VAULT_PROGRAM_ID, keys, data });
  send(env, 'forged event', direct([{ pubkey: eventAuthorityPda(), isSigner: false, isWritable: false }], Buffer.concat([tag, disc, Buffer.alloc(200)])), [stranger]);
  send(env, 'forged event, wrong signer', direct([{ pubkey: stranger.publicKey, isSigner: true, isWritable: false }], Buffer.concat([tag, disc])), [stranger]);
  send(env, 'event without accounts', direct([], tag), [stranger]);
  send(env, 'unknown instruction', direct([], Buffer.alloc(8, 7)), [stranger]);
  send(env, 'short instruction', direct([], Buffer.alloc(4, 7)), [stranger]);

  // A second vault: pre-funded config and fee vault, capital vault ATA created by a stranger first.
  const env2 = new Env();
  env2.svm.airdrop(configPda(), 10_000_000n);
  env2.svm.airdrop(feeVaultPda(), 1n);
  const griefer = env2.wallet();
  send(env2, 'grief ata', createAssociatedTokenAccountIdempotentInstruction(griefer.publicKey, capitalVaultAddress(), vaultAuthorityPda(), USDC_MINT), [griefer]);
  send(env2, 'init prefunded', await env2.vault.initialize({ admin: env2.admin.publicKey, params: CONFIG_PARAMS }), [env2.admin]);
  snap(env2, 'prefunded', [configPda(), feeVaultPda(), capitalVaultAddress()]);
});
