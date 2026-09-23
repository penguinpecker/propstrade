# @props/server

API, stream hub and module host for Props.trade (spec: `docs/ARCHITECTURE.md` §4, contract: `packages/shared/src/api.ts`).
Node 22, Fastify 5, Drizzle ORM on Postgres, zod config, pino logs. TypeScript runs through the `tsx` loader in every
environment (workspace packages export TypeScript source), so there is no build step; `npm run typecheck` checks types.

## Run locally

```sh
npm install                                   # from the repo root (npm workspaces)
cp server/.env.example server/.env            # fill in the required values
DATABASE_URL=… npm run migrate --workspace @props/server
npm run dev --workspace @props/server         # loads server/.env, restarts on change
```

## Test

Tests run against a real Postgres. `TEST_DATABASE_URL` must name a disposable database whose name contains `_test`;
the run drops and recreates it (plus `<name>_migrations`) and applies the committed migrations.

```sh
TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/props_server_test npm test --workspace @props/server
npm run typecheck --workspace @props/server
```

## Layout

| Path | What |
|---|---|
| `src/main.ts` | process entry: config, database, app, modules, graceful shutdown (SIGTERM/SIGINT abort `ctx.signal`, end streams, close the pool) |
| `src/app.ts` | Fastify app: security headers, CORS (`APP_ORIGIN` only, credentials), rate limit, 64 KB body limit, request ids, `ApiError` responses, core routes |
| `src/config.ts` | environment schema; startup fails naming every missing or invalid variable |
| `src/db/schema.ts` | schema for the whole app; units are documented at the top of the file |
| `drizzle/` | committed SQL migrations, generated with `npm run db:generate` after editing the schema |
| `src/auth/` | Sign-In With Solana and cookie sessions |
| `src/stream.ts` | SSE hub behind `GET /v1/stream` |
| `src/modules/` | module registry + contracts (`types.ts`); `marketdata`, `sim`, `chain`, `keeper` each live in their own folder |
| `src/lib/leader.ts` | Postgres advisory-lock leader election for money-moving loops |
| `src/lib/solana.ts` | RPC connection factory (commitment `confirmed`), signing-key loading, token helpers |

## HTTP routes in core

| Route | Auth | Notes |
|---|---|---|
| `GET /v1/health` | – | `{ status, db, modules }`; 503 when the database is unreachable (Railway health check) |
| `POST /v1/auth/nonce` `{ wallet }` | – | returns `NonceResponse`; the message is Wallet Standard sign-in text with domain, URI, chain id, nonce, 5-minute expiry |
| `POST /v1/auth/verify` `{ wallet, message, signature }` | – | signature base58; nonce single-use and bound to the wallet and exact message; sets the session cookie; returns `{ wallet, expiresAt }` |
| `POST /v1/auth/logout` | cookie | deletes the session, ends its open streams, clears the cookie |
| `GET /v1/stream` | optional cookie | SSE; frames are `data: <StreamEvent JSON>`; heartbeat every 15 s; wallet-scoped events reach only that wallet's connections, which end when their session is logged out or expires; at most 10 open per client address and 2,000 in total (else 429 `too_many_streams`); a client with 256 KB unread is dropped |
| `GET /v1/me` | cookie | `Me`: SOL and USDC balances (one RPC read; `null` when the RPC fails), trader profile PDA when it exists, KYC state |
| `POST /v1/kyc/start` `{ country, region? }` | cookie | ISO 3166-1 alpha-2 country; `region` ISO 3166-2, required for UA; US, US territories, comprehensively sanctioned countries and regions (UA-43, UA-40, UA-14, UA-09) refused; one pending request per wallet |
| `GET /v1/notifications` | cookie | newest 100 `Notification`s |
| `POST /v1/notifications/read` `{ ids? }` | cookie | marks the given ids (or all) read |
| `GET /v1/admin/kyc?status=&limit=` | admin | review queue with the linked chain job's status |
| `POST /v1/admin/kyc/:id/approve` `{ identityHash, country, region? }` | admin | 32-byte hex salted identity hash, made by `scripts/admin/identity-hash.ts` from the reviewed document, and the residence the documents show (checked like `/v1/kyc/start`, recorded on the request); queues a sealed `set_identity` chain job; one approved wallet per identity |
| `POST /v1/admin/kyc/:id/reject` `{ reason }` | admin | |

Admin routes take `Authorization: Bearer $ADMIN_API_TOKEN` (constant-time compare) and write `admin_audit_log`.
Chain jobs and evaluation results carry an HMAC keyed from `SESSION_SECRET` (`src/lib/integrity.ts`); the executor signs
nothing whose seal does not verify. Rotate `SESSION_SECRET` only when no chain job is queued or sent and every
evaluation result is recorded (`sim_results.recorded_signature` set): rows sealed with the old secret are never signed.
Errors always have the `ApiError` shape `{ error: { code, message } }`; every response carries `x-request-id`.

## Sessions and cross-site requests

