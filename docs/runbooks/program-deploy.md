# Runbook: deploy and initialize `props_vault` on Solana mainnet

Audience: the operator who holds the deploy keypair. Every command below is exact; placeholders are in
`<ANGLE_BRACKETS>` and are filled from your own environment. No key, seed or secret ever goes into this
repo, a chat, a ticket or a log. Environment variables used:

| Variable | Meaning |
|---|---|
| `OPERATOR_KEYPAIR` | path to the operator keypair file (program upgrade authority until handover, then vault admin until handover) |
| `RPC_URL` | paid mainnet RPC endpoint (Helius); the public endpoint rate-limits deploys |
| `PROGRAM_KEYPAIR` | path to `keys/props_vault-keypair.json` (gitignored); its public key is the id in `Anchor.toml` and `declare_id!` |

Order of operations (do not reorder): **build → verify hash → deploy → initialize → configure → fund →
test with small money → unpause → hand admin and upgrade authority to Squads last.** `initialize` must be
signed by the program's upgrade authority, so it has to run before the upgrade authority moves to Squads.

## 0. Preconditions

1. GMTrade is still release v0.10.0 on mainnet. `scripts/fixtures.sh` refuses to continue if the deployed
   binary's sha256 differs from the pinned `6056a845…d20a`; if it fails, stop and re-test against the new
   GMTrade binary first.
2. Written permission from GMTrade to link `gmsol-programs` (BSL 1.1, non-production use) in a
   fee-charging product, and the legal review in spec §7.
3. The program id in `Anchor.toml` / `programs/props_vault/src/lib.rs` equals
   `solana-keygen pubkey "$PROGRAM_KEYPAIR"`.
4. All tests pass on the exact commit you deploy:

   ```sh
   export PATH=$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH
   scripts/fixtures.sh
   anchor build
   cargo test --manifest-path programs/props_vault/Cargo.toml
   npm test --workspace packages/sdk
   npm test --workspace tests/program
   npm run test:validator --workspace tests/program
   ```

5. A Squads v4 multisig exists for the handover (threshold ≥ 2, members on separate devices), and you know
   its **vault** address (the PDA that signs, not the multisig account).

## 1. Costs (mainnet rent, 2026-09)

| Item | Size | SOL |
|---|---|---|
| Program data account (`props_vault.so` = 1,077,944 B + 45 B header) | 1,077,989 B | 7.5037 (rent, locked while deployed) |
| Program account | 36 B | 0.0011 |
| Deploy buffer (refunded when the deploy completes) | same as program data | 7.5037 temporarily |
| Deploy transactions (~1,100 writes × 5,000 lamports + priority fee) | | ≈ 0.01–0.05 |
| `Config` + fee vault + capital vault ATA (initialize) | 474 B + 2 × 165 B | ≈ 0.0083 |
| Each tier / market config (upserts) | 70 B / 147 B | 0.0014 / 0.0019 each (55 markets ≈ 0.105) |
| SOL treasury float: owner PDA target per funded account (`owner_sol_target`) | | 0.25 per active funded account, mostly refundable at closure |
| Per trader (paid by the trader): profile, evaluation, funded account, payout request | 86 / 164 / 1,547 / 129 B | 0.0015 / 0.0020 / 0.0117 / 0.0018 |

Have **≥ 15.5 SOL** on the operator key for the deploy (buffer and program data exist at the same time),
plus the treasury float. Net cost after the buffer refund is ≈ 7.51 SOL plus fees. Check current rent
with `solana rent <SO_SIZE + 45> --url "$RPC_URL"` whenever the binary size changes.

## 2. Build a verifiable binary

The binary you deploy must be the one `solana-verify` reproduces, so build it with `solana-verify`
(Docker), not with a local `anchor build`:

```sh
cargo install solana-verify --locked
solana-verify build --library-name props_vault
solana-verify get-executable-hash target/deploy/props_vault.so   # record this hash
```

`anchor build` is still needed once to regenerate `target/idl/props_vault.json`; the SDK's committed copy
(`packages/sdk/src/idl/props_vault.json`) must equal it (the SDK test checks this).

## 3. Deploy

