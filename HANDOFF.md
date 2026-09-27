# Props.trade — handoff

Start here. Onchain prop firm on Solana: traders buy a simulated evaluation, and passers trade real perps on the
exchange (GMTrade, white-labelled) from a funded account whose capital sits in the `props_vault` program (one
data-less owner PDA per account owns the positions; the trader can open and close, never withdraw). 80/20 profit
split, paid by the program from realized USDC only.

## Read in this order

1. `learnings.txt` — the full record: decisions, verified exchange facts, risk register, build log (section 12 is
   the dated history; the last entries cover the order fee, referrals, compact design, mobile, black-swan work and
   the owner's questions about the venue). Append to it; never rewrite it.
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
- Props fee: $2 + 0.1 % per order on demo AND funded accounts. Referrers earn 10 % of the Props fee charged on their
  referees' funded orders; demo trades earn nothing.
- Demo (practice/evaluation) and real (funded) data live in separate tables (sim_* vs gm_orders/venue_fills/
  program events); keep it that way.

## State on 2026-09-27

- LIVE (main = daec993 and later docs): app on Vercel (propstrade.vercel.app), server + Postgres on Railway
  (migrations up to 0012). Evaluations, funded accounts and payouts show "not initialized" until the program is
  deployed; practice trading is fully live.
- Live features: TradingView-style chart with 13 intervals and history kept in Postgres; order ticket with TP/SL,
  expected P&L, per-market per-side leverage/size caps from the exchange's own model, the full cost breakdown and
  the Props fee; Search (any trader by wallet); referral program; watchlist shared across tabs; tab title = market +
  price; 55 markets (those without a USDC-only pool are hidden).
- Props fee: charged on practice/evaluation now (Railway ORDER_FEE_USDC=2, ORDER_FEE_BPS=10; GET /v1/order-fee says
  source 'server'). From the program's initialize on, every stage reads the program's rate, so set_order_fee must
  follow initialize immediately (runbook 10.1), or demo fees drop to 0.
- NOT on mainnet: the `props_vault` program. Pinocchio build 181,672 bytes (≈ 1.02 SOL of program data at the default
  `--max-len`), with the order fee. The deploy file is the `solana-verify` Docker build of 2026-09-27,
  `programs-p/props_vault_p/target/deploy/props_vault_p.so`, executable hash
  `a3dd0d389959ceb137e3050919f4eff148573aec631ec4d075e99f27257ae997` (LiteSVM 95/95 on it; the compare scenarios,
  quick fuzz and validator smoke still have to be re-run on this file: they ran on a local `cargo build-sbf` binary
  that differs in 4,451 bytes). Audited (09-23/24), black-swan campaign (09-25: no invariant broke; 16 server
  findings fixed), order-fee audit (11 defects fixed), full differential fuzz on the fee binaries (338,550
  transactions, 0 differences, 0 violations).
- Sign-ups so far: 2 wallets (2026-09-26 01:50 IST).

## What happens next, in order

1. Owner: send 3 SOL (13 SOL for the Anchor-fallback `--max-len`, runbook §4) to the operator key
   `5fWyePMCDoaLnShs7PTX3umcur1zQsDQ4rFB7UZdhCHH` (`~/.config/props-trade/operator.json`; 0 SOL on 2026-09-27),
   create the Alchemy app (PAYG with a spend limit) and hand over its key, decide `--max-len`, and say go. Get the
   exchange's written OK for charging fees on top of their code (BSL 1.1 licence; learnings 2026-09-26).
2. Operator: put the Alchemy HTTP URL in Railway `RPC_URL` and the streaming URL in `RPC_WS_URL` (both sealed,
   runbook §6), redeploy the server, check `/v1/health`; back up `keys/props_vault-keypair.json` and the operator
   key; re-run runbook §3.3 (compare ×7, `FUZZ_QUICK=1`, validator smoke, server module suites, full-stack e2e) with
   `PROPS_VAULT_SO` = the Docker file above.
3. Follow `docs/runbooks/launch.md` sections 4–10 with that file (the server already runs the fee-aware IDL, so the
   program can follow it): deploy with `PROGRAM_KEYPAIR=keys/props_vault-keypair.json`, configure (everything paused),
   small-money smoke test, `set_order_fee 2 / 10`, go live.
4. Hand over admin and the upgrade authority to the Squads vault (section 13) only once operations are boring.

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

- `node_modules/litesvm` is 1.4.1 since `npm ci` on 2026-09-27 (the lock's version; 0.8.0 before, which made the
  program suite refuse to start). Re-run `npm ci` after any checkout.
- The `solana-verify` Docker build (launch.md 3.2) was rehearsed on this Mac on 2026-09-27: `colima start
  --vz-rosetta`, ≈ 15 s, 181,672 B, executable hash `a3dd0d38…7ae997`; colima is stopped again (start it only to
  rebuild). A local `cargo build-sbf` binary differs from it in 4,451 bytes: only the Docker file is the deploy file.
- Program keypair: the source of truth is `keys/props_vault-keypair.json` (git-ignored, mode 600, the only copy: back
  it up). `target/deploy/props_vault-keypair.json` is a copy that `cargo clean` deletes and `anchor build` regenerates
  at random (it now holds `EznR…Ln1m`); never deploy it. `records.txt` line 109 still names that path: fix it.
- Operator key: `~/.config/props-trade/operator.json`, public key `5fWyePMCDoaLnShs7PTX3umcur1zQsDQ4rFB7UZdhCHH`,
  0 SOL on mainnet (2026-09-27).
- `--max-len` for the deploy is an owner decision: default +10 % (199,839 B, 1.016 SOL) or sized for an Anchor
  fallback (`MAX_LEN=1161274`, ≈ 5.90 SOL; the Anchor binary is 1,055,704 B now, so the older 1123117 leaves 6 %).
- The Privy app secret was once pasted into a chat: rotate it in the Privy dashboard.
- RPC provider is Alchemy (was Helius in the docs until 2026-09-27; every method and subscription the code uses is
  supported; PAYG $0.525/M CU, idle ≈ 23M CU/month, ≈ 41M CU/month ≈ $22 per funded account). The server runs on the
  public mainnet endpoint until the key exists; `RPC_WS_URL` must then be set too (the streaming host), or the indexer
  silently polls. `props.trade` is not bought.
- Owner decisions pending: phone-landscape layout (chart starts ~280 px down; folding the account strip/watchlist
  would hide content); a referral cut of evaluation sales (only real revenue from demo users).
- Keeper never sends `close_empty_position` (≈ 0.026 SOL rent per empty position stays locked); the exchange's
  UserHeader rent (≈ 0.0045 SOL per funded account) has no close instruction.
- Black-swan scenario 8 (a malicious exchange upgrade mid-crash) was not built.
- The CSP blocks `explorer-api.walletconnect.com` (console noise from the wallet library; harmless).
- Live-data tests (`marketdata 'live: routes…'`, `packages/gmtrade` live price share) fail when the exchange's data
  services are slow or on even UTC hours: known flakes, not regressions.

## Repo map

`programs/` Anchor reference · `programs-p/` Pinocchio port (+ `compare/`, `fuzz/`) · `packages/sdk` IDL + client +
fee helpers · `packages/shared` API contract · `packages/gmtrade`, `packages/gmsol-wasm` exchange data + exact fill
model · `server/` Fastify (marketdata, sim, chain indexer + fee ledger, keeper, referrals) + Postgres
(`server/drizzle` migrations) · `app/` Vite/React trading interface · `tests/program` LiteSVM + validator suites ·
`scripts/admin` operator scripts (incl. set-order-fee, settle-order-fees), `scripts/local-stack.ts` the full local
stack · `docs/design` design notes · `research/` raw research evidence.
