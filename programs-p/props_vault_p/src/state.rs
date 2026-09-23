//! Account layouts, byte for byte the Anchor borsh layout of programs/props_vault/src/state.rs (8-byte discriminator
//! sha256("account:<Name>")[..8], then the fields in order, little-endian, no padding). Fixed-size accounts are
//! zero-copy views (`load::<T>`); `Config` has an `Option<Pubkey>` and a `Vec<Pubkey>` and gets its own view.
use core::mem::size_of;
use pinocchio::{AccountView, Address};

use crate::{
    accounts::SYSTEM_PROGRAM_ID,
    error::{require, Error, Result, E},
};

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
/// Micro-USD (u64, 6 dp) × this = GMTrade USD (u128, 1 USD = 10^20).
pub const MICRO_USD_TO_GM: u128 = 100_000_000_000_000;

pub fn to_gm_usd(micro_usd: u64) -> Result<u128> {
    (micro_usd as u128).checked_mul(MICRO_USD_TO_GM).ok_or(E::MathOverflow.into())
}

/// `amount × bps / 10_000`, rounded down.
pub fn apply_bps(amount: u64, bps: u16) -> Result<u64> {
    let v = (amount as u128).checked_mul(bps as u128).ok_or(Error::from(E::MathOverflow))? / BPS as u128;
    u64::try_from(v).map_err(|_| E::MathOverflow.into())
}

// ---------- little-endian field types (alignment 1, so any account offset works) ----------

macro_rules! le {
    ($($name:ident: $t:ty),*) => {$(
        #[repr(transparent)]
        #[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
        pub struct $name([u8; size_of::<$t>()]);
        impl $name {
            #[inline(always)]
            pub fn get(&self) -> $t {
                <$t>::from_le_bytes(self.0)
            }
            #[inline(always)]
            pub fn set(&mut self, v: $t) {
                self.0 = v.to_le_bytes();
            }
        }
    )*};
}
le!(U16: u16, U32: u32, U64: u64, I64: i64, U128: u128);

/// Borsh bool: 0 or 1.
#[repr(transparent)]
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Bool(u8);
impl Bool {
    #[inline(always)]
    pub fn get(&self) -> bool {
        self.0 != 0
    }
    #[inline(always)]
    pub fn set(&mut self, v: bool) {
        self.0 = v as u8;
    }
}

const _: () = assert!(size_of::<Address>() == 32 && core::mem::align_of::<Address>() == 1);

// ---------- enums (borsh: one byte, the variant index) ----------

pub mod evaluation_status {
    pub const ACTIVE: u8 = 0;
    pub const PASSED: u8 = 1;
    pub const FAILED: u8 = 2;
    pub const FUNDED: u8 = 3;
}
pub mod funded_status {
    pub const ACTIVE: u8 = 0;
    pub const RESTRICTED: u8 = 1;
    pub const PAYOUT_PENDING: u8 = 2;
    pub const BREACHED: u8 = 3;
    pub const CLOSED: u8 = 4;
}
pub mod order_type {
    pub const MARKET: u8 = 0;
    pub const LIMIT: u8 = 1;
    pub const CLOSE: u8 = 2;
    pub const TAKE_PROFIT: u8 = 3;
    pub const STOP_LOSS: u8 = 4;
    /// Number of variants (instruction args are refused beyond it, as borsh does).
    pub const COUNT: u8 = 5;

    pub fn is_increase(t: u8) -> bool {
        t == MARKET || t == LIMIT
    }

    /// GMTrade only lets owners update limit and trigger orders.
    pub fn is_updatable(t: u8) -> bool {
        t == LIMIT || t == TAKE_PROFIT || t == STOP_LOSS
    }
}
pub mod payout_status {
    pub const REQUESTED: u8 = 0;
    pub const PAID: u8 = 1;
    pub const REJECTED: u8 = 2;
    pub const CANCELLED: u8 = 3;
}

// ---------- fixed-size accounts ----------

/// An account type owned by this program: its Anchor discriminator. The struct is the body after it.
pub trait Data: Sized {
    const DISC: [u8; 8];
    /// Anchor `space` = 8 + INIT_SPACE.
    const SPACE: usize = 8 + size_of::<Self>();
}

