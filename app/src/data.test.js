import { describe, expect, it } from 'vitest';
import { compactUsd, freshnessLabel, isCurrent, marginFor, marketPrice, percent, signedUsd, tierRules, usd, usdBase } from './data.js';

describe('formatters', () => {
  it('show a dash for values the API reports as unavailable', () => {
    for (const format of [usd, signedUsd, compactUsd, percent]) expect(format(null)).toBe('—');
    expect([usd('1234.5'), signedUsd('-49.86'), signedUsd('0'), compactUsd('142600000'), percent(2.481)]).toEqual(['$1,234.50', '−$49.86', '+$0.00', '$142.6M', '+2.48%']);
  });
});

describe('tierRules', () => {
  it('derives the pinned rules of a tier', () => {
    expect(tierRules({ sizeUsd: '25000', profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000, termsHash: 'h', version: 3 }))
      .toEqual({ sizeUsd: '25000', lossAllowanceUsd: '1250', floorUsd: '23750', profitTargetUsd: '2000', maxExposureUsd: '25000', traderShareBps: 8000, termsHash: 'h', version: 3 });
  });
});

describe('isCurrent', () => {
  const evaluation = { id: 'e1', stage: 'evaluation', status: 'passed', evidence: {} };
  it('keeps a passed evaluation current until a funded account is activated from it', () => {
    expect(isCurrent(evaluation, [evaluation])).toBe(true);
    expect(isCurrent(evaluation, [evaluation, { stage: 'funded', status: 'active', evidence: { evaluation: 'e1' } }])).toBe(false);
  });
  it('moves ended accounts to the past', () => {
    for (const status of ['breached', 'failed', 'closed']) expect(isCurrent({ ...evaluation, status }, [])).toBe(false);
  });
});

describe('usdBase', () => {
  it('names the base asset only for pairs quoted in USD', () => {
    expect(usdBase({ pair: 'BTC / USD' })).toBe('BTC');
    expect(usdBase({ pair: 'USD / JPY' })).toBeNull();
  });
});

describe('marketPrice', () => {
  it('prefixes $ only for pairs quoted in USD', () => {
    expect(marketPrice('64482', { pair: 'BTC / USD', priceDecimals: 2 })).toBe('$64,482.00');
    expect(marketPrice('147.214', { pair: 'USD / JPY', priceDecimals: 3 })).toBe('147.214');
    expect(marketPrice(null, { pair: 'BTC / USD', priceDecimals: 2 })).toBe('—');
  });
});

describe('freshnessLabel', () => {
  it('names every state but live', () => {
    expect(['live', 'delayed', 'stale', 'unavailable'].map(freshness => freshnessLabel({ freshness }))).toEqual([null, 'Delayed', 'Stale', 'Unavailable']);
  });
});

describe('marginFor', () => {
  it('rounds up to the micro-USD so size ÷ margin stays within the leverage, without float noise', () => {
    expect([marginFor(1001, 15), marginFor(1000.5, 5), marginFor(1000, 10)]).toEqual(['66.733334', '200.100000', '100.000000']);
    expect(1001 / Number(marginFor(1001, 15))).toBeLessThanOrEqual(15);
  });
});
