// The order fee's admin tooling (docs/runbooks/launch.md §10.1, §12): set-order-fee.ts always names both values and
// stays within the program's caps; settle-order-fees.ts names the account's fees due and settlement count it read,
// refuses a settlement the program would refuse, and only for a risk authority. Both print a transaction Squads (or a
// risk key holder) can import with --print-for, and only when the dry run passes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import { GMTRADE_PROGRAM_ID, PROPS_VAULT_PROGRAM_ID, PropsVaultClient, USDC_MINT, configPda, ownerUsdcAddress } from '@props/sdk';

const client = new PropsVaultClient(new Connection('http://127.0.0.1:1'));
const n = (v: number | bigint) => new BN(v.toString());
const risk = Keypair.generate().publicKey;
const funded = Keypair.generate().publicKey;

/** An account's data as the program stores it (Anchor's own encode has a 1,000-byte buffer; FundedAccount is larger). */
function encode(name: string, data: Record<string, unknown>): Buffer {
  const coder = client.program.coder.accounts as unknown as { accountLayouts: Map<string, { discriminator: number[]; layout: { encode(src: unknown, b: Buffer): number } }> };
  const entry = coder.accountLayouts.get(name)!;
  const body = Buffer.alloc(4_000);
  return Buffer.concat([Buffer.from(entry.discriminator), body.subarray(0, entry.layout.encode(data, body))]);
}
const key = () => Keypair.generate().publicKey;
const config = encode('config', {
  admin: key(), pendingAdmin: null, riskAuthorities: [risk], kycAuthority: key(), usdcMint: USDC_MINT, gmtradeProgram: GMTRADE_PROGRAM_ID,
  gmtradeStore: key(), capitalVault: key(), traderShareBps: 8000, minPayout: n(50_000_000), ownerSolTarget: n(250_000_000), ownerSolMin: n(100_000_000),
  maxDailyPrincipal: n(1_000_000), principalWindowStart: n(0), principalInWindow: n(0), paused: { newEvaluations: false, trading: false, payouts: false },
  feesCollected: n(0), allocatedPrincipal: n(0), payoutsPaid: n(0), profitToVault: n(0), evaluationsSold: n(0), fundedActivated: n(0), fundedActive: 0,
  bump: 255, vaultBump: 255, feeVaultBump: 255, solTreasuryBump: 255, orderFeeUsdc: n(0), orderFeeBps: 0,
});
const free = { marketToken: PublicKey.default, gmPosition: PublicKey.default, isLong: false, collateral: n(0), sizeUsd: n(0), pendingUsd: n(0), lastSync: n(0) };
const freeOrder = { order: PublicKey.default, slot: 0, orderType: { market: {} }, sizeUsd: n(0), collateral: n(0), placedByRisk: false };
const fundedData = encode('fundedAccount', {
  trader: key(), evaluation: key(),
  terms: { sizeUsd: n(10_000_000_000), profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000, termsHash: Array(32).fill(1), tierVersion: 1 },
  principal: n(500_000_000), status: { active: {} }, slots: Array(8).fill(free), orders: Array(8).fill(freeOrder), orderSeq: n(3), payoutsPaid: n(0), payoutSeq: 0,
  createdAt: n(0), lastSyncAt: n(0), bump: 255, ownerBump: 255, orderFees: Array(8).fill(n(0)), orderFeesDue: n(5_000_000), orderFeesPaid: n(2_500_000),
  orderFeeSettlements: n(3),
});
const usdcBalance = 3_000_000n;

