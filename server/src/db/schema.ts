// Database schema for the whole app. Migrations in ../../drizzle are generated from this file (npm run db:generate).
//
// Units (one rule everywhere):
//   USD and USDC amounts   numeric(38,6), whole units ("12.345678") — the same decimal strings api.ts puts on the wire.
//   prices                 numeric(38,18), USD per index token.
//   token quantities       numeric(38,18).
//   SOL amounts            numeric(38,9).
//   onchain u16 / u32      integer / bigint (Postgres has no unsigned types; the next wider signed type holds all).
//   raw onchain integers   (u64 base units, u128 GMTrade values) stay verbatim inside program_events.data.
// Pubkeys and signatures are base58 text. Timestamps are timestamptz.
// Leader election uses Postgres advisory locks, which need no table (keys in src/lib/leader.ts).
import { sql } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, char, check, foreignKey, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text,
  timestamp, uniqueIndex, uuid, varchar, type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const usd = (name: string) => numeric(name, { precision: 38, scale: 6 });
const price = (name: string) => numeric(name, { precision: 38, scale: 18 });
const tokens = (name: string) => numeric(name, { precision: 38, scale: 18 });
const sol = (name: string) => numeric(name, { precision: 38, scale: 9 });
const at = (name: string) => timestamp(name, { withTimezone: true });
const now = (name: string) => at(name).notNull().defaultNow();
const pubkey = (name: string) => varchar(name, { length: 44 });
const signature = (name: string) => varchar(name, { length: 88 });
const slot = (name: string) => bigint(name, { mode: 'number' });

export const stage = pgEnum('stage', ['practice', 'evaluation', 'funded']);
export const accountStatus = pgEnum('account_status', [
  'active', 'near_limit', 'checking', 'passed', 'breached', 'failed',
  'awaiting_capacity', 'activating', 'restricted', 'payout_pending', 'closure_pending', 'closed',
]);
export const side = pgEnum('side', ['Long', 'Short']);
export const orderKind = pgEnum('order_kind', ['Market', 'Limit', 'TakeProfit', 'StopLoss']);
export const orderStatus = pgEnum('order_status', [
  'draft', 'signing', 'submitted', 'awaiting_execution', 'awaiting_price', 'executed', 'canceled', 'rejected', 'frozen', 'unknown',
]);
export const venue = pgEnum('venue', ['simulated', 'gmtrade']);
export const activityType = pgEnum('activity_type', [
  'order', 'fill', 'cancel', 'protection', 'liquidation', 'charge', 'account', 'payout', 'risk',
]);
export const activityStatus = pgEnum('activity_status', ['pending', 'confirmed', 'failed', 'indexing']);
export const evaluationStatus = pgEnum('evaluation_status', ['active', 'passed', 'failed', 'funded', 'refunded']);
export const fundedStatus = pgEnum('funded_status', ['active', 'restricted', 'payout_pending', 'breached', 'closed']);
export const payoutStatus = pgEnum('payout_status', ['requested', 'reviewing', 'paid', 'rejected', 'cancelled', 'uncertain']);
export const ledgerDirection = pgEnum('ledger_direction', ['in', 'out', 'internal']);
export const notificationKind = pgEnum('notification_kind', ['fill', 'risk', 'payout', 'account']);
export const kycStatus = pgEnum('kyc_status', ['pending', 'approved', 'rejected']);
export const chainJobKind = pgEnum('chain_job_kind', ['set_identity', 'record_evaluation_result', 'approve_payout', 'reject_payout', 'lift_restriction', 'close_funded']);
export const chainJobStatus = pgEnum('chain_job_status', ['queued', 'sent', 'confirmed', 'failed']);
export const orderFeeState = pgEnum('order_fee_state', ['assessed', 'released', 'due']);
export const feeSettlementStatus = pgEnum('fee_settlement_status', ['sent', 'confirmed', 'failed']);

// ---------- identity + auth ----------

/** Wallets that have signed in. Referral fields: src/routes/referrals.ts. */
export const users = pgTable('users', {
  wallet: pubkey('wallet').primaryKey(),
  createdAt: now('created_at'),
  lastLoginAt: now('last_login_at'),
  /** The shortest prefix of the wallet, 8 characters or more, upper-cased, that no other user held when it was given
   *  (at the first sign-in; the boot backfill for older users). Never changes; upper case makes the unique constraint
   *  case-insensitive. */
  referralCode: text('referral_code').unique(),
  /** The referrer's wallet, bound once and never changed. */
  referredBy: pubkey('referred_by').references((): AnyPgColumn => users.wallet),
  referredAt: at('referred_at'),
}, (t) => [
  check('users_referral_code_upper', sql`${t.referralCode} = upper(${t.referralCode})`),
  index('users_referred_by_idx').on(t.referredBy),
]);

