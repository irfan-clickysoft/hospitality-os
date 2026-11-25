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
  app = await createTestApp(); T = await provision(app, 'corpfin'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true });
  const acc = await addUser(T.tenantId, 'accountant@corp.test'); await assignRole(T.tenantId, acc, 'accountant', 'TENANT', null);
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
  const fd = await addUser(T.tenantId, 'desk@corpfin.test'); await assignRole(T.tenantId, fd, 'front_desk_agent', 'TENANT', null);
  FD = as(T.tenantId, fd); FDM = as(T.tenantId, fd, { mfa: true });
});
async function company(over: Record<string, unknown> = {}) {
  return ok(call('POST', '/v1/companies', OM, { name: `Acme ${++n} Ltd`, ntn: '1234567-8', creditLimit: '100000', termsDays: 30, ...over }), 201);
}
const usedRooms = new Map<string, number>();
/** A stay with a manual charge of `amount` outstanding on the bill (nights post at the night audit). */
async function stayOwing(w: W, companyId: string | null, amount = '5000') {
  await setBd(w, '2026-11-05'); at('2026-11-05', '10:00');
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: '2026-11-05', departure: '2026-11-06', adults: 1, channel: 'PHONE', ...(companyId ? { companyId } : {}) })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Traveller ${++n}`, phone: `0300${String(6000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'CORPORATE', lines: [{ quoteToken: q.options[0].quoteToken }] }, key()), 201);
  const b = { id: r.id as string, line: r.lines[0].id as string };
  const room = Object.keys(w.room).sort()[(usedRooms.get(w.pid) ?? 0)]!; usedRooms.set(w.pid, (usedRooms.get(w.pid) ?? 0) + 1);
  await adminDb.updateTable('room').set({ hk_status: 'CLEAN' }).where('id', '=', w.room[room]!).execute();
  await checkIn(w, b, room);
  const f = await folio(w, b);
  await charge(w, f.folio.id, amount);
  return { ...b, folioId: f.folio.id as string };
}
const bill = (w: W, b: { id: string }, body: Record<string, unknown> = {}, h: Record<string, string> = O) => call('POST', u(w, `reservations/${b.id}/bill-to-company`), h, body, key());
const owes = async (id: string) => (await ok(call('GET', `/v1/companies/${id}`, O))).owed.amount as string;
const receipt = (cid: string, body: Record<string, unknown>, h: Record<string, string> = ACC) => call('POST', `/v1/companies/${cid}/receipts`, h, { method: 'BANK_TRANSFER', receivedOn: '2026-11-05', reference: `REF-${++n}-${Date.now()}`, counterparty: 'HBL', ...body });

const F = (t: string) => `/v1/finance/${t}`;
const net = async (code: string) => { const r = (await ok(call('GET', F('reports/trial-balance?from=2026-11-01&to=2026-12-31'), O))).rows.find((x: any) => x.code === code); return r ? { dr: r.closingDr, cr: r.closingCr } : { dr: '0.00', cr: '0.00' }; };
describe('company receipts in the ledger', () => {
  it('billing a company moves the amount from the guest ledger to receivables; a verified payment clears it, with withheld tax shown apart', async () => {
    await ok(call('POST', F('accounts/starter'), OM)); await ok(call('POST', F('pms/enable'), OM, { from: '2026-11-01' }));
    const w = await sunset(); const c = await company(); const b = await stayOwing(w, c.id, '5000');
    expect(await net('1250')).toEqual({ dr: '5000.00', cr: '0.00' });
    await ok(bill(w, b), 201);
    expect(await net('1250')).toEqual({ dr: '0.00', cr: '0.00' }); expect(await net('1200')).toEqual({ dr: '5000.00', cr: '0.00' });
    const r = await ok(receipt(c.id, { amount: '4000', withheld: '1000', withholdingRef: 'CPR-1' }), 201);
    expect(await net('1200')).toEqual({ dr: '5000.00', cr: '0.00' });                      // not until it is verified
    await ok(call('POST', `/v1/ar/receipts/${r.id}/verify`, O, { approve: true }));
    expect(await net('1200')).toEqual({ dr: '0.00', cr: '0.00' }); expect(await net('1800')).toEqual({ dr: '4000.00', cr: '0.00' }); expect(await net('1310')).toEqual({ dr: '1000.00', cr: '0.00' });
  });
});
