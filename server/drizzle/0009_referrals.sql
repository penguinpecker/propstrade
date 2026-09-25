-- Referral program (2026-09-25, src/routes/referrals.ts): each user's referral code (the shortest prefix of the wallet,
-- 8 characters or more, upper-cased, that no other user holds: given at sign-in, and to the users from before this
-- migration by the server's boot backfill, oldest first), the referrer a user bound (once), the referrers' rewards (a
-- share of the exchange fee of each funded fill of a trader they referred, one row per fill) and the payouts operators
-- recorded.
CREATE TABLE "referral_payouts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"referrer" varchar(44) NOT NULL,
	"amount_usd" numeric(38, 6) NOT NULL,
	"signature" varchar(88) NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_rewards" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"referrer" varchar(44) NOT NULL,
	"referee" varchar(44) NOT NULL,
	"venue_fill_id" text NOT NULL,
	"symbol" text NOT NULL,
	"fee_usd" numeric(38, 6) NOT NULL,
	"rate_bps" integer NOT NULL,
	"reward_usd" numeric(38, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_rewards_venue_fill_id_unique" UNIQUE("venue_fill_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referred_by" varchar(44);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral_payouts" ADD CONSTRAINT "referral_payouts_referrer_users_wallet_fk" FOREIGN KEY ("referrer") REFERENCES "public"."users"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referrer_users_wallet_fk" FOREIGN KEY ("referrer") REFERENCES "public"."users"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referee_users_wallet_fk" FOREIGN KEY ("referee") REFERENCES "public"."users"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_venue_fill_id_venue_fills_venue_id_fk" FOREIGN KEY ("venue_fill_id") REFERENCES "public"."venue_fills"("venue_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_payouts_referrer_signature_uq" ON "referral_payouts" USING btree ("referrer","signature");--> statement-breakpoint
CREATE INDEX "referral_rewards_referrer_created_idx" ON "referral_rewards" USING btree ("referrer","created_at" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_referred_by_users_wallet_fk" FOREIGN KEY ("referred_by") REFERENCES "public"."users"("wallet") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_referred_by_idx" ON "users" USING btree ("referred_by");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_referral_code_unique" UNIQUE("referral_code");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_referral_code_upper" CHECK ("users"."referral_code" = upper("users"."referral_code"));