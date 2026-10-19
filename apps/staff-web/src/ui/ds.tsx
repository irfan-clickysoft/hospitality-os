import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { Icon, type IconName } from './icons.js';

/** Status is always icon + word + tone. Colour alone never carries meaning. */
export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';
export function StatusBadge({ tone, icon, children }: { tone: Tone; icon: IconName; children: ReactNode }) {
  return <span className={`st st-${tone}`}><Icon name={icon} size={14} />{children}</span>;
}
const RES: Record<string, [Tone, IconName]> = { OPTION: ['warn', 'half'], CONFIRMED: ['info', 'ring'], CHECKED_IN: ['ok', 'dot'], CHECKED_OUT: ['neutral', 'check'], CANCELLED: ['neutral', 'x'], NO_SHOW: ['danger', 'x'] };
export function ResStatus({ status }: { status: string }) { const { t } = useT(); const [tone, icon] = RES[status] ?? ['neutral', 'ring']; return <StatusBadge tone={tone} icon={icon}>{t(`rs.${status}` as Key)}</StatusBadge>; }
const HK: Record<string, [Tone, IconName]> = { DIRTY: ['danger', 'ring'], CLEANING: ['warn', 'half'], CLEAN: ['info', 'dot'], INSPECTED: ['ok', 'check'] };
export function RoomState({ hk }: { hk: string }) { const { t } = useT(); const [tone, icon] = HK[hk] ?? ['neutral', 'ring']; return <StatusBadge tone={tone} icon={icon}>{t(`hk2.${hk}` as Key)}</StatusBadge>; }

/** The three attention levels used by queues, banners and the inbox. */
export type Level = 'BLOCKER' | 'ACTION' | 'INFO';
const LEVEL: Record<Level, [Tone, IconName]> = { BLOCKER: ['danger', 'stop'], ACTION: ['warn', 'alert'], INFO: ['info', 'info'] };
export const levelTone = (l: Level): Tone => LEVEL[l][0];
export function LevelBadge({ level, children }: { level: Level; children: ReactNode }) { const [tone, icon] = LEVEL[level]; return <StatusBadge tone={tone} icon={icon}>{children}</StatusBadge>; }

/** A banner explains one thing and offers at most one way forward. Blockers use role="alert"; the rest are polite. */
export function Banner({ level, title, children, action }: { level: Level; title: string; children?: ReactNode; action?: ReactNode }) {
  const [tone, icon] = LEVEL[level];
  return (
    <div className={`banner2 b-${tone}`} role={level === 'BLOCKER' ? 'alert' : 'status'}>
      <Icon name={icon} size={22} />
      <div className="b-body"><strong>{title}</strong>{children && <div className="b-text">{children}</div>}</div>
      {action && <div className="b-action">{action}</div>}
    </div>
  );
}

/** Save state of anything that autosaves. Always words and an icon, never just a colour or a toast. */
export type SaveStatus = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: string } | { kind: 'failed' } | { kind: 'offline' } | { kind: 'conflict' };
export function SaveState({ s, onRetry }: { s: SaveStatus; onRetry?: () => void }) {
  const { t } = useT();
  const map: Record<SaveStatus['kind'], [Tone, IconName, string]> = {
    idle: ['neutral', 'clock', t('save.idle')], saving: ['info', 'clock', t('save.saving')], saved: ['ok', 'check', s.kind === 'saved' ? t('save.saved', { time: s.at }) : ''],
    failed: ['danger', 'alert', t('save.failed')], offline: ['warn', 'offline', t('save.offline')], conflict: ['danger', 'stop', t('save.conflict')],
  };
  const [tone, icon, text] = map[s.kind];
  return <span className={`savestate st-${tone}`} role="status" aria-live="polite"><Icon name={icon} size={14} />{text}{s.kind === 'failed' && onRetry && <button className="link" onClick={onRetry}>{t('common.retry')}</button>}</span>;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  const { t } = useT();
  return <div className="skeleton" role="status" aria-label={t('common.loading')}>{Array.from({ length: rows }, (_, i) => <span key={i} className="sk-row" />)}</div>;
}

