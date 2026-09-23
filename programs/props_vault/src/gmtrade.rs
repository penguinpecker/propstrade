//! GMTrade (gmsol-store v0.10.0) integration: account layouts read by fixed offsets and the CPIs we make.
//! Never call `gmsol_programs::gmsol_store::utils::Account::try_from` onchain (23 KB stack frame).
use anchor_lang::{prelude::*, Discriminator};
use anchor_spl::associated_token;
use gmsol_programs::gmsol_store::{
    accounts::{Market, Order, Position},
    cpi::{
        self,
        accounts::{CloseOrderV2, CreateOrderV2, PreparePosition, PrepareUser, UpdateOrderV2},
    },
    types::{CreateOrderParams, DecreasePositionSwapType, OrderKind, UpdateOrderParams},
};

use crate::{errors::VaultError, state::OrderType};

/// gmsol-store `Order::MIN_EXECUTION_LAMPORTS` (states/order.rs:343): the execution fee we offer keepers.
pub const EXECUTION_LAMPORTS: u64 = 300_000;
/// Smallest decrease we place, GMTrade USD: $1, GMTrade's `min_position_size_usd` on the listed markets.
/// Anything smaller changes nothing but still costs the owner PDA a keeper execution fee.
pub const MIN_DECREASE_USD: u128 = 100_000_000_000_000_000_000;
pub const POSITION_SEED: &[u8] = b"position";
/// `PositionKind` representation: 1 = long, 2 = short.
pub fn position_kind(is_long: bool) -> u8 {
    if is_long {
        1
    } else {
        2
    }
}

/// Byte offsets (including the 8-byte discriminator) of gmsol-store v0.10.0 zero-copy accounts, derived
/// from the crate IDL (`idls/gmsol_store.json`) and checked against mainnet accounts in the tests.
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
    pub const ORDER_ACTION_STATE: usize = 9;
    pub const ORDER_INITIAL_COLLATERAL_ESCROW: usize = 592;
    pub const ORDER_FINAL_OUTPUT_ESCROW: usize = 656;
    /// `ActionState::Pending`.
    pub const ACTION_STATE_PENDING: u8 = 0;

    pub const MARKET_MIN_LEN: usize = 248;
    pub const MARKET_TOKEN: usize = 88;
    pub const MARKET_LONG_TOKEN: usize = 152;
    pub const MARKET_SHORT_TOKEN: usize = 184;
    pub const MARKET_STORE: usize = 216;
}
use layout::*;

fn pubkey_at(data: &[u8], offset: usize) -> Pubkey {
    Pubkey::new_from_array(data[offset..offset + 32].try_into().expect("32 bytes"))
}

fn u128_at(data: &[u8], offset: usize) -> u128 {
    u128::from_le_bytes(data[offset..offset + 16].try_into().expect("16 bytes"))
}

