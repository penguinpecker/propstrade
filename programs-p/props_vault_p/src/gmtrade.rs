//! GMTrade (gmsol-store v0.10.0) integration: account fields read at fixed offsets (the offsets of
//! programs/props_vault/src/gmtrade.rs, checked there against mainnet accounts) and the CPIs we make, hand-built from
//! tests/program/fixtures/gmsol_store.idl.json the way Anchor 0.31's `declare_program!` client builds them: IDL account
//! order, IDL signer/writable flags, and an absent optional account passed as the GMTrade program id (readonly).
//! Each CPI checks its `program` account is GMTrade before anything is signed (Anchor's `Program<'info, GmsolStore>`),
//! so the owner PDA's signature can only ever reach GMTrade, even from a handler that forgot its own check. GMTrade is
//! upgradeable, so each CPI the owner PDA signs writable is also bounded afterwards (`UnexpectedGmtradeEffect`): the owner
//! PDA stays data-less and system-owned and loses at most the rent and fees the call is for, and the owner's USDC account,
//! when GMTrade gets it, keeps its owner, gets no delegate or close authority, and changes only by the order's collateral.
use pinocchio::{AccountView, Address};

use crate::{
    accounts::{
        create_program_address, program_account, token_account, Rent, GMTRADE_PROGRAM_ID, NONE, SYSTEM_PROGRAM_ID,
    },
    cpi::{create_ata, invoke, r, w, ws, Buf, Meta, Seeds},
    error::{require, Result, E},
    state::order_type,
};

/// gmsol-store `Order::MIN_EXECUTION_LAMPORTS`: the execution fee offered to keepers.
pub const EXECUTION_LAMPORTS: u64 = 300_000;
/// Smallest decrease placed, GMTrade USD: $1 (`min_position_size_usd` on the listed markets).
pub const MIN_DECREASE_USD: u128 = 100_000_000_000_000_000_000;
pub const POSITION_SEED: &[u8] = b"position";

/// `PositionKind`: 1 = long, 2 = short.
pub fn position_kind(is_long: bool) -> u8 {
    if is_long {
        1
    } else {
        2
    }
}

/// Byte offsets (discriminator included) of gmsol-store v0.10.0 zero-copy accounts.
pub mod layout {
    pub const POSITION_LEN: usize = 680;
    pub const POSITION_BUMP: usize = 9;
    pub const POSITION_STORE: usize = 10;
    pub const POSITION_KIND: usize = 42;
    pub const POSITION_OWNER: usize = 56;
    pub const POSITION_MARKET_TOKEN: usize = 88;
    pub const POSITION_COLLATERAL_TOKEN: usize = 120;
    pub const POSITION_COLLATERAL_AMOUNT: usize = 200;
    pub const POSITION_SIZE_IN_USD: usize = 216;

    pub const ORDER_LEN: usize = 2472;
    /// UserHeader (`prepare_user`): 8 + `UserHeader::space(0)`.
    pub const USER_LEN: usize = 520;
    pub const TOKEN_ACCOUNT_LEN: usize = 165;
    pub const ORDER_ACTION_STATE: usize = 9;
    pub const ORDER_INITIAL_COLLATERAL_ESCROW: usize = 592;
    pub const ORDER_FINAL_OUTPUT_ESCROW: usize = 656;
    /// `ActionState::Pending`.
    pub const ACTION_STATE_PENDING: u8 = 0;
    /// `ActionState::Cancelled`: the order never executed.
    pub const ACTION_STATE_CANCELLED: u8 = 2;

    pub const MARKET_MIN_LEN: usize = 248;
    pub const MARKET_TOKEN: usize = 88;
    pub const MARKET_LONG_TOKEN: usize = 152;
    pub const MARKET_SHORT_TOKEN: usize = 184;
    pub const MARKET_STORE: usize = 216;
}
use layout::*;

/// gmsol-store account discriminators (sha256("account:<Name>")[..8]).
pub const MARKET_DISC: [u8; 8] = [219, 190, 213, 55, 0, 227, 198, 154];
pub const ORDER_DISC: [u8; 8] = [134, 173, 223, 185, 77, 86, 28, 51];
pub const POSITION_DISC: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];

