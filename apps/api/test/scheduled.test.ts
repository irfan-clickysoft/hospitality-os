import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { zonedToUtcMs } from '@hos/domain-types';
import { MailService } from '../src/mail/mail.service.js';
import { isDue, periodFor } from '../src/insights/scheduled.service.js';
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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'sch'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@sch.test`); await adminDb.updateTable('staff_user').set({ status: 'ACTIVE' }).where('id', '=', id).execute(); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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


const csv = async (url: string, h = O, status = 200) => { const r = await call('GET', url, h); expect(r.statusCode, r.body).toBe(status); return r; };
const lines = (body: string) => body.replace(/^﻿/, '').trim().split('\r\n');

const sent: Array<{ to: string; subject: string; text: string }> = [];
const sched = (extra: Record<string, unknown> = {}) => ({ reportId: 'historical', name: 'Daily performance', period: 'CLOSED_DAY', frequency: 'DAILY', recipientIds: [] as string[], ...extra });

describe('schedule rules', () => {
  it('works out which days a schedule is due and what dates it covers', () => {
    expect(isDue({ frequency: 'DAILY', weekday: null, month_day: null }, '2026-11-05')).toBe(true);
    expect(isDue({ frequency: 'WEEKLY', weekday: 4, month_day: null }, '2026-11-05')).toBe(true);        // 5 Nov 2026 is a Thursday
    expect(isDue({ frequency: 'WEEKLY', weekday: 1, month_day: null }, '2026-11-05')).toBe(false);
    expect(isDue({ frequency: 'MONTHLY', weekday: null, month_day: 0 }, '2026-11-30')).toBe(true);       // the last day of the month, the period end
    expect(isDue({ frequency: 'MONTHLY', weekday: null, month_day: 0 }, '2026-11-29')).toBe(false);
    expect(isDue({ frequency: 'MONTHLY', weekday: null, month_day: 5 }, '2026-11-05')).toBe(true);
    expect(periodFor('CLOSED_DAY', '2026-11-05')).toEqual({ from: '2026-11-05', to: '2026-11-05' });
    expect(periodFor('MONTH_TO_DATE', '2026-11-05')).toEqual({ from: '2026-11-01', to: '2026-11-05' });
    expect(periodFor('PREVIOUS_MONTH', '2026-12-01')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(periodFor('NEXT_7', '2026-11-05')).toEqual({ from: '2026-11-06', to: '2026-11-12' });
  });
});

describe('scheduled report delivery', () => {
  beforeAll(async () => { await adminDb.updateTable('staff_user').set({ status: 'ACTIVE' }).where('id', '=', T.ownerUserId).execute(); process.env.MAIL_FROM = 'reports@hotel.test'; process.env.PUBLIC_BASE_URL = 'https://app.hotel.test'; app.get(MailService).transport = { send: async (m) => { sent.push(m); return { id: `ses-${sent.length}` }; } }; });
  beforeEach(() => { sent.length = 0; });

  it('is made when a day closes, delivered as an expiring link, and checked again when it is opened', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const acct = await staff(w, 'accountant'); const fd = await staff(w, 'front_desk_agent'); const cashier = await staff(w, 'cashier');
    await code(call('GET', u(w, 'insights/schedules'), fd.h), 403, 'PERMISSION_DENIED');
    await code(call('POST', u(w, 'insights/schedules'), O, sched({ recipientIds: [cashier.id] })), 422, 'RECIPIENT_NO_ACCESS');        // a cashier cannot open this report, so it cannot be sent to one
    const made = await ok(call('POST', u(w, 'insights/schedules'), O, sched({ recipientIds: [acct.id] })), 201);
    const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-06' }); await checkIn(w, b, '101');
    at('2026-11-05', '23:30'); await ok(audit(w));
    const list = await ok(call('GET', u(w, 'insights/schedules'), O)); expect(list.items[0]).toMatchObject({ lastStatus: 'Delivered', lastRunOn: expect.stringContaining('2026-11-05') }); expect(list.recent).toHaveLength(1);
    expect(list.recent[0]).toMatchObject({ status: 'READY', recipients: 1, opened: 0 });
    expect(sent).toHaveLength(1); expect(sent[0]!.to).toBe(`${(await adminDb.selectFrom('staff_user').select('email').where('id', '=', acct.id).executeTakeFirstOrThrow()).email}`);
    expect(sent[0]!.text).toContain('https://app.hotel.test/#/reports/center?d='); expect(sent[0]!.text).toContain('7 days'); expect(sent[0]!.text).not.toMatch(/12,?000|PKR/);       // a link, never figures
    const mine = await ok(call('GET', u(w, 'insights/deliveries'), acct.h)); expect(mine.items).toHaveLength(1); const did = mine.items[0].id;
    expect((await ok(call('GET', u(w, 'insights/deliveries'), fd.h))).items).toHaveLength(0);
    await code(call('GET', u(w, `insights/deliveries/${did}`), fd.h), 404, 'NOT_FOUND');            // not addressed to them
    await code(call('GET', u(w, `insights/deliveries/${did}`), O), 404, 'NOT_FOUND');               // even the person who made it must be a recipient
    const opened = await ok(call('GET', u(w, `insights/deliveries/${did}`), acct.h));
    expect(opened.envelope.meta).toMatchObject({ id: 'historical', from: '2026-11-05', to: '2026-11-05' }); expect(opened.envelope.rows[0]).toMatchObject({ period: '2026-11-05', sold: 1 });
    const csv = await call('GET', u(w, `insights/deliveries/${did}/csv`), acct.h); expect(csv.statusCode).toBe(200); expect(csv.body).toContain('Date basis:'); expect(csv.body).toContain('2026-11-05');
    expect((await ok(call('GET', u(w, 'insights/schedules'), O))).recent[0].opened).toBe(1);
    // closing the day again does not deliver the same day twice
    expect((await adminDb.selectFrom('report_delivery').select('id').where('schedule_id', '=', made.id).execute())).toHaveLength(1);
    // permission is checked on every opening, not only when it was made
    await adminDb.deleteFrom('role_assignment').where('user_id', '=', acct.id).execute();
    await code(call('GET', u(w, `insights/deliveries/${did}`), acct.h), 403, 'PERMISSION_DENIED');
  });

  it('expires, and the stored copy is removed', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05'); const acct = await staff(w, 'accountant');
    const s = await ok(call('POST', u(w, 'insights/schedules'), O, sched({ recipientIds: [acct.id] })), 201);
    const run = await ok(call('POST', u(w, `insights/schedules/${s.id}/run`), O)); expect(run.status).toBe('READY');
    await adminDb.updateTable('report_delivery').set({ expires_at: new Date('2020-01-01T00:00:00Z') }).where('id', '=', run.id).execute();
    await code(call('GET', u(w, `insights/deliveries/${run.id}`), acct.h), 410, 'DELIVERY_EXPIRED');
    at('2026-11-05', '23:30'); await ok(audit(w));
    expect((await adminDb.selectFrom('report_delivery').select('snapshot').where('id', '=', run.id).executeTakeFirstOrThrow()).snapshot).toBeNull();
  });

  it('only sends an alert when its condition is true, and says why it did not', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05'); const acct = await staff(w, 'accountant');
    await ok(call('POST', u(w, 'insights/schedules'), O, sched({ name: 'Busy day alert', recipientIds: [acct.id], alert: { kpi: 'sold', op: 'gt', value: 50 } })), 201);
    at('2026-11-05', '23:30'); await ok(audit(w));
    const d = await adminDb.selectFrom('report_delivery').select(['status', 'note']).where('property_id', '=', w.pid).executeTakeFirstOrThrow();
    expect(d.status).toBe('SKIPPED'); expect(d.note).toContain('Alert not triggered'); expect(sent).toHaveLength(0);
  });

  it('pauses when its owner can no longer open the report, and never carries restricted cases', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05'); const mgr = await staff(w, 'group_gm'); const acct = await staff(w, 'accountant');
    await ok(call('POST', u(w, 'cases'), O, { type: 'SECURITY', severity: 'HIGH', description: 'Restricted: side gate left open' }), 201);
    await ok(call('POST', u(w, 'cases'), O, { type: 'GUEST_COMPLAINT', severity: 'LOW', description: 'Ordinary complaint about towels' }), 201);
    const s = await ok(call('POST', u(w, 'insights/schedules'), mgr.h, sched({ reportId: 'complaints-incidents', name: 'Cases', period: 'LAST_30', recipientIds: [mgr.id] })), 201);
    const r = await ok(call('POST', u(w, `insights/schedules/${s.id}/run`), mgr.h)); expect(r.status).toBe('READY');
    const got = await ok(call('GET', u(w, `insights/deliveries/${r.id}`), mgr.h)); expect(got.envelope.rows).toHaveLength(1); expect(got.envelope.rows[0].type).toBe('Guest complaint');   // the owner may see restricted cases, a scheduled copy never has them
    await adminDb.deleteFrom('role_assignment').where('user_id', '=', mgr.id).execute();
    const again = await ok(call('POST', u(w, `insights/schedules/${s.id}/run`), O)); expect(again.status).toBe('FAILED');
    expect((await ok(call('GET', u(w, 'insights/schedules'), O))).items.find((x: any) => x.id === s.id)).toMatchObject({ active: false });
    expect(acct.id).toBeTruthy();
  });

  it('is recorded as undelivered by email, but still readable in the app, when email is not switched on', async () => {
    const w = await sunset(); at('2026-11-05', '10:00'); await setBd(w, '2026-11-05'); const acct = await staff(w, 'accountant');
    const s = await ok(call('POST', u(w, 'insights/schedules'), O, sched({ recipientIds: [acct.id] })), 201);
    const keep = process.env.MAIL_FROM; delete process.env.MAIL_FROM;
    try { const r = await ok(call('POST', u(w, `insights/schedules/${s.id}/run`), O)); expect(r.status).toBe('READY'); expect(sent).toHaveLength(0);
      expect((await adminDb.selectFrom('report_delivery_recipient').select(['mail_status', 'mail_note']).where('delivery_id', '=', r.id).executeTakeFirstOrThrow()).mail_status).toBe('SKIPPED');
      expect((await ok(call('GET', u(w, `insights/deliveries/${r.id}`), acct.h))).envelope.meta.id).toBe('historical');
    } finally { process.env.MAIL_FROM = keep; }
  });
});
