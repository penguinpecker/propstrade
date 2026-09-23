import React, { useState } from 'react';
import { ArrowDownToLine, ArrowUpRight } from 'lucide-react';
import { useApp } from './App.jsx';
import { Badge, Button, PageHeading, Tabs } from './ui.jsx';

// Design artefact: the screen collection and its 4K exports. App.jsx loads this only in dev builds.
const screens = [
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

export default function ScreenIndex() {
  const { navigate, theme } = useApp();
  const [group, setGroup] = useState('All screens');
  const visible = screens.filter(s => group === 'All screens' || s.group === group);
  return <div className="page screen-index"><PageHeading title="The Props.trade workspace." description="22 connected screens. Matte dark and light paper."><Badge tone="purple">4K screen collection</Badge><Button icon={ArrowUpRight} onClick={() => navigate('/trade/funded')}>Explore the prototype</Button></PageHeading><Tabs items={['All screens', 'Onboarding', 'Accounts', 'Trading', 'Payouts', 'Transparency', 'Settings']} value={group} onChange={setGroup} /><div className="screen-grid">{visible.map(s => <article key={s.id}><button className="screen-thumbnail" onClick={() => navigate(s.path)}><img src={`/exports/${theme === 'light' ? 'light/' : ''}${s.id}-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`} alt={`${s.name} screen`} loading="lazy" /><span>Open screen <ArrowUpRight size={16} /></span></button><div className="screen-caption"><span><small>{s.group}</small><h2>{s.name}</h2></span><a href={`/exports/${theme === 'light' ? 'light/' : ''}${s.id}-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`} target="_blank" rel="noreferrer" aria-label={`Open ${s.name} 4K image`}><ArrowDownToLine size={17} /></a></div></article>)}</div></div>;
}
