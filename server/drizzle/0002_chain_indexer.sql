ALTER TYPE "public"."chain_job_kind" ADD VALUE 'record_evaluation_result';--> statement-breakpoint
ALTER TYPE "public"."chain_job_kind" ADD VALUE 'approve_payout';--> statement-breakpoint
ALTER TYPE "public"."chain_job_kind" ADD VALUE 'reject_payout';--> statement-breakpoint
CREATE TABLE "indexer_cursors" (
	"program" varchar(44) PRIMARY KEY NOT NULL,
	"signature" varchar(88) NOT NULL,
	"slot" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chain_jobs" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "venue_fills" ADD COLUMN "venue_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "venue_fills" ADD COLUMN "size_after_usd" numeric(38, 6) NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chain_jobs_subject_uq" ON "chain_jobs" USING btree ("subject");--> statement-breakpoint
ALTER TABLE "venue_fills" ADD CONSTRAINT "venue_fills_venue_id_unique" UNIQUE("venue_id");