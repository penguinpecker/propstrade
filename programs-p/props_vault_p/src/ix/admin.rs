//! Port of programs/props_vault/src/instructions/admin.rs. Each handler validates in Anchor's order: account types in
//! field order, then `init` fields, then the remaining constraints in field order, then the handler body.
use pinocchio::{AccountView, Address};

use crate::{
    accounts::{
        check_event_authority, keys_eq, mint_account, mutable, now, program_account, signer, singleton, system_account,
        take, token_account, token_constraint, Args, Rent, ATA_PROGRAM_ID, BPF_LOADER_UPGRADEABLE_ID, CONFIG_PDA,
        FEE_VAULT_PDA, GMTRADE_PROGRAM_ID, SOL_TREASURY_PDA, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, VAULT_PDA,
    },
    cpi::{
        create_account_anchor, init_address, init_ata_if_needed, init_pda, init_token_pda, transfer, transfer_checked,
    },
    error::{require, Result, E},
    events::{config_change, disc, emit, event},
    gmtrade,
    state::{
        initialized_and_owned, Config, ConfigParams, MarketConfig, MarketParams, Pauses, Tier, TierParams, CONFIG_SEED,
        CONFIG_SPACE, FEE_VAULT_SEED, MARKET_SEED, MAX_RISK_AUTHORITIES, SOL_TREASURY_SEED, TIER_SEED, VAULT_SEED,
    },
};

/// `ConfigChanged { change, subject, paused, ts }`.
fn config_changed(event_authority: &AccountView, paused: &Pauses, change: u8, subject: &Address) -> Result {
    let mut e = event::<60>(disc::CONFIG_CHANGED);
    e.u8(change)
        .key(subject)
        .bool(paused.new_evaluations.get())
        .bool(paused.trading.get())
        .bool(paused.payouts.get())
        .i64(now()?);
    emit(event_authority, &e)
}

/// `Account<'info, ProgramData>`: owned by the upgradeable loader, bincode `UpgradeableLoaderState::ProgramData`
/// (u32 variant 3, u64 slot, Option<Pubkey>). Returns `upgrade_authority_address`.
fn program_data_authority(v: &AccountView) -> Result<Option<&Address>> {
    initialized_and_owned(v, &BPF_LOADER_UPGRADEABLE_ID)?;
    // SAFETY: read-only; nothing else borrows the loader's account.
    let d = unsafe { v.borrow_unchecked() };
    let variant = d.first_chunk::<4>().map(|t| u32::from_le_bytes(*t)).ok_or(E::AccountDidNotDeserialize)?;
    require(variant <= 3, E::AccountDidNotDeserialize)?;
    require(variant == 3, E::AccountNotProgramData)?;
    match (d.get(12), d.get(13..45)) {
        (Some(0), _) => Ok(None),
        // SAFETY: 32 bytes; Address has alignment 1.
        (Some(1), Some(key)) => Ok(Some(unsafe { &*(key.as_ptr() as *const Address) })),
        _ => Err(E::AccountDidNotDeserialize.into()),
    }
}

/// `Program::programdata_address()`: the ProgramData address of an upgradeable program account.
fn programdata_address(program: &AccountView) -> Option<&Address> {
    if !program.owned_by(&BPF_LOADER_UPGRADEABLE_ID) {
        return None;
    }
    // SAFETY: read-only; nothing else borrows the loader's account.
    let d = unsafe { program.borrow_unchecked() };
    // UpgradeableLoaderState::Program { programdata_address } = u32 variant 2 + 32 bytes.
    match (d.get(..4), d.get(4..36)) {
        // SAFETY: 32 bytes; Address has alignment 1.
        (Some([2, 0, 0, 0]), Some(key)) => Some(unsafe { &*(key.as_ptr() as *const Address) }),
        _ => None,
    }
}

