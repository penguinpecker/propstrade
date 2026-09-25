// Wallet-signed props_vault transactions, built in the browser with @props/sdk. Loaded on demand (see
// transactions.ts) so Anchor, spl-token and the program IDL stay out of the entry chunk.
import './buffer';
import bs58 from 'bs58';
import {
  CLOSE_ALL, GMTRADE_PROGRAM_ID, PROPS_VAULT_IDL, PROPS_VAULT_PROGRAM_ID, PropsVaultClient, acceptablePrice, buildTransaction, decodeGmMarketMeta, decodeGmPosition,
  evaluationPda, fundedPda, gmPositionPda, marketConfigPda, ownerPda, payoutPda, tierPda, toMicro, toUnitPrice, traderProfilePda, usdToGm,
  type FundedRef,
} from '@props/sdk';
import { ComputeBudgetProgram, PublicKey, SendTransactionError, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { AccountInfo, Connection, TransactionError, TransactionInstruction } from '@solana/web3.js';
import type { Tier } from '@props/shared';

/** An unsigned transaction with everything the interface shows before the wallet asks for approval. */
export interface Prepared {
  tx: VersionedTransaction;
  lastValidBlockHeight: number;
  /** Network fee of this exact message, lamports. */
  feeLamports: number;
  /** Rent the trader deposits for accounts the transaction creates, lamports. */
  rentLamports: number;
}

/**
 * A failure with a plain-English reason that is safe to show as is. `uncertain`: the transaction was signed and may
 * still land (the send or the status reads failed in transit), so its signature must be followed before any retry.
 */
export class TxError extends Error {
  constructor(message: string, readonly signature?: string, readonly uncertain = false) {
    super(message);
    this.name = 'TxError';
  }
}

export type Signer = (tx: VersionedTransaction) => Promise<VersionedTransaction>;

const clients = new WeakMap<Connection, PropsVaultClient>();
function client(connection: Connection): PropsVaultClient {
  let c = clients.get(connection);
  if (!c) clients.set(connection, (c = new PropsVaultClient(connection)));
  return c;
}

/** Transactions only work against the program this build's SDK was generated for. */
export function assertProgram(programId: string) {
  if (programId !== PROPS_VAULT_PROGRAM_ID.toBase58())
    throw new TxError('The Props.trade service uses a different program than this app. Reload the page to update.');
}

/** Solana's per-transaction maximum. Transactions are built with it and cut to their simulated use before signing. */
const MAX_COMPUTE_UNITS = 1_400_000;

async function prepare(connection: Connection, payer: PublicKey, instructions: TransactionInstruction[], rentLamports = 0): Promise<Prepared> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = buildTransaction({ payer, instructions, recentBlockhash: blockhash, computeUnits: MAX_COMPUTE_UNITS });
  const fee = await connection.getFeeForMessage(tx.message, 'confirmed');
  // No compute-unit price is set, so the fee is the base fee per signature (whatever the unit limit), also when the
  // RPC cannot quote it.
  return { tx, lastValidBlockHeight, feeLamports: fee.value ?? 5000 * tx.message.header.numRequiredSignatures, rentLamports };
}

/**
 * The same transaction with its compute-unit limit set to its simulated use plus 20%. GMTrade's cost varies with the
 * PDA bump searches of each account's order addresses (open + TP + SL measured 377k–445k CU), so no fixed limit fits.
 */
function withComputeLimit(tx: VersionedTransaction, unitsConsumed: number): VersionedTransaction {
  const units = Math.min(MAX_COMPUTE_UNITS, Math.ceil(unitsConsumed * 1.2));
  const message = TransactionMessage.decompile(tx.message);
  message.instructions = message.instructions.map(ix =>
    ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2 ? ComputeBudgetProgram.setComputeUnitLimit({ units }) : ix);
  return new VersionedTransaction(message.compileToV0Message());
}

const rent = async (connection: Connection, sizes: number[]) =>
  (await Promise.all(sizes.map(size => connection.getMinimumBalanceForRentExemption(size)))).reduce((a, b) => a + b, 0);

/** A price as a number input gives it ("64000", "0.5", ".5", "2e-5") in plain decimal digits, without float rounding. */
function plainDecimal(price: string): { whole: string; fraction: string } {
  const match = /^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(price.trim());
  if (!match || !(match[1] || match[2])) throw new TxError(`"${price}" is not a valid price.`);
  const digits = (match[1] ?? '') + (match[2] ?? '');
  const point = (match[1] ?? '').length + Number(match[3] ?? 0);
  if (point <= 0) return { whole: '0', fraction: '0'.repeat(-point) + digits };
  return { whole: digits.slice(0, point).padEnd(point, '0'), fraction: digits.slice(point) };
}

