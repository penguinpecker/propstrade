// Where funded accounts are not available (spec §1 Geo). The KYC residence is the binding gate: the edge middleware
// (app/middleware.js) is a first filter only, and nothing checks location before an evaluation is bought.
import { z } from 'zod';

/**
 * US persons (GMTrade terms), including residents of US territories with their own ISO code, and comprehensively
 * sanctioned countries (ISO 3166-1 alpha-2).
 */
const BLOCKED_COUNTRIES = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'CU', 'IR', 'KP', 'SY']);
/** Comprehensively sanctioned regions (ISO 3166-2): Crimea, Sevastopol, Donetsk, Luhansk. */
const BLOCKED_REGIONS = new Set(['UA-43', 'UA-40', 'UA-14', 'UA-09']);
/** Countries only partly sanctioned: their residents must name their region. */
const REGION_REQUIRED = new Set([...BLOCKED_REGIONS].map((r) => r.slice(0, 2)));

/** A residence: ISO 3166-1 alpha-2 country and, where only part of it is sanctioned, its ISO 3166-2 region. */
export const residence = {
  country: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code'),
  region: z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/, 'ISO 3166-2 code').optional(),
};
export const refineResidence = (r: { country: string; region?: string }, ctx: z.RefinementCtx) => {
  if (r.region !== undefined && !r.region.startsWith(`${r.country}-`)) {
    ctx.addIssue({ code: 'custom', path: ['region'], message: `must be a region of ${r.country}` });
  }
  if (r.region === undefined && REGION_REQUIRED.has(r.country)) {
    ctx.addIssue({ code: 'custom', path: ['region'], message: `required for ${r.country}` });
  }
};

export const isBlocked = (r: { country: string; region?: string }) =>
  BLOCKED_COUNTRIES.has(r.country) || (r.region !== undefined && BLOCKED_REGIONS.has(r.region));
