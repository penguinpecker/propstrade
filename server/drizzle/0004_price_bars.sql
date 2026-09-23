CREATE TABLE "price_bars" (
	"symbol" text NOT NULL,
	"t" bigint NOT NULL,
	"open" numeric(38, 18) NOT NULL,
	"high" numeric(38, 18) NOT NULL,
	"low" numeric(38, 18) NOT NULL,
	"close" numeric(38, 18) NOT NULL,
	CONSTRAINT "price_bars_symbol_t_pk" PRIMARY KEY("symbol","t")
);
