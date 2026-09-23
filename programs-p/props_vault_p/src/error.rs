//! Errors: Anchor framework codes (anchor-lang 0.31 `ErrorCode`, same numbers) and the program's `VaultError`
//! (6000 + index in programs/props_vault/src/errors.rs, i.e. the IDL's error list). Each is returned as
//! `custom program error: <code>` and logged once, by `process_instruction`, in Anchor's format:
//! `AnchorError occurred. Error Code: <Name>. Error Number: <n>. Error Message: <msg>.`
//! (the server matches /Error Code: (\w+)/, the app /AnchorError.*Error Number: (\d+)\. Error Message: (.*?)\.?$/).
use core::num::NonZeroU64;
use pinocchio::error::ProgramError;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum E {
    // Anchor framework errors (anchor-lang 0.31.1 src/error.rs).
    InstructionFallbackNotFound = 101,
    InstructionDidNotDeserialize = 102,
    IdlInstructionStub = 1000,
    ConstraintMut = 2000,
    ConstraintHasOne = 2001,
    ConstraintSigner = 2002,
    ConstraintRaw = 2003,
    ConstraintOwner = 2004,
    ConstraintRentExempt = 2005,
    ConstraintSeeds = 2006,
    ConstraintAssociated = 2009,
    ConstraintAddress = 2012,
    ConstraintTokenMint = 2014,
    ConstraintTokenOwner = 2015,
    ConstraintSpace = 2019,
    ConstraintAssociatedTokenTokenProgram = 2023,
    AccountDiscriminatorNotFound = 3001,
    AccountDiscriminatorMismatch = 3002,
    AccountDidNotDeserialize = 3003,
    AccountDidNotSerialize = 3004,
    AccountNotEnoughKeys = 3005,
    AccountOwnedByWrongProgram = 3007,
    InvalidProgramId = 3008,
    InvalidProgramExecutable = 3009,
    AccountNotSigner = 3010,
    AccountNotSystemOwned = 3011,
    AccountNotInitialized = 3012,
    AccountNotProgramData = 3013,
    AccountNotAssociatedTokenAccount = 3014,
    DeclaredProgramIdMismatch = 4100,
    TryingToInitPayerAsProgramAccount = 4101,
    // VaultError (programs/props_vault/src/errors.rs), in order.
    NotUpgradeAuthority = 6000,
    Unauthorized,
    InvalidParams,
    TooManyRiskAuthorities,
    Paused,
    TierDisabled,
    MarketNotPure,
    MarketMismatch,
    MarketDisabled,
    InvalidEvaluationStatus,
    InvalidAccountStatus,
    NotVerified,
    AlreadyVerified,
    AlreadyFunded,
    InsufficientCapital,
    InvalidAmount,
    ZeroAcceptablePrice,
    InvalidTriggerPrice,
    InvalidOrderType,
    CollateralExceedsBalance,
    LeverageTooHigh,
    PositionTooLarge,
    ExposureTooHigh,
    MarketOpenInterestCap,
    NoFreeSlot,
    TooManyOrders,
    NoPosition,
    OrderNotTracked,
    OrderNotPending,
    OrderPending,
    InvalidOrderAccount,
    InvalidPositionAccount,
    InvalidRemainingAccounts,
    NotFlat,
    NoProfit,
    BelowMinPayout,
    InvalidPayoutStatus,
    BalanceChanged,
    OwnerFloatSufficient,
    MathOverflow,
    TierChanged,
    DailyPrincipalLimit,
}

/// A program error as the u64 the entrypoint returns: `code` for Anchor/VaultError codes (`Custom(code)`), `n << 32`
/// for runtime errors (`ProgramError`). Never 0, so `Result<()>` fits one register.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Error(NonZeroU64);

pub type Result<T = ()> = core::result::Result<T, Error>;

impl Error {
    pub const INVALID_ACCOUNT_DATA: Error = Error::builtin(4);
    pub const UNINITIALIZED_ACCOUNT: Error = Error::builtin(10);
    pub const NOT_ENOUGH_ACCOUNT_KEYS: Error = Error::builtin(11);
    pub const UNSUPPORTED_SYSVAR: Error = Error::builtin(17);

    const fn builtin(n: u64) -> Error {
        Error(NonZeroU64::new(n << 32).unwrap())
    }

    /// The value the entrypoint returns.
    pub fn code(self) -> u64 {
        self.0.get()
    }
}

impl From<E> for Error {
    #[inline(always)]
    fn from(e: E) -> Self {
        // SAFETY: every E is at least 101.
        Error(unsafe { NonZeroU64::new_unchecked(e as u64) })
    }
}

