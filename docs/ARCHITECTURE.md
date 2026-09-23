# Props.trade — architecture and build spec

Status: authoritative build spec, 2026-09-23. Every component in this repo implements this document.
Evidence for every factual claim below is in `learnings.txt` and `research/`.
If implementation proves a statement here wrong, fix the code to the facts AND update this file in the same change.

## 0. Non-negotiables

1. **Everything shown is real.** No synthetic prices, balances, markets, trades, receipts or records anywhere in the
   shipped app. Simulated trading (practice, evaluation) is real engine state priced off live GMTrade prices and
   is labelled "Simulated". When data is unavailable, show the loading / stale / unavailable state the design
   already defines, never a placeholder number.
2. **Chain: Solana mainnet-beta.** Money: USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` only.
   Venue: GMTrade store program `Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo`, store
   `CTDLvGGXnoxvqLyTpGzdGLg9pD6JexKxKXSV8tqqo8bN`, release v0.10.0 (commit 665fe60a).
3. **The vault can never lose more than it posts.** A funded account only ever receives its loss allowance
   (principal) as USDC. GMTrade positions carry no debt, so the worst case per account is its principal.
4. **Traders can trade but never withdraw capital.** The only token-out paths are: approved payout (trader's
   share of realized profit, to the trader's registered wallet) and returns to the capital vault.
5. **UI fidelity.** The interface in `app/` is the approved design (`docs/design/`, reference screens in
   `docs/design/reference-screens/`). Keep layout, components, styles, copy tone and routes. Change copy only where
   it described a preview ("illustrative", "sample", "preview wallet") and now must describe real behaviour, or where
   the venue does not support a control (then omit it, per SCREEN-PLAN §5 "omit unsupported controls").
6. **Secrets never in code, logs or docs.** Refer to them by env-var name only. No private keys in the repo.

## 1. Product rules (defaults; all stored onchain in `Tier` / `MarketConfig` and changeable by admin)

| Rule | Default | Notes |
|---|---|---|
| Tiers (account size S / fee) | 10K / 79 USDC, 25K / 149 USDC enabled; 50K / 249, 100K / 449 disabled (shown as "unavailable") | Pool depth (≈$0.8–1.8M per major market) limits size at launch |
| Loss allowance L | 5% of S, **static** floor `S − L`, includes open P&L and costs | Funded: L is the USDC principal actually posted |
| Profit target | 8% of S (evaluation only), net of costs | |
| Daily loss limit / time limit / min days | none / none / none | |
| Max total exposure | 1.0 × S (sum of open position notional) | `Tier.max_exposure_bps = 10000` |
| Margin model | Each position's margin (collateral) comes from the remaining loss allowance | Hard cap: loss per position ≤ its collateral |
| Per-market max leverage (size / collateral) | from `MarketConfig.max_leverage_bps`: crypto ≤ 25×, FX ≤ 20×, metals/oil ≤ 15×, stocks/ETFs ≤ 8× | GMTrade liquidates stocks at the close at ~10× (live: 23–36× NVDA liquidated 13 s after close); fees push the safe line to ≤ 8× |
| Closed-session leverage | `MarketConfig.closed_max_leverage_bps` (stocks/ETFs/FX 8×) | risk service closes positions above it before the session ends (US stocks ≈19:55 UTC) |
| Profit split | 80% trader / 20% vault (`Config.trader_share_bps = 8000`) | |
| Payout | when flat (no open positions, no pending orders), min 50 USDC trader share, reviewed by risk service, paid in USDC to the trader's wallet; account continues, allowance resets to L | |
| Funded accounts per person | 1 active (enforced by `IdentityLock`) | KYC authority sets identity; v1 = manual review |
| Order types | Market, Limit (increase); Take-profit (LimitDecrease), Stop-loss (StopLossDecrease) | GMTrade has no stop-entry: the "Stop" entry tab is removed |
| Tradable markets | GMTrade **pure USDC-USDC** markets only, on the allowlist (`MarketConfig.enabled`) | All 68 markets are listed and browsable; non-allowlisted ones show "Not available for funded trading" |
| Sessions | stock/ETF and FX markets close outside hours; risk service closes positions above the closed-market leverage cap before the close; decreases are impossible while closed | |
| Practice | free, 25K virtual, same engine and rules, reset anytime, never paid out | |
| Acceptable price | every order carries one; default slippage 0.5% (user-editable ≤ 5%) | protects against GMTrade's scheduled price-impact windows |
| Geo | block US persons and sanctioned regions (edge middleware + KYC country) | GMTrade terms bar US persons |

Evaluation and funded use **identical** risk semantics so passing an evaluation predicts funded behaviour.

Isolated margin caveat (state it in the rules copy): each position is backed only by its own collateral, so GMTrade
can liquidate one position while account equity is above the floor. The static account floor (incl. open P&L across
positions) is enforced by the risk service; the per-position collateral is the hard cap.

Definitions used everywhere (UI, engine, program, API):
- `size` S — account size (max total exposure).
- `allowance` — `equity − floor`; floor = `S − L`. Starts at L.
- `equity` — `S + realized P&L + unrealized P&L` (net of all costs).
- `available margin` — `allowance_realized − Σ collateral of open positions − Σ collateral of pending increase orders`,
  where `allowance_realized = L + realized P&L` (for funded: the owner PDA's USDC balance).
- `buying power` for a new order = `min(S × exposure − Σ open notional, available margin × market max leverage)`.
- `qualifying profit` (evaluation) = realized + unrealized P&L net of costs; pass when ≥ target with no floor breach,
  after all positions are closed or marked (see §4.3).

## 2. System overview

```
 app/ (Vite React, Vercel)  ──HTTPS/SSE──►  server/ (Node 22, Railway, one replica + leader lock)  ──►  Postgres (Railway)
      │  wallet-signed txs                        │  marketdata  (GMTrade keeper WS + market-info + candles + subsquid)
      ▼                                           │  sim engine  (practice + evaluation, gmsol-sdk 0.10.0 WASM model)
 Solana mainnet ◄───── risk-authority txs ─────── │  indexer     (props_vault events + GMTrade positions of owner PDAs)
   props_vault (Anchor 0.31.1)                    │  keeper      (sync, stop-outs, session closes, cleanup, top-ups, payouts)
     └─CPI─► GMTrade store (v0.10.0)              │  api         (SIWS auth, accounts, sim orders, payouts, verify, vault)
