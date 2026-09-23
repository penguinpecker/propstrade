ALTER TYPE "public"."chain_job_kind" ADD VALUE 'record_evaluation_result';--> statement-breakpoint
ALTER TYPE "public"."chain_job_kind" ADD VALUE 'approve_payout';--> statement-breakpoint
ALTER TYPE "public"."chain_job_kind" ADD VALUE 'reject_payout';--> statement-breakpoint
ALTER TYPE "public"."chain_job_kind" ADD VALUE 'lift_restriction';--> statement-breakpoint
CREATE TABLE "gmtrade_deploys" (
	"slot" bigint PRIMARY KEY NOT NULL,
	"detected_at" timestamp with time zone,
	"handled_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer_cursors" (
	"program" varchar(44) PRIMARY KEY NOT NULL,
	"signature" varchar(88) NOT NULL,
	"slot" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_results" (
	"evaluation" text PRIMARY KEY NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"passed" boolean NOT NULL,
	"final_equity" numeric(38, 6) NOT NULL,
	"trades_root" char(64) NOT NULL,
	"resolved_at" timestamp with time zone NOT NULL,
	"recorded_signature" varchar(88),
	"recorded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sim_fills" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chain_jobs" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "chain_jobs" ADD COLUMN "rejections" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "sim_orders" ADD COLUMN "parent_order_id" uuid;--> statement-breakpoint
ALTER TABLE "sim_orders" ADD COLUMN "close_all" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "venue_fills" ADD COLUMN "venue_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "venue_fills" ADD COLUMN "size_after_usd" numeric(38, 6) NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_results" ADD CONSTRAINT "sim_results_evaluation_accounts_id_fk" FOREIGN KEY ("evaluation") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_orders" ADD CONSTRAINT "sim_orders_parent_order_id_sim_orders_id_fk" FOREIGN KEY ("parent_order_id") REFERENCES "public"."sim_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chain_jobs_subject_uq" ON "chain_jobs" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "sim_orders_pending_idx" ON "sim_orders" USING btree ("account_id") WHERE "sim_orders"."status" in ('awaiting_execution', 'awaiting_price');--> statement-breakpoint
ALTER TABLE "venue_fills" ADD CONSTRAINT "venue_fills_venue_id_unique" UNIQUE("venue_id");