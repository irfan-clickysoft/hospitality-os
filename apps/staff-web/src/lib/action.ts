import { useCallback, useState } from 'react';
import { ApiError, NetworkError } from '../api/client.js';
import type { Problem } from '../ui/kit.js';

/** Runs an async handler, keeps `busy` and the last problem (with the server's own message as a fallback). */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setProblem(null);
    try { return await fn(); }
    catch (e) { setProblem(e instanceof ApiError ? { code: e.code, detail: e.message } : e instanceof NetworkError ? { code: 'network' } : { code: 'generic' }); return undefined; }
    finally { setBusy(false); }
  }, []);
  return { busy, problem, run, clear: () => setProblem(null), setProblem };
}
