//! Port of programs/props_vault/src/instructions/trader.rs (see PORTING.md). Each handler validates in Anchor's order:
//! account types in field order, then `init` fields, then the remaining constraints in field order, then the handler
//! body.
use pinocchio::{AccountView, Address};

use super::trading::{funded_seeds, owner_seeds};
use crate::{
    accounts::{
        associated_token_constraint, ata_address, check_event_authority, find_seeds, keys_eq, mint_account, mutable,
        now, program_account, seeds, signer, singleton, system_account, take, token_account, token_constraint, Args,
        Rent, ATA_PROGRAM_ID, CONFIG_PDA, FEE_VAULT_PDA, SOL_TREASURY_PDA, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
        VAULT_PDA,
    },
    cpi::{create_ata, init_pda, top_up_from_treasury, transfer_checked},
    error::{require, Result, E},
    events::{disc, emit, event},
    state::{
        apply_bps, evaluation_status, funded_status, load, payout_status, Config, Evaluation, FundedAccount,
        PayoutRequest, Terms, Tier, TraderProfile, EVALUATION_SEED, FUNDED_SEED, OWNER_SEED, PAYOUT_SEED, TIER_SEED,
        TRADER_SEED, VAULT_SEED,
    },
};

/// `seeds = [PAYOUT_SEED, funded.key().as_ref(), &payout.seq.to_le_bytes()], bump = payout.bump`.
pub(crate) fn payout_seeds(payout: &AccountView, funded: &AccountView, p: &PayoutRequest) -> Result {
    seeds(payout, &[PAYOUT_SEED, funded.address().as_ref(), &p.seq.get().to_le_bytes(), &[p.bump]])
}

/// Pays the tier fee and creates the evaluation in one transaction. `index` must be the profile's evaluation count (0
/// for a new trader). The fee and tier version are the ones the trader reviewed: an `upsert_tier` landing between
/// review and purchase (it bumps the version) makes the purchase fail.
pub fn buy_evaluation(accounts: &[AccountView], data: &[u8]) -> Result {
    let mut args = Args(data);
    let tier_id = args.u16()?;
    let index = args.u32()?;
    let expected_fee_usdc = args.u64()?;
    let expected_tier_version = args.u32()?;
    #[rustfmt::skip]
    let [
        trader, config, tier, profile, evaluation, trader_usdc, fee_vault, usdc_mint, token_program, system_program,
        event_authority, _program,
    ] = take::<12>(accounts)?;
    signer(trader)?;
    let mut c = Config::load(config)?;
    let t = load::<Tier>(tier)?;
    let trader_token = token_account(trader_usdc)?;
    token_account(fee_vault)?;
    let decimals = mint_account(usdc_mint)?.decimals;
    program_account(token_program, &TOKEN_PROGRAM_ID)?;
    program_account(system_program, &SYSTEM_PROGRAM_ID)?;

    let rent = Rent::get()?;
    let (p, profile_bump) =
        init_pda::<TraderProfile>(trader, profile, &[TRADER_SEED, trader.address().as_ref()], true, &rent)?;
    let evaluation_seeds: &[&[u8]] = &[EVALUATION_SEED, trader.address().as_ref(), &index.to_le_bytes()];
    let (e, evaluation_bump) = init_pda::<Evaluation>(trader, evaluation, evaluation_seeds, false, &rent)?;

    mutable(trader)?;
    singleton(config, c.bump, &CONFIG_PDA)?;
    mutable(config)?;
    seeds(tier, &[TIER_SEED, &tier_id.to_le_bytes(), &[t.bump]])?;
    mutable(trader_usdc)?;
    token_constraint(trader_token, usdc_mint.address(), trader.address())?;
    singleton(fee_vault, c.fee_vault_bump, &FEE_VAULT_PDA)?;
    mutable(fee_vault)?;
    keys_eq(usdc_mint.address(), &c.usdc_mint, E::ConstraintAddress)?;
    check_event_authority(event_authority)?;

    require(!c.paused.new_evaluations.get(), E::Paused)?;
    require(t.enabled.get(), E::TierDisabled)?;
    require(index == p.evaluation_count.get(), E::InvalidParams)?;
    require(t.fee_usdc.get() == expected_fee_usdc && t.version.get() == expected_tier_version, E::TierChanged)?;
    let fee = t.fee_usdc.get();
    transfer_checked(trader_usdc, usdc_mint, fee_vault, trader, fee, decimals, &[])?;

    let terms = Terms {
        size_usd: t.size_usd,
        profit_target_bps: t.profit_target_bps,
        max_drawdown_bps: t.max_drawdown_bps,
        max_exposure_bps: t.max_exposure_bps,
        trader_share_bps: c.trader_share_bps,
        terms_hash: t.terms_hash,
        tier_version: t.version,
    };
    let ts = now()?;

    if p.wallet == Address::default() {
        p.wallet = *trader.address();
        p.bump = profile_bump;
    }
    p.evaluation_count.set(p.evaluation_count.get().checked_add(1).ok_or(E::MathOverflow)?);

    e.trader = *trader.address();
    e.index.set(index);
    e.tier_id.set(tier_id);
    e.terms = terms;
    e.fee_paid.set(fee);
    e.status = evaluation_status::ACTIVE;
    e.created_at.set(ts);
    e.bump = evaluation_bump;

    let c = &mut *c;
    c.fees_collected.set(c.fees_collected.get().checked_add(fee).ok_or(E::MathOverflow)?);
    c.evaluations_sold.set(c.evaluations_sold.get().checked_add(1).ok_or(E::MathOverflow)?);
    let mut ev = event::<102>(disc::EVALUATION_PURCHASED);
    ev.key(evaluation.address()).key(trader.address()).u16(tier_id).u32(terms.tier_version.get()).u64(fee).i64(ts);
    emit(event_authority, &ev)
}

