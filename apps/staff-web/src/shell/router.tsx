import { useCallback, useEffect, useMemo, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

/** A tiny hash router: the address is the app's memory (property-independent: section, record, tab and filters live in the URL), so reload, back and a shared link all land in the same place. */
export interface Route { path: string; seg: string[]; query: URLSearchParams; full: string }

const read = (): string => { const h = window.location.hash.replace(/^#/, ''); return h.startsWith('/') ? h : '/today'; };
const subscribe = (fn: () => void) => { window.addEventListener('hashchange', fn); return () => window.removeEventListener('hashchange', fn); };

export function useRoute(): Route {
  const full = useSyncExternalStore(subscribe, read, () => '/today');
  return useMemo(() => { const [path = '/today', q = ''] = full.split('?'); return { path, seg: path.split('/').filter(Boolean), query: new URLSearchParams(q), full }; }, [full]);
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) { window.history.replaceState(null, '', `#${to}`); window.dispatchEvent(new HashChangeEvent('hashchange')); }
  else window.location.hash = to;
}

/** Changes query parameters in place (filters, tabs) without adding history entries. `null` removes one. */
export function useSetQuery(): (patch: Record<string, string | null>) => void {
  return useCallback((patch) => {
    const [p = '/today', q = ''] = read().split('?'); const params = new URLSearchParams(q);
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') params.delete(k); else params.set(k, v); }
    const s = params.toString(); navigate(s ? `${p}?${s}` : p, { replace: true });
  }, []);
}

export function Link({ to, onClick, children, ...rest }: { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const go = (e: MouseEvent<HTMLAnchorElement>) => { onClick?.(e); if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); navigate(to); };
  return <a href={`#${to}`} onClick={go} {...rest}>{children}</a>;
}

/** Remembers the last place visited inside each top-level section, so coming back to "Reservations" returns to the same tab and filters. */
const LAST = 'hos.last.v1';
export const lastIn = (section: string): string | null => { try { return (JSON.parse(sessionStorage.getItem(LAST) ?? '{}') as Record<string, string>)[section] ?? null; } catch { return null; } };
export function useRememberPlace(section: string | null, full: string): void {
  useEffect(() => { if (!section) return; try { const m = JSON.parse(sessionStorage.getItem(LAST) ?? '{}') as Record<string, string>; m[section] = full; sessionStorage.setItem(LAST, JSON.stringify(m)); } catch { /* private mode */ } }, [section, full]);
}

/** Keeps each page's scroll position while you step into a record and back. */
export function useScrollMemory(path: string): void {
  useEffect(() => {
    const key = `hos.scroll.${path}`;
    let saved = 0; try { saved = Number(sessionStorage.getItem(key) ?? 0); } catch { /* ignore */ }
    const timers = saved > 0 ? [0, 120, 400].map((ms) => window.setTimeout(() => window.scrollTo(0, saved), ms)) : (window.scrollTo(0, 0), []);
    const on = () => { try { sessionStorage.setItem(key, String(window.scrollY)); } catch { /* ignore */ } };
    window.addEventListener('scroll', on, { passive: true });
    return () => { timers.forEach(clearTimeout); window.removeEventListener('scroll', on); };
  }, [path]);
}