impl From<ProgramError> for Error {
    fn from(e: ProgramError) -> Self {
        Error(NonZeroU64::new(u64::from(e)).unwrap_or(NonZeroU64::MIN))
    }
}

/// `require!(cond, e)`.
#[inline(always)]
pub fn require(cond: bool, e: E) -> Result {
    if cond {
        Ok(())
    } else {
        Err(e.into())
    }
}

/// (key, name, message) of every error this program raises. key = the Anchor code, or `n << 24` for the runtime error
/// `n << 32` (its ProgramError Debug name and Display message).
const TEXT: [(u32, &str, &str); 76] = [
    (101, "InstructionFallbackNotFound", "Fallback functions are not supported"),
    (102, "InstructionDidNotDeserialize", "The program could not deserialize the given instruction"),
    (1000, "IdlInstructionStub", "The program was compiled without idl instructions"),
    (2000, "ConstraintMut", "A mut constraint was violated"),
    (2001, "ConstraintHasOne", "A has one constraint was violated"),
    (2002, "ConstraintSigner", "A signer constraint was violated"),
    (2003, "ConstraintRaw", "A raw constraint was violated"),
    (2004, "ConstraintOwner", "An owner constraint was violated"),
    (2005, "ConstraintRentExempt", "A rent exemption constraint was violated"),
    (2006, "ConstraintSeeds", "A seeds constraint was violated"),
    (2009, "ConstraintAssociated", "An associated constraint was violated"),
    (2012, "ConstraintAddress", "An address constraint was violated"),
    (2014, "ConstraintTokenMint", "A token mint constraint was violated"),
    (2015, "ConstraintTokenOwner", "A token owner constraint was violated"),
    (2019, "ConstraintSpace", "A space constraint was violated"),
    (
        2023,
        "ConstraintAssociatedTokenTokenProgram",
        "An associated token account token program constraint was violated",
    ),
    (3001, "AccountDiscriminatorNotFound", "No discriminator was found on the account"),
    (3002, "AccountDiscriminatorMismatch", "Account discriminator did not match what was expected"),
    (3003, "AccountDidNotDeserialize", "Failed to deserialize the account"),
    (3004, "AccountDidNotSerialize", "Failed to serialize the account"),
    (3005, "AccountNotEnoughKeys", "Not enough account keys given to the instruction"),
    (3007, "AccountOwnedByWrongProgram", "The given account is owned by a different program than expected"),
    (3008, "InvalidProgramId", "Program ID was not as expected"),
    (3009, "InvalidProgramExecutable", "Program account is not executable"),
    (3010, "AccountNotSigner", "The given account did not sign"),
    (3011, "AccountNotSystemOwned", "The given account is not owned by the system program"),
    (3012, "AccountNotInitialized", "The program expected this account to be already initialized"),
    (3013, "AccountNotProgramData", "The given account is not a program data account"),
    (3014, "AccountNotAssociatedTokenAccount", "The given account is not the associated token account"),
    (4100, "DeclaredProgramIdMismatch", "The declared program id does not match the actual program id"),
    (
        4101,
        "TryingToInitPayerAsProgramAccount",
        "You cannot/should not initialize the payer account as a program account",
    ),
    (6000, "NotUpgradeAuthority", "Signer is not the program's upgrade authority"),
    (6001, "Unauthorized", "Signer is not allowed to perform this action"),
    (6002, "InvalidParams", "Invalid parameters"),
    (6003, "TooManyRiskAuthorities", "Too many risk authorities"),
    (6004, "Paused", "This action is paused"),
    (6005, "TierDisabled", "Tier is disabled"),
    (6006, "MarketNotPure", "GMTrade market is not a pure USDC-USDC market of the pinned store"),
    (6007, "MarketMismatch", "Account does not match the market"),
    (6008, "MarketDisabled", "Market is not enabled for funded trading"),
    (6009, "InvalidEvaluationStatus", "Evaluation status does not allow this action"),
    (6010, "InvalidAccountStatus", "Funded account status does not allow this action"),
    (6011, "NotVerified", "Trader identity is not verified"),
    (6012, "AlreadyVerified", "Trader identity is already set"),
    (6013, "AlreadyFunded", "Trader already has an active funded account"),
    (6014, "InsufficientCapital", "Not enough unallocated capital"),
    (6015, "InvalidAmount", "Invalid amount"),
    (6016, "ZeroAcceptablePrice", "Acceptable price must be set"),
    (6017, "InvalidTriggerPrice", "Trigger price is required for this order type and not allowed otherwise"),
    (6018, "InvalidOrderType", "Order type not allowed here"),
    (6019, "CollateralExceedsBalance", "Collateral exceeds the account's available USDC"),
    (6020, "LeverageTooHigh", "Leverage above the market limit"),
    (6021, "PositionTooLarge", "Position size above the market limit"),
    (6022, "ExposureTooHigh", "Total exposure above the account limit"),
    (6023, "MarketOpenInterestCap", "Funded open interest cap reached for this market side"),
    (6024, "NoFreeSlot", "All position slots are in use"),
    (6025, "TooManyOrders", "Too many open orders"),
    (6026, "NoPosition", "No position in this market and side"),
    (6027, "OrderNotTracked", "Order is not tracked by this account"),
    (6028, "OrderNotPending", "Order is no longer pending; close it with close_completed_order"),
    (6029, "OrderPending", "Order is still pending"),
    (6030, "InvalidOrderAccount", "Invalid GMTrade order account"),
    (6031, "InvalidPositionAccount", "Invalid GMTrade position account"),
    (6032, "InvalidRemainingAccounts", "Remaining accounts do not match the account state"),
    (6033, "NotFlat", "Account has open positions or orders"),
    (6034, "NoProfit", "No realized profit"),
    (6035, "BelowMinPayout", "Trader share below the minimum payout"),
    (6036, "InvalidPayoutStatus", "Payout status does not allow this action"),
    (6037, "BalanceChanged", "Account balance dropped since the payout request"),
    (6038, "OwnerFloatSufficient", "Owner SOL float is above the minimum"),
    (6039, "MathOverflow", "Arithmetic overflow"),
    (6040, "TierChanged", "The tier's fee or terms changed since they were reviewed"),
    (6041, "DailyPrincipalLimit", "Funded activations reached the vault's daily limit; try again later"),
    (4 << 24, "InvalidAccountData", "An account's data contents was invalid"),
    (10 << 24, "UninitializedAccount", "An attempt to operate on an account that hasn't been initialized"),
    (11 << 24, "NotEnoughAccountKeys", "The instruction expected additional account keys"),
];

