import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerRpcRelay, rpcRefusal } from '../src/routes/rpc.js';

const GMTRADE = 'Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo';
const seen: { body: unknown; headers: IncomingHttpHeaders }[] = [];
let upstream: Server;
let upstreamUrl: string;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ body, headers: req.headers });
      const answer = (c: { id: unknown }) => ({ jsonrpc: '2.0', id: c.id, result: 'ok' });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/?api-key=secret`;
});
afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

async function relay(rpcUrl = upstreamUrl) {
  const app = Fastify();
  registerRpcRelay(app, { rpcUrl });
  await app.ready();
  return app;
}

describe('rpcRefusal', () => {
  it('relays exactly the reads and sends the app makes', () => {
    for (const method of ['getAccountInfo', 'getMultipleAccounts', 'getLatestBlockhash', 'getSignatureStatuses', 'getFeeForMessage', 'getGenesisHash']) {
      expect(rpcRefusal({ method, params: [] })).toBeNull();
    }
    expect(rpcRefusal({ method: 'sendTransaction', params: ['AQID'] })).toBeNull();
    expect(rpcRefusal({ method: 'requestAirdrop', params: [] })).toMatch(/not relayed/);
    expect(rpcRefusal({ method: 'getSignaturesForAddress', params: [] })).toMatch(/not relayed/);
    expect(rpcRefusal({ method: 'sendTransaction', params: ['A'.repeat(1645)] })).toBe('Transaction too large');
    expect(rpcRefusal({ params: [] })).toBe('Invalid request');
  });

  it('relays getProgramAccounts only for filtered GMTrade queries', () => {
    const filtered = { filters: [{ dataSize: 680 }, { memcmp: { offset: 56, bytes: 'x' } }] };
    expect(rpcRefusal({ method: 'getProgramAccounts', params: [GMTRADE, filtered] })).toBeNull();
    expect(rpcRefusal({ method: 'getProgramAccounts', params: [GMTRADE, { filters: [{ dataSize: 680 }] }] })).toMatch(/filtered exchange/);
    expect(rpcRefusal({ method: 'getProgramAccounts', params: [GMTRADE] })).toMatch(/filtered exchange/);
    expect(rpcRefusal({ method: 'getProgramAccounts', params: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', filtered] })).toMatch(/filtered exchange/);
  });
});

describe('POST /v1/rpc', () => {
  it('forwards the body only, never the caller headers, and is never cached', async () => {
    const app = await relay();
    const res = await app.inject({
      method: 'POST', url: '/v1/rpc',
      headers: { origin: 'https://app.props.test', cookie: '__Host-props_session=abc', 'solana-client': 'js/1.0' },
      payload: { jsonrpc: '2.0', id: 7, method: 'getSlot', params: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ jsonrpc: '2.0', id: 7, result: 'ok' });
    const last = seen.at(-1)!;
    expect(last.body).toEqual({ jsonrpc: '2.0', id: 7, method: 'getSlot', params: [] });
    expect([last.headers.origin, last.headers.cookie, last.headers['solana-client']]).toEqual([undefined, undefined, undefined]);
    await app.close();
  });

  it('refuses a whole batch when one call is not allowed, and sends nothing', async () => {
    const app = await relay();
    const before = seen.length;
    const res = await app.inject({ method: 'POST', url: '/v1/rpc', payload: [
      { jsonrpc: '2.0', id: 1, method: 'getSlot' },
      { jsonrpc: '2.0', id: 2, method: 'requestAirdrop', params: ['x', 1] },
    ] });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((e: { id: number; error: { code: number } }) => [e.id, e.error.code])).toEqual([[1, -32601], [2, -32601]]);
    expect(seen.length).toBe(before);
    await app.close();
  });

  it('rejects empty and oversized batches', async () => {
    const app = await relay();
    const call = { jsonrpc: '2.0', id: 1, method: 'getSlot' };
    expect((await app.inject({ method: 'POST', url: '/v1/rpc', payload: [] })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/rpc', payload: Array(11).fill(call) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/rpc', payload: Array(10).fill(call) })).statusCode).toBe(200);
    await app.close();
  });

  it('answers a JSON-RPC error, without the upstream URL, when the RPC is unreachable', async () => {
    const app = await relay('http://127.0.0.1:1/?api-key=secret');
    const res = await app.inject({ method: 'POST', url: '/v1/rpc', payload: { jsonrpc: '2.0', id: 3, method: 'getSlot' } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'The Solana RPC could not be reached' } });
    expect(res.body).not.toContain('secret');
    await app.close();
  });
});
