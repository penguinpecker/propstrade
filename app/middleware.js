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

export default function middleware(request) {
  const { country, countryRegion } = geolocation(request);
  if (!isBlocked(country, countryRegion)) return next();
  return new Response(PAGE, {
    status: 451,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
