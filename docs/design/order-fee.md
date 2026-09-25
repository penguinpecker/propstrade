# Props.trade order fee: design

Status: implemented in both program builds on 2026-09-26 (`programs/props_vault` and `programs-p/props_vault_p`,
identical behaviour), with `tests/program` and `packages/sdk`; not deployed. Two design reviews and two independent
audits were applied (listed in §11). What the server, app, shared contract and `docs/ARCHITECTURE.md` need is in §9, for
the team that owns them; nothing there is built yet. The rate must stay 0 until every prerequisite in §9 "Before the
first nonzero rate" is in place.

The owner's decision (2026-09-25): Props.trade charges its own fee on every order, on demo accounts (practice and
evaluation, simulated by the server) and on funded accounts (this program). The rate is not decided: a flat USDC amount
per order and/or basis points of the order's size, both set by the admin, both 0 (off) by default. Revenue on funded
accounts goes to the program's fee vault, where evaluation fees go.

On practice and evaluation accounts the fee is simulated: it lowers the virtual balance and P&L exactly as it would on a
funded account, but no USDC moves, it is not revenue, and it earns no referral reward (§9 Referrals; §10 Q3 asks the
owner to confirm).

## 1. Decision: assessed when placed, charged only if executed

1. When a trader places or updates an order, the program computes its fee at `Config`'s current rate, refuses the order
   if that fee is above the `max_fee` the trader signed (`OrderFeeChanged`), stores the fee next to the order on the
   funded account and emits it with the rate that produced it.
2. Cancelling through the program (`cancel_order`, by the trader or a risk authority) releases the fee: nothing is
   charged and no USDC moves.
3. When an order leaves the book any other way, its fee becomes the account's `order_fees_due` or is released:
   `sync` makes due the fee of an order whose account is gone (the exchange executed it or cancelled it: the program
   cannot tell which); `close_completed_order`, for an order the exchange finished but left open, reads which: an
   executed order's fee becomes due, a cancelled one's is released as by `cancel_order`.
4. A risk authority settles `order_fees_due` with `settle_order_fees(charge, waive, expected_due, expected_settlements)`:
   `charge` moves from the account's USDC to the fee vault, `waive` is forgiven, and `expected_due` and
   `expected_settlements` must equal the fees due and the account's settlement count, which every settlement advances:
   a stale settlement fails, and a settlement lands at most once. This is the only new token movement.
5. An order that adds exposure must leave its fee, the fees already due and the fees of the account's pending increase
   orders in the account's USDC (fees count against the loss allowance like trading costs). Decrease orders are never
   held; closes, take profits, stop losses, cancels and collateral-only additions never need or move fee money (a
   trader's decrease still checks its own fee against the `max_fee` it signed, §6.2).
6. `request_payout` and `close_funded` require `order_fees_due == 0`.
7. Free: a risk authority's close of a breached account (the breach auto-close: the account's USDC all returns to the
   capital vault), liquidations (no order of ours) and collateral-only additions (size 0). A risk authority's close of an
   active or restricted account (the session guard) is assessed like the trader's own close.

What the program enforces, whatever the keeper does: every fee is computed onchain from the rate and the order's size
(bounded by the trader's `max_fee` on the trader's orders); a settlement pays only the fee vault, only from the account's
own USDC, at most the fees due in total and at most the balance, signed only by a risk authority, and only against the
current `order_fees_due` and settlement count, so it lands once.

What Props' settlement adds (keeper policy, checkable against the exchange's public order records): only executed orders
are charged, each at most the rate on the size it filled; every other order is waived.

For traders: "Each order shows its Props fee before you place it, and the order fails rather than cost more. Props
charges it only if the order executes, on the size it fills: never for an order you cancel, an order we cancel, an order
the exchange does not execute, the close of a breached account or a liquidation. When the session guard closes a
position held above the closed-session leverage limit, that close is charged like your own." (The second and third
sentences are Props' settlement policy; the first is enforced by the program, once the app passes `max_fee`, §9.) On
practice and evaluation accounts the Props fee is simulated: it lowers your virtual balance and P&L the same way it would
on a funded account, but no USDC moves.

## 2. Options evaluated

Criteria in the owner's order: (1) never charged more than the rate × what was traded, and visible; (2) never takes
margin a position needs, never causes a liquidation or a stuck order; (3) fee money can only go to the fee vault; (4)
exact loss accounting, settled by payouts and closure; (5) simplicity; (6) parity with the simulator.

| | A: collect at placement, refund on our cancel | B: keeper `collect_order_fees(amount)` ≤ rate × created notional − collected | C (chosen): assess at placement, settle executed orders |
|---|---|---|---|
| 1 | Charges orders the exchange cancels: slippage-cancelled market orders, a stop loss the exchange refuses as insolvent just before it liquidates (a Props fee in a liquidation); close-all orders priced at the size when placed | Exact only if the keeper is right; the onchain bound keeps growing with orders the trader cancelled | Onchain bound = assessed fees of orders not cancelled through the program nor known cancelled by the exchange; the keeper charges executed orders on their executed size; every fee and its rate in an event |
| 2 | Closes, TP/SL must go through with no free USDC (an all-in position has none), so a debt ledger is needed anyway; refunds come from the fee vault, which `sweep_fees` empties, so a cancel could fail | Owner USDC only | Settlement touches owner USDC only; closes, TP/SL and cancels never move fee money |
| 3 | Yes | Yes | Yes |
| 4 | With the ledger | The program cannot tell uncollected fees from fees never due: a payout would split them 80/20 as profit, or a collection after the request fails `approve_payout` (`BalanceChanged`); closure cannot settle | Payout and closure gated on `order_fees_due == 0`; every movement evented |
| 5 | Fee vault (and owner USDC on decreases) on every order instruction: every trader order write-locks the fee vault (contention across all traders) and grows | One instruction, but payout and closure need more | 2 instructions, 5 fields, 1 read-only account on `update_order`, 8 bytes (`max_fee`) per order instruction; no refunds |
| 6 | The simulator would have to charge orders that never fill | Fills | Fills, same formula (SDK) and same rule |

