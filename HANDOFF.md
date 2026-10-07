# Props.trade — handoff

Start here. Onchain prop firm on Solana: traders buy a simulated evaluation, and passers trade real perps on the
exchange (GMTrade, white-labelled) from a funded account whose capital sits in the `props_vault` program (one
data-less owner PDA per account owns the positions; the trader can open and close, never withdraw). 80/20 profit
split, paid by the program from realized USDC only.

This file, `learnings.txt` and `research/2026-09-23-*.json` live in this repository (owner's call, 2026-10-07; the repo
is public, so never write a key, a secret or a trader's personal data in them). Only `records.txt` stays local. The repo
also has README.md, SECURITY.md, CONTRIBUTING.md and THIRD-PARTY-NOTICES.md.

## Read in this order

1. `learnings.txt` — the full record: decisions, verified exchange facts, risk register, build log (section 12 is
   the dated history; the last entries cover the real-money exchange probe, the single package, the 0.10 + 0.1 % fee,
   the business-model discussion and the borrowing fee). Append to it; never rewrite it.
2. `docs/ARCHITECTURE.md` — the build spec; section 8 holds the implementation notes that override sections 1–7
   (incl. "Props order fee", "Referrals", "Black-swan handling").
3. `docs/runbooks/launch.md` — the mainnet go-live procedure, rehearsed on a local validator; it deploys the
   Pinocchio build and sets the order fee right after initialize (section 10.1).
4. `docs/design/order-fee.md` — how the Props fee works on funded accounts (assess at placement, charge only when
   executed) and the owner's answers (section 10).
5. `programs-p/props_vault_p/PORTING.md` — the Pinocchio port: build, suite, byte-level compare harness, fuzzer.
6. `records.txt` (local only, git-excluded) — account identifiers and every deployment with its rollback target.

## Product rules from the owner (apply to every change)

- WHITE LABEL: the venue's name never appears in anything users see or fetch (UI, API values and messages, health,
  CSV, meta). Say "the exchange". The TradingView attribution stays (licence). An e2e sweep enforces it.
- SLEEK AND COMPACT: small paddings, one-row market heading, dense tables, a short ticket (Liq. price, Margin, Fees)
  with a big buy button, explanations in info buttons; type slightly larger than the old 8–12 px scale.
- MOBILE: every page works on phones; on touch inputs are 16 px (iOS zoom), targets 40 px, text 11 px, no sideways
  page scroll, chart swipes scroll the page.
- ONE PACKAGE: 9.99 USDC for a 1,000 USD account, 10 % loss allowance ("stop loss") on evaluation, funded AND practice
  (practice = 1,000 virtual / 100 allowance; older practice accounts keep 25K until the trader resets).
- Props fee: 0.10 USD + 0.1 % per order on demo AND funded accounts (charged only when an order executes). Minimum
  payout 10 USDC. Referrers earn 10 % of the Props fee charged on their referees' funded orders; demo trades earn
  nothing.
- Demo (practice/evaluation) and real (funded) data live in separate tables (sim_* vs gm_orders/venue_fills/
  program events); keep it that way.

## State on 2026-10-07

- PUBLIC REPO github.com/penguinpecker/propstrade, main = e27921d (branch protection, secret scanning, Dependabot on).
  This file, learnings.txt and the research JSONs are tracked in this repo since 2026-10-07; records.txt stays local.
