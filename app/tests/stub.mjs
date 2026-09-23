// Test-only stand-in for the Props.trade API (packages/shared/src/api.ts shapes) and a Solana JSON-RPC endpoint, with a
// simulated GMTrade keeper. Every value here is fixture data for the browser tests; none of it ships with the app.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer } from 'node:http';
import bs58 from 'bs58';
import { SIWS_STATEMENT, buildSiwsMessage } from '@props/shared/siws';
import BN from 'bn.js';
import { ComputeBudgetProgram, Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  MARKET_DISCRIMINATOR, MARKET_LAYOUT, POSITION_DISCRIMINATOR, POSITION_LAYOUT, PROPS_VAULT_IDL, PROPS_VAULT_PROGRAM_ID, PropsVaultClient, USDC_MINT, capitalVaultAddress,
  evaluationPda, feeVaultPda, fundedPda, marketConfigPda, payoutPda, tierPda, traderProfilePda,
} from '@props/sdk';

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const PROGRAM_ID = PROPS_VAULT_PROGRAM_ID.toBase58();
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const GMTRADE = 'Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo';
const HOUR = 3_600_000, DAY = 24 * HOUR;
const client = new PropsVaultClient(new Connection('http://127.0.0.1:1'));
const fakeKey = seed => new PublicKey(createHash('sha256').update(seed).digest()).toBase58();
const fakeSignature = seed => bs58.encode(Buffer.concat([createHash('sha512').update(seed).digest()]));
/** Anchor's own encoder caps accounts at 1000 bytes; FundedAccount is larger. */
function encodeAccount(name, value) {
  const { discriminator, layout } = client.program.coder.accounts.accountLayouts.get(name);
  const data = Buffer.alloc(4096);
  return Buffer.concat([Buffer.from(discriminator), data.subarray(0, layout.encode(value, data))]);
}
const accountIndex = (ix, name) => PROPS_VAULT_IDL.instructions.find(i => i.name === ix).accounts.findIndex(a => a.name === name);

// ---------- tiers (the API's /v1/config and the onchain Tier accounts agree) ----------
const TERMS_HASH = 'a1b2c3d4'.repeat(8);
export const TIERS = [[1, '10K', 10_000, 79, true], [2, '25K', 25_000, 149, true], [3, '50K', 50_000, 249, false], [4, '100K', 100_000, 449, false]]
  .map(([id, name, size, fee, enabled]) => ({ id, name, sizeUsd: String(size), feeUsdc: String(fee), profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000, enabled, termsHash: TERMS_HASH, version: 1 }));
const tierAccount = t => encodeAccount('tier', {
  id: t.id, sizeUsd: new BN(Number(t.sizeUsd) * 1e6), feeUsdc: new BN(Number(t.feeUsdc) * 1e6), profitTargetBps: t.profitTargetBps, maxDrawdownBps: t.maxDrawdownBps,
  maxExposureBps: t.maxExposureBps, enabled: t.enabled, termsHash: [...Buffer.from(t.termsHash, 'hex')], version: t.version, bump: 255,
});

// ---------- compute ----------
/** Fixture cost of one props_vault instruction (an open on the GMTrade binary measures 140–166k CU). */
const UNITS_PER_INSTRUCTION = 150_000;
/** Units the transaction would use, and the limit it requests (200k per instruction when it sets none, like Solana). */
function compute(tx) {
  const keys = tx.message.staticAccountKeys.map(k => k.toBase58());
  const limit = tx.message.compiledInstructions.find(ix => keys[ix.programIdIndex] === ComputeBudgetProgram.programId.toBase58() && ix.data[0] === 2);
  const units = tx.message.compiledInstructions.filter(ix => keys[ix.programIdIndex] === PROGRAM_ID).length * UNITS_PER_INSTRUCTION;
  return { units, limit: limit ? Buffer.from(limit.data).readUInt32LE(1) : 200_000 * tx.message.compiledInstructions.length };
}
const overBudget = limit => ({ err: { InstructionError: [1, 'ComputationalBudgetExceeded'] }, logs: [`Program ${PROGRAM_ID} invoke [1]`, `Program ${PROGRAM_ID} consumed ${limit} of ${limit} compute units`, `Program ${PROGRAM_ID} failed: exceeded CUs meter at BPF instruction`] });

