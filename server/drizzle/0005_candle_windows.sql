-- GMTrade candle windows kept for the charts (modules/marketdata/history.ts): one unsettled latest window per series
-- (symbol × resolution, rewritten when it rotates or five minutes after its last write) and settled history windows.
-- Bounded per series to the app's reach of 30,000 bars (the oldest-fetched settled windows beyond it are evicted) plus
-- one window of at most 2,000 bars and the latest one. jsonb keeps a 300-bar page in about 10.5 KB: the backfill's
-- first fill (2,000 bars for 1h/4h/1D, 1,000 for 5m/15m, 68 markets) is about 20 MB, and since every page is kept once
-- it completes, a series grows to the cap over time (5m in about 100 days, 15m in about 300 days): about 70 MB per
-- interval at the cap, 360 MB if every one of the 68 × 5 series reached it.
CREATE TABLE "candle_windows" (
	"symbol" text NOT NULL,
	"resolution" integer NOT NULL,
	"start_time" bigint NOT NULL,
	"end_time" bigint NOT NULL,
	"candles" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled" boolean NOT NULL,
	CONSTRAINT "candle_windows_symbol_resolution_start_time_pk" PRIMARY KEY("symbol","resolution","start_time")
);
