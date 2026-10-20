/** Thin fetch wrapper: cookie session, CSRF header on writes, problem+json errors. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body: Record<string, unknown> = {}) { super(message); }
}
/** The request never reached the server (no signal, server down). The caller may queue it. */
export class NetworkError extends Error {}

let csrf: string | null = null;
export const setCsrf = (t: string | null) => { csrf = t; };
type Listener = () => void;
const unauth = new Set<Listener>();
export const onUnauthenticated = (fn: Listener) => { unauth.add(fn); return () => { unauth.delete(fn); }; };

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const h: Record<string, string> = { accept: 'application/json', ...headers };
  const form = typeof FormData !== 'undefined' && body instanceof FormData;     // a file upload: the browser sets the multipart boundary itself
  if (body !== undefined && !form) h['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) h['x-csrf-token'] = csrf;
  let res: Response;
  try {
    res = await fetch(path, { method, headers: h, credentials: 'same-origin', body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body) });
  } catch {
    throw new NetworkError('network');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* a proxy error page, not JSON */ }
  if (!res.ok) {
    if (res.status === 401 && path !== '/v1/auth/login') unauth.forEach((f) => f());
    throw new ApiError(res.status, String(json.code ?? (res.status >= 500 ? 'SERVER_ERROR' : 'ERROR')), String(json.detail ?? res.statusText), json);
  }
  return json as T;
}