/// Creates the config and vault accounts. Everything starts paused. Only the program's upgrade authority can call it.
pub fn initialize(accounts: &[AccountView], data: &[u8]) -> Result {
    let params = ConfigParams::read(&mut Args(data))?;
    #[rustfmt::skip]
    let [
        admin, config, vault, fee_vault, capital_vault, sol_treasury, usdc_mint, gmtrade_program, gmtrade_store,
        program, program_data, token_program, associated_token_program, system_program, event_authority,
    ] = take::<15>(accounts)?;
    signer(admin)?;
    system_account(sol_treasury)?;
    mint_account(usdc_mint)?;
    program_account(gmtrade_program, &GMTRADE_PROGRAM_ID)?;
    program_account(program, &crate::ID)?;
    let upgrade_authority = program_data_authority(program_data)?;
    program_account(token_program, &TOKEN_PROGRAM_ID)?;
    program_account(associated_token_program, &ATA_PROGRAM_ID)?;
    program_account(system_program, &SYSTEM_PROGRAM_ID)?;

    // init: config, fee_vault; init_if_needed: capital_vault (anyone may create ATA(vault, USDC) first).
    let rent = Rent::get()?;
    let config_bump = init_address(config, &[CONFIG_SEED])?;
    create_account_anchor(admin, config, CONFIG_SPACE, &crate::ID, &rent, &[&[CONFIG_SEED, &[config_bump]]])?;
    initialized_and_owned(config, &crate::ID)?;
    mutable(config)?;
    let fee_vault_bump = init_token_pda(admin, fee_vault, &[FEE_VAULT_SEED], usdc_mint, vault, token_program, &rent)?;
    init_ata_if_needed(admin, capital_vault, vault, usdc_mint, system_program, token_program)?;

    mutable(admin)?;
    keys_eq(vault.address(), &VAULT_PDA.0, E::ConstraintSeeds)?;
    keys_eq(sol_treasury.address(), &SOL_TREASURY_PDA.0, E::ConstraintSeeds)?;
    keys_eq(gmtrade_store.owner(), gmtrade_program.address(), E::ConstraintOwner)?;
    require(programdata_address(program) == Some(program_data.address()), E::NotUpgradeAuthority)?;
    require(upgrade_authority == Some(admin.address()), E::NotUpgradeAuthority)?;
    check_event_authority(event_authority)?;

    params.validate(rent.minimum_balance(0))?;
    let mut c = Config::init(config, admin.address());
    c.kyc_authority = Address::default();
    c.usdc_mint = *usdc_mint.address();
    c.gmtrade_program = *gmtrade_program.address();
    c.gmtrade_store = *gmtrade_store.address();
    c.capital_vault = *capital_vault.address();
    c.set_params(&params);
    let mut paused = Pauses::default();
    paused.new_evaluations.set(true);
    paused.trading.set(true);
    paused.payouts.set(true);
    c.paused = paused;
    c.bump = config_bump;
    c.vault_bump = VAULT_PDA.1;
    c.fee_vault_bump = fee_vault_bump;
    c.sol_treasury_bump = SOL_TREASURY_PDA.1;
    config_changed(event_authority, &c.paused, config_change::INITIALIZED, admin.address())
}

/// `AdminOnly`: admin (signer), config (mut, seeds, `has_one = admin @ Unauthorized`), event_authority, program.
fn admin_only(accounts: &[AccountView]) -> Result<(Config, &AccountView)> {
    let [admin, config, event_authority, _program] = take::<4>(accounts)?;
    signer(admin)?;
    let c = Config::load(config)?;
    singleton(config, c.bump, &CONFIG_PDA)?;
    mutable(config)?;
    keys_eq(c.admin(), admin.address(), E::Unauthorized)?;
    check_event_authority(event_authority)?;
    Ok((c, event_authority))
}

pub fn propose_admin(accounts: &[AccountView], data: &[u8]) -> Result {
    let new_admin = Args(data).key()?;
    let (mut c, event_authority) = admin_only(accounts)?;
    c.set_pending_admin(Some(new_admin))?;
    config_changed(event_authority, &c.paused, config_change::ADMIN_PROPOSED, new_admin)
}

pub fn accept_admin(accounts: &[AccountView], _data: &[u8]) -> Result {
    let [new_admin, config, event_authority, _program] = take::<4>(accounts)?;
    signer(new_admin)?;
    let mut c = Config::load(config)?;
    singleton(config, c.bump, &CONFIG_PDA)?;
    mutable(config)?;
    require(c.pending_admin() == Some(new_admin.address()), E::Unauthorized)?;
    check_event_authority(event_authority)?;

    c.set_admin(new_admin.address());
    c.set_pending_admin(None)?;
    config_changed(event_authority, &c.paused, config_change::ADMIN_ACCEPTED, new_admin.address())
}

pub fn set_authorities(accounts: &[AccountView], data: &[u8]) -> Result {
    let mut args = Args(data);
    let risk_authorities = args.keys()?;
    let kyc_authority = args.key()?;
    let (mut c, event_authority) = admin_only(accounts)?;
    require(risk_authorities.len() <= MAX_RISK_AUTHORITIES, E::TooManyRiskAuthorities)?;
    require(!risk_authorities.contains(&Address::default()), E::InvalidParams)?;
    c.set_risk_authorities(risk_authorities)?;
    c.kyc_authority = *kyc_authority;
    let admin = *c.admin();
    config_changed(event_authority, &c.paused, config_change::AUTHORITIES, &admin)
}

pub fn set_params(accounts: &[AccountView], data: &[u8]) -> Result {
    let params = ConfigParams::read(&mut Args(data))?;
    let (mut c, event_authority) = admin_only(accounts)?;
    params.validate(Rent::get()?.minimum_balance(0))?;
    c.set_params(&params);
    let admin = *c.admin();
    config_changed(event_authority, &c.paused, config_change::PARAMS, &admin)
}

