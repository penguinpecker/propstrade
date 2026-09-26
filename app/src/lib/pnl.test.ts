import { describe, expect, it } from 'vitest';
import { orderFee, toMicro, usdToGm } from '@props/sdk';
import { buyingPower, expectedPnl, feeRate, feeRateLabel, hourlyCostUsd, propsFeeUsd, sideRates } from './pnl';

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

describe('Props fee', () => {
  const rate = feeRate({ orderFeeUsd: '0.5', orderFeeBps: 7 });

  it('reads the rate from AppConfig as the SDK\'s toMicro does, and a server without it charges none', () => {
    expect(rate).toEqual({ feeUsdc: 500_000n, feeBps: 7 });
    for (const usd of ['0', '0.000001', '0.5', '1.999999', '2']) expect(feeRate({ orderFeeUsd: usd }).feeUsdc).toBe(toMicro(usd));
    expect(feeRate({})).toEqual({ feeUsdc: 0n, feeBps: 0 });
    expect(feeRate(undefined)).toEqual({ feeUsdc: 0n, feeBps: 0 });
  });

  it('is the program\'s fee, the SDK\'s orderFee: flat + bps of the size rounded down to the micro-USDC, nothing without a size', () => {
    expect(propsFeeUsd(rate, 1234.567891)).toBe(1.364197); // 0.5 + ⌊1,234,567,891 × 7 / 10,000⌋ micro = 0.5 + 0.864197
    expect(propsFeeUsd(rate, 0)).toBe(0);
    expect(propsFeeUsd(feeRate({ orderFeeUsd: '0', orderFeeBps: 0 }), 5000)).toBe(0);
    // Every size the ticket can hold (6 decimals) and every rate up to the caps: the same micro-USDC as the SDK.
    for (let i = 0; i < 2000; i += 1) {
      const r = { feeUsdc: BigInt(Math.floor(Math.random() * 2_000_001)), feeBps: Math.floor(Math.random() * 11) };
      const size = Number((Math.random() * 10 ** Math.floor(Math.random() * 7)).toFixed(6));
      expect(propsFeeUsd(r, size), `${size} at ${r.feeUsdc} + ${r.feeBps} bps`).toBe(size > 0 ? Number(orderFee(r, usdToGm(size.toFixed(6)))) / 1e6 : 0);
    }
  });

  it('names the rate by its flat part and its percentage, and not at all while it is off', () => {
    expect([rate, feeRate({ orderFeeUsd: '2' }), feeRate({ orderFeeBps: 10 }), feeRate({ orderFeeUsd: '0.000001', orderFeeBps: 1 }), feeRate({})].map(feeRateLabel))
      .toEqual(['$0.50 + 0.07%', '$2.00', '0.1%', '$0.000001 + 0.01%', null]);
  });

  it('leaves the order\'s own fee beside its margin: at the largest size, margin + fee spend the available margin exactly', () => {
    const size = buyingPower(1000, 10, rate);
    expect(size / 10 + 0.5 + size * 7 / 10_000).toBeCloseTo(1000, 9);
    expect(buyingPower(1000, 10, feeRate({}))).toBe(10_000);
    expect(buyingPower(0.4, 10, rate)).toBe(0); // less than the flat part: nothing can be opened
  });
});
