import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useConnection } from '@solana/wallet-adapter-react';
import { ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, Clock3, FileCheck2, Info, LockKeyhole, ShieldCheck, TriangleAlert, Wallet } from 'lucide-react';
import { useApp, useSaved } from './App.jsx';
import { bpsPercent, explorerTx, isCurrent, number, shortAddress, signedUsd, sol, tierRules, usd } from './data.js';
import { accountHref } from './Workspace.jsx';
import { SignupReferral } from './Referrals.jsx';
import { Badge, Button, UsdcIcon, DataRow, Empty, FullAddress, InlineLink, Notice, PageHeading, Pending, RuleList, SectionHeading, SessionNotice, Steps, Unavailable, WalletOptions } from './ui.jsx';
import { isNotLive } from './lib/api';
import { GOOGLE_ONLY } from './lib/privy';
import { useMe, useStartKyc, useVault } from './lib/queries';
import { isFinalTxError, loadChain, useTxCost, useWalletTransaction } from './lib/transactions';

const TX_LABELS = { preparing: 'Preparing transaction…', signing: 'Approve in your wallet…', submitted: 'Confirming onchain…' };
// ISO 3166-1 alpha-2 codes, without the US and its territories and comprehensively sanctioned countries (spec §1 Geo).
const COUNTRIES = 'AD AE AF AG AI AL AM AO AQ AR AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IS IT JE JM JO JP KE KG KH KI KM KN KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UY UZ VA VC VE VG VN VU WF WS XK YE YT ZA ZM ZW'.split(' ');
/**
 * Countries sanctioned only in part: residents choose their ISO 3166-2 region, which the service checks (Crimea,
 * Sevastopol, Donetsk and Luhansk are refused).
 */
const REGIONS = {
  UA: [['UA-71', 'Cherkasy'], ['UA-74', 'Chernihiv'], ['UA-77', 'Chernivtsi'], ['UA-43', 'Crimea'], ['UA-12', 'Dnipropetrovsk'], ['UA-14', 'Donetsk'],
    ['UA-26', 'Ivano-Frankivsk'], ['UA-63', 'Kharkiv'], ['UA-65', 'Kherson'], ['UA-68', 'Khmelnytskyi'], ['UA-35', 'Kirovohrad'], ['UA-30', 'Kyiv (city)'],
    ['UA-32', 'Kyiv region'], ['UA-09', 'Luhansk'], ['UA-46', 'Lviv'], ['UA-48', 'Mykolaiv'], ['UA-51', 'Odesa'], ['UA-53', 'Poltava'], ['UA-56', 'Rivne'],
    ['UA-40', 'Sevastopol'], ['UA-59', 'Sumy'], ['UA-61', 'Ternopil'], ['UA-05', 'Vinnytsia'], ['UA-07', 'Volyn'], ['UA-21', 'Zakarpattia'],
    ['UA-23', 'Zaporizhzhia'], ['UA-18', 'Zhytomyr']],
};
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const COUNTRY_OPTIONS = COUNTRIES.map(code => [code, regionNames.of(code) ?? code]).sort((a, b) => a[1].localeCompare(b[1]));

function ProgramPicker() {
  const { tiers, tier, setTierId } = useApp();
  return <div className="program-picker" role="group" aria-label="Choose account size">{tiers.map(t => <button key={t.id} aria-pressed={tier?.id === t.id} className={tier?.id === t.id ? 'active' : ''} disabled={!t.enabled} title={t.enabled ? undefined : 'Unavailable for now'} onClick={() => setTierId(t.id)}>${t.name}</button>)}</div>;
}
/** Exact amounts: the fee in USDC from the tier, and the network fee and rent deposit in SOL once the transaction can be built. */
function FeeSummary({ total = true, cost }) {
  const { tier } = useApp();
  const lamports = cost.data ? cost.data.feeLamports + cost.data.rentLamports : null;
  const pending = cost.isError ? 'Unavailable' : cost.fetchStatus === 'idle' && !cost.data ? 'Shown after sign-in' : 'Calculating…';
  return <><DataRow label="Evaluation fee" value={`${number(Number(tier.feeUsdc))} USDC`} /><DataRow label="Network fee" value={cost.data ? sol(cost.data.feeLamports) : pending} /><DataRow label="Account rent deposit" value={cost.data ? sol(cost.data.rentLamports) : pending} />{total && <DataRow className="total" label="Total due" value={<>{number(Number(tier.feeUsdc))} USDC{lamports !== null && <small> + {sol(lamports)}</small>}</>} />}</>;
}
const useEvaluationCost = () => { const { tier, signedIn } = useApp(); return useTxCost(['evaluation', tier?.id, tier?.version, tier?.feeUsdc], (chain, connection, trader) => chain.prepareEvaluation(connection, trader, tier), signedIn && !!tier); };
function ConfigGate({ children }) {
  const { config, tier, tiers, navigate } = useApp();
  if (config.isPending) return <Pending>Loading the evaluation programs…</Pending>;
  if (isNotLive(config.error)) return <Empty icon={Info} title="Evaluations open soon" action={<Button variant="secondary" onClick={() => navigate('/trade/practice')}>Practice with live prices</Button>}>The Props.trade vault program is not live on Solana yet. Evaluations open as soon as it is.</Empty>;
  if (config.isError) return <Unavailable title="Programs are unavailable" error={config.error} retry={config.refetch} />;
  if (!tier) return <Empty icon={Info} title="No evaluation is available right now">{tiers.length ? 'Every account size is currently unavailable. Check back soon.' : 'No evaluation programs are configured yet.'}</Empty>;
  return children;
}

