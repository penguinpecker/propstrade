//! Account validation with Anchor's semantics and error numbers (see PORTING.md "Constraint map"), PDAs, sysvars and
//! the borsh reader for instruction arguments.
use core::mem::MaybeUninit;
use pinocchio::{AccountView, Address};

use crate::{
    error::{require, Error, Result, E},
    state::{initialized_and_owned, U64},
};

pub const SYSTEM_PROGRAM_ID: Address = Address::new_from_array([0; 32]);
/// TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
pub const TOKEN_PROGRAM_ID: Address = Address::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145,
    58, 140, 245, 133, 126, 255, 0, 169,
]);
/// ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
pub const ATA_PROGRAM_ID: Address = Address::new_from_array([
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142,
    123, 216, 219, 233, 248, 89,
]);
/// BPFLoaderUpgradeab1e11111111111111111111111
pub const BPF_LOADER_UPGRADEABLE_ID: Address = Address::new_from_array([
    2, 168, 246, 145, 78, 136, 161, 176, 226, 16, 21, 62, 247, 99, 174, 43, 0, 194, 185, 61, 22, 193, 36, 210, 192, 83,
    122, 16, 4, 128, 0, 0,
]);
/// Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo (gmsol_programs::gmsol_store::ID, what `Program<GmsolStore>` checks).
pub const GMTRADE_PROGRAM_ID: Address = Address::new_from_array([
    234, 94, 74, 175, 228, 208, 167, 114, 85, 24, 18, 149, 120, 219, 76, 130, 12, 54, 252, 80, 147, 170, 106, 18, 19,
    192, 130, 125, 110, 213, 68, 8,
]);

/// Singleton PDAs of this program and their canonical bumps (checked by `tests::constants_match_anchor`). Anchor's
/// `seeds = [X], bump` (find) and `seeds = [X], bump = config.x_bump` (stored, always canonical) both reduce to
/// comparing with these.
pub const CONFIG_PDA: (Address, u8) = (
    Address::new_from_array([
        80, 94, 159, 195, 122, 82, 41, 13, 255, 108, 112, 97, 236, 212, 78, 4, 135, 58, 51, 95, 29, 40, 67, 246, 208,
        149, 125, 68, 75, 224, 190, 252,
    ]),
    255,
);
pub const VAULT_PDA: (Address, u8) = (
    Address::new_from_array([
        188, 70, 179, 17, 87, 149, 26, 50, 205, 156, 223, 199, 238, 102, 220, 212, 158, 238, 129, 75, 82, 8, 25, 127,
        92, 133, 201, 62, 152, 251, 52, 79,
    ]),
    255,
);
pub const FEE_VAULT_PDA: (Address, u8) = (
    Address::new_from_array([
        116, 88, 121, 206, 23, 102, 246, 225, 203, 97, 39, 139, 209, 205, 14, 1, 113, 150, 110, 1, 61, 221, 145, 0,
        148, 61, 58, 140, 191, 68, 49, 114,
    ]),
    255,
);
pub const SOL_TREASURY_PDA: (Address, u8) = (
    Address::new_from_array([
        213, 150, 51, 29, 58, 150, 177, 46, 145, 191, 255, 210, 22, 107, 204, 2, 74, 80, 31, 121, 205, 53, 201, 184,
        132, 185, 242, 22, 146, 211, 105, 52,
    ]),
    253,
);
/// ["__event_authority"]: signer of the event self-CPI (Anchor event-cpi).
pub const EVENT_AUTHORITY_PDA: (Address, u8) = (
    Address::new_from_array([
        148, 236, 136, 23, 141, 183, 84, 89, 27, 130, 93, 177, 165, 148, 57, 110, 216, 228, 21, 125, 217, 213, 186,
        135, 108, 254, 148, 71, 254, 188, 252, 91,
    ]),
    255,
);

// ---------- account list ----------

/// The instruction's declared accounts, in IDL order (`AccountNotEnoughKeys` when short). `&accounts[N..]` are the
/// remaining accounts.
// Simplification: checks the count up front; Anchor reports the first failing account before running out, so a transaction
// that is both short and wrong earlier names a different error (still a failure).
pub fn take<const N: usize>(accounts: &[AccountView]) -> Result<&[AccountView; N]> {
    accounts.first_chunk::<N>().ok_or(E::AccountNotEnoughKeys.into())
}

// ---------- Anchor account types (checked in field order, before any constraint) ----------

