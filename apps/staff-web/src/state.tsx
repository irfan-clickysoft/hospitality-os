import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, NetworkError, onUnauthenticated, setCsrf } from './api/client.js';
import { LocalStore, OfflineQueue, type Dropped, type QueuedAction, type SendResult } from './api/queue.js';
import { LocaleProvider, type Locale } from './i18n/index.js';

export interface Grant { permission: string; scopeType: string; scopeId: string | null }
export interface Me { user: { id: string; email: string; fullName: string; locale: Locale }; session: { state: string }; csrfToken: string | null; grants: Grant[] }
export interface Property { id: string; code: string; name: string; businessDate: string; timezone: string; status: string }
type Status = 'loading' | 'out' | 'mfa' | 'in';

interface Auth {
  status: Status; me: Me | null; properties: Property[]; property: Property | null; setPropertyId: (id: string) => void; offlineBoot: boolean;
  can: (permission: string) => boolean;
  login: (tenant: string, email: string, password: string) => Promise<void>; verifyMfa: (code: string) => Promise<void>; logout: () => Promise<void>; setLocale: (l: Locale) => void;
}
const AuthCtx = createContext<Auth | null>(null);
export const useAuth = (): Auth => { const c = useContext(AuthCtx); if (!c) throw new Error('AuthProvider missing'); return c; };

const CACHE = 'hos.session.v1';
const readCache = (): { me: Me; properties: Property[] } | null => { try { return JSON.parse(localStorage.getItem(CACHE) ?? 'null'); } catch { return null; } };
const writeCache = (v: { me: Me; properties: Property[] } | null) => { try { if (v) localStorage.setItem(CACHE, JSON.stringify(v)); else localStorage.removeItem(CACHE); } catch { /* ignore */ } };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyId, setPid] = useState<string | null>(() => { try { return localStorage.getItem('hos.property'); } catch { return null; } });
  const [offlineBoot, setOfflineBoot] = useState(false);

  const load = useCallback(async () => {
    const m = await api<Me>('GET', '/v1/auth/me');
    setCsrf(m.csrfToken);
    setMe(m);
    if (m.session.state === 'PENDING_MFA') { setStatus('mfa'); return; }
    const props = (await api<{ items: Property[] }>('GET', '/v1/me/properties')).items;
    setProperties(props); setOfflineBoot(false); writeCache({ me: m, properties: props }); setStatus('in');
  }, []);

  useEffect(() => {
    load().catch((e) => {
      if (e instanceof NetworkError) {                                   // opened with no signal: carry on with the last known session
        const c = readCache();
        if (c) { setCsrf(c.me.csrfToken); setMe(c.me); setProperties(c.properties); setOfflineBoot(true); setStatus('in'); return; }
      }
      setStatus('out');
    });
    return onUnauthenticated(() => { writeCache(null); setMe(null); setStatus('out'); });
  }, [load]);

  const property = useMemo(() => properties.find((p) => p.id === propertyId) ?? properties[0] ?? null, [properties, propertyId]);
  const setPropertyId = useCallback((id: string) => { setPid(id); try { localStorage.setItem('hos.property', id); } catch { /* ignore */ } }, []);
  const can = useCallback((permission: string) => !!me?.grants.some((g) => g.permission === permission && (g.scopeType === 'TENANT' || g.scopeType === 'LEGAL_ENTITY' || (g.scopeType === 'PROPERTY' && g.scopeId === property?.id))), [me, property]);

  const login = useCallback(async (tenant: string, email: string, password: string) => {
    const r = await api<{ state: string; csrfToken: string }>('POST', '/v1/auth/login', { tenant, email, password });
    setCsrf(r.csrfToken);
    await load();
  }, [load]);
  const verifyMfa = useCallback(async (code: string) => { await api('POST', '/v1/auth/mfa/verify', { code }); await load(); }, [load]);
  const logout = useCallback(async () => { try { await api('POST', '/v1/auth/logout'); } catch { /* signed out locally anyway */ } writeCache(null); setCsrf(null); setMe(null); setStatus('out'); }, []);
  const setLocale = useCallback((l: Locale) => { api('POST', '/v1/auth/locale', { locale: l }).catch(() => undefined); }, []);

  const value = useMemo<Auth>(() => ({ status, me, properties, property, setPropertyId, offlineBoot, can, login, verifyMfa, logout, setLocale }), [status, me, properties, property, setPropertyId, offlineBoot, can, login, verifyMfa, logout, setLocale]);
  return <AuthCtx.Provider value={value}><LocaleProvider initial={me?.user.locale} onChange={setLocale}>{children}</LocaleProvider></AuthCtx.Provider>;
}