/** Sign-In With Solana nonces: single use, bound to one wallet and the exact message issued. */
export const authNonces = pgTable('auth_nonces', {
  nonce: varchar('nonce', { length: 64 }).primaryKey(),
  wallet: pubkey('wallet').notNull(),
  message: text('message').notNull(),
  createdAt: now('created_at'),
  expiresAt: at('expires_at').notNull(),
  usedAt: at('used_at'),
}, (t) => [index('auth_nonces_expires_at_idx').on(t.expiresAt)]);

/** Cookie sessions. token_hash = HMAC-SHA256(SESSION_SECRET, cookie token); the token itself is never stored. */
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  wallet: pubkey('wallet').notNull().references(() => users.wallet, { onDelete: 'cascade' }),
  tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
  createdAt: now('created_at'),
  expiresAt: at('expires_at').notNull(),
}, (t) => [index('sessions_wallet_idx').on(t.wallet)]);

// ---------- accounts (all stages) + simulated engine state ----------

/**
 * One row per trading account, whatever the stage; id matches api.ts AccountSummary.id
 * ("practice:<wallet>", or the Evaluation / FundedAccount PDA). Wallets here need not have signed in.
 */
export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  wallet: pubkey('wallet').notNull(),
  stage: stage('stage').notNull(),
  status: accountStatus('status').notNull(),
  label: text('label').notNull(),
  tierId: integer('tier_id'),
  evaluation: pubkey('evaluation'),
  funded: pubkey('funded'),
  sizeUsd: usd('size_usd').notNull(),
  lossAllowanceUsd: usd('loss_allowance_usd').notNull(),
  profitTargetUsd: usd('profit_target_usd'),
  maxExposureBps: integer('max_exposure_bps').notNull(),
  traderShareBps: integer('trader_share_bps').notNull(),
  termsHash: text('terms_hash'),
  termsVersion: integer('terms_version'),
  realizedPnl: usd('realized_pnl').notNull().default('0'),
  /** Practice and evaluation: Props.trade fees charged at the fills so far (simulated; in realized_pnl too). */
  platformFeesUsd: usd('platform_fees_usd').notNull().default('0'),
  createdAt: now('created_at'),
  activatedAt: at('activated_at'),
  resolvedAt: at('resolved_at'),
  updatedAt: now('updated_at'),
}, (t) => [index('accounts_wallet_idx').on(t.wallet, t.stage)]);

export const simPositions = pgTable('sim_positions', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  marketToken: pubkey('market_token').notNull(),
  side: side('side').notNull(),
  sizeUsd: usd('size_usd').notNull(),
  sizeTokens: tokens('size_tokens').notNull(),
  collateralUsd: usd('collateral_usd').notNull(),
  entryPrice: price('entry_price').notNull(),
  /** Venue-model position state (borrowing / funding checkpoints) for the fee model. */
  modelState: jsonb('model_state'),
  openedAt: now('opened_at'),
  updatedAt: now('updated_at'),
  closedAt: at('closed_at'),
}, (t) => [
  uniqueIndex('sim_positions_open_uq').on(t.accountId, t.symbol, t.side).where(sql`${t.closedAt} is null`),
]);

export const simOrders = pgTable('sim_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull(),
  positionId: uuid('position_id').references(() => simPositions.id, { onDelete: 'set null' }),
  symbol: text('symbol').notNull(),
  marketToken: pubkey('market_token').notNull(),
  side: side('side').notNull(),
  kind: orderKind('kind').notNull(),
  isIncrease: boolean('is_increase').notNull(),
  sizeUsd: usd('size_usd').notNull(),
  collateralUsd: usd('collateral_usd'),
  triggerPrice: price('trigger_price'),
  acceptablePrice: price('acceptable_price'),
  slippageBps: integer('slippage_bps').notNull(),
  status: orderStatus('status').notNull(),
  statusDetail: text('status_detail'),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
  /**
   * The earliest price tick (its ts) that may execute the order: a practice order the first tick published after it
   * (1 ms past the latest tick seen when it was placed or armed), an evaluation order its placement plus the keeper
   * delay (SIM_FILL_DELAY_MS); GMTrade's trigger rule then applies on top for limits and protection.
   */
  executableFrom: at('executable_from').notNull(),
  /** Take-profit / stop-loss placed with an increase order: armed when that order fills, cancelled with it. */
  parentOrderId: uuid('parent_order_id').references((): AnyPgColumn => simOrders.id, { onDelete: 'cascade' }),
  /** Closes the whole position at execution (GMTrade CLOSE_ALL): take profit, stop loss and 100% closes; size_usd is shown only. */
  closeAll: boolean('close_all').notNull().default(false),
  /**
   * Props.trade's fee assessed on the order when it was placed (as the program assesses a funded order: an increase on
   * its size, a decrease on the account's exposure cap) and the rate that assessment used: at a fill it is charged
   * min(assessed, the rate on the executed size) (@props/sdk orderFee). 0 for liquidations' and breach closes.
   */
  platformFeeUsd: usd('platform_fee_usd').notNull().default('0'),
  feeRateUsd: usd('fee_rate_usd').notNull().default('0'),
  feeRateBps: integer('fee_rate_bps').notNull().default(0),
}, (t) => [
  uniqueIndex('sim_orders_client_uq').on(t.accountId, t.clientId),
  index('sim_orders_account_status_idx').on(t.accountId, t.status),
  index('sim_orders_pending_idx').on(t.accountId).where(sql`${t.status} in ('awaiting_execution', 'awaiting_price')`),
]);

