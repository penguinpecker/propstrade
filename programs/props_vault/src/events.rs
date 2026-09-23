use anchor_lang::prelude::*;

use crate::state::{OrderType, Pauses};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ConfigChange {
    Initialized,
    AdminProposed,
    AdminAccepted,
    Authorities,
    Params,
    Pauses,
    Tier,
    Market,
}

#[event]
pub struct ConfigChanged {
    pub change: ConfigChange,
    /// The admin, the new admin, the tier or the market config, depending on `change`.
    pub subject: Pubkey,
    pub paused: Pauses,
    pub ts: i64,
}

#[event]
pub struct CapitalDeposited {
    pub amount: u64,
    pub capital_vault_balance: u64,
    pub ts: i64,
}

#[event]
pub struct CapitalWithdrawn {
    pub amount: u64,
    pub to: Pubkey,
    pub capital_vault_balance: u64,
    pub ts: i64,
}

#[event]
pub struct FeesSwept {
    pub amount: u64,
    pub ts: i64,
}

#[event]
pub struct SolTreasuryWithdrawn {
    pub lamports: u64,
    pub to: Pubkey,
    pub ts: i64,
}

#[event]
pub struct IdentitySet {
    pub profile: Pubkey,
    pub wallet: Pubkey,
    pub identity_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct EvaluationPurchased {
    pub evaluation: Pubkey,
    pub trader: Pubkey,
    pub tier_id: u16,
    pub tier_version: u32,
    pub fee_paid: u64,
    pub ts: i64,
}

#[event]
pub struct EvaluationResolved {
    pub evaluation: Pubkey,
    pub trader: Pubkey,
    pub passed: bool,
    pub final_equity: i64,
    pub trades_root: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct FundedActivated {
    pub funded: Pubkey,
    pub evaluation: Pubkey,
    pub trader: Pubkey,
    pub owner: Pubkey,
    pub principal: u64,
    pub owner_lamports: u64,
    pub ts: i64,
}

#[event]
pub struct OrderRequested {
    pub funded: Pubkey,
    pub order: Pubkey,
    pub market_token: Pubkey,
    pub is_long: bool,
    pub order_type: OrderType,
    pub size_delta_usd: u128,
    pub collateral: u64,
    pub trigger_price: u128,
    pub acceptable_price: u128,
    pub by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct ProtectionSet {
    pub funded: Pubkey,
    pub order: Pubkey,
    pub market_token: Pubkey,
    pub is_long: bool,
    pub order_type: OrderType,
    pub size_delta_usd: u128,
    pub trigger_price: u128,
    pub ts: i64,
}

#[event]
pub struct OrderUpdated {
    pub funded: Pubkey,
    pub order: Pubkey,
    pub size_delta_usd: Option<u128>,
    pub trigger_price: Option<u128>,
    pub acceptable_price: Option<u128>,
    pub ts: i64,
}

#[event]
pub struct OrderCancelled {
    pub funded: Pubkey,
    pub order: Pubkey,
    pub by: Pubkey,
    pub ts: i64,
}

#[event]
pub struct CompletedOrderClosed {
    pub funded: Pubkey,
    pub order: Pubkey,
    pub ts: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct SlotSnapshot {
    pub market_token: Pubkey,
    pub is_long: bool,
    pub size_usd: u128,
    pub collateral: u64,
    pub pending_usd: u128,
}

#[event]
pub struct Synced {
    pub funded: Pubkey,
    pub slots: Vec<SlotSnapshot>,
    pub orders_dropped: Vec<Pubkey>,
    pub ts: i64,
}

#[event]
pub struct OwnerToppedUp {
    pub funded: Pubkey,
    pub lamports: u64,
    pub ts: i64,
}

#[event]
pub struct PayoutRequested {
    pub funded: Pubkey,
    pub request: Pubkey,
    pub seq: u32,
    pub balance: u64,
    pub profit: u64,
    pub trader_amount: u64,
    pub vault_amount: u64,
    pub ts: i64,
}

#[event]
pub struct PayoutCancelled {
    pub funded: Pubkey,
    pub request: Pubkey,
    pub ts: i64,
}

#[event]
pub struct PayoutPaid {
    pub funded: Pubkey,
    pub request: Pubkey,
    pub trader: Pubkey,
    pub trader_amount: u64,
    pub vault_amount: u64,
    pub ts: i64,
}

#[event]
pub struct PayoutRejected {
    pub funded: Pubkey,
    pub request: Pubkey,
    pub reason_code: u16,
    pub ts: i64,
}

#[event]
pub struct AccountRestricted {
    pub funded: Pubkey,
    pub restricted: bool,
    pub ts: i64,
}

#[event]
pub struct AccountBreached {
    pub funded: Pubkey,
    pub ts: i64,
}

#[event]
pub struct AccountClosed {
    pub funded: Pubkey,
    pub principal: u64,
    pub usdc_returned: u64,
    pub lamports_returned: u64,
    pub ts: i64,
}
