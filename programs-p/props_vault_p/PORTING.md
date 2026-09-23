# props_vault_p: porting guide

A Pinocchio (0.11.2) rewrite of `programs/props_vault` that must be a drop-in replacement: same program id
(`7qYRWwpmj3j3exVoBUJHzigcWmMN8ruPEdZdZrGzTJ7`), same instruction discriminators, borsh args and account lists
(including the `event_authority` + `program` accounts of `#[event_cpi]`), same account bytes, PDAs and stored bumps,
same `emit_cpi!` events, same error numbers and error log lines. The IDL in `packages/sdk/src/idl/props_vault.json`,
`@props/sdk`, the server and the app do not change.

## Status

| Anchor file (`programs/props_vault/src/instructions/`) | Pinocchio file (`src/ix/`) | Instructions | State |
|---|---|---|---|
| `admin.rs` | `admin.rs` | initialize, propose_admin, accept_admin, set_authorities, set_params, set_pauses, upsert_tier, upsert_market, deposit_capital, withdraw_capital, sweep_fees, withdraw_sol_treasury | ported |
| `trader.rs` | `trader.rs` | buy_evaluation, activate_funded, request_payout, cancel_payout | ported |
| `trading.rs` | `trading.rs` | open_position, close_position, set_protection, update_order, cancel_order | ported |
| `risk.rs` | `risk.rs` | set_identity, record_evaluation_result, approve_payout, reject_payout, restrict, mark_breached, close_funded | ported |
| `crank.rs` | `crank.rs` | sync, top_up_owner, close_completed_order | ported |

All 31 instructions are ported: `src/lib.rs` dispatches every discriminator, the event self-CPI and Anchor's IDL tag,
and the suite passes 60/60 on this build as on the Anchor build.

Binary: 162,800 bytes (145,120 before the payout and risk actions, 88,856 before trading and the cranks, 64,128 with
admin only; the Anchor build is 981,640 bytes). Trading brought in the GMTrade CPI builders (`CreateOrder::invoke`
4.2 KB, `CloseOrder::invoke` 2.1 KB, `update_order` 1 KB); the largest handlers are sync 7.3 KB, open_position 6 KB,
activate_funded 5.6 KB, update_order 4.9 KB and approve_payout 4.1 KB.

## Build, test, compare

```sh
export PATH=$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH   # Homebrew cargo shadows rustup
cargo build-sbf --manifest-path programs-p/props_vault_p/Cargo.toml --sbf-out-dir target/deploy   # → target/deploy/props_vault_p.so
cargo test --manifest-path programs-p/props_vault_p/Cargo.toml     # every hard-coded discriminator and PDA vs its sha256 / find_program_address; GMTrade CPI helpers refuse any other program
cd tests/program && PROPS_VAULT_SO=$PWD/../../target/deploy/props_vault_p.so npm test          # the suite on this build
cd tests/program && npm test                                                                    # the suite on the Anchor build (60/60)
node programs-p/props_vault_p/compare/admin.ts                    # byte-level diff against the Anchor build (needs both .so files); also trader.ts, risk.ts, trading.ts, crank.ts
cd tests/program && PROPS_VAULT_SO=... npm run test:validator    # solana-test-validator, mainnet feature set (needs ports 18001/18899/19900)
rustfmt --edition 2021 --config max_width=120,use_small_heuristics=Max programs-p/props_vault_p/src/lib.rs
```

The crate has its own `[workspace]` so the Anchor build's `Cargo.toml`, `Cargo.lock` and output are untouched
(`anchor build` still produces a byte-identical `props_vault.so`). Release profile as the root: `overflow-checks = true`,
`lto = "fat"`, `codegen-units = 1`, `opt-level = "s"` (measured on the admin build: s 84,728 B, z 84,808, 2 85,688,
3 86,320). `cargo build-sbf` writes a throwaway `target/deploy/props_vault_p-keypair.json` (gitignored, never used:
the program id is fixed in `src/lib.rs`).

