import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { zonedToUtcMs } from '@hos/domain-types';
import { TAX_MATRIX } from '../src/cli/sunset-data.js';
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

beforeAll(async () => { app = await createTestApp(); T = await provision(app, 'matrix'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true }); });
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
const staff = async (w: W, role: string) => { const id = await addUser(T.tenantId, `${role}${++n}@matrix.test`); await assignRole(T.tenantId, id, role, 'PROPERTY', w.pid); return { id, h: as(T.tenantId, id), hm: as(T.tenantId, id, { mfa: true }) }; };

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


let ACCM: Record<string, string>;
const fid = async (w: W, b: { id: string }) => (await folioOf(w, b)).folio.id as string;
const charge = (w: W, f: string, txnCode: string, amount: string) => ok(call('POST', u(w, `folios/${f}/charges`), O, { txnCode, amount, description: `Test ${txnCode}` }), 201);
const taxOf = async (w: W, b: { id: string }, postingId: string) => (await adminDb.selectFrom('folio_posting').select(['tax_code', 'amount_minor']).where('parent_posting_id', '=', postingId).where('posting_type', '=', 'TAX').execute()).map((x) => [x.tax_code, Number(x.amount_minor) / 100]);

/** The owner's matrix, entered through the real maker–checker path (the accountant enters, the owner approves with the advisor's reference). */
const entered = new Set<string>();                                                                           // the codes belong to the business; a second property of the same area reuses them
async function applyMatrix(w: W, area: 'FBR-ICT' | 'SRB') {
  const def = TAX_MATRIX.find((x) => x.jurisdiction === area)!;
  for (const c of entered.has(area) ? [] : def.codes) {
    const made = await ok(call('POST', '/v1/tax/codes', ACCM, { code: c.code, name: c.name, jurisdiction: area, version: { rateBp: c.rateBp, appliesTo: c.appliesTo, effectiveFrom: '2026-01-01' } }), 201);
    await ok(call('POST', `/v1/tax/versions/${made.version.id}/approve`, OM, { advisorRef: 'TEST-MATRIX', legalBasis: 'Test fixture, not law' }));
  }
  entered.add(area);
  await adminDb.updateTable('property').set({ tax_jurisdiction: area }).where('id', '=', w.pid).execute();
  for (const r of def.reviews) await adminDb.insertInto('charge_review_rule').values({ tenant_id: T.tenantId, jurisdiction: area, txn_code: r.txnCode, kind: r.kind, message: r.message } as never).onConflict((oc) => oc.columns(['tenant_id', 'jurisdiction', 'txn_code', 'kind']).doNothing()).execute();
}

beforeAll(async () => {
  const acc = await addUser(T.tenantId, 'accountant@matrix.test'); await assignRole(T.tenantId, acc, 'accountant', 'TENANT', null); ACCM = as(T.tenantId, acc, { mfa: true });
});

