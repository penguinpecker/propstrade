import { describe, expect, it } from 'vitest';
import { TxError } from './chain';
import { isFinalTxError } from './transactions';

describe('isFinalTxError', () => {
  it('treats only a proven outcome as final, never a transaction that may still land', () => {
    expect(isFinalTxError(new TxError('The transaction failed onchain. No change was made.', 'sig'))).toBe(true);
    expect(isFinalTxError(new TxError('The transaction expired without being included.', 'sig'))).toBe(true);
    expect(isFinalTxError(new TxError('The Solana connection stopped answering.', 'sig', true))).toBe(false);
    expect(isFinalTxError(new TypeError('Failed to fetch dynamically imported module'))).toBe(false);
  });
});