/// Creates the funded account for a passed evaluation and posts its principal L = S × max drawdown to the owner PDA,
/// which stays data-less and system-owned (it only receives SOL and pays its USDC account's rent).
pub fn activate_funded(accounts: &[AccountView], _data: &[u8]) -> Result {
    #[rustfmt::skip]
    let [
        trader, config, profile, evaluation, funded, owner, owner_usdc, vault, capital_vault, sol_treasury, usdc_mint,
        token_program, associated_token_program, system_program, event_authority, _program,
    ] = take::<16>(accounts)?;
    signer(trader)?;
    let mut c = Config::load(config)?;
    let p = load::<TraderProfile>(profile)?;
    let e = load::<Evaluation>(evaluation)?;
    system_account(owner)?;
    // Anchor keeps the balance from load time; the transfer below changes the live one.
    let capital = token_account(capital_vault)?.amount.get();
    system_account(sol_treasury)?;
    let decimals = mint_account(usdc_mint)?.decimals;
    program_account(token_program, &TOKEN_PROGRAM_ID)?;
    program_account(associated_token_program, &ATA_PROGRAM_ID)?;
    program_account(system_program, &SYSTEM_PROGRAM_ID)?;

    let funded_seeds: &[&[u8]] = &[FUNDED_SEED, evaluation.address().as_ref()];
    let (f, funded_bump) = init_pda::<FundedAccount>(trader, funded, funded_seeds, false, &Rent::get()?)?;

    mutable(trader)?;
    singleton(config, c.bump, &CONFIG_PDA)?;
    mutable(config)?;
    seeds(profile, &[TRADER_SEED, trader.address().as_ref(), &[p.bump]])?;
    mutable(profile)?;
    seeds(evaluation, &[EVALUATION_SEED, trader.address().as_ref(), &e.index.get().to_le_bytes(), &[e.bump]])?;
    mutable(evaluation)?;
    keys_eq(&e.trader, trader.address(), E::Unauthorized)?;
    let owner_bump = find_seeds(owner, &[OWNER_SEED, funded.address().as_ref()])?;
    mutable(owner)?;
    mutable(owner_usdc)?;
    keys_eq(owner_usdc.address(), &ata_address(owner.address(), usdc_mint.address()), E::ConstraintAddress)?;
    singleton(vault, c.vault_bump, &VAULT_PDA)?;
    mutable(capital_vault)?;
    keys_eq(capital_vault.address(), &c.capital_vault, E::ConstraintAddress)?;
    singleton(sol_treasury, c.sol_treasury_bump, &SOL_TREASURY_PDA)?;
    mutable(sol_treasury)?;
    keys_eq(usdc_mint.address(), &c.usdc_mint, E::ConstraintAddress)?;
    check_event_authority(event_authority)?;

    require(!c.paused.trading.get(), E::Paused)?;
    require(e.status == evaluation_status::PASSED, E::InvalidEvaluationStatus)?;
    require(p.is_verified(), E::NotVerified)?;
    require(p.active_funded == 0, E::AlreadyFunded)?;
    let principal = e.terms.loss_allowance()?;
    require(principal > 0, E::InvalidAmount)?;
    require(capital >= principal, E::InsufficientCapital)?;

    let owner_seeds: &[&[u8]] = &[OWNER_SEED, funded.address().as_ref(), &[owner_bump]];
    top_up_from_treasury(sol_treasury, owner, c.sol_treasury_bump, c.owner_sol_target.get())?;
    create_ata(owner, owner_usdc, owner, usdc_mint, system_program, token_program, true, &[owner_seeds])?;
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, &[c.vault_bump]];
    transfer_checked(capital_vault, usdc_mint, owner_usdc, vault, principal, decimals, &[vault_seeds])?;

    let ts = now()?;
    let owner_lamports = owner.lamports();
    f.trader = *trader.address();
    f.evaluation = *evaluation.address();
    f.terms = e.terms;
    f.principal.set(principal);
    f.status = funded_status::ACTIVE;
    f.created_at.set(ts);
    f.bump = funded_bump;
    f.owner_bump = owner_bump;

    e.status = evaluation_status::FUNDED;
    p.active_funded = 1;
    let c = &mut *c;
    c.allocate_daily_principal(principal, ts)?;
    c.allocated_principal.set(c.allocated_principal.get().checked_add(principal).ok_or(E::MathOverflow)?);
    c.funded_activated.set(c.funded_activated.get().checked_add(1).ok_or(E::MathOverflow)?);
    c.funded_active.set(c.funded_active.get().checked_add(1).ok_or(E::MathOverflow)?);
    let mut ev = event::<168>(disc::FUNDED_ACTIVATED);
    ev.key(funded.address())
        .key(evaluation.address())
        .key(trader.address())
        .key(owner.address())
        .u64(principal)
        .u64(owner_lamports)
        .i64(ts);
    emit(event_authority, &ev)
}

