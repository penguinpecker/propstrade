//! Port of programs/props_vault/src/instructions/trading.rs (see PORTING.md). Each handler validates in Anchor's order:
//! account types in field order, then the remaining constraints in field order, then the handler body. Every GMTrade
//! CPI goes through the `gmtrade` helpers, which refuse any program but GMTrade before the owner PDA signs; the owner
//! PDA is the order's owner and receiver, and the order nonce comes from `FundedAccount::order_seq`.
use pinocchio::{AccountView, Address};

use crate::{
    accounts::{
        associated_token_constraint, ata_address, check_event_authority, keys_eq, mint_account, mutable, now,
        program_account, seeds, signer, singleton, system_account, take, token_account, Args, ATA_PROGRAM_ID,
        CONFIG_PDA, GMTRADE_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
    },
    error::{require, Result, E},
    events::{disc, emit, event},
    gmtrade::{self, order_params, CloseOrder, CreateOrder},
    state::{
        funded_status, load, order_type, to_gm_usd, Config, FundedAccount, MarketConfig, Slot, TrackedOrder, BPS,
        FUNDED_SEED, MARKET_SEED, MAX_ORDERS, OWNER_SEED,
    },
};

/// Event buffer size for every event of this file and crank.rs: 16 + the largest body, Synced's (funded 32, 8 slot
/// snapshots of 73 bytes and 8 dropped orders, each list with its u32 length, ts 8 = 888). One `N` for both files
/// saves the per-`N` copies of the writer (PORTING.md "Size notes").
pub(crate) const EV: usize = 904;

/// `seeds = [FUNDED_SEED, funded.evaluation.as_ref()], bump = funded.bump`.
pub(crate) fn funded_seeds(funded: &AccountView, f: &FundedAccount) -> Result {
    seeds(funded, &[FUNDED_SEED, f.evaluation.as_ref(), &[f.bump]])
}

/// `seeds = [OWNER_SEED, funded.key().as_ref()], bump = funded.owner_bump`.
pub(crate) fn owner_seeds(owner: &AccountView, funded: &AccountView, f: &FundedAccount) -> Result {
    seeds(owner, &[OWNER_SEED, funded.address().as_ref(), &[f.owner_bump]])
}

/// `seeds = [MARKET_SEED, market_config.market_token.as_ref()], bump = market_config.bump`.
fn market_seeds(market_config: &AccountView, m: &MarketConfig) -> Result {
    seeds(market_config, &[MARKET_SEED, m.market_token.as_ref(), &[m.bump]])
}

/// Phase 1 of the four programs every GMTrade-order struct ends with: `Program<GmsolStore>`, `Program<Token>`,
/// `Program<AssociatedToken>`, `Program<System>`.
pub(crate) fn order_programs(
    gmtrade: &AccountView,
    token: &AccountView,
    ata: &AccountView,
    system: &AccountView,
) -> Result {
    program_account(gmtrade, &GMTRADE_PROGRAM_ID)?;
    program_account(token, &TOKEN_PROGRAM_ID)?;
    program_account(ata, &ATA_PROGRAM_ID)?;
    program_account(system, &SYSTEM_PROGRAM_ID)
}

/// Phase 3 of `OpenPosition` / `DecreaseOrder` from `usdc_mint` on: usdc_mint (address = config.usdc_mint), gm_store
/// (address), gm_market (mut, address = market_config.gm_market @ MarketMismatch), gm_user, gm_position, gm_order
/// (mut), order_escrow (mut, address = ATA(gm_order, USDC)), gmtrade_program (address), event_authority.
fn check_create_order(o: &CreateOrder, c: &Config, m: &MarketConfig, event_authority: &AccountView) -> Result {
    keys_eq(o.usdc_mint.address(), &c.usdc_mint, E::ConstraintAddress)?;
    keys_eq(o.store.address(), &c.gmtrade_store, E::ConstraintAddress)?;
    mutable(o.market)?;
    keys_eq(o.market.address(), &m.gm_market, E::MarketMismatch)?;
    mutable(o.user)?;
    mutable(o.position)?;
    mutable(o.order)?;
    mutable(o.escrow)?;
    keys_eq(o.escrow.address(), &ata_address(o.order.address(), o.usdc_mint.address()), E::ConstraintAddress)?;
    keys_eq(o.program.address(), &c.gmtrade_program, E::ConstraintAddress)?;
    check_event_authority(event_authority)
}

