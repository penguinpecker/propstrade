// GMTrade mainnet (release v0.10.0). The HTTP/WS services are GMTrade's own, undocumented, no SLA.
export const STORE_PROGRAM = 'Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo';
export const STORE = 'CTDLvGGXnoxvqLyTpGzdGLg9pD6JexKxKXSV8tqqo8bN';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** The all-zero pubkey: "no account" in gmsol_store fields. */
export const NO_ACCOUNT = '11111111111111111111111111111111';

export const KEEPER_HTTP = 'https://keeper-prod-api.gmtrade.xyz/graphql';
export const KEEPER_WS = 'wss://keeper-prod-api.gmtrade.xyz/graphql-ws';
export const MARKET_INFO = 'https://market-info-mainnet-prod.gmtrade.xyz/api/v2/solana/pairs';
export const CANDLES = 'https://price-candle-mainnet.gmtrade.xyz/graphql';
export const SUBSQUID = 'https://gmx-solana-sqd.squids.live/gmx-solana-base:prod/api/graphql';
export const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

/** A feed (or an open market's price) with no update for this long is stale. */
export const STALE_AFTER_MS = 20_000;