fn is_absent(ai: &AccountInfo) -> bool {
    ai.owner == &System::id() && ai.data_is_empty()
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct PositionState {
    pub size_usd: u128,
    /// USDC base units.
    pub collateral: u64,
}

pub fn read_position_state(data: &[u8]) -> Result<PositionState> {
    require!(
        data.len() == POSITION_LEN && data[..8] == *Position::DISCRIMINATOR,
        VaultError::InvalidPositionAccount
    );
    Ok(PositionState {
        size_usd: u128_at(data, POSITION_SIZE_IN_USD),
        collateral: u64::try_from(u128_at(data, POSITION_COLLATERAL_AMOUNT)).map_err(|_| error!(VaultError::MathOverflow))?,
    })
}

/// State of a position account whose address the caller already verified. A closed account reads as flat.
pub fn position_state(ai: &AccountInfo, gm_program: &Pubkey) -> Result<PositionState> {
    if is_absent(ai) {
        return Ok(PositionState::default());
    }
    require_keys_eq!(*ai.owner, *gm_program, VaultError::InvalidPositionAccount);
    read_position_state(&ai.try_borrow_data()?)
}

/// Checks that a freshly prepared position account belongs to `owner` in `market_token` / `collateral` / side.
pub fn check_position_identity(
    ai: &AccountInfo,
    gm_program: &Pubkey,
    store: &Pubkey,
    owner: &Pubkey,
    market_token: &Pubkey,
    collateral: &Pubkey,
    is_long: bool,
) -> Result<()> {
    require_keys_eq!(*ai.owner, *gm_program, VaultError::InvalidPositionAccount);
    let data = ai.try_borrow_data()?;
    read_position_state(&data)?;
    require!(
        pubkey_at(&data, POSITION_STORE) == *store
            && pubkey_at(&data, POSITION_OWNER) == *owner
            && pubkey_at(&data, POSITION_MARKET_TOKEN) == *market_token
            && pubkey_at(&data, POSITION_COLLATERAL_TOKEN) == *collateral
            && data[POSITION_KIND] == position_kind(is_long),
        VaultError::InvalidPositionAccount
    );
    Ok(())
}

/// Returns the size of a position of `owner`, verifying the account address against its PDA seeds.
/// An absent account is refused: without data its seeds cannot be checked, so it proves nothing.
pub fn verified_position_size(ai: &AccountInfo, gm_program: &Pubkey, store: &Pubkey, owner: &Pubkey) -> Result<u128> {
    require_keys_eq!(*ai.owner, *gm_program, VaultError::InvalidPositionAccount);
    let data = ai.try_borrow_data()?;
    let state = read_position_state(&data)?;
    let expected = Pubkey::create_program_address(
        &[
            POSITION_SEED,
            store.as_ref(),
            owner.as_ref(),
            &data[POSITION_MARKET_TOKEN..POSITION_MARKET_TOKEN + 32],
            &data[POSITION_COLLATERAL_TOKEN..POSITION_COLLATERAL_TOKEN + 32],
            &[data[POSITION_KIND]],
            &[data[POSITION_BUMP]],
        ],
        gm_program,
    )
    .map_err(|_| error!(VaultError::InvalidPositionAccount))?;
    require_keys_eq!(expected, ai.key(), VaultError::InvalidPositionAccount);
    Ok(state.size_usd)
}

/// True while GMTrade still holds the order as pending. A closed order account (no longer owned by
/// GMTrade) is not pending; a GMTrade-owned account that is not an Order is refused rather than guessed.
pub fn is_pending_order(ai: &AccountInfo, gm_program: &Pubkey) -> Result<bool> {
    if ai.owner != gm_program {
        return Ok(false);
    }
    let data = ai.try_borrow_data()?;
    require!(
        data.len() > ORDER_ACTION_STATE && data[..8] == *Order::DISCRIMINATOR,
        VaultError::InvalidOrderAccount
    );
    Ok(data[ORDER_ACTION_STATE] == ACTION_STATE_PENDING)
}

/// Checks that `ai` is a GMTrade Market of `store` for `market_token` with USDC as both pool tokens.
pub fn check_pure_usdc_market(ai: &AccountInfo, gm_program: &Pubkey, store: &Pubkey, market_token: &Pubkey, usdc: &Pubkey) -> Result<()> {
    require_keys_eq!(*ai.owner, *gm_program, VaultError::MarketNotPure);
    let data = ai.try_borrow_data()?;
    require!(
        data.len() >= MARKET_MIN_LEN
            && data[..8] == *Market::DISCRIMINATOR
            && pubkey_at(&data, MARKET_STORE) == *store
            && pubkey_at(&data, MARKET_TOKEN) == *market_token
            && pubkey_at(&data, MARKET_LONG_TOKEN) == *usdc
            && pubkey_at(&data, MARKET_SHORT_TOKEN) == *usdc,
        VaultError::MarketNotPure
    );
    Ok(())
}

fn gm_kind(order_type: OrderType) -> OrderKind {
    match order_type {
        OrderType::Market => OrderKind::MarketIncrease,
        OrderType::Limit => OrderKind::LimitIncrease,
        OrderType::Close => OrderKind::MarketDecrease,
        OrderType::TakeProfit => OrderKind::LimitDecrease,
        OrderType::StopLoss => OrderKind::StopLossDecrease,
    }
}

/// Order parameters we allow: USDC collateral and output, no swaps, no unwrapping, no delayed start.
pub fn order_params(
    order_type: OrderType,
    is_long: bool,
    collateral: u64,
    size_delta_usd: u128,
    trigger_price: Option<u128>,
    acceptable_price: Option<u128>,
) -> CreateOrderParams {
    CreateOrderParams {
        kind: gm_kind(order_type),
        decrease_position_swap_type: (!order_type.is_increase()).then_some(DecreasePositionSwapType::NoSwap),
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

/// Builds a [`CreateOrderCpi`] from an accounts struct that uses the standard field names.
macro_rules! create_order_cpi {
    ($a:expr) => {
        $crate::gmtrade::CreateOrderCpi {
            owner: $a.owner.to_account_info(),
            store: $a.gm_store.to_account_info(),
            market: $a.gm_market.to_account_info(),
            user: $a.gm_user.to_account_info(),
            position: $a.gm_position.to_account_info(),
            order: $a.gm_order.to_account_info(),
            usdc_mint: $a.usdc_mint.to_account_info(),
            escrow: $a.order_escrow.to_account_info(),
            event_authority: $a.gm_event_authority.to_account_info(),
            program: $a.gmtrade_program.to_account_info(),
            token_program: $a.token_program.to_account_info(),
            associated_token_program: $a.associated_token_program.to_account_info(),
            system_program: $a.system_program.to_account_info(),
        }
    };
}
pub(crate) use create_order_cpi;

/// Builds a [`CloseOrderCpi`] from an accounts struct that uses the standard field names.
macro_rules! close_order_cpi {
    ($a:expr) => {
        $crate::gmtrade::CloseOrderCpi {
            owner: $a.owner.to_account_info(),
            owner_usdc: $a.owner_usdc.to_account_info(),
            store: $a.gm_store.to_account_info(),
            store_wallet: $a.gm_store_wallet.to_account_info(),
            user: $a.gm_user.to_account_info(),
            order: $a.gm_order.to_account_info(),
            usdc_mint: $a.usdc_mint.to_account_info(),
            escrow: $a.order_escrow.to_account_info(),
            event_authority: $a.gm_event_authority.to_account_info(),
            program: $a.gmtrade_program.to_account_info(),
            token_program: $a.token_program.to_account_info(),
            associated_token_program: $a.associated_token_program.to_account_info(),
            system_program: $a.system_program.to_account_info(),
        }
    };
}
pub(crate) use close_order_cpi;

/// Accounts for creating a GMTrade order on a pure USDC-USDC market as the owner PDA.
pub struct CreateOrderCpi<'info> {
    pub owner: AccountInfo<'info>,
    pub store: AccountInfo<'info>,
    pub market: AccountInfo<'info>,
    pub user: AccountInfo<'info>,
    pub position: AccountInfo<'info>,
    pub order: AccountInfo<'info>,
    pub usdc_mint: AccountInfo<'info>,
    /// ATA(order, USDC): the only escrow a pure market needs.
    pub escrow: AccountInfo<'info>,
    pub event_authority: AccountInfo<'info>,
    pub program: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub associated_token_program: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
}

impl<'info> CreateOrderCpi<'info> {
    /// Creates the order. For increases, `source` is the owner's USDC account and the user and position
    /// accounts are prepared first. Receiver is always the owner PDA.
    pub fn invoke(&self, signer: &[&[&[u8]]], nonce: [u8; 32], params: CreateOrderParams, source: Option<AccountInfo<'info>>) -> Result<()> {
        associated_token::create_idempotent(CpiContext::new_with_signer(
            self.associated_token_program.clone(),
            associated_token::Create {
                payer: self.owner.clone(),
                associated_token: self.escrow.clone(),
                authority: self.order.clone(),
                mint: self.usdc_mint.clone(),
                system_program: self.system_program.clone(),
                token_program: self.token_program.clone(),
            },
            signer,
        ))?;

        let is_increase = source.is_some();
        if is_increase {
            cpi::prepare_user(CpiContext::new_with_signer(
                self.program.clone(),
                PrepareUser {
                    owner: self.owner.clone(),
                    store: self.store.clone(),
                    user: self.user.clone(),
                    system_program: self.system_program.clone(),
                },
                signer,
            ))?;
            cpi::prepare_position(
                CpiContext::new_with_signer(
                    self.program.clone(),
                    PreparePosition {
                        owner: self.owner.clone(),
                        store: self.store.clone(),
                        market: self.market.clone(),
                        position: self.position.clone(),
                        system_program: self.system_program.clone(),
                    },
                    signer,
                ),
                params,
            )?;
        }

        let escrow = Some(self.escrow.clone());
        cpi::create_order_v2(
            CpiContext::new_with_signer(
                self.program.clone(),
                CreateOrderV2 {
                    owner: self.owner.clone(),
                    receiver: self.owner.clone(),
                    store: self.store.clone(),
                    market: self.market.clone(),
                    user: self.user.clone(),
                    order: self.order.clone(),
                    position: Some(self.position.clone()),
                    initial_collateral_token: is_increase.then(|| self.usdc_mint.clone()),
                    // v0.11 requires final_output_token == collateral for increases; USDC is valid on v0.10 too.
                    final_output_token: self.usdc_mint.clone(),
                    long_token: Some(self.usdc_mint.clone()),
                    short_token: Some(self.usdc_mint.clone()),
                    initial_collateral_token_escrow: if is_increase { escrow.clone() } else { None },
                    final_output_token_escrow: if is_increase { None } else { escrow.clone() },
                    long_token_escrow: escrow.clone(),
                    short_token_escrow: escrow,
                    initial_collateral_token_source: source,
                    system_program: self.system_program.clone(),
                    token_program: self.token_program.clone(),
                    associated_token_program: self.associated_token_program.clone(),
                    callback_authority: None,
                    callback_program: None,
                    callback_shared_data_account: None,
                    callback_partitioned_data_account: None,
                    event_authority: self.event_authority.clone(),
                    program: self.program.clone(),
                },
                signer,
            ),
            nonce,
            params,
            None,
        )
    }
}

/// Accounts for an owner-executed `close_order_v2`: funds and rent go back to the owner PDA only.
pub struct CloseOrderCpi<'info> {
    pub owner: AccountInfo<'info>,
    pub owner_usdc: AccountInfo<'info>,
    pub store: AccountInfo<'info>,
    pub store_wallet: AccountInfo<'info>,
    pub user: AccountInfo<'info>,
    pub order: AccountInfo<'info>,
    pub usdc_mint: AccountInfo<'info>,
    pub escrow: AccountInfo<'info>,
    pub event_authority: AccountInfo<'info>,
    pub program: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub associated_token_program: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
}

impl<'info> CloseOrderCpi<'info> {
    pub fn invoke(&self, signer: &[&[&[u8]]], reason: &str) -> Result<()> {
        // GMTrade requires exactly the escrows the order recorded: initial collateral for increases,
        // final output for decreases.
        let (has_initial, has_final) = {
            require_keys_eq!(*self.order.owner, self.program.key(), VaultError::InvalidOrderAccount);
            let data = self.order.try_borrow_data()?;
            require!(data.len() == ORDER_LEN && data[..8] == *Order::DISCRIMINATOR, VaultError::InvalidOrderAccount);
            (
                pubkey_at(&data, ORDER_INITIAL_COLLATERAL_ESCROW) != Pubkey::default(),
                pubkey_at(&data, ORDER_FINAL_OUTPUT_ESCROW) != Pubkey::default(),
            )
        };
        let some = |ai: &AccountInfo<'info>, yes: bool| yes.then(|| ai.clone());
        cpi::close_order_v2(
            CpiContext::new_with_signer(
                self.program.clone(),
                CloseOrderV2 {
                    executor: self.owner.clone(),
                    store: self.store.clone(),
                    store_wallet: self.store_wallet.clone(),
                    owner: self.owner.clone(),
                    receiver: self.owner.clone(),
                    rent_receiver: self.owner.clone(),
                    user: self.user.clone(),
                    referrer_user: None,
                    order: self.order.clone(),
                    initial_collateral_token: some(&self.usdc_mint, has_initial),
                    final_output_token: Some(self.usdc_mint.clone()),
                    long_token: Some(self.usdc_mint.clone()),
                    short_token: Some(self.usdc_mint.clone()),
                    initial_collateral_token_escrow: some(&self.escrow, has_initial),
                    final_output_token_escrow: some(&self.escrow, has_final),
                    long_token_escrow: Some(self.escrow.clone()),
                    short_token_escrow: Some(self.escrow.clone()),
                    initial_collateral_token_ata: some(&self.owner_usdc, has_initial),
                    final_output_token_ata: some(&self.owner_usdc, has_final),
                    long_token_ata: Some(self.owner_usdc.clone()),
                    short_token_ata: Some(self.owner_usdc.clone()),
                    system_program: self.system_program.clone(),
                    token_program: self.token_program.clone(),
                    associated_token_program: self.associated_token_program.clone(),
                    callback_authority: None,
                    callback_program: None,
                    callback_shared_data_account: None,
                    callback_partitioned_data_account: None,
                    event_authority: self.event_authority.clone(),
                    program: self.program.clone(),
                },
                signer,
            ),
            reason.to_string(),
        )
    }
}

#[allow(clippy::too_many_arguments)]
pub fn update_order<'info>(
    program: AccountInfo<'info>,
    owner: AccountInfo<'info>,
    store: AccountInfo<'info>,
    market: AccountInfo<'info>,
    order: AccountInfo<'info>,
    event_authority: AccountInfo<'info>,
    signer: &[&[&[u8]]],
    params: UpdateOrderParams,
) -> Result<()> {
    cpi::update_order_v2(
        CpiContext::new_with_signer(
            program.clone(),
            UpdateOrderV2 {
                owner,
                store,
                market,
                order,
                callback_authority: None,
                callback_program: None,
                callback_shared_data_account: None,
                callback_partitioned_data_account: None,
                event_authority,
                program,
            },
            signer,
        ),
        params,
    )
}

