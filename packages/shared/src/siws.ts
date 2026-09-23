// Sign-In With Solana message, in the exact text layout wallets produce for `solana:signIn` (Wallet Standard
// createSignInMessageText). The server builds it for POST /v1/auth/nonce; the app rebuilds it for its own origin and
// cluster before asking the wallet to sign, so it never signs a sign-in message for another site.

export interface SiwsFields {
  domain: string;       // host of the app origin, e.g. "props.trade"
  address: string;      // base58 wallet
  statement: string;
  uri: string;          // the app origin
  chainId: 'mainnet' | 'localnet';
  nonce: string;
  issuedAt: Date;
  expirationTime: Date;
}

export const SIWS_STATEMENT = 'Sign in to Props.trade. This request does not send a transaction or cost a fee.';

export function buildSiwsMessage(f: SiwsFields): string {
  return [
    `${f.domain} wants you to sign in with your Solana account:`,
    f.address,
    '',
    f.statement,
    '',
    `URI: ${f.uri}`,
    'Version: 1',
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt.toISOString()}`,
    `Expiration Time: ${f.expirationTime.toISOString()}`,
  ].join('\n');
}