/// Phase 3 of `CancelOrder` / `CloseCompletedOrder` from `usdc_mint` on: usdc_mint (address), gm_store (mut, address),
/// gm_store_wallet, gm_user, gm_order (mut), order_escrow (mut, address = ATA(gm_order, USDC)), gmtrade_program
/// (address), event_authority.
pub(crate) fn check_close_order(o: &CloseOrder, c: &Config, event_authority: &AccountView) -> Result {
    keys_eq(o.usdc_mint.address(), &c.usdc_mint, E::ConstraintAddress)?;
    mutable(o.store)?;
    keys_eq(o.store.address(), &c.gmtrade_store, E::ConstraintAddress)?;
    mutable(o.store_wallet)?;
    mutable(o.user)?;
    mutable(o.order)?;
    mutable(o.escrow)?;
    keys_eq(o.escrow.address(), &ata_address(o.order.address(), o.usdc_mint.address()), E::ConstraintAddress)?;
    keys_eq(o.program.address(), &c.gmtrade_program, E::ConstraintAddress)?;
    check_event_authority(event_authority)
}

fn tracked(order: &Address, slot: usize, kind: u8, size: u128, collateral: u64, placed_by_risk: bool) -> TrackedOrder {
    let mut t = TrackedOrder { order: *order, slot: slot as u8, order_type: kind, ..TrackedOrder::default() };
    t.size_usd.set(size);
    t.collateral.set(collateral);
    t.placed_by_risk.set(placed_by_risk);
    t
}

/// Account and market limits for adding `size` (GMTrade USD, backed by `collateral` USDC) to `slot`, where `replaced`
/// is the size of a pending order being resized (0 for a new order).
fn check_increase(
    f: &FundedAccount,
    slot: &Slot,
    m: &MarketConfig,
    is_long: bool,
    size: u128,
    collateral: u64,
    replaced: u128,
) -> Result {
    // Leverage = size / collateral, with USDC collateral valued at 1 USD.
    let lhs = size.checked_mul(BPS as u128).ok_or(E::MathOverflow)?;
    let rhs = to_gm_usd(collateral)?.checked_mul(m.max_leverage_bps.get() as u128).ok_or(E::MathOverflow)?;
    require(lhs <= rhs, E::LeverageTooHigh)?;

    let with = |current: u128| current.checked_sub(replaced).and_then(|v| v.checked_add(size)).ok_or(E::MathOverflow);
    require(with(slot.committed()?)? <= to_gm_usd(m.max_position_usd.get())?, E::PositionTooLarge)?;
    require(with(f.committed_exposure()?)? <= f.terms.max_exposure_gm()?, E::ExposureTooHigh)?;
    require(with(m.oi(is_long))? <= to_gm_usd(m.max_total_oi_usd.get())?, E::MarketOpenInterestCap)
}

