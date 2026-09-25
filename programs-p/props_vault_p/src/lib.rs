//! Props.trade vault on Pinocchio: a drop-in replacement for the Anchor `props_vault` program (programs/props_vault).
//! Same program id, instruction discriminators and borsh args, account lists (incl. Anchor's event-cpi accounts),
//! account layouts and PDAs, `emit_cpi!`-style events and Anchor error numbers and log lines. PORTING.md explains how
//! the Anchor constraints map onto the helpers in `accounts`, `cpi`, `state`, `events` and `gmtrade`.
#![cfg_attr(not(test), no_std)]

use pinocchio::{AccountView, Address};

pub mod accounts;
pub mod cpi;
pub mod error;
pub mod events;
pub mod gmtrade;
pub mod ix;
pub mod state;

use error::{Result, E};

/// 7qYRWwpmj3j3exVoBUJHzigcWmMN8ruPEdZdZrGzTJ7
pub const ID: Address = Address::new_from_array([
    1, 192, 95, 7, 149, 22, 81, 88, 109, 136, 82, 191, 251, 39, 1, 161, 229, 57, 250, 225, 106, 85, 43, 24, 237, 245,
    204, 108, 219, 208, 98, 0,
]);

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use core::mem::MaybeUninit;
    use pinocchio::{AccountView, MAX_TX_ACCOUNTS, SUCCESS};

    /// pinocchio's input parsing; the error code goes out as is (no `ProgramError` round trip).
    #[no_mangle]
    pub unsafe extern "C" fn entrypoint(input: *mut u8) -> u64 {
        const UNINIT: MaybeUninit<AccountView> = MaybeUninit::uninit();
        let mut accounts = [UNINIT; MAX_TX_ACCOUNTS];
        // SAFETY: `input` is the runtime's serialized instruction; `count` views were initialized.
        let (program_id, count, data) = pinocchio::entrypoint::deserialize::<MAX_TX_ACCOUNTS>(input, &mut accounts);
        let accounts = core::slice::from_raw_parts(accounts.as_ptr() as *const AccountView, count);
        match crate::process_instruction(program_id, accounts, data) {
            Ok(()) => SUCCESS,
            Err(e) => e.code(),
        }
    }

    pinocchio::no_allocator!();
    pinocchio::nostd_panic_handler!();
}

/// Anchor's `entry`: a program id check, the dispatch, and the error log line for every error this program raises.
pub fn process_instruction(program_id: &Address, accounts: &[AccountView], data: &[u8]) -> Result {
    let result = if program_id != &ID { Err(E::DeclaredProgramIdMismatch.into()) } else { dispatch(accounts, data) };
    if let Err(e) = result {
        error::log(e);
    }
    result
}