Also considered and rejected:
- Sync attribution (charge a finished order at `sync` when its slot's size changed, release it when it did not): exact
  onchain for the common case, but several orders finishing on one slot between syncs cannot be told apart, a
  liquidation in the same window charges the trader's orphaned TP/SL, an open and an immediate take profit between two
  syncs go free, and it puts fee logic into `sync`, the largest audited handler.
- A fee on increases only, priced for the round trip: simplest, but not "every order", and closes and TP/SL are free.
- Assessing a decrease on the slot's committed size (the first draft): a take profit placed on an empty or small slot
  kept a small fee after the position grew (review probes 1 and 2, §3). Raising resting decrease fees on every increase
  of the slot closes that too, but changes fees the trader did not sign on an instruction that does not name those
  orders; accepting the gap leaves the bps part of every close avoidable. The account's exposure cap is a true upper
  bound that needs neither.
- Assessing a decrease on the market's position limit (the second draft): not a bound once the admin changes it. Lowered
  below an open position, a close was assessed on less than it closes; raised after a take profit was placed, the
  position could outgrow the take profit's fee; and a limit above a small tier's exposure over-assessed that tier
  (audits 1 and 2). min(limit, exposure cap) with max(·, committed size) fixes the first and third but not the second.
- The rate snapshotted into `Terms` at purchase (rules pinned per account): changes `Terms`, `Evaluation` and
  `FundedAccount` and what `buy_evaluation` binds. The owner must decide it before the first nonzero rate (§10 Q5).
- The rate in `ConfigParams` / `set_params`: changes the arguments of `initialize` and `set_params`, which
  `scripts/admin/set-params.ts` and the runbook's multisig flow build with every parameter named. A separate instruction
  leaves them untouched.
- A global `Config` total of order fees: `settle_order_fees` would write-lock `Config`, which every order instruction
  reads. Totals come from the events and `FundedAccount.order_fees_paid`.
- Settlement by totals only (`charge`, `waive`): a retried or replayed settlement could spend room left by other orders.
  `expected_due` alone is not enough: the fees due return to an earlier value whenever the trader repeats an order size
  (a fee depends only on rate and size), and a re-sent settlement then went through again (audit 2). With the settlement
  count, which only moves forward, each settlement is a compare-and-set that lands once.

## 3. The fee rule

Rate: `(order_fee_usdc, order_fee_bps)` from `Config` when the order is placed or updated.

```
fee(size, cap) = 0                                                                  if size == 0
               = order_fee_usdc + ⌊⌊min(size, cap) / 10^14⌋ × order_fee_bps / 10,000⌋   otherwise
```

`size` is the order's own size in GMTrade USD (10^20 = $1); `⌊· / 10^14⌋` is micro-USD = USDC base units (USDC valued
at $1, as collateral already is). Both roundings are down. The zero rule tests the order's own size: only a
collateral-only increase is free; every decrease is at least $1, so it always pays the flat part.

| Order | Instruction | `cap` |
|---|---|---|
| Market or limit increase | `open_position` | none (its size is bounded by the market and account limits) |
| Close, sized or `CLOSE_ALL`, by the trader | `close_position` | the account's exposure cap, `funded.terms.max_exposure_gm()` (size × max exposure) |
| Take profit / stop loss | `set_protection` | as a close |
| Update (resize or trigger/price only) | `update_order` | as above for its kind, re-assessed at the current rate on every call |
| Close by a risk authority of an active or restricted account (session guard) | `close_position` | as a trader's close |
| Close by a risk authority of a breached account (breach auto-close) | `close_position` | fee 0 |
| Liquidation, auto-deleveraging | the exchange | not an order of ours: none |

A decrease is assessed on the account's exposure cap because the position can grow before it fires, but never past that
cap: every increase is checked against it (`ExposureTooHigh`) and it is pinned in the account's terms, so no admin change
can move it. The assessed fee is the most the order can cost, and it is charged on what it actually closes. The market's
position limit is not such a bound (the admin can lower it below an open position or raise it after a take profit was
placed, §2). The cost: for a tier whose exposure cap is above a market's limit, the maximum of a close-all order is
higher than on the limit (the 25K tier under the runbook's $10,000 limits: $2 + 10 bps of $25,000 = $27 at the caps,
not $12); what is charged does not change.

Charge for an order that executed (the keeper, §9): `min(assessed, fee at the rate in its latest assessment event on the
executed size)`. An increase executes once, in full, or not at all, so it is charged exactly its assessed fee; a decrease
is charged the rate on the size it closed. An order that did not execute is charged nothing.