The session cookie (`__Host-props_session`: host-only, Path=/, so no sibling subdomain can plant one) is httpOnly, Secure,
SameSite=Lax, 7 days. The database stores only HMAC-SHA256(`SESSION_SECRET`, token). Because the cookie is SameSite=Lax, the API must be served from the same site
as the app (e.g. `api.props.trade` next to `props.trade`); the app calls it with `credentials: 'include'` and opens
the stream with `new EventSource(url, { withCredentials: true })`. Writes (any method but GET, HEAD, OPTIONS) that carry
any other `Origin` are refused with 403, logout included.

## Modules

`src/modules/index.ts` registers `marketdata → sim → chain → keeper` from `src/modules/<name>/index.ts` (default export
`ModuleRegister`, see `types.ts`). A missing folder is logged as a warning and reported `absent` by `/v1/health`; a
module that throws during registration stops startup. `ctx.signal` aborts on shutdown. Routes that need a signed-in
wallet use `{ preHandler: app.requireWallet }` and read `request.wallet`. Money-moving loops wrap themselves in
`runAsLeader({ databaseUrl, key: LOCK_KEYS.keeper, signal, log, run })` and must stop when `run`'s signal aborts.

### sim (practice + evaluation engine)

`src/modules/sim`: routes `POST /v1/sim/:id/orders`, `DELETE /v1/sim/:id/orders/:orderId`,
`POST /v1/sim/:id/positions/:positionId/close`, `PUT /v1/sim/:id/positions/:positionId/protection`,
`GET /v1/sim/:id/fills`, `POST /v1/practice/reset` (all signed-in, own accounts only, else 404; the fill list of an
evaluation whose result is onchain is public, for recomputing its trades root); implements `SimService`.
Orders are accepted by any process; fills, liquidations and the 1 s rules loop run on the holder of `LOCK_KEYS.sim`.
`SIM_FILL_DELAY_MS` (default 2000) is the keeper delay before an order may fill. Tests: `test/sim/` (own database
`<TEST_DATABASE_URL>_engine` / `_restart`, fed with live GMTrade state recorded by `test/sim/capture-fixtures.ts`).

## Whole stack locally (rehearsal)

`scripts/local-stack.ts` runs Props.trade end to end on one machine, and `app/tests/fullstack.e2e.mjs` drives the whole
trader journey through it in Chrome (connect and sign in, markets, practice, checkout, evaluation to a pass, KYC,
activation, a funded GMTrade order with TP/SL canceled again, verify, vault), checking the UI against the database and
the chain at each step.

```sh
export PATH=$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH
scripts/fixtures.sh && anchor build                   # once: the GMTrade binary and target/deploy/props_vault.so
LOCAL_STACK_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/props_local_test node scripts/local-stack.ts [--trader <pubkey>]
LOCAL_STACK_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/props_local_test node app/tests/fullstack.e2e.mjs
```

What the stack starts (Ctrl-C stops all of it):

| Part | Where | Notes |
|---|---|---|
| solana-test-validator | RPC `127.0.0.1:38899`, websocket `:38900` (faucet, gossip and 38910-38950 too; `LOCAL_STACK_PORT` moves every port) | mainnet GMTrade binary at its address; the committed account snapshots (Store patched for the local restart slot); the markets' virtual inventories and index-token mints cloned from mainnet (read-only); props_vault deployed with a throwaway upgrade authority; 2,000 USDC for the operator and 100 USDC + 10 SOL for the trader at genesis (USDC cannot be minted) |
| operator setup | `scripts/admin/*` | the runbook's order: initialize, set-authorities (throwaway risk + KYC keys), upsert-tiers with `--test-tier 9:1000:1:10` (a $1,000 account, 1 USDC fee, 0.1% target; refused on mainnet), upsert-markets `SOL,BTC,ETH,XAU`, deposit 1,000 USDC, 5 SOL to `sol_treasury`, pauses off |
| server | `http://127.0.0.1:38951` | all four modules on the recreated database (its name must contain `_test`), live GMTrade market data, `NODE_ENV=test`; log file path printed at start and kept after exit |
| app | `http://127.0.0.1:38952` | production build with `VITE_CLUSTER=localnet` against the server and validator |

Keys are generated per run in a temporary directory that is deleted on exit; the paths of the trader key (when no
`--trader` is given; import it into a wallet set to the local validator) and of the admin API token are printed, never
the values. Mainnet is only read. GMTrade keepers do not run locally, so funded orders are created and canceled but
never filled.

`NODE_ENV=test` with `SOLANA_CLUSTER=localnet` adds one route for rehearsals, `PUT /v1/test/prices/:symbol` `{ "price": "87000" | null }` (admin token):
it pins a market's price, which then replaces the live one in every tick marketdata serves (and ticks every second),
so an evaluation can be decided through the sim engine's own rules on a known price path; live prices cannot make a
pass deterministic. It does not exist unless both are set, so a mis-set `NODE_ENV` on mainnet cannot open it.

## Deploy (Railway)

`server/railway.json` is config-as-code: set the service's root directory to the repo root and its config file path
to `server/railway.json`. Railpack builds it (`railpack.json` at the repo root pins the Node provider). Migrations run as
the pre-deploy command; one replica; health check `/v1/health`; 15 s drain after SIGTERM. Set every required variable
from `.env.example` in the service. The full procedure is `docs/runbooks/launch.md`.