/// Requests the trader's share of realized profit (owner USDC above principal). Requires a flat account as of the last
/// sync; blocks new positions until resolved.
pub fn request_payout(accounts: &[AccountView], _data: &[u8]) -> Result {
    let [trader, config, funded, owner, owner_usdc, usdc_mint, payout, system_program, event_authority, _program] =
        take::<10>(accounts)?;
    signer(trader)?;
    let c = Config::load(config)?;
    let f = load::<FundedAccount>(funded)?;
    system_account(owner)?;
    let usdc = token_account(owner_usdc)?;
    mint_account(usdc_mint)?;
    program_account(system_program, &SYSTEM_PROGRAM_ID)?;

    let request_seeds: &[&[u8]] = &[PAYOUT_SEED, funded.address().as_ref(), &f.payout_seq.get().to_le_bytes()];
    let (p, payout_bump) = init_pda::<PayoutRequest>(trader, payout, request_seeds, false, &Rent::get()?)?;

    mutable(trader)?;
    singleton(config, c.bump, &CONFIG_PDA)?;
    funded_seeds(funded, f)?;
    mutable(funded)?;
    keys_eq(&f.trader, trader.address(), E::Unauthorized)?;
    owner_seeds(owner, funded, f)?;
    associated_token_constraint(owner_usdc, usdc, owner.address(), usdc_mint.address())?;
    keys_eq(usdc_mint.address(), &c.usdc_mint, E::ConstraintAddress)?;
    check_event_authority(event_authority)?;

    require(!c.paused.payouts.get(), E::Paused)?;
    require(f.status == funded_status::ACTIVE, E::InvalidAccountStatus)?;
    require(f.is_flat(), E::NotFlat)?;
    let balance = usdc.amount.get();
    let profit = balance.saturating_sub(f.principal.get());
    require(profit > 0, E::NoProfit)?;
    let trader_amount = apply_bps(profit, f.terms.trader_share_bps.get())?;
    require(trader_amount >= c.min_payout.get(), E::BelowMinPayout)?;
    let vault_amount = profit.checked_sub(trader_amount).ok_or(E::MathOverflow)?;
    let ts = now()?;

    let seq = f.payout_seq.get();
    f.payout_seq.set(seq.checked_add(1).ok_or(E::MathOverflow)?);
    f.status = funded_status::PAYOUT_PENDING;

    p.funded = *funded.address();
    p.trader = *trader.address();
    p.seq.set(seq);
    p.balance_at_request.set(balance);
    p.profit.set(profit);
    p.trader_amount.set(trader_amount);
    p.vault_amount.set(vault_amount);
    p.status = payout_status::REQUESTED;
    p.created_at.set(ts);
    p.bump = payout_bump;
    // 168 (≥ 16 + 108): an `N` activate_funded already instantiates (PORTING.md "Size notes").
    let mut e = event::<168>(disc::PAYOUT_REQUESTED);
    e.key(funded.address())
        .key(payout.address())
        .u32(seq)
        .u64(balance)
        .u64(profit)
        .u64(trader_amount)
        .u64(vault_amount)
        .i64(ts);
    emit(event_authority, &e)
}

pub fn cancel_payout(accounts: &[AccountView], _data: &[u8]) -> Result {
    let [trader, funded, payout, event_authority, _program] = take::<5>(accounts)?;
    signer(trader)?;
    let f = load::<FundedAccount>(funded)?;
    let p = load::<PayoutRequest>(payout)?;

    funded_seeds(funded, f)?;
    mutable(funded)?;
    keys_eq(&f.trader, trader.address(), E::Unauthorized)?;
    payout_seeds(payout, funded, p)?;
    mutable(payout)?;
    keys_eq(&p.funded, funded.address(), E::Unauthorized)?;
    check_event_authority(event_authority)?;

    require(p.status == payout_status::REQUESTED, E::InvalidPayoutStatus)?;
    require(f.status == funded_status::PAYOUT_PENDING, E::InvalidAccountStatus)?;
    let ts = now()?;
    f.status = funded_status::ACTIVE;
    p.status = payout_status::CANCELLED;
    p.resolved_at.set(ts);
    // 102 (≥ 16 + 72): an `N` buy_evaluation already instantiates.
    let mut e = event::<102>(disc::PAYOUT_CANCELLED);
    e.key(&p.funded).key(payout.address()).i64(ts);
    emit(event_authority, &e)
}