// ───────────── work: actions that survive a lost signal ─────────────
export interface Request { method: 'POST' | 'PUT'; path: string; body?: Record<string, unknown>; effect: QueuedAction['effect'] }
interface Work {
  online: boolean; pending: QueuedAction[]; notices: Dropped[]; clearNotices: () => void; lastSent: number;
  /** Runs the request now; if there is no signal it is queued and `queued` is true. Server refusals throw ApiError. */
  run: <T = unknown>(r: Request) => Promise<{ queued: boolean; data?: T }>;
  flushNow: () => void;
}
const WorkCtx = createContext<Work | null>(null);
export const useWork = (): Work => { const c = useContext(WorkCtx); if (!c) throw new Error('WorkProvider missing'); return c; };

export function WorkProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [pending, setPending] = useState<QueuedAction[]>([]);
  const [notices, setNotices] = useState<Dropped[]>([]);
  const [lastSent, setLastSent] = useState(0);
  const queue = useRef<OfflineQueue | null>(null);
  if (!queue.current) {
    queue.current = new OfflineQueue(new LocalStore(`hos.queue.v1.${userId}`), async (a): Promise<SendResult> => {
      try { await api(a.method, a.path, a.body); return { ok: true }; }
      catch (e) {
        if (e instanceof NetworkError) return { ok: false, retry: true };
        if (e instanceof ApiError) return e.status >= 500 || e.status === 429 || e.status === 401 ? { ok: false, retry: true } : { ok: false, retry: false, status: e.status, code: e.code };
        return { ok: false, retry: true };
      }
    });
  }
  const q = queue.current;
  const refresh = useCallback(() => setPending(q.list()), [q]);
  const flushNow = useCallback(() => {
    if (!q.list().length) return;
    q.flush().then((r) => { refresh(); if (r.sent) setLastSent((n) => n + r.sent); if (r.dropped.length) setNotices((n) => [...n, ...r.dropped]); if (!r.stopped) setOnline(true); });
  }, [q, refresh]);

  useEffect(() => { refresh(); flushNow(); }, [refresh, flushNow]);
  useEffect(() => {
    const up = () => { setOnline(true); flushNow(); }, down = () => setOnline(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    const t = setInterval(flushNow, 15_000);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); clearInterval(t); };
  }, [flushNow]);

  const run = useCallback(async <T,>(r: Request) => {
    const body = r.body;
    if (q.list().length) { q.add({ method: r.method, path: r.path, body, effect: r.effect, createdAt: typeof body?.at === 'string' ? body.at : undefined }); refresh(); flushNow(); return { queued: true }; }   // keep order behind earlier queued work
    try {
      const data = await api<T>(r.method, r.path, body);
      return { queued: false, data };
    } catch (e) {
      if (e instanceof NetworkError) { setOnline(false); q.add({ method: r.method, path: r.path, body, effect: r.effect, createdAt: typeof body?.at === 'string' ? body.at : undefined }); refresh(); return { queued: true }; }
      throw e;
    }
  }, [q, refresh, flushNow]);

  const value = useMemo<Work>(() => ({ online, pending, notices, clearNotices: () => setNotices([]), lastSent, run, flushNow }), [online, pending, notices, lastSent, run, flushNow]);
  return <WorkCtx.Provider value={value}>{children}</WorkCtx.Provider>;
}

/** Polls a GET, keeps the last good answer (also on disk) so a screen still shows something with no signal. */
export function useLive<T>(path: string | null, intervalMs = 30_000, cacheKey?: string): { data: T | null; error: ApiError | null; offline: boolean; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T | null>(() => { try { return cacheKey ? JSON.parse(localStorage.getItem(`hos.cache.${cacheKey}`) ?? 'null') : null; } catch { return null; } });
  const [error, setError] = useState<ApiError | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const { lastSent } = useWork();
  useEffect(() => {
    if (!path) return;
    let dead = false;
    const go = () => api<T>('GET', path).then((d) => { if (dead) return; setData(d); setError(null); setOffline(false); setLoading(false); if (cacheKey) { try { localStorage.setItem(`hos.cache.${cacheKey}`, JSON.stringify(d)); } catch { /* full */ } } })
      .catch((e) => { if (dead) return; setLoading(false); if (e instanceof NetworkError) setOffline(true); else if (e instanceof ApiError) setError(e); });
    go();
    const t = setInterval(go, intervalMs);
    return () => { dead = true; clearInterval(t); };
  }, [path, intervalMs, cacheKey, tick, lastSent]);
  return { data, error, offline, reload: () => setTick((n) => n + 1), loading };
}
