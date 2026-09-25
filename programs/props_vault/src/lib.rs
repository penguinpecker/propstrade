//! Props.trade vault. Holds evaluation fees and seed capital, posts each funded account's loss allowance
//! to a data-less owner PDA, and trades on GMTrade (gmsol-store v0.10.0) only through that PDA, with the
//! PDA as the receiver of every order. The only USDC paths out of an owner PDA are GMTrade order escrows,
//! settled order fees (fee vault), approved payouts (trader wallet + capital vault) and account closure (capital vault).
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod gmtrade;
pub mod instructions;
pub mod state;

pub use instructions::*;
use state::{ConfigParams, MarketParams, Pauses, TierParams};

declare_id!("7qYRWwpmj3j3exVoBUJHzigcWmMN8ruPEdZdZrGzTJ7");

#[program]
pub mod props_vault {
    use super::*;

    // ----- admin -----

    pub fn initialize(ctx: Context<Initialize>, params: ConfigParams) -> Result<()> {
        instructions::initialize(ctx, params)
    }

    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::propose_admin(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::accept_admin(ctx)
    }

    pub fn set_authorities(ctx: Context<AdminOnly>, risk_authorities: Vec<Pubkey>, kyc_authority: Pubkey) -> Result<()> {
        instructions::set_authorities(ctx, risk_authorities, kyc_authority)
    }

    pub fn set_params(ctx: Context<AdminOnly>, params: ConfigParams) -> Result<()> {
        instructions::set_params(ctx, params)
    }

    pub fn set_pauses(ctx: Context<AdminOnly>, paused: Pauses) -> Result<()> {
        instructions::set_pauses(ctx, paused)
    }

    pub fn set_order_fee(ctx: Context<AdminOnly>, fee_usdc: u64, fee_bps: u16) -> Result<()> {
        instructions::set_order_fee(ctx, fee_usdc, fee_bps)
    }

    pub fn upsert_tier(ctx: Context<UpsertTier>, id: u16, params: TierParams) -> Result<()> {
        instructions::upsert_tier(ctx, id, params)
    }

    pub fn upsert_market(ctx: Context<UpsertMarket>, market_token: Pubkey, params: MarketParams) -> Result<()> {
        instructions::upsert_market(ctx, market_token, params)
    }

    pub fn deposit_capital(ctx: Context<MoveCapital>, amount: u64) -> Result<()> {
        instructions::deposit_capital(ctx, amount)
    }

    pub fn withdraw_capital(ctx: Context<MoveCapital>, amount: u64) -> Result<()> {
        instructions::withdraw_capital(ctx, amount)
    }

    pub fn sweep_fees(ctx: Context<SweepFees>) -> Result<()> {
        instructions::sweep_fees(ctx)
    }

    pub fn withdraw_sol_treasury(ctx: Context<WithdrawSolTreasury>, lamports: u64) -> Result<()> {
        instructions::withdraw_sol_treasury(ctx, lamports)
    }

    // ----- trader -----

    pub fn buy_evaluation(
        ctx: Context<BuyEvaluation>,
        tier_id: u16,
        index: u32,
        expected_fee_usdc: u64,
        expected_tier_version: u32,
    ) -> Result<()> {
        instructions::buy_evaluation(ctx, tier_id, index, expected_fee_usdc, expected_tier_version)
    }

    pub fn activate_funded(ctx: Context<ActivateFunded>) -> Result<()> {
        instructions::activate_funded(ctx)
    }

    pub fn open_position(ctx: Context<OpenPosition>, args: OpenPositionArgs) -> Result<()> {
        instructions::open_position(ctx, args)
    }

    pub fn close_position(ctx: Context<DecreaseOrder>, args: ClosePositionArgs) -> Result<()> {
        instructions::close_position(ctx, args)
    }

    pub fn set_protection(ctx: Context<DecreaseOrder>, args: SetProtectionArgs) -> Result<()> {
        instructions::set_protection(ctx, args)
    }

    pub fn update_order(ctx: Context<UpdateOrder>, args: UpdateOrderArgs) -> Result<()> {
        instructions::update_order(ctx, args)
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        instructions::cancel_order(ctx)
    }

    pub fn request_payout(ctx: Context<RequestPayout>) -> Result<()> {
        instructions::request_payout(ctx)
    }

    pub fn cancel_payout(ctx: Context<CancelPayout>) -> Result<()> {
        instructions::cancel_payout(ctx)
    }

    // ----- risk + KYC authorities -----

    pub fn set_identity(ctx: Context<SetIdentity>, wallet: Pubkey, identity_hash: [u8; 32]) -> Result<()> {
        instructions::set_identity(ctx, wallet, identity_hash)
    }

    pub fn record_evaluation_result(
        ctx: Context<RecordEvaluationResult>,
        passed: bool,
        final_equity: i64,
        trades_root: [u8; 32],
    ) -> Result<()> {
        instructions::record_evaluation_result(ctx, passed, final_equity, trades_root)
    }

    pub fn approve_payout<'info>(ctx: Context<'_, '_, 'info, 'info, ApprovePayout<'info>>) -> Result<()> {
        instructions::approve_payout(ctx)
    }

    pub fn reject_payout(ctx: Context<RejectPayout>, reason_code: u16) -> Result<()> {
        instructions::reject_payout(ctx, reason_code)
    }

    pub fn restrict(ctx: Context<RiskFunded>, restricted: bool) -> Result<()> {
        instructions::restrict(ctx, restricted)
    }

    pub fn mark_breached(ctx: Context<RiskFunded>) -> Result<()> {
        instructions::mark_breached(ctx)
    }

    pub fn close_funded<'info>(ctx: Context<'_, '_, 'info, 'info, CloseFunded<'info>>) -> Result<()> {
        instructions::close_funded(ctx)
    }

    pub fn settle_order_fees(
        ctx: Context<SettleOrderFees>,
        charge: u64,
        waive: u64,
        expected_due: u64,
        expected_settlements: u64,
    ) -> Result<()> {
        instructions::settle_order_fees(ctx, charge, waive, expected_due, expected_settlements)
    }

    // ----- permissionless cranks -----

    pub fn sync<'info>(ctx: Context<'_, '_, 'info, 'info, SyncFunded<'info>>) -> Result<()> {
        instructions::sync(ctx)
    }

    pub fn top_up_owner(ctx: Context<TopUpOwner>) -> Result<()> {
        instructions::top_up_owner(ctx)
    }

    pub fn close_completed_order(ctx: Context<CloseCompletedOrder>) -> Result<()> {
        instructions::close_completed_order(ctx)
    }

    pub fn close_empty_position(ctx: Context<CloseEmptyPosition>) -> Result<()> {
        instructions::close_empty_position(ctx)
    }

    pub fn collect_claimable(ctx: Context<CollectClaimable>) -> Result<()> {
        instructions::collect_claimable(ctx)
    }
}
