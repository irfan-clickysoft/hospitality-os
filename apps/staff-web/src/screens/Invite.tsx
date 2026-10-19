import { useState, type FormEvent } from 'react';
import { api, ApiError, NetworkError } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { ErrorLine } from '../ui/kit.js';

/** The page behind a staff invitation or password-reset link: choose a password, then sign in. */
export function Invite({ tenant, token, onDone }: { tenant: string; token: string; onDone: () => void }) {
  const { t, locale, setLocale } = useT();
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState(''); const [err, setErr] = useState<string>(); const [detail, setDetail] = useState<string>(); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(undefined);
    if (pw !== pw2) { setErr('PASSWORDS_DIFFER'); return; }
    setBusy(true);
    try { await api('POST', '/v1/auth/accept-invite', { tenant, token, password: pw }); try { localStorage.setItem('hos.tenant', tenant); } catch { /* ignore */ } setDone(true); }
    catch (x) { setErr(x instanceof ApiError ? x.code : x instanceof NetworkError ? 'network' : 'generic'); setDetail(x instanceof ApiError ? x.message : undefined); } finally { setBusy(false); }
  };
  return (
    <main className="login">
      <button className="link lang" onClick={() => setLocale(locale === 'ur' ? 'en' : 'ur')}>{t('nav.language')}</button>
      <h1>{t('app.name')}</h1>
      {done ? (
        <div className="card stack"><p className="ok">✓ {t('inv2.done')}</p><button className="primary" onClick={onDone}>{t('login.submit')}</button></div>
      ) : (
        <form onSubmit={submit} className="card stack">
          <h2>{t('inv2.title')}</h2><p className="muted small">{t('inv2.help')}</p>
          <label>{t('inv2.new')}<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" dir="ltr" required minLength={12} /></label>
          <label>{t('inv2.again')}<input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" dir="ltr" required /></label>
          <ErrorLine code={err} detail={detail} />
          <button className="primary" disabled={busy}>{t('inv2.set')}</button>
        </form>)}
    </main>
  );
}