export const simFills = pgTable('sim_fills', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  /** Null for liquidations, which no order of the account caused. */
  orderId: uuid('order_id').references(() => simOrders.id, { onDelete: 'cascade' }),
  positionId: uuid('position_id').references(() => simPositions.id, { onDelete: 'set null' }),
  symbol: text('symbol').notNull(),
  side: side('side').notNull(),
  isIncrease: boolean('is_increase').notNull(),
  sizeUsd: usd('size_usd').notNull(),
  price: price('price').notNull(),
  feeUsd: usd('fee_usd').notNull(),
  priceImpactUsd: usd('price_impact_usd').notNull(),
  fundingUsd: usd('funding_usd').notNull(),
  borrowUsd: usd('borrow_usd').notNull(),
  /** Props.trade's fee charged at this fill (simulated); realized_pnl is net of it. */
  platformFeeUsd: usd('platform_fee_usd').notNull().default('0'),
  realizedPnl: usd('realized_pnl'),
  /** Timestamp of the price tick the fill used. */
  tickTs: at('tick_ts').notNull(),
  ts: now('ts'),
}, (t) => [
  index('sim_fills_account_ts_idx').on(t.accountId, t.ts),
  /** The round trip written when a position closes sums its fills (engine.ts recordRoundTrip). */
  index('sim_fills_position_idx').on(t.positionId),
]);

/**
 * Evaluation outcomes decided by the sim engine: an outbox the chain module drains into record_evaluation_result
 * (SimService.onResolved / markRecorded). One row per evaluation, written once.
 */
export const simResults = pgTable('sim_results', {
  evaluation: text('evaluation').primaryKey().references(() => accounts.id, { onDelete: 'cascade' }),
  wallet: pubkey('wallet').notNull(),
  passed: boolean('passed').notNull(),
  finalEquity: usd('final_equity').notNull(),
  tradesRoot: char('trades_root', { length: 64 }).notNull(),
  resolvedAt: at('resolved_at').notNull(),
  recordedSignature: signature('recorded_signature'),
  recordedAt: at('recorded_at'),
  /** HMAC over the result as emitted (server/src/lib/integrity.ts); a row without a valid one is never redelivered. */
  mac: char('mac', { length: 64 }).notNull(),
});

/** Round trips for every stage; funded rows come from venue_fills. */
export const closedTrades = pgTable('closed_trades', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  side: side('side').notNull(),
  venue: venue('venue').notNull(),
  openedAt: at('opened_at').notNull(),
  closedAt: at('closed_at').notNull(),
  sizeUsd: usd('size_usd').notNull(),
  entryPrice: price('entry_price').notNull(),
  exitPrice: price('exit_price').notNull(),
  /** Every cost of the trip, summed from its fills: fees_usd = order_fees_usd + platform_fee_usd + funding_usd +
   *  borrow_usd; price impact sits inside the prices and the P&L and is recorded for the breakdown. */
  feesUsd: usd('fees_usd').notNull(),
  orderFeesUsd: usd('order_fees_usd').notNull().default('0'),
  /** Props.trade's fees on the trip's orders (net_pnl is after them). */
  platformFeeUsd: usd('platform_fee_usd').notNull().default('0'),
  fundingUsd: usd('funding_usd').notNull().default('0'),
  borrowUsd: usd('borrow_usd').notNull().default('0'),
  priceImpactUsd: usd('price_impact_usd').notNull().default('0'),
  netPnl: usd('net_pnl').notNull(),
  signatures: text('signatures').array().notNull().default(sql`'{}'::text[]`),
}, (t) => [index('closed_trades_account_closed_idx').on(t.accountId, t.closedAt)]);

