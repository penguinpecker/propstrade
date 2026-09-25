use anchor_lang::prelude::*;

use crate::errors::VaultError;

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const FEE_VAULT_SEED: &[u8] = b"fee_vault";
pub const SOL_TREASURY_SEED: &[u8] = b"sol_treasury";
pub const TIER_SEED: &[u8] = b"tier";
pub const MARKET_SEED: &[u8] = b"market";
pub const TRADER_SEED: &[u8] = b"trader";
pub const IDENTITY_SEED: &[u8] = b"identity";
pub const EVALUATION_SEED: &[u8] = b"evaluation";
pub const FUNDED_SEED: &[u8] = b"funded";
pub const OWNER_SEED: &[u8] = b"owner";
pub const PAYOUT_SEED: &[u8] = b"payout";

pub const MAX_RISK_AUTHORITIES: usize = 4;
pub const MAX_SLOTS: usize = 8;
pub const MAX_ORDERS: usize = 8;
pub const BPS: u64 = 10_000;
pub const DAY_SECONDS: i64 = 86_400;
/// USD amounts stored as u64 are micro-USD (6 dp, like USDC). GMTrade sizes are u128 with 1 USD = 10^20.
/// Multiply micro-USD by this to get GMTrade USD.
pub const MICRO_USD_TO_GM: u128 = 100_000_000_000_000;
/// Highest order fee `set_order_fee` accepts: USDC base units per order ($2) and bps of the order's size (0.1 %).
/// Raising either needs a program upgrade.
pub const MAX_ORDER_FEE_USDC: u64 = 2_000_000;
pub const MAX_ORDER_FEE_BPS: u16 = 10;

pub fn to_gm_usd(micro_usd: u64) -> Result<u128> {
    (micro_usd as u128).checked_mul(MICRO_USD_TO_GM).ok_or_else(|| error!(VaultError::MathOverflow))
}

/// `amount × bps / 10_000`, rounded down.
pub fn apply_bps(amount: u64, bps: u16) -> Result<u64> {
    let v = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or_else(|| error!(VaultError::MathOverflow))?
        / BPS as u128;
    u64::try_from(v).map_err(|_| error!(VaultError::MathOverflow))
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, InitSpace, Debug)]
pub struct Pauses {
    pub new_evaluations: bool,
    pub trading: bool,
    pub payouts: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct ConfigParams {
    pub trader_share_bps: u16,
    /// Minimum trader share of a payout, USDC base units.
    pub min_payout: u64,
    /// Owner PDA SOL float, lamports: topped up to `owner_sol_target` whenever it drops below `owner_sol_min`.
    pub owner_sol_target: u64,
    pub owner_sol_min: u64,
    /// Principal `activate_funded` may post per day, USDC base units. Bounds what a compromised risk or KYC key, or a
    /// tampered server database (evaluation results and identities are decided off-chain), can put at risk.
    pub max_daily_principal: u64,
}

impl ConfigParams {
    pub fn validate(&self, rent_exempt_min: u64) -> Result<()> {
        require!(self.trader_share_bps as u64 <= BPS, VaultError::InvalidParams);
        require!(self.min_payout > 0, VaultError::InvalidParams);
        require!(self.owner_sol_min >= rent_exempt_min, VaultError::InvalidParams);
        require!(self.owner_sol_target >= self.owner_sol_min, VaultError::InvalidParams);
        require!(self.max_daily_principal > 0, VaultError::InvalidParams);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Option<Pubkey>,
    #[max_len(MAX_RISK_AUTHORITIES)]
    pub risk_authorities: Vec<Pubkey>,
    /// `Pubkey::default()` until set.
    pub kyc_authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub gmtrade_program: Pubkey,
    pub gmtrade_store: Pubkey,
    /// ATA(vault, USDC), recorded at initialize.
    pub capital_vault: Pubkey,
    pub trader_share_bps: u16,
    pub min_payout: u64,
    pub owner_sol_target: u64,
    pub owner_sol_min: u64,
    pub max_daily_principal: u64,
    /// The current activation window: it opens with the first activation after the previous one ended, lasts a day,
    /// and `principal_in_window` counts what was posted in it.
    pub principal_window_start: i64,
    pub principal_in_window: u64,
    pub paused: Pauses,
    /// Totals, USDC base units.
    pub fees_collected: u64,
    pub allocated_principal: u64,
    pub payouts_paid: u64,
    pub profit_to_vault: u64,
    pub evaluations_sold: u64,
    pub funded_activated: u64,
    pub funded_active: u32,
    pub bump: u8,
    pub vault_bump: u8,
    pub fee_vault_bump: u8,
    pub sol_treasury_bump: u8,
    /// Props.trade's fee per trader-placed order, set by `set_order_fee`: `order_fee_usdc` (USDC base units) plus
    /// `order_fee_bps` of the order's USD size. 0 = off.
    pub order_fee_usdc: u64,
    pub order_fee_bps: u16,
}

impl Config {
    pub fn is_risk_authority(&self, key: &Pubkey) -> bool {
        self.risk_authorities.contains(key)
    }

