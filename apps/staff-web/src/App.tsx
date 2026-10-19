import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from './i18n/index.js';
import { Login } from './screens/Login.js';
import { MyRooms } from './screens/MyRooms.js';
import { Board } from './screens/Board.js';
import { Issues } from './screens/Issues.js';
import { LostFound } from './screens/LostFound.js';
import { Bookings } from './desk/Bookings.js';
import { Companies } from './desk/Companies.js';
import { Management } from './desk/Management.js';
import { OtaTab } from './desk/OtaClaims.js';
import { Import } from './desk/Import.js';
import { Maintenance } from './desk/Maintenance.js';
import { Compliance } from './desk/Compliance.js';
import { Accounts } from './desk/Accounts.js';
import { Kitchen } from './desk/Kitchen.js';
import { Spaces } from './desk/Spaces.js';
import { Account } from './desk/Account.js';
import { AuditLog } from './desk/AuditLog.js';
import { Staff } from './desk/Staff.js';
import { Invite } from './screens/Invite.js';
import { Reports } from './desk/Reports.js';
import { Cashier } from './desk/Cashier.js';
import { NightAudit } from './desk/NightAudit.js';
import { Rack } from './desk/Rack.js';
import { Tax } from './desk/Tax.js';
import { Today } from './desk/Today.js';
import { StepUpProvider } from './lib/stepup.js';
import { AuthProvider, useAuth, useWork, WorkProvider } from './state.js';
import { Spinner } from './ui/kit.js';
import type { Key } from './i18n/en.js';
import { errorText } from './i18n/index.js';

type Group = 'front' | 'house' | 'money' | 'manage';
const GROUPS: Group[] = ['front', 'house', 'money', 'manage'];
type Tab = 'today' | 'management' | 'rack' | 'bookings' | 'cashier' | 'companies' | 'ota' | 'maintenance' | 'compliance' | 'accounts' | 'kitchen' | 'spaces' | 'reports' | 'staff' | 'trail' | 'import' | 'audit' | 'tax' | 'mine' | 'board' | 'issues' | 'lost';

