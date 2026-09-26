import React, { useEffect, useId, useRef, useState } from 'react';
import { Clock3, Copy, Gift, Info } from 'lucide-react';
import { useApp } from './App.jsx';
import { DASH, bpsPercent, date, dateTime, number, usd } from './data.js';
import { Badge, Button, Empty, PageHeading, Pending, SectionHeading, Unavailable } from './ui.jsx';
import { useDebounced } from './Trading.jsx';
import { ApiRequestError } from './lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { keys, useReferralCode, useReferralProgram, useReferrals, useSetReferrer } from './lib/queries';
import { clearReferral, normalizeReferral, saveReferral, savedReferral } from './lib/referral';

/** Per-trade amounts: a reward is a share of one fee charge, which can be a fraction of a cent. */
const FINE_USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fineUsd = value => value == null ? DASH : FINE_USD.format(Number(value));

/** A referral code input that checks the code once typing pauses. `children` sit beside the input (a submit button). */
export function ReferralField({ value, onChange, label = 'Referral code', children }) {
  const id = useId();
  const typed = value.trim();
  const settled = useDebounced(typed, 400);
  const code = normalizeReferral(settled);
  const check = useReferralCode(code);
  const [tone, text] = !settled || settled !== typed ? ['', ''] : !code ? ['negative', 'Codes are 4 to 16 letters and digits']
    : check.isPending ? ['quiet', 'Checking…'] : check.isError ? ['quiet', 'The code could not be checked right now']
    : check.data.valid ? ['positive', 'Valid code'] : ['negative', 'No such code'];
  return <div className="field referral-field"><label htmlFor={id}>{label}</label><div className="referral-input"><input id={id} value={value} onChange={e => onChange(e.target.value)} maxLength={16} autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-describedby={`${id}-check`} />{children}</div><small id={`${id}-check`} className={tone} aria-live="polite">{text}</small></div>;
}

/** The sign-up screens' code: prefilled from a link, kept in this browser as it is typed, for the sign-in that follows. */
export function SignupReferral() {
  const [value, setValue] = useState(() => savedReferral() ?? '');
  function change(next) { setValue(next); const code = normalizeReferral(next); if (code) saveReferral(code); else clearReferral(); }
  return <ReferralField label="Referral code (optional)" value={value} onChange={change} />;
}

/**
 * A sign-in binds the code kept at sign-up (after Google's, which reloads the page, too): once, then the code is
 * forgotten, unless the service could not answer, when it waits for the next sign-in. A code the field already showed as
 * 'No such code' is dropped without asking, and a code kept while signed in to a wallet that can no longer add one is
 * dropped too, so no refusal surprises a later sign-in.
 */
export function useReferralSignIn(session, notify) {
  const client = useQueryClient();
  const setReferrer = useSetReferrer();
  const last = useRef(session.status);
  const referrals = useReferrals(session.status === 'signed-in' && savedReferral() !== null);
  useEffect(() => { if (referrals.data?.canSetReferrer === false) clearReferral(); }, [referrals.data]);
  useEffect(() => {
    const was = last.current;
    last.current = session.status;
    const code = was === 'signing' && session.status === 'signed-in' ? savedReferral() : null;
    if (!code) return;
    clearReferral();
    if (client.getQueryData(keys.referralCode(code))?.valid === false) return;
    setReferrer.mutateAsync(code).then(() => notify('Referral code applied', `You signed up with code ${code}.`), error => {
      if (!(error instanceof ApiRequestError) || error.status === 0 || error.status >= 500) saveReferral(code);
      session.setNotice(`Referral code ${code} was not applied: ${error.message.replace(/\.?$/, '.')}`);
      notify('Referral code not applied', error.message, 'info');
    });
  }, [session.status]);
}