fn data(v: &AccountView) -> &[u8] {
    // SAFETY: read-only view; this program holds no mutable borrow of GMTrade accounts.
    unsafe { v.borrow_unchecked() }
}

fn address_at(d: &[u8], at: usize) -> &Address {
    // SAFETY: callers index within length-checked data; Address has alignment 1.
    unsafe { &*(d[at..at + 32].as_ptr() as *const Address) }
}

fn u128_at(d: &[u8], at: usize) -> u128 {
    u128::from_le_bytes(d[at..at + 16].try_into().unwrap())
}

fn is_absent(v: &AccountView) -> bool {
    v.owned_by(&SYSTEM_PROGRAM_ID) && v.is_data_empty()
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct PositionState {
    pub size_usd: u128,
    /// USDC base units.
    pub collateral: u64,
}

pub fn read_position_state(d: &[u8]) -> Result<PositionState> {
    require(d.len() == POSITION_LEN && d[..8] == POSITION_DISC, E::InvalidPositionAccount)?;
    Ok(PositionState {
        size_usd: u128_at(d, POSITION_SIZE_IN_USD),
        collateral: u64::try_from(u128_at(d, POSITION_COLLATERAL_AMOUNT)).map_err(|_| E::MathOverflow)?,
    })
}

/// State of a position account whose address the caller already verified. A closed account reads as flat.
pub fn position_state(v: &AccountView, gm_program: &Address) -> Result<PositionState> {
    if is_absent(v) {
        return Ok(PositionState::default());
    }
    require(v.owned_by(gm_program), E::InvalidPositionAccount)?;
    read_position_state(data(v))
}

/// Checks that a freshly prepared position account belongs to `owner` in `market_token` / `collateral` / side.
pub fn check_position_identity(
    v: &AccountView,
    gm_program: &Address,
    store: &Address,
    owner: &Address,
    market_token: &Address,
    collateral: &Address,
    is_long: bool,
) -> Result {
    require(v.owned_by(gm_program), E::InvalidPositionAccount)?;
    let d = data(v);
    read_position_state(d)?;
    require(
        address_at(d, POSITION_STORE) == store
            && address_at(d, POSITION_OWNER) == owner
            && address_at(d, POSITION_MARKET_TOKEN) == market_token
            && address_at(d, POSITION_COLLATERAL_TOKEN) == collateral
            && d[POSITION_KIND] == position_kind(is_long),
        E::InvalidPositionAccount,
    )
}

/// Size of a position of `owner`, with the account address verified against its PDA seeds. An absent account is
/// refused: without data its seeds cannot be checked, so it proves nothing.
pub fn verified_position_size(v: &AccountView, gm_program: &Address, store: &Address, owner: &Address) -> Result<u128> {
    require(v.owned_by(gm_program), E::InvalidPositionAccount)?;
    let d = data(v);
    let state = read_position_state(d)?;
    let expected = create_program_address(
        &[
            POSITION_SEED,
            store.as_ref(),
            owner.as_ref(),
            &d[POSITION_MARKET_TOKEN..POSITION_MARKET_TOKEN + 32],
            &d[POSITION_COLLATERAL_TOKEN..POSITION_COLLATERAL_TOKEN + 32],
            &[d[POSITION_KIND]],
            &[d[POSITION_BUMP]],
        ],
        gm_program,
    )
    .ok_or(E::InvalidPositionAccount)?;
    require(&expected == v.address(), E::InvalidPositionAccount)?;
    Ok(state.size_usd)
}

/// True while GMTrade still holds the order as pending. A closed order account (no longer owned by GMTrade) is not
/// pending; a GMTrade-owned account that is not an Order is refused rather than guessed.
pub fn is_pending_order(v: &AccountView, gm_program: &Address) -> Result<bool> {
    if !v.owned_by(gm_program) {
        return Ok(false);
    }
    let d = data(v);
    require(d.len() > ORDER_ACTION_STATE && d[..8] == ORDER_DISC, E::InvalidOrderAccount)?;
    Ok(d[ORDER_ACTION_STATE] == ACTION_STATE_PENDING)
}

/// True when GMTrade holds the order as cancelled (it never executed). A closed order account (no longer owned by
/// GMTrade) is not known to be cancelled; a GMTrade-owned account that is not an Order is refused.
pub fn is_cancelled_order(v: &AccountView, gm_program: &Address) -> Result<bool> {
    if !v.owned_by(gm_program) {
        return Ok(false);
    }
    let d = data(v);
    require(d.len() > ORDER_ACTION_STATE && d[..8] == ORDER_DISC, E::InvalidOrderAccount)?;
    Ok(d[ORDER_ACTION_STATE] == ACTION_STATE_CANCELLED)
}

/// Checks that `v` is a GMTrade Market of `store` for `market_token` with USDC as both pool tokens.
pub fn check_pure_usdc_market(
    v: &AccountView,
    gm_program: &Address,
    store: &Address,
    market_token: &Address,
    usdc: &Address,
) -> Result {
    require(v.owned_by(gm_program), E::MarketNotPure)?;
    let d = data(v);
    require(
        d.len() >= MARKET_MIN_LEN
            && d[..8] == MARKET_DISC
            && address_at(d, MARKET_STORE) == store
            && address_at(d, MARKET_TOKEN) == market_token
            && address_at(d, MARKET_LONG_TOKEN) == usdc
            && address_at(d, MARKET_SHORT_TOKEN) == usdc,
        E::MarketNotPure,
    )
}

// ---------- CPIs ----------

/// gmsol-store instruction discriminators (sha256("global:<name>")[..8]).
pub mod ix {
    pub const PREPARE_USER: [u8; 8] = [190, 173, 143, 193, 139, 80, 231, 133];
    pub const PREPARE_POSITION: [u8; 8] = [178, 215, 55, 90, 137, 15, 108, 15];
    pub const CREATE_ORDER_V2: [u8; 8] = [200, 157, 3, 182, 3, 164, 162, 240];
    pub const CLOSE_ORDER_V2: [u8; 8] = [213, 217, 98, 100, 225, 205, 76, 184];
    pub const UPDATE_ORDER_V2: [u8; 8] = [195, 175, 207, 33, 171, 246, 41, 176];
    pub const CLOSE_EMPTY_POSITION: [u8; 8] = [175, 105, 138, 38, 237, 235, 250, 59];
}

/// Lamports one order takes from its owner: the escrow ATA and the Order account's rent, and the keeper's execution fee.
/// It is also what GMTrade reserves in a new Position for a liquidation order (`Order::position_cut_rent`, pure market).
fn order_cost(rent: &Rent) -> u64 {
    rent.minimum_balance(TOKEN_ACCOUNT_LEN) + rent.minimum_balance(ORDER_LEN) + EXECUTION_LAMPORTS
}

/// The owner PDA after a GMTrade CPI it signed writable: still data-less and system-owned (a GMTrade that took it over
/// would strand everything it controls) and at most `spend` lamports poorer.
fn check_owner(owner: &AccountView, before: u64, spend: u64) -> Result {
    require(
        owner.owned_by(&SYSTEM_PROGRAM_ID) && owner.is_data_empty() && owner.lamports() >= before.saturating_sub(spend),
        E::UnexpectedGmtradeEffect,
    )
}

/// The owner's USDC account after a GMTrade CPI that got it: still a USDC account of `owner`, with no delegate and no
/// close authority, holding between `min` and `max`.
fn check_usdc(v: &AccountView, owner: &Address, min: u64, max: u64) -> Result {
    let ok = match token_account(v) {
        Ok(t) => {
            t.owner == *owner
                && t.delegate_tag == NONE
                && t.close_authority_tag == NONE
                && t.amount.get() >= min
                && t.amount.get() <= max
        }
        Err(_) => false,
    };
    require(ok, E::UnexpectedGmtradeEffect)
}

/// `OrderKind` variant indexes.
pub mod order_kind {
    pub const MARKET_INCREASE: u8 = 3;
    pub const MARKET_DECREASE: u8 = 4;
    pub const LIMIT_INCREASE: u8 = 6;
    pub const LIMIT_DECREASE: u8 = 7;
    pub const STOP_LOSS_DECREASE: u8 = 8;
}
/// `DecreasePositionSwapType::NoSwap`.
pub const NO_SWAP: u8 = 0;

/// `CreateOrderParams` (borsh, IDL field order).
#[derive(Clone, Copy)]
pub struct OrderParams {
    pub kind: u8,
    pub decrease_position_swap_type: Option<u8>,
    pub execution_lamports: u64,
    pub swap_path_length: u8,
    pub initial_collateral_delta_amount: u64,
    pub size_delta_value: u128,
    pub is_long: bool,
    pub is_collateral_long: bool,
    pub min_output: Option<u128>,
    pub trigger_price: Option<u128>,
    pub acceptable_price: Option<u128>,
    pub should_unwrap_native_token: bool,
    pub valid_from_ts: Option<i64>,
}

impl OrderParams {
    fn write<const N: usize>(&self, b: &mut Buf<N>) {
        b.u8(self.kind);
        match self.decrease_position_swap_type {
            Some(t) => b.u8(1).u8(t),
            None => b.u8(0),
        };
        b.u64(self.execution_lamports)
            .u8(self.swap_path_length)
            .u64(self.initial_collateral_delta_amount)
            .u128(self.size_delta_value)
            .bool(self.is_long)
            .bool(self.is_collateral_long)
            .option_u128(self.min_output)
            .option_u128(self.trigger_price)
            .option_u128(self.acceptable_price)
            .bool(self.should_unwrap_native_token)
            .option_i64(self.valid_from_ts);
    }
}

fn gm_kind(t: u8) -> u8 {
    match t {
        order_type::MARKET => order_kind::MARKET_INCREASE,
        order_type::LIMIT => order_kind::LIMIT_INCREASE,
        order_type::CLOSE => order_kind::MARKET_DECREASE,
        order_type::TAKE_PROFIT => order_kind::LIMIT_DECREASE,
        _ => order_kind::STOP_LOSS_DECREASE,
    }
}

/// Order parameters we allow: USDC collateral and output, no swaps, no unwrapping, no delayed start.
pub fn order_params(
    order_type: u8,
    is_long: bool,
    collateral: u64,
    size_delta_usd: u128,
    trigger_price: Option<u128>,
    acceptable_price: Option<u128>,
) -> OrderParams {
    OrderParams {
        kind: gm_kind(order_type),
        decrease_position_swap_type: (!order_type::is_increase(order_type)).then_some(NO_SWAP),
        execution_lamports: EXECUTION_LAMPORTS,
        swap_path_length: 0,
        initial_collateral_delta_amount: collateral,
        size_delta_value: size_delta_usd,
        is_long,
        // Pure USDC-USDC markets: the collateral token is both the long and the short token.
        is_collateral_long: true,
        min_output: None,
        trigger_price,
        acceptable_price,
        should_unwrap_native_token: false,
        valid_from_ts: None,
    }
}

/// Accounts for creating a GMTrade order on a pure USDC-USDC market as the owner PDA (Anchor `CreateOrderCpi`).
pub struct CreateOrder<'a> {
    pub owner: &'a AccountView,
    pub store: &'a AccountView,
    pub market: &'a AccountView,
    pub user: &'a AccountView,
    pub position: &'a AccountView,
    pub order: &'a AccountView,
    pub usdc_mint: &'a AccountView,
    /// ATA(order, USDC): the only escrow a pure market needs.
    pub escrow: &'a AccountView,
    pub event_authority: &'a AccountView,
    pub program: &'a AccountView,
    pub token_program: &'a AccountView,
    pub associated_token_program: &'a AccountView,
    pub system_program: &'a AccountView,
}