```

Repo layout (npm workspaces):

```
programs/props_vault/        Anchor program (workspace root Anchor.toml/Cargo.toml at repo root)
tests/program/               program tests on solana-test-validator with the mainnet GMTrade binary + cloned accounts
packages/shared/             API contract types (src/api.ts) — single source of truth for server + app
packages/sdk/                TS client for props_vault: PDAs, account decoders, instruction/tx builders (from IDL)
packages/gmtrade/            TS GMTrade data client: market catalog, keeper API (WS/HTTP), market-info, candles,
                             subsquid, onchain Market/Position decoding
packages/gmsol-wasm/         gmsol-sdk 0.10.0 built to WASM (nodejs + web targets) + liquidation-price fix
server/                      API + engine + indexer + keeper
app/                         the approved interface, wired to real data
docs/                        this spec, design docs, runbooks
research/, learnings.txt     evidence
```

## 3. Onchain program `props_vault`

Anchor 0.31.1, `gmsol-programs = "=0.10.0"` (features `store`), `anchor-spl` with `token, token_2022, associated_token`.
Build with `~/.cargo/bin` first on PATH (see learnings). Never call `gmsol_programs::…::utils::Account::try_from`
onchain (23 KB stack). Read GMTrade `Position` fields by fixed offsets derived from the 0.10.0 IDL, with a test that
checks the offsets against cloned mainnet Position accounts.

### 3.1 Accounts (PDAs)

| Account | Seeds | Key fields |
|---|---|---|
| `Config` | `["config"]` | admin, pending_admin, risk_authorities (≤4), kyc_authority, usdc_mint, gmtrade_program, gmtrade_store (pinned at init), trader_share_bps, min_payout, owner_sol_target, owner_sol_min, pause flags (new_evaluations, trading, payouts), totals (fees_collected, allocated_principal, payouts_paid, profit_to_vault), counters, bumps |
| vault authority | `["vault"]` | data-less signer that owns the three USDC token accounts below |
| `capital_vault` | ATA(vault authority, USDC) | seed capital; source of principal |
| `fee_vault` | `["fee_vault"]` token account (owner = vault authority) | evaluation fees |
| `sol_treasury` | `["sol_treasury"]` | data-less, system-owned; pays owner-PDA SOL float and rents |
| `Tier` | `["tier", id:u16]` | size_usd, fee_usdc, profit_target_bps, max_drawdown_bps, max_exposure_bps, enabled, terms_hash[32], version |
| `MarketConfig` | `["market", gm_market_token]` | enabled, index_symbol[16], max_leverage_bps, closed_max_leverage_bps, max_position_usd, max_total_oi_usd (all funded, per side), oi_long_usd, oi_short_usd, session_restricted |
| `TraderProfile` | `["trader", wallet]` | wallet, identity_hash[32] (zero = unverified), verified_at, active_funded:u8, evaluation_count:u32 |
| `IdentityLock` | `["identity", identity_hash]` | profile — `init` only, so one wallet per person |
| `Evaluation` | `["evaluation", wallet, index:u32]` | trader, tier_id, terms snapshot (size, target_bps, dd_bps, exposure_bps, share_bps, terms_hash), fee_paid, status (Active, Passed, Failed, Funded, Refunded), created_at, resolved_at, final_equity:i64, trades_root[32] |
| `FundedAccount` | `["funded", evaluation]` | trader, evaluation, owner_bump, terms snapshot, principal, status (Active, Restricted, PayoutPending, Breached, Closed), slots[8] {market_token, is_long, gm_position, collateral, size_usd, last_sync}, orders[8] (tracked GMTrade order pubkeys), payouts_paid, payout_seq, created_at, last_sync_at |
| owner PDA | `["owner", funded_account]` | **data-less, system-owned** signer; owns all GMTrade user/position/order accounts and the account's USDC ATA |
| `PayoutRequest` | `["payout", funded_account, seq:u32]` | balance_at_request, profit, trader_amount, vault_amount, status (Requested, Paid, Rejected, Cancelled), reason_code, created_at, resolved_at |

### 3.2 Instructions

Admin (signer = `Config.admin`):
`initialize` (only the program's upgrade authority, checked via ProgramData; pins USDC mint + GMTrade program/store),
`propose_admin` / `accept_admin`, `set_authorities` (risk ≤4, kyc), `set_params`, `set_pauses`, `upsert_tier`,
`upsert_market`, `deposit_capital`, `withdraw_capital` (≤ capital_vault balance; never touches principal already
posted), `sweep_fees` (fee_vault → capital_vault), `withdraw_sol_treasury`.

Trader (signer = trader wallet):
- `buy_evaluation(tier_id)` — tier enabled, not paused; `transfer_checked` fee USDC trader → fee_vault; init-if-needed
  `TraderProfile`; init `Evaluation` with terms snapshot. One atomic tx = payment + entitlement.
- `activate_funded(evaluation)` — evaluation `Passed`, profile verified, `active_funded == 0`, capital available;
  creates `FundedAccount`, owner PDA ATA, moves principal `L = size × dd_bps` capital_vault → owner ATA, tops the owner
  PDA up to `owner_sol_target` from `sol_treasury`, `Evaluation.status = Funded`.
- `open_position(market_token, is_long, kind: Market|Limit, collateral, size_delta_usd, trigger_price, acceptable_price)`
  — account `Active`, trading not paused, market enabled; `collateral ≤ owner ATA balance`; `size/collateral ≤
  max_leverage`; `size ≤ max_position_usd`; exposure: `Σ slot size + Σ pending increase size + size ≤ S × exposure`;
  market OI cap; free slot or existing slot for (market, side); tracked orders < 8; `acceptable_price != 0`.
  Creates order escrow ATA idempotently (payer = owner PDA), CPIs `prepare_user`, `prepare_position`,
  `create_order_v2` (MarketIncrease or LimitIncrease; owner = receiver = owner PDA; collateral token = USDC;
  final_output_token = USDC). Records the order; updates market OI; emits `OrderRequested`.
- `close_position(market_token, is_long, size_delta_usd, acceptable_price)` — trader or risk authority;
  MarketDecrease (u128::MAX size closes all; GMTrade caps to position size).
- `set_protection(market_token, is_long, kind: TakeProfit|StopLoss, trigger_price, size_delta_usd)` — trader;
  LimitDecrease / StopLossDecrease.
- `update_order(order, trigger_price, acceptable_price, size_delta_usd)` — trader; `update_order_v2`.
- `cancel_order(order)` — trader or risk authority; `close_order_v2` with executor = owner = receiver = rent_receiver =
  owner PDA; drops the order from tracking.
- `request_payout()` — account Active; last sync shows all slots flat and no tracked orders; profit =
  owner ATA balance − principal; trader_amount = profit × share ≥ min_payout; status → PayoutPending (blocks opens).
- `cancel_payout(request)` — trader, while Requested.

Risk authority (signer ∈ `Config.risk_authorities`):
- `record_evaluation_result(evaluation, passed, final_equity, trades_root)` — Active → Passed | Failed.
- `approve_payout(request)` — re-checks flat + balance in the same instruction (positions passed as remaining
  accounts, verified by seeds, must be size 0 or absent); pays trader_amount → trader's USDC ATA (init-if-needed,
  payer sol_treasury) and vault_amount → capital_vault; status back to Active.
- `reject_payout(request, reason_code)`.
- `restrict(funded, restricted: bool)`, `mark_breached(funded)`, `close_funded(funded)` (flat only: remaining USDC →
  capital_vault, remaining SOL → sol_treasury, principal released from totals).
- `force_close` = `close_position` signed by risk authority.

KYC authority: `set_identity(profile, identity_hash)` — inits `IdentityLock` (fails if the person already has a wallet).

Permissionless cranks:
- `sync(funded)` — remaining accounts = the GMTrade Position account for every slot and every tracked order account.
  Position accounts must be owned by the GMTrade program and match `["position", store, owner_pda, market_token, usdc, kind]`
  (kind 1 = long, 2 = short, per v0.10.0 IDL). Order accounts that no longer exist or are not owned by GMTrade are
  dropped. Updates slot size/collateral, frees flat slots, updates market OI, sets `last_sync_at`.
- `top_up_owner(funded)` — owner lamports < owner_sol_min → transfer from sol_treasury up to owner_sol_target.
- `close_completed_order(funded, order)` — owner-signed `close_order_v2` for orders GMTrade left open (missing ATA case).

Events for every state change (`EvaluationPurchased`, `EvaluationResolved`, `FundedActivated`, `OrderRequested`,
`OrderCancelled`, `ProtectionSet`, `Synced`, `PayoutRequested`, `PayoutPaid`, `PayoutRejected`, `AccountRestricted`,
`AccountBreached`, `AccountClosed`, `CapitalDeposited`, `CapitalWithdrawn`, `FeesSwept`, `ConfigChanged`) so the
indexer and the Verify page can reconstruct everything from chain data alone. Events are emitted with Anchor
`emit_cpi!` (a self-CPI signed by the `["__event_authority"]` PDA), never as log lines: Solana keeps only the first
10,000 bytes of a transaction's logs, and anyone can fill them.

Invariants (tests must assert each; security review must try to break each):
- No instruction moves USDC out of an owner ATA except GMTrade order creation (to a GMTrade escrow), approve_payout
  (to the registered trader wallet + capital_vault) and close_funded (to capital_vault).
- Receiver of every GMTrade order = owner PDA. No trader-supplied receiver, referrer, builder-fee or token-account.
- Owner PDA stays data-less and system-owned; its lamports never go to a trader.
- Sum of principal posted ≤ capital deposited; `allocated_principal` tracks it exactly.
- A trader cannot act on another trader's accounts; risk authority cannot withdraw to itself.
- Pauses stop new risk (evaluations, opens, payouts) but never block closes or cancels.

## 4. Server

Node 22 + TypeScript, Fastify, Drizzle ORM + Postgres, zod, pino. One process, one Railway replica; money-moving
loops run only while holding a Postgres advisory lock (`pg_try_advisory_lock`).

### 4.1 marketdata
- Market catalog = GMTrade keeper GraphQL `markets` + `tokens` (+ categories) joined with market-info
  `/api/v2/solana/pairs` (24h volume, change, OI, funding/borrow, capacity) and our `MarketConfig` allowlist.
  All 68 markets (93 pools); one row per index asset, preferring the pure USDC-USDC pool.
- Live prices: keeper WS `wss://keeper-prod-api.gmtrade.xyz/graphql-ws` tokens subscription; drop any tick older
  than the last seen for that token; `isOpen` = session state. Fallback poll over HTTP. Stale threshold 20 s.
