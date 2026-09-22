//! Spike: a vault program whose data-less PDA owns GMTrade (gmsol-store v0.10.0) orders via CPI.
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{self, AssociatedToken},
    token::{Mint, Token, TokenAccount},
};
use gmsol_programs::gmsol_store::{
    cpi::{
        accounts::{CloseOrderV2, CreateOrderV2, PreparePosition, PrepareUser},
        close_order_v2, create_order_v2, prepare_position, prepare_user,
    },
    program::GmsolStore,
    types::{CreateOrderParams, DecreasePositionSwapType, OrderKind},
};

declare_id!("CnFTSE4a4fVdu8DoR7tEBmkdQfJR4uQikx331B6KJrcN");

pub const VAULT_SEED: &[u8] = b"vault_state";
pub const FUNDED_SEED: &[u8] = b"funded";
/// gmsol-store 0.10.0 src/states/order.rs:343 (`Order::MIN_EXECUTION_LAMPORTS`).
pub const MIN_EXECUTION_LAMPORTS: u64 = 300_000;

fn opt<'info>(x: &Option<UncheckedAccount<'info>>) -> Option<AccountInfo<'info>> {
    x.as_ref().map(|x| x.to_account_info())
}

#[program]
pub mod props_vault {
    use super::*;

    pub fn init_funded(ctx: Context<InitFunded>, id: u64) -> Result<()> {
        let s = &mut ctx.accounts.vault_state;
        s.authority = ctx.accounts.authority.key();
        s.id = id;
        s.bump = ctx.bumps.vault_state;
        s.signer_bump = ctx.bumps.funded_signer;
        Ok(())
    }

    /// MarketIncrease on GMTrade, owner = receiver = the funded signer PDA.
    pub fn open(
        ctx: Context<Open>,
        nonce: [u8; 32],
        size_delta_usd: u128,
        collateral_amount: u64,
        is_long: bool,
    ) -> Result<()> {
        let a = &ctx.accounts;
        let vs = a.vault_state.key();
        let id = a.vault_state.id.to_le_bytes();
        let bump = [a.vault_state.signer_bump];
        let seeds: &[&[u8]] = &[FUNDED_SEED, vs.as_ref(), &id, &bump];
        let signer = &[seeds];

        // Escrows are ATAs of the (not yet created) order PDA; create_order_v2 requires them to exist.
        let mut done: Vec<Pubkey> = Vec::with_capacity(3);
        for (escrow, mint) in [
            (&a.collateral_escrow, &a.collateral_mint.to_account_info()),
            (&a.long_token_escrow, &a.long_token.to_account_info()),
            (&a.short_token_escrow, &a.short_token.to_account_info()),
        ] {
            if done.contains(escrow.key) {
                continue;
            }
            done.push(*escrow.key);
            associated_token::create_idempotent(CpiContext::new_with_signer(
                a.associated_token_program.to_account_info(),
                associated_token::Create {
                    payer: a.funded_signer.to_account_info(),
                    associated_token: escrow.to_account_info(),
                    authority: a.order.to_account_info(),
                    mint: mint.clone(),
                    system_program: a.system_program.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                },
                signer,
            ))?;
        }

        let params = CreateOrderParams {
            kind: OrderKind::MarketIncrease,
            decrease_position_swap_type: None,
            execution_lamports: MIN_EXECUTION_LAMPORTS,
            swap_path_length: 0,
            initial_collateral_delta_amount: collateral_amount,
            size_delta_value: size_delta_usd,
            is_long,
            is_collateral_long: a.collateral_mint.key() == a.long_token.key(),
            min_output: None,
            trigger_price: None,
            acceptable_price: None,
            should_unwrap_native_token: false,
            valid_from_ts: None,
        };

        prepare_user(CpiContext::new_with_signer(
            a.store_program.to_account_info(),
            PrepareUser {
                owner: a.funded_signer.to_account_info(),
                store: a.store.to_account_info(),
                user: a.user.to_account_info(),
                system_program: a.system_program.to_account_info(),
            },
            signer,
        ))?;

        prepare_position(
            CpiContext::new_with_signer(
                a.store_program.to_account_info(),
                PreparePosition {
                    owner: a.funded_signer.to_account_info(),
                    store: a.store.to_account_info(),
                    market: a.market.to_account_info(),
                    position: a.position.to_account_info(),
                    system_program: a.system_program.to_account_info(),
                },
                signer,
            ),
            params.clone(),
        )?;

        create_order_v2(
            CpiContext::new_with_signer(
                a.store_program.to_account_info(),
                CreateOrderV2 {
                    owner: a.funded_signer.to_account_info(),
                    receiver: a.funded_signer.to_account_info(),
                    store: a.store.to_account_info(),
                    market: a.market.to_account_info(),
                    user: a.user.to_account_info(),
                    order: a.order.to_account_info(),
                    position: Some(a.position.to_account_info()),
                    initial_collateral_token: Some(a.collateral_mint.to_account_info()),
                    // v0.11 requires final_output_token == collateral for increase orders; same value works on v0.10.
                    final_output_token: a.collateral_mint.to_account_info(),
                    long_token: Some(a.long_token.to_account_info()),
                    short_token: Some(a.short_token.to_account_info()),
                    initial_collateral_token_escrow: Some(a.collateral_escrow.to_account_info()),
                    final_output_token_escrow: None,
                    long_token_escrow: Some(a.long_token_escrow.to_account_info()),
                    short_token_escrow: Some(a.short_token_escrow.to_account_info()),
                    initial_collateral_token_source: Some(a.collateral_source.to_account_info()),
                    system_program: a.system_program.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                    associated_token_program: a.associated_token_program.to_account_info(),
                    callback_authority: None,
                    callback_program: None,
                    callback_shared_data_account: None,
                    callback_partitioned_data_account: None,
                    event_authority: a.event_authority.to_account_info(),
                    program: a.store_program.to_account_info(),
                },
                signer,
            ),
            nonce,
            params,
            None,
        )?;
        Ok(())
    }

