import { useEffect, type ReactNode } from 'react';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';

export const Spinner = () => { const { t } = useT(); return <p className="muted center" role="status">{t('common.loading')}</p>; };
export const Empty = ({ text }: { text: string }) => <p className="muted center empty">{text}</p>;
export const ErrorLine = ({ code, detail }: { code?: string; detail?: string }) => { const { err, t } = useT(); if (!code) return null; const known = err(code); return <p className="error" role="alert">{known === t('err.generic') && detail ? detail : known}</p>; };
/** One state for "what went wrong" that keeps the server's message as a fallback. */
export interface Problem { code: string; detail?: string }
export const problemOf = (e: unknown): Problem => (e instanceof Error && 'code' in e ? { code: String((e as { code: unknown }).code), detail: (e as Error).message } : { code: 'generic' });

export function Chip({ active, onClick, children }: { active?: boolean; onClick?: () => void; children: ReactNode }) {
  return <button type="button" className={`chip${active ? ' on' : ''}`} onClick={onClick} aria-pressed={!!active}>{children}</button>;
}
/** Status badges always show a word as well as a colour. */
export function Badge({ tone, children }: { tone: 'dirty' | 'cleaning' | 'clean' | 'inspected' | 'urgent' | 'high' | 'neutral' | 'warn'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export const hkTone = (s: string) => (s === 'DIRTY' ? 'dirty' : s === 'CLEANING' ? 'cleaning' : s === 'INSPECTED' ? 'inspected' : 'clean') as 'dirty' | 'cleaning' | 'inspected' | 'clean';
export const HkBadge = ({ status }: { status: string }) => { const { t } = useT(); return <Badge tone={hkTone(status)}>{t(`hk.${status}` as Key)}</Badge>; };
export const PriorityBadge = ({ p }: { p: number }) => { const { t } = useT(); return p <= 2 ? <Badge tone={p === 1 ? 'urgent' : 'high'}>{t(`priority.${p}` as Key)}</Badge> : null; };

/** Bottom sheet (full width on a phone). Escape and the backdrop close it. */
export function Sheet({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const { t } = useT();
  useEffect(() => { const f = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f); }, [onClose]);
  return (
    <div className="sheet-wrap" role="dialog" aria-modal="true" aria-label={title}>
      <button className="sheet-backdrop" aria-label={t('common.close')} onClick={onClose} />
      <div className={`sheet${wide ? ' wide' : ''}`}><div className="sheet-head"><h2>{title}</h2><button className="icon" onClick={onClose} aria-label={t('common.close')}>✕</button></div>{children}</div>
    </div>
  );
}
