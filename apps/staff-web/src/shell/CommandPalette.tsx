import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAuth, useLive } from '../state.js';
import { useFocusTrap } from '../ui/ds.js';
import { Icon, type IconName } from '../ui/icons.js';
import { useCommands } from './context.js';
import { navigate } from './router.js';
import { SECTIONS } from './sections.js';
import type { ListItem } from '../desk/types.js';

interface Entry { id: string; group: string; label: string; hint?: string; icon: IconName; keys?: string; run: () => void }

/** Search for a guest, booking or room, or run a command. One box, reachable from anywhere with Ctrl K or "/". Arrow keys move, Enter runs, Esc closes. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { t, locale, setLocale } = useT();
  const { property, properties, setPropertyId, can, logout } = useAuth();
  const { commands } = useCommands();
  const [q, setQ] = useState(''); const [debounced, setDebounced] = useState(''); const [at, setAt] = useState(0);
  const ref = useFocusTrap(onClose);
  useEffect(() => { const id = setTimeout(() => setDebounced(q.trim()), 220); return () => clearTimeout(id); }, [q]);
  const searching = can('reservation.view') && debounced.length >= 2;
  const found = useLive<{ items: ListItem[] }>(searching ? `/v1/properties/${property!.id}/reservations?q=${encodeURIComponent(debounced)}&limit=8` : null, 3_600_000);

  const entries = useMemo<Entry[]>(() => {
    const done = (f: () => void) => () => { onClose(); f(); };
    const here: Entry[] = commands.map((c) => ({ id: `cmd-${c.id}`, group: t('cp.here'), label: c.label, hint: c.hint, icon: c.icon ?? 'chevron', keys: c.keys?.toUpperCase(), run: done(c.run) }));
    const go: Entry[] = SECTIONS.filter((s) => s.show(can)).flatMap((s) => [
      { id: `go-${s.id}`, group: t('cp.go'), label: t(s.label), icon: s.icon, run: done(() => navigate(s.path)) } as Entry,
      ...(s.tabs ?? []).filter((x) => x.show(can) && s.tabs!.length > 1).map((x) => ({ id: `go-${s.id}-${x.id}`, group: t('cp.go'), label: `${t(s.label)} · ${t(x.label)}`, icon: s.icon, run: done(() => navigate(`${s.path}?tab=${x.id}`)) } as Entry)),
    ]);
    const other: Entry[] = [
      { id: 'lang', group: t('cp.other'), label: t('nav.language'), icon: 'chevron', run: done(() => setLocale(locale === 'ur' ? 'en' : 'ur')) },
      ...properties.filter((p) => p.id !== property?.id).map((p) => ({ id: `prop-${p.id}`, group: t('cp.other'), label: t('cp.switchTo', { name: p.name }), icon: 'rooms' as IconName, run: done(() => { setPropertyId(p.id); navigate('/today'); }) })),
      { id: 'out', group: t('cp.other'), label: t('nav.logout'), icon: 'lock', run: done(() => void logout()) },
    ];
    const people: Entry[] = (found.data?.items ?? []).map((i) => ({ id: `res-${i.lineId}`, group: t('cp.people'), label: i.guest.fullName, hint: `${i.confirmationNo} · ${t(`rs.${i.status}` as Key)}${i.assignedRoom ? ` · ${t('d.room')} ${i.assignedRoom}` : ''}`, icon: 'user' as IconName, run: done(() => navigate(`/reservations/${i.reservationId}`)) }));
    const needle = q.trim().toLowerCase();
    const match = (e: Entry) => !needle || `${e.label} ${e.hint ?? ''}`.toLowerCase().includes(needle);
    return [...(needle.length >= 2 ? people : []), ...here.filter(match), ...go.filter(match), ...(needle ? other.filter(match) : other)];
  }, [commands, found.data, q, can, properties, property, locale, t, onClose, setLocale, setPropertyId, logout]);

  useEffect(() => { setAt(0); }, [q, found.data]);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((a) => Math.min(a + 1, entries.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); entries[at]?.run(); }
  };
  useEffect(() => { document.getElementById(`cp-opt-${at}`)?.scrollIntoView({ block: 'nearest' }); }, [at]);
  let last = '';
  return (
    <div className="cp-wrap">
      <div className="panel-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="cp" role="dialog" aria-modal="true" aria-label={t('cp.title')} ref={ref}>
        <div className="cp-input"><Icon name="search" />
          <input data-autofocus role="combobox" aria-expanded="true" aria-controls="cp-list" aria-activedescendant={entries.length ? `cp-opt-${at}` : undefined} aria-autocomplete="list" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} placeholder={t('cp.placeholder')} aria-label={t('cp.placeholder')} autoComplete="off" />
        </div>
        <ul id="cp-list" role="listbox" className="cp-list plain" aria-label={t('cp.title')}>
          {entries.map((e, i) => {
            const head = e.group !== last ? e.group : null; last = e.group;
            return (
              <li key={e.id} role="presentation">
                {head && <div className="cp-group" role="presentation">{head}</div>}
                <div id={`cp-opt-${i}`} role="option" aria-selected={i === at} className={`cp-opt${i === at ? ' on' : ''}`} onMouseMove={() => setAt(i)} onClick={e.run}>
                  <Icon name={e.icon} size={18} /><span className="cp-label">{e.label}{e.hint && <span className="muted small"> · {e.hint}</span>}</span>{e.keys && <kbd>{e.keys}</kbd>}
                </div>
              </li>);
          })}
          {entries.length === 0 && <li className="muted cp-empty" role="presentation">{searching && found.loading ? t('common.loading') : t('cp.none')}</li>}
        </ul>
        <p className="cp-foot muted small">{t('cp.help')}</p>
      </div>
    </div>
  );
}