export function FundingPage() {
  const { tier, tiers, config, navigate, accounts, selectAccount } = useApp();
  const unavailable = tiers.filter(t => !t.enabled);
  // A returning trader's account in progress: the funded one first, else the newest current evaluation.
  const resume = ['funded', 'evaluation'].map(stage => accounts.filter(a => a.stage === stage && isCurrent(a, accounts)).sort((a, b) => b.createdAt - a.createdAt)[0]).find(Boolean);
  const activation = resume?.stage === 'evaluation' && resume.status === 'passed';
  return <div className="page funding-page"><Steps active={1} /><div className="funding-layout"><section className="funding-story"><h1>Your edge.<br /><span>More capital.</span></h1><p className="funding-intro">Show what you can do. Pass an evaluation, trade a funded account, and keep {tier ? bpsPercent(tier.traderShareBps) : 'most'} of your profits.</p>{resume && <Notice tone="purple"><span>{activation ? `${resume.label} ${resume.shortId} passed and is ready for funded activation.` : `${resume.label} ${resume.shortId} is in progress.`}</span> <Button small variant="secondary" icon={ArrowRight} onClick={() => activation ? navigate(`/activate?id=${resume.id}`) : selectAccount(resume, 'trade')}>{activation ? 'Continue to activation' : 'Resume trading'}</Button></Notice>}<div className="funding-journey">{[['Prove your process', 'Trade a simulated account with clear, visible rules.'], ['Step into funded trading', 'Put your strategy to work on the exchange with capital from the Props.trade vault.'], ['Keep your share', 'Request eligible profits in USDC. Follow every record.']].map(([title, text], i) => <div key={title}><span>{i + 1}</span><div><h3>{title}</h3><p>{text}</p></div></div>)}</div><div className="funding-bottom"><ShieldCheck size={18} /><span>Built for clarity. From your first trade to your payout.</span></div><a href="#/trade/practice" className="practice-link">Get a feel for the platform first <ArrowUpRight size={15} /></a></section><section className="program-sheet"><div className="program-sheet-title"><h2>Start your evaluation</h2><Badge tone="purple">One step</Badge></div><p>Choose your starting account size.</p><ConfigGate><ProgramPicker />{unavailable.length > 0 && <p className="sheet-footnote">{unavailable.map(t => t.name).join(' and ')} {unavailable.length === 1 ? 'is' : 'are'} unavailable for now.</p>}<div className="program-face"><span>Evaluation balance</span><strong>{usd(tier?.sizeUsd, 0)}</strong><span className="program-face-note">Virtual capital · Real opportunity</span></div><RuleList rules={tier && tierRules(tier)} /><div className="program-price"><span>One-time evaluation fee<small>Paid once, in USDC on Solana</small></span><strong>{usd(tier?.feeUsdc)}<span> USDC</span></strong></div>{config.data?.paused.newEvaluations && <Notice tone="amber">New evaluations are paused for now. Existing accounts are not affected.</Notice>}<Button className="full-width" icon={ArrowRight} onClick={() => navigate('/program')}>Choose {tier?.name} account</Button><p className="sheet-footnote">Review all rules and costs before paying.</p></ConfigGate></section></div><div className="funding-market-line"><span>One workspace. More ways to trade.</span><strong>Crypto</strong><i /><strong>Gold</strong><i /><strong>Forex</strong><i /><strong>Stocks</strong><Badge>Perpetual contracts</Badge></div></div>;
}