/// Anchor `Account<'info, T>` (`Account::try_from`): initialized, owned by this program, discriminator, size.
/// Returns a view into the account data (the runtime's input buffer, not the `AccountView`). Load each account at most
/// once: two views of one account alias. PDA and discriminator checks make that impossible for distinct fields.
#[allow(clippy::mut_from_ref)]
pub fn load<T: Data>(view: &AccountView) -> Result<&mut T> {
    // SAFETY: T is repr(C) of alignment-1 fields and the data holds at least SPACE bytes.
    Ok(unsafe { &mut *(load_raw(view, &T::DISC, T::SPACE)? as *mut T) })
}

/// `load` without the type (one copy of the code for every account type): the account body after the discriminator.
#[inline(never)]
pub(crate) fn load_raw(view: &AccountView, disc: &[u8; 8], space: usize) -> Result<*mut u8> {
    initialized_and_owned(view, &crate::ID)?;
    let d = check_disc(view, disc)?;
    require(view.data_len() >= space, E::AccountDidNotDeserialize)?;
    // SAFETY: at least 8 bytes of data.
    Ok(unsafe { d.add(8) })
}

/// Anchor's `Account::try_from` preamble: `AccountNotInitialized`, then `AccountOwnedByWrongProgram`.
pub(crate) fn initialized_and_owned(view: &AccountView, owner: &Address) -> Result {
    require(!(view.owned_by(&SYSTEM_PROGRAM_ID) && view.lamports() == 0), E::AccountNotInitialized)?;
    require(view.owned_by(owner), E::AccountOwnedByWrongProgram)
}

fn check_disc(view: &AccountView, disc: &[u8; 8]) -> Result<*mut u8> {
    require(view.data_len() >= 8, E::AccountDiscriminatorNotFound)?;
    let mut v = *view;
    let d = v.data_mut_ptr();
    // SAFETY: at least 8 bytes of data.
    require(unsafe { *(d as *const [u8; 8]) } == *disc, E::AccountDiscriminatorMismatch)?;
    Ok(d)
}

#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Pauses {
    pub new_evaluations: Bool,
    pub trading: Bool,
    pub payouts: Bool,
}

#[repr(C)]
pub struct Tier {
    pub id: U16,
    /// Account size S, micro-USD.
    pub size_usd: U64,
    /// Evaluation fee, USDC base units.
    pub fee_usdc: U64,
    pub profit_target_bps: U16,
    pub max_drawdown_bps: U16,
    pub max_exposure_bps: U16,
    pub enabled: Bool,
    pub terms_hash: [u8; 32],
    /// Incremented on every upsert; snapshotted into evaluations.
    pub version: U32,
    pub bump: u8,
}
impl Data for Tier {
    const DISC: [u8; 8] = [18, 149, 18, 34, 50, 201, 207, 55];
}

#[repr(C)]
pub struct MarketConfig {
    pub market_token: Address,
    /// GMTrade Market account (pure USDC-USDC, verified at upsert).
    pub gm_market: Address,
    pub enabled: Bool,
    pub index_symbol: [u8; 16],
    pub max_leverage_bps: U32,
    pub closed_max_leverage_bps: U32,
    pub max_position_usd: U64,
    pub max_total_oi_usd: U64,
    /// Committed funded open interest (synced size + pending increase orders), GMTrade USD.
    pub oi_long_usd: U128,
    pub oi_short_usd: U128,
    pub session_restricted: Bool,
    pub bump: u8,
}
impl Data for MarketConfig {
    const DISC: [u8; 8] = [119, 255, 200, 88, 252, 82, 128, 24];
}
impl MarketConfig {
    pub fn set_params(&mut self, p: &MarketParams) {
        self.enabled.set(p.enabled);
        self.index_symbol = p.index_symbol;
        self.max_leverage_bps.set(p.max_leverage_bps);
        self.closed_max_leverage_bps.set(p.closed_max_leverage_bps);
        self.max_position_usd.set(p.max_position_usd);
        self.max_total_oi_usd.set(p.max_total_oi_usd);
        self.session_restricted.set(p.session_restricted);
    }

