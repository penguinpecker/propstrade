import { z } from 'zod';
import { walletSchema } from './lib/solana.js';

export const EnvSchema = z.object({
  DATABASE_URL: z.url(),
  APP_ORIGIN: z.url().refine((v) => new URL(v).origin === v, 'must be a bare origin such as https://props.trade'),
  SESSION_SECRET: z.string().min(32),
  ADMIN_API_TOKEN: z.string().min(32),
  RPC_URL: z.url(),
  RPC_WS_URL: z.url().optional(),
  SOLANA_CLUSTER: z.enum(['mainnet-beta', 'localnet']).default('mainnet-beta'),
  PROGRAM_ID: walletSchema.optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  /** Referrers' share of the Props fee charged on each funded order of the traders they referred, in bps (10% by default). */
  REFERRAL_REWARD_BPS: z.coerce.number().int().min(0).max(5000).default(1000),
  /**
   * Props.trade's fee per order on practice and evaluation accounts until the program is live (then every stage reads
   * the onchain Config rate): a flat USDC amount ('0.50') plus bps of the order's size, within the program's caps.
   */
  ORDER_FEE_USDC: z.string().regex(/^\d+(\.\d{1,6})?$/, 'a USDC amount with at most 6 decimal places')
    .refine((v) => Number(v) <= 2, 'at most 2 (the program caps the flat fee at $2)').default('0'),
  ORDER_FEE_BPS: z.coerce.number().int().min(0).max(10).default(0),
});

export type Config = z.infer<typeof EnvSchema>;

/** Parses the environment; throws naming every invalid variable (never its value). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // An empty assignment (as copied from .env.example) means unset.
  const parsed = EnvSchema.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}
