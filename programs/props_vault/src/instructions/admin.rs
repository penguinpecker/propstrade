use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};
use gmsol_programs::gmsol_store::program::GmsolStore;

use super::now;
use crate::{errors::VaultError, events::*, gmtrade, program::PropsVault, state::*};

fn config_changed(config: &Config, change: ConfigChange, subject: Pubkey) -> Result<()> {
    emit!(ConfigChanged { change, subject, paused: config.paused, ts: now()? });
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: data-less PDA that owns the vault token accounts.
    #[account(seeds = [VAULT_SEED], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        seeds = [FEE_VAULT_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = vault,
    )]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    /// `init_if_needed`: anyone can create ATA(vault, USDC) first, which must not block initialize.
    #[account(
        init_if_needed,
        payer = admin,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault,
    )]
    pub capital_vault: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [SOL_TREASURY_SEED], bump)]
    pub sol_treasury: SystemAccount<'info>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub gmtrade_program: Program<'info, GmsolStore>,
    /// CHECK: the GMTrade store to pin; must be owned by the GMTrade program.
    #[account(owner = gmtrade_program.key())]
    pub gmtrade_store: UncheckedAccount<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ VaultError::NotUpgradeAuthority)]
    pub program: Program<'info, PropsVault>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ VaultError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Creates the config and vault accounts. Everything starts paused.
pub(crate) fn initialize(ctx: Context<Initialize>, params: ConfigParams) -> Result<()> {
    params.validate(Rent::get()?.minimum_balance(0))?;
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.pending_admin = None;
    c.risk_authorities = Vec::new();
    c.kyc_authority = Pubkey::default();
    c.usdc_mint = ctx.accounts.usdc_mint.key();
    c.gmtrade_program = ctx.accounts.gmtrade_program.key();
    c.gmtrade_store = ctx.accounts.gmtrade_store.key();
    c.capital_vault = ctx.accounts.capital_vault.key();
    c.set_params(&params);
    c.paused = Pauses { new_evaluations: true, trading: true, payouts: true };
    c.bump = ctx.bumps.config;
    c.vault_bump = ctx.bumps.vault;
    c.fee_vault_bump = ctx.bumps.fee_vault;
    c.sol_treasury_bump = ctx.bumps.sol_treasury;
    config_changed(c, ConfigChange::Initialized, c.admin)
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
}

pub(crate) fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.pending_admin = Some(new_admin);
    config_changed(c, ConfigChange::AdminProposed, new_admin)
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.pending_admin == Some(new_admin.key()) @ VaultError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,
}

pub(crate) fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.new_admin.key();
    c.pending_admin = None;
    config_changed(c, ConfigChange::AdminAccepted, c.admin)
}

pub(crate) fn set_authorities(ctx: Context<AdminOnly>, risk_authorities: Vec<Pubkey>, kyc_authority: Pubkey) -> Result<()> {
    require!(risk_authorities.len() <= MAX_RISK_AUTHORITIES, VaultError::TooManyRiskAuthorities);
    require!(!risk_authorities.contains(&Pubkey::default()), VaultError::InvalidParams);
    let c = &mut ctx.accounts.config;
    c.risk_authorities = risk_authorities;
    c.kyc_authority = kyc_authority;
    config_changed(c, ConfigChange::Authorities, c.admin)
}

pub(crate) fn set_params(ctx: Context<AdminOnly>, params: ConfigParams) -> Result<()> {
    params.validate(Rent::get()?.minimum_balance(0))?;
    let c = &mut ctx.accounts.config;
    c.set_params(&params);
    config_changed(c, ConfigChange::Params, c.admin)
}

pub(crate) fn set_pauses(ctx: Context<AdminOnly>, paused: Pauses) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.paused = paused;
    config_changed(c, ConfigChange::Pauses, c.admin)
}

#[derive(Accounts)]
#[instruction(id: u16)]
pub struct UpsertTier<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + Tier::INIT_SPACE,
        seeds = [TIER_SEED, &id.to_le_bytes()],
        bump,
    )]
    pub tier: Box<Account<'info, Tier>>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn upsert_tier(ctx: Context<UpsertTier>, id: u16, params: TierParams) -> Result<()> {
    params.validate()?;
    let t = &mut ctx.accounts.tier;
    t.id = id;
    t.size_usd = params.size_usd;
    t.fee_usdc = params.fee_usdc;
    t.profit_target_bps = params.profit_target_bps;
    t.max_drawdown_bps = params.max_drawdown_bps;
    t.max_exposure_bps = params.max_exposure_bps;
    t.enabled = params.enabled;
    t.terms_hash = params.terms_hash;
    t.version = t.version.checked_add(1).ok_or(VaultError::MathOverflow)?;
    t.bump = ctx.bumps.tier;
    config_changed(&ctx.accounts.config, ConfigChange::Tier, t.key())
}