    pub fn oi(&self, is_long: bool) -> u128 {
        if is_long {
            self.oi_long_usd.get()
        } else {
            self.oi_short_usd.get()
        }
    }

    /// Applies `new − old` to the side's open interest.
    pub fn apply_oi_change(&mut self, is_long: bool, old: u128, new: u128) -> Result {
        let oi = if is_long { &mut self.oi_long_usd } else { &mut self.oi_short_usd };
        oi.set(oi.get().checked_add(new).and_then(|v| v.checked_sub(old)).ok_or(Error::from(E::MathOverflow))?);
        Ok(())
    }
}

#[repr(C)]
pub struct TraderProfile {
    pub wallet: Address,
    /// Zero until the KYC authority verifies the wallet.
    pub identity_hash: [u8; 32],
    pub verified_at: I64,
    pub active_funded: u8,
    pub evaluation_count: U32,
    pub bump: u8,
}
impl Data for TraderProfile {
    const DISC: [u8; 8] = [99, 135, 170, 100, 49, 79, 225, 169];
}
impl TraderProfile {
    pub fn is_verified(&self) -> bool {
        self.identity_hash != [0; 32]
    }
}

/// One per person: `init`-only, so an identity can be attached to one wallet.
#[repr(C)]
pub struct IdentityLock {
    pub profile: Address,
    pub bump: u8,
}
impl Data for IdentityLock {
    const DISC: [u8; 8] = [248, 246, 9, 101, 144, 56, 209, 232];
}

#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Terms {
    /// Account size S, micro-USD.
    pub size_usd: U64,
    pub profit_target_bps: U16,
    pub max_drawdown_bps: U16,
    pub max_exposure_bps: U16,
    pub trader_share_bps: U16,
    pub terms_hash: [u8; 32],
    pub tier_version: U32,
}
impl Terms {
    /// L = S × max drawdown: the USDC principal a funded account receives.
    pub fn loss_allowance(&self) -> Result<u64> {
        apply_bps(self.size_usd.get(), self.max_drawdown_bps.get())
    }

    /// S × max exposure, GMTrade USD.
    pub fn max_exposure_gm(&self) -> Result<u128> {
        to_gm_usd(apply_bps(self.size_usd.get(), self.max_exposure_bps.get())?)
    }
}

#[repr(C)]
pub struct Evaluation {
    pub trader: Address,
    pub index: U32,
    pub tier_id: U16,
    pub terms: Terms,
    pub fee_paid: U64,
    /// `evaluation_status::*`.
    pub status: u8,
    pub created_at: I64,
    pub resolved_at: I64,
    /// Micro-USD.
    pub final_equity: I64,
    pub trades_root: [u8; 32],
    pub bump: u8,
}
impl Data for Evaluation {
    const DISC: [u8; 8] = [212, 70, 25, 106, 239, 24, 93, 220];
}

/// One GMTrade position (market, side) of a funded account. Free when `market_token` is default.
#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Slot {
    pub market_token: Address,
    pub gm_position: Address,
    pub is_long: Bool,
    /// Position collateral (USDC base units) and size (GMTrade USD) at the last sync.
    pub collateral: U64,
    pub size_usd: U128,
    /// Σ size of tracked, pending increase orders on this slot.
    pub pending_usd: U128,
    pub last_sync: I64,
}
impl Slot {
    pub fn is_free(&self) -> bool {
        self.market_token == Address::default()
    }

    /// Exposure this slot holds against account and market limits.
    pub fn committed(&self) -> Result<u128> {
        self.size_usd.get().checked_add(self.pending_usd.get()).ok_or(E::MathOverflow.into())
    }
}

/// A GMTrade order owned by the account's owner PDA. Free when `order` is default.
#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct TrackedOrder {
    pub order: Address,
    pub slot: u8,
    /// `order_type::*`.
    pub order_type: u8,
    pub size_usd: U128,
    pub collateral: U64,
    /// Orders placed by a risk authority (forced closes) cannot be cancelled by the trader.
    pub placed_by_risk: Bool,
}
impl TrackedOrder {
    pub fn is_free(&self) -> bool {
        self.order == Address::default()
    }
}