/// Places a market or limit increase order on GMTrade with the owner PDA as owner and receiver.
pub fn open_position(accounts: &[AccountView], data: &[u8]) -> Result {
    let mut args = Args(data);
    let is_long = args.bool()?;
    let kind = args.variant(order_type::COUNT)?;
    let collateral = args.u64()?;
    let size = args.u128()?;
    let trigger_price = args.u128()?;
    let acceptable_price = args.u128()?;
    let max_fee = args.u64()?;
    #[rustfmt::skip]
    let [
        trader, config, funded, owner, owner_usdc, market_config, usdc_mint, gm_store, gm_market, gm_user, gm_position,
        gm_order, order_escrow, gm_event_authority, gmtrade_program, token_program, associated_token_program,
        system_program, event_authority, _program,
    ] = take::<20>(accounts)?;
    signer(trader)?;
    let c = Config::load(config)?;
    let f = load::<FundedAccount>(funded)?;
    system_account(owner)?;
    let usdc = token_account(owner_usdc)?;
    let m = load::<MarketConfig>(market_config)?;
    mint_account(usdc_mint)?;
    order_programs(gmtrade_program, token_program, associated_token_program, system_program)?;
    let order = CreateOrder {
        owner,
        store: gm_store,
        market: gm_market,
        user: gm_user,
        position: gm_position,
        order: gm_order,
        usdc_mint,
        escrow: order_escrow,
        event_authority: gm_event_authority,
        program: gmtrade_program,
        token_program,
        associated_token_program,
        system_program,
    };

    singleton(config, c.bump, &CONFIG_PDA)?;
    funded_seeds(funded, f)?;
    mutable(funded)?;
    keys_eq(&f.trader, trader.address(), E::Unauthorized)?;
    owner_seeds(owner, funded, f)?;
    mutable(owner)?;
    associated_token_constraint(owner_usdc, usdc, owner.address(), usdc_mint.address())?;
    mutable(owner_usdc)?;
    market_seeds(market_config, m)?;
    mutable(market_config)?;
    check_create_order(&order, &c, m, event_authority)?;

    require(!c.paused.trading.get(), E::Paused)?;
    require(f.status == funded_status::ACTIVE, E::InvalidAccountStatus)?;
    require(m.enabled.get(), E::MarketDisabled)?;
    require(order_type::is_increase(kind), E::InvalidOrderType)?;
    require(acceptable_price != 0, E::ZeroAcceptablePrice)?;
    require((trigger_price != 0) == (kind == order_type::LIMIT), E::InvalidTriggerPrice)?;
    require(collateral > 0, E::InvalidAmount)?;
    // The token account's balance as loaded: the CPI below moves it.
    require(collateral <= usdc.amount.get(), E::CollateralExceedsBalance)?;

    let market_token = m.market_token;
    let (slot_idx, is_new_slot) = match f.find_slot(&market_token, is_long) {
        Some(i) => {
            keys_eq(gm_position.address(), &f.slots[i].gm_position, E::InvalidPositionAccount)?;
            (i, false)
        }
        None => (f.slots.iter().position(Slot::is_free).ok_or(E::NoFreeSlot)?, true),
    };
    require(f.tracked_orders() < MAX_ORDERS, E::TooManyOrders)?;
    check_increase(f, &f.slots[slot_idx], m, is_long, size, collateral, 0)?;
    // The order's fee must stay in the account's USDC with every fee already due or held for pending increases (a
    // collateral-only increase is free and adds margin whatever is held).
    let fee = c.order_fee(size, u128::MAX)?;
    require(fee <= max_fee, E::OrderFeeChanged)?;
    if size > 0 {
        let held = f.reserved_fees()?;
        let needed = collateral.checked_add(fee).and_then(|v| v.checked_add(held)).ok_or(E::MathOverflow)?;
        require(needed <= usdc.amount.get(), E::CollateralExceedsBalance)?;
    }

    let bump = [f.owner_bump];
    let owner_signer: &[&[u8]] = &[OWNER_SEED, funded.address().as_ref(), &bump];
    let trigger = (kind == order_type::LIMIT).then_some(trigger_price);
    let params = order_params(kind, is_long, collateral, size, trigger, Some(acceptable_price));
    order.invoke(&[owner_signer], f.next_order_nonce(), &params, Some(owner_usdc))?;
    if is_new_slot {
        gmtrade::check_position_identity(
            gm_position,
            &c.gmtrade_program,
            &c.gmtrade_store,
            owner.address(),
            &market_token,
            &c.usdc_mint,
            is_long,
        )?;
    }

    let ts = now()?;
    if is_new_slot {
        let mut s = Slot { market_token, gm_position: *gm_position.address(), ..Slot::default() };
        s.is_long.set(is_long);
        f.slots[slot_idx] = s;
    }
    let s = &mut f.slots[slot_idx];
    s.pending_usd.set(s.pending_usd.get().checked_add(size).ok_or(E::MathOverflow)?);
    f.track_order(tracked(gm_order.address(), slot_idx, kind, size, collateral, false), fee)?;
    m.apply_oi_change(is_long, 0, size)?;
    let mut e = event::<EV>(disc::ORDER_REQUESTED);
    e.key(funded.address())
        .key(gm_order.address())
        .key(&market_token)
        .bool(is_long)
        .u8(kind)
        .u128(size)
        .u64(collateral)
        .u128(trigger_price)
        .u128(acceptable_price)
        .key(trader.address())
        .i64(ts)
        .u64(fee)
        .u64(c.order_fee_usdc.get())
        .u16(c.order_fee_bps.get());
    emit(event_authority, &e)
}

