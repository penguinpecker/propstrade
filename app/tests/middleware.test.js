import { describe, expect, it } from 'vitest';
import middleware from '../middleware.js';

const visit = (country, region) => middleware(new Request('https://props.trade/', {
  headers: { ...(country && { 'x-vercel-ip-country': country }), ...(region && { 'x-vercel-ip-country-region': region }) },
}));

describe('geo middleware', () => {
  it.each([['US'], ['PR'], ['IR'], ['KP'], ['CU'], ['SY'], ['UA', '43'], ['UA', '40'], ['UA', '14'], ['UA', '09']])(
    'returns 451 for %s %s', async (country, region) => {
      const response = visit(country, region);
      expect(response.status).toBe(451);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toContain('not available in your region');
    });

  it.each([['DE'], ['GB'], ['UA', '30'], [undefined]])('lets %s %s through', (country, region) => {
    const response = visit(country, region);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