#[repr(C)]
pub struct FundedAccount {
    pub trader: Address,
    pub evaluation: Address,
    pub terms: Terms,
    /// USDC posted from the capital vault (= L).
    pub principal: U64,
    /// `funded_status::*`.
    pub status: u8,
    pub slots: [Slot; MAX_SLOTS],
    pub orders: [TrackedOrder; MAX_ORDERS],
    /// GMTrade orders created so far; the next order's nonce (see `next_order_nonce`).
    pub order_seq: U64,
    pub payouts_paid: U64,
    pub payout_seq: U32,
    pub created_at: I64,
    pub last_sync_at: I64,
    pub bump: u8,
    pub owner_bump: u8,
}
impl Data for FundedAccount {
    const DISC: [u8; 8] = [243, 213, 249, 109, 66, 122, 63, 208];
}
impl FundedAccount {
    pub fn find_slot(&self, market_token: &Address, is_long: bool) -> Option<usize> {
        self.slots.iter().position(|s| !s.is_free() && s.market_token == *market_token && s.is_long.get() == is_long)
    }

    pub fn find_order(&self, order: &Address) -> Option<usize> {
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
        self.slots.iter().try_fold(0u128, |acc, s| acc.checked_add(s.committed()?).ok_or(E::MathOverflow.into()))
    }

    /// GMTrade nonce of the next order: `order_seq` little-endian in the first 8 bytes.
    pub fn next_order_nonce(&self) -> [u8; 32] {
        let mut nonce = [0u8; 32];
        nonce[..8].copy_from_slice(&self.order_seq.0);
        nonce
    }

    /// Tracks the order just created with `next_order_nonce` and advances the counter.
    pub fn track_order(&mut self, order: TrackedOrder) -> Result {
        require(self.find_order(&order.order).is_none(), E::InvalidOrderAccount)?;
        let free = self.orders.iter().position(TrackedOrder::is_free).ok_or(Error::from(E::TooManyOrders))?;
        self.orders[free] = order;
        self.order_seq.set(self.order_seq.get().checked_add(1).ok_or(Error::from(E::MathOverflow))?);
        Ok(())
    }

    /// Frees a slot whose position is flat with no pending or tracked orders.
    pub fn release_slot_if_idle(&mut self, slot: usize) {
        let s = &self.slots[slot];
        let referenced = self.orders.iter().any(|o| !o.is_free() && o.slot as usize == slot);
        if !s.is_free() && s.size_usd.get() == 0 && s.pending_usd.get() == 0 && !referenced {
            self.slots[slot] = Slot::default();
        }
    }

    /// Accounts that can still hold positions or orders.
    pub fn is_open(&self) -> bool {
        self.status != funded_status::CLOSED
    }
}

#[repr(C)]
pub struct PayoutRequest {
    pub funded: Address,
    pub trader: Address,
    pub seq: U32,
    /// USDC base units.
    pub balance_at_request: U64,
    pub profit: U64,
    pub trader_amount: U64,
    pub vault_amount: U64,
    /// `payout_status::*`.
    pub status: u8,
    pub reason_code: U16,
    pub created_at: I64,
    pub resolved_at: I64,
    pub bump: u8,
}
impl Data for PayoutRequest {
    const DISC: [u8; 8] = [182, 69, 255, 168, 65, 179, 121, 171];
}

// Anchor INIT_SPACE of each account (checked against the IDL-derived sizes in PORTING.md).
const _: () = {
    assert!(size_of::<Tier>() == 62);
    assert!(size_of::<MarketConfig>() == 139);
    assert!(size_of::<TraderProfile>() == 78);
    assert!(size_of::<IdentityLock>() == 33);
    assert!(size_of::<Terms>() == 52);
    assert!(size_of::<Evaluation>() == 156);
    assert!(size_of::<Slot>() == 113);
    assert!(size_of::<TrackedOrder>() == 59);
    assert!(size_of::<FundedAccount>() == 1539);
    assert!(size_of::<PayoutRequest>() == 120);
    assert!(size_of::<ConfigTail>() == 269);
};