- Candles: `price-candle-mainnet.gmtrade.xyz/graphql` (60/300/3600/86400 s) with server cache; 15m and 4h are
  aggregated from 5m and 1h.
- Recent trades per market + trader history: GMTrade subsquid.
- Pool state (capacity, price impact inputs, fee factors, leverage limits) from onchain Market accounts, refreshed
  every 30 s and on the keeper `markets` subscription (GMTrade rewrites configs on a schedule).

### 4.2 auth
Sign-In With Solana: `POST /v1/auth/nonce` → message with domain, wallet, nonce, issued-at; wallet signs;
`POST /v1/auth/verify` checks the ed25519 signature → httpOnly, Secure, SameSite=Lax session cookie
(`SESSION_SECRET`). Sessions expire in 7 days; `POST /v1/auth/logout`.

### 4.3 sim engine (practice + evaluation)
- Uses `packages/gmsol-wasm` (gmsol-sdk 0.10.0 model with the HEAD liquidation-price fix) for fill price,
  price impact, open/close fees, borrowing and funding, and liquidation, fed with live market state.
- Market orders fill at the first price tick with `ts ≥ submit_time + 2 s` (measured keeper delay); limit and
  TP/SL trigger on ticks; fills use the side-correct min/max price like GMTrade.
- Refuse decreases and opens on closed markets (`isOpen = false`), like GMTrade. Apply the same leverage,
  exposure and margin rules as the program.