/// Instruction discriminators: Anchor's sha256("global:<name>")[..8], read as a little-endian u64.
pub mod disc {
    pub const INITIALIZE: u64 = 0xed9b980d1f6dafaf;
    pub const PROPOSE_ADMIN: u64 = 0xea752757d4c7d679;
    pub const ACCEPT_ADMIN: u64 = 0xaa0db5745a2d2a70;
    pub const SET_AUTHORITIES: u64 = 0x6bbe46c5f02cfe7c;
    pub const SET_PARAMS: u64 = 0x8dbb029334b2ea1b;
    pub const SET_PAUSES: u64 = 0x7ae2f442e3c85030;
    pub const UPSERT_TIER: u64 = 0xca00959d00b5e8ee;
    pub const UPSERT_MARKET: u64 = 0x27394d4611d97a49;
    pub const DEPOSIT_CAPITAL: u64 = 0xfd79d2cd2928629d;
    pub const WITHDRAW_CAPITAL: u64 = 0x684174a076522052;
    pub const SWEEP_FEES: u64 = 0x942242764762e1af;
    pub const WITHDRAW_SOL_TREASURY: u64 = 0x3424edb7315b3264;
    pub const BUY_EVALUATION: u64 = 0xca352c822fda3135;
    pub const ACTIVATE_FUNDED: u64 = 0xcdaea3453e474a37;
    pub const OPEN_POSITION: u64 = 0x31f0980f4d2f8087;
    pub const CLOSE_POSITION: u64 = 0x626244310051867b;
    pub const SET_PROTECTION: u64 = 0xac37c628c882c7aa;
    pub const UPDATE_ORDER: u64 = 0xa8ef8622cfd00836;
    pub const CANCEL_ORDER: u64 = 0x84df3108f0ed815f;
    pub const REQUEST_PAYOUT: u64 = 0xc840b1acc56eb005;
    pub const CANCEL_PAYOUT: u64 = 0x3decdab1717e9877;
    pub const SET_IDENTITY: u64 = 0xb06a63b2418d1f1f;
    pub const RECORD_EVALUATION_RESULT: u64 = 0xe9cc9780014b53e0;
    pub const APPROVE_PAYOUT: u64 = 0x911c66e5916fe9bc;
    pub const REJECT_PAYOUT: u64 = 0xdf9be0e9b93efd84;
    pub const RESTRICT: u64 = 0xeb0d107fedba51d1;
    pub const MARK_BREACHED: u64 = 0x0d91bd5a93d1d1ac;
    pub const CLOSE_FUNDED: u64 = 0x633f416415375c0c;
    pub const SYNC: u64 = 0x58bd9d15a428db04;
    pub const TOP_UP_OWNER: u64 = 0xd37d3413550dd12e;
    pub const CLOSE_COMPLETED_ORDER: u64 = 0x9f2700ed03bb15b3;
    pub const CLOSE_EMPTY_POSITION: u64 = 0x3bfaebed268a69af;
    pub const COLLECT_CLAIMABLE: u64 = 0x803e6bea4c65abe0;
    pub const SET_ORDER_FEE: u64 = 0xe469c70cd343901a;
    pub const SETTLE_ORDER_FEES: u64 = 0x685eb63b2f0b4f39;
    /// anchor_lang::idl::IDL_IX_TAG: Anchor's onchain-IDL instructions (not provided, as with Anchor's `no-idl`).
    pub const IDL_IX_TAG: u64 = 0x0a69e9a778bcf440;
    /// anchor_lang::event::EVENT_IX_TAG: the event self-CPI.
    pub const EVENT_IX_TAG: u64 = 0x1d9acb512ea545e4;
}

fn dispatch(accounts: &[AccountView], data: &[u8]) -> Result {
    use ix::{admin, crank, risk, trader, trading};
    let Some((tag, args)) = data.split_first_chunk::<8>() else {
        return Err(E::InstructionFallbackNotFound.into());
    };
    match u64::from_le_bytes(*tag) {
        disc::INITIALIZE => admin::initialize(accounts, args),
        disc::PROPOSE_ADMIN => admin::propose_admin(accounts, args),
        disc::ACCEPT_ADMIN => admin::accept_admin(accounts, args),
        disc::SET_AUTHORITIES => admin::set_authorities(accounts, args),
        disc::SET_PARAMS => admin::set_params(accounts, args),
        disc::SET_PAUSES => admin::set_pauses(accounts, args),
        disc::UPSERT_TIER => admin::upsert_tier(accounts, args),
        disc::UPSERT_MARKET => admin::upsert_market(accounts, args),
        disc::DEPOSIT_CAPITAL => admin::deposit_capital(accounts, args),
        disc::WITHDRAW_CAPITAL => admin::withdraw_capital(accounts, args),
        disc::SWEEP_FEES => admin::sweep_fees(accounts, args),
        disc::WITHDRAW_SOL_TREASURY => admin::withdraw_sol_treasury(accounts, args),
        disc::BUY_EVALUATION => trader::buy_evaluation(accounts, args),
        disc::ACTIVATE_FUNDED => trader::activate_funded(accounts, args),
        disc::OPEN_POSITION => trading::open_position(accounts, args),
        disc::CLOSE_POSITION => trading::close_position(accounts, args),
        disc::SET_PROTECTION => trading::set_protection(accounts, args),
        disc::UPDATE_ORDER => trading::update_order(accounts, args),
        disc::CANCEL_ORDER => trading::cancel_order(accounts, args),
        disc::REQUEST_PAYOUT => trader::request_payout(accounts, args),
        disc::CANCEL_PAYOUT => trader::cancel_payout(accounts, args),
        disc::SET_IDENTITY => risk::set_identity(accounts, args),
        disc::RECORD_EVALUATION_RESULT => risk::record_evaluation_result(accounts, args),
        disc::APPROVE_PAYOUT => risk::approve_payout(accounts, args),
        disc::REJECT_PAYOUT => risk::reject_payout(accounts, args),
        disc::RESTRICT => risk::restrict(accounts, args),
        disc::MARK_BREACHED => risk::mark_breached(accounts, args),
        disc::CLOSE_FUNDED => risk::close_funded(accounts, args),
        disc::SYNC => crank::sync(accounts, args),
        disc::TOP_UP_OWNER => crank::top_up_owner(accounts, args),
        disc::CLOSE_COMPLETED_ORDER => crank::close_completed_order(accounts, args),
        disc::CLOSE_EMPTY_POSITION => crank::close_empty_position(accounts, args),
        disc::COLLECT_CLAIMABLE => crank::collect_claimable(accounts, args),
        disc::SET_ORDER_FEE => admin::set_order_fee(accounts, args),
        disc::SETTLE_ORDER_FEES => risk::settle_order_fees(accounts, args),
        disc::EVENT_IX_TAG => events::receive(accounts),
        disc::IDL_IX_TAG => Err(E::IdlInstructionStub.into()),
        _ => Err(E::InstructionFallbackNotFound.into()),
    }
}