export function ProgramPage() {
  const { tier, config, markets, navigate } = useApp();
  const [open, setOpen] = useState('drawdown');
  const cost = useEvaluationCost();
  const rules = tier && tierRules(tier);
  const maxLeverage = Math.max(0, ...markets.filter(m => m.tradable).map(m => m.maxLeverage));
  const share = tier && bpsPercent(tier.traderShareBps);
  const details = rules ? [
    ['target', 'How is the profit target calculated?', `Reach ${usd(rules.profitTargetUsd)} in qualifying profit: realized and open P&L after every trading cost. If positions are still open when you reach it, the result is final once they are closed.`],
    ['drawdown', 'How does the drawdown limit work?', `Your equity must stay above a static floor of ${usd(rules.floorUsd)}. Open P&L and trading costs count toward equity, and gains never move the floor upward.`],
    ['capital', 'What changes after I pass?', `After an identity review, activate a funded account: the Props.trade vault posts your ${usd(rules.lossAllowanceUsd)} loss allowance as USDC and your trades become real positions on the exchange. Evaluation profits are not withdrawable. Funded accounts are not available to US persons or to residents of sanctioned countries and regions. The identity review checks where you live; buying an evaluation does not, so check this before you pay.`],
    ['payout', 'When can I request a payout?', `Whenever your funded account is flat, request your ${share} share of realized profit, at least ${usd(config.data?.minPayoutUsdc)}. After review it is paid in USDC to your wallet, and the account continues with its loss allowance reset.`],
  ] : [];
  return <div className="page"><Steps active={1} /><PageHeading title="Know the rules. Own your process." description="A clear agreement before your first trade." back={{ label: 'Choose an account', href: '#/get-funded' }}>{tier && <Badge tone="purple">Terms v{tier.version}</Badge>}</PageHeading><ConfigGate><div className="checkout-layout"><section><div className="surface rules-main"><SectionHeading>Evaluation terms</SectionHeading><RuleList rules={rules} /><DataRow label="Maximum leverage" value={maxLeverage ? `Up to ${maxLeverage}×, set per market` : 'Set per market'} /><DataRow label="Trading environment" value="Simulated evaluation" /><DataRow label="Payment currency" value="USDC on Solana" /></div><section className="rules-explained"><h2>A few details worth understanding.</h2>{details.map(([id, title, text]) => <div className={`accordion ${open === id ? 'open' : ''}`} key={id}><button aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>{title}<ChevronDown size={16} /></button>{open === id && <p>{text}</p>}</div>)}</section></section><aside className="purchase-summary"><div className="purchase-summary-top"><img src="/brand/symbol.svg" alt="" /><Badge>Evaluation</Badge><h2>{tier?.name} account</h2><p>One clear step toward funded trading.</p></div><div className="purchase-summary-body"><FeeSummary cost={cost} /><Button className="full-width" icon={ArrowRight} onClick={() => navigate('/connect')}>Continue with this account</Button><div className="fine-print"><ShieldCheck size={14} /><span>You review the exact total again before approving it in your wallet.</span></div></div><Notice>These terms are copied into your evaluation onchain when you buy it. Later changes to this program do not affect it.</Notice></aside></div></ConfigGate></div>;
}

export function ConnectPage() {
  const { tier, session, navigate } = useApp();
  const [chosen, setChosen] = useSaved('connect-chosen', false); // saved: Google sign-in reloads the page
  useEffect(() => { if (chosen && session.status === 'signed-in') { setChosen(false); navigate('/checkout'); } }, [chosen, session.status, navigate, setChosen]);
  function choose(name) { setChosen(true); session.connect(name); }
  const usdc = session.me?.usdcBalance;
  return <div className="page connection-page"><Steps active={2} /><div className="connection-layout"><section><div className="wallet-outline"><Wallet size={34} strokeWidth={1.35} /></div><h1>Your account starts<br />with your wallet.</h1><p>One connection for your evaluation, funded account and future USDC payouts.</p><div className="connection-points"><div><Check size={15} /><span>USDC on Solana</span></div><div><Check size={15} /><span>Review every action before signing</span></div><div><Check size={15} /><span>Your identity across every account stage</span></div></div><InlineLink href="#/program">Back to program details</InlineLink></section><section className="surface connect-sheet"><h2>Connect a wallet</h2><p>{GOOGLE_ONLY ? 'Sign in with Google. Props.trade creates your Solana wallet and signs each action you confirm.' : "Pick a Solana wallet, then sign a message to prove it's yours."}</p>{session.status !== 'signed-in' && <SignupReferral />}<WalletOptions session={session} onChoose={choose} /><div className="connect-balance"><DataRow label="USDC balance" value={session.status !== 'signed-in' ? 'Sign in to view' : usdc == null ? 'Unavailable' : `${number(Number(usdc))} USDC`} /><DataRow label="Selected evaluation" value={tier ? `${tier.name} account` : '—'} /><DataRow label="Evaluation fee" value={tier ? `${number(Number(tier.feeUsdc))} USDC` : '—'} /></div><SessionNotice session={session}>{GOOGLE_ONLY ? 'Signing in sends no transaction and costs nothing.' : 'Signing in sends no transaction and costs nothing. You approve every payment separately in your wallet.'}</SessionNotice><div className="connect-privacy"><LockKeyhole size={13} /><span>Wallet connection never requires a recovery phrase.</span></div></section></div></div>;
}