- Rules: continuous check of equity vs floor (breach → auto-close all, Failed) and target (≥ target with no open
  position → Passed; with open positions → "checking" until flat). On resolution the risk authority sends
  `record_evaluation_result` with `trades_root = sha256` Merkle root over the canonical fill list.
- Evaluation accounts are created when the indexer sees `EvaluationPurchased`. Practice accounts are created on first
  use per wallet.

### 4.4 indexer
Subscribes to props_vault logs + backfills by signature; decodes Anchor events into tables. Tracks GMTrade positions
and orders of every owner PDA (Position accounts by address; keeper API `user(owner)`; subsquid trade events) to
produce funded positions, fills, fees and realized P&L.

### 4.5 keeper (leader only)
Per funded account, every tick (≤ 5 s) and on account change:
1. `sync` when GMTrade state differs from the last synced state.
2. Equity with live prices via the model; if equity ≤ floor → `restrict` + `close_position` on every slot; alert.
3. Session guard: for session-restricted markets, 10 min before close, close positions whose leverage exceeds the
   closed-market cap.
4. Cancel TP/SL orders whose position is gone; `close_completed_order` for stuck orders; `top_up_owner`.
5. Payout review: flat, no linked opposite/correlated positions across accounts in the review window, identity
   verified → `approve_payout`, else hold for manual review (admin API) and alert.
