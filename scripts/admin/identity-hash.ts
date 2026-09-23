// Prints the identity hash for a KYC approval (POST /v1/admin/kyc/:id/approve { identityHash }): HMAC-SHA256 under
// IDENTITY_SALT of one identity document in canonical form, "<ISSUER>:<TYPE>:<NUMBER>". The program allows one wallet
// per hash (IdentityLock), so the same document must give the same hash however it was typed. The canonical form never
// changes (every approved identity was hashed with it):
//   ISSUER  the issuing country, ISO 3166-1 alpha-2, upper case, aliases resolved ("uk" → "GB")
//   TYPE    PASSPORT or ID_CARD
//   NUMBER  the document number, upper case, with spaces, dashes, dots and slashes removed ("c01x-00 t47" → "C01X00T47")
// The salt is read from stdin, never from an argument (shell history, process list). stdout gets only the hash; stderr
// shows the canonical document it hashed, for the reviewer to compare with the document.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { main } from './lib.ts';

const DOCUMENTS: Record<string, string> = { passport: 'PASSPORT', 'id-card': 'ID_CARD' };
const REGIONS = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
// Region codes Intl knows that are not countries.
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'QO', 'UN', 'ZZ']);

main(async () => {
  const usage = `printf '%s' "$IDENTITY_SALT" | node scripts/admin/identity-hash.ts --country <issuing country, e.g. DE> --document <passport|id-card> --number <document number>`;
  const { values } = parseArgs({
    options: { country: { type: 'string' }, document: { type: 'string' }, number: { type: 'string' }, help: { type: 'boolean' } },
    strict: true,
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.country || !values.document || !values.number) throw new Error(usage);

  const code = values.country.trim().toUpperCase();
  const country = /^[A-Z]{2}$/.test(code) ? new Intl.Locale(`und-${code}`).region! : '';
  const countryName = country && !NOT_COUNTRIES.has(country) ? REGIONS.of(country) : undefined;
  if (!countryName) throw new Error(`--country "${values.country}" is not an ISO 3166-1 alpha-2 country code`);
  const type = DOCUMENTS[values.document.trim().toLowerCase().replace(/[\s_]+/g, '-')];
  if (!type) throw new Error(`--document must be one of ${Object.keys(DOCUMENTS).join(', ')}`);
  const number = values.number.toUpperCase().replace(/[\s./-]+/g, '');
  if (!/^[A-Z0-9]+$/.test(number)) throw new Error('--number may hold only the letters A-Z, digits, and spaces, dashes, dots or slashes');

  if (process.stdin.isTTY) throw new Error(`pipe the salt in, so it is not echoed: read -rs IDENTITY_SALT, then\n  ${usage}`);
  const salt = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (salt.length < 32) throw new Error('the salt on stdin is shorter than 32 characters: is IDENTITY_SALT set?');

  const canonical = `${country}:${type}:${number}`;
  console.error(`identity ${canonical} (${countryName})`);
  console.log(createHmac('sha256', salt).update(canonical).digest('hex'));
});
