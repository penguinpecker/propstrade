// Props.trade's fee per order: one rate for every stage (docs/design/order-fee.md §9). Before the program is live the
// server's settings (ORDER_FEE_USDC / ORDER_FEE_BPS) set it for practice and evaluation; once the onchain Config exists
// the chain module's reader is the only source, so a simulated fee and a funded one are always the same number.
import { toMicro, type OrderFeeRate } from '@props/sdk';
import type { Config } from '../config.ts';
import type { Services } from '../modules/types.ts';

export interface OrderFeeRateInfo extends OrderFeeRate {
  source: 'program' | 'server';
}

export const serverOrderFeeRate = (c: Pick<Config, 'ORDER_FEE_USDC' | 'ORDER_FEE_BPS'>): OrderFeeRateInfo =>
  ({ feeUsdc: toMicro(c.ORDER_FEE_USDC), feeBps: c.ORDER_FEE_BPS, source: 'server' });

/** The rate orders are assessed at now: the chain module's (program, else the server's settings), or the settings alone. */
export const orderFeeRateOf = (ctx: { services: Services; config: Pick<Config, 'ORDER_FEE_USDC' | 'ORDER_FEE_BPS'> }): Promise<OrderFeeRateInfo> =>
  ctx.services.chain?.orderFeeRate() ?? Promise.resolve(serverOrderFeeRate(ctx.config));
