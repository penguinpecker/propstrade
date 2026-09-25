import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import App from './App.jsx';
import { env } from './lib/env';
import { GOOGLE_ONLY, WithPrivy } from './lib/privy';
import { createQueryClient } from './lib/queries';
import { captureReferral } from './lib/referral';
import './styles.css';
import './themes.css';
import './pages.css';

if (!env.rpcUrl) throw new Error('VITE_RPC_URL is required for mainnet builds (see app/.env.example).');
// A `?ref=` link's code waits in this browser for the sign-up; a link opened in a tab that already shows the app changes only the hash.
captureReferral();
addEventListener('hashchange', () => captureReferral());

const queryClient = createQueryClient();
// Wallet Standard wallets (Phantom, Solflare, Backpack, …) are detected automatically; no adapters are bundled.
const extraAdapters = [];
// useSession shows wallet errors in the interface; this replaces the provider's default console logging.
const ignoreWalletError = () => {};

createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={queryClient}>
    <ConnectionProvider endpoint={env.rpcUrl} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={extraAdapters} autoConnect={!GOOGLE_ONLY} onError={ignoreWalletError}>
        <WithPrivy>
          <App />
        </WithPrivy>
      </WalletProvider>
    </ConnectionProvider>
  </QueryClientProvider>,
);
