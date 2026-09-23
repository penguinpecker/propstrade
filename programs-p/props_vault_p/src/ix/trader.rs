//! Port of programs/props_vault/src/instructions/trader.rs (see PORTING.md). Not ported yet: every handler returns
//! `NotPorted` so the suite fails loudly.
use pinocchio::AccountView;

use crate::error::{Result, E};

pub fn buy_evaluation(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}

pub fn activate_funded(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}

pub fn request_payout(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}

pub fn cancel_payout(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}
