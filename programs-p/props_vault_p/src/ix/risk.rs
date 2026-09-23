//! Port of programs/props_vault/src/instructions/risk.rs (see PORTING.md). Not ported yet: every handler returns
//! `NotPorted` so the suite fails loudly.
use pinocchio::AccountView;

use crate::error::{Result, E};

pub fn set_identity(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}

pub fn record_evaluation_result(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}

pub fn approve_payout(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}

pub fn reject_payout(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}

pub fn restrict(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}

pub fn mark_breached(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}

pub fn close_funded(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}
