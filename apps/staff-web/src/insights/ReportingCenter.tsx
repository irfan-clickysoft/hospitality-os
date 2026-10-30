import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { personaOf } from '../shell/sections.js';
import { Link, useRoute } from '../shell/router.js';
import { useAuth } from '../state.js';
import { ErrorLine, Spinner, problemOf } from '../ui/kit.js';
import { ReportView } from './ReportView.js';
import type { CatalogItem, Planned } from './types.js';

const CATS = ['management', 'frontdesk', 'rooms', 'finance', 'sales', 'risk'] as const;
const read = (k: string): string[] => { try { return JSON.parse(localStorage.getItem(k) ?? '[]') as string[]; } catch { return []; } };
const write = (k: string, v: string[]) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* not saved */ } };

/** The home of reports: what suits this person's job first, favourites and recent ones, then everything they may open, grouped by what it is for. */
export function ReportingCenter() {
  const { t } = useT(); const { property, can } = useAuth(); const route = useRoute();
  const pid = property!.id; const persona = personaOf(can);
  const [items, setItems] = useState<CatalogItem[] | null>(null); const [planned, setPlanned] = useState<Planned[]>([]); const [problem, setProblem] = useState<{ code: string; detail?: string } | null>(null);
  const [q, setQ] = useState(''); const [fav, setFav] = useState<string[]>(() => read(`hos.ins.fav.${pid}`)); const [recent, setRecent] = useState<string[]>(() => read(`hos.ins.recent.${pid}`));
  useEffect(() => { let dead = false; api<{ items: CatalogItem[]; planned: Planned[] }>('GET', `/v1/properties/${pid}/insights`).then((r) => { if (!dead) { setItems(r.items); setPlanned(r.planned); } }).catch((e) => { if (!dead) setProblem(problemOf(e)); }); return () => { dead = true; }; }, [pid]);
  const open = route.query.get('r');
  const current = items?.find((x) => x.id === open) ?? null;
  useEffect(() => { if (current) { const next = [current.id, ...recent.filter((x) => x !== current.id)].slice(0, 6); setRecent(next); write(`hos.ins.recent.${pid}`, next); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [current?.id]);
  const toggleFav = (id: string) => { const next = fav.includes(id) ? fav.filter((x) => x !== id) : [...fav, id]; setFav(next); write(`hos.ins.fav.${pid}`, next); };
  const byId = useMemo(() => new Map((items ?? []).map((x) => [x.id, x])), [items]);
  if (problem) return <ErrorLine code={problem.code} detail={problem.detail} />;
  if (!items) return <Spinner />;
  if (current) return <ReportView key={current.id} item={current} />;
  const needle = q.trim().toLowerCase();
  const match = (x: CatalogItem) => !needle || `${x.name} ${x.purpose}`.toLowerCase().includes(needle);
  const mine = items.filter((x) => x.roles.includes(persona));
  const card = (x: CatalogItem) => (
    <li key={x.id} className="card inner ins-card">
      <div className="row between"><Link to={`/reports/center?r=${x.id}`} className="ins-link"><strong>{x.name}</strong></Link>
        <button type="button" className="link" aria-pressed={fav.includes(x.id)} aria-label={`${fav.includes(x.id) ? t('ins.unfav') : t('ins.fav')}: ${x.name}`} onClick={() => toggleFav(x.id)}>{fav.includes(x.id) ? '★' : '☆'}</button></div>
      <p className="muted small">{x.purpose}</p><span className="st st-neutral small">{t(`ins.kind.${x.kind}` as Key)}</span>
    </li>);
  const group = (title: string, list: CatalogItem[]) => list.length > 0 && <section className="stack" key={title}><h3>{title}</h3><ul className="plain ins-grid">{list.map(card)}</ul></section>;
  return (
    <section className="stack">
      <h2>{t('ins.title')}</h2><p className="muted">{t('ins.intro')}</p>
      <input type="search" className="ins-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('ins.find')} aria-label={t('ins.find')} />
      {!needle && group(t('ins.forYou', { role: t(`role.${persona}` as Key) }), mine)}
      {!needle && group(t('ins.favourites'), fav.map((id) => byId.get(id)).filter((x): x is CatalogItem => !!x))}
      {!needle && group(t('ins.recent'), recent.map((id) => byId.get(id)).filter((x): x is CatalogItem => !!x))}
      {CATS.map((c) => group(t(`ins.cat.${c}` as Key), items.filter((x) => x.category === c && match(x))))}
      {needle && items.filter(match).length === 0 && <p className="muted center">{t('ins.none')}</p>}
      {!needle && planned.length > 0 && <section className="stack"><h3>{t('ins.planned')}</h3><ul className="plain ins-grid">{planned.map((p) => <li key={p.id} className="card inner"><strong>{p.name}</strong><p className="muted small">{p.purpose}</p><p className="muted small">{t('ins.needs')}: {p.needs}</p></li>)}</ul></section>}
      <p className="muted small">{t('rp.help')} <Link to="/reports/downloads">{t('ins.downloads')}</Link></p>
    </section>
  );
}
