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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'mail'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@mail.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

async function book(w: W, o: { arrival?: string; departure?: string; hold?: number } = {}) {
  const q = (await call('POST', u(w, 'quotes'), O, { arrival: o.arrival ?? '2026-11-05', departure: o.departure ?? '2026-11-07', adults: 2, channel: 'PHONE' })).json();
  const g = await ok(call('POST', '/v1/guests', O, { fullName: `Guest ${++n}`, phone: `0300${String(6000000 + n).slice(-7)}`, nationality: 'PK' }), 201);
  const r = await ok(call('POST', u(w, 'reservations'), O, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }], ...(o.hold ? { hold: { minutes: o.hold } } : {}) }, key()), 201);
  return { id: r.id as string, line: r.lines[0].id as string };
}

import { MailService } from '../src/mail/mail.service.js';
const sent: Array<Record<string, any>> = [];
let mail: MailService;
beforeAll(() => {
  mail = app.get(MailService);
  process.env.MAIL_FROM = 'accounts@hotel.test'; process.env.MAIL_REPLY_TO = 'frontdesk@hotel.test';
  mail.transport = { send: async (m) => { if (m.to.startsWith('bounce')) throw new Error('Mailbox does not exist'); sent.push(m); return { id: `ses-${sent.length}` }; } };
});

describe('email sending', () => {
  it('sends the guest message and the company statement by email, records each, refuses bad addresses, strangers and when switched off', async () => {
    const w = await sunset(); const b = await book(w);
    const st = await ok(call('GET', u(w, 'email/status'), O)); expect(st).toEqual({ configured: true, from: 'accounts@hotel.test' });
    const c = await ok(call('POST', u(w, 'messages/compose'), O, { event: 'RESERVATION_CONFIRMED', channel: 'EMAIL', reservationId: b.id }));
    expect(c.subject).toContain('confirmed'); expect(c).toHaveProperty('email');
    const r = await ok(call('POST', u(w, 'email/guest'), O, { reservationId: b.id, to: 'Guest@Example.COM', subject: c.subject, text: c.text }));
    expect(r.status).toBe('SENT');
    expect(sent[0]).toMatchObject({ from: 'accounts@hotel.test', to: 'guest@example.com', replyTo: 'frontdesk@hotel.test' }); expect(sent[0]!.fromName).toContain('Audit');
    const co = await ok(call('POST', '/v1/companies', OM, { name: `Mail Co ${++n} Ltd`, creditLimit: '100000', termsDays: 30, contactName: 'Mr. Aslam', contactEmail: 'ap@mailco.test' }), 201);
    const cm = await ok(call('POST', u(w, `companies/${co.id}/message?channel=EMAIL`), O, {}));
    expect(cm.subject).toContain(co.name); expect(cm.email).toBe('ap@mailco.test'); expect(cm.text).toContain('/v1/guest/doc/');
    await ok(call('POST', u(w, `email/company/${co.id}`), O, { to: cm.email, subject: cm.subject, text: cm.text }));
    const log = await ok(call('GET', u(w, 'email/recent'), O)); expect(log.items.map((x: any) => x.status)).toEqual(['SENT', 'SENT']); expect(log.items[1].purpose).toBe('GUEST');
    await code(call('POST', u(w, 'email/guest'), O, { reservationId: b.id, to: 'not-an-address', subject: 'Hi', text: 'Hello there guest' }), 400, 'VALIDATION_FAILED');
    await code(call('POST', u(w, 'email/guest'), O, { reservationId: b.id, to: 'a@b.test', subject: 'Hi\nBcc: x@y.test', text: 'Hello there guest' }), 400, 'VALIDATION_FAILED');
    await code(call('POST', u(w, 'email/guest'), O, { reservationId: '00000000-0000-4000-8000-000000000000', to: 'a@b.test', subject: 'Hi', text: 'Hello there guest' }), 404, 'NOT_FOUND');
    const hk = await staff(w, 'housekeeper');
    expect((await call('POST', u(w, 'email/guest'), hk.h, { reservationId: b.id, to: 'a@b.test', subject: 'Hi', text: 'Hello there guest' })).statusCode).toBe(403);
    await code(call('POST', u(w, 'email/guest'), O, { reservationId: b.id, to: 'bounce@x.test', subject: 'Hi', text: 'Hello there guest' }), 502, 'EMAIL_FAILED');
    expect((await ok(call('GET', u(w, 'email/recent'), O))).items[0]).toMatchObject({ status: 'FAILED', error: 'Mailbox does not exist' });
    delete process.env.MAIL_FROM;
    await code(call('POST', u(w, 'email/guest'), O, { reservationId: b.id, to: 'a@b.test', subject: 'Hi', text: 'Hello there guest' }), 503, 'EMAIL_NOT_CONFIGURED');
    expect((await ok(call('GET', u(w, 'email/status'), O))).configured).toBe(false);
  });
});
