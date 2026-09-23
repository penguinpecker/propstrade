use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    associated_token::{self, get_associated_token_address, AssociatedToken},
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

use super::now;
use crate::{errors::VaultError, events::*, state::*};

/// Moves SOL from the treasury so the owner PDA holds at least `target` lamports.
pub(crate) fn top_up_from_treasury<'info>(
    system_program: &AccountInfo<'info>,
    sol_treasury: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    treasury_bump: u8,
    target: u64,
) -> Result<u64> {
    let amount = target.saturating_sub(owner.lamports());
    if amount > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                system_program.clone(),
                system_program::Transfer { from: sol_treasury.clone(), to: owner.clone() },
                &[&[SOL_TREASURY_SEED, &[treasury_bump]]],
            ),
            amount,
        )?;
    }
    Ok(amount)
}

#[derive(Accounts)]
#[instruction(tier_id: u16, index: u32)]
pub struct BuyEvaluation<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [TIER_SEED, &tier_id.to_le_bytes()], bump = tier.bump)]
    pub tier: Box<Account<'info, Tier>>,
    #[account(
        init_if_needed,
        payer = trader,
        space = 8 + TraderProfile::INIT_SPACE,
        seeds = [TRADER_SEED, trader.key().as_ref()],
        bump,
    )]
    pub profile: Box<Account<'info, TraderProfile>>,
    #[account(
        init,
        payer = trader,
        space = 8 + Evaluation::INIT_SPACE,
        seeds = [EVALUATION_SEED, trader.key().as_ref(), &index.to_le_bytes()],
        bump,
    )]
    pub evaluation: Box<Account<'info, Evaluation>>,
    #[account(mut, token::mint = usdc_mint, token::authority = trader)]
    pub trader_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [FEE_VAULT_SEED], bump = config.fee_vault_bump)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Pays the tier fee and creates the evaluation in one transaction. `index` must be the profile's
/// evaluation count (0 for a new trader).
pub(crate) fn buy_evaluation(ctx: Context<BuyEvaluation>, tier_id: u16, index: u32) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.config.paused.new_evaluations, VaultError::Paused);
    require!(a.tier.enabled, VaultError::TierDisabled);
    require!(index == a.profile.evaluation_count, VaultError::InvalidParams);
    let fee = a.tier.fee_usdc;
    token::transfer_checked(
        CpiContext::new(
            a.token_program.to_account_info(),
            TransferChecked {
                from: a.trader_usdc.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.fee_vault.to_account_info(),
                authority: a.trader.to_account_info(),
            },
        ),
        fee,
        a.usdc_mint.decimals,
    )?;

    let trader = a.trader.key();
    let terms = Terms {
        size_usd: a.tier.size_usd,
        profit_target_bps: a.tier.profit_target_bps,
        max_drawdown_bps: a.tier.max_drawdown_bps,
        max_exposure_bps: a.tier.max_exposure_bps,
        trader_share_bps: a.config.trader_share_bps,
        terms_hash: a.tier.terms_hash,
        tier_version: a.tier.version,
    };
    let ts = now()?;

    let profile = &mut ctx.accounts.profile;
    if profile.wallet == Pubkey::default() {
        profile.wallet = trader;
        profile.bump = ctx.bumps.profile;
    }
    profile.evaluation_count = profile.evaluation_count.checked_add(1).ok_or(VaultError::MathOverflow)?;

    let e = &mut ctx.accounts.evaluation;
    e.trader = trader;
    e.index = index;
    e.tier_id = tier_id;
    e.terms = terms;
    e.fee_paid = fee;
    e.status = EvaluationStatus::Active;
    e.created_at = ts;
    e.bump = ctx.bumps.evaluation;

    let c = &mut ctx.accounts.config;
    c.fees_collected = c.fees_collected.checked_add(fee).ok_or(VaultError::MathOverflow)?;
    c.evaluations_sold = c.evaluations_sold.checked_add(1).ok_or(VaultError::MathOverflow)?;
    emit!(EvaluationPurchased {
        evaluation: e.key(),
        trader,
        tier_id,
        tier_version: terms.tier_version,
        fee_paid: fee,
        ts,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ActivateFunded<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [TRADER_SEED, trader.key().as_ref()], bump = profile.bump)]
    pub profile: Box<Account<'info, TraderProfile>>,
    #[account(
        mut,
        seeds = [EVALUATION_SEED, trader.key().as_ref(), &evaluation.index.to_le_bytes()],
        bump = evaluation.bump,
        has_one = trader @ VaultError::Unauthorized,
    )]
    pub evaluation: Box<Account<'info, Evaluation>>,
    #[account(
        init,
        payer = trader,
        space = 8 + FundedAccount::INIT_SPACE,
        seeds = [FUNDED_SEED, evaluation.key().as_ref()],
        bump,
    )]
    pub funded: Box<Account<'info, FundedAccount>>,
    #[account(mut, seeds = [OWNER_SEED, funded.key().as_ref()], bump)]
    pub owner: SystemAccount<'info>,
    /// CHECK: the owner PDA's USDC ATA, created here.
    #[account(mut, address = get_associated_token_address(&owner.key(), &usdc_mint.key()))]
    pub owner_usdc: UncheckedAccount<'info>,
    /// CHECK: vault authority PDA.
    #[account(seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
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

