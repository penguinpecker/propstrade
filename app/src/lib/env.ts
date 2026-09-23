import type { AppConfig } from '@props/shared';

export type Cluster = AppConfig['cluster'];

// The public mainnet endpoint answers 403 to browser requests (any Origin header), so mainnet has no default RPC.
// Every local validator creates its own genesis, so localnet has no fixed genesis hash to compare against.
const CLUSTERS: Record<Cluster, { rpcUrl: string | null; genesisHash: string | null }> = {
  'mainnet-beta': { rpcUrl: null, genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' },
  localnet: { rpcUrl: 'http://127.0.0.1:8899', genesisHash: null },
};

function parseCluster(value: string | undefined): Cluster {
  if (!value) return 'mainnet-beta';
  if (value in CLUSTERS) return value as Cluster;
  throw new Error(`VITE_CLUSTER must be one of: ${Object.keys(CLUSTERS).join(', ')}`);
}

const vars = import.meta.env;
const cluster = parseCluster(vars.VITE_CLUSTER);

export const env = {
  cluster,
  apiUrl: (vars.VITE_API_URL ?? '').replace(/\/+$/, ''),
  /** null only when VITE_RPC_URL is missing on mainnet: builds fail then (vite.config.js), and main.jsx refuses to start. */
  rpcUrl: vars.VITE_RPC_URL || CLUSTERS[cluster].rpcUrl,
  programId: vars.VITE_PROGRAM_ID || null,
  genesisHash: CLUSTERS[cluster].genesisHash,
};
