//! Cross-program invocations with the exact instruction layouts the Anchor build sends (anchor_lang::system_program,
//! anchor_spl::token / associated_token), Anchor's `init` / `init_if_needed` account creation, and the borsh writer
//! used for CPI and event data.
use core::{mem::MaybeUninit, slice::from_raw_parts};
use pinocchio::{
    cpi::{invoke_signed_unchecked, CpiAccount, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address,
};

use crate::{
    accounts::{
        ata_address, find_program_address, token_account, token_constraint, Rent, TokenAccount, ATA_PROGRAM_ID,
        SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
    },
    error::{require, Result, E},
    state::{initialized_and_owned, load_raw, Data, SOL_TREASURY_SEED},
};

/// One instruction account: the account, writable, signer.
pub type Meta<'a> = (&'a AccountView, bool, bool);
pub fn r(v: &AccountView) -> Meta<'_> {
    (v, false, false)
}
pub fn w(v: &AccountView) -> Meta<'_> {
    (v, true, false)
}
pub fn rs(v: &AccountView) -> Meta<'_> {
    (v, false, true)
}
pub fn ws(v: &AccountView) -> Meta<'_> {
    (v, true, true)
}

/// Largest CPI account list (GMTrade close_order_v2 has 30).
const MAX_CPI_ACCOUNTS: usize = 32;

/// PDA signer seeds, as solana-program's `invoke_signed` takes them: one `&[&[u8]]` (seeds + bump) per signing PDA.
pub type Seeds<'a> = &'a [&'a [&'a [u8]]];

/// Invokes `program_id` with `metas` (in the callee's account order) and `data`, signed by the PDAs in `signers`. A
/// failing callee aborts the whole transaction, as with any CPI.
#[inline(never)]
pub fn invoke(program_id: &Address, metas: &[Meta], data: &[u8], signers: Seeds) -> Result {
    let n = metas.len();
    assert!(n <= MAX_CPI_ACCOUNTS);
    let mut accounts = [const { MaybeUninit::<InstructionAccount>::uninit() }; MAX_CPI_ACCOUNTS];
    let mut infos = [const { MaybeUninit::<CpiAccount>::uninit() }; MAX_CPI_ACCOUNTS];
    for (i, (v, writable, signer)) in metas.iter().enumerate() {
        accounts[i].write(InstructionAccount::new(v.address(), *writable, *signer));
        CpiAccount::init_from_account_view(v, &mut infos[i]);
    }
    // SAFETY: the first `n` entries of both arrays were written above. `Signer` / `Seed` are repr(C) (pointer, u64
    // length) pairs, the layout of `&[&[u8]]` / `&[u8]`, which is also what the syscall reads.
    unsafe {
        invoke_signed_unchecked(
            &InstructionView { program_id, accounts: from_raw_parts(accounts.as_ptr() as _, n), data },
            from_raw_parts(infos.as_ptr() as _, n),
            &*(signers as *const [&[&[u8]]] as *const [Signer]),
        )
    };
    Ok(())
}

// ---------- System program (anchor_lang::system_program) ----------

pub fn transfer(from: &AccountView, to: &AccountView, lamports: u64, signers: Seeds) -> Result {
    let mut d = [0u8; 12];
    d[0] = 2;
    d[4..].copy_from_slice(&lamports.to_le_bytes());
    invoke(&SYSTEM_PROGRAM_ID, &[ws(from), w(to)], &d, signers)
}

pub fn create_account(
    from: &AccountView,
    to: &AccountView,
    lamports: u64,
    space: u64,
    owner: &Address,
    signers: Seeds,
) -> Result {
    let mut d = [0u8; 52];
    d[4..12].copy_from_slice(&lamports.to_le_bytes());
    d[12..20].copy_from_slice(&space.to_le_bytes());
    d[20..].copy_from_slice(owner.as_ref());
    invoke(&SYSTEM_PROGRAM_ID, &[ws(from), ws(to)], &d, signers)
}

pub fn allocate(account: &AccountView, space: u64, signers: Seeds) -> Result {
    let mut d = [0u8; 12];
    d[0] = 8;
    d[4..].copy_from_slice(&space.to_le_bytes());
    invoke(&SYSTEM_PROGRAM_ID, &[ws(account)], &d, signers)
}

pub fn assign(account: &AccountView, owner: &Address, signers: Seeds) -> Result {
    let mut d = [0u8; 36];
    d[0] = 1;
    d[4..].copy_from_slice(owner.as_ref());
    invoke(&SYSTEM_PROGRAM_ID, &[ws(account)], &d, signers)
}

/// Moves SOL from the treasury so `owner` holds at least `target` lamports (Anchor trader.rs `top_up_from_treasury`;
/// used by activate_funded and top_up_owner). `treasury_bump` = `config.sol_treasury_bump`.
pub fn top_up_from_treasury(
    sol_treasury: &AccountView,
    owner: &AccountView,
    treasury_bump: u8,
    target: u64,
) -> Result<u64> {
    let amount = target.saturating_sub(owner.lamports());
    if amount > 0 {
        transfer(sol_treasury, owner, amount, &[&[SOL_TREASURY_SEED, &[treasury_bump]]])?;
    }
    Ok(amount)
}