Example, rate $0.50 + 2 bps, a $10,000 long placed with take profit and stop loss (close-all), as the app does, on a 10K
account (exposure cap $10,000):
- open assessed $2.50 (held in the account's USDC), TP $2.50 and SL $2.50 (assessed on the $10,000 cap, not held);
- the open executes: charged $2.50; the TP executes on $10,000: $2.50; the keeper cancels the SL: released. Total $5.00;
- the same open cancelled by the exchange for slippage: $0 (waived);
- a $4,000 partial close first ($1.30), then the TP closes the remaining $6,000: $0.50 + $1.20 = $1.70 charged, $0.80 of
  its $2.50 waived.

On a 25K account (exposure cap $25,000) the same TP and SL are each assessed $5.50 (the most they could cost) and still
charged on what they close. The ticket shows the expected fee and that maximum (§9 App).

Review probes, now regression tests (`fees.test.ts`, `compare/fees.ts`): a collateral-only open (free) with a close-all
take profit in the same transaction assesses the take profit at the flat part plus the bps of the cap, not 0; after
the trader adds $2,000 and moves the trigger, the update re-assesses it at the current rate; a close-all take profit
placed on a $10 position that grows to $2,010 carries a fee that covers the $2,010 it closes. Audit probes, also
regression tests: a take profit placed under a $2,000 limit still covers the $10,000 the position reaches after the limit
is raised; a close under a limit lowered below the position counts all it closes; a market limit above the account's cap
counts the cap; the 25K tier counts its $25,000 cap.

## 4. Program changes (both builds, identical)

### 4.1 Accounts and constants (fields appended; every existing offset unchanged)

`Config`, after `sol_treasury_bump`: `order_fee_usdc: u64`, `order_fee_bps: u16`. 484 bytes (was 474). Port: `ConfigTail`
gains the same two fields at its end (269 → 279 bytes, `CONFIG_SPACE` 484).

`FundedAccount`, after `owner_bump`: `order_fees: [u64; 8]` (the fee assessed on `orders[j]`; 0 while it is free or a
risk authority's close of a breached account), `order_fees_due: u64`, `order_fees_paid: u64`, `order_fee_settlements:
u64` (settlements so far, §4.5). 1,635 bytes (was 1,547); port body 1,539 → 1,627. New field offsets (discriminator
included): `order_fees[j]` 1,547 + 8j, `order_fees_due` 1,611, `order_fees_paid` 1,619, `order_fee_settlements` 1,627.
`TrackedOrder` is unchanged, so every existing raw writer and offset stays valid.

Constants: `MAX_ORDER_FEE_USDC = 2_000_000` ($2 per order), `MAX_ORDER_FEE_BPS = 10` (0.1 %). Raising either needs a
program upgrade (§10 Q2).

Helpers (both builds; the port puts `order_fee` on `ConfigTail`):
- `Config::order_fee(size, cap) -> Result<u64>`: §3's formula, checked (`MathOverflow`).
- `FundedAccount::reserved_fees() -> Result<u64>`: `order_fees_due` + Σ `order_fees[j]` over tracked increase orders.
- `FundedAccount::track_order(order, fee)`: writes `order_fees[j] = fee` for the entry it fills.
- `FundedAccount::make_fee_due(j)`: `order_fees_due += order_fees[j]; order_fees[j] = 0` (checked).

Invariant: `order_fees[j] == 0` whenever `orders[j]` is free or a risk authority's close of a breached account
(`cancel_order` zeroes it, `sync` moves it to due, `close_completed_order` moves an executed order's to due and zeroes a
cancelled one's; the fuzzer checks it after every step).

### 4.2 `set_order_fee(fee_usdc: u64, fee_bps: u16)`: admin

Accounts: `AdminOnly` (admin signer, config mut with `has_one = admin @ Unauthorized`, event_authority, program).
`require!(fee_usdc <= MAX_ORDER_FEE_USDC && fee_bps <= MAX_ORDER_FEE_BPS, InvalidParams)`, writes both, emits
`ConfigChanged { change: OrderFee, subject: admin, .. }`. Not blocked by pauses. Applies to orders placed or updated
afterwards; fees already assessed do not change. `initialize` leaves both at 0.

### 4.3 Order paths

`max_fee: u64` is appended to `OpenPositionArgs`, `ClosePositionArgs`, `SetProtectionArgs` and `UpdateOrderArgs`: the
most the trader agrees to pay as the order's fee. For a close, take profit or stop loss that is its assessed maximum (the
rate on its size up to the account's exposure cap, §3), not the fee expected on what it will close, which the program
would refuse as too low; the field's IDL doc says so. Every order path refuses `fee > max_fee` with `OrderFeeChanged`: a
risk authority's close of a breached account has fee 0 and always passes, its close of any other account is checked
against the `max_fee` it sends (the keeper sends none: u64::MAX). The SDK defaults it to u64::MAX (no limit) for callers
that do not pass one yet (§7); the app must pass the fee the program will assess before the first nonzero rate (§9).

`open_position` (accounts unchanged). The existing `collateral ≤ owner_usdc.amount` check stays where it is; after
`check_increase`, before the CPI:

```rust
let fee = a.config.order_fee(args.size_delta_usd, u128::MAX)?;
require!(fee <= args.max_fee, VaultError::OrderFeeChanged);
if args.size_delta_usd > 0 {
    let held = a.funded.reserved_fees()?;
    let needed = args.collateral.checked_add(fee).and_then(|v| v.checked_add(held)).ok_or(VaultError::MathOverflow)?;
    require!(needed <= a.owner_usdc.amount, VaultError::CollateralExceedsBalance);
}
// CPI; f.track_order(.., fee); OrderRequested { .., fee, order_fee_usdc, order_fee_bps }
```

A collateral-only increase (size 0) is free and ignores held fees: adding margin is never limited by fees.

`close_position` / `set_protection` (`DecreaseOrder::place`, accounts unchanged, no balance check), after the existing
checks, before the CPI:

```rust
let free = placed_by_risk && self.funded.status == FundedStatus::Breached;
let fee = if free { 0 } else { self.config.order_fee(size, self.funded.terms.max_exposure_gm()?)? };
require!(fee <= max_fee, VaultError::OrderFeeChanged);
```

The keeper marks an account breached alone in its transaction and places breach closes only afterwards; the session
guard closes positions of active or restricted accounts (`server/src/modules/keeper/rules.ts`), so the status tells the
two apart. The rule is the status, not the keeper step: any risk close of a breached account is free (the session step
too, if it ever closes one). A breach close cannot fail on fee arithmetic (no fee is computed).

`update_order` gains one read-only account after `gmtrade_program` (Anchor puts it before `event_authority` /
`program`): `#[account(address = get_associated_token_address(&owner.key(), &config.usdc_mint))] pub owner_usdc:
Box<Account<'info, TokenAccount>>`. After the existing checks, before the CPI, every call (trigger-only too) re-assesses:

```rust
let size = args.size_delta_usd.unwrap_or(tracked.size_usd);
let cap = if increase { u128::MAX } else { a.funded.terms.max_exposure_gm()? };
let fee = a.config.order_fee(size, cap)?;
require!(fee <= args.max_fee, VaultError::OrderFeeChanged);
let old = a.funded.order_fees[idx];
if increase && fee > old {
    let held = a.funded.reserved_fees()?.checked_sub(old).and_then(|v| v.checked_add(fee)).ok_or(VaultError::MathOverflow)?;
    require!(held <= a.owner_usdc.amount, VaultError::CollateralExceedsBalance);
}
// CPI; f.order_fees[idx] = fee; OrderUpdated { .., fee, order_fee_usdc, order_fee_bps }
```

A lower fee never needs USDC. (Port: `take::<13>`; `token_account(owner_usdc)` in phase 1 after `gmtrade_program`'s program
check; the address constraint in phase 3 after `gmtrade_program`'s, before `check_event_authority`.) A closed account's
update is now refused at `owner_usdc` (its USDC account is gone) instead of at the status check.

`cancel_order`: where the entry is freed, `f.order_fees[idx] = 0`. Nothing charged, nothing moved.

### 4.4 Cranks

`sync`: every order it drops (account gone) has its fee made due (`make_fee_due`, after the orders loop). An order
finished but still open keeps its fee until `close_completed_order`, which reads the order's action state before its CPI
closes the account (`gmtrade::is_cancelled_order`, GMTrade `ActionState::Cancelled` = 2): an executed order's fee becomes
due, a cancelled one's is released (`order_fees[j] = 0`, as `cancel_order` does). Accounts unchanged.
`Synced.orders_dropped` names the orders made due; `CompletedOrderClosed` gains a trailing `cancelled: bool` (true: the
fee was released, false: it is due).

### 4.5 `settle_order_fees(charge: u64, waive: u64, expected_due: u64, expected_settlements: u64)`: risk authority

Accounts (10): risk_authority (signer); config (seeds, `is_risk_authority @ Unauthorized`, not writable: settlements never
contend with trading); funded (mut, seeds); owner (seeds, signs the transfer only); owner_usdc (mut, associated token of
owner and USDC); fee_vault (mut, seeds `fee_vault`); usdc_mint (address = config.usdc_mint); token_program;
event_authority; program.

```rust
require!(a.funded.is_open(), VaultError::InvalidAccountStatus);
let total = charge.checked_add(waive).ok_or(VaultError::MathOverflow)?;
require!(total > 0, VaultError::InvalidAmount);
require!(
    a.funded.order_fees_due == expected_due
        && a.funded.order_fee_settlements == expected_settlements
        && total <= expected_due
        && charge <= a.owner_usdc.amount,
    VaultError::InvalidFeeSettlement
);
// transfer_from_owner(owner_usdc -> fee_vault, signed by the owner PDA), nothing when charge == 0
// order_fees_due -= total; order_fees_paid += charge; order_fee_settlements += 1 (checked)
// OrderFeesSettled { funded, charged, waived, order_fees_due, order_fees_paid, by, ts }
```

`expected_due` makes a settlement stale once the fees due move; it cannot stop a replay on its own, since the fees due
return to an earlier value whenever the trader repeats an order size (audit 2: a re-sent settlement charged 1.2 USDC a
second time for an order the exchange had cancelled). The count only moves forward, so a settlement lands at most once.

Allowed in every open status (Active, Restricted, Breached, PayoutPending) and never paused: fees due come from orders
already placed. A closed account is refused: its USDC account is gone (`AccountNotInitialized`), and one a stranger
re-creates for the owner PDA hits `InvalidAccountStatus`. It lives in `risk.rs` in both builds (it reuses
`transfer_from_owner`; the port's event buffer is N = 120, set_identity's). What can fail a settlement computed from a
read: a sized open cannot (the hold keeps the fees due in the account's USDC), but a collateral-only open (it ignores held
fees) can move the balance below the charge, and a `sync` or `close_completed_order` anyone sends, or another
settlement, changes the fees due or the count. So settlements go in their own transaction and are recomputed from a
fresh read after an `InvalidFeeSettlement` (§9).

### 4.6 Payout and closure

`request_payout`, right after `require!(is_flat, NotFlat)`: `require!(order_fees_due == 0, FeesDue)`. Flat means no
tracked order and so no assessed fee: `profit = owner USDC − principal` is net of every fee charged.

`close_funded`, right after `require_flat`: `require!(order_fees_due == 0, FeesDue)`. With fees due the keeper sends
`[settle_order_fees(charge ≤ balance, waive = the rest, expected_due, expected_settlements), close_funded]` in one
transaction; with none it sends `close_funded` alone (a settlement of 0 + 0 fails `InvalidAmount`).

`approve_payout`: unchanged. While PayoutPending the account is flat with nothing due and nothing can add to it, so fees
cannot move owner USDC between the request and its approval.

### 4.7 Errors, events, discriminators

Errors, appended (neutral messages, no venue name):

| Number | Name | Message | Raised by |
|---|---|---|---|
| 6044 | `FeesDue` | Order fees are still being settled | `request_payout`, `close_funded` |
| 6045 | `InvalidFeeSettlement` | Fee settlement does not match the account's fees due, settlement count or USDC | `settle_order_fees` |
| 6046 | `OrderFeeChanged` | The order fee changed since it was reviewed | `open_position`, `close_position`, `set_protection`, `update_order` |

The hold reuses `CollateralExceedsBalance` (6019; "available" now means net of held fees); a zero settlement reuses
`InvalidAmount`; the caps of `set_order_fee` reuse `InvalidParams`.

Events:
- `OrderRequested`, `ProtectionSet`, `OrderUpdated`: trailing `fee: u64` (the order's fee after the call),
  `order_fee_usdc: u64` and `order_fee_bps: u16` (the `Config` rate that produced it), after `ts`. The indexer never
  needs `set_order_fee`'s instruction data (inside a Squads CPI after the handover) to know the rate of an order.
- New `OrderFeesSettled { funded, charged, waived, order_fees_due, order_fees_paid, by, ts }`, discriminator
  `[57, 230, 88, 28, 118, 63, 61, 145]`.
- `ConfigChange` gains `OrderFee` (index 8), emitted by `set_order_fee`; the new rate is `Config`'s.
- `CompletedOrderClosed` gains a trailing `cancelled: bool` (§4.4).
- `OrderCancelled`, `Synced` unchanged.

Instruction discriminators (sha256("global:<name>")[..8]): `set_order_fee` `[26, 144, 67, 211, 12, 199, 105, 228]`,
`settle_order_fees` `[57, 79, 11, 47, 59, 182, 94, 104]` (port `lib.rs` `disc` and `dispatch`; the host test checks both
and the event).

### 4.8 Unchanged

`initialize` and `set_params` (`ConfigParams` byte-identical), `set_pauses`, `upsert_tier`, `upsert_market`,
`deposit_capital`, `withdraw_capital`, `sweep_fees` (still moves the whole fee vault, evaluation and order fees, to the
capital vault), `withdraw_sol_treasury`, `buy_evaluation`, `activate_funded` (allocates the larger account),
`cancel_payout`, `set_identity`, `record_evaluation_result`, `approve_payout`, `reject_payout`, `restrict`,
`mark_breached`, `top_up_owner`, `close_empty_position`, `collect_claimable`. `Config.fees_collected` still counts
evaluation fees only.

### 4.9 Layout safety, sizes and costs

- Safe only because nothing is deployed on mainnet: `Config` +10 and `FundedAccount` +88 bytes (appended, so existing
  offsets hold and old decoders read the prefix), the four order-args structs +8 bytes each (a client built without
  `max_fee` now fails `InstructionDidNotDeserialize`), `settle_order_fees` takes four arguments, `update_order` +1
  account, events with trailing fields. No discriminator or error number changes. Deploy the server with the new
  `@props/sdk` IDL before the program.
- Rent (5,080 lamports per byte): +447,040 lamports per funded account (paid by the trader at `activate_funded`),
  +50,800 once for `Config`.
- Transactions: `max_fee` adds 8 bytes to each order instruction: open + TP + SL measured 1,153 of 1,232 bytes (v0,
  compute-limit instruction, no lookup table; 1,165 with a compute price), 24 more than before. `update_order` +41 bytes.
  Among order-fee paths only settlements write-lock the fee vault (`buy_evaluation` and `sweep_fees` also write it).
- Compute (Anchor → port, from `compare/fees.ts`): open with a fee 188k → 125k CU, update_order 67k → 31k (the new ATA
  check), settle_order_fees 48k → 15k, set_order_fee 16k → 2k.
- Binary: the port grew 172,536 → 181,672 bytes (180,800 before the audit fixes; +8,264 for settle_order_fees 2.7 KB,
  update_order +1.2 KB, open_position +0.7 KB, the rest in `place`, the events and set_order_fee; +872 for the audit
  fixes); program-data rent ≈ 0.924 SOL at the exact size (+≈ 0.046 SOL), ≈ 1.016 SOL with the runbook's 10 % headroom
  (+≈ 0.051 SOL). The Anchor build: 1,021,016 → 1,055,704 (1,053,744 before the audit fixes).
  The runbook's `<SO_SIZE>` / `<EXECUTABLE_HASH>` come from the new verifiable build.

## 5. Cases

| Case | What happens |
|---|---|
| Market open that executes | assessed and held at placement, due at `sync`, charged by the keeper |
| Market open the exchange cancels (slippage, expiry) | account closed: due at `sync`, waived; account left open: released by `close_completed_order` |
| Limit increase resting for days | assessed once and held (it only limits new exposure); trader cancel → released; update → re-assessed at the current rate (a higher fee must fit); fills → charged; refused by the exchange at its trigger → waived |
| Increase of an existing position | as an open; its TP/SL were assessed on the exposure cap, so the growth is covered |
| TP + SL (at most one executes) | both assessed on the exposure cap, neither held; the one that executes is charged the rate on the size it closed; the other is cancelled by the keeper (released) or by the exchange (released if left open, else waived) |
| Partial or full close | assessed on min(size, exposure cap), charged on the size executed |
| Decrease executed, not yet synced | its fee is neither due nor held: the proceeds can go into a new position before `sync` makes the fee due; the settlement then charges what the balance covers and the rest stays due (blocking payouts) until the trader closes something, or is waived if the account breaches (§9 valuation) |
| Decrease executed and synced | its whole assessment (a close-all: flat + bps of the exposure cap) is due and held against new exposure until the keeper settles it, which needs the executed size (§9 keeper: settle it within the tick) |
| Trigger-only edit of a TP/SL | re-assessed at the current rate (as the simulator's cancel-and-replace does) |
| Session-guard close by a risk authority (active or restricted account) | assessed like the trader's close (the trader held a position above the closed-session cap into the guard window); charged on the size it closed (§10 Q6) |
| Breach close by a risk authority (breached account) | fee 0 |
| Liquidation, auto-deleveraging | no order of ours, no fee; orphaned TP/SL released or waived |
| Stop loss the exchange refuses as insolvent before liquidating | cancelled by the exchange: released if left open, else waived |
| Collateral-only addition (size 0) | free, and not limited by held fees |
| Restricted account | closes, TP/SL and cancels as today, assessed as usual; no opens; settlement allowed |
| Breached account | trader orders that still execute are charged, cancelled ones released; breach closes free; closed after settlement |
| Trading or payouts paused | settlement and `set_order_fee` are not blocked; fees follow the orders pauses allow |
| Payout | at request: flat and `order_fees_due == 0`; profit is net of all fees charged |
| Closure | the keeper settles (charge up to the balance, waive the rest) and closes in one transaction |
| Rate change | applies to orders placed or updated afterwards, on every account (§10 Q5) |
| Rate raised between quote and signature | the order fails with `OrderFeeChanged`, a risk-reducing one too (a stop loss, its trigger edit, a close); the app re-quotes and resends (§10 Q8) |
| Rate set back to 0 | no new fees; fees already due still block payouts and closure until settled (§6.6) |
| Settlement re-sent (timeout, retry) | refused: the settlement count moved on, even if the fees due are back at the same value |
| SOL | no new account or rent per order; the risk authority pays settlement transaction fees; owner PDA floats untouched |

## 6. Guarantees and invariants

1. Program-enforced: a trader's order costs at most its `max_fee`; a settlement charges in total at most the assessed fees
   of orders that left the book other than through `cancel_order` (`charge + waive ≤ order_fees_due`), never for an order
   cancelled through the program or cancelled by the exchange and left open, never for a risk authority's close of a
   breached account, and only against the current `order_fees_due` and settlement count, once. Keeper policy (Props'
   settlement, checkable against the exchange's order records): only executed orders are charged, each at most the rate
   on its executed size. For an order whose account is gone the program cannot tell executed from exchange-cancelled, so
   a compromised risk key could charge up to the assessed fees of those orders (for a close-all TP/SL, the fee on the
   account's exposure cap); it can also place closes of active accounts, which are assessed (such a key can already
   close any position).
2. Fee money only ever leaves the account's USDC token account, never position collateral or an order escrow, and only
   in `settle_order_fees`. Closes, protective orders, cancels and collateral-only additions never need or move fee
   money, so fees cannot cause a liquidation. A trader's close, protective order or trigger edit does check its own fee
   against its `max_fee`: after a rate increase, one signed with the old quote fails (`OrderFeeChanged`) until the app
   re-quotes (§10 Q8).
3. `settle_order_fees` pays only the fee vault (PDA seeds), from only the account's own USDC (ATA of its owner PDA), at
   most the fees due and at most the balance, signed only by a risk authority. `waive` moves nothing.
4. Fees are costs: charged fees reduce owner USDC, so allowance, breach and payout profit include them; an order that
   adds exposure holds its fee from the start. Payout and closure need nothing due. `FundedAccount.order_fees_paid` and
   `OrderFeesSettled` give exact per-account and total order-fee revenue.
5. New invariant for ARCHITECTURE §3.2: "No instruction moves USDC out of an owner ATA except GMTrade order creation (to
   a GMTrade escrow), `settle_order_fees` (to the fee vault, at most the fees due), `approve_payout` (to the registered
   trader wallet + capital vault) and `close_funded` (to the capital vault)." (`tests/program` pins the IDL list.)
6. At rate 0 no new fee is assessed: the hold reduces to the existing collateral check and nothing new becomes due.
   Fees assessed before a switch to 0 still count as held or due until they are released, charged or waived, and fees
   due still block payouts and closure until settled: switching the rate off does not unblock them (a regression test
   pins it), which is why the rate stays 0 until the keeper settles (§9).

## 7. SDK (`packages/sdk`)

- IDL: `anchor build`, then `target/idl/props_vault.json` and `target/types/props_vault.ts` copied into `src/idl/` (done;
  the SDK test checks they equal the local build).
- `client.ts`: `setOrderFee({ admin, feeUsdc, feeBps })`; `settleOrderFees({ riskAuthority, funded, charge, waive,
  expectedDue, expectedSettlements })` (derives owner, owner USDC, fee vault; both expectations come from the same read
  of the account); `openPosition`, `closePosition`, `setProtection` and `updateOrder` take an optional `maxFee` (default
  u64::MAX: no limit, so existing callers keep working); `updateOrder` passes `ownerUsdc` itself. `maxFee` stays
  optional for now: making it required would break the other team's in-progress callers (`app/src/lib/chain.ts`, the
  keeper's forced close, server tests), which this change may not touch. The app passing it is a prerequisite of the
  first nonzero rate (§9); make it required once they do.
- `fees.ts`, one formula for the program's tests, the server's simulator and the app's ticket: `orderFee({ feeUsdc,
  feeBps }, sizeUsd, capUsd?)` (§3, integer math, rounding down; pass the account's exposure cap,
  ⌊sizeUsd × maxExposureBps / 10^4⌋ × 10^14 = the server's `maxExposureUsd`, as `capUsd` for a decrease),
  `reservedFees(due, [{ fee, isIncrease }])` over a plain list (for the demo engine, which has no FundedAccount) and
  `fundedReservedFees(account)`. `test/sdk.test.ts` pins the rounding; `fees.test.ts` checks the program against
  `orderFee`.

## 8. Tests, compare harness, fuzzers

`tests/program/src/fees.test.ts` (16 tests, both builds): `set_order_fee` (admin only, $2.000001 and 11 bps refused,
evented, works paused, 0 at initialize); `open_position` (rounding, `max_fee`, collateral + fee + held = balance passes
and one more unit fails, collateral-only free); decreases (sized close, close-all TP on the exposure cap, SL, `max_fee`,
no balance needed, a risk close of an active account assessed, decreases not held); both review probes; the exposure-cap
base under a raised, a lowered and a too-high market limit and on the 25K tier; the session guard (a risk close of an
active or restricted account assessed and bound by `max_fee`, still not cancellable by the trader; a breach close free);
`update_order` (limit resize past and within the balance, down with none, TP resize, trigger-only re-assessment after a
rate change, `max_fee`, event rate); `cancel_order` by trader and risk (released, nothing moved); `sync` and
`close_completed_order` (due; finished order keeps its fee; an executed order left open made due, a cancelled one
released, `cancelled` in the event); a liquidation with orphaned TP/SL (waived, only the open charged);
`settle_order_fees` (signers, 0 + 0, above the due, stale, another settlement count, over the balance, exact movement
and event, the count advancing, replay refused, waive-only with no token CPI; re-sent after the fees due return to the
same value: refused, nothing charged twice; fee vault = capital vault or a stranger's USDC → `ConstraintSeeds`, another
account's owner USDC → `ConstraintTokenOwner`, another owner → `ConstraintSeeds`, another program → `InvalidProgramId`;
restricted, breached and paused; closed account, also with a re-created USDC account); `request_payout` and
`close_funded` with fees due (`FeesDue`, also after the rate is set back to 0), the settled payout's profit net of the
charge, `[settle, close_funded]` with exact vault amounts; rate 0 round trip. The whole suite: 95/95 on each build (79
before the fee). `tests/program/src/invariants.test.ts` lists `settle_order_fees` among the owner-USDC outflows. The
two audits' own probes, rerun on the fixed binaries, show every program finding fixed on both builds.

`compare/fees.ts`: 139 records, 0 differences (every path above plus malformed data, missing accounts, read-only flags,
config/mint/event-authority substitutions, market limits below the position and above the cap, a risk close of an
active account above its `max_fee`, a breach close with an overflowing rate (free, so it goes through), an executed and
a cancelled order left open (also with the fees due at u64::MAX: the executed one overflows, the cancelled one is
released), every funded status, a replay with the fees due restored, and the checked-arithmetic limits: fees due, a
held fee, the rate, `order_fees_paid` and `order_fee_settlements` written near u64::MAX). The six other scenarios still
have 0 differences (admin 80, trader 204, risk 258, trading 290, crank 141, audit 172 records).

Fuzzers: `seqfuzz.ts` gains both instructions (in- and out-of-bound arguments, stale `expected_due`, a replayed or
future settlement count, every held signer, impersonation), a random `max_fee` on orders, a random starting rate in three
seeds of four, a keeper settlement before payout requests and most closures, the oracle (admin for `set_order_fee`, risk
authorities for `settle_order_fees`) and the rule that a settlement pays the fee vault exactly what the owner USDC lost.
`invariants.ts` gains the same actions and I9 (fee vault = evaluation fees + Σ charged since the last sweep over program
instructions only, Σ `order_fees_paid` = Σ charged, a settlement moves exactly `charged` out of the account), I10
(`order_fees[j] = 0` for free entries and for a risk authority's closes of breached accounts, whose `OrderRequested` fee
must be 0), I11 (`order_fees_due + Σ order_fees` moves only by the order, update, cancel, completed-order (`cancelled`)
and settlement events), and its keeper emulation leaves some orders cancelled and open. Before the audit fixes:
`FUZZ_QUICK=1` and seqfuzz seeds 6-45 / invariants seeds 2-21, 0 differences and 0 violations. After them: `FUZZ_QUICK=1`
and seqfuzz seeds 6-105 / invariants seeds 2-61 (33,267 transactions, 16,946 succeeded, 5.8 minutes), 0 differences, 0
violations; on invariants seeds 2-21 the fixed paths ran with the checks on (10 closes of exchange-cancelled orders, 18
of executed ones, 9 assessed risk closes of active or restricted accounts, 2 free breach closes). Both fuzzers' detector
self-tests (`SANITY=1`, `FUZZ_SELFTEST=1`) still fire. The hour-long campaign was not rerun.

Test environment note: this checkout's `node_modules` holds litesvm 0.8.0 (the package pins 1.4.1), which `Env`
refuses. The runs above used litesvm 1.4.1 through a scratch module-resolution hook; `npm install` restores it.

## 9. For the server, app, shared contract and docs (the other team, later)

Chain module and indexer:
- Take the new IDL from `@props/sdk` and deploy the server before the program. Decode `Config.orderFeeUsdc` /
  `orderFeeBps`, `FundedAccount.orderFees` / `orderFeesDue` / `orderFeesPaid` / `orderFeeSettlements`, the `fee` /
  `orderFeeUsdc` / `orderFeeBps` event fields, `CompletedOrderClosed.cancelled`, `OrderFeesSettled`,
  `ConfigChange.orderFee`.
- A per-order fee ledger: assessed (placement, update: fee and rate from the event) → released (`OrderCancelled`, or
  `CompletedOrderClosed` with `cancelled`) or due (`Synced.orders_dropped`, `CompletedOrderClosed` without it) → charged /
  waived (settlement), with the executed size. A session-guard close (a risk authority's `OrderRequested` on an account
  that is not breached) carries a fee like the trader's own close; a breach close carries none. Each order's
  Props fee is a pure function of (assessed fee, rate in its latest assessment, executed size from
  `venue_fills.order` / `size_usd`), so the trade view shows it at fill time on both stages and settlement only
  reconciles.
- `/v1/config`: the rate (`orderFee: { usdc, bps }` in place of the reserved `orderFeeBps?`), refreshed on a
  `ConfigChanged` `OrderFee`. `/v1/quote`: `platformFeeUsd` (the open's fee) and a close fee assessed on the existing
  position plus the new size (and its maximum on the account's exposure cap); `roundTripFeeUsd` includes both, on both
  stages.
- Funded valuation: the one valuation used by the keeper's breach check, the account summary (equity,
  allowanceRemaining, realized, eligiblePayout) and payout review subtracts exactly Σ over executed orders of
  min(assessed, rate × executed size) minus what has been charged, computed from order outcomes whether or not `sync`
  has made the fee due yet. It never subtracts fees of cancelled orders or orders whose outcome is unknown. Available
  margin for new exposure = owner USDC − `orderFeesDue` − the fees of pending increase orders (`fundedReservedFees`),
  and the new order's own fee must fit in it (the program's rule). Two windows where the program's hold differs from
  what is owed (audit 1, both builds; documented, not changed, since holding decrease fees would lock two maximums per
  TP/SL pair out of every account's buying power):
  - Between an executed decrease and the `sync` that makes its fee due, the fee is neither due nor held, so the
    proceeds can go into a new position. The valuation subtracts it from the fill, as above. If the USDC is committed
    by the time the keeper settles, the settlement charges what the balance covers and the rest stays due, blocking
    payouts until the trader closes something, or is waived if the account breaches. Syncing every tick keeps the
    window short.
  - From that `sync` until the keeper settles, the decrease's whole assessment is in `orderFeesDue` and held against
    new exposure: for a close-all, flat + bps of the exposure cap ($12 at the caps on a 10K account, where a $1,000
    close owes $3), and likewise the fee of an exchange-cancelled order whose account is gone. An open that fits the
    real fee is refused (`CollateralExceedsBalance`) meanwhile. The keeper's immediate waive (below) keeps this to the
    tick. Demo has neither window.

Keeper (settlement policy, the exact-charging half of the design):
- Sources: `gm_orders.status` (executed / cancelled) and `venue_fills.order` / `size_usd` (executed size), joined on the
  order address. Per account with fees due and known outcomes: an executed order owes `min(assessed, rate at its latest
  assessment × executed size)`; `charge` = what executed orders owe and has not been charged, capped at owner USDC (the
  rest stays due for a later tick); `waive` = every non-executed order's fee plus assessed − owed of every executed one;
  `expected_due` / `expected_settlements` = the `orderFeesDue` / `orderFeeSettlements` of that same read.
- Waive at once what cannot be owed, without waiting for the order records (they lag about 35 s): the n decrease
  orders of a slot that finished between two syncs closed together at most that slot's committed size at the earlier
  sync (`Synced.slots`: size + pending) minus its size at the later one (a liquidation in between only widens the
  bound), so they owe at most n × flat + bps × that; waive the rest of their assessments in that tick and charge the
  owed part when the records confirm the executed sizes. Session-guard closes are charged like the trader's decreases;
  breach closes have nothing due.
- Idempotent per order: write the per-order charged / waived rows in the same database transaction that records the
  settlement signature, derive charge and waive only from orders settled for the first time, and check the rows against
  the chain (`orderFeesPaid`, `orderFeesDue`, `orderFeeSettlements`) on startup. A replay fails onchain: every
  settlement advances `orderFeeSettlements`, which the next one must name.
- Send settlements in their own transaction: a `sync` or `close_completed_order` anyone sends, a collateral-only open (it
  can move the balance below the charge) or another settlement landing between the read and the settlement fails it.
  After an `InvalidFeeSettlement`, recompute from a fresh read on the next tick.
- Settle known outcomes before evaluating breaches in the same tick.
- Never charge an order whose outcome is unknown; alert when one is still unknown after 10 minutes (the order records lag
  about 35 s); waive it after a stated limit (24 h suggested, §10 Q7), or at once when the trader is flat and asks for a
  payout, so a payout is never blocked indefinitely. Runbook the alert that fires it.
- Closure: `[settle_order_fees(charge ≤ balance, waive the rest, expected_due, expected_settlements), close_funded]`,
  the settlement only when `orderFeesDue > 0` (today's `closure` step in `rules.ts` sends `close_funded` alone, which
  fails `FeesDue` once any fee is due).
- Payout review: the program refuses a request with fees due; the reconciliation subtracts Props fees charged since the
  last payout.
- Label `Config.feesCollected` as evaluation fees; report order fees from `orderFeesPaid` / `OrderFeesSettled`.
- Alert on failed settlements and on fees due for longer than N minutes.

Simulator (practice and evaluation; parity with funded):
- Rate: `Config`'s, the same numbers as funded; before the program is live, 0 or a server setting the owner picks (§10 Q3).
- Assess with the SDK's `orderFee` and §3's caps (a decrease: the evaluation's exposure cap); the session guard's closes
  are assessed like the trader's (parity with funded); the breach auto-close, liquidations and collateral-only orders:
  0. Store the assessed fee and the rate at assessment on each sim order (two columns).
- Parity with the instruction the app sends on funded:

| Ticket action | Funded instruction | Fee |
|---|---|---|
| place | open_position / close_position / set_protection | assessed |
| trigger-only edit | update_order | re-assessed at the current rate |
| resize | update_order | re-assessed |
| replace (cancel + place) | cancel_order + placement | released, then assessed |
| cancel | cancel_order | released |

- Available margin for an order that adds exposure subtracts the fees of pending increase orders, the fees due (none on
  demo) and the order's own fee (`reservedFees` over a plain list).
- At a fill: realized P&L −= min(assessed, rate × executed size), recorded as the fill's Props fee (like the exchange's
  order fee); nothing for orders that do not fill.
- `sim_fills` and `closed_trades` carry the Props fee; trades-root leaves include it (no evaluation result is onchain yet,
  so the leaf format can change now); targets, floors and equity include it through realized P&L.

App:
- Ticket: a Props fee row ("charged only if the order executes"), each TP/SL leg with its expected fee and its maximum
  ("only the one that executes is charged, on the size it closes"), buying power and maximum margin net of held fees and
  the order's fee. Pass every order builder `maxFee` = the fee the program will assess, computed with the SDK's
  `orderFee` from the rate read (for a close, take profit or stop loss: with the account's exposure cap as `capUsd`,
  the server's `maxExposureUsd`, i.e. its maximum, not the expected fee, which the program would refuse as too low),
  including the trigger-only `updateOrder` of a TP/SL edit; re-quote on `OrderFeeChanged`, and resend a risk-reducing
  order (close, stop loss, TP/SL edit) at once (§10 Q8).
- The fallback in `Trading.jsx` (`sizeNum * propsFeeBps / 10_000`) ignores the flat part: call the SDK `orderFee` with
  `usdToGm(size)` instead.
- Copy sweep: the ticket's "charges no fee per order" note, the "No Props.trade fee per order" tooltip, the rules modal
  (the current rate, on both stages) and the Costs row in `docs/ARCHITECTURE.md` §1.
- Orders: each pending order's fee; trades: the Props fee per trade; account: fees due, paid and held; payouts:
  "Settling order fees" while flat with fees due. On demo, the simulated-fee line (§1). No venue name in copy.

Shared contract (`packages/shared/src/api.ts`): the rate in `AppConfig`, `platformFeeUsd` and the close fee in the quote,
per-order fee and status, per-trade Props fee, per-account fees due / paid / held.

`docs/ARCHITECTURE.md`: §1 Costs row (Props now charges per order; demo simulated), §3.1 fields, §3.2 the two
instructions and invariant 5 of §6, the events list, §4.5 the keeper settlement step, §8 notes.

Referrals: rewards from Props' order fee accrue only from USDC actually charged on funded accounts (`OrderFeesSettled`,
attributed per order by the keeper's ledger); never from simulated demo fees, and never from assessed, released or
waived amounts. Demo fills pay no referral reward. Today's accrual (the exchange's fee on funded fills,
`accrueReferralReward` from `modules/chain/venue.ts`) is unaffected.

Before the first nonzero rate (not for deploying at rate 0). Once any fee is due, the program refuses every payout
request and every closure until a risk authority settles it, and setting the rate back to 0 does not clear fees already
due (§6.6, audit 1). So `set_order_fee` above 0 waits for all of these:
1. Keeper settlement live (the keeper part above), including the closure bundle `[settle_order_fees, close_funded]` and
   a settlement before payout requests; today nothing in `server/` or `scripts/` sends `settle_order_fees`.
2. A risk-key fallback for when the keeper is down: `scripts/admin/settle-order-fees.ts` (reads the account, names both
   expectations, `--print-for`), and a runbook entry for it.
3. The app passing `maxFee` on every order builder (§9 App); until then the trader promise in §1 does not hold (the SDK
   default is no limit, §7).
4. The funded valuation (above), so breach checks, the account summary and payout reviews count the fees.
5. Published terms that include the fee: a new tier version and terms hash through `upsert_tier` (the rules JSON that
   `scripts/admin/upsert-tiers.ts` hashes names the rate), and the ticket's "charges no fee per order" note in
   `app/src/Trading.jsx` changed with the copy sweep. The program does not tie the rate to the terms a trader bought:
   `Terms.terms_hash` does not change when `set_order_fee` runs.
6. The §10 Q5 decision for accounts bought before the change.
7. The admin tooling: `scripts/admin/set-order-fee.ts` (with `--print-for`, both values named), the rate in
   `scripts/admin/status.ts` (and `fees_collected` labelled evaluation fees), a runbook step for setting the rate, and
   `fees` added to the runbook §3.3 compare loop (`for s in admin trader risk trading crank audit`).

## 10. Open questions for the owner

1. The rate: flat per order, bps of size, or both (0 until `set_order_fee`).
2. The caps, now $2 per order and 10 bps (0.1 %). At the draft's $5 + 50 bps a full-size round trip on the 10K tier
   ($10,000 exposure, $500 principal) cost $110, 22 % of the loss allowance; at $2 + 10 bps it costs $24, 4.8 %. A
   mistyped rate or a compromised admin key can reach at most the caps, and raising them needs a program upgrade.
3. Demo accounts: the fee is simulated only (no USDC, no revenue, no referral reward); confirm. Charge it from a server
   setting before the program is live, or start when the onchain rate is set?
4. Referrals: pay referrers a share of Props' charged order fees (exact per executed order here) instead of, or as well
   as, the exchange's fee?
5. Before the first nonzero rate: a rate change applies to every account's next orders, including evaluations already
   bought and funded accounts already active (it makes a running evaluation's target harder), and nothing onchain ties
   the rate to the terms a trader bought. Keep it global (as built), or pin the rate per account at purchase (a `Terms`
   snapshot: a program change)? Whatever is chosen must be identical on both stages.
6. Session-guard closes: charged like the trader's own close since the audit round, applying the owner's decision that
   every order is charged. The first draft kept them free because "the program cannot tell them from breach closes"; it
   can (the account's status, §4.3), and free guard closes let a trader holding an over-levered position into the guard
   window exit without the close fee, every session, on demo too. Breach closes stay free: the account's USDC all
   returns to the capital vault, so a fee would only move Props' capital into the fee vault (and into referral
   rewards). Keep, or make guard closes free again (one condition in each build)?
7. The keeper's fallback: waive an order whose outcome is still unknown after 24 h?
8. Risk-reducing orders under a raised rate: a stop loss, its trigger edit or a close signed with the old quote fails
   (`OrderFeeChanged`) until the app re-quotes. Keep (the app resends at once), or let decreases accept the higher fee
   (a program change: `max_fee` would then bind increases only)?

## 11. Reviews applied (2026-09-26)

Security review: flat part charged on every trader decrease; decreases assessed on the position limit (the exposure cap
since the audits) and re-assessed on every update (probes 1 and 2 are tests); `max_fee` + `OrderFeeChanged`; the rate in
every assessment event; referral rule; strict settlement kept, bundling advice dropped except closure with fees due; program-enforced guarantees separated
from keeper policy, keeper idempotency; caps lowered to $2 / 10 bps with the arithmetic in §10; §6.6 and §4.9 wording,
session-guard gap, keeper liveness, `fees_collected` label; the missing settlement tests; I9 over program instructions
only; scratch litesvm 1.4.1 and a fresh `anchor build` reference (hashes in every suite's `props_vault binary:` line).

Product review: demo fees stated as simulated (§1, trader copy, §9, §10 Q3); `expected_due` compare-and-set and
per-order keeper rows; funded valuation for breaches (§9); one hold rule (pending increase fees + fees due) with
`reservedFees` over a plain list; `max_fee`; the rate-pinning decision moved before the first nonzero rate (§10 Q5); the
keeper's bounded fallback; the demo/funded parity table; the quote, fallback and copy sweep; an owner for the admin
tooling; the keeper's source tables and the buying-power gap.

Audits 1 and 2 (2026-09-26), each reproduced on both builds before the fix and fixed identically in both:
- Program: a settlement lands once (`order_fee_settlements` + `expected_settlements`: a re-sent settlement went through
  again when the fees due returned to the same value); a decrease is assessed on the account's exposure cap instead of
  the market's position limit (a lowered limit under-assessed closes, a raised one left resting take profits
  under-assessed, a limit above a small tier over-assessed it); a risk authority's close of an active or restricted
  account (the session guard) is assessed like the trader's, a breach close stays free; `close_completed_order` releases
  the fee of an order the exchange cancelled and left open (`CompletedOrderClosed.cancelled`). Regression tests in
  `fees.test.ts` and `compare/fees.ts`.
- Design corrections: the gate before the first nonzero rate (§9); decreases do check `max_fee` (§6.2, §10 Q8); what can
  fail a settlement (§4.5, §9); the hold's two windows around executed decreases (§5, §9) with the keeper's immediate
  waive; the `max_fee` field docs name a decrease's maximum.
- Not changed: the SDK's optional `maxFee` (§7: required once the app passes it; confirmed by both audits, it is item 3
  of the gate). Verified without a defect: no refund of an executed order, the rate across Config tail moves, no
  re-entry, account substitutions and arithmetic limits, 0 differences between the builds.