/// Creates the funded account for a passed evaluation and posts its principal L = S × max drawdown.
pub(crate) fn activate_funded(ctx: Context<ActivateFunded>) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.config.paused.trading, VaultError::Paused);
    require!(a.evaluation.status == EvaluationStatus::Passed, VaultError::InvalidEvaluationStatus);
    require!(a.profile.is_verified(), VaultError::NotVerified);
    require!(a.profile.active_funded == 0, VaultError::AlreadyFunded);
    let principal = a.evaluation.terms.loss_allowance()?;
    require!(principal > 0, VaultError::InvalidAmount);
    require!(a.capital_vault.amount >= principal, VaultError::InsufficientCapital);

    let funded_key = a.funded.key();
    let owner_bump = ctx.bumps.owner;
    let owner_seeds: &[&[u8]] = &[OWNER_SEED, funded_key.as_ref(), &[owner_bump]];
    top_up_from_treasury(
        &a.system_program.to_account_info(),
        &a.sol_treasury.to_account_info(),
        &a.owner.to_account_info(),
        a.config.sol_treasury_bump,
        a.config.owner_sol_target,
    )?;
    associated_token::create_idempotent(CpiContext::new_with_signer(
        a.associated_token_program.to_account_info(),
        associated_token::Create {
            payer: a.owner.to_account_info(),
            associated_token: a.owner_usdc.to_account_info(),
            authority: a.owner.to_account_info(),
            mint: a.usdc_mint.to_account_info(),
            system_program: a.system_program.to_account_info(),
            token_program: a.token_program.to_account_info(),
        },
        &[owner_seeds],
    ))?;
    token::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            TransferChecked {
                from: a.capital_vault.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.owner_usdc.to_account_info(),
                authority: a.vault.to_account_info(),
            },
            &[&[VAULT_SEED, &[a.config.vault_bump]]],
        ),
        principal,
        a.usdc_mint.decimals,
    )?;

    let ts = now()?;
    let owner = a.owner.key();
    let owner_lamports = a.owner.lamports();
    let trader = a.trader.key();
    let evaluation = a.evaluation.key();
    let terms = a.evaluation.terms;

    let f = &mut ctx.accounts.funded;
    f.trader = trader;
    f.evaluation = evaluation;
    f.terms = terms;
    f.principal = principal;
    f.status = FundedStatus::Active;
    f.created_at = ts;
    f.bump = ctx.bumps.funded;
    f.owner_bump = owner_bump;

    ctx.accounts.evaluation.status = EvaluationStatus::Funded;
    ctx.accounts.profile.active_funded = 1;
    let c = &mut ctx.accounts.config;
    c.allocated_principal = c.allocated_principal.checked_add(principal).ok_or(VaultError::MathOverflow)?;
    c.funded_activated = c.funded_activated.checked_add(1).ok_or(VaultError::MathOverflow)?;
    c.funded_active = c.funded_active.checked_add(1).ok_or(VaultError::MathOverflow)?;
    emit!(FundedActivated { funded: funded_key, evaluation, trader, owner, principal, owner_lamports, ts });
    Ok(())
}

