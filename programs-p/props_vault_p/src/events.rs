//! Events exactly as Anchor's `emit_cpi!`: a CPI into this program, signed by the ["__event_authority"] PDA, with data
//! EVENT_IX_TAG_LE ++ sha256("event:<Name>")[..8] ++ borsh(event). `receive` is the other end (Anchor's
//! `__event_dispatch`): it accepts the call only when the event authority signed, so a direct call cannot forge one.
use pinocchio::AccountView;

use crate::{
    accounts::EVENT_AUTHORITY_PDA,
    cpi::{invoke, rs, Buf},
    error::{require, Error, Result, E},
};

pub const EVENT_IX_TAG: [u8; 8] = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];

/// sha256("event:<Name>")[..8], as in the IDL.
pub mod disc {
    pub const ACCOUNT_BREACHED: [u8; 8] = [13, 23, 23, 163, 10, 177, 199, 234];
    pub const ACCOUNT_CLOSED: [u8; 8] = [19, 250, 79, 236, 91, 80, 148, 48];
    pub const ACCOUNT_RESTRICTED: [u8; 8] = [151, 99, 235, 224, 157, 128, 151, 4];
    pub const CAPITAL_DEPOSITED: [u8; 8] = [193, 124, 182, 129, 144, 1, 221, 53];
    pub const CAPITAL_WITHDRAWN: [u8; 8] = [202, 30, 139, 204, 45, 210, 182, 244];
    pub const CLAIMABLE_COLLECTED: [u8; 8] = [76, 25, 203, 177, 10, 215, 251, 108];
    pub const COMPLETED_ORDER_CLOSED: [u8; 8] = [82, 165, 207, 110, 81, 70, 218, 68];
    pub const CONFIG_CHANGED: [u8; 8] = [147, 25, 86, 98, 98, 77, 78, 192];
    pub const EMPTY_POSITION_CLOSED: [u8; 8] = [1, 100, 57, 60, 215, 135, 241, 157];
    pub const EVALUATION_PURCHASED: [u8; 8] = [236, 7, 10, 61, 193, 209, 76, 136];
    pub const EVALUATION_RESOLVED: [u8; 8] = [176, 38, 204, 76, 223, 133, 148, 143];
    pub const FEES_SWEPT: [u8; 8] = [96, 218, 115, 136, 74, 170, 202, 172];
    pub const FUNDED_ACTIVATED: [u8; 8] = [119, 43, 37, 84, 142, 191, 142, 101];
    pub const IDENTITY_SET: [u8; 8] = [207, 143, 155, 168, 233, 175, 52, 179];
    pub const ORDER_CANCELLED: [u8; 8] = [108, 56, 128, 68, 168, 113, 168, 239];
    pub const ORDER_FEES_SETTLED: [u8; 8] = [57, 230, 88, 28, 118, 63, 61, 145];
    pub const ORDER_REQUESTED: [u8; 8] = [233, 57, 116, 185, 63, 88, 154, 140];
    pub const ORDER_UPDATED: [u8; 8] = [172, 140, 210, 241, 108, 117, 122, 145];
    pub const OWNER_TOPPED_UP: [u8; 8] = [178, 73, 99, 250, 204, 210, 52, 139];
    pub const PAYOUT_CANCELLED: [u8; 8] = [78, 190, 217, 66, 73, 23, 172, 182];
    pub const PAYOUT_PAID: [u8; 8] = [64, 207, 193, 176, 14, 102, 54, 159];
    pub const PAYOUT_REJECTED: [u8; 8] = [59, 154, 242, 246, 203, 126, 213, 199];
    pub const PAYOUT_REQUESTED: [u8; 8] = [65, 18, 121, 118, 19, 164, 79, 166];
    pub const PROTECTION_SET: [u8; 8] = [85, 187, 36, 64, 195, 98, 226, 124];
    pub const SOL_TREASURY_WITHDRAWN: [u8; 8] = [163, 85, 22, 101, 16, 168, 245, 167];
    pub const SYNCED: [u8; 8] = [114, 244, 163, 97, 99, 80, 164, 70];
}

/// `ConfigChange` variant indexes.
pub mod config_change {
    pub const INITIALIZED: u8 = 0;
    pub const ADMIN_PROPOSED: u8 = 1;
    pub const ADMIN_ACCEPTED: u8 = 2;
    pub const AUTHORITIES: u8 = 3;
    pub const PARAMS: u8 = 4;
    pub const PAUSES: u8 = 5;
    pub const TIER: u8 = 6;
    pub const MARKET: u8 = 7;
    pub const ORDER_FEE: u8 = 8;
}

/// A buffer holding the event tag and `disc`; write the event's fields in IDL order, then `emit`. `N` = 16 + body size.
pub fn event<const N: usize>(disc: [u8; 8]) -> Buf<N> {
    let mut b = Buf::default();
    b.bytes(&EVENT_IX_TAG).bytes(&disc);
    b
}

/// `emit_cpi!`: the self-CPI with the event authority (already checked with `accounts::check_event_authority`) as its only,
/// signing account.
pub fn emit<const N: usize>(event_authority: &AccountView, event: &Buf<N>) -> Result {
    invoke(&crate::ID, &[rs(event_authority)], event.as_slice(), &[&[b"__event_authority", &[EVENT_AUTHORITY_PDA.1]]])
}

/// The event self-CPI (Anchor `__event_dispatch`): the first account must be the event authority, signing.
pub fn receive(accounts: &[AccountView]) -> Result {
    let authority = accounts.first().ok_or(Error::NOT_ENOUGH_ACCOUNT_KEYS)?;
    require(authority.is_signer(), E::ConstraintSigner)?;
    require(authority.address() == &EVENT_AUTHORITY_PDA.0, E::ConstraintSeeds)
}