// ---------- markets ----------
const MARKETS = [
  ['BTC', 'Bitcoin', 'Crypto', 'Layer 1 & 2', 64482, 2, 8, 142_600_000, 2.48],
  ['ETH', 'Ethereum', 'Crypto', 'Layer 1 & 2', 2641.82, 2, 8, 86_400_000, 1.86],
  ['SOL', 'Solana', 'Crypto', 'Layer 1 & 2', 151.84, 2, 9, 42_800_000, 4.12],
  ['TAO', 'Bittensor', 'Crypto', 'Other', 312.4, 2, 9, 3_100_000, -3.4],
  ['FARTCOIN', 'Fartcoin', 'Crypto', 'Meme', 0.8123, 4, 6, 1_900_000, 7.8],
  ['XAU', 'Gold', 'Commodities', 'Metals', 2674.3, 2, 8, 18_200_000, 0.64],
  ['EUR', 'Euro / US Dollar', 'Forex', 'Majors', 1.11482, 5, 8, 9_600_000, -0.12],
  ['USDJPY', 'US Dollar / Japanese Yen', 'Forex', 'Majors', 147.214, 3, 8, 7_200_000, 0.21],
  ['NVDA', 'NVIDIA', 'Stocks', 'Companies', 124.92, 2, 8, 12_400_000, 3.28],
  ['SPY', 'SPDR S&P 500 ETF', 'Stocks', 'Index ETFs', 773.61, 2, 8, 4_300_000, 0.42],
];
export function market([symbol, name, category, subcategory, price, priceDecimals, indexTokenDecimals, volume, change], now = Date.now()) {
  const marketToken = fakeKey(`market:${symbol}`);
  const pure = symbol !== 'FARTCOIN';
  return {
    symbol, pair: symbol === 'USDJPY' ? 'USD / JPY' : `${symbol} / USD`, name, category, subcategory, marketToken,
    pools: [{ marketToken, name: `${symbol}/USD[${pure ? 'USDC-USDC' : 'WSOL-USDC'}]`, pure, longToken: pure ? USDC_MINT.toBase58() : fakeKey('wsol'), shortToken: USDC_MINT.toBase58() }],
    tradable: pure, ...(pure ? {} : { unavailableReason: 'Not available for funded trading: GMTrade has no USDC-only pool for this market' }),
    price: price.toFixed(priceDecimals), priceDecimals, indexTokenDecimals, change24h: change, volume24h: String(volume),
    openInterestLong: String(volume * 0.21), openInterestShort: String(volume * 0.13), fundingRateHourlyLong: 0.0012, borrowRateHourlyLong: 0.0008, borrowRateHourlyShort: 0,
    capacityLong: String(volume * 0.02), capacityShort: String(volume * 0.013), poolLiquidity: String(volume * 0.009),
    maxLeverage: { Crypto: 25, Forex: 20, Commodities: 15, Stocks: 8 }[category], closedMaxLeverage: ['Forex', 'Stocks'].includes(category) ? 8 : null,
    session: symbol === 'NVDA' ? 'closed' : 'open', ...(category === 'Stocks' ? { sessionNote: 'US regular market hours, Mon–Fri 9:30–16:00 New York time' } : {}),
    freshness: 'live', updatedAt: now,
  };
}
/** What an order passes as its market (app/src/lib/chain.ts MarketRef) for one of the fixture markets. */
export const marketRef = symbol => ({ marketToken: fakeKey(`market:${symbol}`), symbol });
/** A fixture market as the chain has it: its MarketConfig, the GMTrade Market that config pins, and its index token mint. */
function onchainMarket(m) {
  const gmMarket = fakeKey(`gm-market:${m.symbol}`), indexMint = fakeKey(`index-token:${m.symbol}`);
  const symbol = Buffer.alloc(16);
  symbol.write(m.symbol);
  const config = encodeAccount('marketConfig', {
    marketToken: new PublicKey(m.marketToken), gmMarket: new PublicKey(gmMarket), enabled: m.tradable, indexSymbol: [...symbol], maxLeverageBps: m.maxLeverage * 10_000,
    closedMaxLeverageBps: (m.closedMaxLeverage ?? m.maxLeverage) * 10_000, maxPositionUsd: new BN(10_000_000_000), maxTotalOiUsd: new BN(100_000_000_000),
    oiLongUsd: new BN(0), oiShortUsd: new BN(0), sessionRestricted: m.closedMaxLeverage !== null, bump: 255,
  });
  const market = Buffer.alloc(MARKET_LAYOUT.store + 32);
  Buffer.from(MARKET_DISCRIMINATOR).copy(market);
  for (const [key, at] of [[m.marketToken, MARKET_LAYOUT.marketToken], [indexMint, MARKET_LAYOUT.indexToken], [m.pools[0].longToken, MARKET_LAYOUT.longToken], [m.pools[0].shortToken, MARKET_LAYOUT.shortToken]]) new PublicKey(key).toBuffer().copy(market, at);
  const mint = Buffer.alloc(82);
  mint[44] = m.indexTokenDecimals;
  mint[45] = 1; // initialized
  return [
    [marketConfigPda(new PublicKey(m.marketToken)).toBase58(), { owner: PROGRAM_ID, data: config }],
    [gmMarket, { owner: GMTRADE, data: market }],
    [indexMint, { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: mint }],
  ];
}
const STEP = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1D': 86_400 };
export function candles(m, interval) {
  const step = STEP[interval], end = Math.floor(Date.now() / 1000 / step) * step, last = Number(m.price);
  return Array.from({ length: 120 }, (_, i) => {
    const drift = k => last * (1 + Math.sin((k + 1) * 0.37) * 0.004 - (119 - k) * 0.0001);
    const open = drift(i - 1), close = i === 119 ? last : drift(i);
    return { time: end - (119 - i) * step, open, high: Math.max(open, close) * 1.0006, low: Math.min(open, close) * 0.9994, close };
  });
}

// ---------- per-wallet accounts ----------
const rules = (size, target) => ({
  sizeUsd: String(size), lossAllowanceUsd: String(size * 0.05), floorUsd: String(size * 0.95), profitTargetUsd: target ? String(size * 0.08) : null,
  maxExposureUsd: String(size), traderShareBps: 8000, drawdownType: 'static', includesOpenPnl: true, dailyLossLimit: null, timeLimit: null,
  termsHash: target === null ? null : 'a1b2c3d4'.repeat(8), version: target === null ? null : 1,
});
function summary(base) {
  return {
    status: 'active', realizedPnl: '0', unrealizedPnl: '0', openNotional: '0', targetProgressPct: null, eligiblePayout: null,
    activatedAt: null, resolvedAt: null, evidence: {}, freshness: 'live', ...base,
  };
}

