# Props.trade

Props.trade is a prop firm where the money is onchain. A trader buys an evaluation, trades a simulated account against
live prices under fixed rules, and on passing (and identity verification) receives a funded account. The funded
account's capital is USDC held by a Solana program, `props_vault`; the trader opens and closes real perpetual-futures
positions on the exchange from that program, but can never withdraw the capital. Realized profit is split 80 % to the
trader and 20 % to the vault, paid by the program from realized USDC only. Every funded trade and payout is public
chain data.

**Status.** The trading app and the server are live (practice trading, charts, order ticket, referrals, search). The
`props_vault` program is built, audited and fuzzed; its mainnet deployment is pending, so evaluations, funded accounts
and payouts show "not initialized" in the live app until it is deployed.

## How it works

```mermaid
flowchart LR
    A["Buy evaluation<br/>(USDC fee, one transaction)"] --> B["Simulated evaluation<br/>live prices, real fee model,<br/>fixed rules"]
    B -->|"loss allowance breached"| F["Failed"]
    B -->|"profit target reached, flat"| C["Passed<br/>(result and trades root recorded onchain)"]
    C --> K["Identity verification<br/>(one funded account per person)"]
    K --> D["Funded account activated<br/>vault posts the loss allowance<br/>as USDC collateral"]
    D --> E["Real perps on the exchange,<br/>positions owned by the program"]
    E -->|"flat, profit above minimum"| P["Payout request"]
    P -->|"risk review"| S["80 % trader / 20 % vault<br/>paid in USDC by the program"]
    S --> D
```

- **Evaluation.** The trader pays the tier's fee in USDC to the program (`buy_evaluation`, one atomic transaction). The
  evaluation runs on the server's simulation engine, priced off the exchange's live prices with the exchange's own fee,
  price-impact, borrowing, funding and liquidation model. Rules by default: loss allowance 5 % of the account size as a
  static floor (open P&L and costs included), profit target 8 % net of costs, maximum exposure 1x the account size,
  per-market leverage caps. No daily loss limit, time limit or minimum days. The result and a Merkle root of the fill
  list are recorded onchain by the risk authority.
- **Funded account.** Activation moves the loss allowance from the capital vault to a data-less owner account that the
  program controls (one per funded account). Every order the trader places is created by the program with that account
  as owner and receiver, so profits, refunds and liquidation proceeds can only ever land back in it. The trader can open,
  close, set take-profit and stop-loss orders, and request payouts. There is no withdrawal instruction.
- **Payout.** When the account is flat and the trader's share is at least 50 USDC, the trader requests a payout; the risk
  service reviews it (identity verified, requested profit reconciles with indexed fills, no hedge or mirror positions
  across accounts) and the program pays the trader's share to the registered wallet and the vault's share to the capital
  vault. The account continues with its allowance reset.

Identical risk semantics apply to evaluation and funded accounts, so passing an evaluation predicts funded behaviour.
US persons and sanctioned regions are blocked (edge middleware and identity verification).

## Business model

```mermaid
flowchart TD
    T["Trader"] -->|"evaluation fee (USDC)"| FV["Fee vault"]
    T -->|"Props order fee: 2 USD + 0.1 % of order size,<br/>charged only when the order executes"| FV
    CV["Capital vault<br/>(seed capital, owner's money)"] -->|"loss allowance posted<br/>as collateral"| OA["Funded account<br/>(program-owned USDC)"]
    OA <-->|"trade P&L, exchange fees"| EX["Exchange pools<br/>(the counterparty)"]
    OA -->|"80 % of realized profit"| T
    OA -->|"20 % of realized profit"| CV
    OA -->|"account breached: remaining USDC returns"| CV
    FV -->|"10 % of the Props fee charged<br/>on a referee's funded orders"| R["Referrer<br/>(paid in USDC, identity-verified)"]
    FV -->|"sweep"| CV
```

Revenue lines:

| Line | Rule | Where it lands |
|---|---|---|
| Evaluation fee | per tier; defaults 10K / 79 USDC and 25K / 149 USDC enabled, 50K / 249 and 100K / 449 disabled by default (all admin-configurable onchain) | fee vault |
| Profit share | 20 % of realized profit at each payout | capital vault |
| Props order fee | 2 USD + 0.1 % (10 bps) of the order's size, per order, on every account stage; assessed when the order is placed, charged only when it executes, on the size it fills; never for cancelled orders, orders the exchange does not execute, liquidations or the forced close of a breached account | fee vault (funded); simulated on practice and evaluation accounts, where it lowers the virtual balance but is not revenue |
| Referral rewards (a cost) | 10 % of the Props fee charged on a referred trader's funded orders; nothing on simulated fees, waived fees or charges on a breached account | paid by hand in USDC to identity-verified referrers |

Where losses go. The vault never takes the other side of a trade. Positions are opened on the exchange's isolated GM
pools, which are the counterparty and pay winning trades. The vault only posts margin: the trader's loss allowance is
exactly the USDC the program moves into the funded account, and every position's collateral comes out of that balance.
Exchange positions carry no debt, so the most a funded account can lose is its allowance, even if a forced close is
late, a market is closed or liquidation is slow. When an account breaches, what remains returns to the capital vault.
Vault P&L = evaluation fees + order fees + 20 % of funded profits − allowances lost on breached accounts.

| Stage | Cost to the trader | What is simulated | What is real | Paid out |
|---|---|---|---|---|
| Practice | free | positions, fills, balance (25K virtual, reset any time) | prices, the exchange's fee and liquidation model, the Props fee (as a deduction only) | never |
| Evaluation | tier fee in USDC | positions, fills, balance | the fee payment, prices and cost model, the recorded result and trades root onchain | never |
| Funded | nothing further; Props fee per executed order | nothing | USDC collateral, positions on the exchange, fees, payouts | 80 % of realized profit when flat, minimum 50 USDC |

## Architecture

```mermaid
flowchart LR
    subgraph Browser
        APP["app/ (Vite, React)<br/>wallet-signed transactions built with packages/sdk"]
    end
    subgraph Server["server/ (Node 22, Fastify, one leader)"]
        API["HTTP API + SSE stream<br/>same-origin RPC relay"]
        MD["marketdata<br/>catalog, prices, candles, pool state"]
        SIM["sim<br/>practice + evaluation engine"]
        IDX["chain indexer<br/>program events, exchange fills, fee ledger"]
        KP["keeper (leader only)<br/>sync, breach, session guard,<br/>fee settlement, payout review"]
    end
    PG[("Postgres")]
    subgraph Solana["Solana mainnet"]
        PV["props_vault program"]
        GM["exchange store program"]
    end
    SRC["Exchange data services<br/>keeper WS prices, candles,<br/>market info, subsquid fills"]

    APP -->|"HTTPS, SSE"| API
    APP -->|"signed transactions via relay"| PV
    API --> MD & SIM & IDX & KP
    MD & SIM & IDX & KP --> PG
    SRC --> MD
    SRC --> IDX
    PV -->|"CPI: create, update, close orders"| GM
    IDX -->|"events, Position and Order accounts"| PV
    KP -->|"risk-authority transactions"| PV
```

- **Program** (`programs/props_vault`, Anchor reference; `programs-p/props_vault_p`, the Pinocchio build that deploys):
  holds the capital vault, fee vault and SOL treasury, one data-less owner account per funded account, tiers, the market
  allowlist with per-market leverage and size caps, identity locks, evaluations, funded accounts and payout requests.
  Admin, trader, risk-authority, KYC-authority and permissionless crank instructions; every state change is an event
  emitted by self-CPI so the indexer and the public search page can rebuild everything from chain data.
- **Prices and fills.** Live prices come from the exchange's keeper price feed (Chainlink Data Streams, the feed the exchange
  executes against; spot-checked equal to the onchain values), candles from its candle service with the server's own price record for 1m/3m bars and
  history kept in Postgres, pool state from the onchain Market accounts. Funded fills come from the exchange's indexer and
  from reading the owner accounts' Position and Order accounts directly. The server never holds user keys; the browser's
  RPC goes through the server's allowlisted relay so no provider key ships in the bundle.