export const equitySnapshots = pgTable('equity_snapshots', {
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  ts: at('ts').notNull(),
  equity: usd('equity').notNull(),
  realizedPnl: usd('realized_pnl').notNull(),
  unrealizedPnl: usd('unrealized_pnl').notNull(),
}, (t) => [primaryKey({ columns: [t.accountId, t.ts] })]);

/** Activity feed (api.ts ActivityItem). */
export const accountEvents = pgTable('account_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  type: activityType('type').notNull(),
  title: text('title').notNull(),
  detail: text('detail').notNull(),
  status: activityStatus('status').notNull(),
  amountUsd: usd('amount_usd'),
  symbol: text('symbol'),
  signature: signature('signature'),
  simulated: boolean('simulated').notNull(),
  ts: now('ts'),
}, (t) => [index('account_events_account_ts_idx').on(t.accountId, t.ts)]);

// ---------- chain-indexed (props_vault + GMTrade) ----------

/** Newest props_vault transaction the indexer has fully processed, per program id (backfill resumes after it). */
export const indexerCursors = pgTable('indexer_cursors', {
  program: pubkey('program').primaryKey(),
  signature: signature('signature').notNull(),
  slot: slot('slot').notNull(),
  updatedAt: now('updated_at'),
});

/** Every decoded props_vault event, exactly once per (signature, event index). */
export const programEvents = pgTable('program_events', {
  signature: signature('signature').notNull(),
  eventIndex: integer('event_index').notNull(),
  slot: slot('slot').notNull(),
  blockTime: at('block_time'),
  name: text('name').notNull(),
  data: jsonb('data').notNull(),
  indexedAt: now('indexed_at'),
}, (t) => [
  primaryKey({ columns: [t.signature, t.eventIndex] }),
  index('program_events_name_slot_idx').on(t.name, t.slot),
  index('program_events_slot_idx').on(t.slot),
]);

export const evaluations = pgTable('evaluations', {
  address: pubkey('address').primaryKey(),
  trader: pubkey('trader').notNull(),
  evalIndex: bigint('eval_index', { mode: 'number' }).notNull(),
  tierId: integer('tier_id').notNull(),
  sizeUsd: usd('size_usd').notNull(),
  profitTargetBps: integer('profit_target_bps').notNull(),
  maxDrawdownBps: integer('max_drawdown_bps').notNull(),
  maxExposureBps: integer('max_exposure_bps').notNull(),
  traderShareBps: integer('trader_share_bps').notNull(),
  termsHash: text('terms_hash').notNull(),
  feePaid: usd('fee_paid').notNull(),
  status: evaluationStatus('status').notNull(),
  finalEquity: usd('final_equity'),
  tradesRoot: text('trades_root'),
  purchaseSignature: signature('purchase_signature').notNull(),
  resultSignature: signature('result_signature'),
  createdAt: at('created_at').notNull(),
  resolvedAt: at('resolved_at'),
  updatedSlot: slot('updated_slot').notNull(),
}, (t) => [uniqueIndex('evaluations_trader_index_uq').on(t.trader, t.evalIndex)]);

export const fundedAccounts = pgTable('funded_accounts', {
  address: pubkey('address').primaryKey(),
  evaluation: pubkey('evaluation').notNull().unique().references(() => evaluations.address),
  trader: pubkey('trader').notNull(),
  ownerPda: pubkey('owner_pda').notNull().unique(),
  principal: usd('principal').notNull(),
  traderShareBps: integer('trader_share_bps').notNull(),
  status: fundedStatus('status').notNull(),
  payoutsPaid: usd('payouts_paid').notNull().default('0'),
  payoutSeq: bigint('payout_seq', { mode: 'number' }).notNull().default(0),
  activationSignature: signature('activation_signature').notNull(),
  createdAt: at('created_at').notNull(),
  lastSyncAt: at('last_sync_at'),
  closedAt: at('closed_at'),
  updatedSlot: slot('updated_slot').notNull(),
}, (t) => [index('funded_accounts_trader_idx').on(t.trader)]);