`compare/harness.ts` runs a scenario on both builds in LiteSVM with deterministic keys and clock and diffs every
transaction outcome (success, `Error Code`, runtime error, error log lines minus the origin of difference 2, and every
inner instruction = events and CPIs: stack height, program, account list in order, data) and every snapshotted account
(lamports, owner, data). The signer/writable flags of CPI accounts are not in the transaction metadata, so check those
against the IDL by reading. Add
`compare/<your file>.ts` for your instructions (copy `admin.ts`) and keep it at 0 differences. It prints compute units
side by side. LiteSVM's `airdrop` below the zero-data rent minimum (890,880 lamports) fails without a word, so pre-fund a
PDA with at least that to reach Anchor's transfer + allocate + assign path (1,000,000 is below every account's rent).
`trading.ts` exports raw writers for state no instruction reaches directly (funded status, slot and order sums,
`order_seq`, open interest, GMTrade order state; offsets checked against the IDL decoder) that `crank.ts`, `trader.ts`
and `risk.ts` reuse. A `program` account (the last `#[event_cpi]` account) that is not this program makes the event
self-CPI fail with the runtime's `MissingAccount` in LiteSVM, on both builds (neither checks the account itself). An
owner PDA's 0.25 SOL float covers about four GMTrade positions and four orders: past that GMTrade's rent transfer fails
(custom error 1), so airdrop more to owners that open more. The SDK's `cancelOrder` / `updateOrder` builders throw for an
order the account does not track: build those refusals by swapping the order key into a valid instruction.

## Module map

