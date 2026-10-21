import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorText, useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { shortDate, weekday } from '../lib/format.js';
import { useAuth, useLive, useWork } from '../state.js';
import { Account } from '../desk/Account.js';
import { SidePanel, Skeleton } from '../ui/ds.js';
import { Icon } from '../ui/icons.js';
import { CommandPalette } from './CommandPalette.js';
import { CommandsProvider, InboxProvider, type InboxData } from './context.js';
import { Link, lastIn, navigate, useRememberPlace, useRoute, useScrollMemory } from './router.js';
import { personaOf, SECTIONS, sectionFor } from './sections.js';
import { Inbox } from '../pages/Inbox.js';
import { Today } from '../pages/Today.js';
import { Workspace } from '../pages/Workspace.js';
import { SectionPage, Guests, RoomsLive } from '../pages/Section.js';

const COLLAPSE = 'hos.nav.collapsed';

export function AppShell() {
  return <CommandsProvider><Frame /></CommandsProvider>;
}

function Popover({ label, icon, badge, children, align = 'end' }: { label: string; icon: 'bell' | 'user'; badge?: number; children: (close: () => void) => ReactNode; align?: 'end' | 'start' }) {
  const [open, setOpen] = useState(false); const box = useRef<HTMLDivElement>(null); const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className="pop" ref={box}>
      <button ref={btn} className="iconbtn" aria-label={label} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}><Icon name={icon} />{!!badge && <span className="count" aria-hidden="true">{badge > 99 ? '99+' : badge}</span>}</button>
      {open && <div className={`pop-panel ${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

function Frame() {
  const { t, locale, setLocale } = useT();
  const { me, property, properties, setPropertyId, can, logout, offlineBoot } = useAuth();
  const work = useWork();
  const route = useRoute();
  const [account, setAccount] = useState(false); const [palette, setPalette] = useState(false); const [help, setHelp] = useState(false); const [more, setMore] = useState(false);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSE) === '1'; } catch { return false; } });
  const sections = useMemo(() => SECTIONS.filter((s) => s.show(can)), [can]);
  const section = sectionFor(route.path);
  const persona = personaOf(can);
  const base = property ? `/v1/properties/${property.id}` : null;
  const inbox = useLive<InboxData>(base ? `${base}/inbox` : null, 45_000, base ? `inbox-${property!.id}` : undefined);
  const items = inbox.data?.summary;
  const attention = (items?.blockers ?? 0) + (items?.actions ?? 0);

  useRememberPlace(section?.id ?? null, route.full);
  useScrollMemory(route.path);
  useEffect(() => { try { if (!localStorage.getItem('hos.locale') && me?.user.locale) setLocale(me.user.locale); } catch { /* ignore */ } }, [me, setLocale]);
  useEffect(() => { setMore(false); }, [route.path]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); return; }
      const el = e.target as HTMLElement | null;
      if (e.key === '?' && !(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) && !document.querySelector('[role="dialog"][aria-modal="true"]')) { e.preventDefault(); setHelp(true); return; }
      if (e.key === '/' && !(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) && !document.querySelector('[role="dialog"][aria-modal="true"]')) { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  const toggleRail = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem(COLLAPSE, n ? '1' : '0'); } catch { /* ignore */ } return n; });

  if (!property) return <main className="login"><p className="muted center">{t('common.none')}</p><button className="link" onClick={logout}>{t('nav.logout')}</button></main>;
  const businessDate = inbox.data?.businessDate ?? property.businessDate;
  const dayChanged = !!inbox.data && inbox.data.businessDate !== property.businessDate;
  const hrefFor = (id: string, path: string) => lastIn(id) ?? path;
  const sys = !work.online || offlineBoot ? 'offline' : work.pending.length ? 'syncing' : 'online';

  const page = (() => {
    const [first, id, flow] = route.seg;
    if (!first || first === 'today') return <Today />;
    if (first === 'reservations' && id) return <Workspace key={id} id={id} flow={flow} />;
    if (first === 'inbox') return <Inbox />;
    if (first === 'guests') return <Guests />;
    if (first === 'rooms') return <RoomsLive />;
    const s = SECTIONS.find((x) => x.id === first);
    return s ? <SectionPage section={s} /> : <SectionPage section={SECTIONS[0]!} missing />;
  })();

  return (
    <div className={`app${collapsed ? ' rail-collapsed' : ''}`}>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>{t('shell.skip')}</a>
      <header className="topbar">
        <button className="iconbtn only-wide" aria-label={collapsed ? t('shell.expandNav') : t('shell.collapseNav')} aria-expanded={!collapsed} onClick={toggleRail}><Icon name="panel" /></button>
        <div className="prop">
          {properties.length > 1
            ? <select aria-label={t('property.choose')} value={property.id} onChange={(e) => { setPropertyId(e.target.value); navigate('/today'); }}>{properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            : <strong className="prop-name">{property.name}</strong>}
          <span className="bizday" title={t('property.businessDate')}><Icon name="calendar" size={16} /><span><span className="muted-inv">{t('shell.businessDay')}</span> <strong>{weekday(businessDate, locale)} {shortDate(businessDate, locale)}</strong></span></span>
          {dayChanged && <span className="st st-warn"><Icon name="alert" size={14} />{t('shell.dayChanged')}</span>}
        </div>
        <button className="searchbtn" onClick={() => setPalette(true)} aria-haspopup="dialog"><Icon name="search" size={18} /><span>{t('shell.search')}</span><kbd>Ctrl K</kbd></button>
        <div className="top-right">
          <span className={`sys sys-${sys}`} role="status"><Icon name={sys === 'offline' ? 'offline' : sys === 'syncing' ? 'clock' : 'check'} size={14} /><span className="sr-narrow">{sys === 'offline' ? t('sys.offline', { n: work.pending.length }) : sys === 'syncing' ? t('sys.syncing', { n: work.pending.length }) : t('sys.online')}</span></span>
          <Popover label={attention ? t('shell.alertsN', { n: attention }) : t('shell.alerts')} icon="bell" badge={attention}>
            {(close) => (
              <div className="pop-body">
                <h2 className="pop-title">{t('shell.alerts')}</h2>
                {!inbox.data ? <Skeleton rows={2} /> : inbox.data.items.length === 0 ? <p className="muted">{t('inbox.clear')}</p> : (
                  <ul className="plain">{inbox.data.items.filter((i) => i.level !== 'INFO').slice(0, 5).map((i) => (
                    <li key={i.id}><Link to={i.reservationId ? `/reservations/${i.reservationId}` : '/inbox'} onClick={close} className="alert-row"><Icon name={i.level === 'BLOCKER' ? 'stop' : 'alert'} size={16} /><span>{t(`ib.${i.kind}` as Key, { guest: i.guest ?? '', room: i.roomNumber ?? '', n: i.count ?? 0, title: i.title ?? '' })}</span></Link></li>))}</ul>)}
                <Link to="/inbox" className="button" onClick={close}>{t('shell.openInbox')}</Link>
              </div>)}
          </Popover>
          <Popover label={t('shell.profile')} icon="user">
            {(close) => (
              <div className="pop-body">
                <p><strong>{me?.user.fullName}</strong><br /><span className="muted small">{me?.user.email}</span></p>
                <p><span className="st st-neutral"><Icon name="user" size={14} />{t(`role.${persona}` as Key)}</span></p>
                <button onClick={() => { setLocale(locale === 'ur' ? 'en' : 'ur'); close(); }}>{t('nav.language')}</button>
                <button onClick={() => { setAccount(true); close(); }}>{t('acct.title')}</button>
                <button onClick={() => { close(); void logout(); }}>{t('nav.logout')}</button>
              </div>)}
          </Popover>
        </div>
      </header>
      {account && <Account onClose={() => setAccount(false)} />}
      <div className="sysbanners">
        {(!work.online || offlineBoot) && <div className="banner warn" role="status">{t('banner.offline')}</div>}
        {work.pending.length > 0 && <div className="banner" role="status">{t('banner.pending', { n: work.pending.length })}</div>}
        {work.notices.length > 0 && <div className="banner warn" role="alert">{t('banner.dropped', { n: work.notices.length })} <small>({[...new Set(work.notices.map((n) => errorText(locale, n.code)))].join(' ')})</small> <button className="link" onClick={work.clearNotices}>{t('common.close')}</button></div>}
      </div>

      <nav className="rail" aria-label={t('shell.mainNav')}>
        <ul className="plain">{sections.map((s) => (
          <li key={s.id}><Link to={hrefFor(s.id, s.path)} className={`navitem${section?.id === s.id ? ' on' : ''}`} aria-current={section?.id === s.id ? 'page' : undefined} title={collapsed ? t(s.label) : undefined}>
            <Icon name={s.icon} /><span className="nav-label">{t(s.label)}</span>{s.id === 'inbox' && attention > 0 && <span className="count" aria-label={t('shell.alertsN', { n: attention })}>{attention}</span>}
          </Link></li>))}</ul>
      </nav>
      <nav className="bottomnav" aria-label={t('shell.mainNav')}>
        {sections.filter((s) => s.primary).slice(0, 4).map((s) => (
          <Link key={s.id} to={hrefFor(s.id, s.path)} className={`navitem${section?.id === s.id ? ' on' : ''}`} aria-current={section?.id === s.id ? 'page' : undefined}>
            <Icon name={s.icon} /><span>{t(s.label)}</span>{s.id === 'inbox' && attention > 0 && <span className="count" aria-label={t('shell.alertsN', { n: attention })}>{attention}</span>}
          </Link>))}
        <button className={`navitem${more ? ' on' : ''}`} aria-expanded={more} onClick={() => setMore((m) => !m)}><Icon name="menu" /><span>{t('shell.more')}</span></button>
      </nav>
      {more && (
        <div className="morenav" role="navigation" aria-label={t('shell.more')}>
          <ul className="plain">{sections.filter((s) => !s.primary).map((s) => <li key={s.id}><Link to={hrefFor(s.id, s.path)} className="navitem wide-item"><Icon name={s.icon} /><span>{t(s.label)}</span></Link></li>)}</ul>
        </div>)}

      <InboxProvider value={{ data: inbox.data, offline: inbox.offline, reload: inbox.reload }}>
        <main id="main" tabIndex={-1} key={property.id} className="main">
          <Suspense fallback={<Skeleton rows={4} />}>{page}</Suspense>
        </main>
      </InboxProvider>
      <p className="sr-only" aria-live="polite">{attention > 0 ? t('shell.alertsN', { n: attention }) : ''}</p>
      {palette && <CommandPalette onClose={() => setPalette(false)} onHelp={() => setHelp(true)} />}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
    </div>
  );
}

const SHORTCUTS: Array<{ keys: string; label: Key }> = [
  { keys: 'Ctrl K', label: 'sc.palette' }, { keys: '/', label: 'sc.search' }, { keys: '?', label: 'sc.help' }, { keys: 'Esc', label: 'sc.close' },
  { keys: 'C', label: 'sc.checkin' }, { keys: 'O', label: 'sc.checkout' }, { keys: 'M', label: 'sc.move' }, { keys: 'P', label: 'sc.pay' },
];
/** Every keyboard shortcut in one place. The single letters work on a reservation page and are ignored while typing. */
function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  return (
    <SidePanel title={t('sc.title')} subtitle={t('sc.subtitle')} onClose={onClose}>
      <dl className="shortcuts">{SHORTCUTS.map((x) => <div key={x.keys}><dt><kbd>{x.keys}</kbd></dt><dd>{t(x.label)}</dd></div>)}</dl>
    </SidePanel>
  );
}
