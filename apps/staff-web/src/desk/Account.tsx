import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAction } from '../lib/action.js';
import { useAuth } from '../state.js';
import { ErrorLine, Sheet } from '../ui/kit.js';

/** My account: change my password, set up the second factor (needed for the sensitive actions), and see my recovery codes once. */
export function Account({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const { me } = useAuth();
  const enrolled = !!(me?.user as { mfaEnabled?: boolean } | undefined)?.mfaEnabled;
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [saved, setSaved] = useState(false);
  const [mfa, setMfa] = useState<{ secret: string; otpauthUri: string } | null>(null); const [code, setCode] = useState(''); const [codes, setCodes] = useState<string[] | null>(null);
  const pw = useAction(); const en = useAction();
  const change = async () => { const r = await pw.run(() => api('POST', '/v1/auth/password/change', { currentPassword: cur, newPassword: next })); if (r === undefined && !pw.problem) { setSaved(true); setCur(''); setNext(''); } };
  const start = async () => { const r = await en.run(() => api<{ secret: string; otpauthUri: string }>('POST', '/v1/auth/mfa/enroll', {})); if (r) setMfa(r); };
  const confirm = async () => { const r = await en.run(() => api<{ recoveryCodes: string[] }>('POST', '/v1/auth/mfa/confirm', { code: code.trim() })); if (r) { setCodes(r.recoveryCodes); setMfa(null); } };
  return (
    <Sheet title={me?.user.fullName ?? t('acct.title')} onClose={onClose}>
      <p className="muted small" dir="ltr">{me?.user.email}</p>
      <h3>{t('acct.password')}</h3>
      <label>{t('acct.current')}<input type="password" value={cur} onChange={(e) => { setCur(e.target.value); setSaved(false); }} autoComplete="current-password" dir="ltr" /></label>
      <label>{t('inv2.new')}<input type="password" value={next} onChange={(e) => { setNext(e.target.value); setSaved(false); }} autoComplete="new-password" dir="ltr" /></label>
      <ErrorLine code={pw.problem?.code} detail={pw.problem?.detail} />{saved && <p className="ok">✓ {t('acct.saved')}</p>}
      <div className="actions"><button disabled={pw.busy || !cur || next.length < 12} onClick={change}>{t('acct.change')}</button></div>
      <h3>{t('acct.mfa')}</h3>
      {codes ? (<><p className="ok">✓ {t('acct.mfaOn')}</p><p className="warnbox">{t('acct.codesHelp')}</p><ul className="plain" dir="ltr" style={{ fontFamily: 'monospace' }}>{codes.map((c) => <li key={c}>{c}</li>)}</ul></>)
        : mfa ? (<>
          <p className="small">{t('acct.scan')}</p>
          <p dir="ltr" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}><strong>{mfa.secret.replace(/(.{4})/g, '$1 ').trim()}</strong></p>
          <a className="button" href={mfa.otpauthUri}>{t('acct.openApp')}</a>
          <label>{t('login.mfa')}<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" /></label>
          <ErrorLine code={en.problem?.code} detail={en.problem?.detail} />
          <div className="actions"><button className="primary" disabled={en.busy || code.trim().length < 6} onClick={confirm}>{t('acct.mfaConfirm')}</button></div></>)
        : enrolled ? <p className="ok">✓ {t('acct.mfaOn')}</p>
        : (<><p className="muted small">{t('acct.mfaWhy')}</p><ErrorLine code={en.problem?.code} detail={en.problem?.detail} /><div className="actions"><button className="primary" disabled={en.busy} onClick={start}>{t('acct.mfaStart')}</button></div></>)}
    </Sheet>
  );
}
