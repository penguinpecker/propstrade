-- White label (2026-09-25): the notes earlier releases stored on simulated orders named the venue; they now say "the
-- exchange", as new notes do (sim/engine.ts). These two were the only stored texts that named it; other rows are left.
UPDATE "sim_orders" SET "status_detail" = replace(replace("status_detail",
  'GMTrade would not execute this order', 'The exchange would not execute this order'),
  'Expired: GMTrade drops market orders', 'Expired: the exchange drops market orders')
WHERE "status_detail" LIKE '%GMTrade%';