export function CheckoutPage() {
  const { tier, config, session, signedIn, navigate } = useApp();
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useSaved('pending-payment', null);
  const tx = useWalletTransaction();
  const cost = useEvaluationCost();
  const me = session.me;
  const fee = tier ? Number(tier.feeUsdc) : 0;
  const lamports = cost.data ? cost.data.feeLamports + cost.data.rentLamports : null;
  const usdcOk = signedIn && me.usdcBalance != null && Number(me.usdcBalance) >= fee;
  const solOk = signedIn && me.solBalance != null && lamports !== null && Number(me.solBalance) * 1e9 >= lamports;
  const ownPending = signedIn && pending?.wallet === me.wallet ? pending : null;
  const blocked = !tier ? null : config.data?.paused.newEvaluations ? 'New evaluations are paused for now. No payment can be made.' : !tier.enabled ? 'This account size is unavailable.' : session.network.state === 'wrong' ? session.network.reason : null;
  async function pay() {
    if (!accepted || !usdcOk || !solOk || blocked || ownPending) return;
    const result = await tx.run((chain, connection, trader) => chain.prepareEvaluation(connection, trader, tier), { confirm: false });
    if (!result) return;
    const payment = { signature: result.signature, lastValidBlockHeight: result.prepared.lastValidBlockHeight, evaluation: result.prepared.evaluation, tierId: tier.id, wallet: me.wallet };
    setPending(payment);
    navigate(`/payment?sig=${payment.signature}`);
  }
  return <div className="page checkout-page"><Steps active={3} /><PageHeading title="One last look. Then you're in." description="Review your evaluation and the exact amount before continuing." back={{ label: 'Wallet connection', href: '#/connect' }} /><ConfigGate><div className="checkout-layout"><section className="surface checkout-details"><SectionHeading action={<Badge tone="purple">Simulated evaluation</Badge>}>Your {tier?.name} evaluation</SectionHeading><div className="checkout-account"><div><span>Starting balance</span><strong>{usd(tier?.sizeUsd, 0)}</strong></div><img src="/brand/symbol.svg" alt="" /></div><div className="checkout-key-rules"><div><span>Profit target</span><strong>{tier && bpsPercent(tier.profitTargetBps)}</strong></div><div><span>Maximum drawdown</span><strong>{tier && bpsPercent(tier.maxDrawdownBps)}</strong></div><div><span>Time limit</span><strong>None</strong></div></div><Notice>Evaluation profits are simulated and cannot be withdrawn. Passing unlocks the funded activation stage.</Notice><h3>Payment details</h3><DataRow label="Network" value="Solana" /><DataRow label="Currency" value="USDC" /><DataRow label="From">{signedIn ? <>{session.walletName} · <FullAddress address={me.wallet} short /></> : 'No wallet connected'}</DataRow><DataRow label="To" value={config.data ? `Props.trade fee vault · ${shortAddress(config.data.feeVault)}` : '—'} /><DataRow label="Terms" value={tier ? `${tier.name} program · v${tier.version}` : '—'} /></section><aside className="surface checkout-total"><h2>Payment summary</h2>{tier && <FeeSummary cost={cost} />}{usdcOk && <div className="balance-check"><Check size={14} /><span>Your USDC balance covers this payment</span></div>}{signedIn && me.usdcBalance != null && !usdcOk && <p className="field-error">Your wallet holds {number(Number(me.usdcBalance))} USDC. This evaluation costs {number(fee)} USDC.</p>}{signedIn && lamports !== null && !solOk && <p className="field-error">Your wallet needs {sol(lamports)} for the network fee and rent deposit.</p>}{blocked && <Notice tone="amber">{blocked}</Notice>}{cost.error?.name === 'TxError' && <Notice tone="amber">{cost.error.message}</Notice>}{ownPending && <Notice tone="amber">A payment from this wallet is still being confirmed. <InlineLink href={`#/payment?sig=${ownPending.signature}`}>Follow it</InlineLink> before paying again.</Notice>}{tx.phase === 'failed' && <Notice tone="amber" role="alert">{tx.message}</Notice>}<label className="checkout-agreement"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} /><span>I have read the evaluation rules. I understand the evaluation is simulated and its profits cannot be withdrawn.</span></label>{signedIn ? <Button className="full-width" disabled={!accepted || !usdcOk || !solOk || !!blocked || !!ownPending || tx.busy} icon={ArrowRight} onClick={pay}>{tx.busy ? TX_LABELS[tx.phase] : `Pay ${number(fee)} USDC`}</Button> : <Button className="full-width" icon={Wallet} onClick={() => navigate('/connect')}>Connect wallet to pay</Button>}<p className="sheet-footnote">{session.autoSigns ? 'Paying sends exactly this amount from your Google wallet.' : 'Your wallet shows the exact transfer before you approve it.'}</p><div className="payment-method"><UsdcIcon /><span>USDC</span><span className="quiet">on Solana</span><ShieldCheck size={17} /></div></aside></div></ConfigGate></div>;
}

