//! Port of programs/props_vault/src/instructions/crank.rs (see PORTING.md). Each handler validates in Anchor's order:
//! account types in field order, then the remaining constraints in field order, then the handler body. All three are
//! permissionless.
use pinocchio::{AccountView, Address};

use super::trading::{check_close_order, funded_seeds, order_programs, owner_seeds, EV};
use crate::{
    accounts::{
        associated_token_constraint, check_event_authority, create_program_address, keys_eq, mint_account, mutable,
        now, program_account, singleton, system_account, take, token_account, CONFIG_PDA, SOL_TREASURY_PDA,
        SYSTEM_PROGRAM_ID,
    },
    cpi::top_up_from_treasury,
    error::{require, Result, E},
    events::{disc, emit, event},
    gmtrade::{self, CloseOrder, PositionState},
    state::{
        load, order_type, Config, FundedAccount, MarketConfig, TrackedOrder, MARKET_SEED, MAX_ORDERS, MAX_SLOTS,
        OWNER_SEED,
    },
};

/// Permissionless: reads GMTrade state into the funded account.
///
/// Remaining accounts, in order:
/// 1. the GMTrade Position of every used slot (ascending slot index),
/// 2. every tracked order (ascending index),
/// 3. the MarketConfig of every distinct market among used slots (first appearance), writable.
///
/// Orders whose account is gone are dropped. Orders GMTrade executed or cancelled but left open stay tracked, outside
/// the pending sums, until close_completed_order sweeps their escrow, so the account is not flat while one still holds
/// funds. Slot size/collateral come from the Position; market open interest follows each slot's committed size; idle
/// flat slots are freed.
pub fn sync(accounts: &[AccountView], _data: &[u8]) -> Result {
    let [config, funded, event_authority, _program] = take::<4>(accounts)?;
    let c = Config::load(config)?;
    let f = load::<FundedAccount>(funded)?;

    singleton(config, c.bump, &CONFIG_PDA)?;
    funded_seeds(funded, f)?;
    mutable(funded)?;
    check_event_authority(event_authority)?;

    let gm_program = c.gmtrade_program;
    require(f.is_open(), E::InvalidAccountStatus)?;
    let ts = now()?;
    let mut remaining = accounts[4..].iter();
    let mut next = || remaining.next().ok_or(E::InvalidRemainingAccounts);

    // The used slots, fixed for the whole call (only the last step frees any).
    let mut used = [false; MAX_SLOTS];
    let mut positions = [PositionState::default(); MAX_SLOTS];
    for i in 0..MAX_SLOTS {
        used[i] = !f.slots[i].is_free();
        if used[i] {
            let v = next()?;
            keys_eq(v.address(), &f.slots[i].gm_position, E::InvalidRemainingAccounts)?;
            positions[i] = gmtrade::position_state(v, &gm_program)?;
        }
    }

    let mut dropped = [Address::default(); MAX_ORDERS];
    let mut n_dropped = 0;
    let mut finished = [false; MAX_ORDERS];
    for (j, o) in f.orders.iter_mut().enumerate().filter(|(_, o)| !o.is_free()) {
        let v = next()?;
        keys_eq(v.address(), &o.order, E::InvalidRemainingAccounts)?;
        if !v.owned_by(&gm_program) {
            dropped[n_dropped] = o.order;
            n_dropped += 1;
            *o = TrackedOrder::default();
        } else {
            finished[j] = !gmtrade::is_pending_order(v, &gm_program)?;
        }
    }

    let mut committed_before = [0u128; MAX_SLOTS];
    for i in (0..MAX_SLOTS).filter(|&i| used[i]) {
        committed_before[i] = f.slots[i].committed()?;
        let mut pending = 0u128;
        for (j, o) in f.orders.iter().enumerate() {
            if !o.is_free() && !finished[j] && o.slot as usize == i && order_type::is_increase(o.order_type) {
                pending = pending.checked_add(o.size_usd.get()).ok_or(E::MathOverflow)?;
            }
        }
        let s = &mut f.slots[i];
        s.size_usd.set(positions[i].size_usd);
        s.collateral.set(positions[i].collateral);
        s.pending_usd.set(pending);
        s.last_sync.set(ts);
    }

    let mut markets = [Address::default(); MAX_SLOTS];
    let mut n_markets = 0;
    for i in (0..MAX_SLOTS).filter(|&i| used[i]) {
        if !markets[..n_markets].contains(&f.slots[i].market_token) {
            markets[n_markets] = f.slots[i].market_token;
            n_markets += 1;
        }
    }
    for market_token in &markets[..n_markets] {
        let v = next()?;
        require(v.is_writable(), E::InvalidRemainingAccounts)?;
        let m = load::<MarketConfig>(v)?;
        let expected = create_program_address(&[MARKET_SEED, market_token.as_ref(), &[m.bump]], &crate::ID)
            .ok_or(E::InvalidRemainingAccounts)?;
        keys_eq(v.address(), &expected, E::InvalidRemainingAccounts)?;
        for i in (0..MAX_SLOTS).filter(|&i| used[i] && f.slots[i].market_token == *market_token) {
            m.apply_oi_change(f.slots[i].is_long.get(), committed_before[i], f.slots[i].committed()?)?;
        }
    }
    require(remaining.next().is_none(), E::InvalidRemainingAccounts)?;

    // Synced { funded, slots (as synced, before idle ones are freed), orders_dropped, ts }.
    let mut e = event::<EV>(disc::SYNCED);
    e.key(funded.address()).u32(used.iter().filter(|&&u| u).count() as u32);
    for i in (0..MAX_SLOTS).filter(|&i| used[i]) {
        let s = &f.slots[i];
        e.key(&s.market_token)
            .bool(s.is_long.get())
            .u128(s.size_usd.get())
            .u64(s.collateral.get())
            .u128(s.pending_usd.get());
    }
    e.u32(n_dropped as u32);
    for order in &dropped[..n_dropped] {
        e.key(order);
    }
    e.i64(ts);
    for i in (0..MAX_SLOTS).filter(|&i| used[i]) {
        f.release_slot_if_idle(i);
    }
    f.last_sync_at.set(ts);
    emit(event_authority, &e)
}

