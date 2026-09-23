CREATE TYPE "public"."account_status" AS ENUM('active', 'near_limit', 'checking', 'passed', 'breached', 'failed', 'awaiting_capacity', 'activating', 'restricted', 'payout_pending', 'closure_pending', 'closed');--> statement-breakpoint
CREATE TYPE "public"."activity_status" AS ENUM('pending', 'confirmed', 'failed', 'indexing');--> statement-breakpoint
CREATE TYPE "public"."activity_type" AS ENUM('order', 'fill', 'cancel', 'protection', 'liquidation', 'charge', 'account', 'payout', 'risk');--> statement-breakpoint
CREATE TYPE "public"."chain_job_kind" AS ENUM('set_identity');--> statement-breakpoint
CREATE TYPE "public"."chain_job_status" AS ENUM('queued', 'sent', 'confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."evaluation_status" AS ENUM('active', 'passed', 'failed', 'funded', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."funded_status" AS ENUM('active', 'restricted', 'payout_pending', 'breached', 'closed');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."ledger_direction" AS ENUM('in', 'out', 'internal');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('fill', 'risk', 'payout', 'account');--> statement-breakpoint
CREATE TYPE "public"."order_kind" AS ENUM('Market', 'Limit', 'TakeProfit', 'StopLoss');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('draft', 'signing', 'submitted', 'awaiting_execution', 'awaiting_price', 'executed', 'canceled', 'rejected', 'frozen', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('requested', 'reviewing', 'paid', 'rejected', 'cancelled', 'uncertain');--> statement-breakpoint
CREATE TYPE "public"."side" AS ENUM('Long', 'Short');--> statement-breakpoint
CREATE TYPE "public"."stage" AS ENUM('practice', 'evaluation', 'funded');--> statement-breakpoint
CREATE TYPE "public"."venue" AS ENUM('simulated', 'gmtrade');--> statement-breakpoint
CREATE TABLE "account_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"type" "activity_type" NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"status" "activity_status" NOT NULL,
	"amount_usd" numeric(38, 6),
	"symbol" text,
	"signature" varchar(88),
	"simulated" boolean NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"stage" "stage" NOT NULL,
	"status" "account_status" NOT NULL,
	"label" text NOT NULL,
	"tier_id" smallint,
	"evaluation" varchar(44),
	"funded" varchar(44),
	"size_usd" numeric(38, 6) NOT NULL,
	"loss_allowance_usd" numeric(38, 6) NOT NULL,
	"profit_target_usd" numeric(38, 6),
	"max_exposure_bps" integer NOT NULL,
	"trader_share_bps" integer NOT NULL,
	"terms_hash" text,
	"terms_version" integer,
	"realized_pnl" numeric(38, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"details" jsonb NOT NULL,
	"ip" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"nonce" varchar(64) PRIMARY KEY NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chain_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "chain_job_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "chain_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"signature" varchar(88),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "closed_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"symbol" text NOT NULL,
	"side" "side" NOT NULL,
	"venue" "venue" NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"size_usd" numeric(38, 6) NOT NULL,
	"entry_price" numeric(38, 18) NOT NULL,
	"exit_price" numeric(38, 18) NOT NULL,
	"fees_usd" numeric(38, 6) NOT NULL,
	"net_pnl" numeric(38, 6) NOT NULL,
	"signatures" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equity_snapshots" (
	"account_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"equity" numeric(38, 6) NOT NULL,
	"realized_pnl" numeric(38, 6) NOT NULL,
	"unrealized_pnl" numeric(38, 6) NOT NULL,
	CONSTRAINT "equity_snapshots_account_id_ts_pk" PRIMARY KEY("account_id","ts")
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"address" varchar(44) PRIMARY KEY NOT NULL,
	"trader" varchar(44) NOT NULL,
	"eval_index" integer NOT NULL,
	"tier_id" smallint NOT NULL,
	"size_usd" numeric(38, 6) NOT NULL,
	"profit_target_bps" integer NOT NULL,
	"max_drawdown_bps" integer NOT NULL,
	"max_exposure_bps" integer NOT NULL,
	"trader_share_bps" integer NOT NULL,
	"terms_hash" text NOT NULL,
	"fee_paid" numeric(38, 6) NOT NULL,
	"status" "evaluation_status" NOT NULL,
	"final_equity" numeric(38, 6),
	"trades_root" text,
	"purchase_signature" varchar(88) NOT NULL,
	"result_signature" varchar(88),
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"updated_slot" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funded_accounts" (
	"address" varchar(44) PRIMARY KEY NOT NULL,
	"evaluation" varchar(44) NOT NULL,
	"trader" varchar(44) NOT NULL,
	"owner_pda" varchar(44) NOT NULL,
	"principal" numeric(38, 6) NOT NULL,
	"trader_share_bps" integer NOT NULL,
	"status" "funded_status" NOT NULL,
	"payouts_paid" numeric(38, 6) DEFAULT '0' NOT NULL,
	"payout_seq" integer DEFAULT 0 NOT NULL,
	"activation_signature" varchar(88) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_sync_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"updated_slot" bigint NOT NULL,
	CONSTRAINT "funded_accounts_evaluation_unique" UNIQUE("evaluation"),
	CONSTRAINT "funded_accounts_owner_pda_unique" UNIQUE("owner_pda")
);
--> statement-breakpoint
CREATE TABLE "gm_orders" (
	"address" varchar(44) PRIMARY KEY NOT NULL,
	"funded_account" varchar(44) NOT NULL,
	"market_token" varchar(44) NOT NULL,
	"symbol" text NOT NULL,
	"side" "side" NOT NULL,
	"kind" "order_kind" NOT NULL,
	"is_increase" boolean NOT NULL,
	"size_usd" numeric(38, 6) NOT NULL,
	"collateral_usd" numeric(38, 6),
	"trigger_price" numeric(38, 18),
	"acceptable_price" numeric(38, 18),
	"status" "order_status" NOT NULL,
	"status_detail" text,
	"create_signature" varchar(88) NOT NULL,
	"close_signature" varchar(88),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gm_position_snapshots" (
	"position" varchar(44) NOT NULL,
	"slot" bigint NOT NULL,
	"funded_account" varchar(44) NOT NULL,
	"market_token" varchar(44) NOT NULL,
	"side" "side" NOT NULL,
	"size_usd" numeric(38, 6) NOT NULL,
	"size_tokens" numeric(38, 18) NOT NULL,
	"collateral_usd" numeric(38, 6) NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	CONSTRAINT "gm_position_snapshots_position_slot_pk" PRIMARY KEY("position","slot")
);
--> statement-breakpoint
CREATE TABLE "kyc_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"country" char(2) NOT NULL,
	"status" "kyc_status" DEFAULT 'pending' NOT NULL,
	"identity_hash" char(64),
	"reason" text,
	"set_identity_job" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"href" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"address" varchar(44) PRIMARY KEY NOT NULL,
	"funded_account" varchar(44) NOT NULL,
	"seq" integer NOT NULL,
	"status" "payout_status" NOT NULL,
	"reason_code" integer,
	"balance_at_request" numeric(38, 6) NOT NULL,
	"profit" numeric(38, 6) NOT NULL,
	"trader_amount" numeric(38, 6) NOT NULL,
	"vault_amount" numeric(38, 6) NOT NULL,
	"network_fee_sol" numeric(38, 9),
	"destination" varchar(44) NOT NULL,
	"request_signature" varchar(88) NOT NULL,
	"pay_signature" varchar(88),
	"requested_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "program_events" (
	"signature" varchar(88) NOT NULL,
	"event_index" integer NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone,
	"name" text NOT NULL,
	"data" jsonb NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "program_events_signature_event_index_pk" PRIMARY KEY("signature","event_index")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"token_hash" char(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sim_fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"order_id" uuid NOT NULL,
	"position_id" uuid,
	"symbol" text NOT NULL,
	"side" "side" NOT NULL,
	"is_increase" boolean NOT NULL,
	"size_usd" numeric(38, 6) NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"fee_usd" numeric(38, 6) NOT NULL,
	"price_impact_usd" numeric(38, 6) NOT NULL,
	"funding_usd" numeric(38, 6) NOT NULL,
	"borrow_usd" numeric(38, 6) NOT NULL,
	"realized_pnl" numeric(38, 6),
	"tick_ts" timestamp with time zone NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"client_id" text NOT NULL,
	"position_id" uuid,
	"symbol" text NOT NULL,
	"market_token" varchar(44) NOT NULL,
	"side" "side" NOT NULL,
	"kind" "order_kind" NOT NULL,
	"is_increase" boolean NOT NULL,
	"size_usd" numeric(38, 6) NOT NULL,
	"collateral_usd" numeric(38, 6),
	"trigger_price" numeric(38, 18),
	"acceptable_price" numeric(38, 18),
	"slippage_bps" integer NOT NULL,
	"status" "order_status" NOT NULL,
	"status_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"symbol" text NOT NULL,
	"market_token" varchar(44) NOT NULL,
	"side" "side" NOT NULL,
	"size_usd" numeric(38, 6) NOT NULL,
	"size_tokens" numeric(38, 18) NOT NULL,
	"collateral_usd" numeric(38, 6) NOT NULL,
	"entry_price" numeric(38, 18) NOT NULL,
	"model_state" jsonb,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"wallet" varchar(44) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_ledger" (
	"signature" varchar(88) NOT NULL,
	"event_index" integer NOT NULL,
	"slot" bigint NOT NULL,
	"event" text NOT NULL,
	"account" text,
	"amount_usd" numeric(38, 6) NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	CONSTRAINT "vault_ledger_signature_event_index_pk" PRIMARY KEY("signature","event_index")
);
--> statement-breakpoint
CREATE TABLE "venue_fills" (
	"signature" varchar(88) NOT NULL,
	"event_index" integer NOT NULL,
	"slot" bigint NOT NULL,
	"funded_account" varchar(44) NOT NULL,
	"position" varchar(44),
	"order" varchar(44),
	"symbol" text NOT NULL,
	"side" "side" NOT NULL,
	"is_increase" boolean NOT NULL,
	"size_usd" numeric(38, 6) NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"fee_usd" numeric(38, 6) NOT NULL,
	"price_impact_usd" numeric(38, 6) NOT NULL,
	"funding_usd" numeric(38, 6) NOT NULL,
	"borrow_usd" numeric(38, 6) NOT NULL,
	"realized_pnl" numeric(38, 6),
	"ts" timestamp with time zone NOT NULL,
	CONSTRAINT "venue_fills_signature_event_index_pk" PRIMARY KEY("signature","event_index")
);
--> statement-breakpoint
ALTER TABLE "account_events" ADD CONSTRAINT "account_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closed_trades" ADD CONSTRAINT "closed_trades_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_snapshots" ADD CONSTRAINT "equity_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funded_accounts" ADD CONSTRAINT "funded_accounts_evaluation_evaluations_address_fk" FOREIGN KEY ("evaluation") REFERENCES "public"."evaluations"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gm_orders" ADD CONSTRAINT "gm_orders_funded_account_funded_accounts_address_fk" FOREIGN KEY ("funded_account") REFERENCES "public"."funded_accounts"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gm_position_snapshots" ADD CONSTRAINT "gm_position_snapshots_funded_account_funded_accounts_address_fk" FOREIGN KEY ("funded_account") REFERENCES "public"."funded_accounts"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_requests" ADD CONSTRAINT "kyc_requests_wallet_users_wallet_fk" FOREIGN KEY ("wallet") REFERENCES "public"."users"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_requests" ADD CONSTRAINT "kyc_requests_set_identity_job_chain_jobs_id_fk" FOREIGN KEY ("set_identity_job") REFERENCES "public"."chain_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_funded_account_funded_accounts_address_fk" FOREIGN KEY ("funded_account") REFERENCES "public"."funded_accounts"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_wallet_users_wallet_fk" FOREIGN KEY ("wallet") REFERENCES "public"."users"("wallet") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_fills" ADD CONSTRAINT "sim_fills_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_fills" ADD CONSTRAINT "sim_fills_order_id_sim_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sim_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_fills" ADD CONSTRAINT "sim_fills_position_id_sim_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."sim_positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_orders" ADD CONSTRAINT "sim_orders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_orders" ADD CONSTRAINT "sim_orders_position_id_sim_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."sim_positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_positions" ADD CONSTRAINT "sim_positions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_fills" ADD CONSTRAINT "venue_fills_funded_account_funded_accounts_address_fk" FOREIGN KEY ("funded_account") REFERENCES "public"."funded_accounts"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_events_account_ts_idx" ON "account_events" USING btree ("account_id","ts");--> statement-breakpoint
CREATE INDEX "accounts_wallet_idx" ON "accounts" USING btree ("wallet","stage");--> statement-breakpoint
CREATE INDEX "auth_nonces_expires_at_idx" ON "auth_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "chain_jobs_status_created_idx" ON "chain_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "closed_trades_account_closed_idx" ON "closed_trades" USING btree ("account_id","closed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluations_trader_index_uq" ON "evaluations" USING btree ("trader","eval_index");--> statement-breakpoint
CREATE INDEX "funded_accounts_trader_idx" ON "funded_accounts" USING btree ("trader");--> statement-breakpoint
CREATE INDEX "gm_orders_funded_status_idx" ON "gm_orders" USING btree ("funded_account","status");--> statement-breakpoint
CREATE INDEX "gm_position_snapshots_funded_idx" ON "gm_position_snapshots" USING btree ("funded_account","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_requests_pending_wallet_uq" ON "kyc_requests" USING btree ("wallet") WHERE "kyc_requests"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_requests_approved_identity_uq" ON "kyc_requests" USING btree ("identity_hash") WHERE "kyc_requests"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "kyc_requests_status_created_idx" ON "kyc_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "kyc_requests_wallet_created_idx" ON "kyc_requests" USING btree ("wallet","created_at");--> statement-breakpoint
CREATE INDEX "notifications_wallet_created_idx" ON "notifications" USING btree ("wallet","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_funded_seq_uq" ON "payouts" USING btree ("funded_account","seq");--> statement-breakpoint
CREATE INDEX "program_events_name_slot_idx" ON "program_events" USING btree ("name","slot");--> statement-breakpoint
CREATE INDEX "program_events_slot_idx" ON "program_events" USING btree ("slot");--> statement-breakpoint
CREATE INDEX "sessions_wallet_idx" ON "sessions" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "sim_fills_account_ts_idx" ON "sim_fills" USING btree ("account_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "sim_orders_client_uq" ON "sim_orders" USING btree ("account_id","client_id");--> statement-breakpoint
CREATE INDEX "sim_orders_account_status_idx" ON "sim_orders" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sim_positions_open_uq" ON "sim_positions" USING btree ("account_id","symbol","side") WHERE "sim_positions"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "vault_ledger_ts_idx" ON "vault_ledger" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "venue_fills_funded_ts_idx" ON "venue_fills" USING btree ("funded_account","ts");