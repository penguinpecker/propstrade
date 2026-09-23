ALTER TYPE "public"."chain_job_kind" ADD VALUE 'lift_restriction';--> statement-breakpoint
ALTER TABLE "chain_jobs" ADD COLUMN "rejections" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gmtrade_deploys" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
-- Deploys seen before acknowledgements existed: the first-sight baseline was accepted as reviewed; upgrades were not.
UPDATE "gmtrade_deploys" SET "acknowledged_at" = "handled_at" WHERE "detected_at" IS NULL;