/// `DecreaseOrder` (close_position, set_protection), validated.
struct Decrease<'a> {
    authority: &'a AccountView,
    c: Config,
    funded: &'a AccountView,
    f: &'a mut FundedAccount,
    /// Not `mut` in `DecreaseOrder`: read only.
    m: &'a MarketConfig,
    order: CreateOrder<'a>,
    event_authority: &'a AccountView,
}

/// The `DecreaseOrder` accounts in Anchor's order: types, then constraints.
fn decrease_order(accounts: &[AccountView]) -> Result<Decrease<'_>> {
    #[rustfmt::skip]
    let [
        authority, config, funded, owner, market_config, usdc_mint, gm_store, gm_market, gm_user, gm_position, gm_order,
        order_escrow, gm_event_authority, gmtrade_program, token_program, associated_token_program, system_program,
        event_authority, _program,
    ] = take::<19>(accounts)?;
    signer(authority)?;
    let c = Config::load(config)?;
    let f = load::<FundedAccount>(funded)?;
    system_account(owner)?;
    let m = load::<MarketConfig>(market_config)?;
    mint_account(usdc_mint)?;
    order_programs(gmtrade_program, token_program, associated_token_program, system_program)?;
    let order = CreateOrder {
        owner,
        store: gm_store,
        market: gm_market,
        user: gm_user,
        position: gm_position,
        order: gm_order,
        usdc_mint,
        escrow: order_escrow,
        event_authority: gm_event_authority,
        program: gmtrade_program,
        token_program,
        associated_token_program,
        system_program,
    };

    singleton(config, c.bump, &CONFIG_PDA)?;
    funded_seeds(funded, f)?;
    mutable(funded)?;
    owner_seeds(owner, funded, f)?;
    mutable(owner)?;
    market_seeds(market_config, m)?;
    check_create_order(&order, &c, m, event_authority)?;
    Ok(Decrease { authority, c, funded, f, m, order, event_authority })
}

impl Decrease<'_> {
    /// Creates a decrease order on the (market, side) slot and tracks it. Returns its fee, at most `max_fee`: the rate on
    /// its size up to the account's exposure cap (the position can grow before it executes, never past that cap; the
    /// charge is capped at the size it closes); 0 for a risk authority's order on a breached account, whose USDC all
    /// returns to the capital vault. A risk authority's order on any other account (the session guard) is assessed like
    /// the trader's own close.
    #[allow(clippy::too_many_arguments)]
    fn place(
        &mut self,
        is_long: bool,
        kind: u8,
        size: u128,
        trigger: Option<u128>,
        acceptable: Option<u128>,
        placed_by_risk: bool,
        max_fee: u64,
    ) -> Result<u64> {
        let f = &mut *self.f;
        require(f.is_open(), E::InvalidAccountStatus)?;
        require(size >= gmtrade::MIN_DECREASE_USD, E::InvalidAmount)?;
        let slot_idx = f.find_slot(&self.m.market_token, is_long).ok_or(E::NoPosition)?;
        keys_eq(self.order.position.address(), &f.slots[slot_idx].gm_position, E::InvalidPositionAccount)?;
        require(f.tracked_orders() < MAX_ORDERS, E::TooManyOrders)?;
        let free = placed_by_risk && f.status == funded_status::BREACHED;
        let fee = if free { 0 } else { self.c.order_fee(size, f.terms.max_exposure_gm()?)? };
        require(fee <= max_fee, E::OrderFeeChanged)?;

        let bump = [f.owner_bump];
        let owner_signer: &[&[u8]] = &[OWNER_SEED, self.funded.address().as_ref(), &bump];
        let params = order_params(kind, is_long, 0, size, trigger, acceptable);
        self.order.invoke(&[owner_signer], f.next_order_nonce(), &params, None)?;
        f.track_order(tracked(self.order.order.address(), slot_idx, kind, size, 0, placed_by_risk), fee)?;
        Ok(fee)
    }
}

