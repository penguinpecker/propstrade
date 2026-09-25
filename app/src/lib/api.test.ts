import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from './api';

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockReset());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api client', () => {
  it('sends the session cookie and a JSON body', async () => {
    fetchMock.mockResolvedValue(json(200, { message: 'm', nonce: 'n', expiresAt: 1 }));
    await api.nonce('Wallet111');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/v1/auth/nonce');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: '{"wallet":"Wallet111"}' });
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('encodes path segments and omits unset query parameters', async () => {
    fetchMock.mockImplementation(async () => json(200, []));
    await api.positions('practice:Wallet/1');
    await api.candles('BTC', '15m');
    await api.marketTrades('XAU');
    await api.quote('BTC', 'Short', '2500.5');
    await api.payoutEligibility('Funded/1');
    await api.trader('Wallet/1');
    await api.referralCode('AB/CD');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/v1/accounts/practice%3AWallet%2F1/positions',
      '/v1/candles?symbol=BTC&interval=15m',
      '/v1/markets/XAU/trades',
      '/v1/quote?symbol=BTC&side=Short&sizeUsd=2500.5',
      '/v1/accounts/Funded%2F1/payout-eligibility',
      '/v1/traders/Wallet%2F1',
      '/v1/referrals/AB%2FCD',
    ]);
  });

  it('turns the contract error body into an ApiRequestError', async () => {
    fetchMock.mockResolvedValue(json(401, { error: { code: 'unauthorized', message: 'Sign in required' } }));
    const error = await api.me().catch(e => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized', message: 'Sign in required' });
  });

  it('keeps a readable error when the body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(api.config()).rejects.toMatchObject({ status: 502, code: 'http_502' });
  });

  it('reports an unreachable service as status 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api.vault()).rejects.toMatchObject({ status: 0, code: 'unreachable' });
  });

  it('turns a 200 non-JSON body (SPA fallback, proxy or challenge page) into an ApiRequestError', async () => {
    fetchMock.mockResolvedValue(new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const error = await api.me().catch(e => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 200, code: 'bad_response', message: 'The Props.trade service sent an unexpected response.' });
  });

  it('sends the KYC residence and the notification ids the server expects', async () => {
    fetchMock.mockImplementation(async () => json(200, {}));
    await api.startKyc({ country: 'DE' });
    await api.startKyc({ country: 'UA', region: 'UA-30' });
    await api.readNotifications(['n1']);
    await api.readNotifications();
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.body])).toEqual([
      ['/v1/kyc/start', '{"country":"DE"}'],
      ['/v1/kyc/start', '{"country":"UA","region":"UA-30"}'],
      ['/v1/notifications/read', '{"ids":["n1"]}'],
      ['/v1/notifications/read', '{}'],
    ]);
  });

  it('resolves bodiless responses to undefined', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    await expect(api.logout()).resolves.toBeUndefined();
    await expect(api.logout()).resolves.toBeUndefined();
  });
});