/** GMTrade unit price of a decimal USD price; digits beyond the unit's precision are dropped. */
export function unitPrice(price: string, indexTokenDecimals: number): bigint {
  const { whole, fraction } = plainDecimal(price);
  return toUnitPrice(`${whole}.${fraction.slice(0, 20 - indexTokenDecimals) || '0'}`, indexTokenDecimals);
}

const positive = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) throw new TxError('Enter an amount greater than zero.');
  return value;
};
/** USD amount with at most 6 decimals, as the program's micro-USD and GMTrade's 10^20 USD both accept. */
const usd6 = (value: number) => positive(value).toFixed(6);
/**
 * Collateral in micro-USDC, rounded up: rounding size ÷ leverage down would put the order above the leverage it was
 * computed from, and the program rejects that at the market's maximum. 15 significant digits drop the float noise.
 */
const collateralMicro = (usd: number) => BigInt(Math.ceil(Number((positive(usd) * 1e6).toPrecision(15))));

async function fundedRef(connection: Connection, funded: string): Promise<FundedRef> {
  const address = new PublicKey(funded);
  const account = await client(connection).fetchFunded(address);
  if (!account) throw new TxError('The funded account was not found onchain yet. Try again in a few seconds.');
  return { address, account };
}

/** A GMTrade position's size; an address GMTrade does not own holds none (never opened, closed, or only sent lamports since). */
const heldSize = (info: AccountInfo<Buffer> | null | undefined) => info?.owner.equals(GMTRADE_PROGRAM_ID) ? decodeGmPosition(info.data).sizeInUsd : 0n;

async function positionSize(connection: Connection, position: PublicKey): Promise<bigint> {
  return heldSize(await connection.getAccountInfo(position, 'confirmed'));
}

// ---------- evaluation purchase + funded activation ----------

/**
 * The program charges the tier account's fee and pins its terms, so the tier the trader reviewed (from the API) must
 * match it exactly; otherwise nothing is built. The purchase carries the reviewed fee and tier version, and the program
 * refuses it if the tier changes before it lands.
 */
export async function prepareEvaluation(connection: Connection, trader: PublicKey, tier: Pick<Tier, 'id' | 'feeUsdc' | 'version' | 'termsHash'>) {
  const c = client(connection);
  const [onchain, profile] = await Promise.all([c.fetch('tier', tierPda(tier.id)), c.fetch('traderProfile', traderProfilePda(trader))]);
  if (!onchain) throw new TxError('This evaluation is not available onchain.');
  if (BigInt(onchain.feeUsdc.toString()) !== toMicro(tier.feeUsdc) || onchain.version !== tier.version || Buffer.from(onchain.termsHash).toString('hex') !== tier.termsHash)
    throw new TxError('This evaluation\'s fee or terms changed since the page loaded. Reload the page to review the current terms.');
  const index = profile?.evaluationCount ?? 0;
  const instruction = await c.buyEvaluation({ trader, tierId: tier.id, index, feeUsdc: toMicro(tier.feeUsdc), tierVersion: tier.version });
  const sizes = [c.program.account.evaluation.size, ...(profile ? [] : [c.program.account.traderProfile.size])];
  return { ...(await prepare(connection, trader, [instruction], await rent(connection, sizes))), evaluation: evaluationPda(trader, index).toBase58() };
}

export async function prepareActivation(connection: Connection, trader: PublicKey, evaluation: string) {
  const c = client(connection);
  const address = new PublicKey(evaluation);
  const instruction = await c.activateFunded({ trader, evaluation: address });
  const deposit = await rent(connection, [c.program.account.fundedAccount.size]);
  return { ...(await prepare(connection, trader, [instruction], deposit)), funded: fundedPda(address).toBase58() };
}

export async function preparePayoutRequest(connection: Connection, trader: PublicKey, funded: string) {
  const c = client(connection);
  const ref = await fundedRef(connection, funded);
  const instruction = await c.requestPayout({ trader, funded: ref.address, payoutSeq: ref.account.payoutSeq });
  const deposit = await rent(connection, [c.program.account.payoutRequest.size]);
  return { ...(await prepare(connection, trader, [instruction], deposit)), payout: payoutPda(ref.address, ref.account.payoutSeq).toBase58() };
}

// ---------- funded trading ----------