export function PaymentPage() {
  const { query, tiers, accounts, signedIn, navigate, selectAccount } = useApp();
  const [pending, setPending] = useSaved('pending-payment', null);
  const { connection } = useConnection();
  const client = useQueryClient();
  const signature = query.get('sig') ?? pending?.signature ?? null;
  const payment = pending?.signature === signature ? pending : null;
  // Only a proven outcome ends the follow-up: while the network cannot be read, it keeps retrying and the checkout guard stays.
  const confirmation = useQuery({ queryKey: ['payment', signature], queryFn: async () => { await (await loadChain()).confirm(connection, signature, payment?.lastValidBlockHeight ?? Number.MAX_SAFE_INTEGER); return true; }, enabled: !!signature, staleTime: Infinity, retry: (_, error) => !isFinalTxError(error), retryDelay: 3000 });
  const account = accounts.find(a => a.stage === 'evaluation' && (payment ? a.id === payment.evaluation : a.evidence.purchaseSignature === signature));
  const tier = tiers.find(t => t.id === payment?.tierId);
  const failed = confirmation.isError;
  const status = !signature ? -1 : failed ? 1 : account ? 3 : confirmation.isSuccess ? 2 : 1;
  const complete = status === 3;
  useEffect(() => { if ((complete || failed) && payment) setPending(null); }, [complete, failed]);
  useEffect(() => { if (!confirmation.isSuccess || account) return; const timer = setInterval(() => client.invalidateQueries({ queryKey: ['accounts'] }), 3000); return () => clearInterval(timer); }, [confirmation.isSuccess, account]);
  if (!signature) return <div className="page"><PageHeading title="Payment status" /><Empty icon={FileCheck2} title="No payment in progress" action={<Button onClick={() => navigate('/get-funded')}>Choose an evaluation</Button>}>Payments you make from this browser are followed here until the evaluation is ready.</Empty></div>;
  const rules = account?.rules ?? (tier && tierRules(tier));
  const steps = [['Payment submitted', <InlineLink href={explorerTx(signature)} external>{shortAddress(signature)}</InlineLink>], ['Payment confirmed', failed ? confirmation.error.message : confirmation.failureReason ? 'Waiting for the Solana network to answer. Checking again…' : 'Recorded onchain by Solana'], ['Evaluation ready', account ? `${account.label} · ${account.shortId}` : signedIn ? 'Waiting for the evaluation account' : 'Sign in to see your new account']];
  return <div className="page outcome-page"><div className="outcome-layout"><section className="outcome-main"><div className={`outcome-symbol ${complete ? 'success' : failed ? 'error' : ''}`}>{complete ? <CheckCheck size={31} /> : failed ? <TriangleAlert size={31} /> : <Clock3 size={31} />}</div><Badge tone={complete ? 'green' : failed ? 'red' : 'purple'}>{complete ? 'Payment complete' : failed ? 'Payment not completed' : 'Payment processing'}</Badge><h1>{complete ? 'Your next chapter is ready.' : failed ? 'The payment did not go through.' : 'Getting your account ready.'}</h1><p>{complete ? 'Your evaluation is active. Take a breath, find your market, and trade your process.' : failed ? 'Nothing was charged if the transaction did not land. Check your wallet activity, then try again.' : 'Confirmation and account creation are separate steps. You can follow both here.'}</p><div className="activation-timeline">{steps.map(([title, detail], i) => <div key={title} className={status > i ? 'done' : status === i ? 'current' : ''}><span>{status > i ? <Check size={15} /> : i + 1}</span><div><strong>{title}</strong><small>{detail}</small></div>{status > i && <Badge tone="green">Complete</Badge>}</div>)}</div>{failed ? <Button icon={ArrowRight} onClick={() => navigate('/checkout')}>Back to checkout</Button> : <Button disabled={!complete} icon={ArrowRight} onClick={() => selectAccount(account, 'trade')}>Open your evaluation</Button>}{complete && <button className="text-button" onClick={() => selectAccount(account, 'account')}>View account overview <ArrowUpRight size={14} /></button>}</section><aside className="receipt-sheet"><div className="receipt-top"><span>Evaluation receipt</span><img src="/brand/symbol.svg" alt="" /></div><h2>{tier ? `${tier.name} account` : 'Evaluation'}</h2><p>{account?.shortId ?? (payment ? shortAddress(payment.evaluation) : '')}</p>{rules && <RuleList rules={rules} />}{tier && <DataRow className="total" label="Evaluation fee" value={`${number(Number(tier.feeUsdc))} USDC`} />}<div className="receipt-footer"><FileCheck2 size={15} /><span>Paid onchain · <InlineLink href={explorerTx(signature)} external>View transaction</InlineLink></span></div></aside></div></div>;
}

