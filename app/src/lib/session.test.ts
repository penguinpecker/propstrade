import { describe, expect, it } from 'vitest';
import { WalletConnectionError, WalletNotReadyError, WalletSignMessageError } from '@solana/wallet-adapter-base';
import { ApiRequestError } from './api';
import { buildSiwsMessage, SIWS_STATEMENT } from '@props/shared/siws';
import { checkNetwork, describeError, signInMessageProblem } from './session';

const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const expected = { cluster: 'mainnet-beta' as const, genesisHash: MAINNET, programId: 'Prog111' };
const config = { cluster: 'mainnet-beta' as const, programId: 'Prog111' };

describe('checkNetwork', () => {
  it('passes when the RPC genesis and the API deployment match', () => {
    expect(checkNetwork(expected, MAINNET, config)).toEqual({ state: 'ok' });
  });
  it('flags an RPC on another cluster', () => {
    expect(checkNetwork(expected, DEVNET, config)).toMatchObject({ state: 'wrong', reason: expect.stringContaining('Solana mainnet') });
  });
  it('flags an API on another cluster or program', () => {
    expect(checkNetwork(expected, MAINNET, { ...config, cluster: 'localnet' }).state).toBe('wrong');
    expect(checkNetwork(expected, MAINNET, { ...config, programId: 'Other111' }).state).toBe('wrong');
  });
  it('waits for both answers before calling it ok', () => {
    expect(checkNetwork(expected, undefined, config).state).toBe('checking');
    expect(checkNetwork(expected, MAINNET, undefined).state).toBe('checking');
  });
  it('warns without blocking when the RPC does not answer', () => {
    expect(checkNetwork(expected, undefined, config, true).state).toBe('unreachable');
    expect(checkNetwork(expected, DEVNET, config, true).state).toBe('wrong');
  });
  it('skips the genesis comparison on localnet', () => {
    expect(checkNetwork({ cluster: 'localnet', genesisHash: null, programId: null }, undefined, { ...config, cluster: 'localnet' }).state).toBe('ok');
  });
});

describe('describeError', () => {
  it('recognises a declined wallet request', () => {
    expect(describeError(new WalletSignMessageError('User rejected the request.'))).toBe('The request was declined in your wallet.');
    expect(describeError(new WalletConnectionError('', { code: 4001 }))).toBe('The request was declined in your wallet.');
  });
  it('explains a missing wallet and passes other messages through', () => {
    expect(describeError(new WalletNotReadyError())).toBe('This wallet is not available in this browser.');
    expect(describeError(new ApiRequestError(0, 'unreachable', 'The Props.trade service could not be reached.'))).toBe('The Props.trade service could not be reached.');
    expect(describeError(new WalletConnectionError(''))).toBe('Your wallet reported an error. Try again.');
  });
});

describe('signInMessageProblem', () => {
  const address = '9Kq3Wb8kZ4wP1t6x2m3Q4rS5T6u7V8w9X1y2Z3a4B5c';
  const site = { address, host: 'props.trade', origin: 'https://props.trade', cluster: 'mainnet-beta' as const };
  const fields = { domain: 'props.trade', address, statement: SIWS_STATEMENT, uri: 'https://props.trade', chainId: 'mainnet' as const, nonce: '5f3c9a1e', issuedAt: new Date(1_790_000_000_000), expirationTime: new Date(1_790_000_300_000) };

  it('accepts exactly the message the server builds for this site, wallet and cluster', () => {
    expect(signInMessageProblem(buildSiwsMessage(fields), site)).toBeNull();
    expect(signInMessageProblem(buildSiwsMessage({ ...fields, domain: '127.0.0.1:4187', uri: 'http://127.0.0.1:4187', chainId: 'localnet' }),
      { address, host: '127.0.0.1:4187', origin: 'http://127.0.0.1:4187', cluster: 'localnet' })).toBeNull();
  });

  it('refuses a message for another site, wallet, cluster or statement, and anything malformed', () => {
    for (const other of [
      buildSiwsMessage({ ...fields, domain: 'other-dapp.example', uri: 'https://other-dapp.example' }),
      buildSiwsMessage({ ...fields, uri: 'https://other-dapp.example' }),
      buildSiwsMessage({ ...fields, address: 'Other1111111111111111111111111111111111111' }),
      buildSiwsMessage({ ...fields, chainId: 'localnet' }),
      buildSiwsMessage({ ...fields, statement: 'Sign in to Other Dapp.' }),
      `${buildSiwsMessage(fields)}\nResources:\n- https://other-dapp.example`,
      buildSiwsMessage(fields).replace('Issued At: 2026', 'Issued At: not a date'),
      `props.trade wants you to sign in with your Solana account:\n${address}`,
    ]) expect(signInMessageProblem(other, site)).toBe('The sign-in message is not for this site or network, so it was not signed.');
  });
});