    /// StopLossDecrease for the funded signer's existing position; output (USDC) returns to the PDA.
    pub fn place_stop_loss(
        ctx: Context<PlaceStopLoss>,
        nonce: [u8; 32],
        size_delta_usd: u128,
        trigger_price: u128,
        is_long: bool,
    ) -> Result<()> {
        let a = &ctx.accounts;
        let vs = a.vault_state.key();
        let id = a.vault_state.id.to_le_bytes();
        let bump = [a.vault_state.signer_bump];
        let seeds: &[&[u8]] = &[FUNDED_SEED, vs.as_ref(), &id, &bump];
        let signer = &[seeds];

        let mut done: Vec<Pubkey> = Vec::with_capacity(3);
        for (escrow, mint) in [
            (&a.output_escrow, &a.output_mint.to_account_info()),
            (&a.long_token_escrow, &a.long_token.to_account_info()),
            (&a.short_token_escrow, &a.short_token.to_account_info()),
        ] {
            if done.contains(escrow.key) {
                continue;
            }
            done.push(*escrow.key);
            associated_token::create_idempotent(CpiContext::new_with_signer(
                a.associated_token_program.to_account_info(),
                associated_token::Create {
                    payer: a.funded_signer.to_account_info(),
                    associated_token: escrow.to_account_info(),
                    authority: a.order.to_account_info(),
                    mint: mint.clone(),
                    system_program: a.system_program.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                },
                signer,
            ))?;
        }

        let params = CreateOrderParams {
            kind: OrderKind::StopLossDecrease,
            decrease_position_swap_type: Some(DecreasePositionSwapType::NoSwap),
            execution_lamports: MIN_EXECUTION_LAMPORTS,
            swap_path_length: 0,
            initial_collateral_delta_amount: 0,
            size_delta_value: size_delta_usd,
            is_long,
            is_collateral_long: a.output_mint.key() == a.long_token.key(),
            min_output: None,
            trigger_price: Some(trigger_price),
            acceptable_price: None,
            should_unwrap_native_token: false,
            valid_from_ts: None,
        };

        create_order_v2(
            CpiContext::new_with_signer(
                a.store_program.to_account_info(),
                CreateOrderV2 {
                    owner: a.funded_signer.to_account_info(),
                    receiver: a.funded_signer.to_account_info(),
                    store: a.store.to_account_info(),
                    market: a.market.to_account_info(),
                    user: a.user.to_account_info(),
                    order: a.order.to_account_info(),
                    position: Some(a.position.to_account_info()),
                    initial_collateral_token: None,
                    final_output_token: a.output_mint.to_account_info(),
                    long_token: Some(a.long_token.to_account_info()),
                    short_token: Some(a.short_token.to_account_info()),
                    initial_collateral_token_escrow: None,
                    final_output_token_escrow: Some(a.output_escrow.to_account_info()),
                    long_token_escrow: Some(a.long_token_escrow.to_account_info()),
                    short_token_escrow: Some(a.short_token_escrow.to_account_info()),
                    initial_collateral_token_source: None,
                    system_program: a.system_program.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                    associated_token_program: a.associated_token_program.to_account_info(),
                    callback_authority: None,
                    callback_program: None,
                    callback_shared_data_account: None,
                    callback_partitioned_data_account: None,
                    event_authority: a.event_authority.to_account_info(),
                    program: a.store_program.to_account_info(),
                },
                signer,
            ),
            nonce,
            params,
            None,
        )?;
        Ok(())
    }