function createWallet(state, wallet) {
  const owner = new PublicKey(wallet);
  const evalFunded = evaluationPda(owner, 0).toBase58();
  const evalActive = evaluationPda(owner, 1).toBase58();
  const funded = fundedPda(new PublicKey(evalFunded)).toBase58();
  const now = Date.now();
  const short = id => `PT-${id.slice(0, 4)}…`;
  const w = {
    wallet, funded, evalActive, kyc: 'verified', orderSeq: 4, payoutSeq: 1, nextId: 1,
    accounts: [
      summary({ id: `practice:${wallet}`, stage: 'practice', label: 'Practice account', shortId: 'PRACTICE', rules: rules(25_000, null), equity: '25000', allowanceRemaining: '1250', availableMargin: '1250', createdAt: now - 9 * DAY }),
      summary({ id: evalActive, stage: 'evaluation', label: 'Evaluation 25K', shortId: short(evalActive), rules: rules(25_000, true), equity: '26185.25', realizedPnl: '992.73', unrealizedPnl: '192.52', allowanceRemaining: '2435.25', availableMargin: '2242.73', openNotional: '4600', targetProgressPct: 59.3, createdAt: now - 6 * DAY, evidence: { evaluation: evalActive, purchaseSignature: fakeSignature(`buy:${evalActive}`) } }),
      summary({ id: evalFunded, stage: 'evaluation', status: 'passed', label: 'Evaluation 25K', shortId: short(evalFunded), rules: rules(25_000, true), equity: '27064.10', realizedPnl: '2064.10', allowanceRemaining: '3314.10', availableMargin: '3314.10', targetProgressPct: 103.2, createdAt: now - 30 * DAY, resolvedAt: now - 20 * DAY, evidence: { evaluation: evalFunded, purchaseSignature: fakeSignature(`buy:${evalFunded}`), resultSignature: fakeSignature(`result:${evalFunded}`) } }),
      summary({ id: funded, stage: 'funded', label: 'Funded 25K', shortId: short(funded), rules: rules(25_000, null), equity: '25312.50', realizedPnl: '312.50', allowanceRemaining: '1562.50', availableMargin: '1562.50', eligiblePayout: '250', createdAt: now - 19 * DAY, activatedAt: now - 19 * DAY, evidence: { evaluation: evalFunded, funded, owner: fakeKey(`owner:${funded}`), activationSignature: fakeSignature(`activate:${funded}`) } }),
    ],
    positions: { [evalActive]: [], [funded]: [], [`practice:${wallet}`]: [] },
    orders: { [evalActive]: [], [funded]: [], [`practice:${wallet}`]: [] },
    history: { [evalActive]: [], [funded]: [], [`practice:${wallet}`]: [] },
    payouts: [],
    notifications: [
      { id: '6f0c5d0e-0000-4000-8000-000000000001', title: 'Order executed', body: 'SOL long · Evaluation 25K', href: '/trade/evaluation', ts: now - 12 * 60_000, read: false, kind: 'fill' },
      { id: '6f0c5d0e-0000-4000-8000-000000000002', title: 'Payout paid', body: '250.00 USDC sent to your wallet', href: '/payouts', ts: now - 2 * DAY, read: true, kind: 'payout' },
    ],
  };
  const sol = state.markets.find(m => m.symbol === 'SOL');
  w.positions[evalActive].push({ id: 'pos-sol', symbol: 'SOL', side: 'Long', sizeUsd: '4600', sizeTokens: '30.2944', collateralUsd: '1533.33', leverage: 3, entryPrice: '145.49', markPrice: sol.price, liquidationPrice: '98.12', unrealizedPnl: '192.52', pendingFeesUsd: '0.84', takeProfit: { price: '168', orderId: 'tp-sol', status: 'awaiting_price' }, stopLoss: null, openedAt: now - 5 * HOUR, venue: 'simulated' });
  w.orders[evalActive].push({ id: 'ord-eth', symbol: 'ETH', side: 'Long', kind: 'Limit', isIncrease: true, sizeUsd: '3000', collateralUsd: '1000', triggerPrice: '2580', acceptablePrice: null, status: 'awaiting_price', createdAt: now - 3 * HOUR, updatedAt: now - 3 * HOUR });
  for (const [i, [symbol, side, pnl]] of [['BTC', 'Long', '73.25'], ['XAU', 'Short', '36.20'], ['ETH', 'Long', '-49.86']].entries())
    w.history[evalActive].push({ id: `trade-${i}`, symbol, side, openedAt: now - (i + 2) * DAY, closedAt: now - (i + 1) * DAY, sizeUsd: '5200', entryPrice: '100', exitPrice: '101', feesUsd: '3.12', netPnl: pnl, venue: 'simulated', signatures: [] });
  w.history[funded].push({ id: 'funded-trade-0', symbol: 'BTC', side: 'Long', openedAt: now - 3 * DAY, closedAt: now - 2 * DAY, sizeUsd: '8200', entryPrice: '63842.5', exitPrice: '64412.8', feesUsd: '4.92', netPnl: '312.50', venue: 'gmtrade', signatures: [fakeSignature('funded-open'), fakeSignature('funded-close')] });
  w.payouts.push(payout(w, 0, 'paid', now - 2 * DAY));
  w.payoutSeq = 1;
  state.wallets.set(wallet, w);
  state.accounts.set(traderProfilePda(owner).toBase58(), { owner: PROGRAM_ID, encode: () => encodeAccount('traderProfile', { wallet: owner, identityHash: Array(32).fill(7), verifiedAt: new BN(0), activeFunded: 1, evaluationCount: 2, bump: 255 }) });
  state.accounts.set(funded, { owner: PROGRAM_ID, encode: () => encodeAccount('fundedAccount', fundedAccount(w)) });
  return w;
}