#[derive(Accounts)]
pub struct RequestPayout<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [FUNDED_SEED, funded.evaluation.as_ref()],
        bump = funded.bump,
        has_one = trader @ VaultError::Unauthorized,
    )]
    pub funded: Box<Account<'info, FundedAccount>>,
    #[account(seeds = [OWNER_SEED, funded.key().as_ref()], bump = funded.owner_bump)]
    pub owner: SystemAccount<'info>,
    #[account(associated_token::mint = usdc_mint, associated_token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = trader,
        space = 8 + PayoutRequest::INIT_SPACE,
        seeds = [PAYOUT_SEED, funded.key().as_ref(), &funded.payout_seq.to_le_bytes()],
        bump,
    )]
    pub payout: Box<Account<'info, PayoutRequest>>,
    pub system_program: Program<'info, System>,
}

/// Requests the trader's share of realized profit (owner USDC above principal). Requires a flat account
/// as of the last sync; blocks new positions until resolved.
pub(crate) fn request_payout(ctx: Context<RequestPayout>) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.config.paused.payouts, VaultError::Paused);
    require!(a.funded.status == FundedStatus::Active, VaultError::InvalidAccountStatus);
    require!(a.funded.is_flat(), VaultError::NotFlat);
    let balance = a.owner_usdc.amount;
    let profit = balance.saturating_sub(a.funded.principal);
    require!(profit > 0, VaultError::NoProfit);
    let trader_amount = apply_bps(profit, a.funded.terms.trader_share_bps)?;
    require!(trader_amount >= a.config.min_payout, VaultError::BelowMinPayout);
    let vault_amount = profit.checked_sub(trader_amount).ok_or(VaultError::MathOverflow)?;
    let ts = now()?;
    let funded_key = a.funded.key();
    let trader = a.trader.key();

    let f = &mut ctx.accounts.funded;
    let seq = f.payout_seq;
    f.payout_seq = seq.checked_add(1).ok_or(VaultError::MathOverflow)?;
    f.status = FundedStatus::PayoutPending;

    let p = &mut ctx.accounts.payout;
    p.funded = funded_key;
    p.trader = trader;
    p.seq = seq;
    p.balance_at_request = balance;
    p.profit = profit;
    p.trader_amount = trader_amount;
    p.vault_amount = vault_amount;
    p.status = PayoutStatus::Requested;
    p.created_at = ts;
    p.bump = ctx.bumps.payout;
    emit!(PayoutRequested { funded: funded_key, request: p.key(), seq, balance, profit, trader_amount, vault_amount, ts });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelPayout<'info> {
    pub trader: Signer<'info>,
    #[account(
        mut,
        seeds = [FUNDED_SEED, funded.evaluation.as_ref()],
        bump = funded.bump,
        has_one = trader @ VaultError::Unauthorized,
    )]
    pub funded: Box<Account<'info, FundedAccount>>,
    #[account(
        mut,
        seeds = [PAYOUT_SEED, funded.key().as_ref(), &payout.seq.to_le_bytes()],
        bump = payout.bump,
        has_one = funded @ VaultError::Unauthorized,
    )]
    pub payout: Box<Account<'info, PayoutRequest>>,
}

pub(crate) fn cancel_payout(ctx: Context<CancelPayout>) -> Result<()> {
    require!(ctx.accounts.payout.status == PayoutStatus::Requested, VaultError::InvalidPayoutStatus);
    require!(ctx.accounts.funded.status == FundedStatus::PayoutPending, VaultError::InvalidAccountStatus);
    let ts = now()?;
    ctx.accounts.funded.status = FundedStatus::Active;
    let p = &mut ctx.accounts.payout;
    p.status = PayoutStatus::Cancelled;
    p.resolved_at = ts;
    emit!(PayoutCancelled { funded: p.funded, request: p.key(), ts });
    Ok(())
}