    /// Owner-cancel of any order owned by the funded signer. Funds + rent return to the PDA only.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let a = &ctx.accounts;
        let vs = a.vault_state.key();
        let id = a.vault_state.id.to_le_bytes();
        let bump = [a.vault_state.signer_bump];
        let seeds: &[&[u8]] = &[FUNDED_SEED, vs.as_ref(), &id, &bump];
        let pda = a.funded_signer.to_account_info();
        close_order_v2(
            CpiContext::new_with_signer(
                a.store_program.to_account_info(),
                CloseOrderV2 {
                    executor: pda.clone(),
                    store: a.store.to_account_info(),
                    store_wallet: a.store_wallet.to_account_info(),
                    owner: pda.clone(),
                    receiver: pda.clone(),
                    rent_receiver: pda,
                    user: a.user.to_account_info(),
                    referrer_user: None,
                    order: a.order.to_account_info(),
                    initial_collateral_token: opt(&a.initial_collateral_token),
                    final_output_token: opt(&a.final_output_token),
                    long_token: Some(a.long_token.to_account_info()),
                    short_token: Some(a.short_token.to_account_info()),
                    initial_collateral_token_escrow: opt(&a.initial_collateral_token_escrow),
                    final_output_token_escrow: opt(&a.final_output_token_escrow),
                    long_token_escrow: Some(a.long_token_escrow.to_account_info()),
                    short_token_escrow: Some(a.short_token_escrow.to_account_info()),
                    initial_collateral_token_ata: opt(&a.initial_collateral_token_ata),
                    final_output_token_ata: opt(&a.final_output_token_ata),
                    long_token_ata: Some(a.long_token_ata.to_account_info()),
                    short_token_ata: Some(a.short_token_ata.to_account_info()),
                    system_program: a.system_program.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                    associated_token_program: a.associated_token_program.to_account_info(),
                    callback_authority: None,
                    callback_program: None,
                    callback_shared_data_account: None,
                    callback_partitioned_data_account: None,
                    event_authority: a.event_authority.to_account_info(),
                    program: a.store_program.to_account_info(),
                },
                &[seeds],
            ),
            "cancel".to_string(),
        )?;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub authority: Pubkey,
    pub id: u64,
    pub bump: u8,
    pub signer_bump: u8,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct InitFunded<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [VAULT_SEED, authority.key().as_ref(), &id.to_le_bytes()],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,
    /// CHECK: data-less signer PDA; only its address/bump are recorded.
    #[account(seeds = [FUNDED_SEED, vault_state.key().as_ref(), &id.to_le_bytes()], bump)]
    pub funded_signer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Open<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [FUNDED_SEED, vault_state.key().as_ref(), &vault_state.id.to_le_bytes()],
        bump = vault_state.signer_bump,
    )]
    pub funded_signer: SystemAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    pub store: UncheckedAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    #[account(mut)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    #[account(mut)]
    pub user: UncheckedAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: checked by gmsol-store CPI (PDA of store/owner/nonce).
    #[account(mut)]
    pub order: UncheckedAccount<'info>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = funded_signer,
    )]
    pub collateral_source: Box<Account<'info, TokenAccount>>,
    /// CHECK: ATA(order, collateral_mint), created here.
    #[account(mut)]
    pub collateral_escrow: UncheckedAccount<'info>,
    pub long_token: Box<Account<'info, Mint>>,
    pub short_token: Box<Account<'info, Mint>>,
    /// CHECK: ATA(order, long_token), created here.
    #[account(mut)]
    pub long_token_escrow: UncheckedAccount<'info>,
    /// CHECK: ATA(order, short_token), created here.
    #[account(mut)]
    pub short_token_escrow: UncheckedAccount<'info>,
    /// CHECK: gmsol-store event authority.
    pub event_authority: UncheckedAccount<'info>,
    pub store_program: Program<'info, GmsolStore>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceStopLoss<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [FUNDED_SEED, vault_state.key().as_ref(), &vault_state.id.to_le_bytes()],
        bump = vault_state.signer_bump,
    )]
    pub funded_signer: SystemAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    pub store: UncheckedAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    #[account(mut)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    #[account(mut)]
    pub user: UncheckedAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    #[account(mut)]
    pub order: UncheckedAccount<'info>,
    pub output_mint: Box<Account<'info, Mint>>,
    /// CHECK: ATA(order, output_mint), created here.
    #[account(mut)]
    pub output_escrow: UncheckedAccount<'info>,
    pub long_token: Box<Account<'info, Mint>>,
    pub short_token: Box<Account<'info, Mint>>,
    /// CHECK: ATA(order, long_token), created here.
    #[account(mut)]
    pub long_token_escrow: UncheckedAccount<'info>,
    /// CHECK: ATA(order, short_token), created here.
    #[account(mut)]
    pub short_token_escrow: UncheckedAccount<'info>,
    /// CHECK: gmsol-store event authority.
    pub event_authority: UncheckedAccount<'info>,
    pub store_program: Program<'info, GmsolStore>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [FUNDED_SEED, vault_state.key().as_ref(), &vault_state.id.to_le_bytes()],
        bump = vault_state.signer_bump,
    )]
    pub funded_signer: SystemAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    #[account(mut)]
    pub store: UncheckedAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    #[account(mut)]
    pub store_wallet: UncheckedAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    #[account(mut)]
    pub user: UncheckedAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    #[account(mut)]
    pub order: UncheckedAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    pub initial_collateral_token: Option<UncheckedAccount<'info>>,
    /// CHECK: checked by gmsol-store CPI.
    pub final_output_token: Option<UncheckedAccount<'info>>,
    /// CHECK: checked by gmsol-store CPI.
    pub long_token: UncheckedAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    pub short_token: UncheckedAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    #[account(mut)]
    pub initial_collateral_token_escrow: Option<UncheckedAccount<'info>>,
    /// CHECK: checked by gmsol-store CPI.
    #[account(mut)]
    pub final_output_token_escrow: Option<UncheckedAccount<'info>>,
    /// CHECK: checked by gmsol-store CPI.
    #[account(mut)]
    pub long_token_escrow: UncheckedAccount<'info>,
    /// CHECK: checked by gmsol-store CPI.
    #[account(mut)]
    pub short_token_escrow: UncheckedAccount<'info>,
    /// CHECK: must be ATA of the PDA (checked by gmsol-store).
    #[account(mut)]
    pub initial_collateral_token_ata: Option<UncheckedAccount<'info>>,
    /// CHECK: must be ATA of the PDA (checked by gmsol-store).
    #[account(mut)]
    pub final_output_token_ata: Option<UncheckedAccount<'info>>,
    /// CHECK: must be ATA of the PDA (checked by gmsol-store).
    #[account(mut)]
    pub long_token_ata: UncheckedAccount<'info>,
    /// CHECK: must be ATA of the PDA (checked by gmsol-store).
    #[account(mut)]
    pub short_token_ata: UncheckedAccount<'info>,
    /// CHECK: gmsol-store event authority.
    pub event_authority: UncheckedAccount<'info>,
    pub store_program: Program<'info, GmsolStore>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
