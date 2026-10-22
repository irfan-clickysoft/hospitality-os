import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAction } from '../lib/action.js';
import { useAuth } from '../state.js';
import { ErrorLine } from '../ui/kit.js';

interface Loaded { text: string; subject: string | null; email: string | null }

/**
 * Send the message by email. Shown only when the system has email switched on. The wording comes from the server (the hotel's email template), staff check the address and the text,
 * and the server records who sent it and whether the mail service accepted it.
 */
export function EmailSend({ compose, send }: { compose: () => Promise<Loaded>; send: (v: { to: string; subject: string; text: string }) => Promise<unknown> }) {
  const { t } = useT(); const { property } = useAuth(); const { busy, problem, run } = useAction();
  const [on, setOn] = useState<boolean | null>(null); const [open, setOpen] = useState(false);
  const [to, setTo] = useState(''); const [subject, setSubject] = useState(''); const [text, setText] = useState(''); const [sent, setSent] = useState(false); const [failed, setFailed] = useState(false);
  useEffect(() => { let dead = false; api<{ configured: boolean }>('GET', `/v1/properties/${property!.id}/email/status`).then((r) => { if (!dead) setOn(r.configured); }).catch(() => { if (!dead) setOn(false); }); return () => { dead = true; }; }, [property]);
  if (!on) return null;
  const start = async () => {
    setFailed(false); setSent(false);
    try { const r = await compose(); setTo(r.email ?? ''); setSubject(r.subject ?? ''); setText(r.text); setOpen(true); } catch { setFailed(true); }
  };
  if (!open) return (<div className="stack"><button type="button" onClick={start}>{t('em.write')}</button>{failed && <p className="warnbox small">{t('gm.failed')}</p>}</div>);
  return (
    <div className="card inner stack">
      <label>{t('em.to')}<input type="email" value={to} onChange={(e) => setTo(e.target.value)} dir="ltr" inputMode="email" /></label>
      <label>{t('em.subject')}<input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} /></label>
      <label>{t('wa.message')}<textarea dir="ltr" rows={12} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <div className="actions">
        <button className="primary" disabled={busy || !to.trim() || !subject.trim() || text.trim().length < 10} onClick={async () => { if (await run(() => send({ to: to.trim(), subject: subject.trim().replace(/[\r\n]+/g, ' '), text }))) setSent(true); }}>{t('em.send')}</button>
        <button type="button" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
      </div>
      {sent && <p className="ok small" role="status">✓ {t('em.sent', { to })}</p>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </div>
  );
}
