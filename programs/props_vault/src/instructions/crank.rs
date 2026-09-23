use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{get_associated_token_address, AssociatedToken},
    token::{Mint, Token, TokenAccount},
};
use gmsol_programs::gmsol_store::program::GmsolStore;

use super::{now, trader::top_up_from_treasury};
use crate::{
    errors::VaultError,
    events::*,
    gmtrade::{self, close_order_cpi, PositionState},
    state::*,
};

#[event_cpi]
#[derive(Accounts)]
pub struct SyncFunded<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [FUNDED_SEED, funded.evaluation.as_ref()], bump = funded.bump)]
    pub funded: Box<Account<'info, FundedAccount>>,
}

/// Permissionless: reads GMTrade state into the funded account.
///
/// Remaining accounts, in order:
/// 1. the GMTrade Position of every used slot (ascending slot index),
/// 2. every tracked order (ascending index),
/// 3. the MarketConfig of every distinct market among used slots (first appearance), writable.
///
/// Orders whose account is gone are dropped. Orders GMTrade executed or cancelled but left open stay
/// tracked, outside the pending sums, until close_completed_order sweeps their escrow, so the account
/// is not flat while one still holds funds. Slot size/collateral come from the Position; market open
/// interest follows each slot's committed size; idle flat slots are freed.
pub(crate) fn sync<'info>(ctx: Context<'_, '_, 'info, 'info, SyncFunded<'info>>) -> Result<()> {
    let gm_program = ctx.accounts.config.gmtrade_program;
    let funded_key = ctx.accounts.funded.key();
    let f = &mut ctx.accounts.funded;
    require!(f.is_open(), VaultError::InvalidAccountStatus);
    let ts = now()?;
    let mut remaining = ctx.remaining_accounts.iter();
    let mut next = || remaining.next().ok_or_else(|| error!(VaultError::InvalidRemainingAccounts));

    let used: Vec<usize> = (0..MAX_SLOTS).filter(|&i| !f.slots[i].is_free()).collect();
    let mut positions = [PositionState::default(); MAX_SLOTS];
    for &i in &used {
        let ai = next()?;
        require_keys_eq!(ai.key(), f.slots[i].gm_position, VaultError::InvalidRemainingAccounts);
        positions[i] = gmtrade::position_state(ai, &gm_program)?;
    }

    let mut orders_dropped = Vec::new();
    let mut finished = [false; MAX_ORDERS];
    for (j, o) in f.orders.iter_mut().enumerate().filter(|(_, o)| !o.is_free()) {
        let ai = next()?;
        require_keys_eq!(ai.key(), o.order, VaultError::InvalidRemainingAccounts);
        if ai.owner != &gm_program {
            orders_dropped.push(o.order);
            *o = TrackedOrder::default();
        } else {
            finished[j] = !gmtrade::is_pending_order(ai, &gm_program)?;
        }
    }

    let mut committed_before = [0u128; MAX_SLOTS];
    for &i in &used {
        committed_before[i] = f.slots[i].committed()?;
        let pending = f
            .orders
            .iter()
            .enumerate()
            .filter(|&(j, o)| !o.is_free() && !finished[j] && o.slot as usize == i && o.order_type.is_increase())
            .try_fold(0u128, |acc, (_, o)| acc.checked_add(o.size_usd))
            .ok_or(VaultError::MathOverflow)?;
        let s = &mut f.slots[i];
        s.size_usd = positions[i].size_usd;
        s.collateral = positions[i].collateral;
        s.pending_usd = pending;
        s.last_sync = ts;
    }

    let mut markets: Vec<Pubkey> = Vec::with_capacity(used.len());
    for &i in &used {
        if !markets.contains(&f.slots[i].market_token) {
            markets.push(f.slots[i].market_token);
        }
    }
    for market_token in markets {
        let ai = next()?;
        require!(ai.is_writable, VaultError::InvalidRemainingAccounts);
        let mut market: Account<MarketConfig> = Account::try_from(ai)?;
        let expected = Pubkey::create_program_address(&[MARKET_SEED, market_token.as_ref(), &[market.bump]], &crate::ID)
            .map_err(|_| error!(VaultError::InvalidRemainingAccounts))?;
        require_keys_eq!(ai.key(), expected, VaultError::InvalidRemainingAccounts);
        for &i in used.iter().filter(|&&i| f.slots[i].market_token == market_token) {
            market.apply_oi_change(f.slots[i].is_long, committed_before[i], f.slots[i].committed()?)?;
        }
        market.exit(&crate::ID)?;
    }
    require!(remaining.next().is_none(), VaultError::InvalidRemainingAccounts);

    let slots = used
        .iter()
        .map(|&i| {
            let s = &f.slots[i];
            SlotSnapshot { market_token: s.market_token, is_long: s.is_long, size_usd: s.size_usd, collateral: s.collateral, pending_usd: s.pending_usd }
        })
        .collect();
    for &i in &used {
        f.release_slot_if_idle(i);
    }
    f.last_sync_at = ts;
    emit_cpi!(Synced { funded: funded_key, slots, orders_dropped, ts });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct TopUpOwner<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [FUNDED_SEED, funded.evaluation.as_ref()], bump = funded.bump)]
    pub funded: Box<Account<'info, FundedAccount>>,
    #[account(mut, seeds = [OWNER_SEED, funded.key().as_ref()], bump = funded.owner_bump)]
    pub owner: SystemAccount<'info>,
    #[account(mut, seeds = [SOL_TREASURY_SEED], bump = config.sol_treasury_bump)]
    pub sol_treasury: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Permissionless: refills the owner PDA's SOL float from the treasury once it drops below the minimum.