/** "Were you referred?": a signed-in trader who can still bind a referrer does it here; a code kept from a link fills it in. */
function ReferrerForm({ until }) {
  const { notify } = useApp();
  const [value, setValue] = useState(() => savedReferral() ?? '');
  const setReferrer = useSetReferrer();
  const code = normalizeReferral(value);
  function apply(e) {
    e.preventDefault();
    // Not mutate's onSuccess: the answer closes this form (canSetReferrer turns false), and an unmounted caller's callbacks do not run.
    if (code) setReferrer.mutateAsync(code).then(() => { clearReferral(); notify('Referral code applied', `You were referred by ${code}.`); }, () => { /* shown under the field */ });
  }
  return <form className="surface referral-form" onSubmit={apply}><h2>Were you referred?</h2><ReferralField value={value} onChange={next => { setValue(next); setReferrer.reset(); }}><Button type="submit" variant="secondary" disabled={!code || setReferrer.isPending}>{setReferrer.isPending ? 'Applying…' : 'Apply code'}</Button></ReferralField>{setReferrer.isError && <p className="field-error" role="alert">{setReferrer.error.message}</p>}<p className="referral-note">You can add a code until {date(until)}, and only before you buy an evaluation. It cannot be changed later.</p></form>;
}

export function ReferralsPage() {
  const { signedIn, setModal, copy, notify } = useApp();
  const referrals = useReferrals(signedIn);
  const program = useReferralProgram();
  const r = signedIn ? referrals.data : undefined;
  const rewardBps = r?.rewardBps ?? program.data?.rewardBps;
  const heading = <PageHeading title="Share your code. Earn on every funded trade." description={`You earn ${rewardBps != null ? bpsPercent(rewardBps) : 'a share'} of the Props fee on every funded trade of the traders who sign up with your code, paid in USDC.`}>{r?.referredBy && <Badge tone="purple">Referred by {r.referredBy}</Badge>}</PageHeading>;
  if (!signedIn) return <div className="page">{heading}<Empty icon={Gift} title="Sign in to get your referral code" action={<Button onClick={() => setModal('wallet')}>Connect wallet</Button>}>Your code is the start of your wallet address. It never changes.</Empty></div>;
  if (!r) return <div className="page">{heading}{referrals.isError ? <Unavailable title="Referrals are unavailable" error={referrals.error} retry={referrals.refetch} /> : <Pending>Loading your referrals…</Pending>}</div>;
  const link = `${location.origin}/?ref=${r.code}`;
  const stats = [
    ['Referred', number(r.referees, 0)], ['With an evaluation', number(r.refereesWithEvaluation, 0)], ['Funded', number(r.refereesFunded, 0)],
    ['Funded volume', usd(r.fundedVolumeUsd, 0), 'The size of every funded trade of the traders you referred.'],
    ['Earned', usd(r.earnedUsd), `${bpsPercent(r.rewardBps)} of the Props fee charged on each of their funded trades. Practice and evaluation trades are simulated and earn nothing.`],
    ['Paid', usd(r.paidUsd)], ['Pending', usd(r.pendingUsd), 'Earned and not paid yet. Props.trade sends it in USDC to this wallet once your identity is verified.'],
  ];
  return <div className="page referrals-page">{heading}
    <section className="surface referral-share"><div><span>Your code</span><strong>{r.code}</strong><button className="text-button" aria-label="Copy code" onClick={() => copy(r.code)}><Copy size={13} /> Copy</button></div><div><span>Your link</span><code>{link}</code><button className="text-button" aria-label="Copy link" onClick={() => copy(link)}><Copy size={13} /> Copy</button></div></section>
    <div className="referral-stats">{stats.map(([label, value, help]) => <div key={label}><span>{label}{help && <button type="button" className="info-tip" aria-label={`About ${label.toLowerCase()}`} title={help} onClick={() => notify(label, help)}><Info size={12} /></button>}</span><strong>{value}</strong></div>)}</div>
    {r.canSetReferrer && <ReferrerForm until={r.setReferrerUntil} />}
    <section className="surface"><SectionHeading>Recent rewards</SectionHeading>{r.recent.length ? <div className="table-scroll"><table className="card-table"><thead><tr><th>Trader</th><th>Market</th><th>Props fee</th><th>Your reward</th><th>Time</th></tr></thead><tbody>{r.recent.map((x, i) => <tr key={`${x.at}-${i}`}><td data-label="Trader">{x.referee}</td><td data-label="Market">{x.symbol}</td><td data-label="Props fee">{fineUsd(x.feeUsd)}</td><td data-label="Your reward"><strong>{fineUsd(x.rewardUsd)}</strong></td><td className="quiet" data-label="Time">{dateTime(x.at)}</td></tr>)}</tbody></table></div> : <Empty icon={Clock3} title="No rewards yet">They appear here as the traders you referred trade their funded accounts.</Empty>}</section>
  </div>;
}
