-- Indexes for the queries measured at production volume (docs/ARCHITECTURE.md §8, Postgres): the fills of a position
-- summed into its round trip (sim_fills.position_id, a sequential scan of every fill before), a funded account's sync
-- cursor max(venue_id) and a position's fills in chain order (venue_fills, which had only signature, venue_id and
-- (funded_account, ts): both walked the venue_id index backwards through every newer fill of every account), and the
-- positions an account has had, read index-only every venue tick (gm_position_snapshots.funded_account, position).
CREATE INDEX "gm_position_snapshots_funded_position_idx" ON "gm_position_snapshots" USING btree ("funded_account","position");--> statement-breakpoint
CREATE INDEX "sim_fills_position_idx" ON "sim_fills" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "venue_fills_funded_venue_id_idx" ON "venue_fills" USING btree ("funded_account","venue_id");--> statement-breakpoint
CREATE INDEX "venue_fills_position_venue_id_idx" ON "venue_fills" USING btree ("position","venue_id");