/// `Signer<'info>`.
pub fn signer(v: &AccountView) -> Result {
    require(v.is_signer(), E::AccountNotSigner)
}

/// `SystemAccount<'info>`.
pub fn system_account(v: &AccountView) -> Result {
    require(v.owned_by(&SYSTEM_PROGRAM_ID), E::AccountNotSystemOwned)
}

/// `Program<'info, T>`.
#[inline(never)]
pub fn program_account(v: &AccountView, id: &Address) -> Result {
    require(v.address() == id, E::InvalidProgramId)?;
    require(v.executable(), E::InvalidProgramExecutable)
}

// ---------- Anchor constraints ----------

/// `mut`.
pub fn mutable(v: &AccountView) -> Result {
    require(v.is_writable(), E::ConstraintMut)
}

/// `signer` constraint (as opposed to the `Signer` type).
pub fn signer_constraint(v: &AccountView) -> Result {
    require(v.is_signer(), E::ConstraintSigner)
}

/// `has_one`, `address`, `constraint = a == b` and `require_keys_eq!`, each with the error Anchor raises there.
#[inline(never)]
pub fn keys_eq(a: &Address, b: &Address, e: E) -> Result {
    require(a == b, e)
}

/// `seeds = [..], bump = <stored>` for a singleton PDA (`CONFIG_PDA`, ...).
#[inline(never)]
pub fn singleton(v: &AccountView, stored_bump: u8, pda: &(Address, u8)) -> Result {
    require(stored_bump == pda.1 && v.address() == &pda.0, E::ConstraintSeeds)
}

/// `seeds = [..], bump = <stored>`: `seeds_with_bump` ends with the stored bump.
pub fn seeds(v: &AccountView, seeds_with_bump: &[&[u8]]) -> Result {
    let pda = create_program_address(seeds_with_bump, &crate::ID).ok_or(Error::from(E::ConstraintSeeds))?;
    require(v.address() == &pda, E::ConstraintSeeds)
}

/// `seeds = [..], bump` (canonical bump found at runtime). Returns the bump (Anchor's `ctx.bumps.<field>`).
pub fn find_seeds(v: &AccountView, seeds: &[&[u8]]) -> Result<u8> {
    let (pda, bump) = find_program_address(seeds, &crate::ID);
    require(v.address() == &pda, E::ConstraintSeeds)?;
    Ok(bump)
}

/// The `event_authority` account of `#[event_cpi]` (`seeds = [b"__event_authority"], bump`).
#[inline(never)]
pub fn check_event_authority(v: &AccountView) -> Result {
    require(v.address() == &EVENT_AUTHORITY_PDA.0, E::ConstraintSeeds)
}

// ---------- PDAs ----------

/// `Pubkey::create_program_address` (`None` = invalid seeds or on-curve).
pub fn create_program_address(seeds: &[&[u8]], program_id: &Address) -> Option<Address> {
    #[cfg(target_os = "solana")]
    {
        let mut out = MaybeUninit::<Address>::uninit();
        // SAFETY: the syscall reads `seeds` as (ptr, len) pairs and writes 32 bytes on success.
        let r = unsafe {
            pinocchio::syscalls::sol_create_program_address(
                seeds.as_ptr() as *const u8,
                seeds.len() as u64,
                program_id as *const Address as *const u8,
                out.as_mut_ptr() as *mut u8,
            )
        };
        (r == 0).then(|| unsafe { out.assume_init() })
    }
    #[cfg(not(target_os = "solana"))]
    {
        let _ = (seeds, program_id, MaybeUninit::<u8>::uninit());
        unimplemented!("PDA syscalls run onchain only")
    }
}

/// `Pubkey::find_program_address` (panics like Anchor's when no bump works).
pub fn find_program_address(seeds: &[&[u8]], program_id: &Address) -> (Address, u8) {
    #[cfg(target_os = "solana")]
    {
        let mut out = MaybeUninit::<Address>::uninit();
        let mut bump = u8::MAX;
        // SAFETY: as in `create_program_address`; the syscall also writes the bump.
        let r = unsafe {
            pinocchio::syscalls::sol_try_find_program_address(
                seeds.as_ptr() as *const u8,
                seeds.len() as u64,
                program_id as *const Address as *const u8,
                out.as_mut_ptr() as *mut u8,
                &mut bump as *mut u8,
            )
        };
        assert!(r == 0, "Unable to find a viable program address bump seed");
        (unsafe { out.assume_init() }, bump)
    }
    #[cfg(not(target_os = "solana"))]
    {
        let _ = (seeds, program_id);
        unimplemented!("PDA syscalls run onchain only")
    }
}

