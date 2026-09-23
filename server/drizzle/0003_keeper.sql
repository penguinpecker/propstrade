CREATE TABLE "gmtrade_deploys" (
	"slot" bigint PRIMARY KEY NOT NULL,
	"detected_at" timestamp with time zone,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "review_note" text;