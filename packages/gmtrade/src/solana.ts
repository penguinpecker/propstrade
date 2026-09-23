// Minimal Solana plumbing: base58, program-derived addresses and the one RPC read we need.
import { createHash } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 character ${JSON.stringify(c)}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function pubkeyBytes(key: string): Uint8Array {
  const b = base58Decode(key);
  if (b.length !== 32) throw new Error(`not a 32-byte public key: ${key}`);
  return b;
}

// ed25519 point decompression check, as curve25519-dalek's CompressedEdwardsY::decompress
// (what Solana's `is_on_curve` uses): y is taken mod p, valid iff (y^2 - 1) / (d y^2 + 1) is a square.
const P = 2n ** 255n - 19n;
const pow = (b: bigint, e: bigint) => {
  let r = 1n;
  b %= P;
  for (; e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) r = (r * b) % P;
  return r;
};
const D = (((-121665n * pow(121666n, P - 2n)) % P) + P) % P;

function isOnCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]!);
  y = (y & ((1n << 255n) - 1n)) % P;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const x2 = (u * pow(v, P - 2n)) % P;
  return x2 === 0n || pow(x2, (P - 1n) / 2n) === 1n;
}

export function findProgramAddress(seeds: Uint8Array[], programId: string): string {
  const program = pubkeyBytes(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    const key = h.update(Uint8Array.of(bump)).update(program).update('ProgramDerivedAddress').digest();
    if (!isOnCurve(key)) return base58Encode(key);
  }
  throw new Error('no viable bump seed');
}

export interface AccountsAt {
  /** Every account is at least this recent (the lowest context slot across chunks). */
  slot: number;
  /** Raw account data (base64), null when the account does not exist. */
  accounts: (string | null)[];
}

/** getMultipleAccounts at `confirmed`, chunked to the RPC's 100-key limit. */
export async function getMultipleAccounts(rpcUrl: string, keys: string[], signal?: AbortSignal): Promise<AccountsAt> {
  const out: AccountsAt = { slot: Number.MAX_SAFE_INTEGER, accounts: [] };
  for (let i = 0; i < keys.length; i += 100) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts',
        params: [keys.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }],
      }),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`RPC getMultipleAccounts: HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: { context: { slot: number }; value: ({ data: [string, string] } | null)[] };
      error?: { message: string };
    };
    if (!body.result) throw new Error(`RPC getMultipleAccounts: ${body.error?.message ?? 'no result'}`);
    out.slot = Math.min(out.slot, body.result.context.slot);
    out.accounts.push(...body.result.value.map((a) => a?.data[0] ?? null));
  }
  return out;
}
