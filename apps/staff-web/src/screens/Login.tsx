import { useState, type FormEvent } from 'react';
import { ApiError, NetworkError } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAuth } from '../state.js';
import { ErrorLine } from '../ui/kit.js';
import { Logo } from '../ui/Logo.js';
import { ThemeToggle } from '../shell/DisplaySettings.js';

export function Login() {
  const { t, locale, setLocale } = useT();
  const { status, login, verifyMfa } = useAuth();
  const [tenant, setTenant] = useState(() => { try { return localStorage.getItem('hos.tenant') ?? ''; } catch { return ''; } });
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [code, setCode] = useState('');
  const [err, setErr] = useState<string>(); const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(undefined);
    try {
      if (status === 'mfa') await verifyMfa(code.trim());
      else { await login(tenant.trim().toLowerCase(), email.trim(), password); try { localStorage.setItem('hos.tenant', tenant.trim().toLowerCase()); } catch { /* ignore */ } }
    } catch (x) { setErr(x instanceof ApiError ? x.code : x instanceof NetworkError ? 'network' : 'generic'); } finally { setBusy(false); }
  };
  return (
    <main className="login">
      <button className="link lang" onClick={() => setLocale(locale === 'ur' ? 'en' : 'ur')}>{t('nav.language')}</button>
      <div className="login-theme"><ThemeToggle /></div>
      <h1 className="login-logo"><Logo height={92} title={t('app.name')} /></h1>
      <form onSubmit={submit} className="card stack">
        <h2>{status === 'mfa' ? t('login.mfa') : t('login.title')}</h2>
        {status === 'mfa' ? (
          <label>{t('login.mfa')}<input inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" /></label>
        ) : (<>
          <label>{t('login.tenant')}<input value={tenant} onChange={(e) => setTenant(e.target.value)} autoCapitalize="none" autoComplete="organization" dir="ltr" required /></label>
          <label>{t('login.email')}<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" dir="ltr" required /></label>
          <label>{t('login.password')}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" dir="ltr" required /></label>
        </>)}
        <ErrorLine code={err} />
        <button className="primary" disabled={busy}>{status === 'mfa' ? t('login.mfaSubmit') : t('login.submit')}</button>
      </form>
    </main>
  );
}
