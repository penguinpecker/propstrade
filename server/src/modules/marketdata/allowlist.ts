// The Props funded-trading allowlist: props_vault `MarketConfig` accounts (PDA ["market", gm_market_token]),
// decoded with the program IDL bundled in @props/sdk (the build the chain module requires PROGRAM_ID to match), so no
// IDL has to be published onchain.
import { PROPS_VAULT_IDL } from '@props/sdk';
import { IdlCoder, findProgramAddress, getMultipleAccounts, pubkeyBytes, type Idl } from '@props/gmtrade';

export interface MarketConfigLimits {
  enabled: boolean;
  maxLeverage: number;
  closedMaxLeverage: number;
}

const coder = new IdlCoder(PROPS_VAULT_IDL as Idl);

export const marketConfigAddress = (programId: string, marketToken: string) =>
  findProgramAddress([Buffer.from('market'), pubkeyBytes(marketToken)], programId);

/** MarketConfig limits by GMTrade market token, for the given market tokens that have one. */
export async function fetchAllowlist(rpcUrl: string, programId: string, marketTokens: string[]): Promise<Map<string, MarketConfigLimits>> {
  const { accounts } = await getMultipleAccounts(rpcUrl, marketTokens.map((t) => marketConfigAddress(programId, t)));
  const out = new Map<string, MarketConfigLimits>();
  marketTokens.forEach((token, i) => {
    const data = accounts[i];
    if (!data) return; // no account, or a data-less one (lamports sent to an unused address)
    const c = coder.decodeAccount('MarketConfig', Buffer.from(data, 'base64'));
    out.set(token, {
      enabled: c.enabled === true,
      maxLeverage: Number(c.max_leverage_bps) / 10_000,
      closedMaxLeverage: Number(c.closed_max_leverage_bps) / 10_000,
    });
  });
  return out;
}
