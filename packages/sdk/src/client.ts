import { Program } from '@coral-xyz/anchor';
import type { IdlAccounts, IdlTypes } from '@coral-xyz/anchor';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import type { AccountMeta, Connection, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { GMTRADE_PROGRAM_ID, GMTRADE_STORE, PROPS_VAULT_PROGRAM_ID, USDC_MINT } from './constants.ts';
import {
  POSITION_DISCRIMINATOR,
  POSITION_LAYOUT,
  gmEventAuthority,
  gmMarketPda,
  gmOrderEscrow,
  gmOrderPda,
  gmPositionPda,
  gmStoreWallet,
  gmUserPda,
  orderNonce,
} from './gmtrade.ts';
import idl from './idl/props_vault.json' with { type: 'json' };
import type { PropsVault } from './idl/props_vault.ts';
import {
  capitalVaultAddress,
  configPda,
  evaluationPda,
  eventAuthorityPda,
  feeVaultPda,
  fundedPda,
  identityLockPda,
  marketConfigPda,
  ownerPda,
  ownerUsdcAddress,
  payoutPda,
  solTreasuryPda,
  tierPda,
  traderProfilePda,
  vaultAuthorityPda,
} from './pda.ts';

export type ConfigAccount = IdlAccounts<PropsVault>['config'];
export type TierAccount = IdlAccounts<PropsVault>['tier'];
export type MarketConfigAccount = IdlAccounts<PropsVault>['marketConfig'];
export type TraderProfileAccount = IdlAccounts<PropsVault>['traderProfile'];
export type EvaluationAccount = IdlAccounts<PropsVault>['evaluation'];
export type FundedAccount = IdlAccounts<PropsVault>['fundedAccount'];
export type PayoutRequestAccount = IdlAccounts<PropsVault>['payoutRequest'];
export type IdentityLockAccount = IdlAccounts<PropsVault>['identityLock'];
export type ConfigParams = IdlTypes<PropsVault>['configParams'];
export type TierParams = IdlTypes<PropsVault>['tierParams'];
export type MarketParams = IdlTypes<PropsVault>['marketParams'];
export type Pauses = IdlTypes<PropsVault>['pauses'];
export type AccountName = keyof IdlAccounts<PropsVault>;

export type OrderTypeName = 'market' | 'limit' | 'close' | 'takeProfit' | 'stopLoss';

/** Name of a decoded Anchor enum value, e.g. `{ payoutPending: {} }` → "payoutPending". */
export function enumName<T extends string>(value: object): T {
  const [name] = Object.keys(value);
  if (!name) throw new Error('empty enum value');
  return name as T;
}

const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const bn = (v: bigint | number): BN => new BN(v.toString());
const orderType = (name: OrderTypeName) => ({ [name]: {} }) as never;
const bytes32 = (b: Uint8Array): number[] => {
  if (b.length !== 32) throw new Error('expected 32 bytes');
  return Array.from(b);
};
const writable = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
/** The accounts every event-emitting instruction takes for its event self-CPI. */
const eventCpi = () => ({ eventAuthority: eventAuthorityPda(), program: PROPS_VAULT_PROGRAM_ID });
/** Anchor's tag on the data of an event self-CPI (`EVENT_IX_TAG_LE`), ahead of the event discriminator and body. */
const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const readonly = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

export interface VaultEvent {
  /** camelCase event name, e.g. "orderRequested" for the IDL's `OrderRequested`. */
  name: string;
  /** Decoded fields: u64/u128/i64 as BN, pubkeys as PublicKey. */
  data: Record<string, unknown>;
}

/** An instruction as a confirmed transaction records it: the program it invoked and its data. */
export interface InvokedInstruction {
  programId: PublicKey;
  data: Uint8Array;
}

/** A funded account address with its decoded state (needed by builders that act on tracked orders). */
export interface FundedRef {
  address: PublicKey;
  account: FundedAccount;
}

/** An instruction that creates a GMTrade order, with the order's address. */
export interface OrderInstruction {
  instruction: TransactionInstruction;
  order: PublicKey;
}

function isFreeKey(key: PublicKey): boolean {
  return key.equals(PublicKey.default);
}

/**
 * GMTrade accounts shared by every order-creating instruction of a funded account. The order address
 * follows the account's order counter, so `funded` must be current; `ordersBefore` counts the orders the
 * same transaction creates ahead of this one.
 */
function gmOrderAccounts(funded: FundedRef, marketToken: PublicKey, isLong: boolean, ordersBefore = 0) {
  const owner = ownerPda(funded.address);
  const gmOrder = gmOrderPda(owner, orderNonce(BigInt(funded.account.orderSeq.toString()) + BigInt(ordersBefore)));
  return {
    owner,
    marketConfig: marketConfigPda(marketToken),
    usdcMint: USDC_MINT,
    gmStore: GMTRADE_STORE,
    gmMarket: gmMarketPda(marketToken),
    gmUser: gmUserPda(owner),
    gmPosition: gmPositionPda(owner, marketToken, isLong),
    gmOrder,
    orderEscrow: gmOrderEscrow(gmOrder),
    gmEventAuthority: gmEventAuthority(),
    gmtradeProgram: GMTRADE_PROGRAM_ID,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}

/**
 * props_vault client. Instruction builders are pure: they derive every account (props_vault and
 * GMTrade) themselves and never touch the network. Only the `fetch*` helpers use the connection.
 */
export class PropsVaultClient {
  readonly connection: Connection;
  readonly program: Program<PropsVault>;

  constructor(connection: Connection) {
    this.connection = connection;
    this.program = new Program(idl as PropsVault, { connection });
  }

  // ---------- decoding + fetching ----------

  decode<N extends AccountName>(name: N, data: Uint8Array): IdlAccounts<PropsVault>[N] {
    return this.program.coder.accounts.decode(name, Buffer.from(data));
  }

  /**
   * props_vault events in emission order (camelCase names and fields), from a successful transaction's inner
   * instructions (`innerInstructionsOf`). The program emits every event as a self-CPI (Anchor `emit_cpi!`), which the
   * runtime records in full; log lines would be cut off once a transaction's logs pass 10 KB.
   */
  parseEvents(inner: Iterable<InvokedInstruction>): VaultEvent[] {
    const events: VaultEvent[] = [];
    for (const ix of inner) {
      const data = Buffer.from(ix.data);
      if (!ix.programId.equals(this.program.programId) || !data.subarray(0, 8).equals(EVENT_IX_TAG)) continue;
      const event = this.program.coder.events.decode(data.subarray(8).toString('base64'));
      if (event) events.push({ name: event.name, data: event.data as Record<string, unknown> });
    }
    return events;
  }

  async fetch<N extends AccountName>(name: N, address: PublicKey): Promise<IdlAccounts<PropsVault>[N] | null> {
    const info = await this.connection.getAccountInfo(address);
    return info ? this.decode(name, info.data) : null;
  }

  fetchConfig(): Promise<ConfigAccount | null> {
    return this.fetch('config', configPda());
  }

  fetchFunded(address: PublicKey): Promise<FundedAccount | null> {
    return this.fetch('fundedAccount', address);
  }

  /** All GMTrade Position accounts owned by a funded account's owner PDA (for payout and closure re-checks). */
  async fetchOwnerPositions(funded: PublicKey): Promise<PublicKey[]> {
    const accounts = await this.connection.getProgramAccounts(GMTRADE_PROGRAM_ID, {
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { dataSize: POSITION_LAYOUT.length },
        { memcmp: { offset: 0, bytes: btoa(String.fromCharCode(...POSITION_DISCRIMINATOR)), encoding: 'base64' } },
        { memcmp: { offset: POSITION_LAYOUT.owner, bytes: ownerPda(funded).toBase58() } },
      ],
    });
    return accounts.map((a) => a.pubkey);
  }

  // ---------- admin ----------

  /** Signer must be the program's upgrade authority. */
  initialize(p: { admin: PublicKey; params: ConfigParams }): Promise<TransactionInstruction> {
    const vault = vaultAuthorityPda();
    return this.program.methods
      .initialize(p.params)
      .accountsStrict({
        admin: p.admin,
        config: configPda(),
        vault,
        feeVault: feeVaultPda(),
        capitalVault: capitalVaultAddress(),
        solTreasury: solTreasuryPda(),
        usdcMint: USDC_MINT,
        gmtradeProgram: GMTRADE_PROGRAM_ID,
        gmtradeStore: GMTRADE_STORE,
        program: PROPS_VAULT_PROGRAM_ID,
        programData: PublicKey.findProgramAddressSync([PROPS_VAULT_PROGRAM_ID.toBytes()], BPF_LOADER_UPGRADEABLE)[0],
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        eventAuthority: eventAuthorityPda(),
      })
      .instruction();
  }

  proposeAdmin(p: { admin: PublicKey; newAdmin: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.proposeAdmin(p.newAdmin).accountsStrict({ ...eventCpi(), admin: p.admin, config: configPda() }).instruction();
  }

  acceptAdmin(p: { newAdmin: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.acceptAdmin().accountsStrict({ ...eventCpi(), newAdmin: p.newAdmin, config: configPda() }).instruction();
  }

  setAuthorities(p: { admin: PublicKey; riskAuthorities: PublicKey[]; kycAuthority: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods
      .setAuthorities(p.riskAuthorities, p.kycAuthority)
      .accountsStrict({ ...eventCpi(), admin: p.admin, config: configPda() })
      .instruction();
  }

  setParams(p: { admin: PublicKey; params: ConfigParams }): Promise<TransactionInstruction> {
    return this.program.methods.setParams(p.params).accountsStrict({ ...eventCpi(), admin: p.admin, config: configPda() }).instruction();
  }

  setPauses(p: { admin: PublicKey; paused: Pauses }): Promise<TransactionInstruction> {
    return this.program.methods.setPauses(p.paused).accountsStrict({ ...eventCpi(), admin: p.admin, config: configPda() }).instruction();
  }

  upsertTier(p: { admin: PublicKey; id: number; params: TierParams }): Promise<TransactionInstruction> {
    return this.program.methods
      .upsertTier(p.id, p.params)
      .accountsStrict({ ...eventCpi(), admin: p.admin, config: configPda(), tier: tierPda(p.id), systemProgram: SystemProgram.programId })
      .instruction();
  }

  upsertMarket(p: { admin: PublicKey; marketToken: PublicKey; params: MarketParams }): Promise<TransactionInstruction> {
    return this.program.methods
      .upsertMarket(p.marketToken, p.params)
      .accountsStrict({
        ...eventCpi(),
        admin: p.admin,
        config: configPda(),
        marketConfig: marketConfigPda(p.marketToken),
        gmMarket: gmMarketPda(p.marketToken),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  private moveCapitalAccounts(admin: PublicKey, adminUsdc?: PublicKey) {
    return {
      admin,
      config: configPda(),
      adminUsdc: adminUsdc ?? getAssociatedTokenAddressSync(USDC_MINT, admin, true),
      vault: vaultAuthorityPda(),
      capitalVault: capitalVaultAddress(),
      usdcMint: USDC_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }

  /** `amount` in USDC base units, from the admin's USDC account (default: its ATA). */
  depositCapital(p: { admin: PublicKey; amount: bigint; adminUsdc?: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.depositCapital(bn(p.amount)).accountsStrict({ ...eventCpi(), ...this.moveCapitalAccounts(p.admin, p.adminUsdc) }).instruction();
  }

  withdrawCapital(p: { admin: PublicKey; amount: bigint; adminUsdc?: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.withdrawCapital(bn(p.amount)).accountsStrict({ ...eventCpi(), ...this.moveCapitalAccounts(p.admin, p.adminUsdc) }).instruction();
  }

  sweepFees(p: { admin: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods
      .sweepFees()
      .accountsStrict({
        ...eventCpi(),
        admin: p.admin,
        config: configPda(),
        vault: vaultAuthorityPda(),
        feeVault: feeVaultPda(),
        capitalVault: capitalVaultAddress(),
        usdcMint: USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  withdrawSolTreasury(p: { admin: PublicKey; lamports: bigint }): Promise<TransactionInstruction> {
    return this.program.methods
      .withdrawSolTreasury(bn(p.lamports))
      .accountsStrict({ ...eventCpi(), admin: p.admin, config: configPda(), solTreasury: solTreasuryPda(), systemProgram: SystemProgram.programId })
      .instruction();
  }

  // ---------- trader ----------

  /** `index` = the trader profile's evaluation count (0 when the profile does not exist yet). */
  buyEvaluation(p: { trader: PublicKey; tierId: number; index: number; traderUsdc?: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods
      .buyEvaluation(p.tierId, p.index)
      .accountsStrict({
        ...eventCpi(),
        trader: p.trader,
        config: configPda(),
        tier: tierPda(p.tierId),
        profile: traderProfilePda(p.trader),
        evaluation: evaluationPda(p.trader, p.index),
        traderUsdc: p.traderUsdc ?? getAssociatedTokenAddressSync(USDC_MINT, p.trader, true),
        feeVault: feeVaultPda(),
        usdcMint: USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  activateFunded(p: { trader: PublicKey; evaluation: PublicKey }): Promise<TransactionInstruction> {
    const funded = fundedPda(p.evaluation);
    return this.program.methods
      .activateFunded()
      .accountsStrict({
        ...eventCpi(),
        trader: p.trader,
        config: configPda(),
        profile: traderProfilePda(p.trader),
        evaluation: p.evaluation,
        funded,
        owner: ownerPda(funded),
        ownerUsdc: ownerUsdcAddress(funded),
        vault: vaultAuthorityPda(),
        capitalVault: capitalVaultAddress(),
        solTreasury: solTreasuryPda(),
        usdcMint: USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /**
   * Market or limit increase. Amounts: `collateral` USDC base units, `sizeDeltaUsd` GMTrade USD,
   * prices GMTrade unit prices (see `toUnitPrice` / `acceptablePrice`). The order address follows the
   * account's order counter, so `funded` must be freshly fetched; `ordersBefore` counts the orders the
   * same transaction creates ahead of this one (e.g. 1 for a stop-loss placed right after an open).
   */
  async openPosition(p: {
    trader: PublicKey;
    funded: FundedRef;
    marketToken: PublicKey;
    isLong: boolean;
    orderType: 'market' | 'limit';
    collateral: bigint;
    sizeDeltaUsd: bigint;
    triggerPrice?: bigint;
    acceptablePrice: bigint;
    ordersBefore?: number;
  }): Promise<OrderInstruction> {
    const accounts = gmOrderAccounts(p.funded, p.marketToken, p.isLong, p.ordersBefore);
    const instruction = await this.program.methods
      .openPosition({
        isLong: p.isLong,
        orderType: orderType(p.orderType),
        collateral: bn(p.collateral),
        sizeDeltaUsd: bn(p.sizeDeltaUsd),
        triggerPrice: bn(p.triggerPrice ?? 0n),
        acceptablePrice: bn(p.acceptablePrice),
      })
      .accountsStrict({ ...eventCpi(), trader: p.trader, config: configPda(), funded: p.funded.address, ownerUsdc: ownerUsdcAddress(p.funded.address), ...accounts })
      .instruction();
    return { instruction, order: accounts.gmOrder };
  }

  /**
   * Market decrease by the trader or a risk authority; `CLOSE_ALL` closes the whole position. The size
   * must be at least $1. `funded` / `ordersBefore` as in `openPosition`.
   */
  async closePosition(p: {
    authority: PublicKey;
    funded: FundedRef;
    marketToken: PublicKey;
    isLong: boolean;
    sizeDeltaUsd: bigint;
    acceptablePrice: bigint;
    ordersBefore?: number;
  }): Promise<OrderInstruction> {
    const accounts = gmOrderAccounts(p.funded, p.marketToken, p.isLong, p.ordersBefore);
    const instruction = await this.program.methods
      .closePosition({ isLong: p.isLong, sizeDeltaUsd: bn(p.sizeDeltaUsd), acceptablePrice: bn(p.acceptablePrice) })
      .accountsStrict({ ...eventCpi(), authority: p.authority, config: configPda(), funded: p.funded.address, ...accounts })
      .instruction();
    return { instruction, order: accounts.gmOrder };
  }

  /** Take-profit or stop-loss of at least $1. `funded` / `ordersBefore` as in `openPosition`. */
  async setProtection(p: {
    trader: PublicKey;
    funded: FundedRef;
    marketToken: PublicKey;
    isLong: boolean;
    orderType: 'takeProfit' | 'stopLoss';
    triggerPrice: bigint;
    sizeDeltaUsd: bigint;
    ordersBefore?: number;
  }): Promise<OrderInstruction> {
    const accounts = gmOrderAccounts(p.funded, p.marketToken, p.isLong, p.ordersBefore);
    const instruction = await this.program.methods
      .setProtection({
        isLong: p.isLong,
        orderType: orderType(p.orderType),
        triggerPrice: bn(p.triggerPrice),
        sizeDeltaUsd: bn(p.sizeDeltaUsd),
      })
      .accountsStrict({ ...eventCpi(), authority: p.trader, config: configPda(), funded: p.funded.address, ...accounts })
      .instruction();
    return { instruction, order: accounts.gmOrder };
  }

  /** Market token of a tracked order's slot. */
  private trackedOrderMarket(funded: FundedRef, order: PublicKey): PublicKey {
    const tracked = funded.account.orders.find((o) => o.order.equals(order));
    if (!tracked) throw new Error(`order ${order.toBase58()} is not tracked by ${funded.address.toBase58()}`);
    const slot = funded.account.slots[tracked.slot];
    if (!slot) throw new Error('tracked order points at a missing slot');
    return slot.marketToken;
  }

  updateOrder(p: {
    trader: PublicKey;
    funded: FundedRef;
    order: PublicKey;
    triggerPrice?: bigint;
    acceptablePrice?: bigint;
    sizeDeltaUsd?: bigint;
  }): Promise<TransactionInstruction> {
    const marketToken = this.trackedOrderMarket(p.funded, p.order);
    const opt = (v?: bigint) => (v === undefined ? null : bn(v));
    return this.program.methods
      .updateOrder({ triggerPrice: opt(p.triggerPrice), acceptablePrice: opt(p.acceptablePrice), sizeDeltaUsd: opt(p.sizeDeltaUsd) })
      .accountsStrict({
        ...eventCpi(),
        trader: p.trader,
        config: configPda(),
        funded: p.funded.address,
        owner: ownerPda(p.funded.address),
        marketConfig: marketConfigPda(marketToken),
        gmStore: GMTRADE_STORE,
        gmMarket: gmMarketPda(marketToken),
        gmOrder: p.order,
        gmEventAuthority: gmEventAuthority(),
        gmtradeProgram: GMTRADE_PROGRAM_ID,
      })
      .instruction();
  }

  private closeOrderAccounts(funded: PublicKey, order: PublicKey) {
    const owner = ownerPda(funded);
    return {
      config: configPda(),
      funded,
      owner,
      ownerUsdc: ownerUsdcAddress(funded),
      usdcMint: USDC_MINT,
      gmStore: GMTRADE_STORE,
      gmStoreWallet: gmStoreWallet(),
      gmUser: gmUserPda(owner),
      gmOrder: order,
      orderEscrow: gmOrderEscrow(order),
      gmEventAuthority: gmEventAuthority(),
      gmtradeProgram: GMTRADE_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
  }

  /** Trader or risk authority. */
  cancelOrder(p: { authority: PublicKey; funded: FundedRef; order: PublicKey }): Promise<TransactionInstruction> {
    const marketToken = this.trackedOrderMarket(p.funded, p.order);
    return this.program.methods
      .cancelOrder()
      .accountsStrict({ ...eventCpi(), authority: p.authority, marketConfig: marketConfigPda(marketToken), ...this.closeOrderAccounts(p.funded.address, p.order) })
      .instruction();
  }

  /** `payoutSeq` = the funded account's current `payoutSeq`. */
  requestPayout(p: { trader: PublicKey; funded: PublicKey; payoutSeq: number }): Promise<TransactionInstruction> {
    const owner = ownerPda(p.funded);
    return this.program.methods
      .requestPayout()
      .accountsStrict({
        ...eventCpi(),
        trader: p.trader,
        config: configPda(),
        funded: p.funded,
        owner,
        ownerUsdc: ownerUsdcAddress(p.funded),
        usdcMint: USDC_MINT,
        payout: payoutPda(p.funded, p.payoutSeq),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  cancelPayout(p: { trader: PublicKey; funded: PublicKey; payout: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods
      .cancelPayout()
      .accountsStrict({ ...eventCpi(), trader: p.trader, funded: p.funded, payout: p.payout })
      .instruction();
  }

  // ---------- KYC + risk authorities ----------

  setIdentity(p: { kycAuthority: PublicKey; wallet: PublicKey; identityHash: Uint8Array }): Promise<TransactionInstruction> {
    return this.program.methods
      .setIdentity(p.wallet, bytes32(p.identityHash))
      .accountsStrict({
        ...eventCpi(),
        kycAuthority: p.kycAuthority,
        config: configPda(),
        profile: traderProfilePda(p.wallet),
        identityLock: identityLockPda(p.identityHash),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** `finalEquity` in micro-USD; `tradesRoot` = sha256 Merkle root over the canonical fill list. */
  recordEvaluationResult(p: {
    riskAuthority: PublicKey;
    evaluation: PublicKey;
    passed: boolean;
    finalEquity: bigint;
    tradesRoot: Uint8Array;
  }): Promise<TransactionInstruction> {
    return this.program.methods
      .recordEvaluationResult(p.passed, bn(p.finalEquity), bytes32(p.tradesRoot))
      .accountsStrict({ ...eventCpi(), riskAuthority: p.riskAuthority, config: configPda(), evaluation: p.evaluation })
      .instruction();
  }

  /**
   * `positions`: the owner PDA's existing GMTrade positions to re-check as flat (`fetchOwnerPositions`);
   * an address without an account proves nothing and is refused.
   */
  approvePayout(p: { riskAuthority: PublicKey; funded: FundedRef; payout: PublicKey; positions?: PublicKey[] }): Promise<TransactionInstruction> {
    const trader = p.funded.account.trader;
    return this.program.methods
      .approvePayout()
      .accountsStrict({
        ...eventCpi(),
        riskAuthority: p.riskAuthority,
        config: configPda(),
        funded: p.funded.address,
        payout: p.payout,
        owner: ownerPda(p.funded.address),
        ownerUsdc: ownerUsdcAddress(p.funded.address),
        trader,
        traderUsdc: getAssociatedTokenAddressSync(USDC_MINT, trader, true),
        capitalVault: capitalVaultAddress(),
        solTreasury: solTreasuryPda(),
        usdcMint: USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts((p.positions ?? []).map(readonly))
      .instruction();
  }

  rejectPayout(p: { riskAuthority: PublicKey; funded: PublicKey; payout: PublicKey; reasonCode: number }): Promise<TransactionInstruction> {
    return this.program.methods
      .rejectPayout(p.reasonCode)
      .accountsStrict({ ...eventCpi(), riskAuthority: p.riskAuthority, config: configPda(), funded: p.funded, payout: p.payout })
      .instruction();
  }

  restrict(p: { riskAuthority: PublicKey; funded: PublicKey; restricted: boolean }): Promise<TransactionInstruction> {
    return this.program.methods
      .restrict(p.restricted)
      .accountsStrict({ ...eventCpi(), riskAuthority: p.riskAuthority, config: configPda(), funded: p.funded })
      .instruction();
  }

  markBreached(p: { riskAuthority: PublicKey; funded: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods
      .markBreached()
      .accountsStrict({ ...eventCpi(), riskAuthority: p.riskAuthority, config: configPda(), funded: p.funded })
      .instruction();
  }

  /** `positions` as in `approvePayout`. */
  closeFunded(p: { riskAuthority: PublicKey; funded: FundedRef; positions?: PublicKey[] }): Promise<TransactionInstruction> {
    return this.program.methods
      .closeFunded()
      .accountsStrict({
        ...eventCpi(),
        riskAuthority: p.riskAuthority,
        config: configPda(),
        funded: p.funded.address,
        profile: traderProfilePda(p.funded.account.trader),
        owner: ownerPda(p.funded.address),
        ownerUsdc: ownerUsdcAddress(p.funded.address),
        capitalVault: capitalVaultAddress(),
        solTreasury: solTreasuryPda(),
        usdcMint: USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts((p.positions ?? []).map(readonly))
      .instruction();
  }

  // ---------- permissionless cranks ----------

  /** Remaining accounts follow the program's order: slot positions, tracked orders, distinct market configs. */
  sync(p: { funded: FundedRef }): Promise<TransactionInstruction> {
    const { slots, orders } = p.funded.account;
    const used = slots.filter((s) => !isFreeKey(s.marketToken));
    const markets: PublicKey[] = [];
    for (const s of used) if (!markets.some((m) => m.equals(s.marketToken))) markets.push(s.marketToken);
    const remaining = [
      ...used.map((s) => readonly(s.gmPosition)),
      ...orders.filter((o) => !isFreeKey(o.order)).map((o) => readonly(o.order)),
      ...markets.map((m) => writable(marketConfigPda(m))),
    ];
    return this.program.methods
      .sync()
      .accountsStrict({ ...eventCpi(), config: configPda(), funded: p.funded.address })
      .remainingAccounts(remaining)
      .instruction();
  }

  topUpOwner(p: { funded: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods
      .topUpOwner()
      .accountsStrict({
        ...eventCpi(),
        config: configPda(),
        funded: p.funded,
        owner: ownerPda(p.funded),
        solTreasury: solTreasuryPda(),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  closeCompletedOrder(p: { funded: PublicKey; order: PublicKey }): Promise<TransactionInstruction> {
    return this.program.methods.closeCompletedOrder().accountsStrict({ ...eventCpi(), ...this.closeOrderAccounts(p.funded, p.order) }).instruction();
  }
}
