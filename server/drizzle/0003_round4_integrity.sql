ALTER TYPE "public"."chain_job_kind" ADD VALUE 'close_funded';--> statement-breakpoint
ALTER TABLE "chain_jobs" ADD COLUMN "mac" char(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "kyc_requests" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "sim_results" ADD COLUMN "mac" char(64) NOT NULL;