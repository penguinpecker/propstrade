// The Props funded-trading allowlist: props_vault `MarketConfig` accounts (PDA ["market", gm_market_token]),
// decoded with the program's own Anchor IDL as published onchain at deploy.
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { IdlCoder, base58Encode, findProgramAddress, getMultipleAccounts, pubkeyBytes, type Idl } from '@props/gmtrade';

export interface MarketConfigLimits {
  enabled: boolean;
  maxLeverage: number;
  closedMaxLeverage: number;
}

/** Anchor's IDL account: createWithSeed(PDA([], program), "anchor:idl", program); data = disc, authority, u32 len, zlib JSON. */
export async function fetchAnchorIdl(rpcUrl: string, programId: string): Promise<Idl> {
  const base = pubkeyBytes(findProgramAddress([], programId));
  const address = base58Encode(createHash('sha256').update(base).update('anchor:idl').update(pubkeyBytes(programId)).digest());
  const [data] = (await getMultipleAccounts(rpcUrl, [address])).accounts;
  if (!data) throw new Error(`program ${programId} has no Anchor IDL account (${address})`);
  const buf = Buffer.from(data, 'base64');
  const len = buf.readUInt32LE(40);
  return JSON.parse(inflateSync(buf.subarray(44, 44 + len)).toString('utf8')) as Idl;
}

export const marketConfigAddress = (programId: string, marketToken: string) =>
  findProgramAddress([Buffer.from('market'), pubkeyBytes(marketToken)], programId);

/** MarketConfig limits by GMTrade market token, for the given market tokens that have one. */
export async function fetchAllowlist(rpcUrl: string, programId: string, idl: Idl, marketTokens: string[]): Promise<Map<string, MarketConfigLimits>> {
  const coder = new IdlCoder(idl);
  const { accounts } = await getMultipleAccounts(rpcUrl, marketTokens.map((t) => marketConfigAddress(programId, t)));
  const out = new Map<string, MarketConfigLimits>();
  marketTokens.forEach((token, i) => {
    const data = accounts[i];
    if (!data) return;
    const c = coder.decodeAccount('MarketConfig', Buffer.from(data, 'base64'));
    out.set(token, {
      enabled: c.enabled === true,
      maxLeverage: Number(c.max_leverage_bps) / 10_000,
      closedMaxLeverage: Number(c.closed_max_leverage_bps) / 10_000,
    });
  });
  return out;
}