describe('the owner’s tax matrix', () => {
  it('Karachi (SRB): rooms, cash food and the conference room at 15%; digital food and transport at 8%; laundry exempt; codes not in the matrix untaxed', async () => {
    const w = await sunset(); await applyMatrix(w, 'SRB');
    at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-07' }); await checkIn(w, b, '101'); const f = await fid(w, b);
    const t = async (code: string) => { const c = await charge(w, f, code, '1000'); return taxOf(w, b, c.postingId); };
    expect(await t('FNB')).toEqual([['SRB-ST15', 150]]);
    expect(await t('FNB_DIGITAL')).toEqual([['SRB-ST8D', 80]]);
    expect(await t('TRANSPORT_OWNED')).toEqual([['SRB-ST8D', 80]]);
    expect(await t('TRANSPORT_THIRDPARTY')).toEqual([['SRB-ST8D', 80]]);
    expect(await t('LAUNDRY')).toEqual([]);                                                                  // exempt in-house
    expect(await t('MINIBAR')).toEqual([]);                                                                  // not in the matrix: untaxed until the owner says otherwise
    // conference room hire and the room nights
    const s = await ok(call('POST', u(w, 'spaces'), O, { name: 'Conference room', hourly: '5000' }), 201);
    const h = await ok(call('POST', u(w, 'spaces/bookings'), O, { spaceId: s.id, eventName: 'Board', hostName: 'Mr Khan', date: '2026-11-05', startTime: '14:00', endTime: '16:00', pricing: 'HOURLY', billTo: 'SEPARATE' }), 201);
    at('2026-11-05', '17:00'); const done = await ok(call('POST', u(w, `spaces/bookings/${h.id}/complete`), O, {}));
    expect(done.bill.balance.amount).toBe('11500.00');                                                       // 10,000 + 15%
    at('2026-11-07', '10:00'); await setBd(w, '2026-11-07'); await checkOut(w, b);
    const nights = (await folioOf(w, b)).postings.filter((p: any) => p.type === 'TAX' && String(p.description).startsWith('SRB-ST15') && p.amount.amount === '1800.00');
    expect(nights).toHaveLength(2);                                                                          // 15% of 12,000 on each night
  });

  it('Islamabad (FBR): rooms, cash food, conference room, transport and laundry at 15%; food paid digitally at 5%; third-party transport opens a withholding-tax review', async () => {
    const w = await sunset(); await applyMatrix(w, 'FBR-ICT');
    at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-06' }); await checkIn(w, b, '101'); const f = await fid(w, b);
    const t = async (code: string) => { const c = await charge(w, f, code, '2000'); return taxOf(w, b, c.postingId); };
    expect(await t('FNB')).toEqual([['ICT-ST15', 300]]);
    expect(await t('FNB_DIGITAL')).toEqual([['ICT-ST5D', 100]]);
    expect(await t('TRANSPORT_OWNED')).toEqual([['ICT-ST15', 300]]);
    expect(await t('LAUNDRY')).toEqual([['ICT-ST15', 300]]);
    const third = await charge(w, f, 'TRANSPORT_THIRDPARTY', '2000');
    expect(await taxOf(w, b, third.postingId)).toEqual([['ICT-ST15', 300]]);
    const reviews = await ok(call('GET', u(w, 'charge-reviews'), O));
    expect(reviews.items).toHaveLength(1);                                                                   // only the third-party transport, not the owned one
    expect(reviews.items[0]).toMatchObject({ kind: 'WHT_REVIEW', txnCode: 'TRANSPORT_THIRDPARTY', amount: { amount: '2000.00' }, status: 'OPEN' });
    // closing it needs the right to act on compliance tasks, a note, and can be done once
    const clerk = await staff(w, 'cashier'); const desk = await staff(w, 'front_desk_agent');
    await code(call('POST', u(w, `charge-reviews/${reviews.items[0].id}/resolve`), clerk.h, { note: 'Checked' }), 403, 'PERMISSION_DENIED');
    await code(call('POST', u(w, `charge-reviews/${reviews.items[0].id}/resolve`), desk.h, { note: 'x' }), 400, 'VALIDATION_FAILED');
    expect(await ok(call('POST', u(w, `charge-reviews/${reviews.items[0].id}/resolve`), desk.h, { note: 'Vendor has NTN; 4.5% withheld' }))).toMatchObject({ status: 'DONE' });
    await code(call('POST', u(w, `charge-reviews/${reviews.items[0].id}/resolve`), desk.h, { note: 'again please' }), 409, 'ALREADY_DONE');
    expect((await ok(call('GET', u(w, 'charge-reviews'), O))).items).toHaveLength(0);
    expect((await ok(call('GET', u(w, 'charge-reviews?status=DONE'), O))).items[0]).toMatchObject({ note: 'Vendor has NTN; 4.5% withheld' });
  });

  it('a kitchen order marked to be paid digitally is charged (and taxed) as digital food; otherwise as cash food', async () => {
    const w = await sunset(); await applyMatrix(w, 'SRB');
    at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const b = await book(w, { arrival: '2026-11-05', departure: '2026-11-07' }); await checkIn(w, b, '101');
    const stay = (await ok(call('GET', u(w, 'fnb/in-house'), O))).items.find((x: any) => x.room === '101');
    const dish = await ok(call('POST', u(w, 'fnb/menu'), O, { category: 'Mains', name: 'Karahi', price: '1000' }), 201);
    for (const digital of [false, true]) {
      const o = await ok(call('POST', u(w, 'fnb/orders'), O, { reservationRoomId: stay.reservationRoomId, payDigitally: digital, lines: [{ menuItemId: dish.id }] }), 201);
      expect(o.payDigitally).toBe(digital);
      await ok(call('POST', u(w, `fnb/orders/${o.id}/deliver`), O, {}));
    }
    const lines = (await folioOf(w, b)).postings.filter((p: any) => p.type === 'TAX').map((p: any) => [p.description, p.amount.amount]);
    expect(lines).toEqual([['SRB-ST15 15%', '150.00'], ['SRB-ST8D 8%', '80.00']]);
  });

  it('cancellation and no-show fees carry the regular 15%; a booking cancelled free of charge has no fee and no tax, so everything paid comes back', async () => {
    const w = await sunset(); await applyMatrix(w, 'SRB');
    at('2026-11-05', '10:00'); await setBd(w, '2026-11-05');
    const deposit = (b: { id: string }) => ok(call('POST', u(w, `reservations/${b.id}/payments`), O, { method: 'CARD_SLIP', amount: '12000', kind: 'DEPOSIT', cardLast4: '4242', reference: `RRN${++n}`, approvalCode: `A${n}` }, key()), 201);
    const late = await book(w, { arrival: '2026-11-06', departure: '2026-11-07' }); await deposit(late);                  // inside the 72 hours
    await ok(call('POST', u(w, `reservations/${late.id}/cancel`), O, { reason: 'Late change of plan' }));
    const f1 = await folioOf(w, late);
    expect(f1.postings.map((p: any) => [p.txnCode, p.amount.amount])).toEqual([['DEPOSIT', '-12000.00'], ['CANCEL_FEE', '12000.00'], ['TAX', '1800.00']]);
    expect(f1.folio.balance.amount).toBe('1800.00');                                                                       // the 15% on the fee is still owed after the deposit is applied
    const early = await book(w, { arrival: '2026-11-20', departure: '2026-11-21' }); await deposit(early);                 // well outside the 72 hours
    await ok(call('POST', u(w, `reservations/${early.id}/cancel`), O, { reason: 'Plans changed' }));
    const f2 = await folioOf(w, early);
    expect(f2.postings.map((p: any) => p.txnCode)).toEqual(['DEPOSIT']);                                                   // no fee, no tax
    expect(f2.folio.balance.amount).toBe('-12000.00');                                                                     // the whole deposit is due back to the guest
    // a no-show is charged the same way
    const ns = await book(w, { arrival: '2026-11-05', departure: '2026-11-06' });
    await setBd(w, '2026-11-06'); at('2026-11-06', '03:00');
    await ok(call('POST', u(w, `reservations/${ns.id}/no-show`), O, { reason: 'Did not arrive' }));
    expect((await folioOf(w, ns)).postings.map((p: any) => [p.txnCode, p.amount.amount])).toEqual([['NOSHOW_FEE', '12000.00'], ['TAX', '1800.00']]);
  });
});