    /// The fee of an order of `size` (GMTrade USD) counting at most `cap` of it: `order_fee_usdc` + `order_fee_bps` of
    /// the size in micro-USD, each step rounded down; 0 for a size of 0 (a collateral-only increase).
    pub fn order_fee(&self, size: u128, cap: u128) -> Result<u64> {
        if size == 0 {
            return Ok(0);
        }
        let micro = u64::try_from(size.min(cap) / MICRO_USD_TO_GM).map_err(|_| error!(VaultError::MathOverflow))?;
        self.order_fee_usdc.checked_add(apply_bps(micro, self.order_fee_bps)?).ok_or_else(|| error!(VaultError::MathOverflow))
    }

    pub fn set_params(&mut self, p: &ConfigParams) {
        self.trader_share_bps = p.trader_share_bps;
        self.min_payout = p.min_payout;
        self.owner_sol_target = p.owner_sol_target;
        self.owner_sol_min = p.owner_sol_min;
        self.max_daily_principal = p.max_daily_principal;
    }

    /// Counts `principal` against the day's activation limit.
    // ponytail: a window anchored at its first activation lets up to 2× the limit through across a window edge; keep
    // per-activation timestamps for a true rolling day if that matters.
    pub fn allocate_daily_principal(&mut self, principal: u64, now: i64) -> Result<()> {
        if now >= self.principal_window_start.saturating_add(DAY_SECONDS) {
            self.principal_window_start = now;
            self.principal_in_window = 0;
        }
        let used = self.principal_in_window.checked_add(principal).ok_or(VaultError::MathOverflow)?;
        require!(used <= self.max_daily_principal, VaultError::DailyPrincipalLimit);
        self.principal_in_window = used;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct TierParams {
    /// Account size S, micro-USD.
    pub size_usd: u64,
    /// Evaluation fee, USDC base units.
    pub fee_usdc: u64,
    pub profit_target_bps: u16,
    pub max_drawdown_bps: u16,
    pub max_exposure_bps: u16,
    pub enabled: bool,
    pub terms_hash: [u8; 32],
}

impl TierParams {
    pub fn validate(&self) -> Result<()> {
        require!(self.size_usd > 0 && self.fee_usdc > 0, VaultError::InvalidParams);
        require!(self.profit_target_bps > 0, VaultError::InvalidParams);
        require!(self.max_drawdown_bps > 0 && self.max_drawdown_bps as u64 <= BPS, VaultError::InvalidParams);
        require!(self.max_exposure_bps > 0, VaultError::InvalidParams);
        require!(self.terms_hash != [0; 32], VaultError::InvalidParams);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Tier {
    pub id: u16,
    pub size_usd: u64,
    pub fee_usdc: u64,
    pub profit_target_bps: u16,
    pub max_drawdown_bps: u16,
    pub max_exposure_bps: u16,
    pub enabled: bool,
    pub terms_hash: [u8; 32],
    /// Incremented on every upsert; snapshotted into evaluations.
    pub version: u32,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct MarketParams {
    pub enabled: bool,
    pub index_symbol: [u8; 16],
    /// Leverage limits as size / collateral in bps (25× = 250_000).
    pub max_leverage_bps: u32,
    pub closed_max_leverage_bps: u32,
    /// Per funded position, micro-USD.
    pub max_position_usd: u64,
    /// All funded accounts together, per side, micro-USD.
    pub max_total_oi_usd: u64,
    pub session_restricted: bool,
}

impl MarketParams {
    pub fn validate(&self) -> Result<()> {
        require!(self.max_leverage_bps as u64 >= BPS, VaultError::InvalidParams);
        require!(self.closed_max_leverage_bps <= self.max_leverage_bps, VaultError::InvalidParams);
        require!(self.max_position_usd > 0 && self.max_total_oi_usd >= self.max_position_usd, VaultError::InvalidParams);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct MarketConfig {
    pub market_token: Pubkey,
    /// GMTrade Market account (pure USDC-USDC, verified at upsert).
    pub gm_market: Pubkey,
    pub enabled: bool,
    pub index_symbol: [u8; 16],
    pub max_leverage_bps: u32,
    pub closed_max_leverage_bps: u32,
    pub max_position_usd: u64,
    pub max_total_oi_usd: u64,
    /// Committed funded open interest (synced size + pending increase orders), GMTrade USD.
    pub oi_long_usd: u128,
    pub oi_short_usd: u128,
    pub session_restricted: bool,
    pub bump: u8,
}

impl MarketConfig {
    pub fn set_params(&mut self, p: &MarketParams) {
        self.enabled = p.enabled;
        self.index_symbol = p.index_symbol;
        self.max_leverage_bps = p.max_leverage_bps;
        self.closed_max_leverage_bps = p.closed_max_leverage_bps;
        self.max_position_usd = p.max_position_usd;
        self.max_total_oi_usd = p.max_total_oi_usd;
        self.session_restricted = p.session_restricted;
    }

    pub fn oi_mut(&mut self, is_long: bool) -> &mut u128 {
        if is_long {
            &mut self.oi_long_usd
        } else {
            &mut self.oi_short_usd
        }
    }

    /// Applies `new − old` to the side's open interest.
    pub fn apply_oi_change(&mut self, is_long: bool, old: u128, new: u128) -> Result<()> {
        let oi = self.oi_mut(is_long);
        *oi = oi
            .checked_add(new)
            .and_then(|v| v.checked_sub(old))
            .ok_or_else(|| error!(VaultError::MathOverflow))?;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct TraderProfile {
    pub wallet: Pubkey,
    /// Zero until the KYC authority verifies the wallet.
    pub identity_hash: [u8; 32],
    pub verified_at: i64,
    pub active_funded: u8,
    pub evaluation_count: u32,
    pub bump: u8,
}

impl TraderProfile {
    pub fn is_verified(&self) -> bool {
        self.identity_hash != [0; 32]
    }
}

/// One per person: `init`-only, so an identity can be attached to one wallet.
#[account]
#[derive(InitSpace)]
pub struct IdentityLock {
    pub profile: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, InitSpace, Debug)]
pub struct Terms {
    /// Account size S, micro-USD.
    pub size_usd: u64,
    pub profit_target_bps: u16,
    pub max_drawdown_bps: u16,
    pub max_exposure_bps: u16,
    pub trader_share_bps: u16,
    pub terms_hash: [u8; 32],
    pub tier_version: u32,
}

impl Terms {
    /// L = S × max drawdown: the USDC principal a funded account receives.
    pub fn loss_allowance(&self) -> Result<u64> {
        apply_bps(self.size_usd, self.max_drawdown_bps)
    }

    /// S × max exposure, GMTrade USD.
    pub fn max_exposure_gm(&self) -> Result<u128> {
        to_gm_usd(apply_bps(self.size_usd, self.max_exposure_bps)?)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum EvaluationStatus {
    Active,
    Passed,
    Failed,
    Funded,
}

#[account]
#[derive(InitSpace)]
pub struct Evaluation {
    pub trader: Pubkey,
    pub index: u32,
    pub tier_id: u16,
    pub terms: Terms,
    pub fee_paid: u64,
    pub status: EvaluationStatus,
    pub created_at: i64,
    pub resolved_at: i64,
    /// Micro-USD.
    pub final_equity: i64,
    pub trades_root: [u8; 32],
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum FundedStatus {
    Active,
    Restricted,
    PayoutPending,
    Breached,
    Closed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, InitSpace, Debug)]
pub enum OrderType {
    #[default]
    Market,
    Limit,
    Close,
    TakeProfit,
    StopLoss,
}

impl OrderType {
    pub fn is_increase(self) -> bool {
        matches!(self, OrderType::Market | OrderType::Limit)
    }

    /// GMTrade only lets owners update limit and trigger orders.
    pub fn is_updatable(self) -> bool {
        matches!(self, OrderType::Limit | OrderType::TakeProfit | OrderType::StopLoss)
    }
}

/// One GMTrade position (market, side) of a funded account. Free when `market_token` is default.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, InitSpace, Debug)]
pub struct Slot {
    pub market_token: Pubkey,
    pub gm_position: Pubkey,
    pub is_long: bool,
    /// Position collateral (USDC base units) and size (GMTrade USD) at the last sync.
    pub collateral: u64,
    pub size_usd: u128,
    /// Σ size of tracked, pending increase orders on this slot.
    pub pending_usd: u128,
    pub last_sync: i64,
}

impl Slot {
    pub fn is_free(&self) -> bool {
        self.market_token == Pubkey::default()
    }

    /// Exposure this slot holds against account and market limits.
    pub fn committed(&self) -> Result<u128> {
        self.size_usd.checked_add(self.pending_usd).ok_or_else(|| error!(VaultError::MathOverflow))
    }
}

/// A GMTrade order owned by the account's owner PDA. Free when `order` is default.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, InitSpace, Debug)]
pub struct TrackedOrder {
    pub order: Pubkey,
    pub slot: u8,
    pub order_type: OrderType,
    pub size_usd: u128,
    pub collateral: u64,
    /// Orders placed by a risk authority (forced closes) cannot be cancelled by the trader.
    pub placed_by_risk: bool,
}

impl TrackedOrder {
    pub fn is_free(&self) -> bool {
        self.order == Pubkey::default()
    }
}

#[account]
#[derive(InitSpace)]
pub struct FundedAccount {
    pub trader: Pubkey,
    pub evaluation: Pubkey,
    pub terms: Terms,
    /// USDC posted from the capital vault (= L).
    pub principal: u64,
    pub status: FundedStatus,
    pub slots: [Slot; MAX_SLOTS],
    pub orders: [TrackedOrder; MAX_ORDERS],
    /// GMTrade orders created so far; the next order's nonce (see `next_order_nonce`).
    pub order_seq: u64,
    pub payouts_paid: u64,
    pub payout_seq: u32,
    pub created_at: i64,
    pub last_sync_at: i64,
    pub bump: u8,
    pub owner_bump: u8,
    /// The fee assessed on `orders[j]` (USDC base units); 0 while `orders[j]` is free or was placed by a risk authority.
    pub order_fees: [u64; MAX_ORDERS],
    /// Assessed fees of orders that left the book other than through `cancel_order` (executed, or cancelled by the
    /// exchange), not settled yet.
    pub order_fees_due: u64,
    /// Order fees charged to the fee vault so far.
    pub order_fees_paid: u64,
    /// Settlements so far. `settle_order_fees` names the count it was computed from and advances it, so a settlement
    /// lands once even when `order_fees_due` returns to the value it was computed from.
    pub order_fee_settlements: u64,
}

impl FundedAccount {
    pub fn find_slot(&self, market_token: &Pubkey, is_long: bool) -> Option<usize> {
        self.slots.iter().position(|s| !s.is_free() && s.market_token == *market_token && s.is_long == is_long)
    }

    pub fn find_order(&self, order: &Pubkey) -> Option<usize> {
        self.orders.iter().position(|o| !o.is_free() && o.order == *order)
    }

    pub fn tracked_orders(&self) -> usize {
        self.orders.iter().filter(|o| !o.is_free()).count()
    }

    pub fn is_flat(&self) -> bool {
        self.slots.iter().all(Slot::is_free) && self.orders.iter().all(TrackedOrder::is_free)
    }

    /// Σ committed size over all slots, GMTrade USD.
    pub fn committed_exposure(&self) -> Result<u128> {
        self.slots.iter().try_fold(0u128, |acc, s| {
            acc.checked_add(s.committed()?).ok_or_else(|| error!(VaultError::MathOverflow))
        })
    }

    /// GMTrade nonce of the next order. The order address is PDA(store, owner, nonce); the owner PDA belongs
    /// to this account alone and only this program signs for it, so a counter never repeats an address.
    pub fn next_order_nonce(&self) -> [u8; 32] {
        let mut nonce = [0u8; 32];
        nonce[..8].copy_from_slice(&self.order_seq.to_le_bytes());
        nonce
    }

    /// Tracks the order just created with `next_order_nonce`, with its assessed fee, and advances the counter.
    pub fn track_order(&mut self, order: TrackedOrder, fee: u64) -> Result<()> {
        require!(self.find_order(&order.order).is_none(), VaultError::InvalidOrderAccount);
        let free = self.orders.iter().position(TrackedOrder::is_free).ok_or(VaultError::TooManyOrders)?;
        self.orders[free] = order;
        self.order_fees[free] = fee;
        self.order_seq = self.order_seq.checked_add(1).ok_or(VaultError::MathOverflow)?;
        Ok(())
    }

    /// The fees an order that adds exposure must leave in the account's USDC: fees due plus the fees of tracked increase
    /// orders. Decrease orders hold nothing while tracked (a take profit and a stop loss are each assessed at their
    /// maximum, and at most one executes); an executed one's fee is held from the sync that makes it due.
    pub fn reserved_fees(&self) -> Result<u64> {
        self.orders.iter().zip(self.order_fees).try_fold(self.order_fees_due, |acc, (o, fee)| {
            if o.is_free() || !o.order_type.is_increase() {
                return Ok(acc);
            }
            acc.checked_add(fee).ok_or_else(|| error!(VaultError::MathOverflow))
        })
    }

    /// `orders[j]` left the book other than through `cancel_order` (executed, or cancelled by the exchange): its fee
    /// becomes due, for a risk authority to charge or waive.
    pub fn make_fee_due(&mut self, j: usize) -> Result<()> {
        self.order_fees_due = self.order_fees_due.checked_add(self.order_fees[j]).ok_or(VaultError::MathOverflow)?;
        self.order_fees[j] = 0;
        Ok(())
    }

    /// Frees a slot whose position is flat with no pending or tracked orders.
    pub fn release_slot_if_idle(&mut self, slot: usize) {
        let s = &self.slots[slot];
        let referenced = self.orders.iter().any(|o| !o.is_free() && o.slot as usize == slot);
        if !s.is_free() && s.size_usd == 0 && s.pending_usd == 0 && !referenced {
            self.slots[slot] = Slot::default();
        }
    }

    /// Accounts that can still hold positions or orders.
    pub fn is_open(&self) -> bool {
        self.status != FundedStatus::Closed
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum PayoutStatus {
    Requested,
    Paid,
    Rejected,
    Cancelled,
}

#[account]
#[derive(InitSpace)]
pub struct PayoutRequest {
    pub funded: Pubkey,
    pub trader: Pubkey,
    pub seq: u32,
    /// USDC base units.
    pub balance_at_request: u64,
    pub profit: u64,
    pub trader_amount: u64,
    pub vault_amount: u64,
    pub status: PayoutStatus,
    pub reason_code: u16,
    pub created_at: i64,
    pub resolved_at: i64,
    pub bump: u8,
}