/** A market as the trader sees it (from the API); every order checks it onchain first (onchainMarket). */
export interface MarketRef { marketToken: string; symbol: string }

/** An SPL mint's `decimals` byte. */
const MINT_DECIMALS_OFFSET = 44;

/**
 * The market an order goes to, as the chain has it rather than as the API describes it: its MarketConfig (which the
 * program checks every order against) must name the symbol the trader is looking at, and the index token's decimals,
 * which scale every signed trigger and acceptable price, come from the index token's mint, through the GMTrade Market
 * the config pins.
 */
async function onchainMarket(connection: Connection, market: MarketRef): Promise<{ marketToken: PublicKey; decimals: number }> {
  const marketToken = new PublicKey(market.marketToken);
  const unconfirmed = new TxError(`The ${market.symbol} market could not be confirmed onchain, so nothing was built. Reload the page and try again.`);
  const config = await client(connection).fetch('marketConfig', marketConfigPda(marketToken));
  if (!config || Buffer.from(config.indexSymbol).toString('utf8').replace(/\0+$/, '') !== market.symbol) throw unconfirmed;
  const gm = await connection.getAccountInfo(config.gmMarket, 'confirmed');
  let indexToken: PublicKey;
  try {
    if (!gm?.owner.equals(GMTRADE_PROGRAM_ID)) throw unconfirmed;
    indexToken = decodeGmMarketMeta(gm.data).indexToken;
  } catch {
    throw unconfirmed;
  }
  const mint = await connection.getAccountInfo(indexToken, 'confirmed');
  if (!mint || mint.data.length <= MINT_DECIMALS_OFFSET) throw unconfirmed;
  return { marketToken, decimals: mint.data[MINT_DECIMALS_OFFSET]! };
}

/** A GMTrade order a transaction created, and the position it changes, to follow until a keeper executes or cancels it. */
export interface OrderFollow { order: string; position: string; sizeBefore: bigint; increase: boolean }

export interface OpenInput {
  funded: string;
  market: MarketRef;
  isLong: boolean;
  kind: 'Market' | 'Limit';
  /** Price the slippage applies to: the live mid for market orders, the limit price for limit orders. */
  price: string;
  sizeUsd: number;
  collateralUsd: number;
  slippageBps: number;
  takeProfit?: string;
  stopLoss?: string;
}

/** Opens (or adds to) a position, with optional take-profit and stop-loss orders for the whole position, in one transaction. */
export async function prepareOpen(connection: Connection, trader: PublicKey, input: OpenInput) {
  const c = client(connection);
  const funded = await fundedRef(connection, input.funded);
  const { marketToken, decimals } = await onchainMarket(connection, input.market);
  const reference = unitPrice(input.price, decimals);
  const open = await c.openPosition({
    trader, funded, marketToken, isLong: input.isLong, orderType: input.kind === 'Market' ? 'market' : 'limit',
    collateral: collateralMicro(input.collateralUsd), sizeDeltaUsd: usdToGm(usd6(input.sizeUsd)),
    triggerPrice: input.kind === 'Limit' ? reference : undefined,
    acceptablePrice: acceptablePrice(reference, input.isLong, true, input.slippageBps),
  });
  const instructions = [open.instruction];
  for (const [orderType, price] of [['takeProfit', input.takeProfit], ['stopLoss', input.stopLoss]] as const) {
    if (!price) continue;
    const protection = await c.setProtection({
      trader, funded, marketToken, isLong: input.isLong, orderType, triggerPrice: unitPrice(price, decimals),
      sizeDeltaUsd: CLOSE_ALL, ordersBefore: instructions.length,
    });
    instructions.push(protection.instruction);
  }
  const position = gmPositionPda(ownerPda(funded.address), marketToken, input.isLong);
  const follow: OrderFollow = { order: open.order.toBase58(), position: position.toBase58(), sizeBefore: await positionSize(connection, position), increase: true };
  return { ...(await prepare(connection, trader, instructions)), follows: [follow] };
}

export interface CloseInput {
  funded: string;
  slippageBps: number;
  positions: { market: MarketRef; isLong: boolean; markPrice: string; sizeUsd: number; percent: number }[];
}

