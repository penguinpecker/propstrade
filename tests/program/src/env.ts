// LiteSVM environment: the mainnet GMTrade binary at its real address, cloned mainnet accounts, and
// props_vault deployed as an upgradeable program whose upgrade authority is the test admin.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { AccountLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { BorshAccountsCoder } from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Clock, FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
  GMTRADE_PROGRAM_ID,
  GMTRADE_STORE,
  PROPS_VAULT_PROGRAM_ID,
  POSITION_LAYOUT,
  PropsVaultClient,
  USDC_MINT,
  enumName,
  evaluationPda,
  fundedPda,
  ownerPda,
  ownerUsdcAddress,
  solTreasuryPda,
  toMicro,
  traderProfilePda,
} from '@props/sdk';
import type { AccountName, FundedAccount, FundedRef, VaultEvent } from '@props/sdk';

const FIXTURES = new URL('../fixtures/', import.meta.url);
const PROGRAM_SO = new URL('../../../target/deploy/props_vault.so', import.meta.url);
/** GMTrade's own IDL (gmsol-programs 0.10.0), used as an independent decoder of GMTrade accounts. */
const gmCoder = new BorshAccountsCoder(JSON.parse(readFileSync(new URL('gmsol_store.idl.json', FIXTURES), 'utf8')));
/** Store.last_restarted_slot (u64 at byte 4800), checked against the LastRestartSlot sysvar by GMTrade. */
const STORE_LAST_RESTART_OFFSET = 4800;
const MAINNET_LAST_RESTART_SLOT = 246464040n;

export const MARKETS = {
  SOL: { token: new PublicKey('6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc'), gm: new PublicKey('CJg17Dn4xgUyEW3gKSSyteNw7LhP1o9pzm9eLtvuNjkQ') },
  BTC: { token: new PublicKey('Dqq58gS1TgRMDouUbdvhhzc51XXTNHG921WLxH9X2eB8'), gm: new PublicKey('4tM9cPqNpEYmstNdJMCc6rwdq42939w1SRFYoqMsqPQF') },
  ETH: { token: new PublicKey('DAY6Qr1FKgJQFvjJAhFUZUWHzx8UbbbkRmt6G6AYswWG'), gm: new PublicKey('6EnZdBzJsGznoh857PuhbrnrzWYGtZe6xMZiQjAPyFGT') },
  XAU: { token: new PublicKey('HCEitzjS88T4x3EpZ14EkrcawbhnZdev48a2nQfwAi37'), gm: new PublicKey('59uFARJWg7B8wcEuXzvkafiT4DuKemdNCN5bshDbwun9') },
  NVDA: { token: new PublicKey('Gi1dxHsgnVLg1JQYqKDWsTfXD9U9GvhPJDg7Has266FL'), gm: new PublicKey('8FHYNS58cXSM1xYDGDq88jHzHoKmbqEDaVnXywqXdAkT') },
  EUR: { token: new PublicKey('DLX3Aa17ebmyRp6Paxe16wn3QYtNVqdNH9AM9ZKLScfy'), gm: new PublicKey('HGEj3sGX2f7AAWUKE3AKtJuG7SZYi3N8argbFc4fk37V') },
} as const;
export type MarketName = keyof typeof MARKETS;
/** SOL/USD[WSOL-USDC]: a real GMTrade market that is not pure USDC-USDC. */
export const NON_PURE_MARKET = new PublicKey('3M4vW1u8RT3HJSWqgEN1WuiUJZuVjJLQYEWvCHCuk56g');
export const NON_PURE_MARKET_TOKEN = new PublicKey('BwN2FWixP5JyKjJNyD1YcRKN1XhgvFtnzrPrkfyb4DkW');
export const MAINNET_POSITIONS = {
  long: new PublicKey('7roEjQEYB9AT43HTfQfPWVJ1MZ6ee3XMAs1BPRkaeBPF'),
  short: new PublicKey('Hix3KU7RASFw4Q3jubUB71rzCWHMG2VaGXitjuE8S9cg'),
  flat: new PublicKey('12ejcFf7NkARnTXF1vjHvatQBYwjidkCzNZBAvjW5Vtc'),
};

export const USD = 10n ** 20n;
export const bn = (v: bigint | number): BN => new BN(v.toString());
export const usdc = (amount: string): bigint => toMicro(amount);
export const CONFIG_PARAMS = {
  traderShareBps: 8000,
  minPayout: bn(usdc('50')),
  ownerSolTarget: bn(0.25 * LAMPORTS_PER_SOL),
  ownerSolMin: bn(0.1 * LAMPORTS_PER_SOL),
};
/** Spec §1 defaults. */
export const TIERS = {
  t10k: { id: 1, size: '10000', fee: '79', enabled: true },
  t25k: { id: 2, size: '25000', fee: '149', enabled: true },
  t50k: { id: 3, size: '50000', fee: '249', enabled: false },
};
export const LEVERAGE = { crypto: 250_000, fx: 200_000, metals: 150_000, stocks: 80_000 };