```sh
solana config set --url "$RPC_URL"
solana balance "$(solana-keygen pubkey "$OPERATOR_KEYPAIR")"
solana program deploy target/deploy/props_vault.so \
  --program-id "$PROGRAM_KEYPAIR" \
  --keypair "$OPERATOR_KEYPAIR" \
  --upgrade-authority "$OPERATOR_KEYPAIR" \
  --with-compute-unit-price 10000 \
  --max-sign-attempts 50 \
  --use-rpc
```

If the deploy stops half-way, do not start over: `solana program show --buffers --keypair "$OPERATOR_KEYPAIR"`
lists the buffer; resume with `--buffer <BUFFER_ADDRESS>` or reclaim its rent with
`solana program close <BUFFER_ADDRESS> --keypair "$OPERATOR_KEYPAIR"`.

Check the result:

```sh
solana program show "$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"   # Authority = operator, data length = the .so size
solana-verify get-program-hash -um "$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"   # must equal the hash from step 2
```

## 4. Initialize and configure (operator key)

Every admin script simulates by default and prints the simulation result; add `--execute` to send. Run
each one first without `--execute`, read the output, then again with it.

```sh
export OPERATOR_KEYPAIR RPC_URL
node scripts/admin/initialize.ts --cluster mainnet-beta              # dry run
node scripts/admin/initialize.ts --cluster mainnet-beta --execute    # config + vaults, all pauses ON
node scripts/admin/set-authorities.ts --cluster mainnet-beta --execute \
  --risk <RISK_AUTHORITY_PUBKEY>[,<SECOND_RISK_PUBKEY>] --kyc <KYC_AUTHORITY_PUBKEY>
node scripts/admin/upsert-tiers.ts --cluster mainnet-beta --execute   # spec §1 tiers; prints each terms hash
node scripts/admin/upsert-markets.ts --cluster mainnet-beta --symbols BTC,ETH,SOL,XAU \
  --max-position-usd 10000 --max-total-oi-usd 50000                   # dry run: review the list
node scripts/admin/upsert-markets.ts --cluster mainnet-beta --symbols BTC,ETH,SOL,XAU \
  --max-position-usd 10000 --max-total-oi-usd 50000 --execute
node scripts/admin/deposit-capital.ts --cluster mainnet-beta --amount <USDC_AMOUNT> --execute
solana transfer <SOL_TREASURY_PDA> <SOL_AMOUNT> --keypair "$OPERATOR_KEYPAIR" --allow-unfunded-recipient
```

- `upsert-markets` reads every GMTrade Market of the pinned store, keeps the enabled pure USDC-USDC ones
  whose index asset is in its reviewed category table, and applies the spec §1 leverage caps (crypto 25×,
  FX 20× / 8× closed, metals and oil 15×, stocks and ETFs 8×). Markets you configured earlier and now
  leave out are switched off, never deleted. Size the per-position and per-side caps against current
  pool depth (learnings §8: keep all funded accounts together under ~10% of a pool's LP money).
- The risk and KYC authority keys live only on the server (`RISK_AUTHORITY_KEYPAIR`,
  `KYC_AUTHORITY_KEYPAIR`); pass their public keys here.
- `initialize` sets `max_daily_principal` to 2,500 USDC: `activate_funded` posts at most that much principal per day
  (a window that opens with the first activation after the previous one ended). It bounds what a compromised risk or
  KYC key, or a tampered server database, can put at risk. Raise it with `set_params` (all `ConfigParams` fields are
  set together; read the current ones with `fetchConfig()` first) as the vault and demand grow.
- The SOL treasury is the PDA `["sol_treasury"]` of the program (`solTreasuryPda()` in `@props/sdk`). It
  pays each funded account's owner float (`owner_sol_target`) and payout ATA rents. Budget
  0.25 SOL × expected funded accounts + 0.5 SOL.

Read the state back and compare with what you intended:

```sh
node --input-type=module -e "
import { Connection } from '@solana/web3.js';
import { PropsVaultClient } from '@props/sdk';
const v = new PropsVaultClient(new Connection(process.env.RPC_URL));
console.log(JSON.stringify(await v.fetchConfig(), null, 2));"
```

## 5. Live test with small money, then open

1. Deposit only the test principal (500 USDC) in section 4, keep the app pointed away from the program
   (no public build uses the program id yet), and lift the pauses:
   `node scripts/admin/set-pauses.ts --cluster mainnet-beta --new-evaluations off --trading off --payouts off --execute`.
   With 500 USDC of capital, at most one 10K account can be funded.
2. With an internal, KYC-verified wallet: buy the 10K evaluation, have the risk service record a pass,
   activate (posts 500 USDC), open a $50 SOL position with $10 collateral, wait for the GMTrade keeper
   fill (3–8 s), run `sync`, close it, `sync`, cancel any leftover order, and check that the owner PDA's
   USDC ends at principal ± PnL and that nothing left the owner PDA except order escrows.
3. Close the test account: `POST /v1/admin/funded/<FUNDED_ACCOUNT>/close` (admin token) queues `close_funded`,
   which the server signs with the risk key (positions = `fetchOwnerPositions()`: only existing accounts, an
   address without an account is refused). Confirm the capital vault got the USDC back and
   `allocated_principal` is 0. The account must be flat: an order GMTrade finished but left open keeps it
   from closing until the keeper's `close_completed_order` sweeps it and `sync` runs (the job fails with that
   reason; retry it with `POST /v1/admin/jobs/<JOB>/retry`).