- **Simulation.** The engine runs the exchange's own model (`packages/gmsol-wasm`, the exchange SDK built to WASM) against
  the live Market account with the simulated position added to it, and executes each order on the first price tick after
  the measured keeper delay, so simulated fills track what a funded order would have got.

One funded order, end to end:

```mermaid
sequenceDiagram
    participant W as Trader wallet (browser)
    participant PV as props_vault program
    participant EX as Exchange program
    participant EK as Exchange keeper
    participant IX as Indexer (server)
    participant KP as Keeper (server, risk authority)

    W->>PV: open_position(market, side, size, collateral, acceptable price, max_fee)
    PV->>PV: check account, market, leverage, exposure, balance covers collateral + fees
    PV->>PV: assess the Props fee at the current rate, refuse if above max_fee
    PV->>EX: CPI create_order_v2 (owner = receiver = program-owned account)
    PV-->>W: OrderRequested event (fee and rate)
    EK->>EX: execute order, open the position (a few seconds later)
    IX->>PV: read events, Position and Order accounts
    IX->>IX: record the fill, mark the order's fee as due
    KP->>PV: sync(funded) - update slots, drop finished orders
    KP->>PV: settle_order_fees(charge, waive, expected_due, expected_settlements)
    PV->>PV: move the charge from the account's USDC to the fee vault
```

## Risk controls

- **Loss allowance as posted collateral, no debt.** The vault moves only the allowance into the funded account; each
  position's collateral comes from that balance; exchange positions cannot go negative. The worst case per account is its
  allowance, without depending on a bot being on time.
- **Breach detection and forced closes.** The keeper values every open funded account each tick (at most 5 s) from one
  consistent chain read and the exchange's model. Equity at or below the floor, confirmed by a second read, marks the
  account breached; positions still worth something are force-closed, positions worth nothing are left to the exchange's
  liquidation, and once flat the account is closed and the remaining USDC returns to the capital vault.
- **Session guard.** Stock, ETF and FX markets close outside their sessions and refuse decreases while closed, so from
  15 minutes before a close the keeper closes positions held above the closed-session leverage cap (on evaluation
  accounts too).
- **Liquidation is the exchange's.** Per-position liquidation runs on the exchange with its own keepers; the program's
  static floor and the keeper's checks sit on top of it. Keeper fills, liquidations and trigger orders are the exchange's
  and are not guaranteed; the product copy states this.
- **Onchain limits.** Per-market leverage, position size and open-interest caps; account-wide exposure cap; one active
  funded account per verified identity; a daily cap on newly posted principal; pauses for new evaluations, trading and
  payouts that never block closes, cancels or protective orders; every order's receiver pinned to the program-owned
  account; the program refuses any exchange call whose effect on the owner account exceeds what the order allows.
- **Payout review.** Flat account, identity verified, requested profit reconciled against indexed fills, no opposite or
  mirrored position across funded accounts in the same market within the review window; anything else is held for manual
  review.
- **Black-swan campaign.** A 20–40 % gap with a feed pause was run against the program (both builds), the keeper, the
  simulation engine and a local full-stack rehearsal. No program invariant broke in the scenarios built; 16 server
  findings (none critical or high) were fixed, among them working accounts eight at a time, a dynamic priority fee and
  one price per market per rules pass. One scenario, a malicious exchange upgrade mid-crash, was not built.
- **Audits and differential fuzzing.** Four audit rounds on the program, each with six independent lenses and every
  finding attacked with runnable tests: 18 confirmed findings fixed in both builds. A separate audit of the order-fee
  change fixed 11 defects. The differential fuzzer drives all 35 instructions with hostile mutations and an exchange
  keeper emulation against the Anchor reference and the Pinocchio build side by side, comparing every transaction's
  outcome and every touched account byte for byte and checking money and authorization invariants on each step:
  340,780 transactions on the audited binaries and 338,550 on the order-fee binaries, 0 differences, 0 violations.
  The deploy file is a reproducible `solana-verify` build whose executable hash every test suite prints.