impl CreateOrder<'_> {
    /// Creates the escrow ATA idempotently (payer = owner), then for increases (`source` = the owner's USDC account)
    /// `prepare_user` + `prepare_position`, then `create_order_v2`. Receiver is always the owner PDA.
    pub fn invoke(&self, signer: Seeds, nonce: [u8; 32], params: &OrderParams, source: Option<&AccountView>) -> Result {
        program_account(self.program, &GMTRADE_PROGRAM_ID)?;
        let program = self.program.address();
        let lamports = self.owner.lamports();
        let usdc = match source {
            Some(s) => token_account(s)?.amount.get(),
            None => 0,
        };
        create_ata(
            self.owner,
            self.escrow,
            self.order,
            self.usdc_mint,
            self.system_program,
            self.token_program,
            true,
            signer,
        )?;

        let is_increase = source.is_some();
        if is_increase {
            invoke(
                program,
                &[ws(self.owner), r(self.store), w(self.user), r(self.system_program)],
                &ix::PREPARE_USER,
                signer,
            )?;
            let mut d = Buf::<112>::default();
            d.bytes(&ix::PREPARE_POSITION);
            params.write(&mut d);
            invoke(
                program,
                &[ws(self.owner), r(self.store), r(self.market), w(self.position), r(self.system_program)],
                d.as_slice(),
                signer,
            )?;
        }

        let none = r(self.program);
        let escrow = w(self.escrow);
        let mut d = Buf::<152>::default();
        d.bytes(&ix::CREATE_ORDER_V2).bytes(&nonce);
        params.write(&mut d);
        d.u8(0); // callback_version: None
        let metas: [Meta; 25] = [
            ws(self.owner),
            r(self.owner), // receiver
            r(self.store),
            w(self.market),
            w(self.user),
            w(self.order),
            w(self.position),
            if is_increase { r(self.usdc_mint) } else { none }, // initial_collateral_token
            r(self.usdc_mint),                                  // final_output_token (v0.11 wants the collateral mint)
            r(self.usdc_mint),                                  // long_token
            r(self.usdc_mint),                                  // short_token
            if is_increase { escrow } else { none },            // initial_collateral_token_escrow
            if is_increase { none } else { escrow },            // final_output_token_escrow
            escrow,                                             // long_token_escrow
            escrow,                                             // short_token_escrow
            match source {
                Some(s) => w(s),
                None => none,
            }, // initial_collateral_token_source
            r(self.system_program),
            r(self.token_program),
            r(self.associated_token_program),
            none, // callback_authority
            none, // callback_program
            none, // callback_shared_data_account
            none, // callback_partitioned_data_account
            r(self.event_authority),
            r(self.program),
        ];
        invoke(program, &metas, d.as_slice(), signer)?;

        // An increase may also pay for the user account, the position and its liquidation reserve, and moves exactly the
        // collateral out of the source.
        let rent = Rent::get()?;
        let mut spend = order_cost(&rent);
        if let Some(s) = source {
            spend += order_cost(&rent) + rent.minimum_balance(USER_LEN) + rent.minimum_balance(POSITION_LEN);
            let left = usdc.saturating_sub(params.initial_collateral_delta_amount);
            check_usdc(s, self.owner.address(), left, left)?;
        }
        check_owner(self.owner, lamports, spend)
    }
}

