import { geolocation, next } from '@vercel/functions';

// First filter only: the binding gate is the country on the KYC record (spec §1 "Geo"). VPNs defeat IP checks.
// US persons: Regulation S "United States" includes its territories and possessions.
// Comprehensive sanctions: Cuba, Iran, North Korea, Syria.
const BLOCKED_COUNTRIES = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'CU', 'IR', 'KP', 'SY']);
// ISO 3166-2 regions of Ukraine under comprehensive sanctions: Crimea, Sevastopol, Donetsk, Luhansk.
const BLOCKED_REGIONS = new Set(['UA-43', 'UA-40', 'UA-14', 'UA-09']);

function isBlocked(country, region) {
  return BLOCKED_COUNTRIES.has(country) || BLOCKED_REGIONS.has(`${country}-${region}`);
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Props.trade is not available in your region</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#131217;color:#e9e5ee;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:460px;padding:24px}h1{font-size:22px;letter-spacing:-.02em;margin:0 0 12px}p{color:#afa6bc;margin:0 0 10px}</style>
</head><body><main><h1>Props.trade is not available in your region.</h1>
<p>Props.trade does not serve US persons or people in comprehensively sanctioned countries and regions.</p>
<p>Using a VPN or proxy to get around this restriction breaks the terms of use.</p></main></body></html>`;

// sha256 of the theme script inlined in index.html (tests/middleware.test.js recomputes it from the file).
const THEME_SCRIPT = "'sha256-cIq7amUUoAf38oOWuEps9aITCcu+zh9DNaxAgtUDGbw='";
// Localnet builds only: mainnet builds refuse to build without VITE_RPC_URL (vite.config.js), as src/lib/env.ts does.
const LOCALNET_RPC = 'http://127.0.0.1:8899';

/**
 * The app's Content-Security-Policy, from the same variables the build inlined (Vercel gives a deployment's middleware the
 * values its build had). The browser talks only to the API and the Solana RPC — over HTTP(S), and over the websocket
 * @solana/web3.js derives from it (ws/wss, port + 1 when the URL names a port). On Android, the Solana Mobile Wallet Adapter
 * that @solana/wallet-adapter-react registers connects to the wallet app through a localhost websocket (after one
 * `fetch('http://localhost')` for Chrome's local-network permission) and styles its dialog with inline <style> and a
 * Google font; wallet icons are data: URIs. Everything else is the app's own files.
 */
export function contentSecurityPolicy(env) {
  const api = new URL(env.VITE_API_URL).origin;
  const rpcUrl = env.VITE_RPC_URL || LOCALNET_RPC;
  const rpc = new URL(rpcUrl);
  const port = /^[a-z]+:\/\/(?:\[[^\]]+\]|[^/?#:]+):(\d+)/i.exec(rpcUrl)?.[1];
  const ws = `${rpc.protocol === 'https:' ? 'wss:' : 'ws:'}//${rpc.hostname}${port ? `:${Number(port) + 1}` : ''}`;
  return [
    "default-src 'none'",
    `script-src 'self' ${THEME_SCRIPT}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src ${[...new Set([api, rpc.origin, ws])].join(' ')} ws://localhost:* http://localhost`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export default function middleware(request) {
  const { country, countryRegion } = geolocation(request);
  if (!isBlocked(country, countryRegion)) return next({ headers: { 'content-security-policy': contentSecurityPolicy(process.env) } });
  return new Response(PAGE, {
    status: 451,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