pub fn set_pauses(accounts: &[AccountView], data: &[u8]) -> Result {
    let paused = Pauses::read(&mut Args(data))?;
    let (mut c, event_authority) = admin_only(accounts)?;
    c.paused = paused;
    let admin = *c.admin();
    config_changed(event_authority, &c.paused, config_change::PAUSES, &admin)
}

/// Validation shared by `upsert_tier` / `upsert_market` after their `init_if_needed` account: admin (mut signer),
/// config (seeds, `has_one = admin @ Unauthorized`), event_authority.
fn upsert_constraints(admin: &AccountView, config: &AccountView, c: &Config, event_authority: &AccountView) -> Result {
    mutable(admin)?;
    singleton(config, c.bump, &CONFIG_PDA)?;
    keys_eq(c.admin(), admin.address(), E::Unauthorized)?;
    check_event_authority(event_authority)
}

pub fn upsert_tier(accounts: &[AccountView], data: &[u8]) -> Result {
    let mut args = Args(data);
    let id = args.u16()?;
    let params = TierParams::read(&mut args)?;
    let [admin, config, tier, system_program, event_authority, _program] = take::<6>(accounts)?;
    signer(admin)?;
    let c = Config::load(config)?;
    program_account(system_program, &SYSTEM_PROGRAM_ID)?;
    let (t, bump) = init_pda::<Tier>(admin, tier, &[TIER_SEED, &id.to_le_bytes()], true, &Rent::get()?)?;
    upsert_constraints(admin, config, &c, event_authority)?;

    params.validate()?;
    t.id.set(id);
    t.size_usd.set(params.size_usd);
    t.fee_usdc.set(params.fee_usdc);
    t.profit_target_bps.set(params.profit_target_bps);
    t.max_drawdown_bps.set(params.max_drawdown_bps);
    t.max_exposure_bps.set(params.max_exposure_bps);
    t.enabled.set(params.enabled);
    t.terms_hash = params.terms_hash;
    t.version.set(t.version.get().checked_add(1).ok_or(E::MathOverflow)?);
    t.bump = bump;
    config_changed(event_authority, &c.paused, config_change::TIER, tier.address())
}

pub fn upsert_market(accounts: &[AccountView], data: &[u8]) -> Result {
    let mut args = Args(data);
    let market_token = args.key()?;
    let params = MarketParams::read(&mut args)?;
    let [admin, config, market_config, gm_market, system_program, event_authority, _program] = take::<7>(accounts)?;
    signer(admin)?;
    let c = Config::load(config)?;
    program_account(system_program, &SYSTEM_PROGRAM_ID)?;
    let (m, bump) =
        init_pda::<MarketConfig>(admin, market_config, &[MARKET_SEED, market_token.as_ref()], true, &Rent::get()?)?;
    upsert_constraints(admin, config, &c, event_authority)?;

    params.validate()?;
    gmtrade::check_pure_usdc_market(gm_market, &c.gmtrade_program, &c.gmtrade_store, market_token, &c.usdc_mint)?;
    if m.market_token == Address::default() {
        m.market_token = *market_token;
        m.gm_market = *gm_market.address();
        m.bump = bump;
    }
    keys_eq(&m.gm_market, gm_market.address(), E::MarketMismatch)?;
    m.set_params(&params);
    config_changed(event_authority, &c.paused, config_change::MARKET, market_config.address())
}

/// `MoveCapital` (deposit_capital / withdraw_capital). Returns the config, the capital vault balance at load (Anchor
/// reads it before the transfer) and the USDC decimals.
fn move_capital(accounts: &[AccountView]) -> Result<(Config, u64, u8)> {
    let [admin, config, admin_usdc, vault, capital_vault, usdc_mint, token_program, event_authority, _program] =
        take::<9>(accounts)?;
    signer(admin)?;
    let c = Config::load(config)?;
    let admin_token = token_account(admin_usdc)?;
    let capital = token_account(capital_vault)?;
    let mint = mint_account(usdc_mint)?;
    program_account(token_program, &TOKEN_PROGRAM_ID)?;

    singleton(config, c.bump, &CONFIG_PDA)?;
    keys_eq(c.admin(), admin.address(), E::Unauthorized)?;
    mutable(admin_usdc)?;
    token_constraint(admin_token, usdc_mint.address(), admin.address())?;
    singleton(vault, c.vault_bump, &VAULT_PDA)?;
    mutable(capital_vault)?;
    keys_eq(capital_vault.address(), &c.capital_vault, E::ConstraintAddress)?;
    keys_eq(usdc_mint.address(), &c.usdc_mint, E::ConstraintAddress)?;
    check_event_authority(event_authority)?;
    Ok((c, capital.amount.get(), mint.decimals))
}

