use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    associated_token::{self, get_associated_token_address, AssociatedToken},
    token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked},
};

use super::now;
use crate::{errors::VaultError, events::*, gmtrade, state::*};

/// The account holds no slots or tracked orders, and every GMTrade position passed exists, belongs to
/// `owner` (verified by PDA seeds) and is flat.
fn require_flat(funded: &FundedAccount, positions: &[AccountInfo], config: &Config, owner: &Pubkey) -> Result<()> {
    require!(funded.is_flat(), VaultError::NotFlat);
    for ai in positions {
        let size = gmtrade::verified_position_size(ai, &config.gmtrade_program, &config.gmtrade_store, owner)?;
        require!(size == 0, VaultError::NotFlat);
    }
    Ok(())
}

fn transfer_from_owner<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    mint: &Account<'info, Mint>,
    owner_seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.clone(),
            TransferChecked { from: from.clone(), mint: mint.to_account_info(), to: to.clone(), authority: owner.clone() },
            &[owner_seeds],
        ),
        amount,
        mint.decimals,
    )
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey, identity_hash: [u8; 32])]
pub struct SetIdentity<'info> {
    #[account(mut)]
    pub kyc_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.kyc_authority == kyc_authority.key() @ VaultError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = kyc_authority,
        space = 8 + TraderProfile::INIT_SPACE,
        seeds = [TRADER_SEED, wallet.as_ref()],
        bump,
    )]
    pub profile: Box<Account<'info, TraderProfile>>,
    #[account(
        init,
        payer = kyc_authority,
        space = 8 + IdentityLock::INIT_SPACE,
        seeds = [IDENTITY_SEED, identity_hash.as_ref()],
        bump,
    )]
    pub identity_lock: Box<Account<'info, IdentityLock>>,
    pub system_program: Program<'info, System>,
}

/// Binds a verified identity to one wallet. The identity lock is `init`, so a person gets one wallet.
pub(crate) fn set_identity(ctx: Context<SetIdentity>, wallet: Pubkey, identity_hash: [u8; 32]) -> Result<()> {
    require!(identity_hash != [0; 32], VaultError::InvalidParams);
    let ts = now()?;
    let profile_key = ctx.accounts.profile.key();
    let p = &mut ctx.accounts.profile;
    require!(!p.is_verified(), VaultError::AlreadyVerified);
    if p.wallet == Pubkey::default() {
        p.wallet = wallet;
        p.bump = ctx.bumps.profile;
    }
    p.identity_hash = identity_hash;
    p.verified_at = ts;
    let lock = &mut ctx.accounts.identity_lock;
    lock.profile = profile_key;
    lock.bump = ctx.bumps.identity_lock;
    emit!(IdentitySet { profile: profile_key, wallet, identity_hash, ts });
    Ok(())
}

#[derive(Accounts)]
pub struct RecordEvaluationResult<'info> {
    pub risk_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.is_risk_authority(&risk_authority.key()) @ VaultError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [EVALUATION_SEED, evaluation.trader.as_ref(), &evaluation.index.to_le_bytes()],
        bump = evaluation.bump,
    )]
    pub evaluation: Box<Account<'info, Evaluation>>,
}

pub(crate) fn record_evaluation_result(
    ctx: Context<RecordEvaluationResult>,
    passed: bool,
    final_equity: i64,
    trades_root: [u8; 32],
) -> Result<()> {
    let e = &mut ctx.accounts.evaluation;
    require!(e.status == EvaluationStatus::Active, VaultError::InvalidEvaluationStatus);
    let ts = now()?;
    e.status = if passed { EvaluationStatus::Passed } else { EvaluationStatus::Failed };
    e.final_equity = final_equity;
    e.trades_root = trades_root;
    e.resolved_at = ts;
    emit!(EvaluationResolved { evaluation: e.key(), trader: e.trader, passed, final_equity, trades_root, ts });
    Ok(())
}

#[derive(Accounts)]
pub struct ApprovePayout<'info> {
    pub risk_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.is_risk_authority(&risk_authority.key()) @ VaultError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [FUNDED_SEED, funded.evaluation.as_ref()], bump = funded.bump)]
    pub funded: Box<Account<'info, FundedAccount>>,
    #[account(
        mut,
        seeds = [PAYOUT_SEED, funded.key().as_ref(), &payout.seq.to_le_bytes()],
        bump = payout.bump,
        has_one = funded @ VaultError::Unauthorized,
    )]
    pub payout: Box<Account<'info, PayoutRequest>>,
    #[account(mut, seeds = [OWNER_SEED, funded.key().as_ref()], bump = funded.owner_bump)]
    pub owner: SystemAccount<'info>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: the funded account's registered trader wallet.
    #[account(address = funded.trader @ VaultError::Unauthorized)]
    pub trader: UncheckedAccount<'info>,
    /// CHECK: the trader's USDC ATA (address checked in the handler to keep this frame small); created,
    /// paid by the SOL treasury, if missing.
    #[account(mut)]
    pub trader_usdc: UncheckedAccount<'info>,
    #[account(mut, address = config.capital_vault)]
    pub capital_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [SOL_TREASURY_SEED], bump = config.sol_treasury_bump)]
    pub sol_treasury: SystemAccount<'info>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Pays a requested payout: trader share to the trader's USDC ATA, vault share to the capital vault.
