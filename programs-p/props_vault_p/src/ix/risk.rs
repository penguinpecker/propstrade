//! Port of programs/props_vault/src/instructions/risk.rs (see PORTING.md). Each handler validates in Anchor's order:
//! account types in field order, then `init` fields, then the remaining constraints in field order, then the handler
//! body. The only USDC paths out of an owner PDA here are an approved payout (the trader's own USDC ATA + the capital
//! vault) and closure (the capital vault), both signed by the owner PDA's seeds.
use pinocchio::{AccountView, Address};

use super::{
    trader::payout_seeds,
    trading::{funded_seeds, owner_seeds},
};
use crate::{
    accounts::{
        associated_token_constraint, ata_address, check_event_authority, keys_eq, mint_account, mutable, now,
        program_account, seeds, signer, singleton, system_account, take, token_account, Args, Rent, ATA_PROGRAM_ID,
        CONFIG_PDA, SOL_TREASURY_PDA, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
    },
    cpi::{close_account, create_ata, init_pda, transfer, transfer_checked},
    error::{require, Result, E},
    events::{disc, emit, event},
    gmtrade,
    state::{
        evaluation_status, funded_status, load, payout_status, Config, Evaluation, FundedAccount, IdentityLock,
        PayoutRequest, TraderProfile, EVALUATION_SEED, IDENTITY_SEED, OWNER_SEED, SOL_TREASURY_SEED, TRADER_SEED,
    },
};

/// The account holds no slots or tracked orders, and every GMTrade position passed exists, belongs to `owner` (verified
/// by PDA seeds) and is flat.
fn require_flat(f: &FundedAccount, positions: &[AccountView], c: &Config, owner: &AccountView) -> Result {
    require(f.is_flat(), E::NotFlat)?;
    for v in positions {
        let size = gmtrade::verified_position_size(v, &c.gmtrade_program, &c.gmtrade_store, owner.address())?;
        require(size == 0, E::NotFlat)?;
    }
    Ok(())
}

/// `transfer_checked` of `amount` out of the owner PDA's USDC account, signed by the owner PDA; nothing when 0.
fn transfer_from_owner(
    from: &AccountView,
    mint: &AccountView,
    to: &AccountView,
    owner: &AccountView,
    decimals: u8,
    owner_signer: &[&[u8]],
    amount: u64,
) -> Result {
    if amount == 0 {
        return Ok(());
    }
    transfer_checked(from, mint, to, owner, amount, decimals, &[owner_signer])
}

/// Binds a verified identity to one wallet. The identity lock is `init`, so a person gets one wallet.
pub fn set_identity(accounts: &[AccountView], data: &[u8]) -> Result {
    let mut args = Args(data);
    let wallet = args.key()?;
    let identity_hash = args.array::<32>()?;
    let [kyc_authority, config, profile, identity_lock, system_program, event_authority, _program] =
        take::<7>(accounts)?;
    signer(kyc_authority)?;
    let c = Config::load(config)?;
    program_account(system_program, &SYSTEM_PROGRAM_ID)?;

    let rent = Rent::get()?;
    let (p, profile_bump) =
        init_pda::<TraderProfile>(kyc_authority, profile, &[TRADER_SEED, wallet.as_ref()], true, &rent)?;
    let (lock, lock_bump) =
        init_pda::<IdentityLock>(kyc_authority, identity_lock, &[IDENTITY_SEED, identity_hash], false, &rent)?;

    mutable(kyc_authority)?;
    singleton(config, c.bump, &CONFIG_PDA)?;
    keys_eq(&c.kyc_authority, kyc_authority.address(), E::Unauthorized)?;
    check_event_authority(event_authority)?;

    require(*identity_hash != [0; 32], E::InvalidParams)?;
    let ts = now()?;
    require(!p.is_verified(), E::AlreadyVerified)?;
    if p.wallet == Address::default() {
        p.wallet = *wallet;
        p.bump = profile_bump;
    }
    p.identity_hash = *identity_hash;
    p.verified_at.set(ts);
    lock.profile = *profile.address();
    lock.bump = lock_bump;
    let mut ev = event::<120>(disc::IDENTITY_SET);
    ev.key(profile.address()).key(wallet).bytes(identity_hash).i64(ts);
    emit(event_authority, &ev)
}

