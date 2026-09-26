-- Referral rewards from the Props fee (2026-09-26, the owner's decision; src/routes/referrals.ts): a referrer earns
-- REFERRAL_REWARD_BPS of the Props fee each confirmed settlement charges a funded order of a trader it referred (the
-- indexed OrderFeesSettled), once per order and settlement, instead of a share of the exchange fee of each funded fill.
-- A reward names its order fee row and its settlement (order_fee_settlements) in place of the venue fill. Production has
-- no funded account yet, so no reward exists: the new NOT NULL columns refuse any row left from the exchange-fee rewards,
-- and the migration then fails whole instead of dropping what a referrer earned.
ALTER TABLE "referral_rewards" DROP CONSTRAINT "referral_rewards_venue_fill_id_unique";--> statement-breakpoint
ALTER TABLE "referral_rewards" DROP CONSTRAINT "referral_rewards_venue_fill_id_venue_fills_venue_id_fk";
--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD COLUMN "order" varchar(44) NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD COLUMN "funded_account" varchar(44) NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD COLUMN "settlement_signature" varchar(88) NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_order_order_fees_order_fk" FOREIGN KEY ("order") REFERENCES "public"."order_fees"("order") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_settlement_fk" FOREIGN KEY ("settlement_signature","funded_account") REFERENCES "public"."order_fee_settlements"("signature","funded_account") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_rewards_order_settlement_uq" ON "referral_rewards" USING btree ("order","settlement_signature");--> statement-breakpoint
ALTER TABLE "referral_rewards" DROP COLUMN "venue_fill_id";