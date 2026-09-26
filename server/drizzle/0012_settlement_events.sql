-- One transaction can settle a funded account more than once (a hand-built one: two settle_order_fees naming consecutive
-- settlement counts). Each OrderFeesSettled now reaches the fee ledger: order_fee_settlements counts the settlements a
-- row stands for (`settlements`, which the keeper compares with the account's order_fee_settlements) and the index of the
-- last event it applied (`event_index`, so none is applied twice); a referral reward names its settlement's event index.
-- A reward from before this migration was the one settlement of its account in its transaction: index 0 keeps it unique.
DROP INDEX "referral_rewards_order_settlement_uq";--> statement-breakpoint
ALTER TABLE "order_fee_settlements" ADD COLUMN "settlements" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_fee_settlements" ADD COLUMN "event_index" integer;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD COLUMN "settlement_event_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_rewards" ALTER COLUMN "settlement_event_index" DROP DEFAULT;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_rewards_order_settlement_uq" ON "referral_rewards" USING btree ("order","settlement_signature","settlement_event_index");
