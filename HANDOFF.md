# Props.trade — handoff

Start here. Onchain prop firm on Solana: traders buy a simulated evaluation, and passers trade real GMTrade perps
from a funded account whose capital sits in the `props_vault` program (one data-less owner PDA per account owns the
GMTrade positions; the trader can open and close, never withdraw). 80/20 profit split, paid by the program from
realized USDC only.

## Read in this order

1. `learnings.txt` — the full record: decisions, verified GMTrade facts, risk register, build log (section 12 is the
   dated history; the last entries are the Pinocchio audit and the runbook switch). Append to it; never rewrite it.
2. `docs/ARCHITECTURE.md` — the build spec; section 8 holds the implementation notes that override sections 1–7.
3. `docs/runbooks/launch.md` — the mainnet go-live procedure, rehearsed on a local validator; it now deploys the
   Pinocchio build.
4. `programs-p/props_vault_p/PORTING.md` — the Pinocchio port: build, suite, byte-level compare harness, fuzzer,
   every deliberate difference from the Anchor build.
5. `records.txt` (local only, git-excluded) — account identifiers and every deployment; `learnings.txt` refers to
   them as placeholders.

## State on 2026-09-24

- LIVE: the app (Vercel) and the server + Postgres (Railway). Evaluations, funded accounts and payouts show
  "not initialized" until the program is deployed.
- NOT on mainnet: the `props_vault` program. Two builds of the same interface exist:
  - `programs/props_vault` — Anchor 0.31.1, the reference and the source of the IDL (`packages/sdk/src/idl`);
  - `programs-p/props_vault_p` — the Pinocchio 0.11.2 port that gets deployed: 172,536 bytes, about 0.97 SOL of
    program data at the runbook's default `--max-len` (the Anchor binary would need 5.7 SOL).
- The port was audited on 2026-09-23/24: four rounds of six independent lenses, adversarial verification of every
  finding, 18 confirmed findings fixed in both builds, a 340,780-transaction differential fuzz campaign at 0
  differences, and a full conformance gate (suite 79/79 on both builds, compare scenarios at 0 differences,
  validator smoke, server and app suites, full browser journey). Details: `learnings.txt` section 12, 2026-09-24.
- `main` carries all of it (the `p1-pinocchio` branch was merged, fast-forward).

## What happens next, in order

1. Deploy the server from `main` first: its indexer must know the two instructions the audit added
   (`close_empty_position`, `collect_claimable`) before the program is live, or it stalls on their events.
   Deploy from a `git archive HEAD` export (`railway up`), follow the deployment to SUCCESS, check `/v1/health`.
2. Fund the operator key with at least 2 SOL (program data ≈ 0.97 SOL locked, plus config, tiers, markets, the two
   hot-key floats and the SOL treasury; `launch.md` section 15 has the rows).
3. Follow `docs/runbooks/launch.md` sections 1–10 with the Pinocchio build: verifiable build, every suite against that
   binary through `PROPS_VAULT_SO`, deploy, configure (everything stays paused), small-money smoke test, go live.
4. Hand over admin and the upgrade authority to the Squads vault (section 13) only once operations are boring.

## Build and test (from the repo root)

```sh
export PATH=$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH   # Homebrew cargo shadows rustup
anchor build                                                                              # the Anchor reference → target/deploy/props_vault.so
cargo build-sbf --manifest-path programs-p/props_vault_p/Cargo.toml --sbf-out-dir target/deploy   # dev build of the port
export PROPS_VAULT_SO=$PWD/target/deploy/props_vault_p.so    # absolute; every suite prints the binary it loaded + its hash
npm test --workspace tests/program                           # LiteSVM 1.4, mainnet rent, real GMTrade binary
for s in admin trader risk trading crank audit; do node programs-p/props_vault_p/compare/$s.ts; done   # 0 differences
FUZZ_QUICK=1 node programs-p/props_vault_p/fuzz/run.ts       # the campaign without FUZZ_QUICK takes an hour
npm run test:validator --workspace tests/program             # solana-test-validator 3.1
TEST_DATABASE_URL=postgres://…/props_server_test npm test --workspace server
LOCAL_STACK_DATABASE_URL=postgres://…/props_fullstack_test node app/tests/fullstack.e2e.mjs   # Chrome journey
```

Rules that came from pain:
- Run at most two LiteSVM fuzz processes at a time and never beside a validator: a child keeps about 200 MB per
  seed and the first audit run took the whole machine down.
- After the verifiable `solana-verify` build, build nothing else into `programs-p/props_vault_p/target/deploy/`.
- The docker Postgres (`props-pg`, port 55433) is unusable until the colima disk is pruned; `embedded-postgres`
  in a scratch directory runs every server suite.
- Keys never enter a chat or a commit; `records.txt` stays local; commits are authored by penguinpecker.

## Open items

- The `solana-verify` Docker build (launch.md section 3.2) has not been rehearsed on this machine: colima here is
  aarch64 without Rosetta and the image is amd64. Run it once with Docker up and take `<SO_SIZE>` and
  `<EXECUTABLE_HASH>` from that build.
- `--max-len` for the deploy is an owner decision: the default +10 % (≈ 0.97 SOL) or sizing for an Anchor
  fallback (≈ 5.7 SOL). After the Squads handover the vault cannot extend program data by itself (section 14.3).
- The Privy app secret was once pasted into a chat: rotate it in the Privy dashboard.
- The server's RPC is the public mainnet endpoint until a Helius key is provided; `props.trade` is not bought.
- GMTrade's UserHeader rent (≈ 0.0045 SOL per funded account) has no close instruction: a permanent cost.

## Repo map

`programs/` Anchor reference · `programs-p/` Pinocchio port (+ `compare/`, `fuzz/`) · `packages/sdk` IDL + client ·
`packages/gmtrade`, `packages/gmsol-wasm` GMTrade data + exact fill model · `server/` Fastify (marketdata, sim,
chain indexer, keeper) + Postgres · `app/` Vite/React trading interface · `tests/program` LiteSVM + validator suites ·
`scripts/admin` operator scripts, `scripts/local-stack.ts` the full local stack · `research/` raw research evidence.
