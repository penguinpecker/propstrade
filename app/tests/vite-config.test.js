import { describe, expect, it } from 'vitest';
import { checkBuildEnv } from '../vite.config.js';

const API = 'https://api.props.test';

describe('build environment check', () => {
  it('refuses a mainnet build without an RPC endpoint', () => {
    expect(() => checkBuildEnv({ VITE_API_URL: API })).toThrow('VITE_RPC_URL is required');
    expect(() => checkBuildEnv({ VITE_CLUSTER: 'mainnet-beta', VITE_API_URL: API, VITE_RPC_URL: '' })).toThrow('VITE_RPC_URL is required');
  });
  it('refuses a build without an API URL or with an unknown cluster', () => {
    expect(() => checkBuildEnv({ VITE_RPC_URL: 'https://rpc.test' })).toThrow('VITE_API_URL is required');
    expect(() => checkBuildEnv({ VITE_CLUSTER: 'devnet', VITE_API_URL: API })).toThrow('VITE_CLUSTER must be one of');
  });
  it('accepts complete mainnet and localnet settings', () => {
    expect(() => checkBuildEnv({ VITE_API_URL: API, VITE_RPC_URL: 'https://rpc.test' })).not.toThrow();
    expect(() => checkBuildEnv({ VITE_CLUSTER: 'localnet', VITE_API_URL: 'http://127.0.0.1:8080' })).not.toThrow();
  });
});
