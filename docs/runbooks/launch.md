# Runbook: launch Props.trade on Solana mainnet

Audience: the operator who holds the deploy (operator) key and the Railway and Vercel accounts. It takes the repo at a
release commit to a live, verified, publicly usable deployment, then hands control to a Squads multisig. Do the sections
in order. Placeholders are `<ANGLE_BRACKETS>`. No key, seed, token or secret ever goes into this repo, a chat, a ticket
or a log; they are referred to by variable name only.

Every command below was run on 2026-09-23 against a local `solana-test-validator` (the mainnet GMTrade binary and cloned
mainnet accounts, throwaway keys), with the server started by the exact Railway commands and the app built by the exact
Vercel commands from a clean copy of the repo. Expected output below is from that rehearsal; addresses and signatures
differ on mainnet. On 2026-09-24 the deploy switched to the Pinocchio build of the program (`programs-p/props_vault_p`,
its `PORTING.md` deliberate difference 5): the order in section 0 and the id check, build, deploy, handover, upgrade
and cost steps of sections 2–4 and 13–15 changed with it, and the binary's size, rent and hash come from the
`solana-verify` build in section 3.2 (`<SO_SIZE>`, `<EXECUTABLE_HASH>`), not from that rehearsal.

Contents: [1 Prerequisites](#1-prerequisites) · [2 Keys](#2-keys) · [3 Build](#3-build-and-verify-the-binary) ·
[4 Deploy](#4-deploy-the-program) · [5 Configure](#5-configure-the-program-everything-stays-paused) ·
[6 Server](#6-server-on-railway) · [7 App](#7-app-on-vercel) · [8 Verify](#8-post-deploy-verification) ·
[9 Smoke test](#9-small-money-mainnet-smoke-test) · [10 Go live](#10-go-live) · [11 Monitoring](#11-monitoring-and-alerts) ·
[12 Emergencies](#12-emergency-procedures) · [13 Squads](#13-hand-over-to-squads) · [14 Upgrades](#14-later-upgrades) ·
[15 Costs](#15-costs) · [16 Variables](#16-environment-variable-reference)

## 0. Order and why

```
build → deploy → initialize (all paused) → authorities → tiers → markets → capital → SOL treasury
      → server (Railway) → app (Vercel) → verify → smoke test with a tiny tier → restore tiers, real capital
      → unpause → monitor → Squads handover (admin, upgrade authority) last
```

- `initialize` must be signed by the program's upgrade authority, so it runs before the upgrade authority moves to
  Squads. There is no IDL step: the onchain IDL is optional and this build has no IDL instructions (section 4).
- `initialize` starts with every pause on. Nothing a trader can do works until step 10 lifts them, so the program can
  be configured in public without anyone buying into a half-configured vault.
- Authorities before anything is sold (the risk key records evaluation results, the KYC key verifies identities);
  tiers before purchases; market configs before opens; capital before activations (`InsufficientCapital`); SOL treasury
  before activations (it pays each account's owner float); server and app before unpausing (the indexer and keeper must
  be watching when the first transaction lands).

## 1. Prerequisites

### Accounts and services

| What | Needed for | Notes |
|---|---|---|
| Domain (`<DOMAIN>`, e.g. `props.trade`) with DNS you control | app at `<DOMAIN>`, API at `api.<DOMAIN>` | The API **must** be a subdomain of the app's domain: the session cookie is SameSite=Lax, so it only flows between same-site origins. A `*.up.railway.app` or `*.vercel.app` address is a different site. |
| Vercel team on **Pro** | the app | Hobby is non-commercial only. Routing Middleware is included on every plan. |
| Railway project (Hobby or Pro) | the server + Postgres | One service, one replica. Pro adds team access and higher limits. |
| Helius **Developer** plan or higher | RPC for server, browser and operator | Two API keys: a server/operator key, and a browser key restricted to `<DOMAIN>` (dashboard → RPCs → Access Control Rules → Allowed Domains). The public mainnet endpoint refuses browser requests and rate-limits the rest. |
| Telegram bot | keeper alerts | Create with @BotFather (`TELEGRAM_BOT_TOKEN`), add it to the operators' group, read the group's chat id (`TELEGRAM_CHAT_ID`, negative for groups) from `https://api.telegram.org/bot<TOKEN>/getUpdates` after posting in the group. |
| Better Stack (or any heartbeat + uptime monitor) | keeper heartbeat, API uptime | A heartbeat URL (`HEARTBEAT_URL`) and an uptime monitor on `https://api.<DOMAIN>/v1/health`. |
| Sentry (optional) | keeper warnings/criticals | A project DSN (`SENTRY_DSN`). |
| Squads v4 multisig | handover (section 13) | Threshold ≥ 2, members on separate devices. You need its **vault** address (the PDA that signs), `<SQUADS_VAULT>`, not the multisig account. |
| GMTrade written permission | charging fees on a product that links `gmsol-programs` (BSL 1.1) | Spec §7. Also the legal review there. |
| KYC process | one funded account per person | v1 is manual review. Pick an identity salt (`IDENTITY_SALT`, 32+ random characters, kept offline) once; every identity hash is an HMAC under it (`scripts/admin/identity-hash.ts`, section 9), so it must never change. |

### Workstation

An offline-capable, disk-encrypted machine for the operator key. Versions used in the rehearsal:

```sh
export PATH=$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH
node --version             # v22.x (the repo pins "22.x")
solana --version           # solana-cli 3.1.14 (Agave)
anchor --version           # anchor-cli 0.31.1
solana-verify --version    # solana-verify 0.4.15 (needs Docker for `build`)
railway --version          # railway 4.x
vercel --version           # Vercel CLI 56.x
```

Check out the release commit and install exactly what the lockfile says:

```sh
git checkout <RELEASE_COMMIT>
npm ci --no-audit --no-fund
```

Set these for the rest of the runbook. The RPC URL carries the Helius API key, so read it without echo instead of
typing it into a command line, which the shell history keeps (the admin token and the identity salt are loaded the same
way in sections 8 and 9):

```sh
read -rs RPC_URL && export RPC_URL    # paste https://mainnet.helius-rpc.com/?api-key=<SERVER_HELIUS_KEY>, Enter
export KEYS_DIR=<ENCRYPTED_DIRECTORY_OUTSIDE_THE_REPO>     # every key file lives here, never in the checkout
export OPERATOR_KEYPAIR=$KEYS_DIR/operator.json             # section 2
export PROGRAM_KEYPAIR=$KEYS_DIR/props_vault-keypair.json   # section 2
export PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
export NODE_NO_WARNINGS=1                                   # hides a punycode deprecation warning from a dependency
```

`solana`, `anchor` and `solana-verify` print the full RPC URL, key included, in network errors: do not paste their
error output into a ticket or chat without removing it.

The admin scripts (`scripts/admin/*.ts`) take `--cluster mainnet-beta` (the default), which uses `RPC_URL`. They
**simulate by default** and print `dry run: ok, <n> CU` / `nothing sent; re-run with --execute to send`; add
`--execute` to send (`sent: <signature>`). A failing dry run prints the program's last log lines and exits 1 with
`…: the dry run fails, so nothing was sent`. Run each one without `--execute` first. `status.ts` is read-only and needs no
key: run it after every step and compare with what the step should have changed. If an `--execute` run fails with a
block-height or timeout error, run `status.ts` before retrying: the transaction may have landed.

## 2. Keys

| Key | Signs | Kept | SOL it needs |
|---|---|---|---|
| Operator (`OPERATOR_KEYPAIR`) | program deploy (upgrade authority), every admin instruction until section 13 | offline, encrypted; cold storage after handover | ≈ 0.97 SOL spent by the deploy at the default `--max-len` (section 15; ≈ 5.7 SOL when sized for an Anchor fallback, section 4); keep **≥ 2 SOL** (≥ 12 SOL for the fallback sizing) on it while deploying, plus what you send on to the treasury and authorities |
| Program keypair (`PROGRAM_KEYPAIR`) | only the first deploy (it creates the program address) | offline | none |
| Deploy buffer keypair | the deploy's write buffer (makes an interrupted deploy resumable) | next to the operator key; delete after the deploy | none |
| Risk authority (`RISK_AUTHORITY_KEYPAIR`) | keeper transactions, `record_evaluation_result`, payouts, restrictions | **only** as a Railway variable (hot) | 0.2 SOL (≈ 0.00003 SOL per keeper transaction at the server's fixed priority fee) |
| KYC authority (`KYC_AUTHORITY_KEYPAIR`) | `set_identity` | **only** as a Railway variable (hot) | 0.1 SOL (≈ 0.002 SOL of rent per verified trader) |
| Squads vault (`<SQUADS_VAULT>`) | admin and upgrades after section 13 | Squads members' devices | ≥ 0.01 SOL: the `--print-for` dry runs simulate with the vault as fee payer and fail if it holds nothing; a new tier or market config's rent (≈ 0.0014 SOL) comes out of it |

Create the operator key on the offline machine and check the program key matches the code.
`programs-p/props_vault_p/src/lib.rs` holds the id as the 32 bytes of `ID` (no `declare_id!`); the crate's
`constants_match_anchor` test asserts they equal `7qYRWwpmj3j3exVoBUJHzigcWmMN8ruPEdZdZrGzTJ7`, and every instruction
and account discriminator and PDA with them:

```sh
solana-keygen new -o "$OPERATOR_KEYPAIR"            # write the seed phrase on paper; never type it anywhere else
chmod 600 "$OPERATOR_KEYPAIR"
solana-keygen pubkey "$PROGRAM_KEYPAIR"             # must print 7qYRWwpmj3j3exVoBUJHzigcWmMN8ruPEdZdZrGzTJ7
cargo test --manifest-path programs-p/props_vault_p/Cargo.toml constants_match_anchor
# test tests::constants_match_anchor ... ok
# test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.00s
```

The risk and KYC keys are generated in section 5.2 by `gen-authority-key.ts`, which writes the key to a new file with
mode 0600 and prints only its public key and how to hand it to Railway; the file is deleted once Railway holds it. A
lost hot key is never recovered: generate a new one and run `set-authorities.ts` again.

Server secrets (section 6): `SESSION_SECRET` and `ADMIN_API_TOKEN`, each `openssl rand -hex 32`, typed straight into
Railway. Keep `ADMIN_API_TOKEN` in the operators' password manager: every admin API call needs it.

## 3. Build and verify the binary

1. GMTrade must still be the reviewed release. `scripts/fixtures.sh` refuses to continue when the deployed binary's
   sha256 differs from the pinned `6056a845…d20a`; if it fails, stop and re-test against the new GMTrade binary first.
   Record GMTrade's deploy slot for `GMTRADE_DEPLOY_SLOT` (section 6):

   ```sh
   MAINNET_RPC_URL="$RPC_URL" scripts/fixtures.sh
   solana program show Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo --url "$RPC_URL" | grep 'Last Deployed'
   # Last Deployed In Slot: 438769784        (value on 2026-09-23)
   ```

2. Build the binary you will deploy with `solana-verify` (Docker; the first run pulls a multi-GB image), so anyone can
   reproduce it from the public repo, and record its hash and size. The crate is `programs-p/props_vault_p`, its own
   Cargo workspace, so the binary lands in that workspace's `target/deploy/`. Give `build` the crate as an absolute
   path: `solana-verify` hands it to `docker run -v` verbatim, and Docker reads a relative path as a volume name:

   ```sh
   solana-verify build "$PWD/programs-p/props_vault_p" --library-name props_vault_p
   solana-verify get-executable-hash programs-p/props_vault_p/target/deploy/props_vault_p.so  # record <EXECUTABLE_HASH>
   wc -c programs-p/props_vault_p/target/deploy/props_vault_p.so                              # record <SO_SIZE>: ≈ 172.5 KB
   ```

   `<SO_SIZE>` and `<EXECUTABLE_HASH>` are what this build printed, and every size and rent figure below follows from
   `<SO_SIZE>`: a local `cargo build-sbf` of the same source gave 172,536 bytes on 2026-09-24 and the pinned Docker
   image a few bytes less in an earlier round, so never take either from a number written here.

3. Run the suites **against that binary**. Every process that loads the program (the LiteSVM suite, the validator
   smoke, the server module suites, `scripts/local-stack.ts` under the full-stack browser test, the Pinocchio side of
   the compare scenarios and of the fuzzers) takes it from `PROPS_VAULT_SO`, an absolute path; without it they load the
   Anchor build, `target/deploy/props_vault.so`. The six compare scenarios run every instruction on both builds and
   diff every outcome, inner instruction and account byte for byte: at 0 differences they are the proof that this
   binary implements the IDL the SDK ships (Anchor generates that IDL from the reference crate). They and the fuzzers
   need the Anchor reference binary, the one place `anchor build` still runs: it writes `target/deploy/props_vault.so`
   at the repo root, not the file being deployed.

   ```sh
   export PROPS_VAULT_SO=$PWD/programs-p/props_vault_p/target/deploy/props_vault_p.so
   cargo test --manifest-path programs-p/props_vault_p/Cargo.toml       # every hard-coded discriminator and PDA
   npm test --workspace packages/sdk
   npm test --workspace tests/program
   npm run test:validator --workspace tests/program
   TEST_DATABASE_URL=postgres://…/props_server_test npm run test:modules --workspace server
   LOCAL_STACK_DATABASE_URL=postgres://…/props_fullstack_test node app/tests/fullstack.e2e.mjs   # runs scripts/local-stack.ts
   anchor build                                                          # the Anchor reference binary, for the two lines below only
   for s in admin trader risk trading crank audit; do node programs-p/props_vault_p/compare/$s.ts; done   # each ends "<n> records, 0 differences"
   FUZZ_QUICK=1 node programs-p/props_vault_p/fuzz/run.ts                # ends "… 0 differences, 0 violations, 0 crashed, <n> min"; the full campaign takes an hour
   ```

   `npm test --workspace tests/program` runs on LiteSVM 1.4 with mainnet's rent and every runtime feature that release
   knows, among them SIMD-0459 (active on mainnet) and SIMD-0460 (pending), which police the account pointers and data
   lengths a program passes to the runtime. `test:validator` runs on solana-test-validator 3.1 with mainnet's feature
   set as far as 3.1 knows it: it predates both.

   Every process above that loads the program (each test file, the validator smoke, the server module suites, the
   local stack, each side of a compare scenario or fuzz job) first prints the binary it loaded on stderr,
   `props_vault binary: <path> (<bytes> bytes, executable hash <hash>)`, with the hash `solana-verify` computes (sha256
   of the file minus its trailing zeros): every line must name `$PROPS_VAULT_SO` with `<SO_SIZE>` bytes and
   `<EXECUTABLE_HASH>` from step 2, except the Anchor side of the compare scenarios and fuzzers
   (`target/deploy/props_vault.so`), or that run proved another file.

   After step 2, build nothing into `programs-p/props_vault_p/target/deploy/`: a plain `cargo build-sbf` in that crate
   would replace the verifiable binary (`PORTING.md`'s `--sbf-out-dir target/deploy` form writes to the repo root's
   `target/deploy/` and does not; neither does `anchor build`).

## 4. Deploy the program

Rent is ≈ 5,080 lamports per byte on mainnet (2026-09-23): the program data costs (`MAX_LEN` + 173) × 5,080 lamports,
and program data never shrinks. It is sized with `--max-len`; choose between:

- the default, 10 % headroom (≈ 17 KB, ≈ +0.09 SOL of rent; ≈ 0.965 SOL in all at 172,536 B): later, slightly larger
  releases of this build upgrade without an `extend`;
- sizing for a fallback to the Anchor build (`anchor build` gives 1,021,016 B on 2026-09-24; its +10 % is
  `MAX_LEN=1123117`, ≈ 5.7 SOL locked from the first day for a binary you may never deploy).

After the handover the Squads vault cannot extend it, and which other route works depends on a pending loader feature
(section 14.3; while ExtendProgramChecked is inactive, `scripts/admin/extend-program.ts` grows it with the operator
key), so choose `--max-len` for the largest release you expect to ship.

```sh
SO=programs-p/props_vault_p/target/deploy/props_vault_p.so   # the solana-verify build of section 3.2, not the Anchor build
SO_SIZE=$(wc -c < "$SO" | tr -d ' ')                         # = <SO_SIZE>
MAX_LEN=$(( SO_SIZE + SO_SIZE / 10 ))                        # the default; MAX_LEN=1123117 for the Anchor fallback sizing
solana rent $(( MAX_LEN + 45 )) --url "$RPC_URL"         # Rent-exempt minimum: ≈ 0.965 SOL (0.96500696 for 172,536 B; ≈ 5.7 for the fallback sizing)
solana balance "$(solana-keygen pubkey "$OPERATOR_KEYPAIR")" --url "$RPC_URL"   # ≥ 2 SOL (≥ 12 SOL for the fallback sizing)
```

Write the program into a buffer. The buffer keypair makes the write resumable: if it stops half-way (congestion, a
dropped connection), run the **same** command again; it only writes what is missing (a complete buffer re-run sends
nothing). Do not start a fresh buffer instead: each one holds the full rent until closed.

```sh
solana-keygen new --no-bip39-passphrase -o "$KEYS_DIR/deploy-buffer.json" && chmod 600 "$KEYS_DIR/deploy-buffer.json"
solana program write-buffer "$SO" --buffer "$KEYS_DIR/deploy-buffer.json" --max-len "$MAX_LEN" \
  --keypair "$OPERATOR_KEYPAIR" --url "$RPC_URL" \
  --with-compute-unit-price 100000 --max-sign-attempts 50 --use-rpc
# Buffer: <BUFFER_ADDRESS>                 (≈ 180 write transactions; ≈ 0.001 SOL of fees at this priority fee)
solana program show "$(solana-keygen pubkey "$KEYS_DIR/deploy-buffer.json")" --url "$RPC_URL"
# Authority: <OPERATOR>, Data Length: <SO_SIZE> (…) bytes
```

Deploy from the buffer (the buffer's lamports become the program data's rent; the buffer is consumed):

```sh
solana program deploy --buffer "$(solana-keygen pubkey "$KEYS_DIR/deploy-buffer.json")" \
  --program-id "$PROGRAM_KEYPAIR" --upgrade-authority "$OPERATOR_KEYPAIR" --keypair "$OPERATOR_KEYPAIR" \
  --max-len "$MAX_LEN" --url "$RPC_URL" --with-compute-unit-price 100000 --use-rpc
# Signature: <SIGNATURE>
# solana-verify reads finalized state, which trails the deploy by ≈ 15 s (until then it says the program
# "is not deployed"). Wait for it before checking the hash:
until solana program show "$PROGRAM_ID" --url "$RPC_URL" --commitment finalized >/dev/null 2>&1; do sleep 2; done
solana program show "$PROGRAM_ID" --url "$RPC_URL"
# Program Id: 7qYRWwpmj3j3exVoBUJHzigcWmMN8ruPEdZdZrGzTJ7
# Authority: <OPERATOR>             Data Length: <MAX_LEN> bytes
solana-verify get-program-hash --url "$RPC_URL" "$PROGRAM_ID"   # must equal <EXECUTABLE_HASH> from section 3
solana program show --buffers --keypair "$OPERATOR_KEYPAIR" --url "$RPC_URL"   # no buffers left
rm "$KEYS_DIR/deploy-buffer.json"
```

An abandoned buffer is closed (rent back to the operator) with
`solana program close <BUFFER_ADDRESS> --keypair "$OPERATOR_KEYPAIR" --url "$RPC_URL"`.

No IDL is published: the onchain IDL is optional (the server, app and SDK decode with the IDL bundled in `@props/sdk`,
which the compare scenarios in section 3 proved this binary implements), and this build has no IDL instructions
(`programs-p/props_vault_p/PORTING.md`, deliberate difference 5), so every `anchor idl` command fails against it.
Explorers can be served later by a tool that needs no instruction in the program, e.g. the Program Metadata program
(`@solana-program/program-metadata` on npm); check what the explorer reads before relying on it.

```sh
node scripts/admin/status.ts
# program       upgrade authority <OPERATOR>, last deployed at slot <SLOT>
# idl           CjZsvaPGt5HdaJq2pXquWf3Ww4fxtRzyb5CUk2iHm8we missing (optional: the server decodes with the IDL bundled in @props/sdk)
# config        6QjJWNQWg43efdr7qTrrqW2GqLETJcGJoHzBc8qYmc9q does not exist: run scripts/admin/initialize.ts
```

## 5. Configure the program (everything stays paused)

### 5.1 Initialize

Creates the Config, the fee vault and the capital vault, pins USDC and the GMTrade program and store, and sets the
spec §1 parameters (80 % trader share, 50 USDC minimum payout, owner float 0.25 SOL topped up below 0.1 SOL) and a
daily principal cap of 2,500 USDC: `activate_funded` posts at most that much principal per day (the window opens with
the first activation after the previous one ended). It bounds what a compromised risk or KYC key, or a tampered server
database, can put at risk; raise it as the vault grows with
`set-params.ts --trader-share-bps 8000 --min-payout 50 --owner-sol-target 0.25 --owner-sol-min 0.1 --max-daily-principal <USDC>`
(every parameter named, as a Squads proposal needs after section 13: section 12; the other four are the current values,
which `status.ts` prints). All three pauses start **on**.

```sh
node scripts/admin/initialize.ts              # dry run: ok, ~86000 CU
node scripts/admin/initialize.ts --execute    # sent: <signature>
node scripts/admin/status.ts
#   pauses              new evaluations PAUSED, trading PAUSED, payouts PAUSED
# warnings
#   - no risk authority: evaluations cannot be resolved and the keeper cannot act
#   - no KYC authority set: identities cannot be verified
#   - the SOL treasury holds less than one owner float (0.25 SOL): the next activation fails; …
```

### 5.2 Authorities

The keys go straight into the server's Railway variables, so first do section 6 steps 1–2 (project, Postgres and an
empty server service; nothing deploys yet). Then generate both hot keys, hand them to Railway, register them onchain
and fund them:

```sh
node scripts/admin/gen-authority-key.ts --role risk --out "$KEYS_DIR/risk-authority.json"
# Wrote a new risk authority keypair to …/risk-authority.json (readable by you only).
# Public key: <RISK_AUTHORITY_PUBKEY>
# 1. … railway variable set RISK_AUTHORITY_KEYPAIR --stdin --service <SERVER_SERVICE> --skip-deploys < …/risk-authority.json
# …
node scripts/admin/gen-authority-key.ts --role kyc --out "$KEYS_DIR/kyc-authority.json"
railway variable set RISK_AUTHORITY_KEYPAIR --stdin --service <SERVER_SERVICE> --skip-deploys < "$KEYS_DIR/risk-authority.json"
railway variable set KYC_AUTHORITY_KEYPAIR --stdin --service <SERVER_SERVICE> --skip-deploys < "$KEYS_DIR/kyc-authority.json"
railway variable list --service <SERVER_SERVICE> --kv | cut -d= -f1    # names only: both listed
rm "$KEYS_DIR/risk-authority.json" "$KEYS_DIR/kyc-authority.json"

node scripts/admin/set-authorities.ts --risk <RISK_AUTHORITY_PUBKEY> --kyc <KYC_AUTHORITY_PUBKEY>
node scripts/admin/set-authorities.ts --risk <RISK_AUTHORITY_PUBKEY> --kyc <KYC_AUTHORITY_PUBKEY> --execute
solana transfer <RISK_AUTHORITY_PUBKEY> 0.2 --allow-unfunded-recipient --keypair "$OPERATOR_KEYPAIR" --url "$RPC_URL" --with-compute-unit-price 100000
solana transfer <KYC_AUTHORITY_PUBKEY> 0.1 --allow-unfunded-recipient --keypair "$OPERATOR_KEYPAIR" --url "$RPC_URL" --with-compute-unit-price 100000
node scripts/admin/status.ts
#   risk authority      <RISK_AUTHORITY_PUBKEY> 0.2 SOL
#   kyc authority       <KYC_AUTHORITY_PUBKEY> 0.1 SOL
```

`--risk` takes up to four comma-separated keys. `set_authorities` replaces the whole risk list and the KYC key at once.

### 5.3 Tiers

For the smoke test (section 9) tier 1 becomes a tiny account and the others are disabled; section 10 restores the
spec tiers. Purchased evaluations keep the terms they were bought with.

```sh
node scripts/admin/upsert-tiers.ts --smoke-test
node scripts/admin/upsert-tiers.ts --smoke-test --execute
# tier 1 smoke test: size 200 USD, fee 1 USDC, target 0.1%, enabled, terms 5964d603…
# tier 2 25K: size 25000 USD, fee 149 USDC, target 8%, disabled, terms 493b95d5…
# tier 3 50K: …, disabled    tier 4 100K: …, disabled
```

(Straight to launch without a smoke test: run it without `--smoke-test`; the printed terms hashes of the spec tiers are
`a43fb290…` (10K), `493b95d5…` (25K), `30373f70…` (50K), `35113d17…` (100K).)

### 5.4 Markets

`upsert-markets.ts` reads every GMTrade market of the pinned store, keeps the enabled pure USDC-USDC ones whose index
asset is in its reviewed table, and applies the spec §1 leverage caps. Size the per-position and per-side caps against
current pool depth (learnings §8: all funded accounts together under ~10 % of a pool's LP money). Markets configured
earlier and now left out are switched off, never deleted.

```sh
node scripts/admin/upsert-markets.ts --symbols BTC,ETH,SOL,XAU --max-position-usd 10000 --max-total-oi-usd 50000
# enable  BTC/USD[USDC-USDC]       BTC      crypto 25× (closed 25×)
# enable  ETH/USD[USDC-USDC]       ETH      crypto 25× (closed 25×)
# enable  SOL/USD[USDC-USDC]       SOL      crypto 25× (closed 25×)
# enable  XAU/USD[USDC-USDC]       XAU      commodities 15× (closed 15×)
# upsert_market 1-4 of 4 … dry run: ok
node scripts/admin/upsert-markets.ts --symbols BTC,ETH,SOL,XAU --max-position-usd 10000 --max-total-oi-usd 50000 --execute
```

### 5.5 Capital

The operator's USDC account must hold the amount. For the smoke test deposit only what the tiny tier needs (10 USDC of
principal per funded account):

```sh
node scripts/admin/deposit-capital.ts --amount 20
node scripts/admin/deposit-capital.ts --amount 20 --execute
node scripts/admin/status.ts
#   capital vault       <CAPITAL_VAULT> 20 USDC (unallocated)
#   id  size USD …  principal  capital covers …
#   1   200      …  10         2
```

### 5.6 SOL treasury

The treasury (PDA `["sol_treasury"]`) pays each funded account's owner float at activation (`owner_sol_target`,
0.25 SOL, mostly returned when the account closes), later top-ups, and the rent of each payout's USDC account. Budget
0.25 SOL × the funded accounts you expect before the next check, plus 0.5 SOL.

```sh
node scripts/admin/fund-sol-treasury.ts --sol 0.5
# sol treasury FNkgGKbRhc5FEWAxZhbVW7dJZDcunLAK8HnMgesoAjP9: 0 SOL → 0.5 SOL
# transfer 0.5 SOL on mainnet-beta as <OPERATOR>: system transfer
# dry run: ok, 300 CU
node scripts/admin/fund-sol-treasury.ts --sol 0.5 --execute
node scripts/admin/status.ts        # no warnings (pauses are still on)
```

## 6. Server on Railway

`server/railway.json` is the service's config as code: Railpack builder, `npm run migrate --workspace @props/server`
as the pre-deploy command, `cd server && exec node --import tsx src/main.ts` as the start command, health check
`/v1/health` (60 s), one replica, 15 s drain after SIGTERM, restart on failure. `railpack.json` at the repo root pins
the Node provider (without it Railpack sees the root `Cargo.toml` and builds the repo as Rust). Railpack reads Node
`22.x` from `package.json`.

1. Project, database and an empty service (from the repo root):

   ```sh
   railway login
   railway init                                 # new project, e.g. "props"
   railway add --database postgres              # a Postgres service named "Postgres"
   railway add --service <SERVER_SERVICE>       # e.g. "server": empty, so nothing deploys before its variables exist
   ```

2. In the service's **Settings**: Source → Connect Repo → this repo and the release branch; Root Directory `/` (the
   repo root: the server needs the workspace packages); Config as code → Railway Config File `/server/railway.json`.
   Do not deploy yet.

3. Variables (service → Variables, or `railway variable set NAME=value --service <SERVER_SERVICE> --skip-deploys`;
   secrets with `--stdin`). Every variable is described in `server/.env.example` and section 16.

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway reference to the private URL) |
   | `APP_ORIGIN` | `https://<DOMAIN>` (exact origin: no path, no trailing slash) |
   | `SESSION_SECRET` | `openssl rand -hex 32` |
   | `ADMIN_API_TOKEN` | `openssl rand -hex 32` (also in the operators' password manager) |
   | `RPC_URL` | `https://mainnet.helius-rpc.com/?api-key=<SERVER_HELIUS_KEY>` |
   | `RPC_WS_URL` | `wss://mainnet.helius-rpc.com/?api-key=<SERVER_HELIUS_KEY>` |
   | `SOLANA_CLUSTER` | `mainnet-beta` |
   | `PROGRAM_ID` | `7qYRWwpmj3j3exVoBUJHzigcWmMN8ruPEdZdZrGzTJ7` |
   | `RISK_AUTHORITY_KEYPAIR`, `KYC_AUTHORITY_KEYPAIR` | from section 5.2 (stdin) |
   | `GMTRADE_DEPLOY_SLOT` | GMTrade's reviewed deploy slot from section 3 (e.g. `438769784`) |
   | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | from section 1 |
   | `HEARTBEAT_URL` | the Better Stack heartbeat URL |
   | `SENTRY_DSN` | optional |
   | `RAILPACK_NODE_NPM_INSTALL` | `npm ci` (build-time only: makes Railpack install exactly the lockfile instead of `npm install`) |

   Leave `PORT` (Railway sets it), `HOST`, `LOG_LEVEL`, `TRUST_PROXY_HOPS` (1 = Railway's edge; set 2 when the API is
   reached through the app's Vercel rewrite, section 7) and
   `SIM_FILL_DELAY_MS` unset unless you mean to change their defaults. From the CLI, single-quote reference values and
   pipe secrets in, so no secret appears in a command line or shell history:

   ```sh
   railway variable set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' APP_ORIGIN=https://<DOMAIN> SOLANA_CLUSTER=mainnet-beta \
     PROGRAM_ID=7qYRWwpmj3j3exVoBUJHzigcWmMN8ruPEdZdZrGzTJ7 GMTRADE_DEPLOY_SLOT=<SLOT> 'RAILPACK_NODE_NPM_INSTALL=npm ci' \
     --service <SERVER_SERVICE> --skip-deploys
   openssl rand -hex 32 | tr -d '\n' | railway variable set SESSION_SECRET --stdin --service <SERVER_SERVICE> --skip-deploys
   ```

   Set `ADMIN_API_TOKEN` (generated in the operators' password manager, 64 hex characters), `RPC_URL`, `RPC_WS_URL`,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `HEARTBEAT_URL` and `SENTRY_DSN` by pasting them in the dashboard
   (service → Variables → New Variable): no command line, no trailing newline.

   Then seal the secrets (service → Variables → the ⋮ menu of each → Seal): `RISK_AUTHORITY_KEYPAIR`,
   `KYC_AUTHORITY_KEYPAIR`, `SESSION_SECRET`, `ADMIN_API_TOKEN`, `RPC_URL`, `RPC_WS_URL` (both carry the Helius key) and
   `TELEGRAM_BOT_TOKEN`. A sealed value still reaches every build and deployment, but nobody with access to the project
   can read it back: not in the dashboard, the API, `railway variable list` or `railway run`. Sealing cannot be undone;
   a sealed variable can still be updated (⋮ → Edit, not the Raw Editor). Sealed values are not copied into PR
   environments or into duplicated environments and services: set them again there. Only seal `ADMIN_API_TOKEN` once it
   is in the password manager, since it can never be read back.

4. Deploy from the connected repo (dashboard → Deploy, or push to the release branch; deploy from Git, not by
   uploading a working directory that holds key files) and read the build and deploy logs. Expected: the build runs
   `npm ci`; the pre-deploy step prints `migrations applied`; the process logs
   `Server listening at http://0.0.0.0:<PORT>`; the only warnings are for alert channels you left unset.
   `RISK_AUTHORITY_KEYPAIR is not set` is a launch blocker (section 5.2).

5. Custom domain: `railway domain api.<DOMAIN> --service <SERVER_SERVICE>` prints the DNS record (a CNAME); add it at
   your DNS provider and wait for the certificate. Then:

   ```sh
   curl -s https://api.<DOMAIN>/v1/health
   # {"status":"ok","db":"ok","modules":{"marketdata":"running","sim":"running","chain":"running","keeper":"running"},
   #  "time":…,"keeper":{"leader":true,"lastTickAt":<within the last few seconds>,"gmtradeUpgrade":null}}
   ```

Rehearsal note: the exact install (`npm ci` at the root), pre-deploy and start commands were run from a clean copy of
the repo against a local validator and Postgres; `/v1/health`, `/v1/config`, `/v1/vault` and `/v1/markets` answered as
above, and the keeper took leadership.

## 7. App on Vercel

`app/vercel.json` sets framework Vite, install `cd .. && npm ci --no-audit --no-fund` (the repo root's lockfile: the
app imports the workspace packages), build `npm run build`, output `dist`, the SPA rewrite and the static security
headers. `app/middleware.js` runs at the edge on every request: it answers 451 to US persons and sanctioned regions,
and adds the Content-Security-Policy (below). Node is pinned by `"engines": { "node": "22.x" }` in `app/package.json`.

1. Project: dashboard → Add New → Project → this repo. Root Directory `app`; Framework Preset Vite (the other build
   settings come from `vercel.json`); keep **Include files outside the root directory in the Build Step** enabled
   (the workspace packages live outside `app`). Or from the repo root: `vercel link --repo`.

2. Environment variables for **Production** (Vite inlines them at build time; the middleware reads `VITE_API_URL` and
   `VITE_RPC_URL` at request time for the CSP, so a change needs a redeploy):

   | Variable | Value |
   |---|---|
   | `VITE_API_URL` | `https://api.<DOMAIN>` (no trailing slash) |
   | `VITE_RPC_URL` | `https://mainnet.helius-rpc.com/?api-key=<BROWSER_HELIUS_KEY>` (the domain-restricted key) |
   | `VITE_CLUSTER` | `mainnet-beta` |
   | `VITE_PROGRAM_ID` | `7qYRWwpmj3j3exVoBUJHzigcWmMN8ruPEdZdZrGzTJ7` (the app refuses an API that reports another program) |
   | `VITE_PRIVY_APP_ID` | the Privy app id, for the Google wallet (optional; see below) |

   ```sh
   printf '%s' 'https://api.<DOMAIN>' | vercel env add VITE_API_URL production
   ```

   A build without `VITE_API_URL`, or a mainnet build without `VITE_RPC_URL`, fails on purpose. Preview deployments
   (`*.vercel.app`) are not same-site with `api.<DOMAIN>` and are not the API's `APP_ORIGIN`, so they cannot sign in.

   Google wallet (`VITE_PRIVY_APP_ID`): in the Privy dashboard, enable Google login and set Allowed domains to the
   app's origin (`https://<DOMAIN>`; Google sign-in returns only to an allowed domain, so local work needs
   `http://127.0.0.1:4187` added too). Privy creates the trader's embedded Solana wallet after the first Google sign-in;
   the app then signs in with Sign-In With Solana like any other wallet, so no Privy secret or server-side Privy call
   exists. The Google wallet signs without Privy's confirmation window (the app turns it off): the trader's click in the
   app is the approval, so the app states the exact amount before every action.

3. Domain: `vercel domains add <DOMAIN>` (and `www.<DOMAIN>` redirecting to it), add the DNS records Vercel prints.

4. Deploy from Git: push the release commit to the production branch (a CLI upload would send the local working
   directory, key files included, unless they are ignored).

The Content-Security-Policy the middleware sends (built by `contentSecurityPolicy()` in `app/middleware.js`, tested in
`app/tests/middleware.test.js`, and enforced during the whole browser suite `npm run test:e2e --workspace @props/app`):

```
default-src 'none'; script-src 'self' 'sha256-<theme script>'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;
connect-src https://api.<DOMAIN> https://mainnet.helius-rpc.com wss://mainnet.helius-rpc.com ws://localhost:* http://localhost;
base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

`connect-src` holds exactly the API and the RPC origins (HTTPS and the websocket `@solana/web3.js` derives). The
`localhost` entries, the inline styles and the Google font are what the Solana Mobile Wallet Adapter needs on Android
(it talks to the wallet app over a local websocket and styles its own dialog); desktop wallets inject through their
extensions and need nothing. If `index.html`'s inline theme script ever changes, update its hash in `middleware.js`
(the unit test fails until you do). The Vercel toolbar on preview deployments is blocked by this policy; that is expected.

Rehearsal note: `vercel build --prod` was run on a clean copy of the repo with the project settings above: it ran the
install command, built the app, and bundled `app/middleware.js` as an edge function in front of every path.

### 7.1 Without a custom domain (current deployment)

Until the domain is bought, the app runs at `https://propstrade.vercel.app` and the API at a `*.up.railway.app`
domain. Those are different sites, so the session cookie would not flow. `app/vercel.json` therefore proxies
`/v1/*` to the Railway service (uncached except `/v1/candles`, which the edge caches for the seconds the server's
`cache-control` allows: `x-vercel-enable-rewrite-caching: 0` elsewhere and the project's external rewrite
caching off), which makes the API same-origin with the app:

| Where | Variable | Value |
|---|---|---|
| Railway `server` | `APP_ORIGIN` | `https://propstrade.vercel.app` |
| Railway `server` | `TRUST_PROXY_HOPS` | `2` (Vercel's proxy + Railway's edge, so rate limits see the trader's IP) |
| Vercel production | `VITE_API_URL` | `https://propstrade.vercel.app` |
| Vercel production | `VITE_RPC_URL` | `https://propstrade.vercel.app/v1/rpc` (the server's RPC relay: the provider key stays in `RPC_URL`) |

The live-update stream (`/v1/stream`) also goes through the rewrite; the app reconnects on its own if the proxy
closes a long-lived connection. When the domain is bought, move the API to `api.<DOMAIN>` (section 6.5), point the
rewrite (or `VITE_API_URL`) at it and set `APP_ORIGIN` to `https://<DOMAIN>`.

Deployed 2026-09-23: Railway project `propstrade` (services `server` and `Postgres`, Postgres 18), Vercel project
`propstrade` (team `penguinpeckers-projects`). New Railway services cannot use `server/railway.json` (config as code
is deprecated for them), so its settings were applied to the service instance through the Railway API; keep them in
sync with that file. Every Railway `server` variable is sealed and every Vercel variable is `sensitive`.

## 8. Post-deploy verification

Load the admin token into the shell once (paste it from the password manager; nothing echoes or reaches the history):

```sh
read -rs ADMIN_API_TOKEN && export ADMIN_API_TOKEN
node scripts/admin/status.ts
# program upgrade authority <OPERATOR>; admin <OPERATOR>; risk and KYC authorities funded; pauses all PAUSED;
# smoke-test tier 1 enabled, 2–4 disabled; 4 markets enabled; capital 20 USDC; treasury 0.5 SOL; "no warnings"

curl -s https://api.<DOMAIN>/v1/health | jq '{status, db, modules, leader: .keeper.leader}'
# {"status":"ok","db":"ok","modules":{…all "running"},"leader":true}
curl -s https://api.<DOMAIN>/v1/config | jq '{cluster, programId, paused, tiers: [.tiers[] | {id, sizeUsd, feeUsdc, enabled}]}'
# cluster "mainnet-beta", programId 7qYR…TJ7, paused all true, tier 1 {200, 1, true}, 2–4 enabled false
curl -s https://api.<DOMAIN>/v1/markets | jq '[.[] | select(.tradable) | "\(.symbol) \(.maxLeverage)x"]'
# ["BTC 25x","ETH 25x","SOL 25x","XAU 15x"]
curl -s https://api.<DOMAIN>/v1/vault | jq '{capitalUsdc, allocatedPrincipal, solTreasurySol, fundedAccounts}'
# {"capitalUsdc":"20","allocatedPrincipal":"0","solTreasurySol":"0.5","fundedAccounts":0}
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: https://example.com' https://api.<DOMAIN>/v1/auth/logout
# 403  (writes from any other origin are refused)
curl -s -H "Authorization: Bearer $ADMIN_API_TOKEN" https://api.<DOMAIN>/v1/admin/payouts     # []
curl -sI https://<DOMAIN>/ | grep -iE '^(content-security-policy|x-frame-options|x-content-type-options):'
# content-security-policy: default-src 'none'; … connect-src https://api.<DOMAIN> https://mainnet.helius-rpc.com wss://… ; … frame-ancestors 'none'
# x-frame-options: DENY
# x-content-type-options: nosniff
```

In a desktop browser with Phantom or Solflare: open `https://<DOMAIN>`, check the DevTools console is free of CSP
errors, connect and sign in (proves the same-site cookie and CORS), open Markets (live prices, 4 tradable), open a
chart. On an Android phone, connect through the Mobile Wallet Adapter once. Check the server log shows the sign-in.

## 9. Small-money mainnet smoke test

Goal: prove, with ≈ 35 USDC and ≈ 1 SOL at risk, the paths the local suites cannot: GMTrade's keepers filling a vault
PDA's orders, TP/SL triggers, liquidation handling, and a payout reconciled against real realized P&L. Use an internal
wallet belonging to a real, KYC-reviewed team member, holding ≈ 20 USDC and 0.1 SOL. Keep `<DOMAIN>` unannounced.

Before: tier 1 is the smoke tier (5.3), capital is 20 USDC (5.5). Lower the minimum payout to the smallest the program
accepts (1 micro-USDC), so any profit can be paid: the program compares it with the trader's 80 % share, and a $20
position's profit is cents (below). Then lift the pauses:

```sh
node scripts/admin/set-params.ts --min-payout 0.000001 --execute
# current trader share 8000 bps, min payout 50 USDC, owner float 0.25 SOL (top-up below 0.1 SOL)
# new     trader share 8000 bps, min payout 0.000001 USDC, owner float 0.25 SOL (top-up below 0.1 SOL)
node scripts/admin/set-pauses.ts --new-evaluations off --trading off --payouts off --execute
# current { newEvaluations: true, trading: true, payouts: true } → new { newEvaluations: false, trading: false, payouts: false }
```

| # | Do | Proves | Locally proven already? |
|---|---|---|---|
| 1 | Sign in with the test wallet | SIWS, same-site session cookie, CORS, CSP in a real browser | parts (e2e with a stub API) |
| 2 | Buy the "$200" evaluation (1 USDC) | fee transfer to the fee vault; indexer picks up `EvaluationPurchased`; sim account created | yes (validator e2e) |
| 3 | Trade the simulated evaluation to +0.1 % (≈ $0.20 net) and go flat | live GMTrade prices, sim fills, pass decided, risk key records `record_evaluation_result` | yes, with recorded prices |
| 4 | On the Activation page start identity verification; approve it (below) | admin API, `set_identity` chain job signed by the KYC key | yes (validator e2e) |
| 5 | Activate | 10 USDC principal to the owner PDA's USDC account; 0.25 SOL owner float from the treasury | yes |
| 6 | Open a $20 SOL long with $2 collateral (10×) and a stop-loss 2 % below | CPI `create_order_v2` accepted **and filled by GMTrade's keeper within seconds**; keeper `sync` | **no**: keepers do not run locally |
| 7 | Set a take-profit at least 0.1 % (10 bp) above the fill | **TP trigger** executed by GMTrade's keeper; keeper cancels the orphaned stop-loss | **no** |
| 8 | Close anything left; wait for the account to show flat | close fills; owner USDC = principal ± P&L; order escrows returned | **no** (fills) |
| 9 | With a profit, request a payout | keeper review reconciles the requested profit with subsquid's realized P&L and approves; USDC arrives in the wallet (80 %), 20 % to the capital vault | **no** (real P&L) |
| 10 | Optional: open $25 at 25× ($1 collateral) on a volatile market and leave it | **liquidation** by GMTrade; keeper sync frees the slot; account stays within its allowance | **no**, and cannot be forced: it happens only if the price moves ≈ 4 % against it |

A GMTrade round trip costs ≈ 0.02–0.04 % in fees (learnings §11), $0.004–0.008 on $20, so the price must move 2–4 bp
before the account makes anything: a take-profit 10 bp above the fill leaves ≈ $0.012–0.016, of which the trader is paid
80 %. A losing round trip in step 8 means no payout: repeat 6–8 (each round trip costs cents) until one closes in profit.
Stop-outs at the equity floor are not exercised deliberately: with collateral = remaining allowance they coincide with
GMTrade liquidations (step 10).

Identity approval for step 4. The identity hash is what enforces one funded account per person (the program allows one
wallet per hash), so it is always made by `scripts/admin/identity-hash.ts` from one identity document in a fixed
canonical form: the country that **issued** the document (ISO 3166-1 alpha-2, not the residence country the request
shows), the document type (`passport`, or `id-card` for a national identity card; use the passport when the applicant
has one, since each of a person's documents hashes differently), and the document number with case, spaces, dashes, dots
and slashes ignored. Any other spelling of the same document gives the same hash, so a second wallet with it is refused
(`409 identity_in_use`). The salt (`IDENTITY_SALT`, section 1) goes in on stdin: `read -rs` keeps it out of the history,
and `printf` is a shell builtin, so it never appears in a process list.

```sh
curl -s -H "Authorization: Bearer $ADMIN_API_TOKEN" 'https://api.<DOMAIN>/v1/admin/kyc?status=pending' | jq '.[] | {id, wallet, country}'
read -rs IDENTITY_SALT                  # once per shell: paste the salt, Enter
IDENTITY_HASH=$(printf '%s' "$IDENTITY_SALT" | node scripts/admin/identity-hash.ts --country <ISSUING_COUNTRY> --document <passport|id-card> --number '<DOCUMENT_NUMBER>')
# identity DE:PASSPORT:C01X00T47 (Germany)          ← check it against the document before approving
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" -H 'content-type: application/json' \
  -d "{\"identityHash\":\"$IDENTITY_HASH\"}" "https://api.<DOMAIN>/v1/admin/kyc/<REQUEST_ID>/approve"
```

Payout review (step 9) is automatic; a payout the keeper holds shows up (with its reason) in
`GET /v1/admin/payouts` and a Telegram alert; approve or reject it with
`POST /v1/admin/payouts/<PAYOUT_ID>/approve` or `…/reject` (`{"reasonCode": <n>}`).

After each step check the Activity page, the Verify page (every record links to the explorer) and `status.ts`
(allocated principal 10 USDC and 1 open funded account after step 5; payouts paid and vault profit share after step 9).

Close the smoke-test funded account once it is flat: `POST /v1/admin/funded/<FUNDED_ACCOUNT>/close` (admin token)
queues `close_funded`, signed by the risk key, which returns its USDC to the capital vault and its SOL
float to the treasury. Confirm with `status.ts` that `allocated principal` is back to 0. An order GMTrade finished but
left open keeps the account from closing until the keeper's `close_completed_order` sweeps it and `sync` runs; the job
then fails with that reason: retry it with `POST /v1/admin/jobs/<JOB>/retry`.

## 10. Go live

```sh
node scripts/admin/set-pauses.ts --new-evaluations on --execute     # no new smoke-tier purchases while switching
node scripts/admin/upsert-tiers.ts --execute                        # spec tiers: 10K and 25K on, 50K and 100K off
node scripts/admin/set-params.ts --min-payout 50 --execute
node scripts/admin/deposit-capital.ts --amount <USDC_AMOUNT> --execute
node scripts/admin/fund-sol-treasury.ts --sol <SOL_AMOUNT> --execute
node scripts/admin/status.ts        # tiers 1–2 enabled with "capital covers" ≥ 1; min payout 50 USDC; no warnings
node scripts/admin/set-pauses.ts --new-evaluations off --trading off --payouts off --execute
curl -s https://api.<DOMAIN>/v1/config | jq '.paused'                # all false (cached up to 30 s)
```

Then announce `<DOMAIN>`.

## 11. Monitoring and alerts

| Signal | Where | Act when |
|---|---|---|
| Keeper alerts | Telegram group (and Sentry for warnings/criticals) | Always read. Critical: a breach close failed, a GMTrade upgrade, a chain job failed for good, an account the keeper cannot value, the indexer > 5 min behind. |
| Keeper heartbeat | `HEARTBEAT_URL` monitor (pinged after a completed tick, at most every 30 s); set its grace to 2–3 min | Missed: the keeper is stalled or leaderless → Railway logs, `/v1/health` `keeper.lastTickAt`. |
| API uptime | uptime monitor on `https://api.<DOMAIN>/v1/health` expecting 200 and `"status":"ok"` | 503 means the database is unreachable. |
| Onchain balances | `node scripts/admin/status.ts` daily (its `warnings` list) | Risk key < 0.05 SOL, KYC key < 0.02 SOL, treasury < one owner float, an enabled tier the capital cannot fund. |
| Pool depth | GMTrade pools of every enabled market, daily (learnings §8) | Lower `--max-position-usd` / `--max-total-oi-usd` with `upsert-markets.ts`. |
| RPC | Helius dashboard: credits and rate-limit errors | Upgrade the plan before the credits run out. |
| Vault reconciliation | weekly: `status.ts` allocated principal vs `select sum(principal) from funded_accounts where status <> 'closed';` (`railway connect Postgres`) | They differ, or the capital vault is not deposits − withdrawals − principal posted + closure returns + vault profit share + swept fees. |
| Database | Railway metrics; a daily off-platform dump | `railway run --service Postgres -- sh -c 'PGHOST=$RAILWAY_TCP_PROXY_DOMAIN PGPORT=$RAILWAY_TCP_PROXY_PORT pg_dump --format=custom -f props-$(date -u +%F).dump'` (needs the Postgres service's public TCP proxy, and a `pg_dump` at least as new as the server). `railway run` puts the Postgres service's variables in the environment and `pg_dump` reads `PGUSER`, `PGPASSWORD` and `PGDATABASE` from there, so the password is on no command line and in no history. Railway volume backups have no point-in-time restore. |

## 12. Emergency procedures

Before section 13 the operator signs admin changes with `--execute`. After it, the same scripts build the transaction
for the Squads vault instead: add `--print-for <SQUADS_VAULT>`. The script simulates it with the vault as signer and fee
payer and only if that passes prints the instructions for review and, on its last line, the transaction Squads imports:
unsigned, base58, paid by the vault (the shape `solana-verify export-pda-tx` prints for Squads). A failing dry run
prints nothing to import and exits 1. In Squads: TX Builder → Create transaction → Add instruction → **Import base58
encoded tx** → paste the last line → Next → check the accounts and data against the printed JSON → Add instruction →
Save draft → run the simulation → Initiate Transaction; the members approve and execute it. Rehearsed on the local
validator with a stand-in vault key, which signed and sent each printed transaction:

```sh
node scripts/admin/set-pauses.ts --new-evaluations on --trading on --payouts on --print-for <SQUADS_VAULT>
# set_pauses on mainnet-beta as <SQUADS_VAULT>: setPauses
# dry run: ok, 15417 CU
# instructions for <SQUADS_VAULT> to sign (program id, accounts, base58 data), for review:
# [ { "programId": "7qYR…TJ7", "accounts": [ … ], "dataBase58": "CyuFEthXt7C7xvc" } ]
# transaction for Squads (Transaction Builder → Add instruction → Import base58 encoded tx):
# 4dc1C5oEagAwXJzX…ymbGLbEPuvkv
```

Admin instructions overwrite everything they set (`set_pauses` all three flags, `set_params` all five parameters,
`set_authorities` every authority, `upsert_*` a whole tier or market), and Squads executes an approved proposal whenever
a member runs it, an older one after a newer one. So with `--print-for`, `set-pauses.ts` and `set-params.ts` refuse
unless every flag (`--new-evaluations`, `--trading`, `--payouts`) or every parameter is named: a value filled in from the
chain when the proposal is printed may be stale when it executes. And the members: reject every older pending proposal
that sets the same thing as soon as a new one is created; before approving or executing one, compare what it sets (the
`new` line the script printed) with `node scripts/admin/status.ts`.

| Situation | Action |
|---|---|
| Stop new risk everywhere | `set-pauses.ts --new-evaluations on --trading on --payouts on` (`--execute`, or `--print-for` after handover, then reject any older pending `set_pauses` proposal in Squads: executed later, it would undo this one). Pauses stop purchases, opens and activations, payouts and owner SOL top-ups; closes, cancels and protective orders always work. |
| One account misbehaves | The keeper restricts accounts itself (equity at the floor, GMTrade upgrade). There is no operator route to restrict a single account by hand yet: pause trading for everyone, then investigate. |
| Stop the keeper | Delete `RISK_AUTHORITY_KEYPAIR` from the Railway service (redeploys): the keeper keeps watching and alerting but sends nothing (`RISK_AUTHORITY_KEYPAIR is not set: the keeper watches and alerts but cannot act`), and evaluation results and payouts stay queued. That deletes the only copy of the risk key (its file went in 5.2 and a sealed value cannot be read back), and the SOL on it is lost with it, so starting the keeper again is a key rotation (5.2): `gen-authority-key.ts --role risk --out "$KEYS_DIR/risk-authority.json"`; `set-authorities.ts --risk <NEW_RISK_PUBKEY> --kyc <CURRENT_KYC_PUBKEY>` (the current KYC key from `status.ts`; `--print-for <SQUADS_VAULT>` after the handover, then Squads); fund the new key with 0.2 SOL; only then set it in Railway (`railway variable set RISK_AUTHORITY_KEYPAIR --stdin …`, redeploys), seal it and delete the file. The queued work then goes out. |
| A hot key may be exposed | Generate a new one (`gen-authority-key.ts`), set it in Railway, then `set-authorities.ts` with the new public key: the old key loses its powers the moment that lands. |
| GMTrade upgraded its program | The keeper alerts and restricts every active funded account. Restricted accounts get no SOL top-ups (nor does any account while trading is paused), so what the new release can take from an owner PDA is capped at its current float; if a keeper close then fails for lack of SOL, send that owner PDA some with a plain transfer (it goes back to the treasury at `close_funded`). Review the release (`scripts/fixtures.sh` fails on the new hash; update the pin and run the suites against the new binary), then acknowledge it: `curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" https://api.<DOMAIN>/v1/admin/gmtrade-deploys/<SLOT>/acknowledge` → `{"slot":…,"acknowledgedAt":…}`. Update `GMTRADE_DEPLOY_SLOT` in Railway. |
| Lift restrictions | Per account, once its reason is gone: `curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" https://api.<DOMAIN>/v1/admin/funded/<FUNDED_ACCOUNT>/lift-restriction` → `{"id":…,"job":…}` (404 unknown account, 409 not restricted). Restricted accounts: `railway connect Postgres`, then `select address from funded_accounts where status = 'restricted';`. |
| A chain job failed for good | Fix the cause, then `curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" https://api.<DOMAIN>/v1/admin/jobs/<JOB_ID>/retry` (id from the alert). |
| RPC outage | Switch `RPC_URL` / `RPC_WS_URL` in Railway and `VITE_RPC_URL` in Vercel to another provider, redeploy both. |
| Admin token or session secret exposed | Replace `ADMIN_API_TOKEN` / `SESSION_SECRET` in Railway (a new session secret signs everyone out). |

## 13. Hand over to Squads

Only after section 10 has run cleanly for a while. Two authorities move to `<SQUADS_VAULT>`.

First prove the import path with nothing at stake, since every emergency action after the handover goes through it:
send 1 lamport from the vault to the SOL treasury (the vault needs a little SOL, section 2) as in section 12, and check
`status.ts` shows the treasury 1 lamport higher.

```sh
node scripts/admin/fund-sol-treasury.ts --sol 0.000000001 --print-for <SQUADS_VAULT>
# transfer 0.000000001 SOL on mainnet-beta as <SQUADS_VAULT>: system transfer
# dry run: ok, 300 CU
# … transaction for Squads (Transaction Builder → Add instruction → Import base58 encoded tx):
# 3md7BBV9wFjYGnMW…CBHeArkb        → import, approve and execute it in Squads
```

1. Vault admin, two steps (the program has no one-step change):

   ```sh
   node scripts/admin/transfer-admin.ts --to <SQUADS_VAULT>
   node scripts/admin/transfer-admin.ts --to <SQUADS_VAULT> --execute        # propose_admin
   node scripts/admin/transfer-admin.ts --to <SQUADS_VAULT> --print-accept
   # accept_admin on mainnet-beta as <SQUADS_VAULT>: acceptAdmin
   # dry run: ok, 15281 CU                        (FAILS with Unauthorized until propose_admin has landed)
   # … [ { "programId": "7qYR…TJ7", "accounts": [ {<SQUADS_VAULT> signer}, {config, writable}, {event authority},
   #       {program} ], "dataBase58": "Km93KsbHouB" } ]
   # transaction for Squads (Transaction Builder → Add instruction → Import base58 encoded tx):
   # 3T4DHUNXqSgNrtRM…mQYY2PNwiCT7k
   ```

   Import the printed `accept_admin` transaction into Squads (section 12), approve and execute it. `status.ts` then
   shows `admin <SQUADS_VAULT>` with no pending admin.

2. IDL authority: nothing to move. This build publishes no onchain IDL and has no IDL instructions (section 4).

3. Program upgrade authority:

   ```sh
   solana program set-upgrade-authority "$PROGRAM_ID" --new-upgrade-authority <SQUADS_VAULT> \
     --skip-new-upgrade-authority-signer-check --keypair "$OPERATOR_KEYPAIR" --url "$RPC_URL"
   solana program show "$PROGRAM_ID" --url "$RPC_URL" | grep Authority    # Authority: <SQUADS_VAULT>
   node scripts/admin/status.ts | grep -E 'upgrade authority|  admin'  # both <SQUADS_VAULT>
   ```

4. Publish the verification: `solana-verify verify-from-repo -um --program-id "$PROGRAM_ID" <PUBLIC_REPO_URL>
   --commit-hash <RELEASE_COMMIT> --library-name props_vault_p --mount-path programs-p/props_vault_p`; with the upgrade
   authority on Squads, create the verification PDA through Squads (`solana-verify export-pda-tx …`) and submit it with
   `--remote` so explorers show the program as verified.

5. Move the operator key and the program keypair to cold storage. The program keypair is never needed again.

## 14. Later upgrades

1. Build with `solana-verify build` as in section 3.2 and run the rest of section 3 on the release commit.
2. Write a buffer with the operator key, then give the buffer to the vault (the CLI will not write a buffer whose
   authority does not sign):

   ```sh
   solana-keygen new --no-bip39-passphrase -o "$KEYS_DIR/upgrade-buffer.json"
   solana program write-buffer programs-p/props_vault_p/target/deploy/props_vault_p.so --buffer "$KEYS_DIR/upgrade-buffer.json" \
     --keypair "$OPERATOR_KEYPAIR" --url "$RPC_URL" --with-compute-unit-price 100000 --max-sign-attempts 50 --use-rpc
   solana program set-buffer-authority "$(solana-keygen pubkey "$KEYS_DIR/upgrade-buffer.json")" --new-buffer-authority <SQUADS_VAULT> \
     --keypair "$OPERATOR_KEYPAIR" --url "$RPC_URL"
   ```

3. Create the upgrade in Squads from that buffer (Programs → upgrade). If the new binary is larger than the program's
   data length (`solana program show`), the upgrade fails (`AccountDataTooSmall`): extend the program data first, not in
   the same slot as an upgrade. Squads cannot do it (the loader refuses `ExtendProgram` as an inner instruction: "not
   supported by inner instructions"), and `solana program extend` refuses any key but the upgrade authority. The route
   depends on the loader feature ExtendProgramChecked (inactive on 2026-09-24):

   ```sh
   solana feature status 2oMRZEDWT2tqtYMofhmmfQ8SsjqUFzT6sYXppQDavxwz --url "$RPC_URL"
   ```

   - Inactive: any key may send a top-level `ExtendProgram` and pay the added rent. With the operator key:
     `node scripts/admin/extend-program.ts --bytes <N>` (dry run), then the same with `--execute`.
   - Active: `ExtendProgram` is refused everywhere ("ExtendProgram was superseded by ExtendProgramChecked"), and
     `ExtendProgramChecked` needs the upgrade authority's signature; through Squads it adds at most 10,240 bytes per
     execution. Either run one Squads execution per 10,240 bytes, or in one Squads transaction run the loader's
     `SetAuthority` (allowed as an inner instruction) to hand the upgrade authority to the operator key, then
     `solana program extend "$PROGRAM_ID" <N> --keypair "$OPERATOR_KEYPAIR" --url "$RPC_URL"` and at once
     `solana program set-upgrade-authority "$PROGRAM_ID" --new-upgrade-authority <SQUADS_VAULT>
     --skip-new-upgrade-authority-signer-check --keypair "$OPERATOR_KEYPAIR" --url "$RPC_URL"`. Check `solana program
     show` names the vault again before creating the upgrade. Rehearse this on a local validator first.
4. If the IDL changed: there is no onchain IDL to update (section 4); the new `packages/sdk/src/idl/props_vault.json`
   reaches the server and the app with their next deploy (the server reads it once per process).
5. `solana-verify get-program-hash` must equal the new executable hash; re-publish the verification (13.4:
   `verify-from-repo … --commit-hash <NEW_COMMIT> --library-name props_vault_p --mount-path programs-p/props_vault_p`).
   It reads finalized state, so for ≈ 15 s after the upgrade executes it still reports the previous binary's hash: run
   it once `solana program show "$PROGRAM_ID" --url "$RPC_URL" --commitment finalized` shows the upgrade's Last
   Deployed slot.

## 15. Costs

Onchain (mainnet rent on 2026-09-23, ≈ 5,080 lamports per byte; re-check with `solana rent <BYTES> --url "$RPC_URL"`):

| Item | Size | SOL | Paid by |
|---|---|---|---|
| Program data at `--max-len` = size + 10 % (`<SO_SIZE>` binary, ≈ 172,536 B; section 3.2) | ≈ 189,834 B | ≈ 0.965 (0.877 without headroom; ≈ 5.7 sized for an Anchor fallback, section 4) | operator, locked while deployed |
| Program account | 36 B | 0.0008 | operator |
| Deploy writes (≈ 180 transactions at 100,000 µlamports/CU) | | ≈ 0.001 | operator |
| Config + fee vault + capital vault (initialize) | 450 + 165 + 165 B | 0.0059 | operator |
| Tier / market config | 70 / 147 B | 0.0010 / 0.0014 each | operator |
| Risk / KYC authority float | | 0.2 / 0.1, refilled as used | operator |
| SOL treasury | | 0.25 per active funded account (owner float, mostly returned at closure) + 0.0015 per payout USDC account + 0.5 buffer | operator |
| Per verification (identity lock + trader profile if new) | 41 + 86 B | 0.0009 – 0.0019 | KYC key |
| Per trader: profile, evaluation, funded account, payout request | 86 / 164 / 1,547 / 128 B | 0.0011 / 0.0015 / 0.0085 / 0.0013 | trader |

Operator SOL: keep about twice what the deploy locks, ≥ 2 SOL at the default `--max-len` (the buffer's rent is the
program's rent, ≈ 0.97; the margin covers a restarted buffer and fees) or ≥ 12 SOL when sized for an Anchor fallback;
≈ 0.97 SOL (≈ 5.7) is spent and locked by the deploy, then the authorities and treasury.

Monthly (list prices on 2026-09-23; check before buying):

| Service | Plan | Cost |
|---|---|---|
| Helius | Developer (10M credits, 50 req/s, websockets) | $49 |
| Vercel | Pro (commercial use) | $20 per developer seat |
| Railway | Hobby $5 or Pro $20 per workspace, each including that much usage; then per second (≈ $20/vCPU, $10/GB RAM, $0.15/GB volume per month) | ≈ $5–40 for one server + Postgres |
| Domain | `props.trade` is a registry premium: ≈ $385 first year, ≈ $55 renewal (ordinary `.trade` names ≈ $5–27) | per year |
| Telegram, Sentry (developer), Better Stack (free tier) | alerts, heartbeat, uptime | $0 |
| KYC vendor (if used instead of manual review) | Persona startup program / Sumsub ≈ $1.85 per check, $299 minimum | per use |

## 16. Environment variable reference

Server (`server/.env.example` has the full descriptions; `server/test/env-docs.test.ts` fails if the server reads a
variable that is not documented there and here):

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (also used by the pre-deploy migrations) |
| `APP_ORIGIN` | yes | exact app origin; CORS, sign-in message domain, cross-site write check |
| `SESSION_SECRET` | yes | ≥ 32 characters; keys the session-token hashes |
| `ADMIN_API_TOKEN` | yes | ≥ 32 characters; bearer token for `/v1/admin/*` |
| `RPC_URL` | yes | Solana JSON-RPC HTTP endpoint |
| `RPC_WS_URL` | no | RPC websocket (derived from `RPC_URL` when unset) |
| `SOLANA_CLUSTER` | no | `mainnet-beta` (default) or `localnet` |
| `NODE_ENV` | no | leave unset in production; `test` + `SOLANA_CLUSTER=localnet` enables the local rehearsal's price-pin route |
| `PROGRAM_ID` | no (yes on mainnet) | props_vault program id; must equal the SDK's |
| `PORT`, `HOST` | no | listen address (8080, 0.0.0.0); Railway sets `PORT` |
| `LOG_LEVEL` | no | pino level (info) |
| `TRUST_PROXY_HOPS` | no | trusted reverse proxies (1 = Railway's edge; 2 when the app's Vercel rewrite fronts the API, see section 7) |
| `SIM_FILL_DELAY_MS` | no | sim keeper delay (2000, minimum 1000) |
| `RISK_AUTHORITY_KEYPAIR` | yes on mainnet | risk authority secret key (JSON byte array or base58) |
| `KYC_AUTHORITY_KEYPAIR` | yes on mainnet | KYC authority secret key |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | no | keeper alerts to Telegram |
| `HEARTBEAT_URL` | no | pinged after each completed keeper tick |
| `SENTRY_DSN` | no | keeper warnings and criticals to Sentry |
| `GMTRADE_DEPLOY_SLOT` | no (set it) | reviewed GMTrade deploy slot; any other is treated as an unreviewed upgrade |
| `TEST_DATABASE_URL` | tests only | disposable `*_test` database for the server suites |
| `RAILPACK_NODE_NPM_INSTALL` | Railway build only | `npm ci`, so the build installs exactly the lockfile |

App (`app/.env.example`; `app/tests/env-docs.test.js` checks the same for the app and its middleware):

| Variable | Required | Meaning |
|---|---|---|
| `VITE_API_URL` | yes | API base URL, same site as the app; also the CSP's API origin |
| `VITE_RPC_URL` | yes on mainnet | browser RPC endpoint (domain-restricted key); also the CSP's RPC origins |
| `VITE_CLUSTER` | no | `mainnet-beta` (default) or `localnet` |
| `VITE_PROGRAM_ID` | no (set it) | the app refuses to sign in against an API reporting another program |
| `VITE_PRIVY_APP_ID` | no | Privy app id: offers the Google wallet (Privy's embedded Solana wallet) and allows auth.privy.io in the CSP |