/** GMTrade orders created by a funded account's owner PDA. */
export const gmOrders = pgTable('gm_orders', {
  address: pubkey('address').primaryKey(),
  fundedAccount: pubkey('funded_account').notNull().references(() => fundedAccounts.address),
  marketToken: pubkey('market_token').notNull(),
  symbol: text('symbol').notNull(),
  side: side('side').notNull(),
  kind: orderKind('kind').notNull(),
  isIncrease: boolean('is_increase').notNull(),
  sizeUsd: usd('size_usd').notNull(),
  collateralUsd: usd('collateral_usd'),
  triggerPrice: price('trigger_price'),
  acceptablePrice: price('acceptable_price'),
  status: orderStatus('status').notNull(),
  statusDetail: text('status_detail'),
  createSignature: signature('create_signature').notNull(),
  closeSignature: signature('close_signature'),
  createdAt: at('created_at').notNull(),
  updatedAt: now('updated_at'),
  closedAt: at('closed_at'),
}, (t) => [index('gm_orders_funded_status_idx').on(t.fundedAccount, t.status)]);

/** Point-in-time reads of GMTrade Position accounts owned by a funded account's owner PDA. */
export const gmPositionSnapshots = pgTable('gm_position_snapshots', {
  position: pubkey('position').notNull(),
  slot: slot('slot').notNull(),
  fundedAccount: pubkey('funded_account').notNull().references(() => fundedAccounts.address),
  marketToken: pubkey('market_token').notNull(),
  side: side('side').notNull(),
  sizeUsd: usd('size_usd').notNull(),
  sizeTokens: tokens('size_tokens').notNull(),
  collateralUsd: usd('collateral_usd').notNull(),
  ts: at('ts').notNull(),
}, (t) => [
  primaryKey({ columns: [t.position, t.slot] }),
  index('gm_position_snapshots_funded_idx').on(t.fundedAccount, t.slot),
  /** The positions an account has had, read index-only every venue tick (venue.ts openSnapshots, verify.ts). */
  index('gm_position_snapshots_funded_position_idx').on(t.fundedAccount, t.position),
]);

/** Executions of funded-account orders on GMTrade. */
export const venueFills = pgTable('venue_fills', {
  signature: signature('signature').notNull(),
  eventIndex: integer('event_index').notNull(),
  /** GMTrade indexer (subsquid) TradeEvent id; chain-ordered, so the newest id is the per-account sync cursor. */
  venueId: text('venue_id').notNull().unique(),
  slot: slot('slot').notNull(),
  fundedAccount: pubkey('funded_account').notNull().references(() => fundedAccounts.address),
  position: pubkey('position'),
  order: pubkey('order'),
  symbol: text('symbol').notNull(),
  side: side('side').notNull(),
  isIncrease: boolean('is_increase').notNull(),
  sizeUsd: usd('size_usd').notNull(),
  /** Position size after the fill; 0 ends a round trip (closed_trades). */
  sizeAfterUsd: usd('size_after_usd').notNull(),
  price: price('price').notNull(),
  feeUsd: usd('fee_usd').notNull(),
  priceImpactUsd: usd('price_impact_usd').notNull(),
  fundingUsd: usd('funding_usd').notNull(),
  borrowUsd: usd('borrow_usd').notNull(),
  /** GMTrade's realized P&L of a decrease after its exchange costs (Props.trade's fee is not in it: platform_fee_usd). */
  realizedPnl: usd('realized_pnl'),
  /**
   * Props.trade's fee on the fill (order_fees: min(assessed, the rate of its latest assessment on the size executed),
   * less what earlier fills of the order took): what the trade view shows at fill time; settlement only reconciles.
   */
  platformFeeUsd: usd('platform_fee_usd').notNull().default('0'),
  ts: at('ts').notNull(),
}, (t) => [
  primaryKey({ columns: [t.signature, t.eventIndex] }),
  index('venue_fills_funded_ts_idx').on(t.fundedAccount, t.ts),
  /** The account's sync cursor, max(venue_id), every venue tick (venue.ts syncFills). */
  index('venue_fills_funded_venue_id_idx').on(t.fundedAccount, t.venueId),
  /** A position's fills in chain order: its opening fill (funded.ts positionsOf) and its round trip (syncFills). */
  index('venue_fills_position_venue_id_idx').on(t.position, t.venueId),
  /** An order's fills: its Props fee (chain/fees.ts) and the next fill's share of it (syncFills). */
  index('venue_fills_order_idx').on(t.order),
]);

/**
 * Props.trade's fee of every funded order, from the program's events (docs/design/order-fee.md): assessed at placement
 * and at every update (OrderRequested / ProtectionSet / OrderUpdated carry the fee and the Config rate that produced it),
 * then released (OrderCancelled; CompletedOrderClosed with `cancelled`) or due (Synced.orders_dropped; CompletedOrderClosed
 * without it), and settled by the keeper: charged_usd moved to the fee vault, waived_usd forgiven (confirmed
 * settlements only). assessed − charged − waived of the rows in state 'due' is the account's order_fees_due.
 */
