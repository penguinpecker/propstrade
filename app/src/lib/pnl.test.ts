import { describe, expect, it } from 'vitest';
import { expectedPnl, hourlyCostUsd, sideRates } from './pnl';

describe('expectedPnl', () => {
  const base = { sizeUsd: 1000, entry: 100 };

  it('is positive for a take profit in the side’s favour and negative for a stop loss', () => {
    expect(expectedPnl({ ...base, side: 'Long', target: 105 })).toBeCloseTo(50);
    expect(expectedPnl({ ...base, side: 'Short', target: 95 })).toBeCloseTo(50);
    expect(expectedPnl({ ...base, side: 'Long', target: 98 })).toBeCloseTo(-20);
    expect(expectedPnl({ ...base, side: 'Short', target: 102 })).toBeCloseTo(-20);
  });

  it('takes the open fee, the close fee and the impact off the result, whichever side', () => {
    const costs = { openFeeUsd: 0.6, closeFeeUsd: 0.6, priceImpactUsd: 0.1 };
    expect(expectedPnl({ ...base, side: 'Long', target: 105, ...costs })).toBeCloseTo(48.7);
    expect(expectedPnl({ ...base, side: 'Short', target: 105, ...costs })).toBeCloseTo(-51.3);
    expect(expectedPnl({ ...base, side: 'Long', target: 100, ...costs })).toBeCloseTo(-1.3); // a target at the entry costs the fees
  });

  it('scales with size and reads the limit price as the entry when the ticket gives one', () => {
    expect(expectedPnl({ side: 'Long', sizeUsd: 2500, entry: 2580, target: 2580 * 1.02 })).toBeCloseTo(50);
  });
});

describe('carry', () => {
  const market = { fundingRateHourlyLong: 0.0012, fundingRateHourlyShort: -0.0009, borrowRateHourlyLong: 0.0008, borrowRateHourlyShort: 0 };

  it('reads each side’s own rates', () => {
    expect(sideRates(market, 'Long')).toEqual({ funding: 0.0012, borrow: 0.0008 });
    expect(sideRates(market, 'Short')).toEqual({ funding: -0.0009, borrow: 0 });
  });

  it('charges borrowing plus funding paid per hour, never credits funding received, and is unknown without both rates', () => {
    expect(hourlyCostUsd(market, 'Long', 10_000)).toBeCloseTo(0.2); // (0.0012 + 0.0008)% of 10,000
    expect(hourlyCostUsd(market, 'Short', 10_000)).toBe(0); // the receiving side is not credited: only its (zero) borrow rate
    expect(hourlyCostUsd({ ...market, borrowRateHourlyLong: null }, 'Long', 10_000)).toBeNull();
  });
});