/// Market-decreases a position. Signed by the trader, or by a risk authority (forced close). Never blocked by pauses.
pub fn close_position(accounts: &[AccountView], data: &[u8]) -> Result {
    let mut args = Args(data);
    let is_long = args.bool()?;
    let size = args.u128()?;
    let acceptable_price = args.u128()?;
    let max_fee = args.u64()?;
    let mut d = decrease_order(accounts)?;
    let by = d.authority.address();
    let is_trader = by == &d.f.trader;
    let is_risk = d.c.is_risk_authority(by);
    require(is_trader || is_risk, E::Unauthorized)?;
    require(acceptable_price != 0, E::ZeroAcceptablePrice)?;
    let fee = d.place(is_long, order_type::CLOSE, size, None, Some(acceptable_price), !is_trader, max_fee)?;
    let mut e = event::<EV>(disc::ORDER_REQUESTED);
    e.key(d.funded.address())
        .key(d.order.order.address())
        .key(&d.m.market_token)
        .bool(is_long)
        .u8(order_type::CLOSE)
        .u128(size)
        .u64(0)
        .u128(0)
        .u128(acceptable_price)
        .key(by)
        .i64(now()?)
        .u64(fee)
        .u64(d.c.order_fee_usdc.get())
        .u16(d.c.order_fee_bps.get());
    emit(d.event_authority, &e)
}

/// Places a take-profit (LimitDecrease) or stop-loss (StopLossDecrease) order. Trader only.
pub fn set_protection(accounts: &[AccountView], data: &[u8]) -> Result {
    let mut args = Args(data);
    let is_long = args.bool()?;
    let kind = args.variant(order_type::COUNT)?;
    let trigger_price = args.u128()?;
    let size = args.u128()?;
    let max_fee = args.u64()?;
    let mut d = decrease_order(accounts)?;
    keys_eq(d.authority.address(), &d.f.trader, E::Unauthorized)?;
    require(d.f.status != funded_status::PAYOUT_PENDING, E::InvalidAccountStatus)?;
    require(kind == order_type::TAKE_PROFIT || kind == order_type::STOP_LOSS, E::InvalidOrderType)?;
    require(trigger_price != 0, E::InvalidTriggerPrice)?;
    let fee = d.place(is_long, kind, size, Some(trigger_price), None, false, max_fee)?;
    let mut e = event::<EV>(disc::PROTECTION_SET);
    e.key(d.funded.address())
        .key(d.order.order.address())
        .key(&d.m.market_token)
        .bool(is_long)
        .u8(kind)
        .u128(size)
        .u128(trigger_price)
        .i64(now()?)
        .u64(fee)
        .u64(d.c.order_fee_usdc.get())
        .u16(d.c.order_fee_bps.get());
    emit(d.event_authority, &e)
}