/// Remaining accounts: GMTrade positions of the owner PDA to re-check as flat.
pub(crate) fn approve_payout<'info>(ctx: Context<'_, '_, 'info, 'info, ApprovePayout<'info>>) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.config.paused.payouts, VaultError::Paused);
    require!(a.payout.status == PayoutStatus::Requested, VaultError::InvalidPayoutStatus);
    require!(a.funded.status == FundedStatus::PayoutPending, VaultError::InvalidAccountStatus);
    require_flat(&a.funded, ctx.remaining_accounts, &a.config, &a.owner.key())?;
    require!(a.owner_usdc.amount >= a.payout.balance_at_request, VaultError::BalanceChanged);
    require_keys_eq!(
        a.trader_usdc.key(),
        get_associated_token_address(&a.funded.trader, &a.config.usdc_mint),
        VaultError::Unauthorized
    );

    associated_token::create_idempotent(CpiContext::new_with_signer(
        a.associated_token_program.to_account_info(),
        associated_token::Create {
            payer: a.sol_treasury.to_account_info(),
            associated_token: a.trader_usdc.to_account_info(),
            authority: a.trader.to_account_info(),
            mint: a.usdc_mint.to_account_info(),
            system_program: a.system_program.to_account_info(),
            token_program: a.token_program.to_account_info(),
        },
        &[&[SOL_TREASURY_SEED, &[a.config.sol_treasury_bump]]],
    ))?;
    let funded_key = a.funded.key();
    let owner_seeds: &[&[u8]] = &[OWNER_SEED, funded_key.as_ref(), &[a.funded.owner_bump]];
    let token_program = a.token_program.to_account_info();
    let owner_usdc = a.owner_usdc.to_account_info();
    let owner = a.owner.to_account_info();
    let (trader_amount, vault_amount) = (a.payout.trader_amount, a.payout.vault_amount);
    transfer_from_owner(&token_program, &owner_usdc, &a.trader_usdc, &owner, &a.usdc_mint, owner_seeds, trader_amount)?;
    transfer_from_owner(&token_program, &owner_usdc, &a.capital_vault.to_account_info(), &owner, &a.usdc_mint, owner_seeds, vault_amount)?;

    let ts = now()?;
    let trader = a.funded.trader;
    let f = &mut ctx.accounts.funded;
    f.status = FundedStatus::Active;
    f.payouts_paid = f.payouts_paid.checked_add(trader_amount).ok_or(VaultError::MathOverflow)?;
    let p = &mut ctx.accounts.payout;
    p.status = PayoutStatus::Paid;
    p.resolved_at = ts;
    let request = p.key();
    let c = &mut ctx.accounts.config;
    c.payouts_paid = c.payouts_paid.checked_add(trader_amount).ok_or(VaultError::MathOverflow)?;
    c.profit_to_vault = c.profit_to_vault.checked_add(vault_amount).ok_or(VaultError::MathOverflow)?;
    emit!(PayoutPaid { funded: funded_key, request, trader, trader_amount, vault_amount, ts });
    Ok(())
}

#[derive(Accounts)]
pub struct RejectPayout<'info> {
    pub risk_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.is_risk_authority(&risk_authority.key()) @ VaultError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [FUNDED_SEED, funded.evaluation.as_ref()], bump = funded.bump)]
    pub funded: Box<Account<'info, FundedAccount>>,
    #[account(
        mut,
        seeds = [PAYOUT_SEED, funded.key().as_ref(), &payout.seq.to_le_bytes()],
        bump = payout.bump,
        has_one = funded @ VaultError::Unauthorized,
    )]
    pub payout: Box<Account<'info, PayoutRequest>>,
}

pub(crate) fn reject_payout(ctx: Context<RejectPayout>, reason_code: u16) -> Result<()> {
    require!(ctx.accounts.payout.status == PayoutStatus::Requested, VaultError::InvalidPayoutStatus);
    require!(ctx.accounts.funded.status == FundedStatus::PayoutPending, VaultError::InvalidAccountStatus);
    let ts = now()?;
    ctx.accounts.funded.status = FundedStatus::Active;
    let p = &mut ctx.accounts.payout;
    p.status = PayoutStatus::Rejected;
    p.reason_code = reason_code;
    p.resolved_at = ts;
    emit!(PayoutRejected { funded: p.funded, request: p.key(), reason_code, ts });
    Ok(())
}

