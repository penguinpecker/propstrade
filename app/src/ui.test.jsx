import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionNotice } from './ui.jsx';

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