/// Updates a pending limit, take-profit or stop-loss order. A limit increase can be changed only while trading is live,
/// the account is active and its market enabled, and only within the market's current limits (any change can make it
/// fill at once). Every update re-assesses the order's fee at the current rate, as placing it again would (at most
/// `max_fee`); a limit increase's higher fee must fit in the account's USDC.
pub fn update_order(accounts: &[AccountView], data: &[u8]) -> Result {
    let mut args = Args(data);
    let trigger_price = args.option_u128()?;
    let acceptable_price = args.option_u128()?;
    let size_delta = args.option_u128()?;
    let max_fee = args.u64()?;
    #[rustfmt::skip]
    let [
        trader, config, funded, owner, market_config, gm_store, gm_market, gm_order, gm_event_authority,
        gmtrade_program, owner_usdc, event_authority, _program,
    ] = take::<13>(accounts)?;
    signer(trader)?;
    let c = Config::load(config)?;
    let f = load::<FundedAccount>(funded)?;
    system_account(owner)?;
    let m = load::<MarketConfig>(market_config)?;
    program_account(gmtrade_program, &GMTRADE_PROGRAM_ID)?;
    let usdc = token_account(owner_usdc)?;

    singleton(config, c.bump, &CONFIG_PDA)?;
    funded_seeds(funded, f)?;
    mutable(funded)?;
    keys_eq(&f.trader, trader.address(), E::Unauthorized)?;
    owner_seeds(owner, funded, f)?;
    market_seeds(market_config, m)?;
    mutable(market_config)?;
    keys_eq(gm_store.address(), &c.gmtrade_store, E::ConstraintAddress)?;
    mutable(gm_market)?;
    keys_eq(gm_market.address(), &m.gm_market, E::MarketMismatch)?;
    mutable(gm_order)?;
    keys_eq(gmtrade_program.address(), &c.gmtrade_program, E::ConstraintAddress)?;
    keys_eq(owner_usdc.address(), &ata_address(owner.address(), &c.usdc_mint), E::ConstraintAddress)?;
    check_event_authority(event_authority)?;

    let idx = f.find_order(gm_order.address()).ok_or(E::OrderNotTracked)?;
    let t = f.orders[idx];
    require(!t.placed_by_risk.get(), E::Unauthorized)?;
    require(order_type::is_updatable(t.order_type), E::InvalidOrderType)?;
    require(f.is_open(), E::InvalidAccountStatus)?;
    require(trigger_price.is_some() || acceptable_price.is_some() || size_delta.is_some(), E::InvalidParams)?;
    require(acceptable_price != Some(0), E::ZeroAcceptablePrice)?;
    require(trigger_price != Some(0), E::InvalidTriggerPrice)?;
    let slot = f.slots[t.slot as usize];
    keys_eq(&m.market_token, &slot.market_token, E::MarketMismatch)?;
    let increase = order_type::is_increase(t.order_type);
    let size = size_delta.unwrap_or(t.size_usd.get());
    if increase {
        require(!c.paused.trading.get(), E::Paused)?;
        require(f.status == funded_status::ACTIVE, E::InvalidAccountStatus)?;
        require(m.enabled.get(), E::MarketDisabled)?;
        check_increase(f, &slot, m, slot.is_long.get(), size, t.collateral.get(), t.size_usd.get())?;
    } else if let Some(size) = size_delta {
        require(size >= gmtrade::MIN_DECREASE_USD, E::InvalidAmount)?;
    }
    let cap = if increase { u128::MAX } else { f.terms.max_exposure_gm()? };
    let fee = c.order_fee(size, cap)?;
    require(fee <= max_fee, E::OrderFeeChanged)?;
    let old = f.order_fees[idx].get();
    if increase && fee > old {
        let held = f.reserved_fees()?.checked_sub(old).and_then(|v| v.checked_add(fee)).ok_or(E::MathOverflow)?;
        require(held <= usdc.amount.get(), E::CollateralExceedsBalance)?;
    }

    let bump = [f.owner_bump];
    let owner_signer: &[&[u8]] = &[OWNER_SEED, funded.address().as_ref(), &bump];
    gmtrade::update_order(
        gmtrade_program,
        owner,
        gm_store,
        gm_market,
        gm_order,
        gm_event_authority,
        &[owner_signer],
        size_delta,
        acceptable_price,
        trigger_price,
    )?;

    if let Some(size) = size_delta {
        if increase {
            let s = &mut f.slots[t.slot as usize];
            let pending = s.pending_usd.get().checked_sub(t.size_usd.get()).and_then(|v| v.checked_add(size));
            s.pending_usd.set(pending.ok_or(E::MathOverflow)?);
            m.apply_oi_change(slot.is_long.get(), t.size_usd.get(), size)?;
        }
        f.orders[idx].size_usd.set(size);
    }
    f.order_fees[idx].set(fee);
    let mut e = event::<EV>(disc::ORDER_UPDATED);
    e.key(funded.address())
        .key(gm_order.address())
        .option_u128(size_delta)
        .option_u128(trigger_price)
        .option_u128(acceptable_price)
        .i64(now()?)
        .u64(fee)
        .u64(c.order_fee_usdc.get())
        .u16(c.order_fee_bps.get());
    emit(event_authority, &e)
}