export interface TxResult {
  ok: boolean;
  logs: string[];
  cu: bigint;
  /** Anchor error name ("NotFlat") or the runtime error text. */
  error?: string;
  events: VaultEvent[];
}

/** Copy of `ix` with every occurrence of `from` replaced by `to` (for account-substitution attacks). */
export function swapKey(ix: TransactionInstruction, from: PublicKey, to: PublicKey): TransactionInstruction {
  assert.ok(ix.keys.some((k) => k.pubkey.equals(from)), `instruction does not use ${from.toBase58()}`);
  const keys = ix.keys.map((k) => (k.pubkey.equals(from) ? { ...k, pubkey: to } : k));
  return new TransactionInstruction({ programId: ix.programId, data: ix.data, keys });
}

export function hash32(label: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(label).digest());
}

export class Env {
  readonly svm: LiteSVM;
  readonly vault: PropsVaultClient;
  readonly admin = Keypair.generate();
  readonly risk = Keypair.generate();
  readonly kyc = Keypair.generate();

  constructor() {
    this.svm = new LiteSVM();
    // Builders never touch the network; the connection only satisfies Anchor's provider type.
    this.vault = new PropsVaultClient(new Connection('http://127.0.0.1:1'));
    this.svm.addProgramFromFile(GMTRADE_PROGRAM_ID, new URL('gmsol_store.so', FIXTURES).pathname);
    this.svm.addProgramFromFile(PROPS_VAULT_PROGRAM_ID, PROGRAM_SO.pathname);
    this.setUpgradeAuthority(this.admin.publicKey);
    this.loadFixtures();
    this.svm.setClock(new Clock(449_600_000n, 1_790_000_000n, 1040n, 1041n, BigInt(Math.floor(Date.now() / 1000))));
    for (const k of [this.admin, this.risk, this.kyc]) this.svm.airdrop(k.publicKey, BigInt(100 * LAMPORTS_PER_SOL));
  }

  private setUpgradeAuthority(authority: PublicKey): void {
    const program = this.svm.getAccount(PROPS_VAULT_PROGRAM_ID)!;
    const programData = new PublicKey(program.data.slice(4, 36));
    const account = this.svm.getAccount(programData)!;
    const data = Buffer.from(account.data);
    data[12] = 1; // Option::Some
    authority.toBuffer().copy(data, 13);
    this.svm.setAccount(programData, { ...account, data });
  }

  private loadFixtures(): void {
    const dir = new URL('accounts/', FIXTURES);
    for (const file of readdirSync(dir)) {
      const { pubkey, account } = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
      const data = Buffer.from(account.data[0], 'base64');
      if (pubkey === GMTRADE_STORE.toBase58()) {
        assert.equal(data.readBigUInt64LE(STORE_LAST_RESTART_OFFSET), MAINNET_LAST_RESTART_SLOT, 'unexpected Store layout');
        data.writeBigUInt64LE(this.svm.getLastRestartSlot(), STORE_LAST_RESTART_OFFSET);
      }
      this.svm.setAccount(new PublicKey(pubkey), {
        lamports: account.lamports,
        data,
        owner: new PublicKey(account.owner),
        executable: false,
      });
    }
  }

  // ---------- transactions ----------

