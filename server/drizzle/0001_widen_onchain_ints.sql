ALTER TABLE "accounts" ALTER COLUMN "tier_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "evaluations" ALTER COLUMN "eval_index" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "evaluations" ALTER COLUMN "tier_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "funded_accounts" ALTER COLUMN "payout_seq" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "seq" SET DATA TYPE bigint;