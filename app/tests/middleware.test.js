import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import middleware, { contentSecurityPolicy } from '../middleware.js';

const MAINNET = { VITE_API_URL: 'https://api.props.test', VITE_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=abc' };
const directives = csp => Object.fromEntries(csp.split('; ').map(d => { const [name, ...values] = d.split(' '); return [name, values]; }));

const visit = (country, region) => middleware(new Request('https://props.trade/', {
  headers: { ...(country && { 'x-vercel-ip-country': country }), ...(region && { 'x-vercel-ip-country-region': region }) },
}));

describe('geo middleware', () => {
  const saved = { ...process.env };
  beforeAll(() => Object.assign(process.env, MAINNET));
  afterAll(() => { for (const key of Object.keys(MAINNET)) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });

  it.each([['US'], ['PR'], ['IR'], ['KP'], ['CU'], ['SY'], ['UA', '43'], ['UA', '40'], ['UA', '14'], ['UA', '09']])(
    'returns 451 for %s %s', async (country, region) => {
      const response = visit(country, region);
      expect(response.status).toBe(451);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toContain('not available in your region');
    });

  it.each([['DE'], ['GB'], ['UA', '30'], [undefined]])('lets %s %s through with the content security policy', (country, region) => {
    const response = visit(country, region);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('content-security-policy')).toBe(contentSecurityPolicy(MAINNET));
  });
});

describe('content security policy', () => {
  it('allows exactly the API, the RPC over https and wss, the mobile wallet loopback, and the app itself', () => {
    expect(directives(contentSecurityPolicy(MAINNET))).toEqual({
      'default-src': ["'none'"],
      'script-src': ["'self'", expect.stringMatching(/^'sha256-/)],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:'],
      'connect-src': ['https://api.props.test', 'https://mainnet.helius-rpc.com', 'wss://mainnet.helius-rpc.com', 'ws://localhost:*', 'http://localhost'],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-ancestors': ["'none'"],
    });
  });

  it('puts the RPC websocket where @solana/web3.js opens it: one port up when the URL names one', () => {
    const connect = env => directives(contentSecurityPolicy(env))['connect-src'];
    expect(connect({ VITE_API_URL: 'http://127.0.0.1:8080', VITE_RPC_URL: 'http://127.0.0.1:8899' }))
      .toEqual(['http://127.0.0.1:8080', 'http://127.0.0.1:8899', 'ws://127.0.0.1:8900', 'ws://localhost:*', 'http://localhost']);
    // A localnet build has no VITE_RPC_URL: the local validator.
    expect(connect({ VITE_API_URL: 'http://127.0.0.1:8080' })).toContain('ws://127.0.0.1:8900');
    expect(connect({ VITE_API_URL: 'https://api.props.test', VITE_RPC_URL: 'https://rpc.props.test:8443/x' })).toContain('wss://rpc.props.test:8444');
    // An API that also serves the RPC is listed once.
    expect(connect({ VITE_API_URL: 'http://127.0.0.1:4000', VITE_RPC_URL: 'http://127.0.0.1:4000/rpc' }))
      .toEqual(['http://127.0.0.1:4000', 'ws://127.0.0.1:4001', 'ws://localhost:*', 'http://localhost']);
  });

  it('allows the inline scripts of index.html by hash, and no others', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, code]) => `'sha256-${createHash('sha256').update(code).digest('base64')}'`);
    expect(inline).toHaveLength(1);
    expect(directives(contentSecurityPolicy(MAINNET))['script-src']).toEqual(["'self'", ...inline]);
  });
});
