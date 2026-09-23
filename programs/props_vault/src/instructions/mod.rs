pub mod admin;
pub mod crank;
pub mod risk;
pub mod trader;
pub mod trading;

pub use admin::*;
pub use crank::*;
pub use risk::*;
pub use trader::*;
pub use trading::*;

use anchor_lang::prelude::*;

pub(crate) fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}