pub fn record_evaluation_result(accounts: &[AccountView], data: &[u8]) -> Result {
    let mut args = Args(data);
    let passed = args.bool()?;
    let final_equity = args.i64()?;
    let trades_root = args.array::<32>()?;
    let [risk_authority, config, evaluation, event_authority, _program] = take::<5>(accounts)?;
    signer(risk_authority)?;
    let c = Config::load(config)?;
    let e = load::<Evaluation>(evaluation)?;

    singleton(config, c.bump, &CONFIG_PDA)?;
    require(c.is_risk_authority(risk_authority.address()), E::Unauthorized)?;
    seeds(evaluation, &[EVALUATION_SEED, e.trader.as_ref(), &e.index.get().to_le_bytes(), &[e.bump]])?;
    mutable(evaluation)?;
    check_event_authority(event_authority)?;

    require(e.status == evaluation_status::ACTIVE, E::InvalidEvaluationStatus)?;
    let ts = now()?;
    e.status = if passed { evaluation_status::PASSED } else { evaluation_status::FAILED };
    e.final_equity.set(final_equity);
    e.trades_root = *trades_root;
    e.resolved_at.set(ts);
    let mut ev = event::<129>(disc::EVALUATION_RESOLVED);
    ev.key(evaluation.address()).key(&e.trader).bool(passed).i64(final_equity).bytes(trades_root).i64(ts);
    emit(event_authority, &ev)
}

/// Pays a requested payout: trader share to the trader's USDC ATA (created, paid by the SOL treasury, if missing), vault
/// share to the capital vault. Remaining accounts: GMTrade positions of the owner PDA to re-check as flat.
pub fn approve_payout(accounts: &[AccountView], _data: &[u8]) -> Result {
    #[rustfmt::skip]
    let [
        risk_authority, config, funded, payout, owner, owner_usdc, trader, trader_usdc, capital_vault, sol_treasury,
        usdc_mint, token_program, associated_token_program, system_program, event_authority, _program,
    ] = take::<16>(accounts)?;
    signer(risk_authority)?;
    let mut c = Config::load(config)?;
    let f = load::<FundedAccount>(funded)?;
    let p = load::<PayoutRequest>(payout)?;
    system_account(owner)?;
    let usdc = token_account(owner_usdc)?;
    token_account(capital_vault)?;
    system_account(sol_treasury)?;
    let decimals = mint_account(usdc_mint)?.decimals;
    program_account(token_program, &TOKEN_PROGRAM_ID)?;
    program_account(associated_token_program, &ATA_PROGRAM_ID)?;
    program_account(system_program, &SYSTEM_PROGRAM_ID)?;

    singleton(config, c.bump, &CONFIG_PDA)?;
    mutable(config)?;
    require(c.is_risk_authority(risk_authority.address()), E::Unauthorized)?;
    funded_seeds(funded, f)?;
    mutable(funded)?;
    payout_seeds(payout, funded, p)?;
    mutable(payout)?;
    keys_eq(&p.funded, funded.address(), E::Unauthorized)?;
    owner_seeds(owner, funded, f)?;
    mutable(owner)?;
    associated_token_constraint(owner_usdc, usdc, owner.address(), usdc_mint.address())?;
    mutable(owner_usdc)?;
    keys_eq(trader.address(), &f.trader, E::Unauthorized)?;
    mutable(trader_usdc)?;
    mutable(capital_vault)?;
    keys_eq(capital_vault.address(), &c.capital_vault, E::ConstraintAddress)?;
    singleton(sol_treasury, c.sol_treasury_bump, &SOL_TREASURY_PDA)?;
    mutable(sol_treasury)?;
    keys_eq(usdc_mint.address(), &c.usdc_mint, E::ConstraintAddress)?;
    check_event_authority(event_authority)?;

    require(!c.paused.payouts.get(), E::Paused)?;
    require(p.status == payout_status::REQUESTED, E::InvalidPayoutStatus)?;
    require(f.status == funded_status::PAYOUT_PENDING, E::InvalidAccountStatus)?;
    require_flat(f, &accounts[16..], &c, owner)?;
    require(usdc.amount.get() >= p.balance_at_request.get(), E::BalanceChanged)?;
    keys_eq(trader_usdc.address(), &ata_address(&f.trader, &c.usdc_mint), E::Unauthorized)?;

    let treasury_signer: &[&[u8]] = &[SOL_TREASURY_SEED, &[c.sol_treasury_bump]];
    create_ata(sol_treasury, trader_usdc, trader, usdc_mint, system_program, token_program, true, &[treasury_signer])?;
    let bump = [f.owner_bump];
    let owner_signer: &[&[u8]] = &[OWNER_SEED, funded.address().as_ref(), &bump];
    let (trader_amount, vault_amount) = (p.trader_amount.get(), p.vault_amount.get());
    transfer_from_owner(owner_usdc, usdc_mint, trader_usdc, owner, decimals, owner_signer, trader_amount)?;
    transfer_from_owner(owner_usdc, usdc_mint, capital_vault, owner, decimals, owner_signer, vault_amount)?;

    let ts = now()?;
    f.status = funded_status::ACTIVE;
    f.payouts_paid.set(f.payouts_paid.get().checked_add(trader_amount).ok_or(E::MathOverflow)?);
    p.status = payout_status::PAID;
    p.resolved_at.set(ts);
    let c = &mut *c;
    c.payouts_paid.set(c.payouts_paid.get().checked_add(trader_amount).ok_or(E::MathOverflow)?);
    c.profit_to_vault.set(c.profit_to_vault.get().checked_add(vault_amount).ok_or(E::MathOverflow)?);
    // 168 (≥ 16 + 120): an `N` activate_funded already instantiates (PORTING.md "Size notes").
    let mut e = event::<168>(disc::PAYOUT_PAID);
    e.key(funded.address()).key(payout.address()).key(&f.trader).u64(trader_amount).u64(vault_amount).i64(ts);
    emit(event_authority, &e)
}