function useEvaluation() {
  const { query, accounts, accountFor } = useApp();
  const id = query.get('id');
  return id ? accounts.find(a => a.id === id) ?? null : accountFor('evaluation');
}

/** Result and activation need one of the wallet's evaluations; this is what they show without one. */
function EvaluationGate({ title }) {
  const { navigate, signedIn, accountsQuery, setModal } = useApp();
  return <div className="page"><PageHeading title={title} />{!signedIn ? <Empty icon={Wallet} title="Sign in to see your evaluation" action={<Button onClick={() => setModal('wallet')}>Connect wallet</Button>}>Evaluations belong to the wallet that bought them.</Empty> : accountsQuery.isPending ? <Pending>Loading your evaluation…</Pending> : accountsQuery.isError ? <Unavailable title="Accounts are unavailable" error={accountsQuery.error} retry={accountsQuery.refetch} /> : <Empty icon={ShieldCheck} title="No evaluation yet" action={<Button onClick={() => navigate('/get-funded')}>Choose an evaluation</Button>}>Your result and funded activation appear here once an evaluation ends.</Empty>}</div>;
}

export function ResultPage() {
  const { navigate, selectAccount } = useApp();
  const evaluation = useEvaluation();
  if (!evaluation) return <EvaluationGate title="Evaluation result" />;
  const rules = evaluation.rules;
  const qualifying = Number(evaluation.realizedPnl) + Number(evaluation.unrealizedPnl);
  const passed = evaluation.status === 'passed', checking = evaluation.status === 'checking', ended = ['breached', 'failed'].includes(evaluation.status);
  const running = !passed && !checking && !ended;
  const targetMet = qualifying >= Number(rules.profitTargetUsd);
  /** The record_evaluation_result transaction once it is confirmed: the engine decides the result first, the chain records it after. */
  const recorded = evaluation.evidence.resultSignature;
  return <div className="page outcome-page"><div className="outcome-layout"><section className="outcome-main"><div className={`outcome-symbol ${passed ? 'success' : ended ? 'error' : ''}`}>{passed ? <ShieldCheck size={32} /> : ended ? <Info size={32} /> : <Clock3 size={32} />}</div><Badge tone={passed ? 'green' : ended ? 'red' : 'amber'}>{passed ? 'Evaluation passed' : checking ? 'Result under review' : ended ? 'Evaluation ended' : 'Evaluation in progress'}</Badge><h1>{passed ? <>You brought the edge.<br />Let's bring the capital.</> : checking ? 'One final check.' : ended ? 'A clear result. A fresh start.' : 'Still in progress.'}</h1><p>{passed ? 'Your evaluation met its objectives. The next step is activating your funded account.' : checking ? 'Your target has been reached. Positions, fees and account rules are being reconciled before the result is final.' : ended ? 'This account crossed its static equity floor. Your trade history stays available so you can review what happened.' : 'Reach the profit target without crossing the equity floor. There is no time limit.'}</p><div className="result-metrics"><div><span>{running ? 'Current equity' : 'Final equity'}</span><strong>{usd(evaluation.equity)}</strong></div><div><span>{ended ? 'Equity floor' : 'Qualifying profit'}</span><strong className={ended ? '' : qualifying >= 0 ? 'positive' : 'negative'}>{ended ? usd(rules.floorUsd) : signedUsd(qualifying)}</strong></div></div><Button disabled={checking} icon={ArrowRight} onClick={() => passed ? navigate(`/activate?id=${evaluation.id}`) : running ? selectAccount(evaluation, 'trade') : navigate('/get-funded')}>{passed ? 'Continue to funded activation' : checking ? 'Waiting for final result' : running ? 'Continue trading' : 'Explore another evaluation'}</Button><a href={`#${accountHref(evaluation, 'activity')}`} className="text-button">Review account history <ArrowUpRight size={14} /></a></section><aside className="surface result-checklist"><h2>{passed ? 'Every objective, accounted for.' : 'Account checks'}</h2>{[['Profit target', `${usd(qualifying)} / ${usd(rules.profitTargetUsd)}`, targetMet], ['Drawdown rule', ended ? `Equity crossed the ${usd(rules.floorUsd)} floor` : `Equity stayed above ${usd(rules.floorUsd)}`, !ended], ['Result recorded', recorded ? <>Written to the evaluation account onchain · <InlineLink href={explorerTx(recorded)} external>View transaction</InlineLink></> : evaluation.resolvedAt ? 'Recording onchain…' : checking ? 'Positions and fees are being checked' : 'Recorded once the evaluation ends', !!recorded]].map(([title, detail, ok]) => <div className="result-check" key={title}><span className={ok ? 'checkmark' : 'pending-mark'}>{ok ? <Check size={15} /> : <Clock3 size={15} />}</span><span><strong>{title}</strong><small>{detail}</small></span></div>)}<Notice>Evaluation profits do not transfer to the funded account. Funded trading starts with its own allocation and rules.</Notice><InlineLink href={`#/verify?q=${evaluation.id}`}>Inspect the account record</InlineLink></aside></div></div>;
}

export function ActivationPage() {
  const { accounts, config, signedIn, session, setModal, notify, selectAccount } = useApp();
  const client = useQueryClient();
  const found = useEvaluation();
  const evaluation = found?.status === 'passed' ? found : accounts.find(a => a.stage === 'evaluation' && a.status === 'passed' && isCurrent(a, accounts)) ?? found;
  const me = useMe().data;
  const vault = useVault();
  const kyc = useStartKyc();
  const [country, setCountry] = useState('');
  const [region, setRegion] = useState('');
  const regions = REGIONS[country];
  const tx = useWalletTransaction();
  const [activated, setActivated] = useState(null);
  const funded = accounts.find(a => a.stage === 'funded' && (a.id === activated || a.evidence.evaluation === evaluation?.id));
  useEffect(() => { if (!activated || funded) return; const timer = setInterval(() => client.invalidateQueries({ queryKey: ['accounts'] }), 3000); return () => clearInterval(timer); }, [activated, funded]);
  useEffect(() => { if (activated && funded) { notify('Funded account active', funded.label); selectAccount(funded, 'account'); } }, [activated, funded]);
  const cost = useTxCost(['activation', evaluation?.id], (chain, connection, trader) => chain.prepareActivation(connection, trader, evaluation.id), signedIn && evaluation?.status === 'passed' && !funded);
  if (!evaluation) return <EvaluationGate title="Funded activation" />;
  const rules = evaluation.rules;
  const principal = Number(rules.lossAllowanceUsd);
  const capacity = vault.data ? Number(vault.data.unallocated) >= principal : null;
  const verified = me?.kyc === 'verified';
  const blocked = funded ? null : evaluation.status !== 'passed' ? 'Only a passed evaluation can be activated.' : !evaluation.evidence.resultSignature ? 'The pass is still being recorded onchain. Activation opens once it is.' : config.data?.paused.trading ? 'Funded trading is paused by the operator, so activation is paused too.' : !verified ? 'Complete the identity review first.' : capacity === false ? 'The vault has no unallocated capital for this account yet.' : session.network.state === 'wrong' ? session.network.reason : null;
  async function activate() {
    if (blocked || capacity !== true) return;
    const result = await tx.run((chain, connection, trader) => chain.prepareActivation(connection, trader, evaluation.id));
    if (result) { setActivated(result.prepared.funded); void client.invalidateQueries({ queryKey: ['vault'] }); }
  }
  const kycBadge = { none: ['neutral', 'Not started'], pending: ['amber', 'In review'], verified: ['green', 'Verified'], rejected: ['red', 'Not approved'] }[me?.kyc ?? 'none'];
  const ready = !blocked && capacity === true;
  return <div className="page activation-page"><PageHeading title="Make room for your next chapter." description="Review what changes when you step into a funded account." back={{ label: 'Evaluation result', href: `#/result?id=${evaluation.id}` }} /><div className="activation-layout"><section className="surface activation-allocation"><span className="account-emblem"><ShieldCheck size={25} /></span><h2>Your funded account size</h2><strong className="allocation-value">{usd(rules.sizeUsd, 0)}<span>maximum exposure</span></strong><Badge tone={funded ? 'green' : ready ? 'green' : 'amber'} dot>{funded ? 'Funded account active' : activated ? 'Activating' : ready ? 'Ready to activate' : capacity === false ? 'Awaiting capital' : 'Not ready yet'}</Badge><div className="allocation-details"><DataRow label="Evaluation" value={evaluation.shortId} /><DataRow label="Capital source" value="Props.trade capital vault" /><DataRow label="Posted as collateral" value={`${usd(principal)} USDC`} /><DataRow label="Execution" value="Onchain exchange" /><DataRow label="Your share of eligible profits" value={bpsPercent(rules.traderShareBps)} /><DataRow label="Equity floor" value={usd(rules.floorUsd)} /><DataRow label="Vault capacity" value={vault.isPending ? 'Checking…' : vault.isError ? 'Unavailable' : capacity ? 'Available' : `${usd(vault.data.unallocated)} unallocated`} /><DataRow label="Identity review"><Badge tone={kycBadge[0]}>{kycBadge[1]}</Badge></DataRow>{cost.data && <DataRow label="Network fee and rent deposit" value={sol(cost.data.feeLamports + cost.data.rentLamports)} />}</div>{signedIn && (me?.kyc === 'none' || me?.kyc === 'rejected') && !funded && <div className="field"><span>Country of residence</span><div className="button-row"><select aria-label="Country of residence" value={country} onChange={e => { setCountry(e.target.value); setRegion(''); }}><option value="">Choose a country</option>{COUNTRY_OPTIONS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select>{regions && <select aria-label="Region of residence" value={region} onChange={e => setRegion(e.target.value)}><option value="">Choose a region</option>{regions.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select>}<Button variant="secondary" disabled={!country || (!!regions && !region) || kyc.isPending} onClick={() => kyc.mutate({ country, region: region || undefined }, { onSuccess: () => notify('Identity review started', 'We will notify you when it is complete.') })}>{kyc.isPending ? 'Starting…' : 'Start identity review'}</Button></div>{kyc.isError && <p className="field-error">{kyc.error.message}</p>}</div>}{me?.kyc === 'pending' && <Notice>Your identity review is in progress. One funded account is allowed per person.</Notice>}{blocked && !activated && (verified || evaluation.status !== 'passed') && <Notice tone="amber">{blocked}</Notice>}{tx.phase === 'failed' && <Notice tone="amber" role="alert">{tx.message}</Notice>}{!signedIn ? <Button className="full-width" icon={Wallet} onClick={() => setModal('wallet')}>Connect wallet</Button> : funded ? <Button className="full-width" icon={ArrowRight} onClick={() => selectAccount(funded, 'account')}>Open funded account</Button> : <Button className="full-width" disabled={!ready || tx.busy || !!activated} icon={ArrowRight} onClick={activate}>{tx.busy ? TX_LABELS[tx.phase] : activated ? 'Waiting for the funded account…' : capacity === false ? 'Waiting for capital' : 'Activate funded account'}</Button>}<p className="sheet-footnote">{capacity === false ? 'No estimated activation time is available yet.' : 'Your wallet asks you to approve one transaction. It creates the funded account and moves the collateral from the vault.'}</p></section><section className="activation-changes"><h2>Same workspace.<br />A new stage.</h2><div className="change-row"><span><ArrowUpRight size={22} /></span><div><h3>From simulated to funded</h3><p>Funded trades are real positions on the exchange, opened with the USDC the vault posts to your account.</p></div></div><div className="change-row"><span><Wallet size={21} /></span><div><h3>Profits become eligible for payout</h3><p>Realized profits follow your funded account's payout rules and profit split.</p></div></div><div className="change-row"><span><ShieldCheck size={21} /></span><div><h3>Your risk limits stay visible</h3><p>You can trade the allocation. Vault capital stays separate from withdrawable profits.</p></div></div><Notice>Activation needs a verified identity, enough unallocated vault capital and one wallet approval.</Notice></section></div></div>;
}
