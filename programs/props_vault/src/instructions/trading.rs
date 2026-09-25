use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{get_associated_token_address, AssociatedToken},
    token::{Mint, Token, TokenAccount},
};
use gmsol_programs::gmsol_store::{program::GmsolStore, types::UpdateOrderParams};

use super::now;
use crate::{
    errors::VaultError,
    events::*,
    gmtrade::{self, close_order_cpi, create_order_cpi},
    state::*,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct OpenPositionArgs {
    pub is_long: bool,
    /// `Market` or `Limit`.
    pub order_type: OrderType,
    /// USDC base units moved from the owner ATA into the order.
    pub collateral: u64,
    /// GMTrade USD (1 USD = 10^20).
    pub size_delta_usd: u128,
    /// GMTrade unit price; required for `Limit`, zero for `Market`.
    pub trigger_price: u128,
    pub acceptable_price: u128,
    /// The most the trader agrees to pay as this order's Props fee (USDC base units): the fee they reviewed. The order
    /// fails with `OrderFeeChanged` if the rate changed so that its fee is higher.
    pub max_fee: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct ClosePositionArgs {
    pub is_long: bool,
    /// `u128::MAX` closes the whole position (GMTrade caps it to the position size).
    pub size_delta_usd: u128,
    pub acceptable_price: u128,
    /// The most the trader agrees to pay as this order's Props fee (USDC base units): the fee they reviewed, which for a
    /// decrease is its maximum (the rate on its size up to the account's exposure cap), not the fee expected on what it
    /// will close. The order fails with `OrderFeeChanged` if the rate changed so that its fee is higher.
    pub max_fee: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct SetProtectionArgs {
    pub is_long: bool,
    /// `TakeProfit` or `StopLoss`.
    pub order_type: OrderType,
    pub trigger_price: u128,
    pub size_delta_usd: u128,
    /// The most the trader agrees to pay as this order's Props fee (USDC base units): the fee they reviewed, which for a
    /// decrease is its maximum (the rate on its size up to the account's exposure cap), not the fee expected on what it
    /// will close. The order fails with `OrderFeeChanged` if the rate changed so that its fee is higher.
    pub max_fee: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct UpdateOrderArgs {
    pub trigger_price: Option<u128>,
    pub acceptable_price: Option<u128>,
    pub size_delta_usd: Option<u128>,
    /// The most the trader agrees to pay as this order's Props fee (USDC base units): the fee they reviewed, which for a
    /// decrease is its maximum (the rate on its size up to the account's exposure cap), not the fee expected on what it
    /// will close. The order fails with `OrderFeeChanged` if the rate changed so that its fee is higher.
    pub max_fee: u64,
}

/// Account and market limits for adding `size` (GMTrade USD, backed by `collateral` USDC) to `slot`,
/// where `replaced` is the size of a pending order being resized (0 for a new order).
fn check_increase(
    funded: &FundedAccount,
    slot: &Slot,
    market: &MarketConfig,
    is_long: bool,
    size: u128,
    collateral: u64,
    replaced: u128,
) -> Result<()> {
    let overflow = || error!(VaultError::MathOverflow);
    // Leverage = size / collateral, with USDC collateral valued at 1 USD.
    let lhs = size.checked_mul(BPS as u128).ok_or_else(overflow)?;
    let rhs = to_gm_usd(collateral)?.checked_mul(market.max_leverage_bps as u128).ok_or_else(overflow)?;
    require!(lhs <= rhs, VaultError::LeverageTooHigh);

    let with = |current: u128| current.checked_sub(replaced).and_then(|v| v.checked_add(size)).ok_or_else(overflow);
    require!(with(slot.committed()?)? <= to_gm_usd(market.max_position_usd)?, VaultError::PositionTooLarge);
    require!(with(funded.committed_exposure()?)? <= funded.terms.max_exposure_gm()?, VaultError::ExposureTooHigh);
    let oi = if is_long { market.oi_long_usd } else { market.oi_short_usd };
    require!(with(oi)? <= to_gm_usd(market.max_total_oi_usd)?, VaultError::MarketOpenInterestCap);
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct OpenPosition<'info> {
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
    #[account(mut, seeds = [OWNER_SEED, funded.key().as_ref()], bump = funded.owner_bump)]
    pub owner: SystemAccount<'info>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [MARKET_SEED, market_config.market_token.as_ref()], bump = market_config.bump)]
    pub market_config: Box<Account<'info, MarketConfig>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// CHECK: pinned GMTrade store.
    #[account(address = config.gmtrade_store)]
    pub gm_store: UncheckedAccount<'info>,
    /// CHECK: the GMTrade market recorded in the market config.
    #[account(mut, address = market_config.gm_market @ VaultError::MarketMismatch)]
    pub gm_market: UncheckedAccount<'info>,
    /// CHECK: GMTrade UserHeader PDA of the owner; GMTrade verifies its seeds.
    #[account(mut)]
    pub gm_user: UncheckedAccount<'info>,
    /// CHECK: GMTrade Position PDA; GMTrade verifies its seeds, then we check it against the slot.
    #[account(mut)]
    pub gm_position: UncheckedAccount<'info>,
    /// CHECK: GMTrade Order PDA (store, owner, `funded.next_order_nonce()`); GMTrade verifies the seeds.
    #[account(mut)]
    pub gm_order: UncheckedAccount<'info>,
    /// CHECK: ATA(order, USDC), created here.
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

/// Places a market or limit increase order on GMTrade with the owner PDA as owner and receiver.
pub(crate) fn open_position(ctx: Context<OpenPosition>, args: OpenPositionArgs) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.config.paused.trading, VaultError::Paused);
    require!(a.funded.status == FundedStatus::Active, VaultError::InvalidAccountStatus);
    require!(a.market_config.enabled, VaultError::MarketDisabled);
    require!(args.order_type.is_increase(), VaultError::InvalidOrderType);
    require!(args.acceptable_price != 0, VaultError::ZeroAcceptablePrice);
    require!((args.trigger_price != 0) == (args.order_type == OrderType::Limit), VaultError::InvalidTriggerPrice);
    require!(args.collateral > 0, VaultError::InvalidAmount);
    require!(args.collateral <= a.owner_usdc.amount, VaultError::CollateralExceedsBalance);

    let market_token = a.market_config.market_token;
    let (slot_idx, is_new_slot) = match a.funded.find_slot(&market_token, args.is_long) {
        Some(i) => {
            require_keys_eq!(a.gm_position.key(), a.funded.slots[i].gm_position, VaultError::InvalidPositionAccount);
            (i, false)
        }
        None => (a.funded.slots.iter().position(Slot::is_free).ok_or(VaultError::NoFreeSlot)?, true),
    };
    require!(a.funded.tracked_orders() < MAX_ORDERS, VaultError::TooManyOrders);
    check_increase(
        &a.funded,
        &a.funded.slots[slot_idx],
        &a.market_config,
        args.is_long,
        args.size_delta_usd,
        args.collateral,
        0,
    )?;
    // The order's fee must stay in the account's USDC with every fee already due or held for pending increases
    // (a collateral-only increase is free and adds margin whatever is held).
    let fee = a.config.order_fee(args.size_delta_usd, u128::MAX)?;
    require!(fee <= args.max_fee, VaultError::OrderFeeChanged);
    if args.size_delta_usd > 0 {
        let held = a.funded.reserved_fees()?;
        let needed = args.collateral.checked_add(fee).and_then(|v| v.checked_add(held)).ok_or(VaultError::MathOverflow)?;
        require!(needed <= a.owner_usdc.amount, VaultError::CollateralExceedsBalance);
    }

    let funded_key = a.funded.key();
    let owner_seeds: &[&[u8]] = &[OWNER_SEED, funded_key.as_ref(), &[a.funded.owner_bump]];
    let trigger = (args.order_type == OrderType::Limit).then_some(args.trigger_price);
    create_order_cpi!(a).invoke(
        &[owner_seeds],
        a.funded.next_order_nonce(),
        gmtrade::order_params(args.order_type, args.is_long, args.collateral, args.size_delta_usd, trigger, Some(args.acceptable_price)),
        Some(a.owner_usdc.to_account_info()),
    )?;
    if is_new_slot {
        gmtrade::check_position_identity(
            &a.gm_position,
            &a.config.gmtrade_program,
            &a.config.gmtrade_store,
            &a.owner.key(),
            &market_token,
            &a.config.usdc_mint,
            args.is_long,
        )?;
    }

    let order = a.gm_order.key();
    let position = a.gm_position.key();
    let trader = a.trader.key();
    let (order_fee_usdc, order_fee_bps) = (a.config.order_fee_usdc, a.config.order_fee_bps);
    let ts = now()?;
    let f = &mut ctx.accounts.funded;
    if is_new_slot {
        f.slots[slot_idx] = Slot { market_token, gm_position: position, is_long: args.is_long, ..Slot::default() };
    }
    let slot = &mut f.slots[slot_idx];
    slot.pending_usd = slot.pending_usd.checked_add(args.size_delta_usd).ok_or(VaultError::MathOverflow)?;
    f.track_order(TrackedOrder {
        order,
        slot: slot_idx as u8,
        order_type: args.order_type,
        size_usd: args.size_delta_usd,
        collateral: args.collateral,
        placed_by_risk: false,
    }, fee)?;
    ctx.accounts.market_config.apply_oi_change(args.is_long, 0, args.size_delta_usd)?;
    emit_cpi!(OrderRequested {
        funded: funded_key,
        order,
        market_token,
        is_long: args.is_long,
        order_type: args.order_type,
        size_delta_usd: args.size_delta_usd,
        collateral: args.collateral,
        trigger_price: args.trigger_price,
        acceptable_price: args.acceptable_price,
        by: trader,
        ts,
        fee,
        order_fee_usdc,
        order_fee_bps,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct DecreaseOrder<'info> {
    /// The trader, or a risk authority for forced closes.
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [FUNDED_SEED, funded.evaluation.as_ref()], bump = funded.bump)]
    pub funded: Box<Account<'info, FundedAccount>>,
    #[account(mut, seeds = [OWNER_SEED, funded.key().as_ref()], bump = funded.owner_bump)]
    pub owner: SystemAccount<'info>,
    #[account(seeds = [MARKET_SEED, market_config.market_token.as_ref()], bump = market_config.bump)]
    pub market_config: Box<Account<'info, MarketConfig>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// CHECK: pinned GMTrade store.
    #[account(address = config.gmtrade_store)]
    pub gm_store: UncheckedAccount<'info>,
    /// CHECK: the GMTrade market recorded in the market config.
    #[account(mut, address = market_config.gm_market @ VaultError::MarketMismatch)]
    pub gm_market: UncheckedAccount<'info>,
    /// CHECK: GMTrade UserHeader PDA of the owner; GMTrade verifies its seeds.
    #[account(mut)]
    pub gm_user: UncheckedAccount<'info>,
    /// CHECK: must be the slot's recorded GMTrade position.
    #[account(mut)]
    pub gm_position: UncheckedAccount<'info>,
    /// CHECK: GMTrade Order PDA (store, owner, `funded.next_order_nonce()`); GMTrade verifies the seeds.
    #[account(mut)]
    pub gm_order: UncheckedAccount<'info>,
    /// CHECK: ATA(order, USDC), created here.
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

impl<'info> DecreaseOrder<'info> {
    /// Creates a decrease order on the (market, side) slot and tracks it. Returns its fee, at most `max_fee`: the rate on
    /// its size up to the account's exposure cap (the position can grow before it executes, never past that cap; the
    /// charge is capped at the size it closes); 0 for a risk authority's order on a breached account, whose USDC all
    /// returns to the capital vault. A risk authority's order on any other account (the session guard) is assessed like
    /// the trader's own close.
    #[allow(clippy::too_many_arguments)]
    fn place(&mut self, is_long: bool, order_type: OrderType, size: u128, trigger: Option<u128>, acceptable: Option<u128>, placed_by_risk: bool, max_fee: u64) -> Result<u64> {
        require!(self.funded.is_open(), VaultError::InvalidAccountStatus);
        require!(size >= gmtrade::MIN_DECREASE_USD, VaultError::InvalidAmount);
        let slot_idx = self.funded.find_slot(&self.market_config.market_token, is_long).ok_or(VaultError::NoPosition)?;
        require_keys_eq!(self.gm_position.key(), self.funded.slots[slot_idx].gm_position, VaultError::InvalidPositionAccount);
        require!(self.funded.tracked_orders() < MAX_ORDERS, VaultError::TooManyOrders);
        let free = placed_by_risk && self.funded.status == FundedStatus::Breached;
        let fee = if free { 0 } else { self.config.order_fee(size, self.funded.terms.max_exposure_gm()?)? };
        require!(fee <= max_fee, VaultError::OrderFeeChanged);

        let funded_key = self.funded.key();
        let owner_seeds: &[&[u8]] = &[OWNER_SEED, funded_key.as_ref(), &[self.funded.owner_bump]];
        create_order_cpi!(self).invoke(
            &[owner_seeds],
            self.funded.next_order_nonce(),
            gmtrade::order_params(order_type, is_long, 0, size, trigger, acceptable),
            None,
        )?;

        let order = self.gm_order.key();
        self.funded.track_order(TrackedOrder { order, slot: slot_idx as u8, order_type, size_usd: size, collateral: 0, placed_by_risk }, fee)?;
        Ok(fee)
    }
}

/// Market-decreases a position. Signed by the trader, or by a risk authority (forced close).
/// Never blocked by pauses.
pub(crate) fn close_position(ctx: Context<DecreaseOrder>, args: ClosePositionArgs) -> Result<()> {
    let a = &mut *ctx.accounts;
    let by = a.authority.key();
    let is_trader = by == a.funded.trader;
    let is_risk = a.config.is_risk_authority(&by);
    require!(is_trader || is_risk, VaultError::Unauthorized);
    require!(args.acceptable_price != 0, VaultError::ZeroAcceptablePrice);
    let fee = a.place(args.is_long, OrderType::Close, args.size_delta_usd, None, Some(args.acceptable_price), !is_trader, args.max_fee)?;
    let event = OrderRequested {
        funded: a.funded.key(),
        order: a.gm_order.key(),
        market_token: a.market_config.market_token,
        is_long: args.is_long,
        order_type: OrderType::Close,
        size_delta_usd: args.size_delta_usd,
        collateral: 0,
        trigger_price: 0,
        acceptable_price: args.acceptable_price,
        by,
        ts: now()?,
        fee,
        order_fee_usdc: a.config.order_fee_usdc,
        order_fee_bps: a.config.order_fee_bps,
    };
    emit_cpi!(event);
    Ok(())
}

/// Places a take-profit (LimitDecrease) or stop-loss (StopLossDecrease) order. Trader only.
pub(crate) fn set_protection(ctx: Context<DecreaseOrder>, args: SetProtectionArgs) -> Result<()> {
    let a = &mut *ctx.accounts;
    require_keys_eq!(a.authority.key(), a.funded.trader, VaultError::Unauthorized);
    require!(a.funded.status != FundedStatus::PayoutPending, VaultError::InvalidAccountStatus);
    require!(matches!(args.order_type, OrderType::TakeProfit | OrderType::StopLoss), VaultError::InvalidOrderType);
    require!(args.trigger_price != 0, VaultError::InvalidTriggerPrice);
    let fee = a.place(args.is_long, args.order_type, args.size_delta_usd, Some(args.trigger_price), None, false, args.max_fee)?;
    let event = ProtectionSet {
        funded: a.funded.key(),
        order: a.gm_order.key(),
        market_token: a.market_config.market_token,
        is_long: args.is_long,
        order_type: args.order_type,
        size_delta_usd: args.size_delta_usd,
        trigger_price: args.trigger_price,
        ts: now()?,
        fee,
        order_fee_usdc: a.config.order_fee_usdc,
        order_fee_bps: a.config.order_fee_bps,
    };
    emit_cpi!(event);
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct UpdateOrder<'info> {
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
    #[account(mut, seeds = [MARKET_SEED, market_config.market_token.as_ref()], bump = market_config.bump)]
    pub market_config: Box<Account<'info, MarketConfig>>,
    /// CHECK: pinned GMTrade store.
    #[account(address = config.gmtrade_store)]
    pub gm_store: UncheckedAccount<'info>,
    /// CHECK: the GMTrade market recorded in the market config.
    #[account(mut, address = market_config.gm_market @ VaultError::MarketMismatch)]
    pub gm_market: UncheckedAccount<'info>,
    /// CHECK: must be a tracked order of this account; GMTrade checks owner and market.
    #[account(mut)]
    pub gm_order: UncheckedAccount<'info>,
    /// CHECK: GMTrade event authority; GMTrade verifies it.
    pub gm_event_authority: UncheckedAccount<'info>,
    #[account(address = config.gmtrade_program)]
    pub gmtrade_program: Program<'info, GmsolStore>,
    /// Read only: the account's USDC, which a limit increase's re-assessed fee must fit in.
    #[account(address = get_associated_token_address(&owner.key(), &config.usdc_mint))]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
}

/// Updates a pending limit, take-profit or stop-loss order. A limit increase can be changed only while
/// trading is live, the account is active and its market enabled, and only within the market's current
/// limits (any change can make it fill at once). Every update re-assesses the order's fee at the current rate, as
/// placing it again would (at most `max_fee`); a limit increase's higher fee must fit in the account's USDC.
pub(crate) fn update_order(ctx: Context<UpdateOrder>, args: UpdateOrderArgs) -> Result<()> {
    let a = &ctx.accounts;
    let idx = a.funded.find_order(&a.gm_order.key()).ok_or(VaultError::OrderNotTracked)?;
    let tracked = a.funded.orders[idx];
    require!(!tracked.placed_by_risk, VaultError::Unauthorized);
    require!(tracked.order_type.is_updatable(), VaultError::InvalidOrderType);
    require!(a.funded.is_open(), VaultError::InvalidAccountStatus);
    require!(
        args.trigger_price.is_some() || args.acceptable_price.is_some() || args.size_delta_usd.is_some(),
        VaultError::InvalidParams
    );
    require!(args.acceptable_price != Some(0), VaultError::ZeroAcceptablePrice);
    require!(args.trigger_price != Some(0), VaultError::InvalidTriggerPrice);
    let slot = a.funded.slots[tracked.slot as usize];
    require_keys_eq!(a.market_config.market_token, slot.market_token, VaultError::MarketMismatch);
    let increase = tracked.order_type.is_increase();
    let size = args.size_delta_usd.unwrap_or(tracked.size_usd);
    if increase {
        require!(!a.config.paused.trading, VaultError::Paused);
        require!(a.funded.status == FundedStatus::Active, VaultError::InvalidAccountStatus);
        require!(a.market_config.enabled, VaultError::MarketDisabled);
        check_increase(&a.funded, &slot, &a.market_config, slot.is_long, size, tracked.collateral, tracked.size_usd)?;
    } else if let Some(size) = args.size_delta_usd {
        require!(size >= gmtrade::MIN_DECREASE_USD, VaultError::InvalidAmount);
    }
    let cap = if increase { u128::MAX } else { a.funded.terms.max_exposure_gm()? };
    let fee = a.config.order_fee(size, cap)?;
    require!(fee <= args.max_fee, VaultError::OrderFeeChanged);
    let old = a.funded.order_fees[idx];
    if increase && fee > old {
        let held = a.funded.reserved_fees()?.checked_sub(old).and_then(|v| v.checked_add(fee)).ok_or(VaultError::MathOverflow)?;
        require!(held <= a.owner_usdc.amount, VaultError::CollateralExceedsBalance);
    }

    let funded_key = a.funded.key();
    let owner_seeds: &[&[u8]] = &[OWNER_SEED, funded_key.as_ref(), &[a.funded.owner_bump]];
    gmtrade::update_order(
        a.gmtrade_program.to_account_info(),
        a.owner.to_account_info(),
        a.gm_store.to_account_info(),
        a.gm_market.to_account_info(),
        a.gm_order.to_account_info(),
        a.gm_event_authority.to_account_info(),
        &[owner_seeds],
        UpdateOrderParams {
            size_delta_value: args.size_delta_usd,
            acceptable_price: args.acceptable_price,
            trigger_price: args.trigger_price,
            min_output: None,
            valid_from_ts: None,
        },
    )?;

    let order = a.gm_order.key();
    if let Some(size) = args.size_delta_usd {
        let f = &mut ctx.accounts.funded;
        if tracked.order_type.is_increase() {
            let s = &mut f.slots[tracked.slot as usize];
            s.pending_usd = s
                .pending_usd
                .checked_sub(tracked.size_usd)
                .and_then(|v| v.checked_add(size))
                .ok_or(VaultError::MathOverflow)?;
            ctx.accounts.market_config.apply_oi_change(slot.is_long, tracked.size_usd, size)?;
        }
        ctx.accounts.funded.orders[idx].size_usd = size;
    }
    ctx.accounts.funded.order_fees[idx] = fee;
    let (order_fee_usdc, order_fee_bps) = (ctx.accounts.config.order_fee_usdc, ctx.accounts.config.order_fee_bps);
    emit_cpi!(OrderUpdated {
        funded: funded_key,
        order,
        size_delta_usd: args.size_delta_usd,
        trigger_price: args.trigger_price,
        acceptable_price: args.acceptable_price,
        ts: now()?,
        fee,
        order_fee_usdc,
        order_fee_bps,
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct CancelOrder<'info> {
    /// The trader, or a risk authority.
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [FUNDED_SEED, funded.evaluation.as_ref()], bump = funded.bump)]
    pub funded: Box<Account<'info, FundedAccount>>,
    #[account(mut, seeds = [OWNER_SEED, funded.key().as_ref()], bump = funded.owner_bump)]
    pub owner: SystemAccount<'info>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [MARKET_SEED, market_config.market_token.as_ref()], bump = market_config.bump)]
    pub market_config: Box<Account<'info, MarketConfig>>,
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
    /// CHECK: must be a tracked order of this account.
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

/// Cancels a pending tracked order; its collateral and rent return to the owner PDA and its fee is released (never
/// charged). The trader cannot cancel orders a risk authority placed. Never blocked by pauses. Orders GMTrade already executed or
/// cancelled go through sync and close_completed_order instead, and only sync, which reads the
/// position, frees slots.
pub(crate) fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
    let a = &ctx.accounts;
    let by = a.authority.key();
    let idx = a.funded.find_order(&a.gm_order.key()).ok_or(VaultError::OrderNotTracked)?;
    let tracked = a.funded.orders[idx];
    let is_risk = a.config.is_risk_authority(&by);
    require!(is_risk || (by == a.funded.trader && !tracked.placed_by_risk), VaultError::Unauthorized);
    require!(gmtrade::is_pending_order(&a.gm_order, &a.config.gmtrade_program)?, VaultError::OrderNotPending);
    let slot = a.funded.slots[tracked.slot as usize];
    require_keys_eq!(a.market_config.market_token, slot.market_token, VaultError::MarketMismatch);

    let funded_key = a.funded.key();
    let owner_seeds: &[&[u8]] = &[OWNER_SEED, funded_key.as_ref(), &[a.funded.owner_bump]];
    close_order_cpi!(a).invoke(&[owner_seeds], "cancel")?;

    let order = a.gm_order.key();
    let f = &mut ctx.accounts.funded;
    f.orders[idx] = TrackedOrder::default();
    f.order_fees[idx] = 0;
    if tracked.order_type.is_increase() {
        let s = &mut f.slots[tracked.slot as usize];
        s.pending_usd = s.pending_usd.checked_sub(tracked.size_usd).ok_or(VaultError::MathOverflow)?;
        ctx.accounts.market_config.apply_oi_change(slot.is_long, tracked.size_usd, 0)?;
    }
    emit_cpi!(OrderCancelled { funded: funded_key, order, by, ts: now()? });
    Ok(())
}