4. Deposit the real capital with `deposit-capital.ts`, then release the app build that uses the program.

## 6. Handover to Squads (last)

Only after steps 1–5 are done and verified. Both authorities move to the Squads **vault** address.

1. Vault admin, two steps (the program has no one-step change):

   ```sh
   node scripts/admin/transfer-admin.ts --cluster mainnet-beta --to <SQUADS_VAULT>             # dry run
   node scripts/admin/transfer-admin.ts --cluster mainnet-beta --to <SQUADS_VAULT> --execute   # propose_admin
   node scripts/admin/transfer-admin.ts --cluster mainnet-beta --to <SQUADS_VAULT> --print-accept
   ```

   The last command prints the `accept_admin` instruction (program id, accounts, base58 data). Add it in
   Squads as a custom instruction signed by the vault, approve and execute it. Then check that
   `fetchConfig()` shows `admin` = the vault and `pendingAdmin` = null. From here on, every admin script
   runs through Squads: build the instruction with `@props/sdk` and import it the same way.

2. Program upgrade authority:

   ```sh
   solana program set-upgrade-authority "$(solana-keygen pubkey "$PROGRAM_KEYPAIR")" \
     --new-upgrade-authority <SQUADS_VAULT> \
     --skip-new-upgrade-authority-signer-check \
     --keypair "$OPERATOR_KEYPAIR"
   solana program show "$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"   # Authority = <SQUADS_VAULT>
   ```

3. Publish the verification: `solana-verify verify-from-repo -um --program-id <PROGRAM_ID>
   <PUBLIC_REPO_URL> --commit-hash <DEPLOYED_COMMIT> --library-name props_vault --mount-path .`; with the
   upgrade authority on Squads, create the verification PDA through Squads with
   `solana-verify export-pda-tx` and submit it with `--remote` so explorers show the program as verified.
4. Move `keys/props_vault-keypair.json` and the operator key to offline storage. The program keypair is
   only needed again if the program is closed and redeployed at the same address (never do that).

## 7. Later upgrades

Build with `solana-verify build`, write a buffer (`solana program write-buffer target/deploy/props_vault.so
--buffer-authority <SQUADS_VAULT>`), and create the upgrade in Squads from that buffer. If the new binary is
larger, first `solana program extend <PROGRAM_ID> <ADDITIONAL_BYTES>` (anyone can pay). Re-run
section 0 step 4 on the commit being deployed, and re-publish the verification.

## 8. What to watch after launch

- The keeper pauses trading if GMTrade's program data slot changes (a GMTrade upgrade); re-run the test
  suite against the new binary (`scripts/fixtures.sh` will fail until the pinned hash is updated).
- `Config.allocated_principal` must equal the sum of `principal` over non-closed funded accounts; the
  capital vault balance must equal deposits − withdrawals − principal posted + closure returns + vault
  profit share + swept fees.
- The SOL treasury balance against `owner_sol_target` × active funded accounts.
