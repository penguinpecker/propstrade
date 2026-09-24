use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("Signer is not allowed to perform this action")]
    Unauthorized,
    #[msg("Invalid parameters")]
    InvalidParams,
    #[msg("Too many risk authorities")]
    TooManyRiskAuthorities,
    #[msg("This action is paused")]
    Paused,
    #[msg("Tier is disabled")]
    TierDisabled,
    #[msg("GMTrade market is not a pure USDC-USDC market of the pinned store")]
    MarketNotPure,
    #[msg("Account does not match the market")]
    MarketMismatch,
    #[msg("Market is not enabled for funded trading")]
    MarketDisabled,
    #[msg("Evaluation status does not allow this action")]
    InvalidEvaluationStatus,
    #[msg("Funded account status does not allow this action")]
    InvalidAccountStatus,
    #[msg("Trader identity is not verified")]
    NotVerified,
    #[msg("Trader identity is already set")]
    AlreadyVerified,
    #[msg("Trader already has an active funded account")]
    AlreadyFunded,
    #[msg("Not enough unallocated capital")]
    InsufficientCapital,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Acceptable price must be set")]
    ZeroAcceptablePrice,
    #[msg("Trigger price is required for this order type and not allowed otherwise")]
    InvalidTriggerPrice,
    #[msg("Order type not allowed here")]
    InvalidOrderType,
    #[msg("Collateral exceeds the account's available USDC")]
    CollateralExceedsBalance,
    #[msg("Leverage above the market limit")]
    LeverageTooHigh,
    #[msg("Position size above the market limit")]
    PositionTooLarge,
    #[msg("Total exposure above the account limit")]
    ExposureTooHigh,
    #[msg("Funded open interest cap reached for this market side")]
    MarketOpenInterestCap,
    #[msg("All position slots are in use")]
    NoFreeSlot,
    #[msg("Too many open orders")]
    TooManyOrders,
    #[msg("No position in this market and side")]
    NoPosition,
    #[msg("Order is not tracked by this account")]
    OrderNotTracked,
    #[msg("Order is no longer pending; close it with close_completed_order")]
    OrderNotPending,
    #[msg("Order is still pending")]
    OrderPending,
    #[msg("Invalid GMTrade order account")]
    InvalidOrderAccount,
    #[msg("Invalid GMTrade position account")]
    InvalidPositionAccount,
    #[msg("Remaining accounts do not match the account state")]
    InvalidRemainingAccounts,
    #[msg("Account has open positions or orders")]
    NotFlat,
    #[msg("No realized profit")]
    NoProfit,
    #[msg("Trader share below the minimum payout")]
    BelowMinPayout,
    #[msg("Payout status does not allow this action")]
    InvalidPayoutStatus,
    #[msg("Account balance dropped since the payout request")]
    BalanceChanged,
    #[msg("Owner SOL float is above the minimum")]
    OwnerFloatSufficient,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("The tier's fee or terms changed since they were reviewed")]
    TierChanged,
    #[msg("Funded activations reached the vault's daily limit; try again later")]
    DailyPrincipalLimit,
    #[msg("GMTrade changed the owner's USDC or SOL beyond what the call allows")]
    UnexpectedGmtradeEffect,
    #[msg("Not a GMTrade claimable account delegated to this account's owner")]
    NotClaimable,
}