// ---------- Config ----------

pub const CONFIG_DISC: [u8; 8] = [155, 12, 170, 224, 30, 250, 204, 130];
/// 8 + INIT_SPACE: admin 32, Option<Pubkey> 33, Vec<Pubkey> 4 + 4 × 32, tail 269.
pub const CONFIG_SPACE: usize = 8 + 32 + 33 + 4 + 32 * MAX_RISK_AUTHORITIES + size_of::<ConfigTail>();
const PENDING_TAG: usize = 40;

/// Config fields after `risk_authorities` (fixed layout; their offset moves with `pending_admin` and the list).
#[repr(C)]
pub struct ConfigTail {
    /// `Pubkey::default()` until set.
    pub kyc_authority: Address,
    pub usdc_mint: Address,
    pub gmtrade_program: Address,
    pub gmtrade_store: Address,
    /// ATA(vault, USDC), recorded at initialize.
    pub capital_vault: Address,
    pub trader_share_bps: U16,
    pub min_payout: U64,
    pub owner_sol_target: U64,
    pub owner_sol_min: U64,
    pub max_daily_principal: U64,
    pub principal_window_start: I64,
    pub principal_in_window: U64,
    pub paused: Pauses,
    pub fees_collected: U64,
    pub allocated_principal: U64,
    pub payouts_paid: U64,
    pub profit_to_vault: U64,
    pub evaluations_sold: U64,
    pub funded_activated: U64,
    pub funded_active: U32,
    pub bump: u8,
    pub vault_bump: u8,
    pub fee_vault_bump: u8,
    pub sol_treasury_bump: u8,
}

impl ConfigTail {
    pub fn set_params(&mut self, p: &ConfigParams) {
        self.trader_share_bps.set(p.trader_share_bps);
        self.min_payout.set(p.min_payout);
        self.owner_sol_target.set(p.owner_sol_target);
        self.owner_sol_min.set(p.owner_sol_min);
        self.max_daily_principal.set(p.max_daily_principal);
    }

    /// Counts `principal` against the day's activation limit.
    // ponytail: a window anchored at its first activation lets up to 2× the limit through across a window edge; keep
    // per-activation timestamps for a true rolling day if that matters (same as the Anchor program).
    pub fn allocate_daily_principal(&mut self, principal: u64, now: i64) -> Result {
        if now >= self.principal_window_start.get().saturating_add(DAY_SECONDS) {
            self.principal_window_start.set(now);
            self.principal_in_window.set(0);
        }
        let used = self.principal_in_window.get().checked_add(principal).ok_or(Error::from(E::MathOverflow))?;
        require(used <= self.max_daily_principal.get(), E::DailyPrincipalLimit)?;
        self.principal_in_window.set(used);
        Ok(())
    }
}

/// View of the Config account. Borsh: disc, admin, pending_admin (tag + 0|32), risk_authorities (u32 + 32·n), tail.
/// Setters of `pending_admin` / `risk_authorities` move the tail the way Anchor's re-serialization does (bytes after
/// the new end are left as they were).
pub struct Config {
    data: *mut u8,
    len: usize,
    tail: usize,
}

impl Config {
    /// Anchor `Account<'info, Config>`.
    pub fn load(view: &AccountView) -> Result<Config> {
        initialized_and_owned(view, &crate::ID)?;
        let data = check_disc(view, &CONFIG_DISC)?;
        let len = view.data_len();
        let mut c = Config { data, len, tail: 0 };
        require(len > PENDING_TAG, E::AccountDidNotDeserialize)?;
        let tag = c.byte(PENDING_TAG) as usize;
        require(tag <= 1, E::AccountDidNotDeserialize)?;
        let list = PENDING_TAG + 1 + 32 * tag;
        require(len >= list + 4, E::AccountDidNotDeserialize)?;
        let n = u32::from_le_bytes(c.bytes::<4>(list)) as u64;
        let tail = list as u64 + 4 + 32 * n;
        require(tail + size_of::<ConfigTail>() as u64 <= len as u64, E::AccountDidNotDeserialize)?;
        c.tail = tail as usize;
        Ok(c)
    }