/// Accounts for an owner-executed `close_order_v2`: funds and rent go back to the owner PDA only.
pub struct CloseOrder<'a> {
    pub owner: &'a AccountView,
    pub owner_usdc: &'a AccountView,
    pub store: &'a AccountView,
    pub store_wallet: &'a AccountView,
    pub user: &'a AccountView,
    pub order: &'a AccountView,
    pub usdc_mint: &'a AccountView,
    pub escrow: &'a AccountView,
    pub event_authority: &'a AccountView,
    pub program: &'a AccountView,
    pub token_program: &'a AccountView,
    pub associated_token_program: &'a AccountView,
    pub system_program: &'a AccountView,
}

impl CloseOrder<'_> {
    /// GMTrade requires exactly the escrows the order recorded: initial collateral for increases, final output for
    /// decreases. `reason` is GMTrade's free-text close reason ("cancel", "completed").
    pub fn invoke(&self, signer: Seeds, reason: &str) -> Result {
        program_account(self.program, &GMTRADE_PROGRAM_ID)?;
        require(self.order.owned_by(self.program.address()), E::InvalidOrderAccount)?;
        let d = data(self.order);
        require(d.len() == ORDER_LEN && d[..8] == ORDER_DISC, E::InvalidOrderAccount)?;
        let has_initial = *address_at(d, ORDER_INITIAL_COLLATERAL_ESCROW) != Address::default();
        let has_final = *address_at(d, ORDER_FINAL_OUTPUT_ESCROW) != Address::default();

        let lamports = self.owner.lamports();
        let usdc = token_account(self.owner_usdc)?.amount.get();

        let none = r(self.program);
        let some = |m, yes| if yes { m } else { none };
        let mut data = Buf::<64>::default();
        data.bytes(&ix::CLOSE_ORDER_V2).u32(reason.len() as u32).bytes(reason.as_bytes());
        let metas: [Meta; 30] = [
            (self.owner, false, true), // executor
            w(self.store),
            w(self.store_wallet),
            w(self.owner),
            w(self.owner), // receiver
            w(self.owner), // rent_receiver
            w(self.user),
            none, // referrer_user
            w(self.order),
            some(r(self.usdc_mint), has_initial),  // initial_collateral_token
            r(self.usdc_mint),                     // final_output_token
            r(self.usdc_mint),                     // long_token
            r(self.usdc_mint),                     // short_token
            some(w(self.escrow), has_initial),     // initial_collateral_token_escrow
            some(w(self.escrow), has_final),       // final_output_token_escrow
            w(self.escrow),                        // long_token_escrow
            w(self.escrow),                        // short_token_escrow
            some(w(self.owner_usdc), has_initial), // initial_collateral_token_ata
            some(w(self.owner_usdc), has_final),   // final_output_token_ata
            w(self.owner_usdc),                    // long_token_ata
            w(self.owner_usdc),                    // short_token_ata
            r(self.system_program),
            r(self.token_program),
            r(self.associated_token_program),
            none, // callback_authority
            none, // callback_program
            none, // callback_shared_data_account
            none, // callback_partitioned_data_account
            r(self.event_authority),
            r(self.program),
        ];
        invoke(self.program.address(), &metas, data.as_slice(), signer)?;
        // Closing only ever pays the owner: escrowed funds to its USDC account, rent to the PDA.
        check_usdc(self.owner_usdc, self.owner.address(), usdc, u64::MAX)?;
        check_owner(self.owner, lamports, 0)
    }
}