function fundedAccount(w) {
  const free = { marketToken: PublicKey.default, gmPosition: PublicKey.default, isLong: false, collateral: new BN(0), sizeUsd: new BN(0), pendingUsd: new BN(0), lastSync: new BN(0) };
  const noOrder = { order: PublicKey.default, slot: 0, orderType: { market: {} }, sizeUsd: new BN(0), collateral: new BN(0), placedByRisk: false };
  return {
    trader: new PublicKey(w.wallet), evaluation: evaluationPda(new PublicKey(w.wallet), 0),
    terms: { sizeUsd: new BN(25_000_000_000), profitTargetBps: 800, maxDrawdownBps: 500, maxExposureBps: 10_000, traderShareBps: 8000, termsHash: Array(32).fill(1), tierVersion: 1 },
    principal: new BN(1_250_000_000), status: { active: {} },
    slots: Array.from({ length: 8 }, (_, i) => w.slots?.[i] ?? free), orders: Array.from({ length: 8 }, (_, i) => w.tracked?.[i] ?? noOrder), orderSeq: new BN(w.orderSeq),
    payoutsPaid: new BN(250_000_000), payoutSeq: w.payoutSeq, createdAt: new BN(0), lastSyncAt: new BN(0), bump: 255, ownerBump: 255,
  };
}

function payout(w, seq, status, requestedAt) {
  return {
    id: payoutPda(new PublicKey(w.funded), seq).toBase58(), account: w.funded, accountLabel: 'Funded 25K', seq, status,
    balanceAtRequest: '1562.50', profit: '312.50', traderAmount: '250', vaultAmount: '62.50', networkFeeSol: status === 'paid' ? '0.000005' : null,
    destination: w.wallet, requestedAt, resolvedAt: status === 'paid' ? requestedAt + HOUR : null,
    requestSignature: fakeSignature(`payout-request:${w.funded}:${seq}`), ...(status === 'paid' ? { paySignature: fakeSignature(`payout-pay:${w.funded}:${seq}`) } : {}),
  };
}

const gmPositionData = sizeUsd => {
  const data = Buffer.alloc(POSITION_LAYOUT.length);
  Buffer.from(POSITION_DISCRIMINATOR).copy(data, 0);
  data.writeBigUInt64LE(sizeUsd & ((1n << 64n) - 1n), POSITION_LAYOUT.sizeInUsd);
  data.writeBigUInt64LE(sizeUsd >> 64n, POSITION_LAYOUT.sizeInUsd + 8);
  return data;
};

