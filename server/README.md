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
| `POST /v1/kyc/start` `{ country }` | cookie | ISO alpha-2; US, US territories and comprehensively sanctioned countries refused; one pending request per wallet |
| `GET /v1/notifications` | cookie | newest 100 `Notification`s |
| `POST /v1/notifications/read` `{ ids? }` | cookie | marks the given ids (or all) read |
| `GET /v1/admin/kyc?status=&limit=` | admin | review queue with the linked chain job's status |
| `POST /v1/admin/kyc/:id/approve` `{ identityHash }` | admin | 32-byte hex salted identity hash from the review process; queues a `set_identity` chain job; one approved wallet per identity |
| `POST /v1/admin/kyc/:id/reject` `{ reason }` | admin | |

Admin routes take `Authorization: Bearer $ADMIN_API_TOKEN` (constant-time compare) and write `admin_audit_log`.
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
`GET /v1/sim/:id/fills`, `POST /v1/practice/reset` (all signed-in, own accounts only, else 404); implements `SimService`.
Orders are accepted by any process; fills, liquidations and the 1 s rules loop run on the holder of `LOCK_KEYS.sim`.
`SIM_FILL_DELAY_MS` (default 2000) is the keeper delay before an order may fill. Tests: `test/sim/` (own database
`<TEST_DATABASE_URL>_engine` / `_restart`, fed with live GMTrade state recorded by `test/sim/capture-fixtures.ts`).

## Deploy (Railway)

`server/railway.json` is config-as-code: set the service's root directory to the repo root and its config file path
to `server/railway.json`. Migrations run as the pre-deploy command; one replica; health check `/v1/health`;
15 s drain after SIGTERM. Set every required variable from `.env.example` in the service.