#[derive(Accounts)]
#[instruction(market_token: Pubkey)]
pub struct UpsertMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + MarketConfig::INIT_SPACE,
        seeds = [MARKET_SEED, market_token.as_ref()],
        bump,
    )]
    pub market_config: Box<Account<'info, MarketConfig>>,
    /// CHECK: GMTrade Market for `market_token`; verified to be a pure USDC-USDC market of the pinned store.
    pub gm_market: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn upsert_market(ctx: Context<UpsertMarket>, market_token: Pubkey, params: MarketParams) -> Result<()> {
    params.validate()?;
    let c = &ctx.accounts.config;
    let gm_market = &ctx.accounts.gm_market;
    gmtrade::check_pure_usdc_market(gm_market, &c.gmtrade_program, &c.gmtrade_store, &market_token, &c.usdc_mint)?;
    let m = &mut ctx.accounts.market_config;
    if m.market_token == Pubkey::default() {
        m.market_token = market_token;
        m.gm_market = gm_market.key();
        m.bump = ctx.bumps.market_config;
    }
    require_keys_eq!(m.gm_market, gm_market.key(), VaultError::MarketMismatch);
    m.set_params(&params);
    config_changed(c, ConfigChange::Market, m.key())
}

#[derive(Accounts)]
pub struct MoveCapital<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, token::mint = usdc_mint, token::authority = admin)]
    pub admin_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: vault authority PDA.
    #[account(seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, address = config.capital_vault)]
    pub capital_vault: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

pub(crate) fn deposit_capital(ctx: Context<MoveCapital>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidAmount);
    let a = &ctx.accounts;
    token::transfer_checked(
        CpiContext::new(
            a.token_program.to_account_info(),
            TransferChecked {
                from: a.admin_usdc.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.capital_vault.to_account_info(),
                authority: a.admin.to_account_info(),
            },
        ),
        amount,
        a.usdc_mint.decimals,
    )?;
    let capital_vault_balance = a.capital_vault.amount.checked_add(amount).ok_or(VaultError::MathOverflow)?;
    emit!(CapitalDeposited { amount, capital_vault_balance, ts: now()? });
    Ok(())
}

/// Withdraws unallocated capital. Principal already posted to funded accounts is not in the capital vault.
pub(crate) fn withdraw_capital(ctx: Context<MoveCapital>, amount: u64) -> Result<()> {
    let a = &ctx.accounts;
    require!(amount > 0 && amount <= a.capital_vault.amount, VaultError::InvalidAmount);
    token::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            TransferChecked {
                from: a.capital_vault.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.admin_usdc.to_account_info(),
                authority: a.vault.to_account_info(),
            },
            &[&[VAULT_SEED, &[a.config.vault_bump]]],
        ),
        amount,
        a.usdc_mint.decimals,
    )?;
    let capital_vault_balance = a.capital_vault.amount.checked_sub(amount).ok_or(VaultError::MathOverflow)?;
    emit!(CapitalWithdrawn { amount, to: a.admin_usdc.key(), capital_vault_balance, ts: now()? });
    Ok(())
}

#[derive(Accounts)]
pub struct SweepFees<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: vault authority PDA.
    #[account(seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, seeds = [FEE_VAULT_SEED], bump = config.fee_vault_bump, token::mint = usdc_mint, token::authority = vault)]
    pub fee_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.capital_vault)]
    pub capital_vault: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

pub(crate) fn sweep_fees(ctx: Context<SweepFees>) -> Result<()> {
    let a = &ctx.accounts;
    let amount = a.fee_vault.amount;
    require!(amount > 0, VaultError::InvalidAmount);
    token::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            TransferChecked {
                from: a.fee_vault.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.capital_vault.to_account_info(),
                authority: a.vault.to_account_info(),
            },
            &[&[VAULT_SEED, &[a.config.vault_bump]]],
        ),
        amount,
        a.usdc_mint.decimals,
    )?;
    emit!(FeesSwept { amount, ts: now()? });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawSolTreasury<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SOL_TREASURY_SEED], bump = config.sol_treasury_bump)]
    pub sol_treasury: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Sends SOL from the treasury to the admin. The runtime keeps the treasury rent-exempt.
pub(crate) fn withdraw_sol_treasury(ctx: Context<WithdrawSolTreasury>, lamports: u64) -> Result<()> {
    require!(lamports > 0, VaultError::InvalidAmount);
    let a = &ctx.accounts;
    system_program::transfer(
        CpiContext::new_with_signer(
            a.system_program.to_account_info(),
            system_program::Transfer { from: a.sol_treasury.to_account_info(), to: a.admin.to_account_info() },
            &[&[SOL_TREASURY_SEED, &[a.config.sol_treasury_bump]]],
        ),
        lamports,
    )?;
    emit!(SolTreasuryWithdrawn { lamports, to: a.admin.key(), ts: now()? });
    Ok(())
}
