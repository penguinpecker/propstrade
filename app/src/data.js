export const money = (value, digits = 2) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
export const number = (value, digits = 2) => new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
export const programs = [
  { size: 10000, fee: 79, name: '10K' },
  { size: 25000, fee: 149, name: '25K' },
  { size: 50000, fee: 249, name: '50K' },
  { size: 100000, fee: 449, name: '100K' },
];
export const markets = [
  { symbol: 'BTC', name: 'Bitcoin', category: 'Crypto', price: 64482.00, change: 2.48, volume: '142.6M', interest: '48.2M', rate: '0.0012%', color: '#bd8238' },
  { symbol: 'ETH', name: 'Ethereum', category: 'Crypto', price: 2641.82, change: 1.86, volume: '86.4M', interest: '26.1M', rate: '0.0008%', color: '#7b79a4' },
  { symbol: 'SOL', name: 'Solana', category: 'Crypto', price: 151.84, change: 4.12, volume: '42.8M', interest: '18.5M', rate: '0.0016%', color: '#756193' },
  { symbol: 'XAU', name: 'Gold', category: 'Commodities', price: 2674.30, change: 0.64, volume: '18.2M', interest: '7.6M', rate: '0.0004%', color: '#aa8b37' },
  { symbol: 'EUR', name: 'Euro / US Dollar', category: 'Forex', price: 1.11482, change: -0.12, volume: '9.6M', interest: '3.4M', rate: '0.0002%', color: '#59749a' },
  { symbol: 'AAPL', name: 'Apple', category: 'Stocks', price: 226.47, change: -0.84, volume: '6.2M', interest: '2.1M', rate: '0.0005%', color: '#72706e' },
  { symbol: 'NVDA', name: 'NVIDIA', category: 'Stocks', price: 124.92, change: 3.28, volume: '12.4M', interest: '4.8M', rate: '0.0007%', color: '#61825b' },
  { symbol: 'GBP', name: 'Pound / US Dollar', category: 'Forex', price: 1.32621, change: 0.23, volume: '4.8M', interest: '1.9M', rate: '0.0003%', color: '#776384' },
];
export const initialPositions = [
  { id: 'pos-1', symbol: 'BTC', side: 'Long', quantity: .125, entry: 63395, leverage: 5, stop: 62150, take: 67500 },
  { id: 'pos-2', symbol: 'SOL', side: 'Long', quantity: 12, entry: 147.12, leverage: 3, stop: 141.50, take: 168 },
];
export const initialOrders = [
  { id: 'ord-1047', symbol: 'ETH', side: 'Long', type: 'Limit', quantity: 1.5, price: 2580, leverage: 3, status: 'Awaiting price' },
];
export const history = [
  { id: 'PT-1046', symbol: 'BTC', side: 'Long', time: 'Today, 10:42:18', size: 8200, entry: 63842.50, exit: 64412.80, pnl: 73.25, fee: 4.92 },
  { id: 'PT-1045', symbol: 'SOL', side: 'Long', time: 'Today, 09:16:04', size: 4600, entry: 146.82, exit: 151.32, pnl: 141.00, fee: 2.76 },
  { id: 'PT-1044', symbol: 'XAU', side: 'Short', time: 'Yesterday, 15:38:22', size: 6800, entry: 2686.40, exit: 2672.10, pnl: 36.20, fee: 4.08 },
  { id: 'PT-1043', symbol: 'ETH', side: 'Long', time: 'Yesterday, 12:09:41', size: 5200, entry: 2664.15, exit: 2638.60, pnl: -49.86, fee: 3.12 },
  { id: 'PT-1042', symbol: 'BTC', side: 'Long', time: 'Sep 21, 14:24:08', size: 12400, entry: 62048.00, exit: 63129.50, pnl: 216.14, fee: 7.44 },
  { id: 'PT-1041', symbol: 'SOL', side: 'Short', time: 'Sep 21, 11:03:56', size: 3500, entry: 149.20, exit: 146.10, pnl: 72.72, fee: 2.10 },
];
export const accounts = {
  funded: { id: 'PT-002841', stage: 'Funded', size: 25000, equity: 26742.50, profit: 1742.50, realized: 1549.98, headroom: 2992.50, target: null, floor: 23750, label: 'Funded 25K' },
  evaluation: { id: 'PT-003192', stage: 'Evaluation', size: 25000, equity: 26185.25, profit: 1185.25, realized: 992.73, headroom: 2435.25, target: 2000, floor: 23750, label: 'Evaluation 25K' },
  practice: { id: 'PRACTICE', stage: 'Practice', size: 25000, equity: 25000, profit: 0, realized: 0, headroom: 1250, target: null, floor: 23750, label: 'Practice account' },
};
export const screens = [
  { id: '01', name: 'Get funded', path: '/get-funded', group: 'Onboarding' },
  { id: '02', name: 'Program & rules', path: '/program', group: 'Onboarding' },
  { id: '03', name: 'Connect wallet', path: '/connect', group: 'Onboarding' },
  { id: '04', name: 'USDC checkout', path: '/checkout', group: 'Onboarding' },
  { id: '05', name: 'Account ready', path: '/payment', group: 'Onboarding' },
  { id: '06', name: 'My accounts', path: '/accounts', group: 'Accounts' },
  { id: '07', name: 'Evaluation overview', path: '/account/evaluation', group: 'Accounts' },
  { id: '08', name: 'Evaluation trading', path: '/trade/evaluation', group: 'Trading' },
  { id: '09', name: 'Evaluation result', path: '/result', group: 'Accounts' },
  { id: '10', name: 'Funded activation', path: '/activate', group: 'Accounts' },
  { id: '11', name: 'Funded overview', path: '/account/funded', group: 'Accounts' },
  { id: '12', name: 'Funded trading', path: '/trade/funded', group: 'Trading' },
  { id: '13', name: 'Markets', path: '/markets', group: 'Trading' },
  { id: '14', name: 'Performance', path: '/performance', group: 'Accounts' },
  { id: '15', name: 'Activity', path: '/activity', group: 'Accounts' },
  { id: '16', name: 'Payout overview', path: '/payouts', group: 'Payouts' },
  { id: '17', name: 'Payout review', path: '/payout/review', group: 'Payouts' },
  { id: '18', name: 'Payout receipt', path: '/payout/receipt', group: 'Payouts' },
  { id: '19', name: 'Verify records', path: '/verify', group: 'Transparency' },
  { id: '20', name: 'Vault transparency', path: '/vault', group: 'Transparency' },
  { id: '21', name: 'Preferences', path: '/settings', group: 'Settings' },
  { id: '22', name: 'Practice trading', path: '/trade/practice', group: 'Trading' },
];
export function seriesValues(count = 60, end = 1742.5) {
  return Array.from({ length: count }, (_, i) => ({ time: i, value: Math.round((i / (count - 1) * end + Math.sin(i * .42) * 95 + Math.sin(i * 1.7) * 30) * 100) / 100 }));
}
export function makeCandles(market, interval = '1h') {
  const step = ({ '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1D': 86400 })[interval] || 3600;
  let value = market.price * .968;
  const candles = [];
  const end = 1790164800;
  for (let i = 0; i < 128; i++) {
    const open = value;
    const drift = Math.sin(i * .91 + 1.2) * .00185 + Math.cos(i * .29) * .00124 + .000245;
    const close = open * (1 + drift);
    const high = Math.max(open, close) * (1 + (.00055 + (Math.sin(i * 2.4) + 1) * .0004));
    const low = Math.min(open, close) * (1 - (.00055 + (Math.cos(i * 1.9) + 1) * .0004));
    candles.push({ time: end - (127 - i) * step, open, high, low, close });
    value = close;
  }
  const factor = market.price / candles.at(-1).close;
  return candles.map(c => ({ ...c, open: c.open * factor, high: c.high * factor, low: c.low * factor, close: c.close * factor }));
}
