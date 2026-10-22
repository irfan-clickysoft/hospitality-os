// Shared by the browser tests: sign in through the API (so a scenario can be prepared without clicking), and a few helpers.
export const BASE = process.env.STAFF_URL ?? 'http://localhost:3001';
export const PASSWORD = process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase';

export async function session(email, { tenant = 'sunset', password = PASSWORD } = {}) {
  let cookie = ''; let csrf = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { accept: 'application/json', origin: BASE, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie?.() ?? []; if (set.length) cookie = [...new Map([...cookie.split('; ').filter(Boolean), ...set.map((c) => c.split(';')[0])].map((c) => [c.split('=')[0], c])).values()].join('; ');
    const text = await res.text(); const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status} ${json.code ?? ''} ${json.detail ?? ''}`), { status: res.status, code: json.code });
    return json;
  };
  const r = await call('POST', '/v1/auth/login', { tenant, email, password }); csrf = r.csrfToken;
  return { call, get: (p) => call('GET', p), post: (p, b = {}, h) => call('POST', p, b, h), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b) };
}

export const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

/** A booking by phone for a new guest, as the front desk would make it. Returns ids. */
export async function book(s, pid, { name, phone, arrival, nights = 2, type = 'EXE', adults = 2 }) {
  const g = await s.post('/v1/guests', { fullName: name, ...(phone ? { phone } : {}), nationality: 'PK' });
  const q = await s.post(`/v1/properties/${pid}/quotes`, { arrival, departure: addDays(arrival, nights), adults, children: 0, residency: 'RESIDENT' });
  const opt = q.options.find((o) => o.roomType.code === type);
  if (!opt) throw new Error(`no quote for ${type}`);
  const r = await s.post(`/v1/properties/${pid}/reservations`, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: opt.quoteToken }] }, { 'idempotency-key': `e2e-${Math.random().toString(36).slice(2)}` });
  return { id: r.id, line: r.lines[0].id, confirmationNo: r.confirmationNo, guestId: g.id };
}
export const cnic = (k) => `3520212345${String(100 + (k % 800)).padStart(3, '0')}`;

/** Where the screens that used to be tabs live now. The tests go by address, as a bookmark would. */
export const ROUTES = { Today: '/today', Bookings: '/reservations?tab=bookings', Cashier: '/reservations?tab=cashier', Companies: '/reservations?tab=companies', 'OTA claims': '/reservations?tab=ota', 'Conference room': '/reservations?tab=spaces',
  Rack: '/calendar', 'ریک': '/calendar', 'Night audit': '/reports?tab=nightaudit', Reports: '/reports?tab=downloads', Rates: '/admin?tab=rates', Accounts: '/admin?tab=accounts', Rooms: '/admin?tab=rooms', Tax: '/admin?tab=tax', 'Setup check': '/admin?tab=readiness',
  Staff: '/admin?tab=staff', Menus: '/admin?tab=menus', Recipes: '/admin?tab=recipes', Kitchen: '/tasks?tab=kitchen', Board: '/housekeeping?tab=board', Repairs: '/tasks?tab=maintenance' };
export const goTab = async (page, name) => { await page.evaluate((h) => { window.location.hash = h; }, ROUTES[name]); await page.waitForTimeout(300); };
export const mainNav = (page) => page.getByRole('navigation', { name: /Main navigation|مین مینو/ }).first();
/** The language switch lives in the profile menu. */
export async function setLang(page, lang) {
  await page.getByRole('button', { name: /Your profile|آپ کا پروفائل/ }).click();
  await page.getByRole('button', { name: lang === 'ur' ? 'اردو' : 'English' }).click();
}