// ---------- SPL Token (anchor_spl::token, program id spl_token::ID) ----------

pub fn transfer_checked(
    from: &AccountView,
    mint: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    amount: u64,
    decimals: u8,
    signers: Seeds,
) -> Result {
    let mut d = [0u8; 10];
    d[0] = 12;
    d[1..9].copy_from_slice(&amount.to_le_bytes());
    d[9] = decimals;
    invoke(&TOKEN_PROGRAM_ID, &[w(from), r(mint), w(to), rs(authority)], &d, signers)
}

pub fn close_account(
    account: &AccountView,
    destination: &AccountView,
    authority: &AccountView,
    signers: Seeds,
) -> Result {
    invoke(&TOKEN_PROGRAM_ID, &[w(account), w(destination), rs(authority)], &[9], signers)
}

/// `token_interface::initialize_account3` (program = the `token_program` account, as Anchor's init does).
pub fn initialize_account3(
    token_program: &AccountView,
    account: &AccountView,
    mint: &AccountView,
    owner: &Address,
) -> Result {
    let mut d = [0u8; 33];
    d[0] = 18;
    d[1..].copy_from_slice(owner.as_ref());
    invoke(token_program.address(), &[w(account), r(mint)], &d, &[])
}

// ---------- Associated Token Account program ----------

/// `associated_token::create` (`idempotent = false`) / `create_idempotent`. The ATA program checks that `ata` is
/// ATA(wallet, mint).
#[allow(clippy::too_many_arguments)]
pub fn create_ata(
    payer: &AccountView,
    ata: &AccountView,
    wallet: &AccountView,
    mint: &AccountView,
    system_program: &AccountView,
    token_program: &AccountView,
    idempotent: bool,
    signers: Seeds,
) -> Result {
    invoke(
        &ATA_PROGRAM_ID,
        &[ws(payer), w(ata), r(wallet), r(mint), r(system_program), r(token_program)],
        &[idempotent as u8],
        signers,
    )
}

// ---------- Anchor `init` / `init_if_needed` ----------

/// Anchor's account creation (codegen `generate_create_account`): `create_account` when the account holds no
/// lamports; otherwise (pre-funded) top up to rent-exempt from `payer`, then `allocate` + `assign` signed by the
/// account's seeds. A program-owned account fails here with the system program's "already in use".
pub fn create_account_anchor(
    payer: &AccountView,
    account: &AccountView,
    space: usize,
    owner: &Address,
    rent: &Rent,
    signers: Seeds,
) -> Result {
    let current = account.lamports();
    if current == 0 {
        return create_account(payer, account, rent.minimum_balance(space), space as u64, owner, signers);
    }
    require(payer.address() != account.address(), E::TryingToInitPayerAsProgramAccount)?;
    let required = rent.minimum_balance(space).max(1).saturating_sub(current);
    if required > 0 {
        transfer(payer, account, required, &[])?;
    }
    allocate(account, space as u64, signers)?;
    assign(account, owner, signers)
}

/// `seeds` followed by `bump` (at most 4 seeds): the signer seeds of the PDA; use `[..=seeds.len()]`.
pub fn with_bump<'a>(seeds: &[&'a [u8]], bump: &'a [u8; 1]) -> [&'a [u8]; 5] {
    let mut all: [&[u8]; 5] = [&[]; 5];
    all[..seeds.len()].copy_from_slice(seeds);
    all[seeds.len()] = bump;
    all
}

/// `init, seeds = [..], bump` address check: the canonical PDA of `seeds` (Anchor's `find_program_address`).
pub fn init_address(account: &AccountView, seeds: &[&[u8]]) -> Result<u8> {
    let (pda, bump) = find_program_address(seeds, &crate::ID);
    require(account.address() == &pda, E::ConstraintSeeds)?;
    Ok(bump)
}

/// `#[account(init | init_if_needed, payer, space = T::SPACE, seeds, bump)] Account<'info, T>`, in Anchor's order:
/// seeds, create (or load when `if_needed` and the account exists), the if_needed space/owner/rent checks, `mut`.
/// Returns the account view (discriminator written when created) and the canonical bump. Same aliasing rule as `load`.
#[allow(clippy::mut_from_ref)]
pub fn init_pda<'a, T: Data>(
    payer: &AccountView,
    account: &'a AccountView,
    seeds: &[&[u8]],
    if_needed: bool,
    rent: &Rent,
) -> Result<(&'a mut T, u8)> {
    let (data, bump) = init_pda_raw(payer, account, seeds, &T::DISC, T::SPACE, if_needed, rent)?;
    // SAFETY: `init_pda_raw` returns the body of an account of at least T::SPACE bytes; T has alignment 1.
    Ok((unsafe { &mut *(data as *mut T) }, bump))
}