6. Watch the GMTrade program's upgrade slot; on change → set trading pause, alert.
Alerts: Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), heartbeat URL (`HEARTBEAT_URL`), Sentry (`SENTRY_DSN`).

### 4.6 HTTP API
The contract lives in `packages/shared/src/api.ts`. Summary:
`GET /v1/health` · `GET /v1/config` (program id, tiers, share, pauses) · `GET /v1/markets` · `GET /v1/markets/:symbol` ·
`GET /v1/candles` · `GET /v1/markets/:symbol/trades` · `GET /v1/stream` (SSE: prices, market status, account updates,
notifications) · auth routes · `GET /v1/me` · `GET /v1/accounts` · `GET /v1/accounts/:id` (+ `/positions`,
`/orders`, `/history`, `/activity`, `/performance`) · `POST /v1/sim/:id/orders` · `DELETE /v1/sim/:id/orders/:orderId` ·
`POST /v1/sim/:id/positions/:positionId/close` · `PUT /v1/sim/:id/positions/:positionId/protection` ·
`POST /v1/practice/reset` · `GET /v1/payouts` · `GET /v1/payouts/:id` · `GET /v1/verify?q=` · `GET /v1/vault` ·
`POST /v1/kyc/start` · admin (`ADMIN_API_TOKEN`): payout review, KYC approve, pauses.
Funded trading, evaluation purchase, activation and payout requests are **wallet-signed transactions built in the
browser with `packages/sdk`**; the server never holds user keys.

## 5. Frontend (`app/`)
- Keep Vite + React 19, hash routes, all components/styles. Add `@solana/wallet-adapter-react` (Wallet Standard:
  Phantom, Solflare, Backpack, …) rendered inside the existing wallet dialog / ConnectPage designs; TanStack Query;
  SSE for live data. Env: `VITE_API_URL`, `VITE_RPC_URL`, `VITE_PROGRAM_ID`, `VITE_CLUSTER`.
- Replace `data.js` fixtures with API data; keep the formatting helpers.
- Screen index (`/screens`) and its 4K exports are design artefacts: dev builds only.
- Edge middleware (`app/middleware.js`, Vercel): 451 page for US and sanctioned countries.
- Every screen's states (loading, empty, stale, pending, failed, uncertain) come from real data.

## 6. Environments
- **local**: `solana-test-validator` with the mainnet GMTrade binary (dumped by `scripts/fixtures.sh`), cloned
  mainnet accounts (Store patched: `last_restarted_slot = 0` at byte 4800), props_vault deployed; server against local
  Postgres; app against local server. GMTrade keepers do not run locally: fills cannot happen; sync/payout paths are
  tested with patched Position/USDC fixture accounts.
- **mainnet**: program deployed by the operator keypair (upgrade authority → Squads multisig at handover), server on
  Railway, app on Vercel, RPC = Helius (`RPC_URL`, `RPC_WS_URL`). Secrets: `RISK_AUTHORITY_KEYPAIR`,
  `KYC_AUTHORITY_KEYPAIR`, `SESSION_SECRET`, `DATABASE_URL`, `ADMIN_API_TOKEN`, alert vars above.

## 7. Known limits (state them in product copy where relevant)
Keeper fills, liquidations and TP/SL triggers are GMTrade's (2–8 s, not guaranteed). Stock/FX positions cannot be
closed while their market is closed. GMTrade's price/indexer APIs are undocumented (no SLA). GMTrade code is BSL 1.1
(non-production) — written permission needed before charging fees. Legal review needed before a company launch.

