import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { zonedToUtcMs } from '@hos/domain-types';
import { addUser, adminDb, as, assignRole, createTestApp, provision, testClock } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>;
let O: Record<string, string>, OM: Record<string, string>, ACC: ReturnType<typeof as>, ACCM: ReturnType<typeof as>;
const OPEN = '2026-11-01';
let n = 0;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...headers, ...extra }, payload: body as object | undefined });
const ok = async (r: Promise<any>, status = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(status); return x.json(); };
const code = async (r: Promise<any>, status: number, c: string) => { const x = await r; expect(x.statusCode, x.body).toBe(status); expect(x.json().code).toBe(c); return x.json(); };
const key = () => ({ 'idempotency-key': `tx-${++n}-${Date.now()}` });
const at = (date: string, time: string) => testClock.set(zonedToUtcMs(date, time, 'Asia/Karachi'));

beforeAll(async () => {
  app = await createTestApp(); T = await provision(app, 'imp'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true });
  const acc = await addUser(T.tenantId, 'accountant@imp.test'); await assignRole(T.tenantId, acc, 'accountant', 'TENANT', null);
  ACC = as(T.tenantId, acc); ACCM = as(T.tenantId, acc, { mfa: true });
});
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

// Fictional rates for the tests only — the product itself ships with none.
const version = (o: Record<string, unknown> = {}) => ({ rateBp: 1000, appliesTo: ['ROOM', 'ROOM_EXTRAS'], effectiveFrom: '2026-01-01', ...o });
async function activate(codeName: string, jurisdiction: string, v: Record<string, unknown> = {}, name = codeName) {
  const c = await ok(call('POST', '/v1/tax/codes', ACCM, { code: codeName, name, jurisdiction, version: version(v) }), 201);
  const a = await ok(call('POST', `/v1/tax/versions/${c.version.id}/approve`, OM, { advisorRef: 'TEST-ADVISOR-1', legalBasis: 'Test fixture, not law' }));
  return { codeId: c.id as string, versionId: a.id as string };
}
async function sunset(jurisdiction?: string) {
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `TX${++n}`, name: `Tax ${n}` })).json().id as string;
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'STD', name: 'Standard', maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id as string;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt, from: 101, to: 104 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  const bar = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'BAR', residency: 'RESIDENT', ...rules })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, O, { items: [{ roomTypeId: rt, amount: '12000', extraAdult: '3000', extraChild: '1500' }] });
  const intl = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'INTL', name: 'Intl', residency: 'NON_RESIDENT', ...rules, derive: { parentPlanId: bar, type: 'PERCENT', value: 0, roundTo: '1' } })).json().id as string;
  void intl;
  const rooms = (await call('GET', `/v1/properties/${pid}/rooms`, O)).json().items as Array<{ id: string; number: string }>;
  if (jurisdiction) await ok(call('PUT', `/v1/properties/${pid}/tax-jurisdiction`, OM, { jurisdiction }));
  return { pid, rt, room: Object.fromEntries(rooms.map((r) => [r.number, r.id])) as Record<string, string> };
}
type W = Awaited<ReturnType<typeof sunset>>;
const u = (w: W, tail: string) => `/v1/properties/${w.pid}/${tail}`;
const setBd = (w: W, d: string) => adminDb.updateTable('property').set({ business_date: d }).where('id', '=', w.pid).execute();
async function book(w: W, o: { arrival?: string; departure?: string; nationality?: string; name?: string } = {}) {
  const foreign = !!o.nationality && o.nationality !== 'PK';
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival ?? '2026-11-05', departure: o.departure ?? '2026-11-07', adults: 2, channel: 'PHONE', residency: foreign ? 'NON_RESIDENT' : 'RESIDENT' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: o.name ?? `Guest ${++n}`, phone: `0300${String(7000000 + n).slice(-7)}`, nationality: o.nationality ?? 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string, quote: q };
}
const checkIn = (w: W, b: { id: string; line: string }, room: string, passport = false) => ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-in`), O, { roomId: w.room[room], occupants: [passport ? { fullName: 'Guest', isPrimary: true, idType: 'PASSPORT', idNumber: 'GB1234567', nationality: 'GB' } : { fullName: 'Guest', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671' }] }));
const checkOut = (w: W, b: { id: string; line: string }, body: Record<string, unknown> = {}) => call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-out`), OM, body);
const folio = (w: W, b: { id: string }) => ok(call('GET', u(w, `reservations/${b.id}/folio`), O));
const bal = async (w: W, b: { id: string }) => (await folio(w, b)).folio.balance.amount as string;
const charge = (w: W, fid: string, amount: string, txnCode = 'FNB') => ok(call('POST', u(w, `folios/${fid}/charges`), O, { txnCode, amount, description: 'Item' }), 201);