    /// A zero-filled account just created for Config: writes the discriminator, admin, no pending admin, no list.
    pub(crate) fn init(view: &AccountView, admin: &Address) -> Config {
        let mut v = *view;
        let data = v.data_mut_ptr();
        let mut c = Config { data, len: view.data_len(), tail: PENDING_TAG + 1 + 4 };
        c.write(0, &CONFIG_DISC);
        c.write(8, admin.as_array());
        c.write(PENDING_TAG, &[0, 0, 0, 0, 0]);
        c
    }

    fn byte(&self, at: usize) -> u8 {
        // SAFETY: callers stay within `len`.
        unsafe { *self.data.add(at) }
    }

    fn bytes<const N: usize>(&self, at: usize) -> [u8; N] {
        // SAFETY: callers stay within `len`.
        unsafe { (self.data.add(at) as *const [u8; N]).read() }
    }

    fn write(&mut self, at: usize, src: &[u8]) {
        assert!(at + src.len() <= self.len);
        // SAFETY: bounds checked above.
        unsafe { core::ptr::copy_nonoverlapping(src.as_ptr(), self.data.add(at), src.len()) }
    }

    fn address_at(&self, at: usize) -> &Address {
        // SAFETY: Address has alignment 1; callers stay within `len`.
        unsafe { &*(self.data.add(at) as *const Address) }
    }

    pub fn admin(&self) -> &Address {
        self.address_at(8)
    }

    pub fn set_admin(&mut self, admin: &Address) {
        self.write(8, admin.as_array());
    }

    pub fn pending_admin(&self) -> Option<&Address> {
        (self.byte(PENDING_TAG) == 1).then(|| self.address_at(PENDING_TAG + 1))
    }

    fn list_at(&self) -> usize {
        PENDING_TAG + 1 + 32 * self.byte(PENDING_TAG) as usize
    }

    pub fn risk_authorities(&self) -> &[Address] {
        let list = self.list_at();
        // SAFETY: `load` checked that the list lies before the tail.
        unsafe { core::slice::from_raw_parts(self.data.add(list + 4) as *const Address, (self.tail - list - 4) / 32) }
    }

    pub fn is_risk_authority(&self, key: &Address) -> bool {
        self.risk_authorities().contains(key)
    }

    /// Moves everything after `at` (up to the end of the tail) so that `old` bytes at `at` become `new` bytes.
    fn resize_at(&mut self, at: usize, old: usize, new: usize) -> Result {
        let end = self.tail + size_of::<ConfigTail>();
        require(end - old + new <= self.len, E::AccountDidNotSerialize)?;
        // SAFETY: source and destination ranges lie within `len`; `copy` handles the overlap.
        unsafe { core::ptr::copy(self.data.add(at + old), self.data.add(at + new), end - at - old) };
        self.tail = self.tail - old + new;
        Ok(())
    }

    pub fn set_pending_admin(&mut self, pending: Option<&Address>) -> Result {
        let had = self.byte(PENDING_TAG) as usize * 32;
        match pending {
            Some(key) => {
                self.resize_at(PENDING_TAG + 1, had, 32)?;
                self.write(PENDING_TAG, &[1]);
                self.write(PENDING_TAG + 1, key.as_array());
            }
            None => {
                self.resize_at(PENDING_TAG + 1, had, 0)?;
                self.write(PENDING_TAG, &[0]);
            }
        }
        Ok(())
    }

    pub fn set_risk_authorities(&mut self, keys: &[Address]) -> Result {
        let list = self.list_at();
        let old = self.tail - list - 4;
        self.resize_at(list + 4, old, 32 * keys.len())?;
        self.write(list, &(keys.len() as u32).to_le_bytes());
        for (i, k) in keys.iter().enumerate() {
            self.write(list + 4 + 32 * i, k.as_array());
        }
        Ok(())
    }
}

impl core::ops::Deref for Config {
    type Target = ConfigTail;
    fn deref(&self) -> &ConfigTail {
        // SAFETY: `load`/`init` keep `tail + size_of::<ConfigTail>() <= len`; alignment 1.
        unsafe { &*(self.data.add(self.tail) as *const ConfigTail) }
    }
}