pub(crate) fn top_up_owner(ctx: Context<TopUpOwner>) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.funded.is_open(), VaultError::InvalidAccountStatus);
    require!(a.owner.lamports() < a.config.owner_sol_min, VaultError::OwnerFloatSufficient);
    let lamports = top_up_from_treasury(
        &a.system_program.to_account_info(),
        &a.sol_treasury.to_account_info(),
        &a.owner.to_account_info(),
        a.config.sol_treasury_bump,
        a.config.owner_sol_target,
    )?;
    emit_cpi!(OwnerToppedUp { funded: a.funded.key(), lamports, ts: now()? });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct CloseCompletedOrder<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [FUNDED_SEED, funded.evaluation.as_ref()], bump = funded.bump)]
    pub funded: Box<Account<'info, FundedAccount>>,
    #[account(mut, seeds = [OWNER_SEED, funded.key().as_ref()], bump = funded.owner_bump)]
    pub owner: SystemAccount<'info>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// CHECK: pinned GMTrade store.
    #[account(mut, address = config.gmtrade_store)]
    pub gm_store: UncheckedAccount<'info>,
    /// CHECK: GMTrade store wallet PDA; GMTrade verifies its seeds.
    #[account(mut)]
    pub gm_store_wallet: UncheckedAccount<'info>,
    /// CHECK: GMTrade UserHeader PDA of the owner; GMTrade verifies its seeds.
    #[account(mut)]
    pub gm_user: UncheckedAccount<'info>,
    /// CHECK: a tracked order that is no longer pending; GMTrade checks the owner.
    #[account(mut)]
    pub gm_order: UncheckedAccount<'info>,
    /// CHECK: ATA(order, USDC).
    #[account(mut, address = get_associated_token_address(&gm_order.key(), &usdc_mint.key()))]
    pub order_escrow: UncheckedAccount<'info>,
    /// CHECK: GMTrade event authority; GMTrade verifies it.
    pub gm_event_authority: UncheckedAccount<'info>,
    #[account(address = config.gmtrade_program)]
    pub gmtrade_program: Program<'info, GmsolStore>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Permissionless: closes a tracked order GMTrade executed or cancelled but left open, returning its
/// escrowed funds and rent to the owner PDA, and stops tracking it. Pending orders are refused. The
/// next sync settles the slot from the position.
pub(crate) fn close_completed_order(ctx: Context<CloseCompletedOrder>) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.funded.is_open(), VaultError::InvalidAccountStatus);
    let order = a.gm_order.key();
    let idx = a.funded.find_order(&order).ok_or(VaultError::OrderNotTracked)?;
    require!(!gmtrade::is_pending_order(&a.gm_order, &a.config.gmtrade_program)?, VaultError::OrderPending);
    let funded_key = a.funded.key();
    let owner_seeds: &[&[u8]] = &[OWNER_SEED, funded_key.as_ref(), &[a.funded.owner_bump]];
    close_order_cpi!(a).invoke(&[owner_seeds], "completed")?;
    ctx.accounts.funded.orders[idx] = TrackedOrder::default();
    emit_cpi!(CompletedOrderClosed { funded: funded_key, order, ts: now()? });
    Ok(())
}