  send(instructions: TransactionInstruction[], signers: Keypair[]): TxResult {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...instructions);
    tx.feePayer = signers[0]!.publicKey;
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.sign(...signers);
    const result = this.svm.sendTransaction(tx);
    this.svm.expireBlockhash();
    const meta = result instanceof FailedTransactionMetadata ? result.meta() : result;
    const logs = meta.logs();
    if (result instanceof FailedTransactionMetadata) {
      const anchor = logs.map((l) => /Error Code: (\w+)/.exec(l)?.[1]).find(Boolean);
      return { ok: false, logs, cu: meta.computeUnitsConsumed(), error: anchor ?? result.err().toString(), events: [] };
    }
    const keys = tx.compileMessage().accountKeys;
    const inner = meta.innerInstructions().flat().map((i) => ({ programId: keys[i.instruction().programIdIndex()]!, data: i.instruction().data() }));
    return { ok: true, logs, cu: meta.computeUnitsConsumed(), events: this.vault.parseEvents(inner) };
  }

  /** Sends and asserts success. */
  ok(instructions: TransactionInstruction | TransactionInstruction[], signers: Keypair[]): TxResult {
    const r = this.send([instructions].flat(), signers);
    assert.ok(r.ok, `transaction failed: ${r.error}\n${r.logs.join('\n')}`);
    return r;
  }

  /** Sends and asserts failure with the given error (Anchor error name or a substring of the runtime error/logs). */
  fails(instructions: TransactionInstruction | TransactionInstruction[], signers: Keypair[], expected: string): TxResult {
    const r = this.send([instructions].flat(), signers);
    assert.ok(!r.ok, `expected failure "${expected}" but the transaction succeeded`);
    const matched = r.error === expected || r.logs.some((l) => l.includes(expected)) || (r.error ?? '').includes(expected);
    assert.ok(matched, `expected "${expected}", got "${r.error}"\n${r.logs.join('\n')}`);
    return r;
  }

  // ---------- accounts ----------

  wallet(sol = 10): Keypair {
    const k = Keypair.generate();
    this.svm.airdrop(k.publicKey, BigInt(sol * LAMPORTS_PER_SOL));
    return k;
  }

  account<N extends AccountName>(name: N, address: PublicKey) {
    const info = this.svm.getAccount(address);
    assert.ok(info, `${name} ${address.toBase58()} does not exist`);
    return this.vault.decode(name, info.data);
  }

  /** Decodes a GMTrade account with GMTrade's IDL (snake_case fields). */
  gm(name: 'Order' | 'Position' | 'UserHeader' | 'Market', address: PublicKey): any {
    const info = this.svm.getAccount(address);
    assert.ok(info, `GMTrade ${name} ${address.toBase58()} does not exist`);
    return gmCoder.decode(name, Buffer.from(info.data));
  }

  funded(address: PublicKey): FundedRef {
    return { address, account: this.account('fundedAccount', address) as FundedAccount };
  }

  status(address: PublicKey): string {
    return enumName(this.account('fundedAccount', address).status);
  }

  lamports(address: PublicKey): bigint {
    return this.svm.getBalance(address) ?? 0n;
  }

  exists(address: PublicKey): boolean {
    const a = this.svm.getAccount(address);
    return !!a && a.lamports > 0;
  }

  /** Writes a USDC token account (mainnet USDC cannot be minted locally). Returns its address. */
  setUsdc(owner: PublicKey, amount: bigint, address = getAssociatedTokenAddressSync(USDC_MINT, owner, true)): PublicKey {
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint: USDC_MINT,
        owner,
        amount,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      data,
    );
    this.svm.setAccount(address, { lamports: 2_039_280, data, owner: TOKEN_PROGRAM_ID, executable: false });
    return address;
  }

  usdcBalance(tokenAccount: PublicKey): bigint {
    const a = this.svm.getAccount(tokenAccount);
    return a ? AccountLayout.decode(a.data).amount : 0n;
  }

  /** Overwrites the USDC balance of an existing token account (emulates realized PnL landing on the owner). */
  setUsdcBalance(tokenAccount: PublicKey, amount: bigint): void {
    const a = this.svm.getAccount(tokenAccount)!;
    const data = Buffer.from(a.data);
    data.writeBigUInt64LE(amount, 64);
    this.svm.setAccount(tokenAccount, { ...a, data });
  }

  remove(address: PublicKey): void {
    this.svm.setAccount(address, { lamports: 0, data: new Uint8Array(), owner: SystemProgram.programId, executable: false });
  }

  // ---------- GMTrade keeper emulation ----------

  /** Writes a GMTrade Position's size (GMTrade USD) and collateral (USDC base units), as a keeper fill would. */
  setPosition(position: PublicKey, sizeUsd: bigint, collateral: bigint): void {
    const a = this.svm.getAccount(position)!;
    const data = Buffer.from(a.data);
    const writeU128 = (v: bigint, at: number) => {
      data.writeBigUInt64LE(v & ((1n << 64n) - 1n), at);
      data.writeBigUInt64LE(v >> 64n, at + 8);
    };
    writeU128(sizeUsd, POSITION_LAYOUT.sizeInUsd);
    writeU128(collateral, POSITION_LAYOUT.collateralAmount);
    this.svm.setAccount(position, { ...a, data });
  }

  /** A keeper executed an order: escrowed collateral went to the pool and the order account was closed. */
  executeOrder(order: PublicKey, escrow: PublicKey): void {
    this.remove(escrow);
    this.remove(order);
  }

  // ---------- flows ----------

  async setUpVault(p: { capital?: bigint } = {}): Promise<void> {
    const v = this.vault;
    const admin = this.admin.publicKey;
    this.ok(await v.initialize({ admin, params: CONFIG_PARAMS }), [this.admin]);
    this.ok(await v.setAuthorities({ admin, riskAuthorities: [this.risk.publicKey], kycAuthority: this.kyc.publicKey }), [this.admin]);
    for (const t of Object.values(TIERS)) {
      this.ok(await v.upsertTier({ admin, id: t.id, params: tierParams(t) }), [this.admin]);
    }
    const lev = (name: MarketName) =>
      name === 'NVDA' ? LEVERAGE.stocks : name === 'EUR' ? LEVERAGE.fx : name === 'XAU' ? LEVERAGE.metals : LEVERAGE.crypto;
    for (const [name, m] of Object.entries(MARKETS) as [MarketName, (typeof MARKETS)[MarketName]][]) {
      this.ok(await v.upsertMarket({ admin, marketToken: m.token, params: marketParams(name, lev(name)) }), [this.admin]);
    }
    const capital = p.capital ?? usdc('100000');
    this.setUsdc(admin, capital);
    this.ok(await v.depositCapital({ admin, amount: capital }), [this.admin]);
    this.svm.airdrop(solTreasuryPda(), BigInt(20 * LAMPORTS_PER_SOL));
    this.ok(await v.setPauses({ admin, paused: { newEvaluations: false, trading: false, payouts: false } }), [this.admin]);
  }

  /** Buys an evaluation, verifies the trader and records a pass. */
  async passedEvaluation(trader: Keypair, tierId = TIERS.t10k.id): Promise<PublicKey> {
    const profile = this.svm.getAccount(traderProfilePda(trader.publicKey));
    const index = profile ? this.account('traderProfile', traderProfilePda(trader.publicKey)).evaluationCount : 0;
    if (this.usdcBalance(getAssociatedTokenAddressSync(USDC_MINT, trader.publicKey)) < usdc('1000')) this.setUsdc(trader.publicKey, usdc('1000'));
    this.ok(await this.vault.buyEvaluation({ trader: trader.publicKey, tierId, index }), [trader]);
    const evaluation = evaluationPda(trader.publicKey, index);
    if (!profile || !this.account('traderProfile', traderProfilePda(trader.publicKey)).identityHash.some((b) => b !== 0)) {
      this.ok(await this.vault.setIdentity({ kycAuthority: this.kyc.publicKey, wallet: trader.publicKey, identityHash: hash32(trader.publicKey.toBase58()) }), [this.kyc]);
    }
    this.ok(
      await this.vault.recordEvaluationResult({
        riskAuthority: this.risk.publicKey,
        evaluation,
        passed: true,
        finalEquity: usdc('10900'),
        tradesRoot: hash32('fills'),
      }),
      [this.risk],
    );
    return evaluation;
  }

  /** A trader with an active funded account (10K tier: principal 500 USDC). */
  async activeFunded(trader = this.wallet(), tierId = TIERS.t10k.id): Promise<{ trader: Keypair; funded: PublicKey; owner: PublicKey; ownerUsdc: PublicKey }> {
    const evaluation = await this.passedEvaluation(trader, tierId);
    this.ok(await this.vault.activateFunded({ trader: trader.publicKey, evaluation }), [trader]);
    const funded = fundedPda(evaluation);
    return { trader, funded, owner: ownerPda(funded), ownerUsdc: ownerUsdcAddress(funded) };
  }
}

export function tierParams(t: { size: string; fee: string; enabled: boolean }) {
  return {
    sizeUsd: bn(usdc(t.size)),
    feeUsdc: bn(usdc(t.fee)),
    profitTargetBps: 800,
    maxDrawdownBps: 500,
    maxExposureBps: 10_000,
    enabled: t.enabled,
    termsHash: Array.from(hash32(`terms:${t.size}`)),
  };
}

export function marketParams(name: string, maxLeverageBps: number, overrides: Partial<{ maxPositionUsd: bigint; maxTotalOiUsd: bigint; enabled: boolean }> = {}) {
  const symbol = new Uint8Array(16);
  symbol.set(new TextEncoder().encode(name));
  return {
    enabled: overrides.enabled ?? true,
    indexSymbol: Array.from(symbol),
    maxLeverageBps,
    closedMaxLeverageBps: Math.min(maxLeverageBps, 80_000),
    maxPositionUsd: bn(overrides.maxPositionUsd ?? usdc('10000')),
    maxTotalOiUsd: bn(overrides.maxTotalOiUsd ?? usdc('100000')),
    sessionRestricted: name === 'NVDA' || name === 'EUR',
  };
}
