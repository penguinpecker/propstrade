# Exchange round-trip probe

`exchange-roundtrip.ts` answers one question with real money and without deploying `props_vault`: does the exchange
execute an order built exactly the way our program builds it, and pay the proceeds back to the owner?

It trades from a plain wallet (the probe key) and builds every instruction the way `programs/props_vault/src/gmtrade.rs`
does for the owner PDA (`CreateOrderCpi::invoke`, `CloseOrderCpi::invoke`, `close_empty_position`): the escrow
`ATA(order, USDC)` created idempotently, `prepare_user` and `prepare_position` on every increase (the exchange creates a
missing user account and validates an existing one), `create_order_v2` with owner = receiver = the wallet, USDC as
collateral / output / long / short token, that one escrow for all four, no swap, no callbacks, execution fee
300,000 lamports, and the order address from the nonce rule `next_order_nonce` (the order counter as 8 little-endian
bytes padded to 32). Instruction data is encoded by anchor's `BorshCoder` from the exchange's own IDL
(`packages/gmtrade/idl/gmsol_store-0.10.0.json`); accounts and events are decoded with `@props/gmtrade`.

Before any order the probe checks the on-chain Market the way the program's `check_pure_usdc_market` does (store, market
token, long and short token both USDC) and refuses otherwise; the keeper API's "pure" flag is not trusted for it.

## What it proves

- The exchange accepts an order shaped like ours from a wallet owner: the instructions encode, every account resolves,
  and the order is created with the owner, receiver, kind, size, collateral and escrow we expect.
- Its keepers execute all four kinds the program places (`open`: MarketIncrease; `tp`: LimitDecrease at a trigger
  above entry; `sl`: StopLossDecrease at a trigger below entry; `close`: MarketDecrease), which keeper did it, how many
  seconds after ours, at what execution price, and what it charged (order fee, borrowing, funding, price impact) from
  the `TradeEvent` of the executing transaction.
- The proceeds come back to the owner's USDC account: the balance deltas before and after, with SOL (fees and rent)
  separated from USDC.
- `cancel-all` (our `cancel_order` path: `close_order_v2` by the owner) refunds the escrow, the order rent and the
  unspent execution fee; `close-position` (our `close_empty_position` path) refunds a flat position's rent and
  liquidation reserve.

### How an outcome is read

The probe never infers a fill from the position or the balances (the keeper's execution changes both in the same
transaction that removes the order, and a keeper that tried and failed also removes it). After an order leaves
`Pending` it finds the transaction that removed it and decodes the exchange's CPI events:

- `OrderRemoved` carries the final state and the reason. `Completed` with a `TradeEvent` is a fill, and only that is
  recorded as one. `Cancelled` (the keeper tried and failed: pool cap, price, a racing order) throws with the reason,
  the transaction and the keeper; the collateral and rent are back in the wallet. A removal with no `TradeEvent` is
  never counted as executed.
- An order still `Pending` after the wait is left in place: `status` re-polls it, `cancel-all` refunds it, exit code 2.
- `cancel-all` prints the `OrderRemoved` event of its own transaction, so the decoder runs on every live cancel too.

## What it does not prove

- Anything about `props_vault` itself: no program is deployed, no PDA signs. The program's owner is a data-less PDA; the
  exchange checks "owner signed and matches the stored owner" for both (learnings.txt section 3), but the PDA path is
  only shown on mainnet by Flipper's transactions until our own smoke test (runbook §9).
- Liquidation and ADL execution (nobody but the exchange places those).
- Anything with a swap, a non-USDC market, callbacks or a referrer: the program never uses them, neither does the probe.
- Behaviour when a market is closed or a pool is full: the probe refuses to run then (it says exactly why).

## Funding

Send to the probe public key **`2KYXt6KND4S6UmbJcD3PGFUV1YFhrCWHtNfSps8iRQxt`**: **5 USDC and 0.05 SOL**.

- USDC: 2 USDC is the collateral per default run; the rest covers fees (about 0.02 USDC per $20 fill) and lets the
  round trip be repeated. Nothing but the exchange's fees and the price move is at risk.
