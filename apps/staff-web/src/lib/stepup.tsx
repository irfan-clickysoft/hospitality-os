import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { ErrorLine, Sheet } from '../ui/kit.js';

type Ask = () => Promise<void>;
interface View { open: boolean; code: string; setCode: (c: string) => void; err?: string; verify: () => void; cancel: () => void; slots: string[]; join: (id: string) => () => void }
const Ctx = createContext<Ask | null>(null);
const ViewCtx = createContext<View | null>(null);

/**
 * Sensitive actions need a fresh second factor. Wrap the call: if the server says MFA_REQUIRED, ask for the code and try once more.
 * The prompt appears **in place**: inside the innermost side panel or workflow page that has a <StepUpSlot/>, so no dialog is opened over another.
 * Only where there is no slot (a plain list or an older sheet) does it fall back to a sheet.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [open, setOpen] = useState(false); const [code, setCode] = useState(''); const [err, setErr] = useState<string>(); const [slots, setSlots] = useState<string[]>([]);
  const waiter = useRef<{ ok: () => void; no: () => void } | null>(null);
  const ask = useCallback(() => new Promise<void>((ok, no) => { waiter.current = { ok, no }; setCode(''); setErr(undefined); setOpen(true); }), []);
  const verify = async () => {
    try { await api('POST', '/v1/auth/mfa/verify', { code: code.trim() }); setOpen(false); waiter.current?.ok(); }
    catch (e) { setErr(e instanceof ApiError ? e.code : 'generic'); }
  };
  const cancel = () => { setOpen(false); waiter.current?.no(); };
  const join = useCallback((id: string) => { setSlots((x) => [...x, id]); return () => setSlots((x) => x.filter((y) => y !== id)); }, []);
  const view: View = { open, code, setCode, err, verify: () => void verify(), cancel, slots, join };
  return (
    <Ctx.Provider value={ask}><ViewCtx.Provider value={view}>{children}
      {open && slots.length === 0 && <Sheet title={t('stepup.title')} onClose={cancel}><StepUpForm v={view} /></Sheet>}
    </ViewCtx.Provider></Ctx.Provider>
  );
}

function StepUpForm({ v }: { v: View }) {
  const { t } = useT();
  return (
    <div className="stepup" role="group" aria-labelledby="stepup-h">
      <h3 id="stepup-h">{t('stepup.title')}</h3>
      <p>{t('stepup.why')}</p>
      <label>{t('login.mfa')}<input data-autofocus inputMode="numeric" autoComplete="one-time-code" autoFocus value={v.code} onChange={(e) => v.setCode(e.target.value)} dir="ltr" onKeyDown={(e) => { if (e.key === 'Enter') v.verify(); }} /></label>
      <ErrorLine code={v.err} />
      <div className="actions"><button className="primary" onClick={v.verify}>{t('login.mfaSubmit')}</button><button onClick={v.cancel}>{t('common.cancel')}</button></div>
    </div>
  );
}

/** Put one inside a panel or workflow page. When the server asks for a second factor, the prompt shows here (in the most recently opened slot only). */
export function StepUpSlot() {
  const v = useContext(ViewCtx); const id = useRef(`s${Math.random().toString(36).slice(2)}`).current;
  useEffect(() => v?.join(id), [v?.join, id]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!v || !v.open || v.slots[v.slots.length - 1] !== id) return null;
  return <div className="stepup-slot"><StepUpForm v={v} /></div>;
}
/** `await withStepUp(() => api(...))` — runs the call, asking for a code once if the server requires it. */
export function useStepUp() {
  const ask = useContext(Ctx);
  return useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); }
    catch (e) {
      if (e instanceof ApiError && e.code === 'MFA_REQUIRED' && ask) { await ask(); return fn(); }
      throw e;
    }
  }, [ask]);
}
