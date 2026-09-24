import { QueryCache, QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccountDetail, AccountSummary, CandleInterval, Market, Me, Notification, Order, Performance, Position, SimCloseRequest,
  SimOrderRequest, SimOrderResponse, SimProtectionRequest, StreamEvent,
} from '@props/shared';
import { api, ApiRequestError, isNotLive, isUnauthorized } from './api';

export const keys = {
  config: ['config'] as const,
  me: ['me'] as const,
  markets: ['markets'] as const,
  market: (symbol: string) => ['market', symbol] as const,
  marketTrades: (symbol: string) => ['market', symbol, 'trades'] as const,
  candles: (symbol: string, interval: CandleInterval) => ['candles', symbol, interval] as const,
  quote: (symbol: string, side: 'Long' | 'Short', sizeUsd: string) => ['quote', symbol, side, sizeUsd] as const,
  accounts: ['accounts'] as const,
  account: (id: string) => ['account', id] as const,
  positions: (id: string) => ['account', id, 'positions'] as const,
  orders: (id: string) => ['account', id, 'orders'] as const,
  history: (id: string) => ['account', id, 'history'] as const,
  activity: (id: string) => ['account', id, 'activity'] as const,
  performance: (id: string, period: Performance['period']) => ['account', id, 'performance', period] as const,
  eligibility: (id: string) => ['account', id, 'payout-eligibility'] as const,
  payouts: ['payouts'] as const,
  payout: (id: string) => ['payout', id] as const,
  verify: (q: string) => ['verify', q] as const,
  vault: ['vault'] as const,
  notifications: ['notifications'] as const,
};

/** Everything that belongs to the signed-in wallet; dropped on sign-out and account switch. */
const USER_SCOPED = [keys.accounts, ['account'], keys.payouts, ['payout'], keys.notifications];

export function clearUserData(client: QueryClient) {
  for (const queryKey of USER_SCOPED) client.removeQueries({ queryKey });
}

export function createQueryClient() {
  const client: QueryClient = new QueryClient({
    // Any 401 means the session cookie is gone: re-read /v1/me so the session state follows.
    queryCache: new QueryCache({ onError: error => { if (isUnauthorized(error)) void client.invalidateQueries({ queryKey: keys.me }); } }),
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        retry: (failures, error) => !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500) && !isNotLive(error) && failures < 3,
      },
    },
  });
  return client;
}

// ---------- reads ----------
export const useConfig = () => useQuery({ queryKey: keys.config, queryFn: api.config, staleTime: 60_000 });

/** The session's wallet profile; `null` when there is no valid session. */
export const meOptions = queryOptions({
  queryKey: keys.me,
  queryFn: (): Promise<Me | null> => api.me().catch(error => { if (isUnauthorized(error)) return null; throw error; }),
  staleTime: 0,
  refetchInterval: 60_000,
});
export const useMe = () => useQuery(meOptions);

export const useMarkets = () => useQuery({ queryKey: keys.markets, queryFn: api.markets });
export const useMarket = (symbol: string) => useQuery({ queryKey: keys.market(symbol), queryFn: () => api.market(symbol) });
export const useMarketTrades = (symbol: string) =>
  useQuery({ queryKey: keys.marketTrades(symbol), queryFn: () => api.marketTrades(symbol), enabled: symbol !== '', refetchInterval: 10_000 });
/**
 * Live ticks move the last candle between fetches (see Chart.jsx); the periodic refetch picks up GMTrade's own candles.
 * The trade page reads these from the saved symbol before the market catalog is in, and prefetches the watchlist's on
 * the same keys, so a watchlist click paints from memory.
 */
export const candlesOptions = (symbol: string, interval: CandleInterval) =>
  queryOptions({ queryKey: keys.candles(symbol, interval), queryFn: () => api.candles(symbol, interval), enabled: symbol !== '', refetchInterval: 60_000 });
export const useCandles = (symbol: string, interval: CandleInterval) => useQuery(candlesOptions(symbol, interval));
/**
 * Fees, price impact and execution price for an order size. While a new size loads, the previous size's quote stays
 * (same market and side only: another market's or side's figures are never shown for this one).
 */
export const useQuote = (symbol: string, side: 'Long' | 'Short', sizeUsd: string | null) => useQuery({
  queryKey: keys.quote(symbol, side, sizeUsd ?? ''),
  queryFn: () => api.quote(symbol, side, sizeUsd!),
  enabled: sizeUsd !== null,
  placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === symbol && previousQuery.queryKey[2] === side ? previous : undefined,
  staleTime: 5_000,
});

export const useAccounts = (enabled: boolean) => useQuery({ queryKey: keys.accounts, queryFn: api.accounts, enabled });
export const useAccount = (id: string | null) => useQuery({ queryKey: keys.account(id ?? ''), queryFn: () => api.account(id!), enabled: id !== null });
export const usePositions = (id: string | null) => useQuery({ queryKey: keys.positions(id ?? ''), queryFn: () => api.positions(id!), enabled: id !== null });
export const useOrders = (id: string | null) => useQuery({ queryKey: keys.orders(id ?? ''), queryFn: () => api.orders(id!), enabled: id !== null });
export const useHistory = (id: string | null) => useQuery({ queryKey: keys.history(id ?? ''), queryFn: () => api.history(id!), enabled: id !== null });
export const useActivity = (id: string | null) => useQuery({ queryKey: keys.activity(id ?? ''), queryFn: () => api.activity(id!), enabled: id !== null });
export const usePerformance = (id: string | null, period: Performance['period']) =>
  useQuery({ queryKey: keys.performance(id ?? '', period), queryFn: () => api.performance(id!, period), enabled: id !== null });

