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
ALTER TABLE "sim_orders" ADD COLUMN "parent_order_id" uuid;--> statement-breakpoint
ALTER TABLE "sim_results" ADD CONSTRAINT "sim_results_evaluation_accounts_id_fk" FOREIGN KEY ("evaluation") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_orders" ADD CONSTRAINT "sim_orders_parent_order_id_sim_orders_id_fk" FOREIGN KEY ("parent_order_id") REFERENCES "public"."sim_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_orders_pending_idx" ON "sim_orders" USING btree ("account_id") WHERE "sim_orders"."status" in ('awaiting_execution', 'awaiting_price');