## 8. Implementation notes (authoritative where they differ from §1–7)

Program (round 1, reviewed by two adversarial auditors, all findings fixed):
- `FundedAccount` slots also carry `pending_usd`; tracked orders are records {order, slot, order_type, size_usd,
  collateral, placed_by_risk}; `order_seq: u64` — GMTrade order nonces are derived by the program from this counter
  (never trader-chosen; reuse attacks closed). Traders cannot cancel/update risk-placed orders.
- `cancel_order` only accepts still-pending orders and never frees a slot; only `sync` (reading the GMTrade Position)
  frees slots. `sync` drops an order only once its account is gone; finished-but-open orders stay tracked (account not
  flat) until `close_completed_order` recovers their escrow.
- `approve_payout` / `close_funded` require the owner's GMTrade Position accounts to EXIST and be size 0 (absent
  addresses are rejected): the keeper passes SDK `fetchOwnerPositions()`.
- Decrease orders need size ≥ $1 (GMTrade min) or CLOSE_ALL. Every non-protective order needs acceptable_price ≠ 0;
  TP/SL have none so they can always execute.
- `initialize` starts with all pauses on; the trading pause also blocks `activate_funded`; pauses never block closes,
  cancels or protective orders. Capital vault ATA is `init_if_needed` (front-running initialize is harmless).
- Build: `opt-level = "s"` → 899 KB (rent ≈ 4.57 SOL; have ~10 SOL during deploy for the buffer). CU: open ≈ 166k,
  open + stop-loss in one v0 tx ≈ 283k (SDK default limit 400k). Owner PDA float target 0.25 SOL / min 0.05 SOL.
- Round 2: events moved to `emit_cpi!` (every event-emitting instruction takes `event_authority` + `program`; the SDK
  passes them and `sharedLookupAddresses()` includes the event authority). The indexer reads events from the
  transaction's inner instructions (`innerInstructionsOf` + `parseEvents`), which a trader cannot cut off with log spam
  (50 memos ahead of an instruction truncated its logs; the event survives). Cost: 978 KB (+79 KB); open ≈ 182k CU,
  open + stop-loss ≈ 308k (validator); open + stop-loss + take-profit without a lookup table 1,129 bytes, 40 of the 64
  instruction-trace entries, ≈ 455k CU; a risk `restrict` + 2 CLOSE_ALL closes fit one transaction without a lookup
  table (3 do not).
- Rent payers: trader pays Evaluation/TraderProfile/FundedAccount/PayoutRequest; sol_treasury pays owner float and
  payout ATAs; kyc authority pays IdentityLock.
- Known, accepted: third-party USDC sent to an owner ATA counts as balance → the payout review must reconcile requested
  profit against indexed GMTrade realized PnL before `approve_payout`. Execution-fee churn is bounded by the $1 minimum;
  the keeper alerts on high order churn.

Data (round 1): 15m/4h candles come natively from GMTrade's candle service (verified equal to aggregates).
`MarketState.raw` = raw base64 account images for the WASM model. The WASM model now runs GMTrade's
`update_fees_state` before every simulated action (reproduced 28/28 real fills: opens, full closes, liquidations, SOL VI).
Candle prices are USD × 1e18 for every token. Subsquid ids are chain-ordered (`id_DESC` is fast).

Server (round 1): Node 22 + tsx (no build step). Session cookie `__Host-props_session`. Global Origin check on unsafe
methods. Leader lock connection uses `max_lifetime: null`. `ModuleContext` carries config, db, sql, rpc, notify.
Money in DB = numeric(38,6).

App (round 1): `VITE_RPC_URL` and `VITE_API_URL` are required at build time (the public mainnet RPC rejects browser
requests). **The API must be same-site with the app** (e.g. app `props.trade`, API `api.props.trade`) or the
SameSite=Lax session cookie will not flow.

Sim engine (round 2, `server/src/modules/sim`):
- Account money is USDC. Every fill carries its realized P&L (an increase: its costs; a decrease or liquidation: payout
  minus collateral released), so realized P&L and a flat account's final equity are the sum over its fills.
- Because every position's collateral comes out of the available margin and positions carry no debt, equity reaches the
  floor only when every open position is worth nothing; GMTrade liquidates those in the same step, so a breach cancels
  pending orders and there is nothing left to close. The static floor still includes open P&L.