/// `init_pda` without the type (one copy of the code for every account type).
#[inline(never)]
fn init_pda_raw(
    payer: &AccountView,
    account: &AccountView,
    seeds: &[&[u8]],
    disc: &[u8; 8],
    space: usize,
    if_needed: bool,
    rent: &Rent,
) -> Result<(*mut u8, u8)> {
    let bump = init_address(account, seeds)?;
    let data = if !if_needed || account.owned_by(&SYSTEM_PROGRAM_ID) {
        create_account_anchor(payer, account, space, &crate::ID, rent, &[&with_bump(seeds, &[bump])[..=seeds.len()]])?;
        initialized_and_owned(account, &crate::ID)?;
        let mut v = *account;
        let d = v.data_mut_ptr();
        // SAFETY: the account was just allocated with `space` (> 8) zeroed bytes.
        unsafe {
            (d as *mut [u8; 8]).write(*disc);
            d.add(8)
        }
    } else {
        load_raw(account, disc, space)?
    };
    if if_needed {
        require(account.data_len() == space, E::ConstraintSpace)?;
        require(account.owned_by(&crate::ID), E::ConstraintOwner)?;
        require(account.lamports() >= rent.minimum_balance(space), E::ConstraintRentExempt)?;
    }
    require(account.is_writable(), E::ConstraintMut)?;
    Ok((data, bump))
}

/// `#[account(init, payer, seeds, bump, token::mint, token::authority)] Account<'info, TokenAccount>` (SPL Token,
/// 165 bytes): create, `initialize_account3`, load, `mut`, token constraint. Returns the canonical bump.
pub fn init_token_pda(
    payer: &AccountView,
    account: &AccountView,
    seeds: &[&[u8]],
    mint: &AccountView,
    authority: &AccountView,
    token_program: &AccountView,
    rent: &Rent,
) -> Result<u8> {
    let bump = init_address(account, seeds)?;
    create_account_anchor(
        payer,
        account,
        165,
        token_program.address(),
        rent,
        &[&with_bump(seeds, &[bump])[..=seeds.len()]],
    )?;
    initialize_account3(token_program, account, mint, authority.address())?;
    let t = token_account(account)?;
    require(account.is_writable(), E::ConstraintMut)?;
    token_constraint(t, mint.address(), authority.address())?;
    Ok(bump)
}

/// `#[account(init_if_needed, payer, associated_token::mint, associated_token::authority)] Account<'info, TokenAccount>`:
/// create through the ATA program when system-owned, then Anchor's if_needed checks and `mut`.
pub fn init_ata_if_needed<'a>(
    payer: &AccountView,
    account: &'a AccountView,
    wallet: &AccountView,
    mint: &AccountView,
    system_program: &AccountView,
    token_program: &AccountView,
) -> Result<&'a TokenAccount> {
    if account.owned_by(&SYSTEM_PROGRAM_ID) {
        create_ata(payer, account, wallet, mint, system_program, token_program, false, &[])?;
    }
    let t = token_account(account)?;
    require(t.mint == *mint.address(), E::ConstraintTokenMint)?;
    require(t.owner == *wallet.address(), E::ConstraintTokenOwner)?;
    require(account.owned_by(token_program.address()), E::ConstraintAssociatedTokenTokenProgram)?;
    require(*account.address() == ata_address(wallet.address(), mint.address()), E::AccountNotAssociatedTokenAccount)?;
    require(account.is_writable(), E::ConstraintMut)?;
    Ok(t)
}

// ---------- borsh writer ----------

/// Borsh writer over a stack buffer (event bodies, CPI data). Writing past `N` panics: size `N` for the largest value.
pub struct Buf<const N: usize> {
    buf: [u8; N],
    len: usize,
}

impl<const N: usize> Default for Buf<N> {
    fn default() -> Self {
        Buf { buf: [0; N], len: 0 }
    }
}

impl<const N: usize> Buf<N> {
    pub fn bytes(&mut self, b: &[u8]) -> &mut Self {
        self.buf[self.len..self.len + b.len()].copy_from_slice(b);
        self.len += b.len();
        self
    }
    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.bytes(&[v])
    }
    pub fn bool(&mut self, v: bool) -> &mut Self {
        self.u8(v as u8)
    }
    pub fn u16(&mut self, v: u16) -> &mut Self {
        self.bytes(&v.to_le_bytes())
    }
    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.bytes(&v.to_le_bytes())
    }
    pub fn u64(&mut self, v: u64) -> &mut Self {
        self.bytes(&v.to_le_bytes())
    }
    pub fn i64(&mut self, v: i64) -> &mut Self {
        self.bytes(&v.to_le_bytes())
    }
    pub fn u128(&mut self, v: u128) -> &mut Self {
        self.bytes(&v.to_le_bytes())
    }
    pub fn key(&mut self, k: &Address) -> &mut Self {
        self.bytes(k.as_ref())
    }
    pub fn option_u128(&mut self, v: Option<u128>) -> &mut Self {
        match v {
            Some(v) => self.u8(1).u128(v),
            None => self.u8(0),
        }
    }
    pub fn option_i64(&mut self, v: Option<i64>) -> &mut Self {
        match v {
            Some(v) => self.u8(1).i64(v),
            None => self.u8(0),
        }
    }
    pub fn as_slice(&self) -> &[u8] {
        &self.buf[..self.len]
    }
}