export const orderFees = pgTable('order_fees', {
  order: pubkey('order').primaryKey().references(() => gmOrders.address),
  fundedAccount: pubkey('funded_account').notNull().references(() => fundedAccounts.address),
  isIncrease: boolean('is_increase').notNull(),
  assessedUsd: usd('assessed_usd').notNull(),
  rateUsd: usd('rate_usd').notNull(),
  rateBps: integer('rate_bps').notNull(),
  state: orderFeeState('state').notNull(),
  dueAt: at('due_at'),
  chargedUsd: usd('charged_usd').notNull().default('0'),
  waivedUsd: usd('waived_usd').notNull().default('0'),
  updatedSlot: slot('updated_slot').notNull(),
}, (t) => [index('order_fees_funded_state_idx').on(t.fundedAccount, t.state)]);

/**
 * settle_order_fees transactions. The sender writes the row, with each order's share (`allocations`: { order, chargeUsd,
 * waiveUsd }[]), in the database transaction that stores the signature before sending; the indexed OrderFeesSettled
 * confirms it and applies the shares to order_fees, once. One the chain refused, or that cannot land any more, is
 * 'failed' and changes nothing. A settlement this server did not send is recorded when indexed (sent_by = its signer),
 * its amounts spread over the account's due orders oldest first.
 */
export const orderFeeSettlements = pgTable('order_fee_settlements', {
  signature: signature('signature').notNull(),
  fundedAccount: pubkey('funded_account').notNull().references(() => fundedAccounts.address),
  chargeUsd: usd('charge_usd').notNull(),
  waiveUsd: usd('waive_usd').notNull(),
  /** The account's order_fees_due and order_fee_settlements the amounts were computed from (the program checks both). */
  expectedDueUsd: usd('expected_due_usd').notNull(),
  expectedSettlements: bigint('expected_settlements', { mode: 'number' }).notNull(),
  allocations: jsonb('allocations').notNull(),
  status: feeSettlementStatus('status').notNull(),
  sentBy: text('sent_by').notNull(),
  createdAt: now('created_at'),
  resolvedAt: at('resolved_at'),
  /** The program's clock when it landed (OrderFeesSettled.ts): the payout review counts the fees charged since a payout. */
  settledAt: at('settled_at'),
  /** A sent settlement's blockhash can land until the confirmed block height passes this; failed only after that. */
  lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'number' }),
  /**
   * The settle_order_fees the row counts: 1, or more when one transaction settled the account several times (only a
   * hand-built one), each later one spread like a settlement this server did not send.
   */
  settlements: integer('settlements').notNull().default(1),
  /** The index of the last OrderFeesSettled applied, among its transaction's events: one at or before it was applied already. */
  eventIndex: integer('event_index'),
}, (t) => [
  // One transaction can settle several accounts (an operators' batch): one row per account, which also counts a hand-built
  // transaction's further settlements of that account (`settlements`).
  primaryKey({ columns: [t.signature, t.fundedAccount] }),
  index('order_fee_settlements_funded_status_idx').on(t.fundedAccount, t.status),
]);

export const payouts = pgTable('payouts', {
  address: pubkey('address').primaryKey(),
  fundedAccount: pubkey('funded_account').notNull().references(() => fundedAccounts.address),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  status: payoutStatus('status').notNull(),
  reasonCode: integer('reason_code'),
  balanceAtRequest: usd('balance_at_request').notNull(),
  profit: usd('profit').notNull(),
  traderAmount: usd('trader_amount').notNull(),
  vaultAmount: usd('vault_amount').notNull(),
  networkFeeSol: sol('network_fee_sol'),
  destination: pubkey('destination').notNull(),
  requestSignature: signature('request_signature').notNull(),
  paySignature: signature('pay_signature'),
  requestedAt: at('requested_at').notNull(),
  resolvedAt: at('resolved_at'),
  /** Why the keeper held the request for manual review (status 'reviewing'); operators only, never shown to the trader. */
  reviewNote: text('review_note'),
}, (t) => [uniqueIndex('payouts_funded_seq_uq').on(t.fundedAccount, t.seq)]);

/** Every USDC movement touching the capital vault, fee vault or funded principal. */
export const vaultLedger = pgTable('vault_ledger', {
  signature: signature('signature').notNull(),
  eventIndex: integer('event_index').notNull(),
  slot: slot('slot').notNull(),
  event: text('event').notNull(),
  account: text('account'),
  amountUsd: usd('amount_usd').notNull(),
  direction: ledgerDirection('direction').notNull(),
  ts: at('ts').notNull(),
}, (t) => [
  primaryKey({ columns: [t.signature, t.eventIndex] }),
  index('vault_ledger_ts_idx').on(t.ts),
]);