/// `sol_log_` (a no-op off-chain).
pub fn log(msg: &[u8]) {
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_log_(msg.as_ptr(), msg.len() as u64)
    };
    #[cfg(not(target_os = "solana"))]
    let _ = msg;
}

#[cfg(test)]
mod tests {
    //! Every hard-coded constant against the rule it comes from: Anchor discriminators (sha256 preimages) and the
    //! canonical singleton PDAs (host `find_program_address`).
    use crate::{accounts::*, events::disc as ev, gmtrade, state::*};
    use pinocchio::Address;
    use sha2::{Digest, Sha256};

    fn sha8(preimage: &str) -> [u8; 8] {
        Sha256::digest(preimage.as_bytes())[..8].try_into().unwrap()
    }

    #[test]
    fn constants_match_anchor() {
        use crate::disc::*;
        let ixs = [
            ("initialize", INITIALIZE),
            ("propose_admin", PROPOSE_ADMIN),
            ("accept_admin", ACCEPT_ADMIN),
            ("set_authorities", SET_AUTHORITIES),
            ("set_params", SET_PARAMS),
            ("set_pauses", SET_PAUSES),
            ("upsert_tier", UPSERT_TIER),
            ("upsert_market", UPSERT_MARKET),
            ("deposit_capital", DEPOSIT_CAPITAL),
            ("withdraw_capital", WITHDRAW_CAPITAL),
            ("sweep_fees", SWEEP_FEES),
            ("withdraw_sol_treasury", WITHDRAW_SOL_TREASURY),
            ("buy_evaluation", BUY_EVALUATION),
            ("activate_funded", ACTIVATE_FUNDED),
            ("open_position", OPEN_POSITION),
            ("close_position", CLOSE_POSITION),
            ("set_protection", SET_PROTECTION),
            ("update_order", UPDATE_ORDER),
            ("cancel_order", CANCEL_ORDER),
            ("request_payout", REQUEST_PAYOUT),
            ("cancel_payout", CANCEL_PAYOUT),
            ("set_identity", SET_IDENTITY),
            ("record_evaluation_result", RECORD_EVALUATION_RESULT),
            ("approve_payout", APPROVE_PAYOUT),
            ("reject_payout", REJECT_PAYOUT),
            ("restrict", RESTRICT),
            ("mark_breached", MARK_BREACHED),
            ("close_funded", CLOSE_FUNDED),
            ("sync", SYNC),
            ("top_up_owner", TOP_UP_OWNER),
            ("close_completed_order", CLOSE_COMPLETED_ORDER),
            ("close_empty_position", CLOSE_EMPTY_POSITION),
            ("collect_claimable", COLLECT_CLAIMABLE),
            ("set_order_fee", SET_ORDER_FEE),
            ("settle_order_fees", SETTLE_ORDER_FEES),
        ];
        for (name, v) in ixs {
            assert_eq!(u64::from_le_bytes(sha8(&format!("global:{name}"))), v, "{name}");
        }
        let accounts = [
            ("Config", CONFIG_DISC),
            ("Tier", Tier::DISC),
            ("MarketConfig", MarketConfig::DISC),
            ("TraderProfile", TraderProfile::DISC),
            ("IdentityLock", IdentityLock::DISC),
            ("Evaluation", Evaluation::DISC),
            ("FundedAccount", FundedAccount::DISC),
            ("PayoutRequest", PayoutRequest::DISC),
            ("Market", gmtrade::MARKET_DISC),
            ("Order", gmtrade::ORDER_DISC),
            ("Position", gmtrade::POSITION_DISC),
        ];
        for (name, d) in accounts {
            assert_eq!(sha8(&format!("account:{name}")), d, "{name}");
        }
        let events = [
            ("AccountBreached", ev::ACCOUNT_BREACHED),
            ("AccountClosed", ev::ACCOUNT_CLOSED),
            ("AccountRestricted", ev::ACCOUNT_RESTRICTED),
            ("CapitalDeposited", ev::CAPITAL_DEPOSITED),
            ("CapitalWithdrawn", ev::CAPITAL_WITHDRAWN),
            ("ClaimableCollected", ev::CLAIMABLE_COLLECTED),
            ("CompletedOrderClosed", ev::COMPLETED_ORDER_CLOSED),
            ("ConfigChanged", ev::CONFIG_CHANGED),
            ("EmptyPositionClosed", ev::EMPTY_POSITION_CLOSED),
            ("EvaluationPurchased", ev::EVALUATION_PURCHASED),
            ("EvaluationResolved", ev::EVALUATION_RESOLVED),
            ("FeesSwept", ev::FEES_SWEPT),
            ("FundedActivated", ev::FUNDED_ACTIVATED),
            ("IdentitySet", ev::IDENTITY_SET),
            ("OrderCancelled", ev::ORDER_CANCELLED),
            ("OrderFeesSettled", ev::ORDER_FEES_SETTLED),
            ("OrderRequested", ev::ORDER_REQUESTED),
            ("OrderUpdated", ev::ORDER_UPDATED),
            ("OwnerToppedUp", ev::OWNER_TOPPED_UP),
            ("PayoutCancelled", ev::PAYOUT_CANCELLED),
            ("PayoutPaid", ev::PAYOUT_PAID),
            ("PayoutRejected", ev::PAYOUT_REJECTED),
            ("PayoutRequested", ev::PAYOUT_REQUESTED),
            ("ProtectionSet", ev::PROTECTION_SET),
            ("SolTreasuryWithdrawn", ev::SOL_TREASURY_WITHDRAWN),
            ("Synced", ev::SYNCED),
        ];
        for (name, d) in events {
            assert_eq!(sha8(&format!("event:{name}")), d, "{name}");
        }
        let gm = [
            ("prepare_user", gmtrade::ix::PREPARE_USER),
            ("prepare_position", gmtrade::ix::PREPARE_POSITION),
            ("create_order_v2", gmtrade::ix::CREATE_ORDER_V2),
            ("close_order_v2", gmtrade::ix::CLOSE_ORDER_V2),
            ("update_order_v2", gmtrade::ix::UPDATE_ORDER_V2),
            ("close_empty_position", gmtrade::ix::CLOSE_EMPTY_POSITION),
        ];
        for (name, d) in gm {
            assert_eq!(sha8(&format!("global:{name}")), d, "{name}");
        }

        let key = |s: &str| s.parse::<Address>().unwrap();
        assert_eq!(crate::ID, key("7qYRWwpmj3j3exVoBUJHzigcWmMN8ruPEdZdZrGzTJ7"));
        assert_eq!(TOKEN_PROGRAM_ID, key("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
        assert_eq!(ATA_PROGRAM_ID, key("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"));
        assert_eq!(BPF_LOADER_UPGRADEABLE_ID, key("BPFLoaderUpgradeab1e11111111111111111111111"));
        assert_eq!(GMTRADE_PROGRAM_ID, key("Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo"));
        for (seed, pda) in [
            ("config", CONFIG_PDA),
            ("vault", VAULT_PDA),
            ("fee_vault", FEE_VAULT_PDA),
            ("sol_treasury", SOL_TREASURY_PDA),
            ("__event_authority", EVENT_AUTHORITY_PDA),
        ] {
            assert_eq!(Address::find_program_address(&[seed.as_bytes()], &crate::ID), pda, "{seed}");
        }
        assert_eq!(CONFIG_SPACE, 484);
    }
}