// Names and messages live in one byte blob indexed by a table of plain integers: no pointer (and so no relocation) per
// entry and no code per error. `UnsupportedSysvar` (a failed sysvar read) is not in the table and logs nothing.
const BLOB_LEN: usize = {
    let (mut i, mut n) = (0, 0);
    while i < TEXT.len() {
        n += TEXT[i].1.len() + TEXT[i].2.len();
        i += 1;
    }
    n
};
/// Per entry: key, start in BLOB, name length, message length.
static INDEX: [(u32, u16, u8, u8); TEXT.len()] = {
    let mut t = [(0u32, 0u16, 0u8, 0u8); TEXT.len()];
    let (mut i, mut at) = (0, 0);
    while i < TEXT.len() {
        let (key, name, msg) = TEXT[i];
        t[i] = (key, at as u16, name.len() as u8, msg.len() as u8);
        at += name.len() + msg.len();
        i += 1;
    }
    t
};
static BLOB: [u8; BLOB_LEN] = {
    let mut b = [0u8; BLOB_LEN];
    let (mut i, mut at) = (0, 0);
    while i < TEXT.len() {
        let text = [TEXT[i].1.as_bytes(), TEXT[i].2.as_bytes()];
        let mut k = 0;
        while k < 2 {
            let mut j = 0;
            while j < text[k].len() {
                b[at] = text[k][j];
                at += 1;
                j += 1;
            }
            k += 1;
        }
        i += 1;
    }
    b
};

/// Logs `e` as Anchor's `AnchorError::log` (`ProgramErrorWithOrigin::log` for a runtime error) does for an error
/// without origin.
// ponytail: no "caused by account: <name>" / "thrown in <file>:<line>" origin and no Left/Right lines; nothing parses
// them. Add the origin if an operator needs it (it costs a name string per account).
#[cold]
#[inline(never)]
pub fn log(e: Error) {
    let code = e.code();
    let (key, kind): (u32, &[u8]) =
        if code >> 32 == 0 { (code as u32, b"AnchorError") } else { ((code >> 8) as u32, b"ProgramError") };
    let Some(&(_, at, name_len, msg_len)) = INDEX.iter().find(|t| t.0 == key) else { return };
    let (at, name_end) = (at as usize, at as usize + name_len as usize);
    let (name, msg) = (&BLOB[at..name_end], &BLOB[name_end..name_end + msg_len as usize]);
    let mut digits = [0u8; 20];
    let (mut v, mut i) = (code, digits.len());
    loop {
        i -= 1;
        digits[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if v == 0 {
            break;
        }
    }
    let mut buf = [0u8; 256];
    let mut n = 0;
    for part in
        [kind, b" occurred. Error Code: ", name, b". Error Number: ", &digits[i..], b". Error Message: ", msg, b"."]
    {
        buf[n..n + part.len()].copy_from_slice(part);
        n += part.len();
    }
    crate::log(&buf[..n]);
}