/**
 * Props.trade's own record of GMTrade's live index price (the keeper feed's mid): one OHLC bar a minute per market,
 * t = unix seconds of the minute's start. Charts fall back to it while GMTrade's candle service is slow or down
 * (modules/marketdata/record.ts), so they never depend on that service alone. Kept 30 days.
 */
export const priceBars = pgTable('price_bars', {
  symbol: text('symbol').notNull(),
  t: bigint('t', { mode: 'number' }).notNull(),
  open: price('open').notNull(),
  high: price('high').notNull(),
  low: price('low').notNull(),
  close: price('close').notNull(),
}, (t) => [primaryKey({ columns: [t.symbol, t.t] })]);

/**
 * GMTrade candle windows kept for the charts (modules/marketdata/history.ts). A series' (symbol, resolution) latest
 * 300-bar window, unsettled and rewritten when it rotates or five minutes after its last write, restores the in-memory
 * copies after a restart; settled windows (fetched for a request, or by the backfill in 300-bar pages aligned to
 * multiples of their span) answer history scrolls without GMTrade. start_time and end_time are the unix seconds of the
 * first and last bucket; candles is the answer GMTrade gave for that range (empty only for a backfill page past its
 * history start, the marker the backfill stops at). Bounded per series to what the app's chart can reach (30,000 bars,
 * the oldest-fetched settled windows beyond it evicted). jsonb keeps a 300-bar page in about 10.5 KB (31 KB of JSON,
 * measured 2026-09-25): the backfill's first fill of 68 markets (2,000 bars for 1h/4h/1D, 1,000 for 5m/15m) is about
 * 20 MB stored, and since every page is kept once it completes, a series grows to the cap over time (5m in about 100
 * days, 15m in about 300 days, the slower ones over years): about 70 MB per interval at the cap, 360 MB if every
 * series reached it.
 */
export const candleWindows = pgTable('candle_windows', {
  symbol: text('symbol').notNull(),
  resolution: integer('resolution').notNull(),
  startTime: bigint('start_time', { mode: 'number' }).notNull(),
  endTime: bigint('end_time', { mode: 'number' }).notNull(),
  candles: jsonb('candles').notNull(),
  fetchedAt: now('fetched_at'),
  settled: boolean('settled').notNull(),
}, (t) => [primaryKey({ columns: [t.symbol, t.resolution, t.startTime] })]);

/**
 * GMTrade program deploys the keeper has seen (the program data's last-deploy slot). acknowledged_at is when the deploy
 * was accepted as reviewed: GMTRADE_DEPLOY_SLOT on first sight (or, without it, the first deploy seen), else an operator
 * through the admin API. Until then it is an upgrade: detected_at is when it was noticed, handled_at when every active
 * funded account had been restricted because of it.
 */
export const gmtradeDeploys = pgTable('gmtrade_deploys', {
  slot: slot('slot').primaryKey(),
  detectedAt: at('detected_at'),
  handledAt: at('handled_at'),
  acknowledgedAt: at('acknowledged_at'),
  createdAt: now('created_at'),
});

// ---------- notifications, KYC, operations ----------

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  wallet: pubkey('wallet').notNull(),
  kind: notificationKind('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  href: text('href').notNull(),
  createdAt: now('created_at'),
  readAt: at('read_at'),
}, (t) => [index('notifications_wallet_created_idx').on(t.wallet, t.createdAt)]);

/**
 * Onchain writes the chain module sends with the risk / KYC authority keys. Payloads by kind:
 *   set_identity             { wallet, identityHash (64 hex) }
 *   record_evaluation_result { evaluation, wallet, passed, finalEquityUsd, tradesRoot (64 hex), resolvedAt }
 *   approve_payout           { payout }
 *   reject_payout            { payout, reasonCode }
 *   lift_restriction         { funded }
 *   close_funded             { funded }
 * `subject` (the evaluation or payout PDA, `lift:<funded>`) makes enqueueing idempotent: one job per evaluation result
 * and one decision per payout, whoever (keeper or admin) asks first.
 */