/// `close_empty_position` as the owner PDA: GMTrade closes an empty Position of the owner (it refuses one that is not
/// empty) and sends its lamports, rent and liquidation reserve, to the owner.
pub fn close_empty_position(
    program: &AccountView,
    owner: &AccountView,
    store: &AccountView,
    position: &AccountView,
    signer: Seeds,
) -> Result {
    program_account(program, &GMTRADE_PROGRAM_ID)?;
    let lamports = owner.lamports();
    invoke(program.address(), &[ws(owner), r(store), w(position)], &ix::CLOSE_EMPTY_POSITION, signer)?;
    check_owner(owner, lamports, 0)
}

/// `update_order_v2` as the owner PDA (`UpdateOrderParams` with `min_output` and `valid_from_ts` None).
#[allow(clippy::too_many_arguments)]
pub fn update_order(
    program: &AccountView,
    owner: &AccountView,
    store: &AccountView,
    market: &AccountView,
    order: &AccountView,
    event_authority: &AccountView,
    signer: Seeds,
    size_delta_value: Option<u128>,
    acceptable_price: Option<u128>,
    trigger_price: Option<u128>,
) -> Result {
    program_account(program, &GMTRADE_PROGRAM_ID)?;
    let none = r(program);
    let mut d = Buf::<64>::default();
    d.bytes(&ix::UPDATE_ORDER_V2)
        .option_u128(size_delta_value)
        .option_u128(acceptable_price)
        .option_u128(trigger_price)
        .option_u128(None)
        .option_i64(None);
    let metas: [Meta; 10] =
        [(owner, false, true), r(store), w(market), w(order), none, none, none, none, r(event_authority), r(program)];
    invoke(program.address(), &metas, d.as_slice(), signer)
}