#[cfg(test)]
mod tests {
    //! The fixed offsets above must match the gmsol-store v0.10.0 IDL on real mainnet accounts.
    use super::*;
    use base64::Engine;
    use gmsol_programs::gmsol_store::accounts::Position as IdlPosition;

    fn fixture(address: &str) -> Vec<u8> {
        let path = format!("{}/../../tests/program/fixtures/accounts/{address}.json", env!("CARGO_MANIFEST_DIR"));
        let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        base64::engine::general_purpose::STANDARD.decode(json["account"]["data"][0].as_str().unwrap()).unwrap()
    }

    #[test]
    fn position_offsets_match_idl_on_mainnet_accounts() {
        let positions = [
            "7roEjQEYB9AT43HTfQfPWVJ1MZ6ee3XMAs1BPRkaeBPF", // open long
            "Hix3KU7RASFw4Q3jubUB71rzCWHMG2VaGXitjuE8S9cg", // open short
            "12ejcFf7NkARnTXF1vjHvatQBYwjidkCzNZBAvjW5Vtc", // flat
        ];
        for address in positions {
            let data = fixture(address);
            let idl: IdlPosition = bytemuck::pod_read_unaligned(&data[8..]);
            let state = read_position_state(&data).unwrap();
            assert_eq!(state.size_usd, idl.state.size_in_usd, "{address} size");
            assert_eq!(state.collateral as u128, idl.state.collateral_amount, "{address} collateral");
            assert_eq!(pubkey_at(&data, POSITION_STORE), idl.store);
            assert_eq!(pubkey_at(&data, POSITION_OWNER), idl.owner);
            assert_eq!(pubkey_at(&data, POSITION_MARKET_TOKEN), idl.market_token);
            assert_eq!(pubkey_at(&data, POSITION_COLLATERAL_TOKEN), idl.collateral_token);
            assert_eq!(data[POSITION_KIND], idl.kind);
            assert_eq!(data[POSITION_BUMP], idl.bump);
            let expected = Pubkey::create_program_address(
                &[
                    POSITION_SEED,
                    idl.store.as_ref(),
                    idl.owner.as_ref(),
                    idl.market_token.as_ref(),
                    idl.collateral_token.as_ref(),
                    &[idl.kind],
                    &[idl.bump],
                ],
                &gmsol_programs::gmsol_store::ID,
            )
            .unwrap();
            assert_eq!(expected.to_string(), address, "position PDA seeds");
        }
        let long = read_position_state(&fixture(positions[0])).unwrap();
        assert!(long.size_usd > 0 && long.collateral > 0, "the open fixture must be non-flat");
        assert_eq!(read_position_state(&fixture(positions[2])).unwrap(), PositionState::default());
    }

    #[test]
    fn market_offsets_identify_pure_usdc_markets() {
        let usdc: Pubkey = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".parse().unwrap();
        let store: Pubkey = "CTDLvGGXnoxvqLyTpGzdGLg9pD6JexKxKXSV8tqqo8bN".parse().unwrap();
        let pure = fixture("CJg17Dn4xgUyEW3gKSSyteNw7LhP1o9pzm9eLtvuNjkQ");
        assert_eq!(pure[..8], *Market::DISCRIMINATOR);
        assert_eq!(pubkey_at(&pure, MARKET_STORE), store);
        assert_eq!(pubkey_at(&pure, MARKET_TOKEN).to_string(), "6UU9sF5fryafHDYPcmVcV7ucfnYs6iMVcvb8p7SBQgTc");
        assert_eq!((pubkey_at(&pure, MARKET_LONG_TOKEN), pubkey_at(&pure, MARKET_SHORT_TOKEN)), (usdc, usdc));
        let mixed = fixture("3M4vW1u8RT3HJSWqgEN1WuiUJZuVjJLQYEWvCHCuk56g");
        assert_ne!(pubkey_at(&mixed, MARKET_LONG_TOKEN), usdc);
    }
}