export const chainJobs = pgTable('chain_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: chainJobKind('kind').notNull(),
  payload: jsonb('payload').notNull(),
  subject: text('subject'),
  status: chainJobStatus('status').notNull().default('queued'),
  /** Every failed attempt (drives the retry backoff). */
  attempts: integer('attempts').notNull().default(0),
  /** Attempts the chain itself refused (simulation or onchain failure, missing account): 10 fail the job for good. */
  rejections: integer('rejections').notNull().default(0),
  lastError: text('last_error'),
  signature: signature('signature'),
  /** HMAC over kind, subject and payload (server/src/lib/integrity.ts); checked before anything is signed. */
  mac: char('mac', { length: 64 }).notNull(),
  createdAt: now('created_at'),
  updatedAt: now('updated_at'),
}, (t) => [
  index('chain_jobs_status_created_idx').on(t.status, t.createdAt),
  uniqueIndex('chain_jobs_subject_uq').on(t.subject),
]);

/**
 * Manual identity review (v1). identity_hash is the reviewer's salted hash of the person, never raw identity data;
 * one approved wallet per identity, one open request per wallet.
 */
export const kycRequests = pgTable('kyc_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  wallet: pubkey('wallet').notNull().references(() => users.wallet),
  country: char('country', { length: 2 }).notNull(),
  /** ISO 3166-2 subdivision (e.g. "UA-43"), required where only part of a country is sanctioned. */
  region: text('region'),
  status: kycStatus('status').notNull().default('pending'),
  identityHash: char('identity_hash', { length: 64 }),
  reason: text('reason'),
  setIdentityJob: uuid('set_identity_job').references(() => chainJobs.id),
  createdAt: now('created_at'),
  reviewedAt: at('reviewed_at'),
}, (t) => [
  uniqueIndex('kyc_requests_pending_wallet_uq').on(t.wallet).where(sql`${t.status} = 'pending'`),
  uniqueIndex('kyc_requests_approved_identity_uq').on(t.identityHash).where(sql`${t.status} = 'approved'`),
  index('kyc_requests_status_created_idx').on(t.status, t.createdAt),
  index('kyc_requests_wallet_created_idx').on(t.wallet, t.createdAt),
]);

export const adminAuditLog = pgTable('admin_audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  action: text('action').notNull(),
  target: text('target'),
  details: jsonb('details').notNull(),
  ip: text('ip').notNull(),
  requestId: text('request_id').notNull(),
  createdAt: now('created_at'),
});

// ---------- referrals (src/routes/referrals.ts) ----------

/**
 * A referrer's reward for the Props fee one settlement charged a funded order (order_fees) of a trader it referred:
 * rate_bps of that charge (the settlement's share for the order), rounded down to the micro-dollar. Written with the
 * indexed OrderFeesSettled that confirms the charge (modules/chain/projector.ts), once per order and settlement.
 */
export const referralRewards = pgTable('referral_rewards', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  referrer: pubkey('referrer').notNull().references(() => users.wallet),
  referee: pubkey('referee').notNull().references(() => users.wallet),
  order: pubkey('order').notNull().references(() => orderFees.order),
  fundedAccount: pubkey('funded_account').notNull(),
  /** The settle_order_fees transaction that charged it (with funded_account: its order_fee_settlements row). */
  settlementSignature: signature('settlement_signature').notNull(),
  /** Its OrderFeesSettled's index among that transaction's events (one transaction can settle an account twice). */
  settlementEventIndex: integer('settlement_event_index').notNull(),
  symbol: text('symbol').notNull(),
  /** The Props fee that settlement charged the order. */
  feeUsd: usd('fee_usd').notNull(),
  rateBps: integer('rate_bps').notNull(),
  rewardUsd: usd('reward_usd').notNull(),
  createdAt: now('created_at'),
}, (t) => [
  uniqueIndex('referral_rewards_order_settlement_uq').on(t.order, t.settlementSignature, t.settlementEventIndex),
  foreignKey({
    name: 'referral_rewards_settlement_fk', columns: [t.settlementSignature, t.fundedAccount],
    foreignColumns: [orderFeeSettlements.signature, orderFeeSettlements.fundedAccount],
  }),
  index('referral_rewards_referrer_created_idx').on(t.referrer, t.createdAt.desc().nullsFirst()), // = order by created_at desc
]);

/** USDC Props.trade sent a referrer, recorded by an operator after sending it (POST /v1/admin/referrals/payouts). */
export const referralPayouts = pgTable('referral_payouts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  referrer: pubkey('referrer').notNull().references(() => users.wallet),
  amountUsd: usd('amount_usd').notNull(),
  signature: signature('signature').notNull(),
  note: text('note'),
  /** The operator's address (the admin token is shared; admin_audit_log has the request). */
  createdBy: text('created_by').notNull(),
  createdAt: now('created_at'),
}, (t) => [uniqueIndex('referral_payouts_referrer_signature_uq').on(t.referrer, t.signature)]);