#[cfg(test)]
mod tests {
    //! The CPI helpers sign as the owner PDA for their `program` account, so they must refuse anything but GMTrade
    //! themselves. Off-chain `invoke` is a no-op: a helper that reaches it returns Ok.
    use super::*;
    use crate::accounts::{BPF_LOADER_UPGRADEABLE_ID, TOKEN_PROGRAM_ID};
    use pinocchio::account::{RuntimeAccount, NOT_BORROWED};

    /// An account laid out as the runtime serializes it (header, then data); the Vec owns the memory.
    fn account(address: Address, owner: Address, executable: bool, data: &[u8]) -> (Vec<u64>, AccountView) {
        let header = core::mem::size_of::<RuntimeAccount>();
        let mut mem = vec![0u64; (header + data.len()).div_ceil(8)];
        let raw = mem.as_mut_ptr() as *mut RuntimeAccount;
        let head = RuntimeAccount {
            borrow_state: NOT_BORROWED,
            executable: executable as u8,
            address,
            owner,
            data_len: data.len() as u64,
            ..RuntimeAccount::default()
        };
        // SAFETY: `mem` is 8-aligned and holds the header followed by `data.len()` bytes.
        unsafe {
            raw.write(head);
            core::ptr::copy_nonoverlapping(data.as_ptr(), (raw as *mut u8).add(header), data.len());
            (mem, AccountView::new_unchecked(raw))
        }
    }