- Simulated positions are valued, changed and liquidated against the live Market account with the position added to
  its open interest, collateral sum and total borrowing, as a funded position would be (otherwise a simulated position
  larger than a thin or closed market's real open interest underflows the model, e.g. NVDA overnight: $561 long OI).
- The closed-market liquidation factor comes from the Market account itself (Closed flag + EnableMarketClosedParams →
  `market_closed_min_collateral_factor_for_liquidation`), which gmsol-programs' `MarketModel::position_params` applies.
- Every order (market, limit, TP/SL) executes only on a tick with ts ≥ its last change + `SIM_FILL_DELAY_MS`, so a limit
  set through the price cannot fill on a quote older than the keeper delay. Market orders expire after 30 min (GMTrade's
  request_expiration). TP/SL placed with an order arm when it fills; one of each per position; they die with it.
- TP/SL and 100% closes close the whole position at execution (CLOSE_ALL, as the funded path places them); their shown
  size follows the position. An account holds at most 8 pending orders (each TP and SL counts) and 8 (market, side)
  positions or pending increases, the program's MAX_ORDERS / MAX_SLOTS. A reused client id with a different request → 409.
- Borrowing and funding accrue from a position's last change (its Position image carries GMTrade's increased_at /
  decreased_at): while the Market account is older than that change, the model restarts its fee clocks there from the
  position's own snapshots, as GMTrade's execution would have committed them; once the market changes onchain later,
  its committed accrual is used, as for every position.
- The leader values every account with open positions in memory each second and locks an account only when a rule has
  work (liquidation, expired market order, status change, 5-min snapshot); ticks lock only accounts with an order the
  tick can execute. Accounts with only resting orders cost nothing.
- Gap: the closed-session leverage guard (§1, §4.5.3) does not yet run for evaluations: it needs the keeper's session
  schedule (keeper/sessions.ts in the keeper track) to know when a session closes. Until then an evaluation can hold a
  position above `closedMaxLeverage` through a close.
- trades_root encoding: `server/src/modules/sim/merkle.ts`, leaves from `GET /v1/sim/:id/fills`. Results go through the
  `sim_results` outbox: `onResolved` fires when decided and again every 5 min / at leadership start until
  `markRecorded`, so the chain module's handler must be idempotent.

Round 2 module ownership:
- `server/src/modules/sim` — practice + evaluation engine; routes `/v1/sim/*`, `/v1/practice/*`; implements `SimService`.
- `server/src/modules/chain` — indexer, funded accounts, payouts, verify, vault, config, chain-job executor
  (set_identity, record_evaluation_result); routes `/v1/config`, `/v1/accounts*` (merges sim + funded),
  `/v1/payouts*`, `/v1/verify`, `/v1/vault`, admin payout review; implements `ChainService`.
- `server/src/modules/keeper` — leader-only risk loops (§4.5).
- `app/` — every page wired to real data and real transactions.

Chain module (round 2):
- Indexer: the logs subscription only wakes a catch-up; the catch-up pages `getSignaturesForAddress` (confirmed) back to
  `indexer_cursors.signature` and applies transactions oldest-first. Each transaction's `program_events` rows, projections
  and cursor commit in one database transaction, so a replay or duplicate delivery applies nothing twice. A projection
  error leaves the cursor before the transaction (retried with backoff), never skips it; the keeper alerts when a
  props_vault transaction has waited more than 5 min to be indexed (checked once a minute against the chain).
- Funded valuation: V = owner USDC + collateral escrowed in pending increase orders + Σ model net value (no debt);
  equity = S − L + V (allowance = V); realized = V − L − unrealized. A position the model cannot value counts at its
  collateral and the account's freshness is `unavailable`.
- GMTrade fills come from subsquid `tradeEvents` (by owner PDA); their transaction via `instructionRelations.txHash`,
  order outcomes via `orderRemoveds` (Completed = filled, Cancelled = GMTrade could not execute it, Pending + "cancel" =
  owner cancel). A decrease's realized PnL = `pnl + priceImpactValue − fees` (decrease price impact is charged to
  collateral outside `pnl`); a round trip then nets the owner's USDC flow to the cent.
- Chain jobs are unique per `subject` (evaluation or payout PDA, `lift:<funded>`): one result per evaluation, one
  decision per payout (keeper or admin, whoever first; a failed decision can be replaced; a failed job is queued again
  when its subject is enqueued again). The executor re-reads the chain before each attempt, simulates, stores the
  signature before sending, and confirms; a transaction seen `processed` is waited for, never re-planned. Work the chain
  shows done is confirmed with the signature of the indexed event that did it, never with a failed transaction of the
  job's. RPC and indexer trouble is retried for as long as it lasts (backoff capped at 5 min); a job fails for good only
  after 10 refusals by the chain itself (simulation or onchain failure, missing account). Operators:
  `POST /v1/admin/jobs/:id/retry` (a failed job), `POST /v1/admin/funded/:id/lift-restriction` (`restrict(false)`).
