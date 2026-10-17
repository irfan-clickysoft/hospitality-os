import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type Key } from './en.js';
import { ur } from './ur.js';

export type Locale = 'en' | 'ur';
export const DICTIONARIES: Record<Locale, Record<Key, string>> = { en, ur };
export const isRtl = (l: Locale): boolean => l === 'ur';

/** {name} placeholders. Missing values stay visible rather than silently disappearing. */
export function translate(locale: Locale, key: Key, vars: Record<string, string | number> = {}): string {
  const s = DICTIONARIES[locale][key] ?? en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
/** An API error code → a message in the staff member's language; unknown codes fall back to a generic one. */
export function errorText(locale: Locale, code: string | undefined): string {
  const key = `err.${code}` as Key;
  return key in en ? translate(locale, key) : translate(locale, 'err.generic');
}

interface Ctx { locale: Locale; setLocale: (l: Locale) => void; t: (k: Key, v?: Record<string, string | number>) => string; err: (code?: string) => string }
const LocaleCtx = createContext<Ctx | null>(null);
const STORE = 'hos.locale';
const read = (): Locale | null => { try { const v = localStorage.getItem(STORE); return v === 'ur' || v === 'en' ? v : null; } catch { return null; } };

export function LocaleProvider({ initial, onChange, children }: { initial?: Locale; onChange?: (l: Locale) => void; children: ReactNode }) {
  const [locale, setLoc] = useState<Locale>(() => read() ?? initial ?? 'en');
  useEffect(() => { document.documentElement.lang = locale; document.documentElement.dir = isRtl(locale) ? 'rtl' : 'ltr'; }, [locale]);
  const setLocale = useCallback((l: Locale) => { setLoc(l); try { localStorage.setItem(STORE, l); } catch { /* private mode */ } onChange?.(l); }, [onChange]);
  const value = useMemo<Ctx>(() => ({ locale, setLocale, t: (k, v) => translate(locale, k, v), err: (c) => errorText(locale, c) }), [locale, setLocale]);
  return <LocaleCtx.Provider value={value}>{children}</LocaleCtx.Provider>;
}
export function useT(): Ctx { const c = useContext(LocaleCtx); if (!c) throw new Error('LocaleProvider missing'); return c; }