/// Permissionless: refills the owner PDA's SOL float from the treasury once it drops below the minimum.
pub fn top_up_owner(accounts: &[AccountView], _data: &[u8]) -> Result {
    let [config, funded, owner, sol_treasury, system_program, event_authority, _program] = take::<7>(accounts)?;
    let c = Config::load(config)?;
    let f = load::<FundedAccount>(funded)?;
    system_account(owner)?;
    system_account(sol_treasury)?;
    program_account(system_program, &SYSTEM_PROGRAM_ID)?;

    singleton(config, c.bump, &CONFIG_PDA)?;
    funded_seeds(funded, f)?;
    owner_seeds(owner, funded, f)?;
    mutable(owner)?;
    singleton(sol_treasury, c.sol_treasury_bump, &SOL_TREASURY_PDA)?;
    mutable(sol_treasury)?;
    check_event_authority(event_authority)?;

    require(f.is_open(), E::InvalidAccountStatus)?;
    require(owner.lamports() < c.owner_sol_min.get(), E::OwnerFloatSufficient)?;
    let lamports = top_up_from_treasury(sol_treasury, owner, c.sol_treasury_bump, c.owner_sol_target.get())?;
    let mut e = event::<EV>(disc::OWNER_TOPPED_UP);
    e.key(funded.address()).u64(lamports).i64(now()?);
    emit(event_authority, &e)
}

/// Permissionless: closes a tracked order GMTrade executed or cancelled but left open, returning its escrowed funds and
/// rent to the owner PDA, and stops tracking it. Pending orders are refused. The next sync settles the slot from the
/// position.
pub fn close_completed_order(accounts: &[AccountView], _data: &[u8]) -> Result {
    #[rustfmt::skip]
    let [
        config, funded, owner, owner_usdc, usdc_mint, gm_store, gm_store_wallet, gm_user, gm_order, order_escrow,
        gm_event_authority, gmtrade_program, token_program, associated_token_program, system_program, event_authority,
        _program,
    ] = take::<17>(accounts)?;
    let c = Config::load(config)?;
    let f = load::<FundedAccount>(funded)?;
    system_account(owner)?;
    let usdc = token_account(owner_usdc)?;
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
    check_close_order(&order, &c, event_authority)?;

    require(f.is_open(), E::InvalidAccountStatus)?;
    let idx = f.find_order(gm_order.address()).ok_or(E::OrderNotTracked)?;
    require(!gmtrade::is_pending_order(gm_order, &c.gmtrade_program)?, E::OrderPending)?;
    let bump = [f.owner_bump];
    let owner_signer: &[&[u8]] = &[OWNER_SEED, funded.address().as_ref(), &bump];
    order.invoke(&[owner_signer], "completed")?;
    f.orders[idx] = TrackedOrder::default();
    let mut e = event::<EV>(disc::COMPLETED_ORDER_CLOSED);
    e.key(funded.address()).key(gm_order.address()).i64(now()?);
    emit(event_authority, &e)
}