| File | What it holds |
|---|---|
| `src/lib.rs` | program id, entrypoint (pinocchio's input parser; the error code goes out as is), `process_instruction` (program id check, dispatch, one error log line), instruction discriminators, host test of every constant |
| `src/error.rs` | `E` (every Anchor framework code we raise + `VaultError` 6000..6041), `Error` / `Result` (register-sized), `require`, the Anchor-format error log |
| `src/state.rs` | seeds, limits, math helpers (`to_gm_usd`, `apply_bps`), LE field types, every account layout with its discriminator, `load::<T>`, the `Config` view, instruction arg structs (`ConfigParams`, `TierParams`, `MarketParams`, `Pauses`), enum constants, the Anchor state helpers (`FundedAccount::find_slot`, `track_order`, `Terms::loss_allowance`, `MarketConfig::apply_oi_change`, `ConfigTail::allocate_daily_principal`, ...) |
| `src/accounts.rs` | program ids, singleton PDAs (`CONFIG_PDA`, `VAULT_PDA`, `FEE_VAULT_PDA`, `SOL_TREASURY_PDA`, `EVENT_AUTHORITY_PDA`), Anchor account types and constraints (`take`, `signer`, `system_account`, `program_account`, `mutable`, `keys_eq`, `singleton`, `seeds`, `find_seeds`, `check_event_authority`, `token_account`, `mint_account`, `token_constraint`, `associated_token_constraint`), PDA syscalls, `ata_address`, `now()`, `Rent`, the borsh reader `Args` |
| `src/cpi.rs` | one `invoke` for every CPI, system/token/ATA instructions with the Anchor build's layouts, `top_up_from_treasury`, Anchor `init` / `init_if_needed` (`init_pda`, `init_token_pda`, `init_ata_if_needed`, `create_account_anchor`), the borsh writer `Buf` |
| `src/events.rs` | event discriminators, `ConfigChange` indexes, `event::<N>(disc)`, `emit`, `receive` (the self-CPI's receiving end) |
| `src/gmtrade.rs` | GMTrade layouts and readers (`position_state`, `check_position_identity`, `verified_position_size`, `is_pending_order`, `check_pure_usdc_market`), `order_params`, CPIs `CreateOrder::invoke` (escrow ATA + `prepare_user` + `prepare_position` + `create_order_v2`), `CloseOrder::invoke` (`close_order_v2`), `update_order` (`update_order_v2`) |
| `src/ix/*.rs` | handlers, one file per Anchor instruction file |
| `compare/` | the byte-level diff harness and one scenario per instruction file |

You should not need to edit the shared modules. If you must, add to them (do not reshape existing helpers) and say so,
since three ports run in parallel.

## How to write a handler

```rust
pub fn upsert_tier(accounts: &[AccountView], data: &[u8]) -> Result {
    // 1. Args, in IDL order (Anchor deserializes them before touching accounts).
    let mut args = Args(data);
    let id = args.u16()?;
    let params = TierParams::read(&mut args)?;
    // 2. Accounts in IDL order, including event_authority and program at the end of every #[event_cpi] struct.
    let [admin, config, tier, system_program, event_authority, _program] = take::<6>(accounts)?;
    // 3. Phase 1, account TYPES in field order (Signer, SystemAccount, Program, Account<T> loads). init fields skip this.
    signer(admin)?;
    let c = Config::load(config)?;
    program_account(system_program, &SYSTEM_PROGRAM_ID)?;
    // 4. Phase 2, init / init_if_needed fields in field order.
    let (t, bump) = init_pda::<Tier>(admin, tier, &[TIER_SEED, &id.to_le_bytes()], true, &Rent::get()?)?;
    // 5. Phase 3, every other field's constraints, field by field, each field in Anchor's constraint order.
    mutable(admin)?;
    singleton(config, c.bump, &CONFIG_PDA)?;
    keys_eq(c.admin(), admin.address(), E::Unauthorized)?;   // has_one = admin @ VaultError::Unauthorized
    check_event_authority(event_authority)?;
    // 6. The Anchor handler body, same checks in the same order, same errors, checked math.
    params.validate()?;
    t.version.set(t.version.get().checked_add(1).ok_or(E::MathOverflow)?);
    // ...
    // 7. The event, where the Anchor handler emits it.
    let mut e = event::<60>(disc::CONFIG_CHANGED);
    e.u8(config_change::TIER).key(tier.address()).bool(c.paused.new_evaluations.get()) /* ... */ .i64(now()?);
    emit(event_authority, &e)
}
```

That order is anchor-syn 0.31's `try_accounts`: deserialize every field (types), then run the `init` fields'
constraints, then the other fields' constraints. Within one field the order is (anchor-syn `linearize`):
init → seeds → associated_token → mut → signer → has_one → constraint → owner → rent_exempt → executable → close →
address → token:: (authority, then mint) → mint::. Following it keeps the error a failing transaction reports equal to
the Anchor build's when several things are wrong at once.

### Constraint map

| Anchor | Here | Error (number) |
|---|---|---|
| fewer accounts than declared | `take::<N>(accounts)?`; remaining accounts = `&accounts[N..]` | AccountNotEnoughKeys (3005) |
| `Signer<'info>` | `signer(v)?` | AccountNotSigner (3010) |
| `SystemAccount<'info>` | `system_account(v)?` | AccountNotSystemOwned (3011) |
| `Program<'info, T>` | `program_account(v, &ID)?` | InvalidProgramId (3008), InvalidProgramExecutable (3009) |
| `Account<'info, T>` (ours; `Box` or not) | `load::<T>(v)?`, `Config::load(v)?` | AccountNotInitialized (3012), AccountOwnedByWrongProgram (3007), AccountDiscriminatorNotFound (3001), AccountDiscriminatorMismatch (3002), AccountDidNotDeserialize (3003) |
| `Account<'info, TokenAccount>` / `Account<'info, Mint>` | `token_account(v)?` / `mint_account(v)?` | 3012, 3007, then runtime InvalidAccountData / UninitializedAccount (Anchor's `unpack`) |
| `UncheckedAccount`, `AccountInfo` | nothing | |
| `init, payer, space, seeds = [..], bump` | `init_pda::<T>(payer, v, &[..], false, &rent)?` → `(&mut T, bump)` | ConstraintSeeds (2006), system program "already in use", TryingToInitPayerAsProgramAccount (4101), ConstraintMut (2000) |
| `init_if_needed, ...` | `init_pda::<T>(payer, v, &[..], true, &rent)?` | the above + the load errors + ConstraintSpace (2019), ConstraintOwner (2004), ConstraintRentExempt (2005) |
| `init, seeds, bump, token::mint, token::authority` | `init_token_pda(payer, v, &[..], mint, authority, token_program, &rent)?` | 2006, 2000, 2015, 2014 |
| `init_if_needed, associated_token::mint, associated_token::authority` | `init_ata_if_needed(payer, v, wallet, mint, system_program, token_program)?` | ConstraintTokenMint (2014), ConstraintTokenOwner (2015), ConstraintAssociatedTokenTokenProgram (2023), AccountNotAssociatedTokenAccount (3014), 2000 |
| `mut` | `mutable(v)?` | ConstraintMut (2000) |
| `signer` (the constraint) | `signer_constraint(v)?` | ConstraintSigner (2002) |
| `seeds = [..], bump = x.bump` (per-user PDA) | `seeds(v, &[SEED, key.as_ref(), &[x.bump]])?` | ConstraintSeeds (2006) |
| `seeds = [SEED], bump = config.x_bump` (singleton) | `singleton(v, c.x_bump, &X_PDA)?` | 2006 |
| `seeds = [..], bump` on a non-init field | `find_seeds(v, &[..])?` → bump (`ctx.bumps.x`) | 2006 |
| `#[event_cpi]` `event_authority` | `check_event_authority(v)?`; `program`: nothing | 2006 |
| `has_one = f` / `has_one = f @ VaultError::X` | `keys_eq(&x.f, f.address(), E::ConstraintHasOne / E::X)?` | 2001 / custom |
| `constraint = expr` / `... @ VaultError::X` | `require(expr, E::ConstraintRaw / E::X)?` | 2003 / custom |
| `owner = p` | `keys_eq(v.owner(), p, E::ConstraintOwner)?` | 2004 |
| `address = a` / `... @ VaultError::X` | `keys_eq(v.address(), &a, E::ConstraintAddress / E::X)?` | 2012 / custom |
| `address = get_associated_token_address(&w, &m)` | `keys_eq(v.address(), &ata_address(w, m), E::ConstraintAddress)?` | 2012 |
| `token::mint = m, token::authority = a` | `token_constraint(t, m.address(), a.address())?` (authority first) | 2015, 2014 |
| `associated_token::mint = m, associated_token::authority = w` | `associated_token_constraint(v, t, w, m)?` | 2015, ConstraintAssociated (2009) |
| `require!(c, VaultError::X)` / `require_keys_eq!(a, b, VaultError::X)` | `require(c, E::X)?` / `keys_eq(&a, &b, E::X)?` | custom |
| `.ok_or(VaultError::MathOverflow)?`, `error!(..)` | `.ok_or(E::MathOverflow)?`, `Err(E::X.into())` | custom |
| `Clock::get()?.unix_timestamp` | `now()?` | |
| `Rent::get()?.minimum_balance(n)` | `Rent::get()?.minimum_balance(n)` (`accounts::Rent`) | |
| `ctx.bumps.x` | the bump `init_pda` / `init_token_pda` / `find_seeds` return, or `X_PDA.1` | |
| `emit_cpi!(Event { .. })` | `event::<N>(disc::EVENT)` + field writes + `emit(event_authority, &e)?` | |
| `close`, `realloc`, `zero`, `executable`, `rent_exempt = ..`, `mint::` | not used by props_vault | |

### State

- `load::<T>(view)` returns `&mut T` over the account data (zero-copy, little-endian fields: `.get()` / `.set(v)`;
  bools are `Bool`, enums are `u8` with constants in `state::{evaluation_status, funded_status, order_type,
  payout_status}`). `Config::load` gives a view whose fixed tail derefs to `ConfigTail` (`c.min_payout.get()`,
  `c.paused`, ...); `c.admin()`, `c.pending_admin()`, `c.risk_authorities()`, `c.is_risk_authority(k)` read the
  variable part, and `set_admin`, `set_pending_admin`, `set_risk_authorities` rewrite it as Anchor's re-serialization
  does (bytes after the new end are left alone, like Anchor).
- Anchor copies typed accounts at load and writes `mut` ones back after the handler. Views read and write the live
  data, so:
  - read a token account's `amount` (and anything else a CPI changes) before the CPI when Anchor uses the load-time
    value (`deposit_capital` reports the vault balance as `amount_at_load + amount`);
  - write only accounts Anchor marks `mut` or `init`; a write to anything else would persist (or fail on a read-only
    account) where Anchor dropped it;
  - load each account once (two views of one account alias; PDA and discriminator checks make that impossible for
    distinct fields, keep it that way in remaining-account loops).
- Account sizes and field offsets equal the IDL (compile-time size asserts; offsets were checked field by field against
  the IDL once). Creating an account writes its discriminator immediately (Anchor writes it at exit; a failing
  instruction reverts either way).

### CPIs, signers, init

- Everything goes through `cpi::invoke(program_id, &[metas], data, signers)`; `r / w / rs / ws` build metas
  (readonly / writable / readonly signer / writable signer) from account views, in the callee's account order.
- Signer seeds are solana-program style: `&[&[SEED, key.as_ref(), &[bump]]]` (one entry per signing PDA).
- System: `transfer`, `create_account`, `allocate`, `assign`, `top_up_from_treasury`. Token: `transfer_checked`,
  `close_account`, `initialize_account3`. ATA: `create_ata(.., idempotent, ..)`. These send the same instruction bytes
  and account metas as anchor_lang / anchor_spl.
- `init_pda` reproduces Anchor's init exactly: canonical PDA check, `create_account` when the account has no lamports,
  otherwise (pre-funded) payer transfer up to `max(rent, 1)`, `allocate` + `assign` signed by the PDA; for
  `init_if_needed` on an existing account it loads it and runs the space / owner / rent checks. Pass `rent` from
  `Rent::get()?` (one read per instruction is enough).

### Events

`let mut e = event::<N>(disc::NAME);` writes the event tag and discriminator; append the fields in IDL order with
`Buf` (`u8 bool u16 u32 u64 i64 u128 key bytes option_u128 option_i64`; a `Vec` is `u32(len)` then the items), then
`emit(event_authority, &e)?`. `N` = 16 + the largest body (a too small `N` panics, it never truncates). `emit` is the
self-CPI signed by `["__event_authority"]`; `events::receive` rejects anything the event authority did not sign
(ConstraintSigner, like Anchor).

### Errors

`E` has every error this program raises; `E::X.into()` is an `Error`, and `Result<T> = Result<T, Error>`.
`process_instruction` logs each error once, as
`AnchorError occurred. Error Code: <Name>. Error Number: <n>. Error Message: <msg>.` (runtime errors we return
ourselves: `ProgramError occurred. ...`). If you need an Anchor framework code that is not in `E` yet, add it to `E` and
to `TEXT` in `error.rs` with Anchor's exact name and message (anchor-lang 0.31.1 `src/error.rs`).

### GMTrade

`gmtrade.rs` mirrors `programs/props_vault/src/gmtrade.rs`: same offsets, same checks, same errors. The CPIs were built
from `tests/program/fixtures/gmsol_store.idl.json` the way `declare_program!` builds them (IDL account order and flags,
an absent optional account = the GMTrade program id, readonly). Use them like the Anchor macros:

```rust
let owner_seeds: &[&[u8]] = &[OWNER_SEED, funded.address().as_ref(), &[f.owner_bump]];
gmtrade::CreateOrder { owner, store: gm_store, market: gm_market, user: gm_user, position: gm_position, order: gm_order,
    usdc_mint, escrow: order_escrow, event_authority: gm_event_authority, program: gmtrade_program, token_program,
    associated_token_program, system_program }
    .invoke(&[owner_seeds], f.next_order_nonce(), &gmtrade::order_params(order_type::MARKET, is_long, collateral, size, None, Some(acceptable)), Some(owner_usdc))?;
```

The owner PDA signs these CPIs and is the authority of the account's USDC, so each helper first checks its `program`
account is GMTrade (`program_account(program, &GMTRADE_PROGRAM_ID)`, Anchor's `Program<'info, GmsolStore>`): a
handler that forgot its own check still cannot hand that signature to another program (`cargo test` proves the helpers
refuse one). Still do the phase-1 `program_account(gmtrade_program, &GMTRADE_PROGRAM_ID)` in every handler: it decides
which error a transaction with several faults reports. `tests/program/src/review.cpi.test.ts` swaps `gmtrade_program`
for SPL Token on all six GMTrade-CPI instructions (open_position, close_position, set_protection, update_order,
cancel_order, close_completed_order) and expects `InvalidProgramId`, as the Anchor build answers; give each compare
scenario the same substitution.

Every helper in the shared modules is now exercised by a ported instruction and compared byte for byte
(`verified_position_size`, `close_account` and `FundedAccount::is_flat` by the payout and closure scenarios in
`compare/risk.ts` and `compare/trader.ts`); the CPI account flags were checked against `gmsol_store.idl.json` and the
SPL Token / ATA / System instruction builders by reading.

## Deliberate differences from the Anchor build

1. No `Program log: Instruction: <Name>` line (nothing parses it; about 2 KB).
2. Error lines carry no origin: `AnchorError occurred.` where Anchor may print `caused by account: <name>` or
   `thrown in <file>:<line>`, and no `Left:` / `Right:` lines. Error Code, Number and Message are identical, which is
   what the server (`/Error Code: (\w+)/`) and the app (`custom program error: 0x..` + the IDL) read.
3. Too few accounts is checked up front (`AccountNotEnoughKeys`); Anchor reports an earlier bad account first when
   both happen. Still a failure.
4. ATA creation passes the given account to the ATA program, which rejects a wrong one (`InvalidSeeds`); Anchor
   derived the address itself and its CPI failed with `MissingAccount`. Same accept/reject set.
5. Anchor's onchain-IDL instructions are not included (the IDL tag answers `IdlInstructionStub`, as with Anchor's
   `no-idl`), so every `anchor idl` command fails against this build. Kept out for size: the onchain IDL is optional
   (explorers only; server, app and SDK decode with the IDL bundled in `@props/sdk`, learnings.txt round 3). The launch
   runbook is written for the Anchor build, so the change that switches the deploy to this build must also drop or
   replace, in `docs/runbooks/launch.md`, §0 (IDL authority in the order), §4 (`anchor idl init`, `anchor idl
   authority`), §13.2-13.3 (`anchor idl set-authority`, the `^idl` check), §14.4 (IDL write-buffer / set-buffer) and
   the IDL row of §15 (and §3/§14 build `props_vault_p`, not `props_vault`); the `anchor idl init` recommendation in
   `docs/ARCHITECTURE.md` §8 "Launch"; and the `idl` line and warning of `scripts/admin/status.ts` (its warning is
   already stale). An IDL can still be published with a tool that needs no instruction in this program, e.g. the
   Program Metadata program (`@solana-program/program-metadata` on npm); check what explorers read before relying on it.
6. Singleton PDAs (config, vault, fee_vault, sol_treasury, event authority) are constants checked by `cargo test`
   instead of `find_program_address` at runtime: same accept/reject set, far fewer compute units.
7. Compute units are much lower (initialize 75.0k → 33.5k, upsert_tier 25.3k → 7.7k, deposit 22.1k → 3.6k, set_pauses
   16.3k → 2.2k). Nothing depends on the old numbers.

## Size notes

What keeps it small, keep doing it: non-generic cores behind thin generic wrappers (`load` → `load_raw`, `init_pda` →
`init_pda_raw`: each account type would otherwise add ~2 KB), `#[inline(never)]` on helpers that compare 32-byte
constants (~130 bytes per inlined compare), `Result<()>` in one register (`Error` is a `NonZeroU64`), error text in one
blob, no closures in CPI helpers (each closure monomorphizes the callee). Check `llvm-nm --size-sort -S` on
`programs-p/props_vault_p/target/sbpf-solana-solana/release/props_vault_p.so` after each port.

Leads not taken: integer and string formatting pulled in by panics with formatted messages (bounds checks, `unwrap`)
costs ~3.7 KB (`core::fmt::num`, `pad_integral`, `do_count_chars`); pinocchio's unrolled input parser is 3.2 KB; the
soft-float rent formula is ~2.5 KB but gives exactly solana-program 2.3's amounts under any Rent sysvar. pinocchio's
own `Rent` (`lamports_per_byte × (128 + len)`) ignores `exemption_threshold`, so it agrees only while the sysvar holds
threshold 1.0 (LiteSVM 0.8 reports 6960 / 1.0); switching to it saves the float code but ties rent amounts to that.
`apply_bps` divides a u128, which pulls in compiler_builtins' `u128_div_rem`, `__udivti3`, `__lshrti3` and `__ashlti3`
(5.8 KB; activate_funded's `loss_allowance` is the first caller, request_payout and open_position need it too): with
q, r = amount / 10⁴, amount % 10⁴, the checked u64 form q·bps + r·bps / 10⁴ gives the same results and errors without
it. `Buf<N>::bytes`, `event::<N>` and `emit::<N>` are instantiated once per distinct `N`, ~700 bytes each: one `N` per
file, or a writer core that is not generic over `N`, would save most of that. trading.rs and crank.rs share one
(`trading::EV` = 904, Synced's largest body; 744 bytes less than one per file). The payout and risk-action events reuse
`N`s other handlers already instantiate (102, 129, 168), so they added no copy; 10 distinct `N`s remain (5 in admin.rs),
so one `N` for the whole crate would save roughly 6 KB.

## Checklist per instruction

1. Read the Anchor accounts struct and handler; note each field's type and constraints in order.
2. Args with `Args` in IDL order; `take::<N>` with N = the IDL account count.
3. Phase 1 types, phase 2 init fields, phase 3 constraints (per-field order above), then the body with the same checks,
   order, errors and checked math.
4. Writes only to `mut` / `init` accounts; token amounts read before the CPIs that move them.
5. The event with the same fields in the same order, at the same point.
6. Build; run the suite with `PROPS_VAULT_SO`; add the scenarios to `compare/<file>.ts` and reach 0 differences;
   check the size.
