// Generates a hot authority key for the server (risk or KYC) into a new file readable only by its owner, and prints
// its public key and how to hand it to Railway. The secret is never printed: it goes from the file to the Railway
// variable over stdin, and the file is deleted afterwards (a lost key is replaced by a new one + set-authorities).
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Keypair } from '@solana/web3.js';
import { main } from './lib.ts';

const ROLES = {
  risk: {
    variable: 'RISK_AUTHORITY_KEYPAIR', sol: '0.2', pays: 'every keeper and chain-job transaction fee',
    authorities: (key: string) => `--risk ${key} --kyc <KYC_AUTHORITY_PUBKEY>`,
  },
  kyc: {
    variable: 'KYC_AUTHORITY_KEYPAIR', sol: '0.1', pays: 'set_identity fees and ~0.002 SOL of rent per verified trader',
    authorities: (key: string) => `--risk <RISK_AUTHORITY_PUBKEY> --kyc ${key}`,
  },
} as const;

main(async () => {
  const usage = 'node scripts/admin/gen-authority-key.ts --role <risk|kyc> --out <new file path>';
  const { values } = parseArgs({ options: { role: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) {
    console.log(usage);
    return;
  }
  const role = ROLES[values.role as keyof typeof ROLES];
  if (!role || !values.out) throw new Error(usage);
  const key = Keypair.generate();
  // 'wx' refuses to replace an existing file (never overwrite a key that may be in use).
  writeFileSync(values.out, `${JSON.stringify(Array.from(key.secretKey))}\n`, { mode: 0o600, flag: 'wx' });
  const pubkey = key.publicKey.toBase58();
  console.log(`Wrote a new ${values.role} authority keypair to ${values.out} (readable by you only).
Public key: ${pubkey}

1. Give it to the server: set the Railway variable ${role.variable} to the file's contents (one line, a JSON array
   of 64 numbers), read from stdin so the secret never appears in a command line:
     railway variable set ${role.variable} --stdin --service <SERVER_SERVICE> --skip-deploys < ${values.out}
   (or paste the contents in the dashboard: server service → Variables → New Variable ${role.variable}).
2. Register the public key onchain (admin key; set_authorities replaces the risk list and the KYC key together):
     node scripts/admin/set-authorities.ts ${role.authorities(pubkey)} --execute
3. Fund it (it pays ${role.pays}):
     solana transfer ${pubkey} ${role.sol} --allow-unfunded-recipient --keypair "$OPERATOR_KEYPAIR" --url "$RPC_URL"
4. Once Railway shows the variable, delete the file: rm ${values.out}`);
});
