//! Port of programs/props_vault/src/instructions/crank.rs (see PORTING.md). Not ported yet: every handler returns
//! `NotPorted` so the suite fails loudly.
use pinocchio::AccountView;

use crate::error::{Result, E};

pub fn sync(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}

pub fn top_up_owner(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}

pub fn close_completed_order(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}