// ---------- server ----------
export async function startStub() {
  const state = {
    genesis: MAINNET_GENESIS, streamUp: true, streamDelayMs: 0, sessions: new Map(), nonces: new Map(), streams: new Set(), logouts: 0, signatures: 0,
    markets: MARKETS.map(m => market(m)), wallets: new Map(), accounts: new Map(), statuses: new Map(), sent: [], simulationLogs: null, simulations: 0, blockHeight: 10, trustKeys: new Map(),
  };
  for (const t of TIERS) state.accounts.set(tierPda(t.id).toBase58(), { owner: PROGRAM_ID, encode: () => tierAccount(t) });
  for (const m of state.markets) for (const [address, account] of onchainMarket(m)) state.accounts.set(address, account);
  const walletData = wallet => state.wallets.get(wallet) ?? createWallet(state, wallet);
  const publish = (event, wallet) => { for (const s of state.streams) if (!wallet || s.wallet === wallet) s.res.write(`data: ${JSON.stringify(event)}\n\n`); };
  const account = (w, id) => w.accounts.find(a => a.id === id);
  const later = (ms, fn) => setTimeout(fn, ms).unref();

  function simFill(w, id, order) {
    later(1500, () => {
      const m = state.markets.find(x => x.symbol === order.symbol);
      order.status = 'executed';
      order.updatedAt = Date.now();
      w.positions[id].push({ id: `pos-${order.id}`, symbol: order.symbol, side: order.side, sizeUsd: order.sizeUsd, sizeTokens: String(Number(order.sizeUsd) / Number(m.price)), collateralUsd: order.collateralUsd, leverage: Number(order.sizeUsd) / Number(order.collateralUsd), entryPrice: m.price, markPrice: m.price, liquidationPrice: null, unrealizedPnl: '0', pendingFeesUsd: '0', takeProfit: null, stopLoss: null, openedAt: Date.now(), venue: 'simulated' });
      publish({ type: 'orders', accountId: id, orders: w.orders[id] }, w.wallet);
      publish({ type: 'positions', accountId: id, positions: w.positions[id] }, w.wallet);
    });
  }

  /** Applies a confirmed props_vault transaction the way the indexer and GMTrade's keeper would. */
  function applyTransaction(w, tx, signature) {
    const keys = tx.message.staticAccountKeys.map(k => k.toBase58());
    for (const ix of tx.message.compiledInstructions) {
      if (keys[ix.programIdIndex] !== PROGRAM_ID) continue;
      const decoded = client.program.coder.instruction.decode(Buffer.from(ix.data));
      const accountAt = (name, name2 = decoded.name) => keys[ix.accountKeyIndexes[accountIndex(name2.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), name)]];
      state.sent.push({ signature, name: decoded.name, data: decoded.data, wallet: w.wallet });
      if (decoded.name === 'buyEvaluation') {
        const id = evaluationPda(new PublicKey(w.wallet), decoded.data.index).toBase58();
        later(1000, () => w.accounts.push(summary({ id, stage: 'evaluation', label: 'Evaluation 10K', shortId: `PT-${id.slice(0, 4)}…`, rules: rules(10_000, true), equity: '10000', allowanceRemaining: '500', availableMargin: '500', targetProgressPct: 0, createdAt: Date.now(), evidence: { evaluation: id, purchaseSignature: signature } })));
      }
      if (decoded.name === 'openPosition' || decoded.name === 'closePosition') {
        const order = accountAt('gm_order'), position = accountAt('gm_position');
        const increase = decoded.name === 'openPosition';
        w.orderSeq += 1;
        state.accounts.set(order, { owner: GMTRADE, data: Buffer.alloc(8) });
        later(1500, () => {
          state.accounts.delete(order);
          const before = state.accounts.get(position)?.data.readBigUInt64LE(POSITION_LAYOUT.sizeInUsd) ?? 0n; // sizes here fit in 64 bits
          const size = before + BigInt(decoded.data.args.sizeDeltaUsd.toString());
          state.accounts.set(position, { owner: GMTRADE, data: gmPositionData(increase ? size : 0n) });
          const btc = state.markets.find(m => m.symbol === 'BTC');
          w.positions[w.funded] = increase ? [{ id: position, symbol: 'BTC', side: decoded.data.args.isLong ? 'Long' : 'Short', sizeUsd: String(size / 10n ** 20n), sizeTokens: String(Number(size / 10n ** 20n) / Number(btc.price)), collateralUsd: String(Number(decoded.data.args.collateral) / 1e6), leverage: 5, entryPrice: btc.price, markPrice: btc.price, liquidationPrice: null, unrealizedPnl: '0', pendingFeesUsd: '0', takeProfit: null, stopLoss: null, openedAt: Date.now(), venue: 'gmtrade', gmPosition: position }] : [];
          publish({ type: 'positions', accountId: w.funded, positions: w.positions[w.funded] }, w.wallet);
        });
      }
      if (decoded.name === 'requestPayout') {
        w.payouts.unshift({ ...payout(w, w.payoutSeq, 'requested', Date.now()), requestSignature: signature });
        w.payoutSeq += 1;
      }
    }
  }

  async function rpc(body) {
    const [first, second] = body.params ?? [];
    const context = { slot: 1 };
    const info = async address => {
      const a = state.accounts.get(address);
      if (!a) return null;
      const data = a.encode ? a.encode() : a.data;
      return { data: [data.toString('base64'), 'base64'], executable: false, lamports: 2_000_000, owner: a.owner, rentEpoch: 0, space: data.length };
    };
    switch (body.method) {
      case 'getGenesisHash': return state.genesis;
      case 'getLatestBlockhash': return { context, value: { blockhash: bs58.encode(randomBytes(32)), lastValidBlockHeight: state.blockHeight + 150 } };
      case 'getBlockHeight': return state.blockHeight;
      case 'getFeeForMessage': return { context, value: 5000 };
      case 'getMinimumBalanceForRentExemption': return (128 + first) * 6960;
      case 'getAccountInfo': return { context, value: await info(first) };
      case 'getMultipleAccounts': return { context, value: await Promise.all(first.map(info)) };
      case 'simulateTransaction': {
        state.simulations += 1;
        if (state.simulationLogs) { const logs = state.simulationLogs; state.simulationLogs = null; return { context, value: { err: { InstructionError: [1, { Custom: 0 }] }, logs, accounts: null, unitsConsumed: 20_000, returnData: null } }; }
        const { units, limit } = compute(VersionedTransaction.deserialize(Buffer.from(first, 'base64')));
        if (units > limit) return { context, value: { ...overBudget(limit), accounts: null, unitsConsumed: limit, returnData: null } };
        return { context, value: { err: null, logs: [`Program ${PROGRAM_ID} success`], accounts: null, unitsConsumed: units, returnData: null } };
      }
      case 'sendTransaction': {
        const tx = VersionedTransaction.deserialize(Buffer.from(first, 'base64'));
        const { units, limit } = compute(tx);
        if (units > limit) throw Object.assign(new Error('Transaction simulation failed: Error processing Instruction 1: Computational budget exceeded'), { code: -32002, data: overBudget(limit) });
        const signer = tx.message.staticAccountKeys[0].toBase58();
        const valid = verify(null, Buffer.from(tx.message.serialize()), createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, bs58.decode(signer)]), format: 'der', type: 'spki' }), Buffer.from(tx.signatures[0]));
        if (!valid) throw Object.assign(new Error('Transaction signature verification failure'), { code: -32003 });
        const signature = bs58.encode(tx.signatures[0]);
        state.statuses.set(signature, { slot: 2, confirmations: null, err: null, confirmationStatus: 'confirmed' });
        applyTransaction(walletData(signer), tx, signature);
        return signature;
      }
      case 'getSignatureStatuses': return { context, value: first.map(sig => state.statuses.get(sig) ?? null) };
      default: throw Object.assign(new Error(`Method not found: ${body.method}`), { code: -32601 });
    }
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }
  const notFound = res => send(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
  const verifySignature = (wallet, message, signature) => verify(null, Buffer.from(message),
    createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, bs58.decode(wallet)]), format: 'der', type: 'spki' }), bs58.decode(signature));

  const server = createServer(async (req, res) => {
    if (req.headers.origin) {
      res.setHeader('access-control-allow-origin', req.headers.origin);
      res.setHeader('access-control-allow-credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      // Echo requested headers: @solana/web3.js adds a solana-client header, which real RPC providers allow.
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT, DELETE', 'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '' });
      return res.end();
    }
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const cookie = /props_session=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    const wallet = cookie && state.sessions.get(cookie);
    const url = new URL(req.url, 'http://stub');
    const route = `${req.method} ${url.pathname}`;
    const w = wallet && walletData(wallet);
    const needWallet = () => { if (!w) send(res, 401, { error: { code: 'unauthorized', message: 'Sign in required.' } }); return !w; };
    let match;

    if (route === 'POST /rpc') {
      try { return send(res, 200, { jsonrpc: '2.0', id: body.id, result: await rpc(body) }); } catch (error) { return send(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: error.code ?? -32000, message: error.message, ...(error.data ? { data: error.data } : {}) } }); }
    }
    switch (route) {
      case 'GET /v1/config':
        return send(res, 200, {
          cluster: 'mainnet-beta', programId: PROGRAM_ID, usdcMint: USDC_MINT.toBase58(), gmtradeStore: 'CTDLvGGXnoxvqLyTpGzdGLg9pD6JexKxKXSV8tqqo8bN',
          tiers: TIERS,
          traderShareBps: 8000, minPayoutUsdc: '50', paused: { newEvaluations: false, trading: false, payouts: false }, feeVault: feeVaultPda().toBase58(), capitalVault: capitalVaultAddress().toBase58(),
        });
      case 'POST /v1/auth/nonce': {
        const nonce = randomBytes(8).toString('hex');
        state.nonces.set(nonce, body.wallet);
        // The server's message for the app that asks (APP_ORIGIN is the app's origin there), on the stub's cluster.
        const origin = req.headers.origin ?? 'http://127.0.0.1';
        const issuedAt = new Date();
        const message = buildSiwsMessage({
          domain: new URL(origin).host, address: body.wallet, statement: SIWS_STATEMENT, uri: origin, chainId: 'mainnet', nonce, issuedAt,
          expirationTime: new Date(issuedAt.getTime() + 300_000),
        });
        return send(res, 200, { message, nonce, expiresAt: issuedAt.getTime() + 300_000 });
      }
      case 'POST /v1/auth/verify': {
        const nonce = /Nonce: (\w+)/.exec(body.message)?.[1];
        const valid = state.nonces.get(nonce) === body.wallet && verifySignature(body.wallet, body.message, body.signature);
        state.nonces.delete(nonce);
        if (!valid) return send(res, 401, { error: { code: 'bad_signature', message: 'The signature did not verify.' } });
        const session = randomBytes(16).toString('hex');
        state.sessions.set(session, body.wallet);
        return send(res, 200, { wallet: body.wallet, expiresAt: Date.now() + 7 * DAY }, { 'set-cookie': `props_session=${session}; HttpOnly; SameSite=Lax; Path=/` });
      }
      case 'POST /v1/auth/logout':
        state.logouts += 1;
        state.sessions.delete(cookie);
        return send(res, 204, undefined, { 'set-cookie': 'props_session=; Max-Age=0; Path=/' });
      case 'GET /v1/me':
        return w ? send(res, 200, { wallet, kyc: w.kyc, profile: traderProfilePda(new PublicKey(wallet)).toBase58(), usdcBalance: '1234.5', solBalance: '0.25' }) : send(res, 401, { error: { code: 'unauthorized', message: 'Sign in required.' } });
      case 'POST /v1/kyc/start':
        if (needWallet()) return;
        w.kyc = 'pending';
        return send(res, 200, { kyc: 'pending' });
      case 'GET /v1/stream': {
        if (!state.streamUp) return send(res, 503, { error: { code: 'unavailable', message: 'Stream down.' } });
        if (state.streamDelayMs) await new Promise(resolve => setTimeout(resolve, state.streamDelayMs)); // a slow cold start
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        const beat = () => res.write(`data: ${JSON.stringify({ type: 'heartbeat', ts: Date.now() })}\n\n`);
        beat();
        const timer = setInterval(beat, 2_000);
        const stream = { res, wallet };
        state.streams.add(stream);
        req.on('close', () => { clearInterval(timer); state.streams.delete(stream); });
        return;
      }
      case 'GET /v1/markets': return send(res, 200, state.markets);
      case 'GET /v1/candles': {
        const m = state.markets.find(x => x.symbol === url.searchParams.get('symbol'));
        return m ? send(res, 200, { symbol: m.symbol, interval: url.searchParams.get('interval'), candles: candles(m, url.searchParams.get('interval')), source: 'gmtrade', freshness: 'live' }) : notFound(res);
      }
      case 'GET /v1/quote': {
        const m = state.markets.find(x => x.symbol === url.searchParams.get('symbol'));
        const size = Number(url.searchParams.get('sizeUsd'));
        return send(res, 200, { symbol: m.symbol, side: url.searchParams.get('side'), sizeUsd: size.toFixed(6), priceImpactPct: size / 1e7, openFeeUsd: (size * 0.0006).toFixed(6), executionPrice: (Number(m.price) * (1 + size / 1e9)).toFixed(m.priceDecimals) });
      }
      case 'GET /v1/notifications': return needWallet() || send(res, 200, w.notifications);
      case 'POST /v1/notifications/read':
        if (needWallet()) return;
        for (const n of w.notifications) if (!body.ids || body.ids.includes(n.id)) n.read = true;
        return send(res, 200, { updated: w.notifications.length });
      case 'GET /v1/accounts': return needWallet() || send(res, 200, w.accounts);
      case 'POST /v1/practice/reset': {
        if (needWallet()) return;
        const practice = account(w, `practice:${wallet}`);
        w.positions[practice.id] = [];
        w.orders[practice.id] = [];
        return send(res, 200, practice);
      }
      case 'GET /v1/payouts': return needWallet() || send(res, 200, w.payouts);
      case 'GET /v1/vault': {
        const now = Date.now();
        return send(res, 200, {
          programId: PROGRAM_ID, capitalVault: capitalVaultAddress().toBase58(), feeVault: feeVaultPda().toBase58(), solTreasury: fakeKey('sol-treasury'),
          capitalUsdc: '48750', allocatedPrincipal: '1250', unallocated: '48750', feeVaultUsdc: '228', pendingPayouts: '0', fundedAccounts: 1, solTreasurySol: '4.5',
          totals: { feesCollected: '377', payoutsPaid: '250', profitToVault: '62.5' },
          series: Array.from({ length: 30 }, (_, i) => ({ ts: now - (29 - i) * DAY, capitalUsdc: String(i < 10 ? 40_000 : 50_000 - (i > 11 ? 1250 : 0)) })),
          ledger: [
            { id: 'l1', event: 'Funding allocation', account: fakeKey('funded-ledger'), amountUsd: '1250', direction: 'out', ts: now - 19 * DAY, signature: fakeSignature('ledger-1') },
            { id: 'l2', event: 'Seed capital added', amountUsd: '10000', direction: 'in', ts: now - 20 * DAY, signature: fakeSignature('ledger-2') },
          ],
          freshness: 'live', updatedAt: now,
        });
      }
      case 'GET /v1/verify': {
        const q = url.searchParams.get('q') ?? '';
        const base = { query: q };
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(q)) return send(res, 200, { ...base, kind: 'unsupported', title: 'Unsupported identifier', items: [] });
        const owner = [...state.wallets.values()].find(x => x.funded === q);
        if (!owner) return send(res, 200, { ...base, kind: 'not_found', title: 'No record', items: [] });
        return send(res, 200, {
          ...base, kind: 'funded', title: 'Funded 25K',
          items: [
            { title: 'Evaluation purchased', description: '149 USDC fee paid to the fee vault.', state: 'confirmed', signature: fakeSignature(`buy:${evaluationPda(new PublicKey(owner.wallet), 0).toBase58()}`), slot: 311_000_001, ts: Date.now() - 30 * DAY, establishes: 'The wallet bought this evaluation under terms version 1.' },
            { title: 'Evaluation trades', description: 'Simulated fills, committed onchain as a hash when the evaluation ended.', state: 'simulated', ts: Date.now() - 20 * DAY, establishes: 'The fill list cannot be changed after the result was recorded. It does not prove the fills were at fair prices.' },
            { title: 'Funded account activated', description: '1,250 USDC loss allowance posted from the capital vault.', state: 'confirmed', address: q, signature: fakeSignature(`activate:${q}`), slot: 311_500_000, ts: Date.now() - 19 * DAY, establishes: 'The vault posted exactly the loss allowance to the account.' },
          ],
        });
      }
    }
    if ((match = /^GET \/v1\/payouts\/(\w+)$/.exec(route))) {
      if (needWallet()) return;
      const p = w.payouts.find(x => x.id === match[1]);
      return p ? send(res, 200, p) : notFound(res);
    }
    if ((match = /^GET \/v1\/markets\/(\w+)\/trades$/.exec(route))) {
      const m = state.markets.find(x => x.symbol === match[1]);
      if (!m) return notFound(res);
      return send(res, 200, Array.from({ length: 18 }, (_, i) => ({ id: `${m.symbol}-${i}`, symbol: m.symbol, side: i % 3 ? 'Long' : 'Short', isIncrease: i % 4 !== 1, price: (Number(m.price) * (1 + Math.sin(i) * 0.0002)).toFixed(m.priceDecimals), sizeUsd: String(500 + i * 137), ts: Date.now() - i * 3_000 })));
    }
    if ((match = /^GET \/v1\/accounts\/([^/]+)(?:\/(\w[\w-]*))?$/.exec(route))) {
      if (needWallet()) return;
      const id = decodeURIComponent(match[1]);
      const a = account(w, id);
      if (!a) return notFound(res);
      const now = Date.now();
      switch (match[2]) {
        case undefined: return send(res, 200, { ...a, positions: w.positions[id] ?? [], orders: w.orders[id] ?? [] });
        case 'positions': return send(res, 200, w.positions[id] ?? []);
        case 'orders': return send(res, 200, w.orders[id] ?? []);
        case 'history': return send(res, 200, w.history[id] ?? []);
        case 'activity': return send(res, 200, [
          ...(w.history[id] ?? []).map(t => ({ id: `fill-${t.id}`, type: 'fill', title: `${t.symbol} ${t.side.toLowerCase()} closed`, detail: `Net ${t.netPnl} USD`, ts: t.closedAt, status: 'confirmed', amountUsd: t.sizeUsd, symbol: t.symbol, simulated: t.venue === 'simulated', ...(t.signatures[1] ? { signature: t.signatures[1] } : {}) })),
          { id: 'account-created', type: 'account', title: a.stage === 'funded' ? 'Funded account activated' : 'Account opened', detail: a.label, ts: a.createdAt, status: 'confirmed', simulated: a.stage !== 'funded', ...(a.evidence.activationSignature ? { signature: a.evidence.activationSignature } : {}) },
        ].sort((x, y) => y.ts - x.ts));
        case 'performance': return send(res, 200, {
          period: url.searchParams.get('period'), series: Array.from({ length: 20 }, (_, i) => ({ ts: now - (19 - i) * DAY, equity: String(Number(a.rules.sizeUsd) + i * 50), netPnl: String(i * 50 + (i % 3) * 20) })),
          netPnl: String(Number(a.equity) - Number(a.rules.sizeUsd)), grossRealized: '1055.24', feesUsd: '48.30', fundingBorrowUsd: '14.21', unrealizedPnl: a.unrealizedPnl,
          trades: 3, winRatePct: 66.7, profitFactor: 2.34, averageTradeUsd: '19.86',
          byMarket: [{ symbol: 'BTC', netPnl: '73.25', sharePct: 67 }, { symbol: 'XAU', netPnl: '36.20', sharePct: 33 }],
        });
        case 'payout-eligibility': {
          const flat = !(w.positions[id] ?? []).length && !(w.orders[id] ?? []).length;
          const pendingRequest = w.payouts.some(p => p.status === 'requested');
          const eligible = flat && !pendingRequest;
          return send(res, 200, { account: id, eligible, reasons: eligible ? [] : [pendingRequest ? 'A payout request is already under review.' : 'Close every position and cancel working orders first.'], realizedProfit: '312.50', traderShare: '250', vaultShare: '62.50', minPayout: '50', flat, openPositions: (w.positions[id] ?? []).length, pendingOrders: (w.orders[id] ?? []).length });
        }
        default: return notFound(res);
      }
    }
    if ((match = /^POST \/v1\/sim\/([^/]+)\/orders$/.exec(route))) {
      if (needWallet()) return;
      const id = decodeURIComponent(match[1]);
      const a = account(w, id);
      if (!a || a.stage === 'funded') return notFound(res);
      const order = { id: `sim-${w.nextId++}`, symbol: body.symbol, side: body.side, kind: body.kind, isIncrease: true, sizeUsd: body.sizeUsd, collateralUsd: body.collateralUsd, triggerPrice: body.triggerPrice ?? null, acceptablePrice: null, status: body.kind === 'Market' ? 'awaiting_execution' : 'awaiting_price', createdAt: Date.now(), updatedAt: Date.now() };
      w.orders[id].push(order);
      if (body.kind === 'Market') simFill(w, id, order);
      return send(res, 200, { order, account: a });
    }
    if ((match = /^POST \/v1\/sim\/([^/]+)\/positions\/([^/]+)\/close$/.exec(route))) {
      if (needWallet()) return;
      const id = decodeURIComponent(match[1]);
      const position = (w.positions[id] ?? []).find(p => p.id === decodeURIComponent(match[2]));
      if (!position) return notFound(res);
      later(1000, () => {
        w.positions[id] = w.positions[id].filter(p => p !== position);
        w.history[id].unshift({ id: `closed-${position.id}`, symbol: position.symbol, side: position.side, openedAt: position.openedAt, closedAt: Date.now(), sizeUsd: position.sizeUsd, entryPrice: position.entryPrice, exitPrice: position.markPrice, feesUsd: '1.20', netPnl: position.unrealizedPnl, venue: 'simulated', signatures: [] });
        publish({ type: 'positions', accountId: id, positions: w.positions[id] }, w.wallet);
      });
      return send(res, 200, { order: { id: `close-${position.id}`, symbol: position.symbol, side: position.side, kind: 'Market', isIncrease: false, sizeUsd: position.sizeUsd, collateralUsd: null, triggerPrice: null, acceptablePrice: null, status: 'awaiting_execution', createdAt: Date.now(), updatedAt: Date.now() }, account: account(w, id) });
    }
    if ((match = /^PUT \/v1\/sim\/([^/]+)\/positions\/([^/]+)\/protection$/.exec(route))) {
      if (needWallet()) return;
      const position = (w.positions[decodeURIComponent(match[1])] ?? []).find(p => p.id === decodeURIComponent(match[2]));
      if (!position) return notFound(res);
      position.takeProfit = body.takeProfit ? { price: body.takeProfit, orderId: `tp-${position.id}`, status: 'awaiting_price' } : null;
      position.stopLoss = body.stopLoss ? { price: body.stopLoss, orderId: `sl-${position.id}`, status: 'awaiting_price' } : null;
      return send(res, 200, position);
    }
    if ((match = /^DELETE \/v1\/sim\/([^/]+)\/orders\/([^/]+)$/.exec(route))) {
      if (needWallet()) return;
      const id = decodeURIComponent(match[1]);
      const order = (w.orders[id] ?? []).find(o => o.id === decodeURIComponent(match[2]));
      if (!order) return notFound(res);
      order.status = 'canceled';
      return send(res, 200, { order, account: account(w, id) });
    }
    return notFound(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, state, publish, walletData,
    close: () => { for (const s of state.streams) s.res.destroy(); server.close(); },
  };
}