async function withChain(run: (script: (name: string, args: string[]) => Promise<{ stdout: string; stderr: string }>) => Promise<void>) {
  const accounts = new Map([[configPda().toBase58(), { data: config, owner: PROPS_VAULT_PROGRAM_ID }], [funded.toBase58(), { data: fundedData, owner: PROPS_VAULT_PROGRAM_ID }]]);
  const rpc = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body) as { id: string; method: string; params: unknown[] };
      const account = method === 'getAccountInfo' ? accounts.get(params[0] as string) : undefined;
      const value = {
        getAccountInfo: account ? { data: [account.data.toString('base64'), 'base64'], executable: false, lamports: 1, owner: account.owner.toBase58(), rentEpoch: 0, space: account.data.length } : null,
        getTokenAccountBalance: params?.[0] === ownerUsdcAddress(funded).toBase58() ? { amount: usdcBalance.toString(), decimals: 6, uiAmount: 3, uiAmountString: '3' } : undefined,
        getLatestBlockhash: { blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', lastValidBlockHeight: 1000 },
        simulateTransaction: { err: null, logs: [], accounts: null, unitsConsumed: 150 },
      }[method];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value === undefined ? { jsonrpc: '2.0', id, error: { code: -32601, message: method } } : { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value } }));
    });
  });
  await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
  const cluster = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  try {
    await run((name, args) => promisify(execFile)(process.execPath, [new URL(name, import.meta.url).pathname, ...args, '--cluster', cluster], { encoding: 'utf8' }));
  } finally {
    rpc.close();
  }
}
const refused = (p: Promise<unknown>) => p.then(() => assert.fail('the script succeeded'), (e: { code: number; stdout: string; stderr: string }) => e);
/** The data of the one instruction in the printed transaction. */
const printed = (stdout: string) => Transaction.from(bs58.decode(stdout.trim().split('\n').at(-1)!)).instructions[0]!.data;

test('set-order-fee: both values, within the program\'s caps, printed as set_order_fee', async () => {
  await withChain(async (script) => {
    const vault = Keypair.generate().publicKey.toBase58();
    const one = await refused(script('./set-order-fee.ts', ['--usdc', '0.5', '--print-for', vault]));
    assert.match(one.stderr, /--usdc and --bps are both required/);
    const high = await refused(script('./set-order-fee.ts', ['--usdc', '2.000001', '--bps', '2', '--print-for', vault]));
    assert.match(high.stderr, /caps the fee at 2 USDC and 10 bps/);
    assert.match((await refused(script('./set-order-fee.ts', ['--usdc', '0.5', '--bps', '11', '--print-for', vault]))).stderr, /caps the fee/);
    const ok = await script('./set-order-fee.ts', ['--usdc', '0.5', '--bps', '2', '--print-for', vault]);
    assert.match(ok.stdout, /current off\nnew {5}0\.5 USDC \+ 2 bps per order \(0\.7 USDC on a \$1,000 order, 2\.5 on \$10,000\)/);
    assert.deepEqual(printed(ok.stdout), client.program.coder.instruction.encode('setOrderFee', { feeUsdc: n(500_000), feeBps: 2 }));
  });
});

test('settle-order-fees: names the fees due and the settlement count read, and refuses what the program would', async () => {
  await withChain(async (script) => {
    const args = (charge: string, waive: string, signer = risk) => ['--funded', funded.toBase58(), '--charge', charge, '--waive', waive, '--print-for', signer.toBase58()];
    assert.match((await refused(script('./settle-order-fees.ts', args('1', '0', key())))).stderr, /is not a risk authority/);
    assert.match((await refused(script('./settle-order-fees.ts', args('3', '2.000001')))).stderr, /is more than the 5 USDC due/);
    assert.match((await refused(script('./settle-order-fees.ts', args('3.000001', '0')))).stderr, /more than the 3 USDC the account holds/);
    assert.match((await refused(script('./settle-order-fees.ts', args('0', '0')))).stderr, /nothing to settle/);
    const ok = await script('./settle-order-fees.ts', args('2.5', '2.5'));
    assert.match(ok.stdout, /5 USDC of order fees due, 3 settlements so far, 3 USDC in its account/);
    assert.deepEqual(printed(ok.stdout), client.program.coder.instruction.encode('settleOrderFees', {
      charge: n(2_500_000), waive: n(2_500_000), expectedDue: n(5_000_000), expectedSettlements: n(3),
    }));
  });
});
