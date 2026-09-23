// /v1/sim/* and /v1/practice/* (api.ts). Every route needs a signed-in wallet and reaches only that wallet's accounts.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, parse } from '../../errors.ts';
import type { Engine } from './engine.ts';
import type { createReader } from './read.ts';

const money = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'a decimal amount with at most 6 decimal places');
const price = z.string().regex(/^\d{1,15}(\.\d{1,18})?$/, 'a decimal price');
// Client ids never contain ":", which the engine uses for the ids of orders it derives.
const clientId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, '1-64 letters, digits, "-" or "_"');
const slippageBps = z.int().min(0).max(500);

const OrderBody = z.object({
  clientId, symbol: z.string().regex(/^[A-Za-z0-9]{1,16}$/), side: z.enum(['Long', 'Short']), kind: z.enum(['Market', 'Limit']),
  sizeUsd: money, collateralUsd: money, triggerPrice: price.optional(), slippageBps,
  takeProfit: price.optional(), stopLoss: price.optional(),
}).refine((b) => (b.kind === 'Limit') === (b.triggerPrice !== undefined), { path: ['triggerPrice'], message: 'required for Limit orders only' });
const CloseBody = z.object({ clientId, percent: z.number().min(1).max(100), slippageBps });
const ProtectionBody = z.object({ takeProfit: price.nullable(), stopLoss: price.nullable() });
const AccountParams = z.object({ id: z.string().min(1).max(128) });
const OrderParams = AccountParams.extend({ orderId: z.uuid() });
const PositionParams = AccountParams.extend({ positionId: z.uuid() });

const walletOf = (req: FastifyRequest): string => {
  if (!req.wallet) throw new ApiError(401, 'unauthorized', 'Sign in with your wallet first');
  return req.wallet;
};

export function registerRoutes(app: FastifyInstance, engine: Engine, reader: ReturnType<typeof createReader>) {
  const auth = { preHandler: app.requireWallet };

  app.post('/v1/sim/:id/orders', auth, async (req) => {
    const { id } = parse(AccountParams, req.params);
    return engine.placeOrder(walletOf(req), id, parse(OrderBody, req.body));
  });
  app.delete('/v1/sim/:id/orders/:orderId', auth, async (req) => {
    const { id, orderId } = parse(OrderParams, req.params);
    return engine.cancelOrder(walletOf(req), id, orderId);
  });
  app.post('/v1/sim/:id/positions/:positionId/close', auth, async (req) => {
    const { id, positionId } = parse(PositionParams, req.params);
    return engine.closePosition(walletOf(req), id, positionId, parse(CloseBody, req.body));
  });
  app.put('/v1/sim/:id/positions/:positionId/protection', auth, async (req) => {
    const { id, positionId } = parse(PositionParams, req.params);
    return engine.setProtection(walletOf(req), id, positionId, parse(ProtectionBody, req.body));
  });
  app.get('/v1/sim/:id/fills', auth, async (req) => {
    const fills = await reader.fills(walletOf(req), parse(AccountParams, req.params).id);
    if (!fills) throw new ApiError(404, 'not_found', 'Account not found');
    return fills;
  });
  app.post('/v1/practice/reset', auth, async (req) => engine.resetPractice(walletOf(req)));
}
