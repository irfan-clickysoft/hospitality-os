import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { zonedToUtcMs } from '@hos/domain-types';
import { addUser, adminDb, as, assignRole, createTestApp, provision, testClock } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>;
let O: Record<string, string>, OM: Record<string, string>;
const OPEN = '2026-11-01';
let n = 0;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, body?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...headers, ...extra }, payload: body as object | undefined });
const ok = async (r: Promise<any>, status = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(status); return x.json(); };
const code = async (r: Promise<any>, status: number, c: string) => { const x = await r; expect(x.statusCode, x.body).toBe(status); expect(x.json().code).toBe(c); return x.json(); };
const key = () => ({ 'idempotency-key': `na-${++n}-${Date.now()}` });
const at = (date: string, time: string) => testClock.set(zonedToUtcMs(date, time, 'Asia/Karachi'));

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'cmp'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
afterAll(async () => { await app.close(); testClock.reset(); });
beforeEach(() => testClock.reset());

async function sunset() {
  const pid = (await call('POST', '/v1/properties', O, { legalEntityId: T.legalEntityId, code: `NA${++n}`, name: `Audit ${n}` })).json().id as string;
  const rt = (await call('POST', `/v1/properties/${pid}/room-types`, O, { code: 'STD', name: 'Standard', maxAdults: 3, maxChildren: 2, maxOccupancy: 4, baseOccupancy: 2 })).json().id as string;
  await call('POST', `/v1/properties/${pid}/rooms/bulk`, O, { roomTypeId: rt, from: 101, to: 104 });
  await call('POST', `/v1/properties/${pid}/go-live`, O, { openingBusinessDate: OPEN });
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  const bar = (await call('POST', `/v1/properties/${pid}/rate-plans`, O, { code: 'BAR', name: 'BAR', residency: 'RESIDENT', ...rules })).json().id as string;
  await call('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, O, { items: [{ roomTypeId: rt, amount: '12000', extraAdult: '3000', extraChild: '1500' }] });
  const rooms = (await call('GET', `/v1/properties/${pid}/rooms`, O)).json().items as Array<{ id: string; number: string }>;
  return { pid, rt, room: Object.fromEntries(rooms.map((r) => [r.number, r.id])) as Record<string, string> };
}
type W = Awaited<ReturnType<typeof sunset>>;
const u = (w: W, tail: string) => `/v1/properties/${w.pid}/${tail}`;
const setBd = (w: W, d: string) => adminDb.updateTable('property').set({ business_date: d }).where('id', '=', w.pid).execute();
const bdOf = async (w: W) => (await adminDb.selectFrom('property').select('business_date').where('id', '=', w.pid).executeTakeFirstOrThrow()).business_date;
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@cmp.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

async function book(w: W, o: { arrival?: string; departure?: string; hold?: number } = {}) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival ?? '2026-11-05', departure: o.departure ?? '2026-11-07', adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(6000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }], ...(o.hold ? { hold: { minutes: o.hold } } : {}) }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string };
}
const checkIn = (w: W, b: { id: string; line: string }, room: string) => ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-in`), O, { roomId: w.room[room], occupants: [{ fullName: 'Guest', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671' }] }));
const checkOut = (w: W, b: { id: string; line: string }) => ok(call('POST', u(w, `reservations/${b.id}/rooms/${b.line}/check-out`), OM, { balanceReason: 'test: settled elsewhere' }));
const audit = (w: W, body: Record<string, unknown> = {}, h = O) => call('POST', u(w, 'night-audit/runs'), h, body);
const folioOf = (w: W, b: { id: string }) => ok(call('GET', u(w, `reservations/${b.id}/folio`), O));


const rule = (o: Record<string, unknown> = {}) => ({ name: `Rule ${++n}`, stages: ['BOOKING'], conditions: {}, action: 'WARN', message: 'Please note this guest needs extra care.', ...o });
const mk = async (o: Record<string, unknown>, activate = true, h = OM) => {
  const r = await ok(call('POST', '/v1/compliance/rules', h, rule(o)), 201);
  return activate ? ok(call('PUT', `/v1/compliance/rules/${r.id}/status`, h, { status: 'ACTIVE', version: r.version })) : r;
};
const sunsetIntl = async () => {
  const w = await sunset();
  const bar = (await adminDb.selectFrom('rate_plan').select('id').where('property_id', '=', w.pid).where('code', '=', 'BAR').executeTakeFirstOrThrow()).id;
  const rules = { cancellationRule: { freeUntilHoursBefore: 72, feeType: 'NIGHTS', feeValue: 1 }, noShowRule: { feeType: 'NIGHTS', feeValue: 1 }, depositRule: { type: 'NIGHTS', value: 1, dueWithinHours: 24 } };
  await call('POST', u(w, 'rate-plans'), O, { code: 'INTL', name: 'Intl', residency: 'NON_RESIDENT', ...rules, derive: { parentPlanId: bar, type: 'PERCENT', value: 0, roundTo: '1' } });
  return w;
};
async function offAll() { await adminDb.updateTable('compliance_rule').set({ status: 'DISABLED' }).where('tenant_id', '=', T.tenantId).execute(); }
async function bookFor(w: W, nat: string, extra: Record<string, unknown> = {}, h = O, arrival = '2026-11-05', departure = '2026-11-06') {
  const foreign = nat !== 'PK';
  const q = (await call('POST', u(w, 'quotes'), O, { arrival, departure, adults: 2, channel: 'PHONE', residency: foreign ? 'NON_RESIDENT' : 'RESIDENT' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(3000000 + n).slice(-7)}`, nationality: nat }), 201);
  return call('POST', u(w, 'reservations'), h, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }], ...extra }, key());
}
const occ = (idType: string, nat: string) => [{ fullName: 'Main Guest', isPrimary: true, idType, idNumber: idType === 'PASSPORT' ? 'AB1234567' : '3520212345671', nationality: nat }];

