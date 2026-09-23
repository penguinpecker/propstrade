// trades_root: the SHA-256 Merkle root over an evaluation's fills, recorded onchain by record_evaluation_result. The
// server computes it with this module and the app recomputes it the same way (Web Crypto, in Node and in browsers).
//
// Anyone can recompute it from GET /v1/sim/:id/fills (every fill of the account, in the canonical order below; public
// once the result is onchain; the round trips in GET /v1/accounts/:id/history are built from the same fills):
//   1. Order the fills by `ts` ascending, then `id` ascending (the endpoint already returns them this way).
//   2. Leaf of a fill = SHA-256 of the UTF-8 text of these fields exactly as the JSON strings/numbers read, joined by "|":
//        id|symbol|side|increase-or-decrease|sizeUsd|price|feeUsd|priceImpactUsd|fundingUsd|borrowUsd|realizedPnl|ts
//      where increase-or-decrease is the word "increase" or "decrease", realizedPnl is "" when null, and ts is the
//      decimal unix-millisecond number.
//   3. Hash pairs left to right, parent = SHA-256(left 32 bytes ‖ right 32 bytes); an odd node at the end of a level
//      moves up unchanged. Repeat until one node is left. The root is its lowercase hex.
//   4. No fills: 64 zeros.
import type { Fill } from './api.ts';

const sha256 = async (data: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest('SHA-256', data));
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const fillLeafText = (f: Fill) => [
  f.id, f.symbol, f.side, f.isIncrease ? 'increase' : 'decrease', f.sizeUsd, f.price, f.feeUsd, f.priceImpactUsd,
  f.fundingUsd, f.borrowUsd, f.realizedPnl ?? '', String(f.ts),
].join('|');

export const canonicalOrder = (a: Fill, b: Fill) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function tradesRoot(fills: Fill[]): Promise<string> {
  const encoder = new TextEncoder();
  let level: Uint8Array<ArrayBuffer>[] = await Promise.all([...fills].sort(canonicalOrder).map((f) => sha256(encoder.encode(fillLeafText(f)))));
  if (level.length === 0) return '0'.repeat(64);
  while (level.length > 1) {
    const next: Uint8Array<ArrayBuffer>[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const [left, right] = [level[i]!, level[i + 1]];
      next.push(right ? await sha256(new Uint8Array([...left, ...right])) : left);
    }
    level = next;
  }
  return hex(level[0]!);
}