/// Cancels a pending tracked order; its collateral and rent return to the owner PDA and its fee is released (never
/// charged). The trader cannot cancel orders a risk authority placed. Never blocked by pauses. Orders GMTrade already executed or cancelled go through sync and
/// close_completed_order instead, and only sync, which reads the position, frees slots.
pub fn cancel_order(accounts: &[AccountView], _data: &[u8]) -> Result {
    #[rustfmt::skip]
    let [
        authority, config, funded, owner, owner_usdc, market_config, usdc_mint, gm_store, gm_store_wallet, gm_user,
        gm_order, order_escrow, gm_event_authority, gmtrade_program, token_program, associated_token_program,
        system_program, event_authority, _program,
    ] = take::<19>(accounts)?;
    signer(authority)?;
    let c = Config::load(config)?;
    let f = load::<FundedAccount>(funded)?;
    system_account(owner)?;
    let usdc = token_account(owner_usdc)?;
    let m = load::<MarketConfig>(market_config)?;
    mint_account(usdc_mint)?;
    order_programs(gmtrade_program, token_program, associated_token_program, system_program)?;
    let order = CloseOrder {
        owner,
        owner_usdc,
        store: gm_store,
        store_wallet: gm_store_wallet,
        user: gm_user,
        order: gm_order,
        usdc_mint,
        escrow: order_escrow,
        event_authority: gm_event_authority,
        program: gmtrade_program,
        token_program,
        associated_token_program,
        system_program,
    };

    singleton(config, c.bump, &CONFIG_PDA)?;
    funded_seeds(funded, f)?;
    mutable(funded)?;
    owner_seeds(owner, funded, f)?;
    mutable(owner)?;
    associated_token_constraint(owner_usdc, usdc, owner.address(), usdc_mint.address())?;
    mutable(owner_usdc)?;
    market_seeds(market_config, m)?;
    mutable(market_config)?;
    check_close_order(&order, &c, event_authority)?;

    let by = authority.address();
    let idx = f.find_order(gm_order.address()).ok_or(E::OrderNotTracked)?;
    let t = f.orders[idx];
    let is_risk = c.is_risk_authority(by);
    require(is_risk || (by == &f.trader && !t.placed_by_risk.get()), E::Unauthorized)?;
    require(gmtrade::is_pending_order(gm_order, &c.gmtrade_program)?, E::OrderNotPending)?;
    let slot = f.slots[t.slot as usize];
    keys_eq(&m.market_token, &slot.market_token, E::MarketMismatch)?;

    let bump = [f.owner_bump];
    let owner_signer: &[&[u8]] = &[OWNER_SEED, funded.address().as_ref(), &bump];
    order.invoke(&[owner_signer], "cancel")?;

    f.orders[idx] = TrackedOrder::default();
    f.order_fees[idx].set(0);
    if order_type::is_increase(t.order_type) {
        let s = &mut f.slots[t.slot as usize];
        s.pending_usd.set(s.pending_usd.get().checked_sub(t.size_usd.get()).ok_or(E::MathOverflow)?);
        m.apply_oi_change(slot.is_long.get(), t.size_usd.get(), 0)?;
    }
    let mut e = event::<EV>(disc::ORDER_CANCELLED);
    e.key(funded.address()).key(gm_order.address()).key(by).i64(now()?);
    emit(event_authority, &e)
}