pub fn reject_payout(accounts: &[AccountView], data: &[u8]) -> Result {
    let reason_code = Args(data).u16()?;
    let [risk_authority, config, funded, payout, event_authority, _program] = take::<6>(accounts)?;
    signer(risk_authority)?;
    let c = Config::load(config)?;
    let f = load::<FundedAccount>(funded)?;
    let p = load::<PayoutRequest>(payout)?;

    singleton(config, c.bump, &CONFIG_PDA)?;
    require(c.is_risk_authority(risk_authority.address()), E::Unauthorized)?;
    funded_seeds(funded, f)?;
    mutable(funded)?;
    payout_seeds(payout, funded, p)?;
    mutable(payout)?;
    keys_eq(&p.funded, funded.address(), E::Unauthorized)?;
    check_event_authority(event_authority)?;

    require(p.status == payout_status::REQUESTED, E::InvalidPayoutStatus)?;
    require(f.status == funded_status::PAYOUT_PENDING, E::InvalidAccountStatus)?;
    let ts = now()?;
    f.status = funded_status::ACTIVE;
    p.status = payout_status::REJECTED;
    p.reason_code.set(reason_code);
    p.resolved_at.set(ts);
    // 129 (≥ 16 + 74): record_evaluation_result's `N`.
    let mut e = event::<129>(disc::PAYOUT_REJECTED);
    e.key(&p.funded).key(payout.address()).u16(reason_code).i64(ts);
    emit(event_authority, &e)
}

/// `RiskFunded` (restrict, mark_breached) in Anchor's order, types then constraints: the funded account, its view and
/// the event authority.
fn risk_funded(accounts: &[AccountView]) -> Result<(&AccountView, &mut FundedAccount, &AccountView)> {
    let [risk_authority, config, funded, event_authority, _program] = take::<5>(accounts)?;
    signer(risk_authority)?;
    let c = Config::load(config)?;
    let f = load::<FundedAccount>(funded)?;

    singleton(config, c.bump, &CONFIG_PDA)?;
    require(c.is_risk_authority(risk_authority.address()), E::Unauthorized)?;
    funded_seeds(funded, f)?;
    mutable(funded)?;
    check_event_authority(event_authority)?;
    Ok((funded, f, event_authority))
}

/// Restricted accounts can only reduce risk (close, cancel, protect).
pub fn restrict(accounts: &[AccountView], data: &[u8]) -> Result {
    let restricted = Args(data).bool()?;
    let (funded, f, event_authority) = risk_funded(accounts)?;
    let (from, to) = if restricted {
        (funded_status::ACTIVE, funded_status::RESTRICTED)
    } else {
        (funded_status::RESTRICTED, funded_status::ACTIVE)
    };
    require(f.status == from, E::InvalidAccountStatus)?;
    f.status = to;
    let mut e = event::<129>(disc::ACCOUNT_RESTRICTED);
    e.key(funded.address()).bool(restricted).i64(now()?);
    emit(event_authority, &e)
}

