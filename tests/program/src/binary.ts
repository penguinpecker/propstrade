// The props_vault binary under test, loaded by every suite, the validator smoke suite, the compare scenarios and the
// fuzzers: PROPS_VAULT_SO (an absolute path), else the Anchor build. Its identity goes to stderr once per process, so a
// run's output says which file it proved (round-4 audit: a stale but valid build passed the whole suite without a word).
// The hash is the one `solana-verify get-executable-hash` prints for the file and `get-program-hash` for the deployed
// program: sha256 of the bytes minus their trailing zeros (the program data's padding).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const PROGRAM_SO = process.env.PROPS_VAULT_SO || new URL('../../../target/deploy/props_vault.so', import.meta.url).pathname;
assert.ok(isAbsolute(PROGRAM_SO), `PROPS_VAULT_SO must be an absolute path: ${PROGRAM_SO}`);
const bytes = readFileSync(PROGRAM_SO);
let end = bytes.length;
while (end > 0 && bytes[end - 1] === 0) end--;
console.error(`props_vault binary: ${PROGRAM_SO} (${bytes.length} bytes, executable hash ${createHash('sha256').update(bytes.subarray(0, end)).digest('hex')})`);