function Shell() {
  const { t, locale, setLocale } = useT();
  const { me, property, properties, setPropertyId, can, logout, offlineBoot } = useAuth();
  const work = useWork();
  const [account, setAccount] = useState(false);
  const tabs = useMemo(() => [
    can('management.view') && { id: 'management' as Tab, label: 'nav.management' as Key, group: 'manage' as Group },
    can('reservation.view') && { id: 'today' as Tab, label: 'nav.today' as Key, group: 'front' as Group },
    can('reservation.view') && { id: 'rack' as Tab, label: 'nav.rack' as Key, group: 'front' as Group },
    can('reservation.view') && { id: 'bookings' as Tab, label: 'nav.bookings' as Key, group: 'front' as Group },
    can('cashier.operate') && { id: 'cashier' as Tab, label: 'nav.cashier' as Key, group: 'money' as Group },
    can('company.view') && { id: 'companies' as Tab, label: 'nav.companies' as Key, group: 'money' as Group },
    can('ota.claim') && { id: 'ota' as Tab, label: 'nav.ota' as Key, group: 'money' as Group },
    can('maintenance.view') && { id: 'maintenance' as Tab, label: 'nav.maintenance' as Key, group: 'house' as Group },
    can('compliance.view') && { id: 'compliance' as Tab, label: 'nav.compliance' as Key, group: 'manage' as Group },
    can('paymentaccount.view') && { id: 'accounts' as Tab, label: 'nav.accounts' as Key, group: 'money' as Group },
    can('fnb.order') && { id: 'kitchen' as Tab, label: 'nav.kitchen' as Key, group: 'front' as Group },
    can('space.view') && { id: 'spaces' as Tab, label: 'nav.spaces' as Key, group: 'front' as Group },
    can('report.view') && { id: 'reports' as Tab, label: 'nav.reports' as Key, group: 'money' as Group },
    can('user.manage') && { id: 'staff' as Tab, label: 'nav.staff' as Key, group: 'manage' as Group },
    can('audit.view') && { id: 'trail' as Tab, label: 'nav.audit2' as Key, group: 'manage' as Group },
    can('data.import') && { id: 'import' as Tab, label: 'nav.import' as Key, group: 'manage' as Group },
    can('nightaudit.run') && { id: 'audit' as Tab, label: 'nav.audit' as Key, group: 'money' as Group },
    (can('tax.configure') || can('tax.approve')) && { id: 'tax' as Tab, label: 'nav.tax' as Key, group: 'money' as Group },
    can('housekeeping.update') && { id: 'mine' as Tab, label: 'nav.myRooms' as Key, group: 'house' as Group },
    can('housekeeping.view') && { id: 'board' as Tab, label: 'nav.board' as Key, group: 'house' as Group },
    can('housekeeping.view') && { id: 'issues' as Tab, label: 'nav.issues' as Key, group: 'house' as Group },
    can('housekeeping.view') && { id: 'lost' as Tab, label: 'nav.lostFound' as Key, group: 'house' as Group },
  ].filter(Boolean) as Array<{ id: Tab; label: Key; group: Group }>, [can]);
  const [tab, setTab] = useState<Tab>('today');
  const grouped = new Set(tabs.map((x) => x.group)).size > 1;                                              // staff with one kind of work see a flat list
  const group = tabs.find((x) => x.id === tab)?.group ?? 'front';
  const lastIn = useRef<Partial<Record<Group, Tab>>>({});
  useEffect(() => { lastIn.current[group] = tab; }, [tab, group]);
  useEffect(() => { if (tabs.length && !tabs.some((x) => x.id === tab)) setTab(tabs[0]!.id); }, [tabs, tab]);
  useEffect(() => { try { if (!localStorage.getItem('hos.locale') && me?.user.locale) setLocale(me.user.locale); } catch { /* ignore */ } }, [me, setLocale]);

  if (!property) return <main className="login"><p className="muted center">{t('common.none')}</p><button className="link" onClick={logout}>{t('nav.logout')}</button></main>;
  return (
    <div className="shell">
      <header className="top">
        <div className="who">{properties.length <= 1 && <strong>{property.name}</strong>}
          {properties.length > 1 && <select aria-label={t('property.choose')} value={property.id} onChange={(e) => setPropertyId(e.target.value)}>{properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
        </div>
        <div className="row">
          {grouped && <select className="groupsel" aria-label={t('grp.label')} value={group} onChange={(e) => { const g = e.target.value as Group; setTab(lastIn.current[g] ?? tabs.find((x) => x.group === g)!.id); }}>{GROUPS.filter((g) => tabs.some((x) => x.group === g)).map((g) => <option key={g} value={g}>{t(`grp.${g}` as Key)}</option>)}</select>}
          <button className="link" onClick={() => setLocale(locale === 'ur' ? 'en' : 'ur')}>{t('nav.language')}</button>
          <button className="link" onClick={() => setAccount(true)}>{me?.user.fullName ?? t('acct.title')}</button>
          <button className="link" onClick={logout}>{t('nav.logout')}</button>
        </div>
      </header>
      {account && <Account onClose={() => setAccount(false)} />}
      {(!work.online || offlineBoot) && <div className="banner warn" role="status">{t('banner.offline')}</div>}
      {work.pending.length > 0 && <div className="banner" role="status">{t('banner.pending', { n: work.pending.length })}</div>}
      {work.notices.length > 0 && <div className="banner warn" role="alert">{t('banner.dropped', { n: work.notices.length })} <small>({[...new Set(work.notices.map((n) => errorText(locale, n.code)))].join(' ')})</small> <button className="link" onClick={work.clearNotices}>{t('common.close')}</button></div>}
      <main key={property.id} className="content">
        {tab === 'today' && <Today />}{tab === 'management' && <Management />}{tab === 'rack' && <Rack />}{tab === 'bookings' && <Bookings />}{tab === 'cashier' && <Cashier />}{tab === 'companies' && <Companies />}{tab === 'ota' && <OtaTab />}{tab === 'import' && <Import />}{tab === 'maintenance' && <Maintenance />}{tab === 'compliance' && <Compliance />}{tab === 'accounts' && <Accounts />}{tab === 'kitchen' && <Kitchen />}{tab === 'spaces' && <Spaces />}{tab === 'reports' && <Reports />}{tab === 'staff' && <Staff />}{tab === 'trail' && <AuditLog />}{tab === 'audit' && <NightAudit />}{tab === 'tax' && <Tax />}{tab === 'mine' && <MyRooms />}{tab === 'board' && <Board />}{tab === 'issues' && <Issues />}{tab === 'lost' && <LostFound />}
        {tabs.length === 0 && <p className="muted center">{t('err.PERMISSION_DENIED')}</p>}
      </main>
      <nav className="tabs" aria-label="main">
        {(grouped ? GROUPS.filter((g) => tabs.some((x) => x.group === g)) : [null]).flatMap((g) => [
          ...(g ? [<span key={`h-${g}`} className="grp" aria-hidden="true">{t(`grp.${g}` as Key)}</span>] : []),
          ...tabs.filter((x) => g === null || x.group === g).map((x) => <button key={x.id} className={`${tab === x.id ? 'on' : ''}${!grouped || x.group === group ? ' ingroup' : ''}`} aria-current={tab === x.id} onClick={() => setTab(x.id)}>{t(x.label)}</button>),
        ])}
      </nav>
    </div>
  );
}

function Gate() {
  const { status, me } = useAuth();
  const [invite, setInvite] = useState(() => { const q = new URLSearchParams(window.location.search); const token = q.get('invite'); const tenant = q.get('tenant'); return token && tenant ? { token, tenant } : null; });
  if (invite) return <Invite tenant={invite.tenant} token={invite.token} onDone={() => { window.history.replaceState(null, '', window.location.pathname); setInvite(null); }} />;
  if (status === 'loading') return <Spinner />;
  if (status === 'out' || status === 'mfa') return <Login />;
  return <WorkProvider userId={me!.user.id}><StepUpProvider><Shell /></StepUpProvider></WorkProvider>;
}
export function App() { return <AuthProvider><Gate /></AuthProvider>; }
