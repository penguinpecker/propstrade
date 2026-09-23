// Onchain facts the indexer needs beyond the events themselves, read through @props/sdk and cached where immutable.
import { PublicKey, type Connection } from '@solana/web3.js';
import { PropsVaultClient, decodeGmMarketMeta, fromMicro, gmMarketPda, marketConfigPda } from '@props/sdk';
import { formatFixed, parseFixed, USD_DECIMALS } from '@props/gmtrade';
import type { EvaluationTerms } from '../types.ts';

export interface EvaluationInfo { index: number; tierVersion: number; terms: EvaluationTerms }
/** A GMTrade market as props_vault trades it: symbol from its MarketConfig, decimals from its index token mint. */
export interface MarketInfo { marketToken: string; symbol: string; indexToken: string; decimals: number }

export interface ChainReader {
  evaluation(address: string): Promise<EvaluationInfo>;
  market(marketToken: string): Promise<MarketInfo>;
}

const SPL_MINT_DECIMALS_OFFSET = 44;
export const hex = (bytes: Uint8Array | number[]) => Buffer.from(bytes).toString('hex');

export function createReader(client: PropsVaultClient, rpc: Connection): ChainReader {
  const markets = new Map<string, Promise<MarketInfo>>();

  async function readMarket(marketToken: string): Promise<MarketInfo> {
    const token = new PublicKey(marketToken);
    const config = await client.fetch('marketConfig', marketConfigPda(token));
    if (!config) throw new Error(`market ${marketToken} has no MarketConfig`);
    const market = await rpc.getAccountInfo(gmMarketPda(token));
    if (!market) throw new Error(`GMTrade market ${marketToken} not found`);
    const { indexToken } = decodeGmMarketMeta(market.data);
    const mint = await rpc.getAccountInfo(indexToken);
    if (!mint || mint.data.length <= SPL_MINT_DECIMALS_OFFSET) throw new Error(`index token ${indexToken.toBase58()} is not a mint`);
    const symbol = Buffer.from(config.indexSymbol).toString('utf8').replace(/\0+$/, '');
    return { marketToken, symbol, indexToken: indexToken.toBase58(), decimals: mint.data[SPL_MINT_DECIMALS_OFFSET]! };
  }

  return {
    async evaluation(address) {
      const e = await client.fetch('evaluation', new PublicKey(address));
      if (!e) throw new Error(`evaluation ${address} not found`);
      return {
        index: e.index,
        tierVersion: e.terms.tierVersion,
        terms: {
          tierId: e.tierId,
          sizeUsd: fromMicro(BigInt(e.terms.sizeUsd.toString())),
          profitTargetBps: e.terms.profitTargetBps,
          maxDrawdownBps: e.terms.maxDrawdownBps,
          maxExposureBps: e.terms.maxExposureBps,
          traderShareBps: e.terms.traderShareBps,
          termsHash: hex(e.terms.termsHash),
        },
      };
    },
    market(marketToken) {
      let info = markets.get(marketToken);
      if (!info) {
        info = readMarket(marketToken);
        info.catch(() => markets.delete(marketToken)); // retry a failed read next time
        markets.set(marketToken, info);
      }
      return info;
    },
  };
}

/** GMTrade USD (1e20) → API decimal with at most 6 dp. */
export const gmUsd = (v: bigint | string) => formatFixed(BigInt(v), USD_DECIMALS, 6);
/** USDC / micro-USD base units → decimal. */
export const micro = (v: bigint | string) => fromMicro(BigInt(v));
/** GMTrade unit price (USD × 10^(20 − decimals)) → USD per whole token, exact. */
export const unitPrice = (v: bigint | string, decimals: number) => formatFixed(BigInt(v), USD_DECIMALS - decimals, 18);
/**
 * An order's price bound in USD per token, or null for a bound beyond any real price: traders may send u128::MAX as
 * "no limit", which numeric(38,18) cannot hold (≥ $10^20).
 */
export const orderPrice = (v: bigint | string, decimals: number) =>
  BigInt(v) >= 10n ** BigInt(2 * USD_DECIMALS - decimals) ? null : unitPrice(v, decimals);
/** Token base units → whole tokens, exact. */
export const tokenAmount = (v: bigint | string, decimals: number) => formatFixed(BigInt(v), decimals, 18);
/** A numeric(38,6) value as Postgres returns it ("500.000000") → micro units. */
export const toMicro6 = (v: string) => parseFixed(v, 6);
/** A numeric(38,6) value as Postgres returns it → API decimal ("500"). */
export const dec = (v: string) => formatFixed(parseFixed(v, 6), 6, 6);
/** A numeric(38,18) price as Postgres returns it → API decimal. */
export const decPrice = (v: string) => formatFixed(parseFixed(v, 18), 18, 18);
/** "10000" → "10K", "2500" → "2.5K", "1000000" → "1M". */
export function sizeName(sizeUsd: string): string {
  const n = Number(sizeUsd);
  if (n >= 1e6) return `${n / 1e6}M`;
  if (n >= 1e3) return `${n / 1e3}K`;
  return String(n);
}