- SOL: an open takes about 0.0374 SOL up front (order rent 0.0132, escrow 0.0015, execution fee 0.0003, the same
  again as the position's liquidation reserve, user account 0.0033, position 0.0041) plus transaction fees. The order
  rent and escrow come back when the order executes or is cancelled. The 300,000-lamport execution fee is paid to the
  keeper only on execution; an owner cancel refunds it with the rent. The user account rent (0.0033) never comes back
  (the exchange has no close for it). The position rent and reserve (about 0.019) come back with `STEP=close-position`
  once the position is flat (the program's keeper never sends `close_empty_position`; learnings "Keeper never sends
  close_empty_position").

On 2026-10-05 the key held 0.0400 SOL and 1.456 USDC: short by 0.544 USDC for one run.

## Commands

From the repo root, `node` 22 (the repo runs `.ts` directly; `npx tsx` works too). `RPC_URL`, `PROBE_KEYPAIR` and
`DRY_RUN` are required; the key file is loaded at runtime by path and never printed.

```sh
export RPC_URL=https://api.mainnet-beta.solana.com      # or the Alchemy URL
export PROBE_KEYPAIR=$HOME/.config/props-trade/probe.json
export MARKET=SOL            # a launch market with a pure USDC-USDC pool: SOL, BTC, ETH, XAU (default SOL)
export SIZE_USD=20           # position size (default 20)
export COLLATERAL_USDC=2     # collateral (default 2; 10x)
export TP_BPS=10             # take-profit trigger = entry × (1 + 10 bps) (default 10)
export SL_BPS=10             # stop-loss trigger = entry × (1 − 10 bps) (default 10); SL_BPS=-10 puts a long's stop above entry (above the mark right after the fill): it fills at once

STEP=status         DRY_RUN=1 node scripts/probe/exchange-roundtrip.ts   # read-only: market, balances, positions, orders, P&L so far
STEP=open           DRY_RUN=1 node scripts/probe/exchange-roundtrip.ts   # build + simulate the open, print the decoded instructions; sends nothing
STEP=open           DRY_RUN=0 node scripts/probe/exchange-roundtrip.ts   # LIVE: MarketIncrease long, wait ≤120 s for the keeper
STEP=tp             DRY_RUN=0 node scripts/probe/exchange-roundtrip.ts   # LIVE: LimitDecrease close-all at entry × (1 + TP_BPS); 'resting' after 120 s, exit 0
STEP=sl             DRY_RUN=0 node scripts/probe/exchange-roundtrip.ts   # LIVE: StopLossDecrease close-all at entry × (1 − SL_BPS); 'resting' after 120 s, exit 0
STEP=close          DRY_RUN=0 node scripts/probe/exchange-roundtrip.ts   # LIVE: cancel the market's resting decreases (tp/sl), then MarketDecrease close-all, wait until flat
STEP=cancel-all     DRY_RUN=0 node scripts/probe/exchange-roundtrip.ts   # LIVE: close every order of the wallet on MARKET (refunds escrow, rent, execution fee)
STEP=close-position DRY_RUN=0 node scripts/probe/exchange-roundtrip.ts   # LIVE: close_empty_position of the flat position on MARKET (refunds its rent + reserve)
STEP=all            DRY_RUN=0 node scripts/probe/exchange-roundtrip.ts   # LIVE: open → sl (60 s) → tp (≤10 min, polls every 5 s) → close → cancel leftovers → status + summary
```

Every step also runs with `DRY_RUN=1`: it builds the transaction, prints the decoded instructions and the simulation
logs, and sends nothing (`tp`, `sl`, `close` and `close-position` need the position to exist to simulate).

Exit codes: 0 done (also for a resting `tp` / `sl`); 2 an order was created but the keeper has not executed it within
the wait (it stays in place: `status` re-polls, `cancel-all` refunds); 1 a prerequisite is missing, a transaction
failed (nothing is sent after a failed simulation), or the exchange cancelled the order (collateral and rent are back).

`PROBE_STATE` (default `~/.cache/props-probe/<pubkey>.json`) holds the order counter, the balances before the first
live step (the P&L baseline) and each fill's event data. Delete it to start the P&L from scratch; the counter restarts
at 0 and skips an order address that still exists. Executed and cancelled orders are closed accounts, so their
addresses get reused then (the exchange does not mind); the program's monotonic counter never reuses one.

## Safety

- `DRY_RUN` must be exactly `1` (build and simulate only: prints what is missing, the decoded instructions and the
  simulation logs, never sends) or exactly `0` (live); anything else (`true`, `yes`, unset) is refused before anything
  runs. Live, the script still refuses when the side has no capacity or the balances are short, simulates every
  transaction first, sends with preflight on and waits for `confirmed`.
- The key file is read from `PROBE_KEYPAIR` with `Keypair.fromSecretKey`; neither the file nor its parse error is
  printed. Use the probe key only; never the operator or program key.
- Amounts are the defaults above unless changed; a $20 position with 2 USDC collateral risks the collateral at most
  (positions carry no debt), plus about 0.0033 SOL of rent that never returns.
- A take-profit or stop-loss that did not trigger is a resting order aimed at the wallet's next position on that market
  (learnings section 3). `close` cancels the market's resting decreases before it places the market close, so two
  closes can never race; after a manual `tp` / `sl` run `close` or `cancel-all`.
- A keeper cancellation is reported as one (reason, transaction, keeper), never as a fill; nothing is recorded in the
  state file for it.
- The empty position account keeps about 0.019 SOL until `STEP=close-position` is run.
- Pools fill up: on 2026-10-05 SOL, ETH and XAU had no long capacity on mainnet and BTC had $4k–$174k; the probe checks
  the side's capacity at run time and refuses when there is none.

## Rehearsal record (2026-10-05)

Local validator (`tests/program/src/validator.ts`: the mainnet exchange binary, the committed Store / market / mint
snapshots plus the markets' cloned dependencies, a throwaway key generated in scratch, 2 SOL from the faucet, 50 USDC
seeded at genesis, and two Position accounts seeded for the key from mainnet fixtures with owner, market token and PDA
bump patched: an open BTC long of $148,685 and a flat ETH position). Every step below ran against the real binary; the
driver asserted the results on chain.

- `DRY_RUN=yes` is refused before anything runs (exit 1).
- `DRY_RUN=0 STEP=open` on SOL (no position): `prepare_user`, `prepare_position`, `create_order_v2` (4 instructions,
  818 bytes, 96,488 CU) created order counter 0; the Order account decoded with owner = receiver = rent receiver = the
  wallet, Pending, MarketIncrease, long, $20, 2 USDC USDC collateral, min output 0, execution fee 300,000 lamports,
  initial-collateral / long / short escrow = `ATA(order, USDC)` (no final-output escrow on an increase), the escrow held
  the 2 USDC, the wallet paid exactly 2 USDC, the user account existed. No keeper runs locally: "not executed yet" after
  the 120 s wait, exit 2.
- `STEP=status` listed the pending order and all three positions (the seeded BTC long with its $85,239.65 entry, the
  flat ETH one, the empty SOL one the open prepared).
- Against the seeded BTC long, `DRY_RUN=1`: `tp` built a LimitDecrease at entry + 10 bps, `sl` a StopLossDecrease at
  entry − 10 bps, `sl` with `SL_BPS=-10` one at entry + 10 bps, `close` a MarketDecrease at mark − 0.5 %; each was
  2 instructions (escrow + `create_order_v2`, no `prepare_*`), 698 bytes, and simulated successfully (64,422 CU).
- `DRY_RUN=0 STEP=cancel-all` closed the order and the escrow; its own transaction's `OrderRemoved` decoded as state
  Pending, reason "cancel"; 2 USDC and 0.02043 SOL (order rent, escrow rent, execution fee, less the fee) came back;
  the wallet was back at 50 USDC.
- `STEP=close-position` on BTC refused the open position ("not empty"); on ETH it simulated (2,628 CU) and then ran
  live: the account closed and 26,053,960 of its 26,058,960 lamports came back (the rest was the transaction fee).
- Mainnet, `DRY_RUN=1 STEP=open MARKET=BTC` with the real probe key path (0.0400 SOL, 1.456 USDC): market state
  read through the catalog helpers (pool $1.09M, capacity long $174k), the on-chain purity check passed, the
  prerequisite check named the shortfall (0.544 USDC), the four instructions decoded from the IDL, and the simulation
  ran `CreateIdempotent`, `PrepareUser` (8,061 CU) and `PreparePosition` (18,213 CU) before `CreateOrderV2` failed at
  the collateral `TransferChecked` ("insufficient funds"), i.e. exactly at the balance check. Nothing was sent and no
  state file was written.