    const SIGNER: Seeds = &[&[b"owner", &[255]]];

    fn create(program: &AccountView, order: &AccountView, any: &AccountView, usdc: &AccountView) -> Result {
        let params = order_params(order_type::MARKET, true, 1, 1, None, Some(1));
        CreateOrder {
            owner: any,
            store: any,
            market: any,
            user: any,
            position: any,
            order,
            usdc_mint: any,
            escrow: any,
            event_authority: any,
            program,
            token_program: any,
            associated_token_program: any,
            system_program: any,
        }
        .invoke(SIGNER, [0; 32], &params, Some(usdc))
    }

    fn close(program: &AccountView, order: &AccountView, any: &AccountView, usdc: &AccountView) -> Result {
        CloseOrder {
            owner: any,
            owner_usdc: usdc,
            store: any,
            store_wallet: any,
            user: any,
            order,
            usdc_mint: any,
            escrow: any,
            event_authority: any,
            program,
            token_program: any,
            associated_token_program: any,
            system_program: any,
        }
        .invoke(SIGNER, "cancel")
    }

    fn update(program: &AccountView, order: &AccountView, any: &AccountView) -> Result {
        update_order(program, any, any, any, order, any, SIGNER, None, None, Some(1))
    }

    #[test]
    fn cpis_refuse_a_program_that_is_not_gmtrade() {
        let (_a, other) = account(TOKEN_PROGRAM_ID, BPF_LOADER_UPGRADEABLE_ID, true, &[]);
        let (_b, gmtrade) = account(GMTRADE_PROGRAM_ID, BPF_LOADER_UPGRADEABLE_ID, true, &[]);
        let (_c, any) = account(Address::default(), Address::default(), false, &[]);
        // An Order image owned by the substitute (so CloseOrder's own order checks pass for it) and one owned by GMTrade.
        let mut image = vec![0u8; ORDER_LEN];
        image[..8].copy_from_slice(&ORDER_DISC);
        let (_d, foreign_order) = account(Address::new_from_array([7; 32]), TOKEN_PROGRAM_ID, false, &image);
        let (_e, order) = account(Address::new_from_array([7; 32]), GMTRADE_PROGRAM_ID, false, &image);
        // The owner's USDC account (owner = `any`), which the helpers read before and after their CPI.
        let mut usdc_image = vec![0u8; TOKEN_ACCOUNT_LEN];
        usdc_image[108] = 1; // initialized
        let (_f, usdc) = account(Address::new_from_array([8; 32]), TOKEN_PROGRAM_ID, false, &usdc_image);

        let refused: Result = Err(E::InvalidProgramId.into());
        assert_eq!(create(&other, &foreign_order, &any, &usdc), refused);
        assert_eq!(close(&other, &foreign_order, &any, &usdc), refused);
        assert_eq!(update(&other, &foreign_order, &any), refused);
        assert_eq!(close_empty_position(&other, &any, &any, &order, SIGNER), refused);
        assert_eq!(create(&gmtrade, &order, &any, &usdc), Ok(()));
        assert_eq!(close(&gmtrade, &order, &any, &usdc), Ok(()));
        assert_eq!(update(&gmtrade, &order, &any), Ok(()));
        assert_eq!(close_empty_position(&gmtrade, &any, &any, &order, SIGNER), Ok(()));
    }