pub fn mark_breached(accounts: &[AccountView], _data: &[u8]) -> Result {
    let (funded, f, event_authority) = risk_funded(accounts)?;
    require(f.status == funded_status::ACTIVE || f.status == funded_status::RESTRICTED, E::InvalidAccountStatus)?;
    f.status = funded_status::BREACHED;
    let mut e = event::<129>(disc::ACCOUNT_BREACHED);
    e.key(funded.address()).i64(now()?);
    emit(event_authority, &e)
}

/// Closes a flat funded account: its USDC returns to the capital vault, its SOL and ATA rent to the SOL treasury, and its
/// principal is released. Remaining accounts: owner positions to re-check.
pub fn close_funded(accounts: &[AccountView], _data: &[u8]) -> Result {
    #[rustfmt::skip]
    let [
        risk_authority, config, funded, profile, owner, owner_usdc, capital_vault, sol_treasury, usdc_mint,
        token_program, system_program, event_authority, _program,
    ] = take::<13>(accounts)?;
    signer(risk_authority)?;
    let mut c = Config::load(config)?;
    let f = load::<FundedAccount>(funded)?;
    let pr = load::<TraderProfile>(profile)?;
    system_account(owner)?;
    let usdc = token_account(owner_usdc)?;
    token_account(capital_vault)?;
    system_account(sol_treasury)?;
    let decimals = mint_account(usdc_mint)?.decimals;
    program_account(token_program, &TOKEN_PROGRAM_ID)?;
    program_account(system_program, &SYSTEM_PROGRAM_ID)?;

    singleton(config, c.bump, &CONFIG_PDA)?;
    mutable(config)?;
    require(c.is_risk_authority(risk_authority.address()), E::Unauthorized)?;
    funded_seeds(funded, f)?;
    mutable(funded)?;
    seeds(profile, &[TRADER_SEED, f.trader.as_ref(), &[pr.bump]])?;
    mutable(profile)?;
    owner_seeds(owner, funded, f)?;
    mutable(owner)?;
    associated_token_constraint(owner_usdc, usdc, owner.address(), usdc_mint.address())?;
    mutable(owner_usdc)?;
    mutable(capital_vault)?;
    keys_eq(capital_vault.address(), &c.capital_vault, E::ConstraintAddress)?;
    singleton(sol_treasury, c.sol_treasury_bump, &SOL_TREASURY_PDA)?;
    mutable(sol_treasury)?;
    keys_eq(usdc_mint.address(), &c.usdc_mint, E::ConstraintAddress)?;
    check_event_authority(event_authority)?;

    let s = f.status;
    require(
        s == funded_status::ACTIVE || s == funded_status::RESTRICTED || s == funded_status::BREACHED,
        E::InvalidAccountStatus,
    )?;
    require_flat(f, &accounts[13..], &c, owner)?;

    let bump = [f.owner_bump];
    let owner_signer: &[&[u8]] = &[OWNER_SEED, funded.address().as_ref(), &bump];
    // The balance as loaded: the transfer below empties the account and close_account then removes it.
    let usdc_returned = usdc.amount.get();
    transfer_from_owner(owner_usdc, usdc_mint, capital_vault, owner, decimals, owner_signer, usdc_returned)?;
    close_account(owner_usdc, sol_treasury, owner, &[owner_signer])?;
    let lamports_returned = owner.lamports();
    if lamports_returned > 0 {
        transfer(owner, sol_treasury, lamports_returned, &[owner_signer])?;
    }

    let principal = f.principal.get();
    f.status = funded_status::CLOSED;
    pr.active_funded = 0;
    let c = &mut *c;
    c.allocated_principal.set(c.allocated_principal.get().checked_sub(principal).ok_or(E::MathOverflow)?);
    c.funded_active.set(c.funded_active.get().checked_sub(1).ok_or(E::MathOverflow)?);
    let mut e = event::<129>(disc::ACCOUNT_CLOSED);
    e.key(funded.address()).u64(principal).u64(usdc_returned).u64(lamports_returned).i64(now()?);
    emit(event_authority, &e)
}
