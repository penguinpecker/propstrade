// One document gives one identity hash however it is typed, the hash format never changes, and the salt is never printed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = new URL('./identity-hash.ts', import.meta.url).pathname;
const SALT = 'test-salt-not-a-secret-0123456789abcdef';
const run = (salt: string, ...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', input: salt });
const hash = (country: string, document: string, number: string, salt = `${SALT}\n`) => {
  const result = run(salt, '--country', country, '--document', document, '--number', number);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!(result.stdout + result.stderr).includes(SALT), 'the salt appears in the output');
  return result.stdout.trim();
};

test('spellings of one document give the same hash, pinned to HMAC-SHA256(salt, "GB:PASSPORT:C01X00T47")', () => {
  // printf '%s' 'GB:PASSPORT:C01X00T47' | openssl dgst -sha256 -hmac 'test-salt-not-a-secret-0123456789abcdef'
  const pinned = '4824cbfa06033d9846125b62e6940b9ce59f08e8c7d4246a806f88f80e2c59d6';
  assert.equal(hash('GB', 'passport', 'C01X00T47', SALT), pinned);
  assert.equal(hash(' gb ', 'PASSPORT', 'c01x-00 t47'), pinned);
  assert.equal(hash('UK', 'Passport', 'C01X.00/T47'), pinned);
  assert.notEqual(hash('GB', 'id-card', 'C01X00T47'), pinned);
  assert.equal(hash('GB', 'id card', 'C01X00T47'), hash('gb', 'ID_CARD', 'c01x00t47'));
  assert.notEqual(hash('IE', 'passport', 'C01X00T47'), pinned);
});

test('refuses what it cannot put in canonical form', () => {
  for (const [salt, country, document, number] of [
    ['short salt', 'GB', 'passport', 'C01X00T47'],
    ['', 'GB', 'passport', 'C01X00T47'],
    [SALT, 'QQ', 'passport', 'C01X00T47'],
    [SALT, 'EU', 'passport', 'C01X00T47'],
    [SALT, 'GBR', 'passport', 'C01X00T47'],
    [SALT, 'GB', 'driving licence', 'C01X00T47'],
    [SALT, 'GB', 'passport', 'С01X00T47'], // Cyrillic С
    [SALT, 'GB', 'passport', ' - '],
  ] as const) {
    const result = run(salt, '--country', country, '--document', document, '--number', number);
    assert.notEqual(result.status, 0, `accepted ${country} ${document} ${number} with a ${salt.length}-character salt`);
    assert.equal(result.stdout, '');
  }
});