#[derive(Accounts)]
pub struct RiskFunded<'info> {
    pub risk_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.is_risk_authority(&risk_authority.key()) @ VaultError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [FUNDED_SEED, funded.evaluation.as_ref()], bump = funded.bump)]
    pub funded: Box<Account<'info, FundedAccount>>,
}

/// Restricted accounts can only reduce risk (close, cancel, protect).
pub(crate) fn restrict(ctx: Context<RiskFunded>, restricted: bool) -> Result<()> {
    let f = &mut ctx.accounts.funded;
    let (from, to) = if restricted {
        (FundedStatus::Active, FundedStatus::Restricted)
    } else {
        (FundedStatus::Restricted, FundedStatus::Active)
    };
    require!(f.status == from, VaultError::InvalidAccountStatus);
    f.status = to;
    emit!(AccountRestricted { funded: f.key(), restricted, ts: now()? });
    Ok(())
}

pub(crate) fn mark_breached(ctx: Context<RiskFunded>) -> Result<()> {
    let f = &mut ctx.accounts.funded;
    require!(
        matches!(f.status, FundedStatus::Active | FundedStatus::Restricted),
        VaultError::InvalidAccountStatus
    );
    f.status = FundedStatus::Breached;
    emit!(AccountBreached { funded: f.key(), ts: now()? });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseFunded<'info> {
    pub risk_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.is_risk_authority(&risk_authority.key()) @ VaultError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [FUNDED_SEED, funded.evaluation.as_ref()], bump = funded.bump)]
    pub funded: Box<Account<'info, FundedAccount>>,
    #[account(mut, seeds = [TRADER_SEED, funded.trader.as_ref()], bump = profile.bump)]
    pub profile: Box<Account<'info, TraderProfile>>,
    #[account(mut, seeds = [OWNER_SEED, funded.key().as_ref()], bump = funded.owner_bump)]
    pub owner: SystemAccount<'info>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.capital_vault)]
    pub capital_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [SOL_TREASURY_SEED], bump = config.sol_treasury_bump)]
    pub sol_treasury: SystemAccount<'info>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Closes a flat funded account: its USDC returns to the capital vault, its SOL and ATA rent to the
/// SOL treasury, and its principal is released. Remaining accounts: owner positions to re-check.
pub(crate) fn close_funded<'info>(ctx: Context<'_, '_, 'info, 'info, CloseFunded<'info>>) -> Result<()> {
    let a = &ctx.accounts;
    require!(
        matches!(a.funded.status, FundedStatus::Active | FundedStatus::Restricted | FundedStatus::Breached),
        VaultError::InvalidAccountStatus
    );
    require_flat(&a.funded, ctx.remaining_accounts, &a.config, &a.owner.key())?;

    let funded_key = a.funded.key();
    let owner_seeds: &[&[u8]] = &[OWNER_SEED, funded_key.as_ref(), &[a.funded.owner_bump]];
    let owner = a.owner.to_account_info();
    let usdc_returned = a.owner_usdc.amount;
    transfer_from_owner(
        &a.token_program.to_account_info(),
        &a.owner_usdc.to_account_info(),
        &a.capital_vault.to_account_info(),
        &owner,
        &a.usdc_mint,
        owner_seeds,
        usdc_returned,
    )?;
    token::close_account(CpiContext::new_with_signer(
        a.token_program.to_account_info(),
        CloseAccount {
            account: a.owner_usdc.to_account_info(),
            destination: a.sol_treasury.to_account_info(),
            authority: owner.clone(),
        },
        &[owner_seeds],
    ))?;
    let lamports_returned = owner.lamports();
    if lamports_returned > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                a.system_program.to_account_info(),
                system_program::Transfer { from: owner, to: a.sol_treasury.to_account_info() },
                &[owner_seeds],
            ),
            lamports_returned,
        )?;
    }

    let principal = a.funded.principal;
    ctx.accounts.funded.status = FundedStatus::Closed;
    ctx.accounts.profile.active_funded = 0;
    let c = &mut ctx.accounts.config;
    c.allocated_principal = c.allocated_principal.checked_sub(principal).ok_or(VaultError::MathOverflow)?;
    c.funded_active = c.funded_active.checked_sub(1).ok_or(VaultError::MathOverflow)?;
    emit!(AccountClosed { funded: funded_key, principal, usdc_returned, lamports_returned, ts: now()? });
    Ok(())
}