describe('compliance rules', () => {
  it('are written by managers, apply only once active, and match by nationality, residency, property, party size and length of stay', async () => {
    await offAll();
    const w = await sunset(); const clerk = await staff(w, 'front_desk_agent');
    await code(call('POST', '/v1/compliance/rules', clerk.hm, rule()), 403, 'PERMISSION_DENIED');
    await code(call('POST', '/v1/compliance/rules', OM, rule({ action: 'REQUIRE_DOCUMENT' })), 400, 'VALIDATION_FAILED');       // needs the accepted ID types
    await code(call('POST', '/v1/compliance/rules', OM, rule({ conditions: { nationalities: ['PK'], color: 'red' } })), 400, 'VALIDATION_FAILED');
    const draft = await mk({ name: 'Afghan nationals: advisory', conditions: { nationalities: ['af'] }, message: 'Extra security advisory applies.', messageUr: 'اضافی حفاظتی ہدایت لاگو ہے۔' }, false);
    expect(draft).toMatchObject({ status: 'DRAFT', conditions: { nationalities: ['AF'] } });
    let hits = (await ok(call('POST', '/v1/compliance/check', clerk.h, { propertyId: w.pid, nationality: 'AF', guests: 2, nights: 1 }))).hits;
    expect(hits).toEqual([]);                                                                                       // a draft does nothing
    await ok(call('PUT', `/v1/compliance/rules/${draft.id}/status`, OM, { status: 'ACTIVE', version: draft.version }));
    await code(call('PUT', `/v1/compliance/rules/${draft.id}/status`, OM, { status: 'DISABLED', version: 1 }), 412, 'VERSION_CONFLICT');
    hits = (await ok(call('POST', '/v1/compliance/check', clerk.h, { propertyId: w.pid, nationality: 'AF', guests: 2, nights: 1 }))).hits;
    expect(hits.map((h: any) => h.name)).toEqual(['Afghan nationals: advisory']); expect(hits[0].messageUr).toContain('حفاظتی');
    expect((await ok(call('POST', '/v1/compliance/check', clerk.h, { propertyId: w.pid, nationality: 'PK' }))).hits).toEqual([]);
    await mk({ name: 'Big foreign party', conditions: { residency: 'NON_RESIDENT', minGuests: 5 }, stages: ['BOOKING', 'CHECK_IN'], action: 'INFO', message: 'Large foreign group.' });
    await mk({ name: 'Long foreign stay', conditions: { excludeNationalities: ['GB'], minNights: 7 }, action: 'INFO', message: 'Long stay.' });
    await mk({ name: 'Elsewhere only', conditions: { propertyIds: ['11111111-1111-4111-8111-111111111111'] }, action: 'INFO', message: 'Another property.' });
    const names = async (b: Record<string, unknown>) => (await ok(call('POST', '/v1/compliance/check', clerk.h, { propertyId: w.pid, ...b }))).hits.map((h: any) => h.name);
    expect(await names({ nationality: 'FR', guests: 5, nights: 1 })).toEqual(['Big foreign party']);
    expect(await names({ nationality: 'FR', guests: 2, nights: 7 })).toEqual(['Long foreign stay']);
    expect(await names({ nationality: 'GB', guests: 2, nights: 9 })).toEqual([]);
    expect(await names({ nationality: 'PK', guests: 9, nights: 1 })).toEqual([]);
    expect((await ok(call('GET', '/v1/compliance/rules', clerk.h))).items.length).toBeGreaterThanOrEqual(4);
  });

  it('at booking: a block refuses; an approval rule holds the booking until a manager approves with a reason and the second factor; warnings and tasks are recorded on the booking', async () => {
    await offAll();
    const w = await sunsetIntl(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const clerk = await staff(w, 'front_desk_agent');
    await mk({ name: 'Warn Canadians', conditions: { nationalities: ['CA'] }, action: 'WARN', message: 'Check the travel advisory for this guest.' });
    await mk({ name: 'Escort for Iranians', conditions: { nationalities: ['IR'] }, action: 'REQUIRE_TASK', taskTitle: 'Arrange security escort', message: 'An escort must be arranged.' });
    await mk({ name: 'GM approves Syrians', conditions: { nationalities: ['SY'] }, action: 'REQUIRE_APPROVAL', message: 'The GM must approve this booking.' });
    await mk({ name: 'No bookings from XX', conditions: { nationalities: ['KP'] }, action: 'BLOCK_BOOKING', message: 'We cannot accept this booking.' });

    const warn = await ok(bookFor(w, 'CA', {}, clerk.h), 201);
    expect(warn.compliance).toEqual([expect.objectContaining({ name: 'Warn Canadians', action: 'WARN', approved: false })]);
    expect((await ok(call('GET', u(w, `reservations/${warn.id}/compliance`), O))).hits).toEqual([expect.objectContaining({ rule: 'Warn Canadians', stage: 'BOOKING' })]);

    const task = await ok(bookFor(w, 'IR', {}, clerk.h), 201);
    const tasks = (await ok(call('GET', u(w, 'compliance-tasks'), clerk.h))).items;
    expect(tasks).toEqual([expect.objectContaining({ title: 'Arrange security escort', confirmationNo: task.confirmationNo, nationality: 'IR' })]);
    await ok(call('POST', u(w, `compliance-tasks/${tasks[0].id}/complete`), clerk.h, { note: 'Escort booked with the police liaison' }));
    expect((await ok(call('GET', u(w, 'compliance-tasks'), clerk.h))).items).toEqual([]);
    expect((await ok(call('GET', u(w, 'compliance-tasks?status=DONE'), clerk.h))).items).toHaveLength(1);
    await code(call('POST', u(w, `compliance-tasks/${tasks[0].id}/complete`), clerk.h, {}), 409, 'NOT_OPEN');

    const blocked = await code(bookFor(w, 'KP', {}, OM), 422, 'COMPLIANCE_BLOCKED');
    expect(blocked.hits[0].name).toBe('No bookings from XX');

    const held = await code(bookFor(w, 'SY', {}, clerk.hm), 403, 'COMPLIANCE_APPROVAL_REQUIRED');
    expect(held.overridable).toBe(true);
    await code(bookFor(w, 'SY', { complianceApproval: { reason: 'I allow it' } }, clerk.hm), 403, 'PERMISSION_DENIED');     // a clerk cannot approve
    await code(bookFor(w, 'SY', { complianceApproval: { reason: 'Known family guest of the owner' } }, O), 403, 'MFA_REQUIRED');
    const okBooking = await ok(bookFor(w, 'SY', { complianceApproval: { reason: 'Known family guest of the owner' } }, OM), 201);
    expect(okBooking.compliance[0]).toMatchObject({ name: 'GM approves Syrians', approved: true });
    const rec = await ok(call('GET', u(w, `reservations/${okBooking.id}/compliance`), O));
    expect(rec.hits[0]).toMatchObject({ approved: true, approvalReason: 'Known family guest of the owner' });
    const audit = await adminDb.selectFrom('audit_log').select(['action', 'reason_code']).where('tenant_id', '=', T.tenantId).where('resource_id', '=', okBooking.id).where('action', '=', 'compliance.hit').execute();
    expect(audit).toHaveLength(1);
  });

  it('at check-in: the document rule needs the right ID, approval given at booking carries over, a rule can block at the desk, and a walk-in goes through the same rules', async () => {
    await offAll();
    const w = await sunsetIntl(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    await mk({ name: 'CNIC for locals', stages: ['CHECK_IN'], conditions: { residency: 'RESIDENT' }, action: 'REQUIRE_DOCUMENT', documentTypes: ['CNIC', 'NICOP'], message: 'Local guests must show a CNIC.' });
    await mk({ name: 'Approve Syrians', stages: ['BOOKING', 'CHECK_IN'], conditions: { nationalities: ['SY'] }, action: 'REQUIRE_APPROVAL', message: 'Approval needed.' });
    const fr = await ok(bookFor(w, 'PK'), 201); const frLine = fr.lines[0].id;
    const ci = (b: any, line: string, occupants: unknown, h = O, extra = {}) => call('POST', u(w, `reservations/${b.id}/rooms/${line}/check-in`), h, { roomId: w.room['101'], occupants, ...extra });
    const miss = await code(ci(fr, frLine, occ('DRIVING_LICENSE', 'PK')), 422, 'DOCUMENT_REQUIRED'); expect(miss.accepted).toEqual(['CNIC', 'NICOP']);
    const done = await ok(ci(fr, frLine, occ('CNIC', 'PK')));
    expect(done.checkIn.compliance).toEqual([expect.objectContaining({ name: 'CNIC for locals', action: 'REQUIRE_DOCUMENT' })]);
    // approval at booking carries over to check-in: no second approval
    const sy = await ok(bookFor(w, 'SY', { complianceApproval: { reason: 'Approved by the GM on the phone' } }, OM), 201);
    await ok(ci(sy, sy.lines[0].id, occ('PASSPORT', 'SY'), O, { roomId: w.room['102'] }));
    // a booking made before the rule existed, arriving later: approval is asked at the desk
    await adminDb.updateTable('compliance_rule').set({ status: 'DISABLED' }).where('tenant_id', '=', T.tenantId).where('name', '=', 'Approve Syrians').execute();
    const late = await ok(bookFor(w, 'SY'), 201);
    await adminDb.updateTable('compliance_rule').set({ status: 'ACTIVE' }).where('tenant_id', '=', T.tenantId).where('name', '=', 'Approve Syrians').execute();
    await code(call('POST', u(w, `reservations/${late.id}/rooms/${late.lines[0].id}/check-in`), O, { roomId: w.room['103'], occupants: occ('PASSPORT', 'SY') }), 403, 'COMPLIANCE_APPROVAL_REQUIRED');
    await ok(call('POST', u(w, `reservations/${late.id}/rooms/${late.lines[0].id}/check-in`), OM, { roomId: w.room['103'], occupants: occ('PASSPORT', 'SY'), complianceApproval: { reason: 'Checked with the GM at the desk' } }));
    // a walk-in goes through the same rules
    await mk({ name: 'Block KP at the desk', stages: ['BOOKING', 'CHECK_IN'], conditions: { nationalities: ['KP'] }, action: 'BLOCK_BOOKING', message: 'Cannot accept.' });
    const rt = (await ok(call('GET', u(w, 'room-types'), O))).items[0].id;
    await code(call('POST', u(w, 'front-desk/walk-ins'), OM, { guest: { fullName: 'Walk In', phone: '03005550999', nationality: 'KP' }, roomTypeId: rt, nights: 1, adults: 1, occupants: occ('PASSPORT', 'KP') }, key()), 422, 'COMPLIANCE_BLOCKED');
  });
});