/** Market-closes a share of one position, or all of several positions, in one transaction. */
export async function prepareClose(connection: Connection, trader: PublicKey, input: CloseInput) {
  const c = client(connection);
  const funded = await fundedRef(connection, input.funded);
  const instructions: TransactionInstruction[] = [];
  const closes: { order: PublicKey; position: PublicKey }[] = [];
  for (const p of input.positions) {
    const { marketToken, decimals } = await onchainMarket(connection, p.market);
    const size = p.percent >= 100 ? CLOSE_ALL : usdToGm(usd6(p.sizeUsd * p.percent / 100));
    if (size !== CLOSE_ALL && size < usdToGm('1')) throw new TxError('The exchange closes at least $1 of a position. Choose a larger share.');
    const close = await c.closePosition({
      authority: trader, funded, marketToken, isLong: p.isLong, sizeDeltaUsd: size, ordersBefore: instructions.length,
      acceptablePrice: acceptablePrice(unitPrice(p.markPrice, decimals), p.isLong, false, input.slippageBps),
    });
    instructions.push(close.instruction);
    closes.push({ order: close.order, position: gmPositionPda(ownerPda(funded.address), marketToken, p.isLong) });
  }
  if (!closes.length) throw new TxError('There is no position to close.');
  const follows = await Promise.all(closes.map(async ({ order, position }): Promise<OrderFollow> =>
    ({ order: order.toBase58(), position: position.toBase58(), sizeBefore: await positionSize(connection, position), increase: false })));
  return { ...(await prepare(connection, trader, instructions)), follows };
}

export interface ProtectionInput {
  funded: string;
  market: MarketRef;
  isLong: boolean;
  /** For each side: the working order to change or cancel (if any) and the new trigger price (null removes it). */
  takeProfit: { order: string | null; price: string | null };
  stopLoss: { order: string | null; price: string | null };
}

/** Places, moves or cancels a position's take-profit and stop-loss orders in one transaction. */
export async function prepareProtection(connection: Connection, trader: PublicKey, input: ProtectionInput) {
  const c = client(connection);
  const funded = await fundedRef(connection, input.funded);
  const { marketToken, decimals } = await onchainMarket(connection, input.market);
  const instructions: TransactionInstruction[] = [];
  let created = 0;
  for (const [orderType, side] of [['takeProfit', input.takeProfit], ['stopLoss', input.stopLoss]] as const) {
    const triggerPrice = side.price ? unitPrice(side.price, decimals) : null;
    if (side.order && triggerPrice !== null) instructions.push(await c.updateOrder({ trader, funded, order: new PublicKey(side.order), triggerPrice }));
    else if (side.order) instructions.push(await c.cancelOrder({ authority: trader, funded, order: new PublicKey(side.order) }));
    else if (triggerPrice !== null) {
      const placed = await c.setProtection({ trader, funded, marketToken, isLong: input.isLong, orderType, triggerPrice, sizeDeltaUsd: CLOSE_ALL, ordersBefore: created++ });
      instructions.push(placed.instruction);
    }
  }
  if (!instructions.length) throw new TxError('Nothing changed.');
  return prepare(connection, trader, instructions);
}

export async function prepareCancel(connection: Connection, trader: PublicKey, funded: string, order: string) {
  const ref = await fundedRef(connection, funded);
  return prepare(connection, trader, [await client(connection).cancelOrder({ authority: trader, funded: ref, order: new PublicKey(order) })]);
}

// ---------- signing, sending, confirming ----------

// The IDL's messages name GMTrade; the trader reads it as "the exchange".
const PROGRAM_ERRORS = new Map(PROPS_VAULT_IDL.errors.map(e => [e.code, e.msg.replace(/\ba GMTrade\b/g, 'an exchange').replace(/^GMTrade\b/, 'The exchange').replace(/GMTrade/g, 'exchange')]));
const FAILED = /^Program (\w+) failed: custom program error: 0x([0-9a-f]+)/;
const ANCHOR_ERROR = /AnchorError.*Error Number: (\d+)\. Error Message: (.*?)\.?$/;

