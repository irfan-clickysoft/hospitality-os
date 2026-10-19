import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive } from '../state.js';
import { Badge, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';

interface Assignment { id: string; roleKey: string; role: string; scopeType: string; scopeId: string | null; scope: string | null; validTo: string | null }
interface User { id: string; email: string; fullName: string; status: string; mfaEnabled: boolean; locale: string; lastLogin: string | null; assignments: Assignment[] }
interface Role { key: string; name: string; permissions: string[] }
const tone = (s: string) => (s === 'ACTIVE' ? 'clean' : s === 'INVITED' ? 'warn' : 'neutral') as 'clean' | 'warn' | 'neutral';
const linkFor = (token: string) => `${window.location.origin}/?invite=${encodeURIComponent(token)}&tenant=${encodeURIComponent((() => { try { return localStorage.getItem('hos.tenant') ?? ''; } catch { return ''; } })())}`;

/** Staff: who can sign in, what each person may do and where, and the care of their accounts. */
export function Staff() {
  const { t } = useT();
  const list = useLive<{ items: User[] }>('/v1/users', 60_000);
  const [open, setOpen] = useState<string | null>(null); const [adding, setAdding] = useState(false); const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const withStepUp = useStepUp();
  const [q, setQ] = useState('');
  const shown = (list.data?.items ?? []).filter((u) => !q.trim() || `${u.fullName} ${u.email}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <section className="stack">
      <h2>{t('nav.staff')}</h2>
      <div className="row"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('ar.search')} /><button className="primary" onClick={() => setAdding(true)}>{t('st.add')}</button></div>
      {!list.data ? <Spinner /> : shown.length === 0 ? <Empty text={t('common.none')} /> : (
        <ul className="plain rows">{shown.map((u) => (
          <li key={u.id}><button className="row-card" onClick={() => setOpen(u.id)}>
            <span className="rc-main"><strong>{u.fullName}</strong><span className="muted small" dir="ltr">{u.email}</span><span className="muted small">{u.assignments.length ? u.assignments.map((a) => `${a.role}${a.scope ? ` · ${a.scope}` : ''}`).join(' · ') : t('st.noRoles')}</span></span>
            <span className="rc-side"><Badge tone={tone(u.status)}>{t(`st.s.${u.status}` as Key)}</Badge>{!u.mfaEnabled && u.status === 'ACTIVE' && <span className="muted small">{t('st.noMfa')}</span>}</span>
          </button></li>))}</ul>)}
      {adding && <AddSheet onDone={(name, url) => { setAdding(false); list.reload(); setLink({ name, url }); }} onClose={() => setAdding(false)} />}
      {link && <LinkSheet name={link.name} url={link.url} onClose={() => setLink(null)} />}
      {open && list.data && <UserSheet user={list.data.items.find((u) => u.id === open)!} onChanged={list.reload} onLink={(name, url) => setLink({ name, url })} onClose={() => setOpen(null)} stepUp={withStepUp} />}
    </section>
  );
}

function LinkSheet({ name, url, onClose }: { name: string; url: string; onClose: () => void }) {
  const { t } = useT();
  return (
    <Sheet title={name} onClose={onClose}>
      <p className="warnbox">{t('st.linkHelp')}</p>
      <p dir="ltr" style={{ wordBreak: 'break-all', fontFamily: 'monospace' }}>{url}</p>
      <div className="actions"><button className="primary" onClick={() => { void navigator.clipboard?.writeText(url); }}>{t('st.copy')}</button><a className="button" href={`https://wa.me/?text=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer">{t('wa.send')}</a><button onClick={onClose}>{t('common.close')}</button></div>
    </Sheet>
  );
}

function AddSheet({ onDone, onClose }: { onDone: (name: string, url: string) => void; onClose: () => void }) {
  const { t, locale } = useT();
  const withStepUp = useStepUp();
  const [email, setEmail] = useState(''); const [name, setName] = useState(''); const [lang, setLang] = useState(locale);
  const { busy, problem, run } = useAction();
  const go = async () => { const r = await run(() => withStepUp(() => api<{ fullName: string; invite: { token: string } }>('POST', '/v1/users', { email: email.trim(), fullName: name.trim(), locale: lang }))); if (r) onDone(r.fullName, linkFor(r.invite.token)); };
  return (
    <Sheet title={t('st.add')} onClose={onClose}>
      <label>{t('ci.name')}<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
      <label>{t('login.email')}<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" /></label>
      <label>{t('st.lang')}<select value={lang} onChange={(e) => setLang(e.target.value as 'en' | 'ur')}><option value="en">English</option><option value="ur">اردو</option></select></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button className="primary" disabled={busy || name.trim().length < 2 || !email.includes('@')} onClick={go}>{t('st.createLink')}</button><button onClick={onClose}>{t('common.cancel')}</button></div>
    </Sheet>
  );
}

function UserSheet({ user, onChanged, onLink, onClose, stepUp }: { user: User; onChanged: () => void; onLink: (name: string, url: string) => void; onClose: () => void; stepUp: <T>(fn: () => Promise<T>) => Promise<T> }) {
  const { t } = useT();
  const { me, property } = useAuth();
  const roles = useLive<{ items: Role[] }>('/v1/roles', 300_000);
  const props = useLive<{ items: Array<{ id: string; name: string }> }>('/v1/properties', 300_000);
  const [role, setRole] = useState(''); const [scope, setScope] = useState<string>(property?.id ?? 'TENANT'); const [reason, setReason] = useState('');
  const { busy, problem, run } = useAction();
  const self = me?.user.id === user.id;
  const act = async (fn: () => Promise<unknown>) => { if (await run(() => stepUp(fn))) { onChanged(); setReason(''); } };
  const need = reason.trim().length >= 3;
  return (
    <Sheet title={user.fullName} onClose={onClose}>
      <p className="muted small" dir="ltr">{user.email} · <Badge tone={tone(user.status)}>{t(`st.s.${user.status}` as Key)}</Badge>{user.lastLogin ? ` · ${new Date(user.lastLogin).toLocaleDateString()}` : ''}</p>
      <h3>{t('st.roles')}</h3>
      {user.assignments.length === 0 && <p className="muted small">{t('st.noRoles')}</p>}
      <ul className="plain">{user.assignments.map((a) => (
        <li key={a.id} className="row between small"><span><strong>{a.role}</strong> · {a.scope ?? t('st.wholeBusiness')}{a.validTo ? ` · ${a.validTo.slice(0, 10)}` : ''}</span>
          {!self && <button className="link" disabled={busy || !need} onClick={() => act(() => api('DELETE', `/v1/users/${user.id}/roles/${a.id}?reason=${encodeURIComponent(reason.trim())}`))}>{t('st.remove')}</button>}</li>))}</ul>
      {!self && (<div className="card inner stack">
        <label>{t('st.role')}<select value={role} onChange={(e) => setRole(e.target.value)}><option value="">—</option>{roles.data?.items.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></label>
        <label>{t('st.where')}<select value={scope} onChange={(e) => setScope(e.target.value)}><option value="TENANT">{t('st.wholeBusiness')}</option>{props.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <button disabled={busy || !role} onClick={() => act(() => api('POST', `/v1/users/${user.id}/roles`, { roleKey: role, scopeType: scope === 'TENANT' ? 'TENANT' : 'PROPERTY', scopeId: scope === 'TENANT' ? null : scope }))}>{t('st.give')}</button>
      </div>)}
      {!self && (<>
        <label>{t('common.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <div className="row">
          {user.status !== 'DISABLED' && <button disabled={busy} onClick={() => act(async () => { const r = await api<{ invite: { token: string } }>('POST', `/v1/users/${user.id}/invite`); onLink(user.fullName, linkFor(r.invite.token)); })}>{t('st.newLink')}</button>}
          {user.status !== 'DISABLED' ? <button disabled={busy || !need} onClick={() => act(() => api('POST', `/v1/users/${user.id}/disable`, { reason: reason.trim() }))}>{t('st.disable')}</button> : <button disabled={busy || !need} onClick={() => act(() => api('POST', `/v1/users/${user.id}/enable`, { reason: reason.trim() }))}>{t('st.enable')}</button>}
          {user.mfaEnabled && <button disabled={busy || !need} onClick={() => act(() => api('POST', `/v1/users/${user.id}/reset-mfa`, { reason: reason.trim() }))}>{t('st.resetMfa')}</button>}
        </div></>)}
      {self && <p className="muted small">{t('st.selfNote')}</p>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </Sheet>
  );
}
