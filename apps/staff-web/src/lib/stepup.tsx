import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { ErrorLine, Sheet } from '../ui/kit.js';

type Ask = () => Promise<void>;
const Ctx = createContext<Ask | null>(null);

/** Sensitive actions need a fresh second factor. Wrap the call: if the server says MFA_REQUIRED, ask for the code and try once more. */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [open, setOpen] = useState(false); const [code, setCode] = useState(''); const [err, setErr] = useState<string>();
  const waiter = useRef<{ ok: () => void; no: () => void } | null>(null);
  const ask = useCallback(() => new Promise<void>((ok, no) => { waiter.current = { ok, no }; setCode(''); setErr(undefined); setOpen(true); }), []);
  const verify = async () => {
    try { await api('POST', '/v1/auth/mfa/verify', { code: code.trim() }); setOpen(false); waiter.current?.ok(); }
    catch (e) { setErr(e instanceof ApiError ? e.code : 'generic'); }
  };
  const cancel = () => { setOpen(false); waiter.current?.no(); };
  return (
    <Ctx.Provider value={ask}>{children}
      {open && (
        <Sheet title={t('stepup.title')} onClose={cancel}>
          <p>{t('stepup.why')}</p>
          <label>{t('login.mfa')}<input inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" onKeyDown={(e) => { if (e.key === 'Enter') void verify(); }} /></label>
          <ErrorLine code={err} />
          <div className="actions"><button className="primary" onClick={verify}>{t('login.mfaSubmit')}</button><button onClick={cancel}>{t('common.cancel')}</button></div>
        </Sheet>
      )}
    </Ctx.Provider>
  );
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
