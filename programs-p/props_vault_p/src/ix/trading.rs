//! Port of programs/props_vault/src/instructions/trading.rs (see PORTING.md). Not ported yet: every handler returns
//! `NotPorted` so the suite fails loudly.
use pinocchio::AccountView;

use crate::error::{Result, E};

pub fn open_position(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}

pub fn close_position(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}

pub fn set_protection(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}

pub fn update_order(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}

pub fn cancel_order(_accounts: &[AccountView], _data: &[u8]) -> Result {
    Err(E::NotPorted.into())
}