impl core::ops::DerefMut for Config {
    fn deref_mut(&mut self) -> &mut ConfigTail {
        // SAFETY: as in `deref`.
        unsafe { &mut *(self.data.add(self.tail) as *mut ConfigTail) }
    }
}

// ---------- instruction argument types (borsh, in IDL field order) ----------

#[derive(Clone, Copy)]
pub struct ConfigParams {
    pub trader_share_bps: u16,
    /// Minimum trader share of a payout, USDC base units.
    pub min_payout: u64,
    /// Owner PDA SOL float, lamports: topped up to `owner_sol_target` whenever it drops below `owner_sol_min`.
    pub owner_sol_target: u64,
    pub owner_sol_min: u64,
    /// Principal `activate_funded` may post per day, USDC base units.
    pub max_daily_principal: u64,
}

impl ConfigParams {
    pub fn read(a: &mut crate::accounts::Args) -> Result<Self> {
        Ok(ConfigParams {
            trader_share_bps: a.u16()?,
            min_payout: a.u64()?,
            owner_sol_target: a.u64()?,
            owner_sol_min: a.u64()?,
            max_daily_principal: a.u64()?,
        })
    }

    pub fn validate(&self, rent_exempt_min: u64) -> Result {
        require(self.trader_share_bps as u64 <= BPS, E::InvalidParams)?;
        require(self.min_payout > 0, E::InvalidParams)?;
        require(self.owner_sol_min >= rent_exempt_min, E::InvalidParams)?;
        require(self.owner_sol_target >= self.owner_sol_min, E::InvalidParams)?;
        require(self.max_daily_principal > 0, E::InvalidParams)
    }
}

impl Pauses {
    pub fn read(a: &mut crate::accounts::Args) -> Result<Self> {
        let mut p = Pauses::default();
        p.new_evaluations.set(a.bool()?);
        p.trading.set(a.bool()?);
        p.payouts.set(a.bool()?);
        Ok(p)
    }
}

#[derive(Clone, Copy)]
pub struct TierParams {
    pub size_usd: u64,
    pub fee_usdc: u64,
    pub profit_target_bps: u16,
    pub max_drawdown_bps: u16,
    pub max_exposure_bps: u16,
    pub enabled: bool,
    pub terms_hash: [u8; 32],
}

impl TierParams {
    pub fn read(a: &mut crate::accounts::Args) -> Result<Self> {
        Ok(TierParams {
            size_usd: a.u64()?,
            fee_usdc: a.u64()?,
            profit_target_bps: a.u16()?,
            max_drawdown_bps: a.u16()?,
            max_exposure_bps: a.u16()?,
            enabled: a.bool()?,
            terms_hash: *a.array::<32>()?,
        })
    }

    pub fn validate(&self) -> Result {
        require(self.size_usd > 0 && self.fee_usdc > 0, E::InvalidParams)?;
        require(self.profit_target_bps > 0, E::InvalidParams)?;
        require(self.max_drawdown_bps > 0 && self.max_drawdown_bps as u64 <= BPS, E::InvalidParams)?;
        require(self.max_exposure_bps > 0, E::InvalidParams)?;
        require(self.terms_hash != [0; 32], E::InvalidParams)
    }
}

#[derive(Clone, Copy)]
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
    pub fn read(a: &mut crate::accounts::Args) -> Result<Self> {
        Ok(MarketParams {
            enabled: a.bool()?,
            index_symbol: *a.array::<16>()?,
            max_leverage_bps: a.u32()?,
            closed_max_leverage_bps: a.u32()?,
            max_position_usd: a.u64()?,
            max_total_oi_usd: a.u64()?,
            session_restricted: a.bool()?,
        })
    }

    pub fn validate(&self) -> Result {
        require(self.max_leverage_bps as u64 >= BPS, E::InvalidParams)?;
        require(self.closed_max_leverage_bps <= self.max_leverage_bps, E::InvalidParams)?;
        require(self.max_position_usd > 0 && self.max_total_oi_usd >= self.max_position_usd, E::InvalidParams)
    }
}