let FD: ReturnType<typeof as>, FDM: ReturnType<typeof as>;
beforeAll(async () => {
  const fd = await addUser(T.tenantId, 'desk@imp.test'); await assignRole(T.tenantId, fd, 'front_desk_agent', 'TENANT', null);
  FD = as(T.tenantId, fd); FDM = as(T.tenantId, fd, { mfa: true });
});
const g = (o: Record<string, unknown>) => ({ fullName: '', phone: '', email: '', nationality: '', vip: '', notes: '', ...o });
const k = () => ({ 'idempotency-key': `imp-${++n}-${Date.now()}` });

describe('importing guests', () => {
  it('previews without changing anything: new, already known, repeated in the file, and rows with problems — Excel numbers lose their leading zero and nationalities arrive as names', async () => {
    const existing = await ok(call('POST', '/v1/guests', O, { fullName: 'Existing Person', phone: '0300 7770001', nationality: 'PK' }), 201);
    const rows = [
      g({ fullName: 'Ali Raza', phone: '3001234501', nationality: 'Pakistan', vip: 'yes' }),          // 10 digits: leading 0 lost
      g({ fullName: 'Existing Again', phone: '+92 300 7770001' }),                                      // same person as an existing guest
      g({ fullName: 'Sara Khan', email: 'Sara@Example.com', nationality: 'British' }),
      g({ fullName: 'Sara K', email: 'sara@example.com' }),                                              // same email again
      g({ fullName: '', phone: '12345' }),                                                               // no name, short phone
      g({ fullName: 'Odd Country', nationality: 'Atlantis' }),
      g({ fullName: 'Bad Mail', email: 'not-an-email' }),
    ];
    const p = await ok(call('POST', '/v1/imports/guests/preview', OM, { rows }));
    expect(p.summary).toEqual({ total: 7, new: 2, exists: 1, duplicateInFile: 1, invalid: 3 });
    expect(p.rows.map((r: any) => r.status)).toEqual(['NEW', 'EXISTS', 'NEW', 'DUPLICATE_IN_FILE', 'INVALID', 'INVALID', 'INVALID']);
    expect(p.rows[1].existing).toEqual({ id: existing.id, name: 'Existing Person' });
    expect(p.rows[3].errors).toEqual(['SAME_AS_ROW_3']);
    expect(p.rows[4].errors).toEqual(expect.arrayContaining(['NAME_REQUIRED', 'PHONE_INVALID']));
    expect(p.rows[5].errors).toEqual(['NATIONALITY_UNKNOWN']); expect(p.rows[6].errors).toEqual(['EMAIL_INVALID']);
    expect((await ok(call('GET', '/v1/guests/search?q=Ali%20Raza', O))).items ?? []).toHaveLength(0);   // nothing was created
  });

  it('commits what is valid, once; a retry with the same key changes nothing; existing guests are skipped or have only their blanks filled; every row is checked again', async () => {
    const ex = await ok(call('POST', '/v1/guests', O, { fullName: 'Fill Me', phone: '0300 7770002' }), 201);
    const rows = [g({ fullName: 'Imported One', phone: '3001234502', nationality: 'PK', vip: 'Y', notes: 'prefers ground floor' }), g({ fullName: 'Imported Two', email: 'two@example.com', nationality: 'US' }),
      g({ fullName: 'Fill Me Again', phone: '03007770002', email: 'fill@example.com', nationality: 'Canada', notes: 'from sheet' }), g({ fullName: '' })];
    const kk = k();
    const r1 = await ok(call('POST', '/v1/imports/guests', OM, { rows, onExisting: 'FILL_BLANKS' }, kk), 201);
    expect(r1.summary).toMatchObject({ total: 4, created: 2, filled: 1, exists: 1, invalid: 1 });
    expect(r1.rows.map((x: any) => x.action)).toEqual(['CREATED', 'CREATED', 'FILLED', 'SKIPPED']);
    const again = await ok(call('POST', '/v1/imports/guests', OM, { rows, onExisting: 'FILL_BLANKS' }, kk), 200); expect(again.replayed).toBe(true);
    const one = (await ok(call('GET', '/v1/guests/search?q=Imported%20One', O)))[0] ?? (await ok(call('GET', '/v1/guests/search?q=Imported%20One', O))).items?.[0];
    expect(one).toMatchObject({ fullName: 'Imported One', phone: '03001234502', nationality: 'PK', residency: 'RESIDENT', vip: true });
    const filled = await ok(call('GET', `/v1/guests/${ex.id}`, O));
    expect(filled).toMatchObject({ email: 'fill@example.com', nationality: 'CA', residency: 'NON_RESIDENT', notes: 'from sheet', fullName: 'Fill Me' });         // name untouched
    // a second import of the same sheet (new key): everyone is known now, nothing is created
    const r2 = await ok(call('POST', '/v1/imports/guests', OM, { rows }, k()), 201);
    expect(r2.summary).toMatchObject({ created: 0, exists: 3, invalid: 1 });
    const log = await adminDb.selectFrom('audit_log').select('action').where('tenant_id', '=', T.tenantId).where('action', '=', 'import.guests').execute();
    expect(log.length).toBeGreaterThanOrEqual(2);
  });

  it('is for people who may import, with a fresh second factor; the size is limited', async () => {
    const rows = [g({ fullName: 'Nobody Special' })];
    await code(call('POST', '/v1/imports/guests', FDM, { rows }, k()), 403, 'PERMISSION_DENIED');
    await code(call('POST', '/v1/imports/guests/preview', O, { rows }), 403, 'MFA_REQUIRED');
    await code(call('POST', '/v1/imports/guests', OM, { rows }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
    await code(call('POST', '/v1/imports/guests/preview', OM, { rows: [] }), 400, 'VALIDATION_FAILED');
    await code(call('POST', '/v1/imports/guests/preview', OM, { rows: Array.from({ length: 2001 }, () => g({ fullName: 'Too Many' })) }), 400, 'VALIDATION_FAILED');
  });
});

describe('importing corporate accounts', () => {
  const c = (o: Record<string, unknown>) => ({ name: '', ntn: '', strn: '', address: '', contactName: '', contactPhone: '', contactEmail: '', creditLimit: '', termsDays: '', notes: '', ...o });
  it('creates new companies with their limits and terms, skips ones that exist, and reports the rest; credit needs the second factor', async () => {
    await ok(call('POST', '/v1/companies', O, { name: 'Already Here Ltd' }), 201);
    const rows = [c({ name: 'Alpha Traders', ntn: '1111111-1', creditLimit: 'Rs. 250,000', termsDays: '30 days', contactEmail: 'a@alpha.test' }), c({ name: 'already here ltd' }), c({ name: 'Beta  Corp', creditLimit: '100000', termsDays: '15' }),
      c({ name: 'Alpha Traders' }), c({ name: 'Bad Limit', creditLimit: 'lots' }), c({ name: '', ntn: '5' }), c({ name: 'No Credit Co' })];
    const p = await ok(call('POST', '/v1/imports/companies/preview', OM, { rows }));
    expect(p.summary).toEqual({ total: 7, new: 3, exists: 1, duplicateInFile: 1, invalid: 2 });
    expect(p.rows.map((r: any) => r.status)).toEqual(['NEW', 'EXISTS', 'NEW', 'DUPLICATE_IN_FILE', 'INVALID', 'INVALID', 'NEW']);
    const nom = as(T.tenantId, T.ownerUserId, { mfa: false });
    await code(call('POST', '/v1/imports/companies', nom, { rows }, k()), 403, 'MFA_REQUIRED');
    const r = await ok(call('POST', '/v1/imports/companies', OM, { rows }, k()), 201);
    expect(r.summary).toMatchObject({ created: 3 });
    const list = (await ok(call('GET', '/v1/companies?q=alpha', O))).items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Alpha Traders', ntn: '1111111-1', creditLimit: { amount: '250000.00' }, termsDays: 30, contactEmail: 'a@alpha.test' });
    expect((await ok(call('GET', '/v1/companies?q=beta', O))).items[0]).toMatchObject({ name: 'Beta Corp', termsDays: 15, creditLimit: { amount: '100000.00' } });
    expect((await ok(call('GET', '/v1/companies?q=no%20credit', O))).items[0].creditLimit.amount).toBe('0.00');
    // companies with no credit need no second factor
    const free = await ok(call('POST', '/v1/imports/companies', as(T.tenantId, T.ownerUserId, { mfa: true }), { rows: [c({ name: 'Zero Credit LLC' })] }, k()), 201);
    expect(free.summary.created).toBe(1);
  });
});