pub fn deposit_capital(accounts: &[AccountView], data: &[u8]) -> Result {
    let amount = Args(data).u64()?;
    let (_, balance, decimals) = move_capital(accounts)?;
    let [admin, _, admin_usdc, _, capital_vault, usdc_mint, _, event_authority, _] = take::<9>(accounts)?;
    require(amount > 0, E::InvalidAmount)?;
    transfer_checked(admin_usdc, usdc_mint, capital_vault, admin, amount, decimals, &[])?;
    let capital_vault_balance = balance.checked_add(amount).ok_or(E::MathOverflow)?;
    let mut e = event::<40>(disc::CAPITAL_DEPOSITED);
    e.u64(amount).u64(capital_vault_balance).i64(now()?);
    emit(event_authority, &e)
}

/// Withdraws unallocated capital. Principal already posted to funded accounts is not in the capital vault.
pub fn withdraw_capital(accounts: &[AccountView], data: &[u8]) -> Result {
    let amount = Args(data).u64()?;
    let (_, balance, decimals) = move_capital(accounts)?;
    let [_, _, admin_usdc, vault, capital_vault, usdc_mint, _, event_authority, _] = take::<9>(accounts)?;
    require(amount > 0 && amount <= balance, E::InvalidAmount)?;
    transfer_checked(capital_vault, usdc_mint, admin_usdc, vault, amount, decimals, &[&[VAULT_SEED, &[VAULT_PDA.1]]])?;
    let capital_vault_balance = balance.checked_sub(amount).ok_or(E::MathOverflow)?;
    let mut e = event::<72>(disc::CAPITAL_WITHDRAWN);
    e.u64(amount).key(admin_usdc.address()).u64(capital_vault_balance).i64(now()?);
    emit(event_authority, &e)
}

pub fn sweep_fees(accounts: &[AccountView], _data: &[u8]) -> Result {
    let [admin, config, vault, fee_vault, capital_vault, usdc_mint, token_program, event_authority, _program] =
        take::<9>(accounts)?;
    signer(admin)?;
    let c = Config::load(config)?;
    let fees = token_account(fee_vault)?;
    token_account(capital_vault)?;
    let mint = mint_account(usdc_mint)?;
    program_account(token_program, &TOKEN_PROGRAM_ID)?;

    singleton(config, c.bump, &CONFIG_PDA)?;
    keys_eq(c.admin(), admin.address(), E::Unauthorized)?;
    singleton(vault, c.vault_bump, &VAULT_PDA)?;
    singleton(fee_vault, c.fee_vault_bump, &FEE_VAULT_PDA)?;
    mutable(fee_vault)?;
    token_constraint(fees, usdc_mint.address(), vault.address())?;
    mutable(capital_vault)?;
    keys_eq(capital_vault.address(), &c.capital_vault, E::ConstraintAddress)?;
    keys_eq(usdc_mint.address(), &c.usdc_mint, E::ConstraintAddress)?;
    check_event_authority(event_authority)?;

    let amount = fees.amount.get();
    require(amount > 0, E::InvalidAmount)?;
    let decimals = mint.decimals;
    transfer_checked(fee_vault, usdc_mint, capital_vault, vault, amount, decimals, &[&[VAULT_SEED, &[VAULT_PDA.1]]])?;
    let mut e = event::<32>(disc::FEES_SWEPT);
    e.u64(amount).i64(now()?);
    emit(event_authority, &e)
}

/// Sends SOL from the treasury to the admin. The runtime keeps the treasury rent-exempt.
pub fn withdraw_sol_treasury(accounts: &[AccountView], data: &[u8]) -> Result {
    let lamports = Args(data).u64()?;
    let [admin, config, sol_treasury, system_program, event_authority, _program] = take::<6>(accounts)?;
    signer(admin)?;
    let c = Config::load(config)?;
    system_account(sol_treasury)?;
    program_account(system_program, &SYSTEM_PROGRAM_ID)?;

    mutable(admin)?;
    singleton(config, c.bump, &CONFIG_PDA)?;
    keys_eq(c.admin(), admin.address(), E::Unauthorized)?;
    singleton(sol_treasury, c.sol_treasury_bump, &SOL_TREASURY_PDA)?;
    mutable(sol_treasury)?;
    check_event_authority(event_authority)?;

    require(lamports > 0, E::InvalidAmount)?;
    transfer(sol_treasury, admin, lamports, &[&[SOL_TREASURY_SEED, &[SOL_TREASURY_PDA.1]]])?;
    let mut e = event::<64>(disc::SOL_TREASURY_WITHDRAWN);
    e.u64(lamports).key(admin.address()).i64(now()?);
    emit(event_authority, &e)
}