/** Plain reason for a failed simulation or preflight, from the error and the program logs. */
export function describeFailure(err: TransactionError | string | null, logs: string[] | null | undefined): string {
  const lines = logs ?? [];
  const text = [typeof err === 'string' ? err : JSON.stringify(err), ...lines].join('\n');
  // A failed CPI is logged by the program that threw first; every caller then repeats the same code on its own line.
  const at = lines.findIndex(line => FAILED.test(line));
  const [, program, hex] = at < 0 ? [] : FAILED.exec(lines[at]!)!;
  const code = hex ? parseInt(hex, 16) : null;
  if (program === PROPS_VAULT_PROGRAM_ID.toBase58() && PROGRAM_ERRORS.has(code!)) return `${PROGRAM_ERRORS.get(code!)}.`;
  if (/insufficient funds/i.test(text)) return 'Your wallet does not have enough USDC for this payment.';
  if (/insufficient lamports|InsufficientFundsForRent|InsufficientFundsForFee/i.test(text)) return 'Your wallet does not have enough SOL for the network fee and account deposit.';
  if (/AccountNotFound/.test(text)) return 'Your wallet has no SOL on this network yet.';
  if (/BlockhashNotFound/.test(text)) return 'The transaction expired before it was sent. Try again.';
  if (/ComputationalBudgetExceeded|exceeded CUs meter/.test(text)) return 'The transaction ran out of compute before it finished. Nothing was sent; try again.';
  if (program === GMTRADE_PROGRAM_ID.toBase58()) {
    // GMTrade's own reason, from the Anchor error it logged just before failing.
    const reason = lines.slice(0, at).reverse().map(line => ANCHOR_ERROR.exec(line)).find(m => m && Number(m[1]) === code)?.[2];
    return `The exchange rejected the order${reason ? `: ${reason}` : ''} (error ${code}).`;
  }
  return 'The network rejected the transaction. Nothing was sent.';
}

/**
 * Simulates (no wallet prompt when it would fail), sizes the compute limit from the simulation, asks the wallet to
 * sign, then sends with preflight. The RPC node rebroadcasts until the blockhash expires (no maxRetries).
 */
export async function signAndSend(connection: Connection, prepared: Prepared, sign: Signer): Promise<string> {
  const simulation = await connection.simulateTransaction(prepared.tx, { sigVerify: false, commitment: 'confirmed' });
  if (simulation.value.err) throw new TxError(describeFailure(simulation.value.err, simulation.value.logs));
  const units = simulation.value.unitsConsumed;
  const signed = await sign(units ? withComputeLimit(prepared.tx, units) : prepared.tx);
  const signature = bs58.encode(signed.signatures[0]!);
  try {
    await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: 'confirmed' });
    return signature;
  } catch (error) {
    // The RPC answered with an error (preflight failed): the transaction was not forwarded.
    if (error instanceof SendTransactionError) throw new TxError(describeFailure(error.message, error.logs));
    // The request failed in transit: the node may already have forwarded it, so it can still land.
    throw new TxError('The connection dropped while sending the transaction. It may still go through: follow it before trying again.', signature, true);
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Consecutive failed status reads (about two minutes at the default poll) before the outcome is reported unknown. */
const UNREACHABLE_POLLS = 40;

/**
 * Resolves once the signature is confirmed. Throws TxError when it failed onchain, or when the network moved past the
 * transaction's last valid block height without including it (it can then never land). A failed read never counts as
 * an outcome: polling continues, and only a connection that stays down ends it, with an `uncertain` TxError.
 */
export async function confirm(connection: Connection, signature: string, lastValidBlockHeight: number, pollMs = 1500): Promise<void> {
  const status = async () => (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  for (let failures = 0; ; await sleep(failures ? pollMs * 2 : pollMs)) {
    try {
      let s = await status();
      if (!s && (await connection.getBlockHeight('confirmed')) > lastValidBlockHeight) {
        s = await status(); // it may have been indexed between the two reads
        if (!s) throw new TxError('The transaction expired without being included. Nothing was changed; you can try again.', signature);
      }
      if (s?.err) throw new TxError('The transaction failed onchain. No change was made.', signature);
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return;
      failures = 0;
    } catch (error) {
      if (error instanceof TxError) throw error;
      if (++failures >= UNREACHABLE_POLLS)
        throw new TxError('The Solana connection stopped answering before the transaction was confirmed. It may still go through: check it before trying again.', signature, true);
    }
  }
}

export type Execution = 'executed' | 'cancelled' | 'pending';

/**
 * Follows a GMTrade order after confirmation. GMTrade's keeper closes the order account in the transaction that
 * executes or cancels it, so a missing order account means it finished; the position size tells which.
 */
export async function watchExecution(connection: Connection, p: OrderFollow, { timeoutMs = 90_000, pollMs = 2_000 } = {}): Promise<Execution> {
  const keys = [new PublicKey(p.order), new PublicKey(p.position)];
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(pollMs)) {
    // A failed read says nothing about the order: read again on the next poll.
    const accounts = await connection.getMultipleAccountsInfo(keys, 'confirmed').catch(() => null);
    if (!accounts || accounts[0]) continue;
    const size = heldSize(accounts[1]);
    return (p.increase ? size > p.sizeBefore : size < p.sizeBefore) ? 'executed' : 'cancelled';
  }
  return 'pending';
}