/// `get_associated_token_address(wallet, mint)` for the SPL Token program.
pub fn ata_address(wallet: &Address, mint: &Address) -> Address {
    find_program_address(&[wallet.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()], &ATA_PROGRAM_ID).0
}

// ---------- SPL Token accounts (anchor_spl::token::{TokenAccount, Mint}) ----------

/// COption tag of spl-token's `Pack` layout: `[0, 0, 0, 0]` None, `[1, 0, 0, 0]` Some.
pub const NONE: [u8; 4] = [0; 4];
pub const SOME: [u8; 4] = [1, 0, 0, 0];

fn coption_ok(tag: &[u8; 4]) -> bool {
    *tag == NONE || *tag == SOME
}

#[repr(C)]
pub struct TokenAccount {
    pub mint: Address,
    pub owner: Address,
    pub amount: U64,
    pub delegate_tag: [u8; 4],
    pub delegate: Address,
    pub state: u8,
    is_native_tag: [u8; 4],
    _is_native: [u8; 8],
    pub delegated_amount: U64,
    pub close_authority_tag: [u8; 4],
    _close_authority: [u8; 32],
}

#[repr(C)]
pub struct Mint {
    mint_authority_tag: [u8; 4],
    _mint_authority: [u8; 32],
    _supply: [u8; 8],
    pub decimals: u8,
    pub is_initialized: u8,
    freeze_authority_tag: [u8; 4],
}

const _: () = assert!(core::mem::size_of::<TokenAccount>() == 165 && core::mem::size_of::<Mint>() == 50);

/// `Account<'info, TokenAccount>`: initialized, owned by SPL Token, `Account::unpack` (165 bytes, every COption tag and
/// the state valid, then initialized).
/// The view reads live data: read `amount` before a CPI that moves it (Anchor keeps the value from load time).
pub fn token_account(v: &AccountView) -> Result<&TokenAccount> {
    initialized_and_owned(v, &TOKEN_PROGRAM_ID)?;
    if v.data_len() != 165 {
        return Err(Error::INVALID_ACCOUNT_DATA);
    }
    // SAFETY: 165 bytes, alignment 1.
    let t = unsafe { &*(v.data_ptr() as *const TokenAccount) };
    if !(coption_ok(&t.delegate_tag) && coption_ok(&t.is_native_tag) && coption_ok(&t.close_authority_tag)) {
        return Err(Error::INVALID_ACCOUNT_DATA);
    }
    match t.state {
        0 => Err(Error::UNINITIALIZED_ACCOUNT),
        1 | 2 => Ok(t),
        _ => Err(Error::INVALID_ACCOUNT_DATA),
    }
}

/// `Account<'info, Mint>`: initialized, owned by SPL Token, `Mint::unpack` (82 bytes, both COption tags and
/// `is_initialized` valid, then initialized).
pub fn mint_account(v: &AccountView) -> Result<&Mint> {
    initialized_and_owned(v, &TOKEN_PROGRAM_ID)?;
    if v.data_len() != 82 {
        return Err(Error::INVALID_ACCOUNT_DATA);
    }
    // SAFETY: 82 bytes, alignment 1.
    let m = unsafe { &*(v.data_ptr() as *const Mint) };
    if !(coption_ok(&m.mint_authority_tag) && coption_ok(&m.freeze_authority_tag)) {
        return Err(Error::INVALID_ACCOUNT_DATA);
    }
    match m.is_initialized {
        0 => Err(Error::UNINITIALIZED_ACCOUNT),
        1 => Ok(m),
        _ => Err(Error::INVALID_ACCOUNT_DATA),
    }
}

/// `token::mint = <mint>, token::authority = <authority>` (Anchor checks the authority first).
#[inline(never)]
pub fn token_constraint(t: &TokenAccount, mint: &Address, authority: &Address) -> Result {
    require(t.owner == *authority, E::ConstraintTokenOwner)?;
    require(t.mint == *mint, E::ConstraintTokenMint)
}

/// `associated_token::mint = <mint>, associated_token::authority = <wallet>`.
pub fn associated_token_constraint(v: &AccountView, t: &TokenAccount, wallet: &Address, mint: &Address) -> Result {
    require(t.owner == *wallet, E::ConstraintTokenOwner)?;
    require(*v.address() == ata_address(wallet, mint), E::ConstraintAssociated)
}