    /// A USDC token account image: owner field `owner`, `amount`, and the delegate / close authority tags given.
    fn usdc_image(owner: &Address, amount: u64, delegate: bool, close_authority: bool) -> Vec<u8> {
        let mut d = vec![0u8; TOKEN_ACCOUNT_LEN];
        d[32..64].copy_from_slice(owner.as_ref());
        d[64..72].copy_from_slice(&amount.to_le_bytes());
        d[72] = delegate as u8;
        d[108] = 1; // initialized
        d[129] = close_authority as u8;
        d
    }

    #[test]
    fn post_cpi_bounds_refuse_what_the_call_did_not_ask_for() {
        let bad: Result = Err(E::UnexpectedGmtradeEffect.into());
        let pda = Address::new_from_array([9; 32]);

        // The owner PDA: system-owned, no data, at most `spend` lamports poorer.
        let (_a, mut owner) = account(pda, SYSTEM_PROGRAM_ID, false, &[]);
        owner.set_lamports(1_000);
        assert_eq!(check_owner(&owner, 1_000, 0), Ok(()));
        assert_eq!(check_owner(&owner, 1_300, 300), Ok(()));
        assert_eq!(check_owner(&owner, 1_301, 300), bad);
        let (_b, taken) = account(pda, GMTRADE_PROGRAM_ID, false, &[]);
        assert_eq!(check_owner(&taken, 0, u64::MAX), bad);
        let (_c, with_data) = account(pda, SYSTEM_PROGRAM_ID, false, &[0]);
        assert_eq!(check_owner(&with_data, 0, u64::MAX), bad);

        // The owner's USDC account: the owner's, no delegate, no close authority, balance within bounds.
        let usdc = |image: &[u8]| account(Address::new_from_array([8; 32]), TOKEN_PROGRAM_ID, false, image);
        let (_d, fine) = usdc(&usdc_image(&pda, 400, false, false));
        assert_eq!(check_usdc(&fine, &pda, 400, 400), Ok(()));
        assert_eq!(check_usdc(&fine, &pda, 300, u64::MAX), Ok(()));
        assert_eq!(check_usdc(&fine, &pda, 401, u64::MAX), bad);
        assert_eq!(check_usdc(&fine, &pda, 0, 399), bad);
        assert_eq!(check_usdc(&fine, &Address::new_from_array([1; 32]), 400, 400), bad);
        let (_e, delegated) = usdc(&usdc_image(&pda, 400, true, false));
        assert_eq!(check_usdc(&delegated, &pda, 400, 400), bad);
        let (_f, closable) = usdc(&usdc_image(&pda, 400, false, true));
        assert_eq!(check_usdc(&closable, &pda, 400, 400), bad);
        let (_g, closed) = account(Address::new_from_array([8; 32]), SYSTEM_PROGRAM_ID, false, &[]);
        assert_eq!(check_usdc(&closed, &pda, 0, u64::MAX), bad);
    }
}