export const usePayoutEligibility = (id: string | null) =>
  useQuery({ queryKey: keys.eligibility(id ?? ''), queryFn: () => api.payoutEligibility(id!), enabled: id !== null });

export const usePayouts = (enabled: boolean) => useQuery({ queryKey: keys.payouts, queryFn: api.payouts, enabled });
export const usePayout = (id: string | null) => useQuery({ queryKey: keys.payout(id ?? ''), queryFn: () => api.payout(id!), enabled: id !== null });
export const useVerify = (q: string) => useQuery({ queryKey: keys.verify(q), queryFn: () => api.verifyRecord(q), enabled: q.trim() !== '' });
export const useVault = () => useQuery({ queryKey: keys.vault, queryFn: api.vault });

/** The signed-in wallet's notifications; the stream prepends new ones. */
export const useNotifications = (enabled: boolean) => useQuery({ queryKey: keys.notifications, queryFn: api.notifications, enabled });

/** Marks notifications read (all when `ids` is omitted) and reflects it in the loaded list. */
export function useReadNotifications() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) => api.readNotifications(ids),
    onSuccess: (_result, ids) => client.setQueryData<Notification[]>(keys.notifications, list =>
      list && list.map(n => (!ids || ids.includes(n.id) ? { ...n, read: true } : n))),
  });
}

// ---------- simulated trading writes ----------
function useSimMutation<Vars>(accountId: string, mutationFn: (vars: Vars) => Promise<SimOrderResponse>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: ({ account, order }) => {
      patchAccount(client, account);
      // The response is the order's current state: show it now rather than after the refetch.
      client.setQueryData<Order[]>(keys.orders(accountId), list => list && [...list.filter(o => o.id !== order.id), order]);
      void client.invalidateQueries({ queryKey: ['account', accountId] });
    },
  });
}

export const usePlaceSimOrder = (accountId: string) =>
  useSimMutation(accountId, (body: SimOrderRequest) => api.placeSimOrder(accountId, body));
export const useCancelSimOrder = (accountId: string) =>
  useSimMutation(accountId, (orderId: string) => api.cancelSimOrder(accountId, orderId));
export const useCloseSimPosition = (accountId: string) =>
  useSimMutation(accountId, ({ positionId, body }: { positionId: string; body: SimCloseRequest }) => api.closeSimPosition(accountId, positionId, body));

export function useSetSimProtection(accountId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ positionId, body }: { positionId: string; body: SimProtectionRequest }) => api.setSimProtection(accountId, positionId, body),
    onSuccess: position => patchList<Position>(client, keys.positions(accountId), [position]),
  });
}

export function useResetPractice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.resetPractice,
    onSuccess: account => {
      patchAccount(client, account);
      void client.invalidateQueries({ queryKey: ['account', account.id] });
    },
  });
}

export function useStartKyc() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.startKyc,
    onSuccess: ({ kyc }) => client.setQueryData<Me | null>(keys.me, me => me && { ...me, kyc }),
  });
}

// ---------- live updates ----------
function patchList<T extends { id: string }>(client: QueryClient, queryKey: readonly unknown[], items: T[]) {
  client.setQueryData<T[]>(queryKey, list => list && list.map(item => items.find(next => next.id === item.id) ?? item));
}

function patchAccount(client: QueryClient, account: AccountSummary) {
  client.setQueryData<AccountSummary[]>(keys.accounts, list =>
    list && (list.some(a => a.id === account.id) ? list.map(a => (a.id === account.id ? account : a)) : [...list, account]));
  client.setQueryData<AccountDetail>(keys.account(account.id), detail => detail && { ...detail, ...account });
}

function patchMarket(client: QueryClient, symbol: string, update: (market: Market) => Market) {
  client.setQueryData<Market[]>(keys.markets, list => list && list.map(m => (m.symbol === symbol ? update(m) : m)));
  client.setQueryData<Market>(keys.market(symbol), market => market && update(market));
}

/** Applies one server-sent event to the query cache. */
export function applyStreamEvent(client: QueryClient, event: StreamEvent) {
  switch (event.type) {
    case 'price':
      for (const tick of event.ticks) {
        patchMarket(client, tick.symbol, market =>
          market.updatedAt !== null && market.updatedAt > tick.ts
            ? market // older than what we already show
            : { ...market, price: tick.mid, session: tick.session, updatedAt: tick.ts, freshness: 'live' });
      }
      return;
    case 'market':
      patchMarket(client, event.market.symbol, () => event.market);
      return;
    case 'account':
      patchAccount(client, event.account);
      return;
    case 'positions': {
      const before = client.getQueryData<Position[]>(keys.positions(event.accountId));
      client.setQueryData<Position[]>(keys.positions(event.accountId), event.positions);
      client.setQueryData<AccountDetail>(keys.account(event.accountId), detail => detail && { ...detail, positions: event.positions });
      // A position that left the list was closed or liquidated: its round trip is new trade history.
      if (before?.some(p => !event.positions.some(next => next.id === p.id))) void client.invalidateQueries({ queryKey: keys.history(event.accountId) });
      return;
    }
    case 'orders':
      client.setQueryData<Order[]>(keys.orders(event.accountId), event.orders);
      client.setQueryData<AccountDetail>(keys.account(event.accountId), detail => detail && { ...detail, orders: event.orders });
      return;
    case 'notification':
      // Without a loaded list there is nothing to patch: the first fetch returns this notification too.
      client.setQueryData<Notification[]>(keys.notifications, list =>
        list && [event.notification, ...list.filter(n => n.id !== event.notification.id)].slice(0, 100));
      // Account and payout notices follow changes /v1/me reports: identity review, wallet balances.
      if (event.notification.kind === 'account' || event.notification.kind === 'payout') void client.invalidateQueries({ queryKey: keys.me });
      return;
    case 'heartbeat':
      return;
  }
}