- LIVE: app on Vercel (propstrade.vercel.app, bundle index-CvTAwEP5.js), server + Postgres on Railway (deployment
  5dbf5639…, migrations to 0012). Practice trading is fully live with the 0.10 + 0.1 % fee (Railway ORDER_FEE_USDC=0.10,
  ORDER_FEE_BPS=10). Evaluations, funded accounts and payouts show "Evaluations open soon" / "not initialized" until the
  program is deployed. 57 markets (the exchange's USDC-only pools).
- Recent fixes: the terminal's stage follows the wallet's accounts (no "No funded account" for practice users); the
  Accounts and Payouts empty states speak to practice traders; chart guide lines always reachable; dependency overrides
  (14 of 16 Dependabot alerts closed; bigint-buffer and braces have no fix; rand 0.7 sits in the program's graph).
- PROVEN WITH REAL MONEY (2026-10-05, no program deploy): `scripts/probe/exchange-roundtrip.ts` places the exact orders
  our program builds, from a throwaway wallet (`2KYXt6KND4S6UmbJcD3PGFUV1YFhrCWHtNfSps8iRQxt`, key
  `~/.config/props-trade/probe.json`, holds ≈ 1.45 USDC + 0.036 SOL). Two SOL round trips: market fills by the exchange's
  keepers in 3–6 s, a take-profit executed by their keeper on its own, a loss settled, a profit paid by the pool into the
  owner's account, a cancel refunded in full; exchange fees equal our quotes to the cent (0.020 % / 0.024 % by impact
  direction). NOT proven: the same with the program as owner, and our own payout — both need the mainnet deploy.
- NOT on mainnet: the `props_vault` program (Pinocchio, 181,672 B). Deploy file =
  `programs-p/props_vault_p/target/deploy/props_vault_p.so`, rebuilt 2026-10-05 at the current program source:
  byte-identical, executable hash `a3dd0d389959ceb137e3050919f4eff148573aec631ec4d075e99f27257ae997`. Gate on THAT file:
  LiteSVM 95/95, compare ×7 at 0 differences, quick fuzz clean, validator smoke pass, server modules green apart from the
  live-data flake; the full-stack journey on it failed only because SOL longs had no exchange capacity (journey fixed
  later in ea23e37 to trade the side with room; rerun it on the Docker file before deploying).
- SOL for the deploy (mainnet rent read 2026-10-05): program data 1.016 SOL at the default `--max-len` (0.924 at exact
  size) + 0.002 program account and writes = 1.02 SOL; through configuration and one funded account (authority floats
  0.30, treasury 0.25, accounts 0.02) = 1.59 SOL. Ask: 1.7 SOL to the operator key. Operator key balance: 0.
- Sign-ups so far: 2 wallets at 2026-09-26; more since (e.g. one practice trader); the server stores wallets
  only (no emails or Privy ids).

## Owner decisions pending (ask, do not assume)

1. PROFIT TARGET: the owner wrote "keep the 100 % as profit target"; asked whether 10 % was meant. Still 8 % in
   `scripts/admin/upsert-tiers.ts` RULES.profitTargetBps (one line + re-pin the terms hash in order-fee.test.ts).
2. BUSINESS MODEL: all-real funded (built) vs simulated funded (usual prop firm) vs hybrid (simulated funded, real tier for
   proven winners). Numbers in learnings 2026-10-05/07. Building the simulated/hybrid route ≈ a few days (stage rules,
   a vault-paid payout instruction in both builds + tests, keeper review, copy).
3. Holding cost in the ticket ("≈ $1.26/day"), offered after the owner asked about the borrowing fee.
4. Simulated fill delay: real keeper fills are 3–6 s (median 8 s on 09-28); the simulator uses 2 s (`SIM_FILL_DELAY_MS`).
   Recommend ≈ 5 s or a live measurement.
5. Phone-landscape layout; a referral cut of evaluation sales; a LICENSE for our code (all rights reserved until then).

## What happens next, in order

1. Owner: send 1.7 SOL to the operator key `5fWyePMCDoaLnShs7PTX3umcur1zQsDQ4rFB7UZdhCHH`
   (`~/.config/props-trade/operator.json`); create the Alchemy app (PAYG with a spend limit) and put its HTTP URL in
   Railway `RPC_URL` and the streaming URL in `RPC_WS_URL` (both sealed; unset WS = the indexer silently polls); get the
   exchange's written OK for charging fees on top of their code (BSL 1.1); rotate the Privy app secret.
2. Operator: back up `keys/props_vault-keypair.json` (the only copy; never deploy `target/deploy/props_vault-keypair.json`,
   which `anchor build` regenerates at random) and the operator key; redeploy the server after the RPC vars; rerun the
   full-stack journey with `PROPS_VAULT_SO` = the Docker file.
3. Follow `docs/runbooks/launch.md` sections 4–10 with that file: deploy with `PROGRAM_KEYPAIR=keys/props_vault-keypair.json`,
   configure (everything paused; `initialize.ts` sets min payout 10 USDC; `upsert-tiers.ts` the one package), the
   small-money smoke test (§9: the real program-owned order + our payout), `set-order-fee.ts --usdc 0.10 --bps 10`, go live.
4. Hand over admin and the upgrade authority to the Squads vault (§13) only once operations are boring.

## Build and test (from the repo root)

```sh
export PATH=$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH   # Homebrew cargo shadows rustup
anchor build                                                                              # the Anchor reference → target/deploy/props_vault.so
cargo build-sbf --manifest-path programs-p/props_vault_p/Cargo.toml --sbf-out-dir target/deploy   # dev build of the port
export PROPS_VAULT_SO=$PWD/target/deploy/props_vault_p.so    # absolute; every suite prints the binary it loaded + its hash
npm test --workspace tests/program                           # LiteSVM 1.4.1 (see open items), mainnet rent, real exchange binary
for s in admin trader risk trading crank audit fees; do node programs-p/props_vault_p/compare/$s.ts; done   # 0 differences
FUZZ_QUICK=1 node programs-p/props_vault_p/fuzz/run.ts       # the full campaign without FUZZ_QUICK takes an hour
npm run test:validator --workspace tests/program             # solana-test-validator 3.1
TEST_DATABASE_URL=postgres://…/props_server_test npm test --workspace server   # plus `npm run test:modules` in server/
cd app && npx vitest run && node tests/e2e.mjs && node tests/ui-review.mjs && node tests/review.e2e.mjs
LOCAL_STACK_DATABASE_URL=postgres://…/props_fullstack_test node app/tests/fullstack.e2e.mjs   # Chrome journey
```

Deploy recipe (Props.trade pushes and deploys without asking once tests pass; batch deploys): `git archive HEAD`
into a scratch folder → `railway up -d -s server -e production --path-as-root <export>` from the linked repo →
`vercel link --yes --project propstrade --team penguinpeckers-projects` in the export, delete `.env.local`,
`vercel deploy --prod --yes` (retry on "fetch failed") → a read-only watcher checks health, API, bundle hash and a
browser render → log it in `records.txt`. Railway variables: `railway variables --set K=V --skip-deploys` before
`railway up`.

Rules that came from pain:
- At most two LiteSVM fuzz processes at a time and never beside a validator (≈ 200 MB per seed; a run took the
  machine down). Parallel agents share one validator through a mkdir lock.
- After the verifiable `solana-verify` build, build nothing else into `programs-p/props_vault_p/target/deploy/`.
- Tests that move the keeper's clock must stamp their fixtures on the same clock (two flaky tests, 09-26).
- A commit cut from a working tree that also holds other work is tested alone in a clean clone before pushing.
- Keys never enter a chat or a commit; `records.txt` stays local; commits are authored by penguinpecker.

## Open items

- Probe wallet and `scripts/probe/`: rerun with `DRY_RUN=0 STEP=open|tp|sl|close|cancel-all|status|close-position`
  (see scripts/probe/README.md); the keeper API rate-limits one IP (HTTP 429): poll ≥ 30 s apart.
- Fee report for any trader: the public `/v1/traders/<wallet>` (Search page data) has per-position borrowing, funding,
  close fee and Props close fee, and per-trade fee splits; map an email to a wallet in the Privy dashboard first.
- The exchange's pools fill up: BTC/ETH/SOL longs and XAU have each hit capacity 0 at times since 10-03; quotes then
  answer 422 "No new long can be opened…" on every stage (demo mirrors real). A status line in the ticket would help.
- `node_modules/litesvm` 1.4.1 (npm ci); verifiable build needs `colima start --vz-rosetta`.
- `--max-len` default (199,839 B) unless the owner wants the Anchor-fallback sizing (`MAX_LEN=1161274`, ≈ 5.90 SOL).
- RPC: Alchemy (docs updated); the server runs on the public endpoint until the vars exist.
- Keeper never sends `close_empty_position` (≈ 0.026 SOL rent per empty position stays locked); the exchange's
  UserHeader rent (≈ 0.0045 SOL per funded account) has no close instruction.
- Black-swan scenario 8 (a malicious exchange upgrade mid-crash) was not built.
- `app/vercel.json` names the Railway API origin (public repo): the edge geo-filter can be bypassed; KYC residence is the
  binding gate.
- The CSP blocks `explorer-api.walletconnect.com` (console noise from the wallet library; harmless).
- Known flaky tests: `marketdata 'live: routes…'` (live data, even UTC hours), and `marketdata.test.ts` 'candle history:
  a restarted process…' hung twice on a docker Postgres (passes alone).

## Repo map

`programs/` Anchor reference · `programs-p/` Pinocchio port (+ `compare/`, `fuzz/`) · `packages/sdk` IDL + client +
fee helpers · `packages/shared` API contract · `packages/gmtrade`, `packages/gmsol-wasm` exchange data + exact fill
model · `server/` Fastify (marketdata, sim, chain indexer + fee ledger, keeper, referrals) + Postgres
(`server/drizzle` migrations) · `app/` Vite/React trading interface · `tests/program` LiteSVM + validator suites ·
`scripts/admin` operator scripts (incl. set-order-fee, settle-order-fees), `scripts/probe` the real-money exchange
round-trip probe, `scripts/local-stack.ts` the full local stack · `docs/design` design notes · `research/spike-vault`
the early CPI spike.