## Repository map

| Path | What |
|---|---|
| `programs/props_vault/` | Anchor reference implementation of the vault program |
| `programs-p/props_vault_p/` | Pinocchio port that deploys; `compare/` byte-level diff harness, `fuzz/` differential fuzzers, `PORTING.md` |
| `packages/sdk/` | TypeScript client: IDL, PDAs, account decoders, transaction builders, fee helpers |
| `packages/shared/` | API contract (`src/api.ts`), Merkle trades root, sign-in message |
| `packages/gmtrade/` | Exchange data client: catalog, keeper API, market info, candles, indexer, onchain decoding |
| `packages/gmsol-wasm/` | The exchange SDK built to WASM (node and web) for the exact fill and liquidation model |
| `server/` | Fastify API and stream, modules `marketdata`, `sim`, `chain` (indexer, fee ledger, jobs), `keeper`; `drizzle/` migrations |
| `app/` | Vite/React trading interface; `middleware.js` edge geo-block and CSP; `tests/` browser suites |
| `tests/program/` | LiteSVM and local-validator suites for the program (mainnet rent, real exchange binary) |
| `scripts/admin/` | Operator scripts: initialize, authorities, tiers, markets, capital, pauses, order fee, settlements |
| `scripts/local-stack.ts` | The whole stack on a local validator with cloned mainnet accounts |
| `docs/ARCHITECTURE.md` | Build spec; section 8 holds the implementation notes that override the earlier sections |
| `docs/design/` | Design notes, including the order-fee design and screen plan |
| `docs/runbooks/launch.md` | Mainnet go-live procedure, rehearsed on a local validator |
| `HANDOFF.md`, `learnings.txt` | Operating manual and the dated record of decisions and verified facts |

## Build and test

Requirements: Node 22, Rust with `cargo build-sbf` (Solana 3.1 toolchain), Anchor 0.31.1, a local Postgres for the
server suites, Chrome for the browser suites.

```sh
export PATH=$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH
npm ci
scripts/fixtures.sh                                            # dumps the exchange program binary from mainnet (gitignored); MAINNET_RPC_URL overrides the public endpoint

# program: Anchor reference and the Pinocchio build
anchor build
cargo build-sbf --manifest-path programs-p/props_vault_p/Cargo.toml --sbf-out-dir target/deploy
export PROPS_VAULT_SO=$PWD/target/deploy/props_vault_p.so      # every suite prints the binary it loaded and its hash
npm test --workspace tests/program                              # LiteSVM suite
for s in admin trader risk trading crank audit fees; do node programs-p/props_vault_p/compare/$s.ts; done
FUZZ_QUICK=1 node programs-p/props_vault_p/fuzz/run.ts         # the full campaign without FUZZ_QUICK takes an hour
npm run test:validator --workspace tests/program               # solana-test-validator

# server (tests run against a disposable database whose name contains _test)
TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/props_server_test npm test --workspace server   # vitest suites, then the module suites

# app
cd app && npx vitest run && node tests/e2e.mjs && node tests/ui-review.mjs && node tests/review.e2e.mjs

# whole stack in Chrome on a local validator
LOCAL_STACK_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/props_fullstack_test node app/tests/fullstack.e2e.mjs
```

Run at most two LiteSVM fuzz processes at a time and never beside a validator (about 200 MB per seed). `server/README.md`
covers running the server locally; `docs/runbooks/launch.md` covers deployment.

## Security

Please report vulnerabilities privately to the contact in `SECURITY.md` rather than in a public issue. There is no bug
bounty programme at this time.

## Licence

The licence for Props.trade's own code is being decided; until a `LICENSE` file is added, all rights are reserved.
`packages/gmsol-wasm` contains compiled code from the exchange's repository under the Business Source
License 1.1; see its `NOTICE` and `LICENSE-GMTRADE`.

## Trademarks

Charts are rendered with TradingView's Lightweight Charts and carry the required TradingView attribution. GMTrade is the
exchange this program integrates with; its name is used here only to describe that integration.
