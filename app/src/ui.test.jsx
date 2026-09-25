import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FreshnessBadge, FullAddress, LineGraph, SessionNotice, WalletOptions, WatchlistStar, openOnRowClick } from './ui.jsx';

afterEach(() => vi.unstubAllGlobals());
const matching = hit => vi.stubGlobal('matchMedia', query => ({ matches: hit.includes(query) }));

const render = (network, notice) => renderToStaticMarkup(<SessionNotice session={{ network, notice }}>Signing in proves this wallet is yours.</SessionNotice>);
const SLOW_RPC = { state: 'unreachable', reason: 'The Solana connection is not responding.' };

describe('SessionNotice', () => {
  it('shows the guidance when nothing is wrong', () => {
    expect(render({ state: 'ok' }, null)).toContain('Signing in proves this wallet is yours.');
  });

  it('still shows a sign-in failure while the RPC is unreachable', () => {
    const html = render(SLOW_RPC, 'The request was declined in your wallet.');
    expect(html).toContain('The request was declined in your wallet.');
    expect(html).not.toContain('not responding');
    expect(render(SLOW_RPC, null)).toContain('not responding');
  });

  it('puts a wrong network first because it blocks sign-in', () => {
    expect(render({ state: 'wrong', reason: 'Not on Solana mainnet.' }, 'Your session expired.')).toContain('Not on Solana mainnet.');
  });

  it('announces session problems to assistive technology from one persistent live region', () => {
    for (const html of [render({ state: 'ok' }, 'Your session expired. Sign in again to continue.'), render({ state: 'ok' }, null)])
      expect(html).toMatch(/^<div class="notice (amber|neutral)" role="status">/);
  });
});

describe('WatchlistStar', () => {
  const star = watched => renderToStaticMarkup(<WatchlistStar symbol="TAO" watched={watched} onToggle={() => {}} />);
  it('names the action it will take and fills the star of a watched market', () => {
    expect(star(false)).toMatch(/^<button class="favorite-button " aria-label="Add TAO to watchlist"/);
    expect(star(true)).toMatch(/^<button class="favorite-button selected" aria-label="Remove TAO from watchlist"/);
  });
});

describe('FullAddress', () => {
  const address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  it('shows the whole address with a copy button and its explorer page', () => {
    const html = renderToStaticMarkup(<FullAddress address={address} />);
    expect(html).toContain(`<code>${address}</code>`);
    expect(html).toMatch(/<button type="button">.*Copy<\/button>/);
    expect(html).toContain(`href="https://explorer.solana.com/address/${address}"`);
  });
  it('on a phone offers one line break, at the midpoint, so a wrapped address splits into even halves', () => {
    matching(['(max-width: 600px)']);
    expect(renderToStaticMarkup(<FullAddress address={address} />)).toContain(`<code>${address.slice(0, 22)}<wbr/>${address.slice(22)}</code>`);
  });
  it('shortens in a dense table, keeping the full address as the hover and the copy, without the link', () => {
    const html = renderToStaticMarkup(<FullAddress address={address} short />);
    expect(html).toContain(`<code title="${address}">EPjF…Dt1v</code>`);
    expect(html).not.toContain('explorer.solana.com');
  });
});

describe('LineGraph', () => {
  const labels = html => [...html.matchAll(/<span style="[^"]*">([^<]*)<\/span>/g)].map(m => m[1]);
  const series = (from, stepMs, n) => Array.from({ length: n }, (_, i) => ({ ts: from + i * stepMs, value: i }));

  it('labels a series under two days long with times of day, each once', () => {
    const shown = labels(renderToStaticMarkup(<LineGraph points={series(Date.UTC(2026, 8, 23, 1), 3_600_000, 12)} />));
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.every(t => /^\d{2}:\d{2}$/.test(t))).toBe(true);
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('labels longer series with dates, never repeating one', () => {
    const shown = labels(renderToStaticMarkup(<LineGraph points={series(Date.UTC(2026, 8, 1), 3 * 3_600_000, 30)} />));
    expect(shown.every(t => /^[A-Z][a-z]{2} \d{2}$/.test(t))).toBe(true);
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('puts the labels in HTML under the stretched SVG, first and last kept inside the edges, three on a phone', () => {
    const html = renderToStaticMarkup(<LineGraph points={series(Date.UTC(2026, 8, 1), 86_400_000, 30)} />);
    expect(html).not.toContain('<text');
    expect(html).toMatch(/<\/svg><div class="graph-axis" aria-hidden="true"><span style="left:2\.2+\d*%;transform:none">/);
    expect(html).toMatch(/left:97\.7+\d*%;transform:translateX\(-100%\)">[^<]+<\/span><\/div>$/);
    expect(labels(html)).toHaveLength(6);
    matching(['(max-width: 600px)']);
    expect(labels(renderToStaticMarkup(<LineGraph points={series(Date.UTC(2026, 8, 1), 86_400_000, 30)} />))).toEqual(['Sep 01', 'Sep 16', 'Sep 30']);
    expect(renderToStaticMarkup(<LineGraph showLabels={false} points={series(0, 1, 3)} />)).not.toContain('graph-axis');
  });
});

describe('FreshnessBadge', () => {
  const market = { freshness: 'stale', updatedAt: Date.UTC(2026, 8, 25, 14, 2, 9) };
  it('prints the last update time on a touch screen, where the tooltip cannot open', () => {
    expect(renderToStaticMarkup(<FreshnessBadge market={market} />)).toMatch(/>Stale<\/span>$/);
    matching(['(hover: none)']);
    expect(renderToStaticMarkup(<FreshnessBadge market={market} />)).toMatch(/>Stale · 14:02 UTC<\/span>$/);
  });
});

describe('WalletOptions without an installed wallet', () => {
  const html = () => renderToStaticMarkup(<WalletOptions session={{ wallets: [] }} onChoose={() => {}} />);
  it('offers the wallet apps\' in-app browsers on a phone and the extensions on a desktop', () => {
    vi.stubGlobal('location', { href: 'https://props.trade/#/connect', origin: 'https://props.trade' });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
    expect(html()).toContain('href="https://phantom.app/ul/browse/https%3A%2F%2Fprops.trade%2F%23%2Fconnect?ref=https%3A%2F%2Fprops.trade"');
    expect(html()).toContain('href="https://solflare.com/ul/v1/browse/https%3A%2F%2Fprops.trade%2F%23%2Fconnect?ref=https%3A%2F%2Fprops.trade"');
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36' });
    expect(html()).toContain('No Solana wallet was found in this browser.');
    expect(html()).not.toContain('wallet-option');
  });
});

describe('openOnRowClick', () => {
  it('opens the record from the row, not from a button or link inside it', () => {
    const open = vi.fn(), handler = openOnRowClick(open);
    handler({ target: { closest: () => null } });
    handler({ target: { closest: s => s === 'button, a' ? {} : null } });
    expect(open).toHaveBeenCalledTimes(1);
  });
});
