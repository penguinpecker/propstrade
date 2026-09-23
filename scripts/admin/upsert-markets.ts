// Builds the market allowlist from live GMTrade state: every enabled, pure USDC-USDC market of the pinned
// store whose index asset has a reviewed category gets a MarketConfig with the spec §1 leverage caps.
// Markets we already configured that GMTrade disabled (or that are left out) are switched off, never deleted.
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import {
  GMTRADE_PROGRAM_ID,
  GMTRADE_STORE,
  MARKET_DISCRIMINATOR,
  MARKET_LAYOUT,
  decodeGmMarketMeta,
  leverageToBps,
  toMicro,
} from '@props/sdk';
import type { GmMarketMeta } from '@props/sdk';
import { main, setUp, submit } from './lib.ts';

type Category = 'crypto' | 'forex' | 'commodities' | 'stocks';

// Reviewed index assets (learnings §4, 2026-09-22). A new GMTrade listing stays off until added here.
const CATEGORY: Record<string, Category> = Object.fromEntries([
  ...['AAVE', 'ADA', 'APE', 'ARB', 'ASTER', 'AVAX', 'BCH', 'BNB', 'BOME', 'BONK', 'BTC', 'DOGE', 'DOT', 'ENA', 'ETH', 'FARTCOIN',
    'GMX', 'HYPE', 'LINK', 'LIT', 'LTC', 'MELANIA', 'NEAR', 'ONDO', 'PEPE', 'PUMP', 'SHIB', 'SOL', 'SUI', 'TAO', 'TON', 'TRUMP',
    'TRX', 'UNI', 'VVV', 'WIF', 'WLD', 'WLFI', 'XLM', 'XMR', 'XPL', 'XRP', 'ZEC'].map((s) => [s, 'crypto']),
  ...['EUR', 'GBP', 'AUD', 'NZD', 'JPY', 'CAD', 'CHF', 'MXN'].map((s) => [s, 'forex']),
  ...['XAU', 'XAG', 'XPT', 'XPD', 'XCU', 'WTI'].map((s) => [s, 'commodities']),
  ...['AAPL', 'AMZN', 'GOOGL', 'META', 'MSFT', 'MSTR', 'NVDA', 'TSLA', 'SPCX', 'SPY', 'QQQ'].map((s) => [s, 'stocks']),
]);

// Spec §1: max leverage by category; closed-session leverage 8× for session markets; stocks liquidate at
// the close near 10×, so stocks stay at 8× even while open.
const CAPS: Record<Category, { max: number; closed: number; session: boolean }> = {
  crypto: { max: 25, closed: 25, session: false },
  forex: { max: 20, closed: 8, session: true },
  commodities: { max: 15, closed: 15, session: false },
  stocks: { max: 8, closed: 8, session: true },
};

/** "BTC/USD[USDC-USDC]" → "BTC"; "USD/JPY[USDC-USDC]" → "JPY". */
function indexSymbol(name: string): string {
  const [base = '', quote = ''] = name.split('[')[0]!.split('/');
  return base === 'USD' ? quote : base;
}

async function liveMarkets(ctx: ReturnType<typeof setUp>): Promise<(GmMarketMeta & { address: PublicKey })[]> {
  const accounts = await ctx.connection.getProgramAccounts(GMTRADE_PROGRAM_ID, {
    dataSlice: { offset: 0, length: MARKET_LAYOUT.store + 32 },
    filters: [
      { memcmp: { offset: 0, bytes: Buffer.from(MARKET_DISCRIMINATOR).toString('base64'), encoding: 'base64' } },
      { memcmp: { offset: MARKET_LAYOUT.store, bytes: GMTRADE_STORE.toBase58() } },
    ],
  });
  return accounts.map((a) => ({ address: a.pubkey, ...decodeGmMarketMeta(a.account.data) })).filter((m) => m.pureUsdc);
}

main(async () => {
  const ctx = setUp(
    'node scripts/admin/upsert-markets.ts [--symbols BTC,ETH,...] [--max-position-usd 10000] [--max-total-oi-usd 50000] [--cluster ...] [--execute]\n' +
      '  Caps are per funded position and per market side across all funded accounts; review them against pool depth.',
    {
      symbols: { type: 'string' },
      'max-position-usd': { type: 'string', default: '10000' },
      'max-total-oi-usd': { type: 'string', default: '50000' },
    },
  );
  const only = ctx.values.symbols ? new Set(String(ctx.values.symbols).split(',').map((s) => s.trim().toUpperCase())) : undefined;
  const maxPositionUsd = new BN(toMicro(String(ctx.values['max-position-usd'])).toString());
  const maxTotalOiUsd = new BN(toMicro(String(ctx.values['max-total-oi-usd'])).toString());
  const configured = new Set((await ctx.vault.program.account.marketConfig.all()).map((m) => m.account.marketToken.toBase58()));

  const instructions = [];
  for (const m of (await liveMarkets(ctx)).sort((a, b) => a.name.localeCompare(b.name))) {
    const symbol = indexSymbol(m.name);
    const category = CATEGORY[symbol];
    const enabled = m.enabled && category !== undefined && (!only || only.has(symbol));
    if (!enabled && !configured.has(m.marketToken.toBase58())) continue;
    const caps = CAPS[category ?? 'stocks'];
    const indexSymbolBytes = new Uint8Array(16);
    indexSymbolBytes.set(new TextEncoder().encode(symbol).subarray(0, 16));
    console.log(`${enabled ? 'enable ' : 'disable'} ${m.name.padEnd(24)} ${symbol.padEnd(8)} ${category ?? 'unreviewed'} ${caps.max}× (closed ${caps.closed}×)`);
    instructions.push(
      await ctx.vault.upsertMarket({
        admin: ctx.operator.publicKey,
        marketToken: m.marketToken,
        params: {
          enabled,
          indexSymbol: Array.from(indexSymbolBytes),
          maxLeverageBps: leverageToBps(caps.max),
          closedMaxLeverageBps: leverageToBps(caps.closed),
          maxPositionUsd,
          maxTotalOiUsd,
          sessionRestricted: caps.session,
        },
      }),
    );
  }
  for (let i = 0; i < instructions.length; i += 6) {
    await submit(ctx, `upsert_market ${i + 1}-${Math.min(i + 6, instructions.length)} of ${instructions.length}`, instructions.slice(i, i + 6));
  }
});
