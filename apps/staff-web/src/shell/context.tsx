import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { IconName } from '../ui/icons.js';

/** Commands that the page currently on screen offers to the command palette ("Check in", "Move guest"…). */
export interface Command { id: string; label: string; hint?: string; icon?: IconName; run: () => void; keys?: string }
interface Ctx { commands: Command[]; set: (owner: string, list: Command[]) => void }
const C = createContext<Ctx>({ commands: [], set: () => undefined });
export const useCommands = () => useContext(C);

export function CommandsProvider({ children }: { children: ReactNode }) {
  const [by, setBy] = useState<Record<string, Command[]>>({});
  const set = useRef((owner: string, list: Command[]) => setBy((m) => { if (!list.length) { if (!(owner in m)) return m; const { [owner]: _drop, ...rest } = m; return rest; } return { ...m, [owner]: list }; })).current;
  return <C.Provider value={{ commands: Object.values(by).flat(), set }}>{children}</C.Provider>;
}
/** Offers `list` to the palette while the calling screen is mounted, and wires single-key shortcuts (ignored while typing). */
export function useRegisterCommands(owner: string, list: Command[]) {
  const { set } = useCommands();
  const ref = useRef(list); ref.current = list;
  const sig = list.map((c) => c.id + c.label).join('|');
  useEffect(() => { set(owner, ref.current); return () => set(owner, []); }, [owner, sig, set]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null; if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const hit = ref.current.find((c) => c.keys && c.keys.toLowerCase() === e.key.toLowerCase());
      if (hit) { e.preventDefault(); hit.run(); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
}

/** The inbox is read once for the shell (bell, nav badge) and shared with the Inbox page. */
export interface InboxItem { id: string; kind: string; level: 'BLOCKER' | 'ACTION' | 'INFO'; at: string | null; reservationId?: string; roomNumber?: string; guest?: string; amount?: { amount: string; currency: string }; count?: number; title?: string }
export interface InboxData { businessDate: string; summary: { blockers: number; actions: number; total: number }; items: InboxItem[] }
const I = createContext<{ data: InboxData | null; offline: boolean; reload: () => void }>({ data: null, offline: false, reload: () => undefined });
export const InboxProvider = I.Provider;
export const useInbox = () => useContext(I);