/** A completed action stays on screen as a card (with Undo where it is allowed), so success never depends on a toast being noticed. */
export function ConfirmCard({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="confirmcard" role="status"><Icon name="check" size={22} /><div className="b-body"><strong>{title}</strong>{children && <div className="b-text">{children}</div>}</div>{action && <div className="b-action">{action}</div>}</div>;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
/** Keeps Tab inside `ref`, puts focus inside on open and gives it back to whatever opened the panel. */
export function useFocusTrap(onEscape: () => void, active = true) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement as HTMLElement | null; const el = ref.current;
    (el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onEscape(); return; }
      if (e.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]!, last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); opener?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  return ref;
}

/** Quick edits beside the record: the page behind stays visible. On a phone it is a full-width sheet from the bottom. Never opened on top of another panel. */
export function SidePanel({ title, subtitle, onClose, children, footer }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const { t } = useT();
  const ref = useFocusTrap(onClose);
  return (
    <div className="panel-wrap">
      <div className="panel-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="panel" role="dialog" aria-modal="true" aria-labelledby="panel-title" ref={ref}>
        <div className="panel-head"><div><h2 id="panel-title">{title}</h2>{subtitle && <p className="muted small">{subtitle}</p>}</div><button className="icon" onClick={onClose} aria-label={t('common.close')}><Icon name="x" /></button></div>
        <div className="panel-body">{children}</div>
        {footer && <div className="panel-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Label above, hint and error tied to the field. Required is said in words. */
export function Field({ label, hint, error, required, children }: { label: string; hint?: string; error?: string; required?: boolean; children: (p: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode }) {
  const { t } = useT();
  const id = useRef(`f${Math.random().toString(36).slice(2, 8)}`).current;
  const desc = [hint ? `${id}-h` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${error ? ' has-error' : ''}`}>
      <label htmlFor={id}>{label}{required && <span className="req"> · {t('field.required')}</span>}</label>
      {children({ id, 'aria-describedby': desc, 'aria-invalid': error ? true : undefined })}
      {hint && <p id={`${id}-h`} className="hint">{hint}</p>}
      {error && <p id={`${id}-e`} className="error"><Icon name="alert" size={14} /> {error}</p>}
    </div>
  );
}

/** Tabs with the keyboard behaviour screen-reader users expect: arrows move, Home/End jump, only the current tab is in the tab order. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: string; badge?: number }>; value: T; onChange: (id: T) => void; label: string }) {
  const key = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((x) => x.id === value); let n = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + tabs.length) % tabs.length; else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = tabs.length - 1; else return;
    e.preventDefault(); onChange(tabs[n]!.id); requestAnimationFrame(() => document.getElementById(`tab-${tabs[n]!.id}`)?.focus());
  };
  return (
    <div className="tabbar" role="tablist" aria-label={label} onKeyDown={key}>
      {tabs.map((x) => <button key={x.id} id={`tab-${x.id}`} role="tab" aria-selected={x.id === value} aria-controls={`panel-${x.id}`} tabIndex={x.id === value ? 0 : -1} className={`tab${x.id === value ? ' on' : ''}`} onClick={() => onChange(x.id)}>{x.label}{!!x.badge && <span className="count">{x.badge}</span>}</button>)}
    </div>
  );
}

/** Confirms a destructive or guest-affecting action in place — no dialog on top of a dialog. Says what will happen, asks for a reason when one is needed. */
export function InlineConfirm({ trigger, consequence, confirmLabel, needReason, busy, error, onConfirm, tone = 'default' }: { trigger: string; consequence: string; confirmLabel: string; needReason?: boolean; busy?: boolean; error?: ReactNode; onConfirm: (reason: string) => void; tone?: 'default' | 'danger' }) {
  const { t } = useT();
  const [open, setOpen] = useState(false); const [reason, setReason] = useState('');
  if (!open) return <button onClick={() => setOpen(true)}>{trigger}</button>;
  return (
    <div className="inlineconfirm" role="group" aria-label={trigger}>
      <p>{consequence}</p>
      {needReason && <Field label={t('common.reason')} required>{(p) => <input {...p} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />}</Field>}
      {error}
      <div className="actions"><button className={tone === 'danger' ? 'danger' : 'primary'} disabled={busy || (needReason && reason.trim().length < 3)} onClick={() => onConfirm(reason.trim())}>{confirmLabel}</button><button onClick={() => setOpen(false)}>{t('common.cancel')}</button></div>
    </div>
  );
}
