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
  bigint, bigserial, boolean, char, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text,
  timestamp, uniqueIndex, uuid, varchar,
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
export const chainJobKind = pgEnum('chain_job_kind', ['set_identity', 'record_evaluation_result', 'approve_payout', 'reject_payout', 'lift_restriction']);
export const chainJobStatus = pgEnum('chain_job_status', ['queued', 'sent', 'confirmed', 'failed']);

// ---------- identity + auth ----------

/** Wallets that have signed in. */
export const users = pgTable('users', {
  wallet: pubkey('wallet').primaryKey(),
  createdAt: now('created_at'),
  lastLoginAt: now('last_login_at'),
});

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
}, (t) => [
  uniqueIndex('sim_orders_client_uq').on(t.accountId, t.clientId),
  index('sim_orders_account_status_idx').on(t.accountId, t.status),
]);

export const simFills = pgTable('sim_fills', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id').notNull().references(() => simOrders.id, { onDelete: 'cascade' }),
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
  realizedPnl: usd('realized_pnl'),
  /** Timestamp of the price tick the fill used. */
  tickTs: at('tick_ts').notNull(),
  ts: now('ts'),
}, (t) => [index('sim_fills_account_ts_idx').on(t.accountId, t.ts)]);

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
  feesUsd: usd('fees_usd').notNull(),
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
  realizedPnl: usd('realized_pnl'),
  ts: at('ts').notNull(),
}, (t) => [
  primaryKey({ columns: [t.signature, t.eventIndex] }),
  index('venue_fills_funded_ts_idx').on(t.fundedAccount, t.ts),
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
