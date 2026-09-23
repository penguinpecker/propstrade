import type {
  AccountDetail, AccountSummary, ActivityItem, ApiError, AppConfig, CandleInterval, CandlesResponse, ClosedTrade, Fill, KycStartRequest, Market,
  MarketTrade, Me, NonceResponse, Notification, Order, Payout, PayoutEligibility, Performance, Position, PriceImpactQuote, Pubkey,
  SimCloseRequest, SimOrderRequest, SimOrderResponse, SimProtectionRequest, VaultStats, VerifyRequest, VerifyResult,
} from '@props/shared';
import { env } from './env';

/** A failed API call. `status` 0 means the service could not be reached at all. */
export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export const isUnauthorized = (error: unknown) => error instanceof ApiRequestError && error.status === 401;

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(env.apiUrl + path, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(0, 'unreachable', 'The Props.trade service could not be reached.');
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as Partial<ApiError> | null;
    throw new ApiRequestError(
      response.status,
      payload?.error?.code ?? `http_${response.status}`,
      payload?.error?.message ?? `The request failed (HTTP ${response.status}).`,
    );
  }
  const text = await response.text(); // empty for 204 and for bodiless 200s
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch { // an HTML page from a proxy, a security challenge or a misrouted SPA fallback
    throw new ApiRequestError(response.status, 'bad_response', 'The Props.trade service sent an unexpected response.');
  }
}

const id = encodeURIComponent;
const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const api = {
  config: () => request<AppConfig>('GET', '/v1/config'),

  markets: () => request<Market[]>('GET', '/v1/markets'),
  market: (symbol: string) => request<Market>('GET', `/v1/markets/${id(symbol)}`),
  marketTrades: (symbol: string, limit?: number) => request<MarketTrade[]>('GET', `/v1/markets/${id(symbol)}/trades${query({ limit })}`),
  candles: (symbol: string, interval: CandleInterval, from?: number, to?: number) =>
    request<CandlesResponse>('GET', `/v1/candles${query({ symbol, interval, from, to })}`),
  quote: (symbol: string, side: 'Long' | 'Short', sizeUsd: string) =>
    request<PriceImpactQuote>('GET', `/v1/quote${query({ symbol, side, sizeUsd })}`),

  nonce: (wallet: Pubkey) => request<NonceResponse>('POST', '/v1/auth/nonce', { wallet }),
  /** Sets the session cookie. The body is not a profile: read that from /v1/me. */
  verify: (body: VerifyRequest) => request<unknown>('POST', '/v1/auth/verify', body),
  logout: () => request<void>('POST', '/v1/auth/logout'),
  me: () => request<Me>('GET', '/v1/me'),

  accounts: () => request<AccountSummary[]>('GET', '/v1/accounts'),
  account: (accountId: string) => request<AccountDetail>('GET', `/v1/accounts/${id(accountId)}`),
  positions: (accountId: string) => request<Position[]>('GET', `/v1/accounts/${id(accountId)}/positions`),
  orders: (accountId: string) => request<Order[]>('GET', `/v1/accounts/${id(accountId)}/orders`),
  history: (accountId: string) => request<ClosedTrade[]>('GET', `/v1/accounts/${id(accountId)}/history`),
  activity: (accountId: string) => request<ActivityItem[]>('GET', `/v1/accounts/${id(accountId)}/activity`),
  performance: (accountId: string, period: Performance['period']) =>
    request<Performance>('GET', `/v1/accounts/${id(accountId)}/performance${query({ period })}`),
  payoutEligibility: (accountId: string) => request<PayoutEligibility>('GET', `/v1/accounts/${id(accountId)}/payout-eligibility`),

  placeSimOrder: (accountId: string, body: SimOrderRequest) => request<SimOrderResponse>('POST', `/v1/sim/${id(accountId)}/orders`, body),
  cancelSimOrder: (accountId: string, orderId: string) =>
    request<SimOrderResponse>('DELETE', `/v1/sim/${id(accountId)}/orders/${id(orderId)}`),
  closeSimPosition: (accountId: string, positionId: string, body: SimCloseRequest) =>
    request<SimOrderResponse>('POST', `/v1/sim/${id(accountId)}/positions/${id(positionId)}/close`, body),
  setSimProtection: (accountId: string, positionId: string, body: SimProtectionRequest) =>
    request<Position>('PUT', `/v1/sim/${id(accountId)}/positions/${id(positionId)}/protection`, body),
  resetPractice: () => request<AccountSummary>('POST', '/v1/practice/reset'),

  payouts: () => request<Payout[]>('GET', '/v1/payouts'),
  payout: (payoutId: string) => request<Payout>('GET', `/v1/payouts/${id(payoutId)}`),

  verifyRecord: (q: string) => request<VerifyResult>('GET', `/v1/verify${query({ q })}`),
  vault: () => request<VaultStats>('GET', '/v1/vault'),

  /** The trader's residence (KycStartRequest): ISO 3166-1 alpha-2 country and, for Ukraine, the ISO 3166-2 region. */
  startKyc: (body: KycStartRequest) => request<{ kyc: Me['kyc'] }>('POST', '/v1/kyc/start', body),
  /** Every fill of a simulated account in trades-root order: the owner's, or anyone's once an evaluation's result is onchain. */
  fills: (accountId: string) => request<Fill[]>('GET', `/v1/sim/${id(accountId)}/fills`),

  notifications: () => request<Notification[]>('GET', '/v1/notifications'),
  /** Marks the given notifications read, or all of them when `ids` is omitted. */
  readNotifications: (ids?: string[]) => request<{ updated: number }>('POST', '/v1/notifications/read', { ids }),
};
