-- Cost breakdown of every round trip (closed_trades.order_fees_usd, funding_usd, borrow_usd, price_impact_usd; fees_usd
-- keeps being order fees + funding + borrowing), backfilled from the fills each trip was written from, and the tick
-- timestamp from which a simulated order may execute (sim_orders.executable_from: practice orders on the first tick
-- published after the request, evaluation orders after the keeper delay). Pending orders from before this migration
-- may execute on any tick after it, which is what the new rule would give them.
ALTER TABLE "closed_trades" ADD COLUMN "order_fees_usd" numeric(38, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "closed_trades" ADD COLUMN "funding_usd" numeric(38, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "closed_trades" ADD COLUMN "borrow_usd" numeric(38, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "closed_trades" ADD COLUMN "price_impact_usd" numeric(38, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_orders" ADD COLUMN "executable_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_orders" ALTER COLUMN "executable_from" DROP DEFAULT;--> statement-breakpoint
-- Simulated trips: a closed position's fills; the trip row carries the position's account, market, side and open time.
UPDATE "closed_trades" t SET "order_fees_usd" = s.fees, "funding_usd" = s.funding, "borrow_usd" = s.borrow, "price_impact_usd" = s.impact
FROM (
  SELECT p.account_id, p.symbol, p.side, p.opened_at,
    sum(f.fee_usd) AS fees, sum(f.funding_usd) AS funding, sum(f.borrow_usd) AS borrow, sum(f.price_impact_usd) AS impact
  FROM sim_fills f JOIN sim_positions p ON p.id = f.position_id
  WHERE p.closed_at IS NOT NULL
  GROUP BY p.id
) s
WHERE t.venue = 'simulated' AND t.account_id = s.account_id AND t.symbol = s.symbol AND t.side = s.side AND t.opened_at = s.opened_at;--> statement-breakpoint
-- Funded trips: the fills of the closing fill's position since the previous close; the trip's id is derived from the
-- closing fill's GMTrade event id (modules/chain/venue.ts uuidOf: the first 32 hex digits of sha256("closed:<id>")).
UPDATE "closed_trades" t SET "order_fees_usd" = s.fees, "funding_usd" = s.funding, "borrow_usd" = s.borrow, "price_impact_usd" = s.impact
FROM (
  SELECT left(encode(sha256(convert_to('closed:' || c.venue_id, 'UTF8')), 'hex'), 32)::uuid AS id,
    sum(f.fee_usd) AS fees, sum(f.funding_usd) AS funding, sum(f.borrow_usd) AS borrow, sum(f.price_impact_usd) AS impact
  FROM venue_fills c
  JOIN venue_fills f ON f.funded_account = c.funded_account AND f.position = c.position AND f.venue_id <= c.venue_id
    AND f.venue_id > coalesce((
      SELECT max(p.venue_id) FROM venue_fills p
      WHERE p.funded_account = c.funded_account AND p.position = c.position AND p.size_after_usd = 0 AND p.venue_id < c.venue_id
    ), '')
  WHERE NOT c.is_increase AND c.size_after_usd = 0
  GROUP BY c.venue_id
) s
WHERE t.venue = 'gmtrade' AND t.id = s.id;