- `/v1/vault` reads Config with the three vault accounts in one call (one slot). `/v1/config` caches Config and the
  tiers for 30 s; an indexed `configChanged` drops the Config (and the tiers when it names a tier).
- `syncOrders` also resolves orders the indexed `sync` marked finished before the venue tick saw them; an order GMTrade
  cancelled gets a `cancel` activity row and a notification.
- `MarketState.prices` (unit prices) was added to the marketdata contract for model inputs. Index-token decimals are
  read from the index token's SPL mint (GMTrade index tokens are mints with no supply).

Keeper module (round 2):
- Each tick (≤ 5 s) the leader reads every open funded account fresh (FundedAccount, owner USDC + lamports, its GMTrade
  Position and Order accounts in ONE `getMultipleAccounts` call, i.e. one slot, re-read if the FundedAccount changed
  since it listed them; model valuation), plans ONE transaction (most urgent first: owner top-up, equity breach,
  session guard, upgrade restrict, cleanup, sync), sends it, reads again and re-plans until nothing is left. Every send
  first asks Postgres whether this session still holds `LOCK_KEYS.keeper`; if not, nothing is sent and the term ends.
- Breach = equity ≤ floor, i.e. V ≤ 0 (V as in the chain notes), decided only on `live`/`delayed` valuations and only
  when a second fresh read agrees: `restrict` (if active) + a CLOSE_ALL `close_position` per open slot in an open
  market, in one transaction when it fits. With all 8 tracked-order slots used it first recovers finished orders
  (`close_completed_order`), then cancels the trader's own pending orders: those on the slots being closed (TP/SL
  first), then increases elsewhere, another position's TP/SL last; the trader is told which. A slot with a pending risk
  close gets no second one.
  Forced closes carry "any price" bounds (long ≥ 1, short ≤ u128::MAX).
- Session guard: session-restricted markets map to a calendar by marketdata category (Stocks → NYSE 16:00 New York,
  13:00 on early closes, 2026–2027 holidays; Forex → Friday 17:00 New York). From 15 min before the close, positions with
  size / model net value above `closed_max_leverage_bps` are closed, only while marketdata says the session is open. The
  keeper alerts 30 days before the NYSE calendar runs out.
- Cleanup: finished-but-open orders → `close_completed_order` + `sync`; TP/SL whose position is gone → cancel, unless a
  pending increase on the slot is at least as old (placed together with an open). `sync` is sent exactly when it would
  change something (slot size/collateral/pending sum, a vanished order, an idle slot). `top_up_owner` below
  `owner_sol_min`.
- Payout review (requested, no decision job yet, payouts not paused): flat (no slot/order, every
  `fetchOwnerPositions` account size 0), identity verified onchain, requested profit ≤ realized P&L of indexed fills since
  the last paid payout + $0.01 per fill, and no other funded account added exposure (any increase fill, not only an
  open from flat) in the same market within 5 min of an increase of this account's with both positions still open
  after both (opposite = hedge, same side = mirror). Pass → `approve_payout`
  job; fail → `payouts.status = 'reviewing'` with `review_note` (operators only) + alert. A reconciliation shortfall
  younger than 5 min waits for GMTrade's indexer instead.
- GMTrade upgrade watch: the program data's last-deploy slot vs the newest `gmtrade_deploys` row (a lower slot, from a
  lagging RPC node, is ignored). First sight is accepted as reviewed when it equals `GMTRADE_DEPLOY_SLOT`, or when that
  is unset (with a warning alert); otherwise, and for every newer slot, it is an upgrade: alert, restrict every account
  that is active on every tick (payout-pending ones once they are active again, new ones once activated) and hold the
  payout review, until an operator acknowledges the deploy (`POST /v1/admin/gmtrade-deploys/:slot/acknowledge`). The
  keeper holds no admin key, so it cannot set the trading pause. `/v1/health` carries `keeper` (leader, last tick, last
  upgrade with `restrictedAt` / `acknowledgedAt`). Lifting each restriction after review is an operator action.
- Alerts (all optional, always logged): Telegram, Sentry (envelope API over HTTP), HEARTBEAT_URL after each tick; repeats
  of one alert key throttled to 30 min. Telegram gets one message per batch, at most every 4 s (its group limit is 20
  a minute), and a 429 is sent again after `retry_after`. Raised for breaches, failed keeper transactions, held payouts,
  GMTrade upgrades, stale prices (> 20 s) on markets with open funded positions, ≥ 50 orders/hour on one account, chain
  jobs failed for good, an account the keeper cannot read or value, and an indexer more than 5 min behind.
- The venue loop keeps reading an account's GMTrade fills for 3 min after it goes flat (subsquid lags ~35 s), so the
  closing fills a payout review reconciles against are indexed.