// ---------- sysvars (the dedicated syscalls solana-program 2.3 uses) ----------

/// `Clock::get()?.unix_timestamp`.
pub fn now() -> Result<i64> {
    #[cfg(target_os = "solana")]
    {
        let mut clock = [0i64; 5];
        // SAFETY: Clock is five 8-byte fields.
        #[allow(deprecated)]
        let r = unsafe { pinocchio::syscalls::sol_get_clock_sysvar(clock.as_mut_ptr() as *mut u8) };
        if r != 0 {
            return Err(Error::UNSUPPORTED_SYSVAR);
        }
        Ok(clock[4])
    }
    #[cfg(not(target_os = "solana"))]
    Ok(0)
}

/// The Rent sysvar as solana-program 2.3 reads it.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Rent {
    pub lamports_per_byte_year: u64,
    pub exemption_threshold: f64,
    pub burn_percent: u8,
}

impl Rent {
    /// `Rent::get()`.
    pub fn get() -> Result<Rent> {
        #[cfg(target_os = "solana")]
        {
            let mut rent = MaybeUninit::<Rent>::uninit();
            // SAFETY: the syscall writes the whole repr(C) struct.
            #[allow(deprecated)]
            let r = unsafe { pinocchio::syscalls::sol_get_rent_sysvar(rent.as_mut_ptr() as *mut u8) };
            if r != 0 {
                return Err(Error::UNSUPPORTED_SYSVAR);
            }
            Ok(unsafe { rent.assume_init() })
        }
        #[cfg(not(target_os = "solana"))]
        Ok(Rent { lamports_per_byte_year: 3480, exemption_threshold: 2.0, burn_percent: 50 })
    }

    /// solana-rent 2.2 `Rent::minimum_balance`, float and all, so every amount matches the Anchor build exactly.
    pub fn minimum_balance(&self, data_len: usize) -> u64 {
        (((128 + data_len as u64) * self.lamports_per_byte_year) as f64 * self.exemption_threshold) as u64
    }
}

// ---------- instruction arguments ----------

/// Borsh reader over the instruction data after the discriminator. Anchor's `deserialize` ignores trailing bytes, and so
/// does this; anything short or malformed is `InstructionDidNotDeserialize`.
pub struct Args<'a>(pub &'a [u8]);

impl<'a> Args<'a> {
    pub fn array<const N: usize>(&mut self) -> Result<&'a [u8; N]> {
        let (head, rest) = self.0.split_first_chunk::<N>().ok_or(Error::from(E::InstructionDidNotDeserialize))?;
        self.0 = rest;
        Ok(head)
    }
    pub fn u8(&mut self) -> Result<u8> {
        Ok(self.array::<1>()?[0])
    }
    pub fn bool(&mut self) -> Result<bool> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(E::InstructionDidNotDeserialize.into()),
        }
    }
    /// A borsh enum without fields: its variant index, refused at or beyond `count`.
    pub fn variant(&mut self, count: u8) -> Result<u8> {
        let v = self.u8()?;
        require(v < count, E::InstructionDidNotDeserialize)?;
        Ok(v)
    }
    pub fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(*self.array()?))
    }
    pub fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(*self.array()?))
    }
    pub fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(*self.array()?))
    }
    pub fn i64(&mut self) -> Result<i64> {
        Ok(i64::from_le_bytes(*self.array()?))
    }
    pub fn u128(&mut self) -> Result<u128> {
        Ok(u128::from_le_bytes(*self.array()?))
    }
    pub fn key(&mut self) -> Result<&'a Address> {
        // SAFETY: Address is 32 bytes with alignment 1.
        Ok(unsafe { &*(self.array::<32>()? as *const [u8; 32] as *const Address) })
    }
    /// `Vec<Pubkey>`: u32 length, then the keys.
    pub fn keys(&mut self) -> Result<&'a [Address]> {
        let n = self.u32()? as usize;
        require(self.0.len() / 32 >= n, E::InstructionDidNotDeserialize)?;
        let (keys, rest) = self.0.split_at(n * 32);
        self.0 = rest;
        // SAFETY: n × 32 bytes, Address has alignment 1.
        Ok(unsafe { core::slice::from_raw_parts(keys.as_ptr() as *const Address, n) })
    }
    pub fn option_u128(&mut self) -> Result<Option<u128>> {
        Ok(if self.bool()? { Some(self.u128()?) } else { None })
    }
}
