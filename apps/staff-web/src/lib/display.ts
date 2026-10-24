import { useSyncExternalStore } from 'react';

/** How the app looks for this person on this device: day or night, text size, stronger contrast, calmer motion. Kept in the browser, applied before the first screen draws. */
export interface Display { theme: 'auto' | 'light' | 'dark'; text: 'normal' | 'large' | 'xlarge'; contrast: 'normal' | 'high'; motion: 'auto' | 'reduce' }
const KEY = 'hos.display';
const DEFAULT: Display = { theme: 'auto', text: 'normal', contrast: 'normal', motion: 'auto' };
const ok = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all as readonly string[]).includes(v as string) ? (v as T) : d;

function read(): Display {
  try { const j = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Display>; return { theme: ok(j.theme, ['auto', 'light', 'dark'], 'auto'), text: ok(j.text, ['normal', 'large', 'xlarge'], 'normal'), contrast: ok(j.contrast, ['normal', 'high'], 'normal'), motion: ok(j.motion, ['auto', 'reduce'], 'auto') }; }
  catch { return DEFAULT; }
}
let current: Display = read();
const subs = new Set<() => void>();

const prefersDark = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
/** The theme actually showing right now (what "auto" resolves to). */
export const effectiveTheme = (d: Display = current): 'light' | 'dark' => (d.theme === 'auto' ? (prefersDark() ? 'dark' : 'light') : d.theme);

export function apply(d: Display = current): void {
  const el = document.documentElement;
  if (d.theme === 'auto') el.removeAttribute('data-theme'); else el.setAttribute('data-theme', d.theme);
  if (d.text === 'normal') el.removeAttribute('data-text'); else el.setAttribute('data-text', d.text);
  if (d.contrast === 'normal') el.removeAttribute('data-contrast'); else el.setAttribute('data-contrast', d.contrast);
  if (d.motion === 'auto') el.removeAttribute('data-motion'); else el.setAttribute('data-motion', d.motion);
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', effectiveTheme(d) === 'dark' ? '#0d1217' : '#ffffff');
}
export function setDisplay(patch: Partial<Display>): void {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* the choice lasts for this visit only */ }
  apply(current); subs.forEach((f) => f());
}
export const resetDisplay = () => setDisplay(DEFAULT);

/** Starts the app in the person's own look and follows the device when the theme is "automatic". */
export function initDisplay(): void {
  apply(current);
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (current.theme === 'auto') { apply(current); subs.forEach((f) => f()); } });
}
export function useDisplay(): Display & { effective: 'light' | 'dark' } {
  const d = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => current);
  return { ...d, effective: effectiveTheme(d) };
}
