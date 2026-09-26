-- Props.trade order fee (2026-09-26, docs/design/order-fee.md §9): the funded fee ledger (order_fees: each order's
-- assessed fee and the rate that produced it, released or due, charged / waived by settlements; order_fee_settlements:
-- every settle_order_fees with its per-order shares, written before it is sent and confirmed by the indexed event), and
-- the simulated fee of practice and evaluation orders (sim_orders: assessed fee and rate; sim_fills and closed_trades:
-- the fee charged; accounts: the fees charged so far). venue_fills and closed_trades carry the funded fee shown per trade.
-- Every new column defaults to 0: nothing charged a fee before this.
CREATE TYPE "public"."fee_settlement_status" AS ENUM('sent', 'confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."order_fee_state" AS ENUM('assessed', 'released', 'due');--> statement-breakpoint
CREATE TABLE "order_fee_settlements" (
	"signature" varchar(88) NOT NULL,
	"funded_account" varchar(44) NOT NULL,
	"charge_usd" numeric(38, 6) NOT NULL,
	"waive_usd" numeric(38, 6) NOT NULL,
	"expected_due_usd" numeric(38, 6) NOT NULL,
	"expected_settlements" bigint NOT NULL,
	"allocations" jsonb NOT NULL,
	"status" "fee_settlement_status" NOT NULL,
	"sent_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"last_valid_block_height" bigint,
	CONSTRAINT "order_fee_settlements_signature_funded_account_pk" PRIMARY KEY("signature","funded_account")
);
--> statement-breakpoint
CREATE TABLE "order_fees" (
	"order" varchar(44) PRIMARY KEY NOT NULL,
	"funded_account" varchar(44) NOT NULL,
	"is_increase" boolean NOT NULL,
	"assessed_usd" numeric(38, 6) NOT NULL,
	"rate_usd" numeric(38, 6) NOT NULL,
	"rate_bps" integer NOT NULL,
	"state" "order_fee_state" NOT NULL,
	"due_at" timestamp with time zone,
	"charged_usd" numeric(38, 6) DEFAULT '0' NOT NULL,
	"waived_usd" numeric(38, 6) DEFAULT '0' NOT NULL,
	"updated_slot" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "platform_fees_usd" numeric(38, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "closed_trades" ADD COLUMN "platform_fee_usd" numeric(38, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_fills" ADD COLUMN "platform_fee_usd" numeric(38, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_orders" ADD COLUMN "platform_fee_usd" numeric(38, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_orders" ADD COLUMN "fee_rate_usd" numeric(38, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_orders" ADD COLUMN "fee_rate_bps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "venue_fills" ADD COLUMN "platform_fee_usd" numeric(38, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_fee_settlements" ADD CONSTRAINT "order_fee_settlements_funded_account_funded_accounts_address_fk" FOREIGN KEY ("funded_account") REFERENCES "public"."funded_accounts"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fees" ADD CONSTRAINT "order_fees_order_gm_orders_address_fk" FOREIGN KEY ("order") REFERENCES "public"."gm_orders"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fees" ADD CONSTRAINT "order_fees_funded_account_funded_accounts_address_fk" FOREIGN KEY ("funded_account") REFERENCES "public"."funded_accounts"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_fee_settlements_funded_status_idx" ON "order_fee_settlements" USING btree ("funded_account","status");--> statement-breakpoint
CREATE INDEX "order_fees_funded_state_idx" ON "order_fees" USING btree ("funded_account","state");--> statement-breakpoint
CREATE INDEX "venue_fills_order_idx" ON "venue_fills" USING btree ("order");