import { useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { useStepUp } from '../lib/stepup.js';
import { useLive } from '../state.js';
import { Banner, Field, StatusBadge } from '../ui/ds.js';
import { ErrorLine } from '../ui/kit.js';
import { EmailLog } from './EmailLog.js';

interface Item { event: string; channel: 'WHATSAPP' | 'EMAIL'; title: string; subject: string | null; body: string; custom: boolean; variables: string[]; defaultBody: string; defaultSubject: string | null }

/** The wording of every message guests receive. The owner or super admin changes it here; "built-in" wording is used until they do. */
export function MessageTemplates() {
  const { t } = useT();
  const list = useLive<{ items: Item[] }>('/v1/message-templates', 600_000);
  const [sel, setSel] = useState<string>('RESERVATION_CONFIRMED/WHATSAPP');
  const items = list.data?.items ?? [];
  const cur = items.find((x) => `${x.event}/${x.channel}` === sel) ?? items[0];
  return (
    <section className="stack">
      <h2>{t('gmt.title')}</h2>
      <p className="muted">{t('gmt.intro')}</p>
      {list.data && cur && (
        <div className="split">
          <ul className="plain mt-list" aria-label={t('gmt.title')}>{items.map((x) => (
            <li key={`${x.event}/${x.channel}`}><button className={`wide pick${x === cur ? ' on' : ''}`} aria-current={x === cur} onClick={() => setSel(`${x.event}/${x.channel}`)}>
              <strong>{t(`gmt.e.${x.event}` as Key)}</strong> <span className="muted small">{x.channel === 'WHATSAPP' ? 'WhatsApp' : 'Email'}</span> {x.custom && <StatusBadge tone="info" icon="check">{t('gmt.custom')}</StatusBadge>}</button></li>))}</ul>
          <Editor key={`${cur.event}/${cur.channel}/${cur.custom}`} item={cur} onChanged={list.reload} />
        </div>
      )}
      <EmailLog />
    </section>
  );
}

function Editor({ item, onChanged }: { item: Item; onChanged: () => void }) {
  const { t } = useT();
  const [body, setBody] = useState(item.body); const [subject, setSubject] = useState(item.subject ?? '');
  const { busy, problem, run } = useAction(); const [saved, setSaved] = useState(false);
  const withStepUp = useStepUp(); const box = useRef<HTMLTextAreaElement>(null);
  const url = `/v1/message-templates/${item.event}/${item.channel}`;
  const insert = (v: string) => {
    const el = box.current; const tag = `{{${v}}}`;
    if (!el) { setBody((b) => b + tag); return; }
    const a = el.selectionStart, z = el.selectionEnd; setBody(body.slice(0, a) + tag + body.slice(z)); setSaved(false);
    window.setTimeout(() => { el.focus(); el.setSelectionRange(a + tag.length, a + tag.length); }, 0);
  };
  const save = async () => { if (await run(() => withStepUp(() => api('PUT', url, { body, ...(item.channel === 'EMAIL' ? { subject } : {}) })))) { setSaved(true); onChanged(); } };
  const reset = async () => { if (await run(() => withStepUp(() => api('DELETE', url)))) onChanged(); };
  return (
    <div className="stack">
      <h3>{t(`gmt.e.${item.event}` as Key)} · {item.channel === 'WHATSAPP' ? 'WhatsApp' : 'Email'}</h3>
      <Banner level="INFO" title={t('gmt.rule')} />
      {item.channel === 'EMAIL' && <Field label={t('gmt.subject')}>{(p) => <input {...p} value={subject} maxLength={200} onChange={(e) => { setSubject(e.target.value); setSaved(false); }} />}</Field>}
      <Field label={t('gmt.body')}>{(p) => <textarea {...p} ref={box} dir="ltr" rows={16} value={body} onChange={(e) => { setBody(e.target.value); setSaved(false); }} />}</Field>
      <div><p className="muted small">{t('gmt.insert')}</p><div className="chips">{item.variables.map((v) => <button key={v} type="button" className="chip" onClick={() => insert(v)}>{`{{${v}}}`}</button>)}</div></div>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions">
        <button className="primary" disabled={busy || body.trim().length < 10} onClick={() => void save()}>{t('common.save')}</button>
        {item.custom && <button disabled={busy} onClick={() => void reset()}>{t('gmt.reset')}</button>}
        {saved && <StatusBadge tone="ok" icon="check">{t('ps.saved')}</StatusBadge>}
      </div>
    </div>
  );
}
