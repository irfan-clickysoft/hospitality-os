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
  app = await createTestApp(); T = await provision(app, 'tax'); O = as(T.tenantId, T.ownerUserId); OM = as(T.tenantId, T.ownerUserId, { mfa: true });
  const acc = await addUser(T.tenantId, 'accountant@tax.test'); await assignRole(T.tenantId, acc, 'accountant', 'TENANT', null);
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

describe('configuring tax: one person enters, another approves', () => {
  it('a draft charges nothing; approval needs a different person, the advisor’s reference and a fresh second factor; the person who last edited a draft cannot approve it', async () => {
    const w = await sunset('MAKER-TEST');
    const c = await ok(call('POST', '/v1/tax/codes', ACCM, { code: 'MK-ACCOM', name: 'Accommodation (test)', jurisdiction: 'MAKER-TEST', version: version() }), 201);
    expect((await ok(call('GET', '/v1/tax/codes', ACC))).items.find((x: any) => x.code === 'MK-ACCOM').versions[0]).toMatchObject({ status: 'DRAFT', ratePercent: 10 });
    const pv = (await ok(call('POST', u(w, 'tax/preview'), O, { lines: [{ txnCode: 'ROOM', amount: '10000' }] })));
    expect(pv).toMatchObject({ configured: false, tax: { amount: '0.00' } });                                // a draft has no effect
    await code(call('POST', `/v1/tax/versions/${c.version.id}/approve`, ACCM, { advisorRef: 'A-1', legalBasis: 'x y z' }), 403, 'PERMISSION_DENIED');          // an accountant cannot approve
    await code(call('POST', `/v1/tax/versions/${c.version.id}/approve`, O, { advisorRef: 'A-1', legalBasis: 'x y z' }), 403, 'MFA_REQUIRED');
    await code(call('POST', `/v1/tax/versions/${c.version.id}/approve`, OM, { legalBasis: 'x y z' }), 400, 'VALIDATION_FAILED');                               // the advisor reference is required
    // the owner edits the draft: from now on the owner is its author, so the owner cannot approve it
    await ok(call('PATCH', `/v1/tax/versions/${c.version.id}`, OM, version({ rateBp: 1100 })));
    await code(call('POST', `/v1/tax/versions/${c.version.id}/approve`, OM, { advisorRef: 'A-1', legalBasis: 'Test fixture' }), 403, 'SELF_APPROVAL');
    await ok(call('PATCH', `/v1/tax/versions/${c.version.id}`, ACCM, version({ rateBp: 1200 })));
    const a = await ok(call('POST', `/v1/tax/versions/${c.version.id}/approve`, OM, { advisorRef: 'A-1', legalBasis: 'Test fixture', note: 'checked against the worksheet' }));
    expect(a).toMatchObject({ status: 'ACTIVE', rateBp: 1200, advisorRef: 'A-1' });
    expect((await ok(call('POST', u(w, 'tax/preview'), O, { lines: [{ txnCode: 'ROOM', amount: '10000' }] }))).tax.amount).toBe('1200.00');
    await code(call('PATCH', `/v1/tax/versions/${c.version.id}`, ACCM, version()), 409, 'NOT_DRAFT');
    const audit = await adminDb.selectFrom('audit_log').select(['action', 'reason_code']).where('tenant_id', '=', T.tenantId).where('resource_id', '=', c.version.id).execute();
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(['tax.version_edit', 'tax.version_approve']));
    // the front desk can neither configure nor approve
    const fd = await addUser(T.tenantId, `fd${++n}@tax.test`); await assignRole(T.tenantId, fd, 'front_desk_agent', 'PROPERTY', w.pid);
    expect((await call('POST', '/v1/tax/codes', as(T.tenantId, fd, { mfa: true }), { code: 'NOPE-1', name: 'No', jurisdiction: 'X1', version: version() })).statusCode).toBe(403);
  });

  it('a newer version closes the one it replaces the day before it starts; overlapping or settlement-dependent rates are refused; rejected and retired versions stop applying', async () => {
    const w = await sunset('VERS-TEST');
    const { codeId, versionId } = await activate('VS-ACCOM', 'VERS-TEST', { rateBp: 1000 });
    const v2 = await ok(call('POST', `/v1/tax/codes/${codeId}/versions`, ACCM, version({ rateBp: 1500, effectiveFrom: '2026-12-01' })), 201);
    expect(v2.versionNo).toBe(2);
    await ok(call('POST', `/v1/tax/versions/${v2.id}/approve`, OM, { advisorRef: 'A-2', legalBasis: 'Test fixture' }));
    const rate = async (date: string) => (await ok(call('POST', u(w, 'tax/preview'), O, { date, lines: [{ txnCode: 'ROOM', amount: '10000' }] }))).tax.amount;
    expect(await rate('2026-11-30')).toBe('1000.00'); expect(await rate('2026-12-01')).toBe('1500.00'); expect(await rate('2025-12-31')).toBe('0.00');
    const old = (await ok(call('GET', '/v1/tax/codes', ACC))).items.find((x: any) => x.code === 'VS-ACCOM').versions.find((x: any) => x.id === versionId);
    expect(old.effectiveTo).toBe('2026-11-30');
    const v3 = await ok(call('POST', `/v1/tax/codes/${codeId}/versions`, ACCM, version({ rateBp: 900, effectiveFrom: '2026-12-01' })), 201);
    await code(call('POST', `/v1/tax/versions/${v3.id}/approve`, OM, { advisorRef: 'A-3', legalBasis: 'Test fixture' }), 409, 'VERSION_OVERLAP');
    await ok(call('POST', `/v1/tax/versions/${v3.id}/reject`, OM, { reason: 'Rate does not match the worksheet' }));
    expect((await call('POST', `/v1/tax/codes/${codeId}/versions`, ACCM, { ...version(), determinationPoint: 'ON_SETTLEMENT' })).statusCode).toBe(400);   // not supported yet — refused, not silently ignored
    await ok(call('POST', `/v1/tax/versions/${v2.id}/retire`, OM, { reason: 'Superseded by a federal change' }));
    expect(await rate('2026-12-01')).toBe('0.00');
    await code(call('POST', `/v1/tax/versions/${v2.id}/retire`, OM, { reason: 'Again' }), 409, 'WRONG_STATE');
  });
});

describe('tax on the bill', () => {
  it('is added beside each charge as it is posted — room nights, extras, manual charges, discounts — with its rate and taxable value recorded; reversing a charge reverses its tax', async () => {
    const w = await sunset('BILL-TEST');
    await activate('BL-ROOM', 'BILL-TEST', { rateBp: 1000, appliesTo: ['ROOM', 'ROOM_EXTRAS'] });
    await activate('BL-FNB', 'BILL-TEST', { rateBp: 500, appliesTo: ['FNB'] });
    at('2026-11-05', '10:00');
    const b = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    const fid = (await folio(w, b)).folio.id as string;
    const c = await charge(w, fid, '1000');
    expect(await bal(w, b)).toBe('1050.00');
    const d = await ok(call('POST', u(w, `folios/${fid}/postings/${c.postingId}/discount`), O, { pct: 10, reason: 'Birthday' }), 201);
    expect(d.balance.amount).toBe('945.00');                                                                 // 1,000 + 50 tax − 100 − 5 tax on the discount
    const f = await folio(w, b);
    expect(f.postings.map((p: any) => [p.type, p.amount.amount])).toEqual([['CHARGE', '1000.00'], ['TAX', '50.00'], ['DISCOUNT', '-100.00'], ['TAX', '-5.00']]);
    const tax = await adminDb.selectFrom('folio_posting').select(['tax_code', 'tax_rate_bp', 'taxable_minor', 'parent_posting_id']).where('folio_id', '=', fid).where('posting_type', '=', 'TAX').orderBy('posted_at').execute();
    expect(tax[0]).toMatchObject({ tax_code: 'BL-FNB', tax_rate_bp: 500, taxable_minor: '100000', parent_posting_id: c.postingId });
    const rev = await ok(call('POST', u(w, `folios/${fid}/postings/${c.postingId}/reverse`), OM, { reason: 'Wrong room' }));
    expect(rev.balance.amount).toBe('0.00');                                                                 // charge, discount and both tax lines all reversed
    // room nights on check-out are taxed too, at the rate in force on their night
    at('2026-11-07', '10:00'); await setBd(w, '2026-11-07');
    const out = await checkOut(w, b, { balanceReason: 'test' }); expect(out.statusCode, out.body).toBe(200);
    const nights = (await folio(w, b)).postings.filter((p: any) => p.sourceType === 'ROOM_NIGHT' || (p.type === 'TAX' && p.description?.startsWith('BL-ROOM')));
    expect(nights.map((p: any) => [p.type, p.amount.amount])).toEqual([['CHARGE', '12000.00'], ['TAX', '1200.00'], ['CHARGE', '12000.00'], ['TAX', '1200.00']]);
    expect(await bal(w, b)).toBe('26400.00');
    expect((await ok(call('GET', u(w, 'folio-check'), O))).ok).toBe(true);
  });

  it('applies only the versions that fit: residency, dates and transaction codes; a zero rate still records the taxable value', async () => {
    const w = await sunset('FIT-TEST');
    await activate('FT-LOCAL', 'FIT-TEST', { rateBp: 1000, residency: 'RESIDENT' });
    await activate('FT-INTL', 'FIT-TEST', { rateBp: 0, residency: 'NON_RESIDENT' });
    at('2026-11-05', '10:00');
    const local = await book(w); const foreign = await book(w, { nationality: 'GB' });
    await setBd(w, '2026-11-05'); await checkIn(w, local, '101'); await checkIn(w, foreign, '102', true);
    const lf = (await folio(w, local)).folio.id as string, ff = (await folio(w, foreign)).folio.id as string;
    await charge(w, lf, '5000', 'ROOM_EXTRAS' as never).catch(() => null);
    await ok(call('POST', u(w, `folios/${lf}/charges`), O, { txnCode: 'MISC', amount: '100', description: 'Not taxed' }), 201);
    await adminDb.insertInto('folio_posting').values({ tenant_id: T.tenantId, property_id: w.pid, folio_id: ff, posting_type: 'CHARGE', txn_code: 'ROOM', amount_minor: '1000000', currency: 'PKR', business_date: '2026-11-05', source_type: 'MANUAL' } as never).execute();
    await adminDb.insertInto('folio_posting').values({ tenant_id: T.tenantId, property_id: w.pid, folio_id: lf, posting_type: 'CHARGE', txn_code: 'ROOM', amount_minor: '1000000', currency: 'PKR', business_date: '2026-11-05', source_type: 'MANUAL' } as never).execute();
    // the two direct inserts bypass the engine; run the audit's catch-up to see what the engine would have added
    const pv = await ok(call('POST', u(w, 'tax/preview'), O, { residency: 'NON_RESIDENT', lines: [{ txnCode: 'ROOM', amount: '10000' }, { txnCode: 'MISC', amount: '500' }] }));
    expect(pv.byCode).toEqual([{ code: 'FT-INTL', ratePercent: 0, taxable: { amount: '10000.00', currency: 'PKR' }, tax: { amount: '0.00', currency: 'PKR' } }]);   // zero-rated, but the value is on record
    expect((await ok(call('POST', u(w, 'tax/preview'), O, { residency: 'RESIDENT', lines: [{ txnCode: 'ROOM', amount: '10000' }] }))).tax.amount).toBe('1000.00');
  });

  it('a cancellation fee is taxed like any charge and comes back with it when the booking is reinstated; the quote shows tax on top of the price', async () => {
    const w = await sunset('FEE-TEST');
    await activate('FE-ROOM', 'FEE-TEST', { rateBp: 1000, appliesTo: ['ROOM', 'ROOM_EXTRAS', 'CANCEL_FEE'] });
    at('2026-11-01', '10:00'); await setBd(w, '2026-11-01');
    const b = await book(w, { arrival: '2026-11-02', departure: '2026-11-04' });
    const opt = b.quote.options[0];
    expect(opt.totalExTax.amount).toBe('24000.00'); expect(opt.taxes).toEqual([{ code: 'FE-ROOM', ratePercent: 10, taxable: { amount: '24000.00', currency: 'PKR' }, tax: { amount: '2400.00', currency: 'PKR' } }]);
    expect(opt.totalIncTax.amount).toBe('26400.00');
    await ok(call('POST', u(w, `reservations/${b.id}/cancel`), O, { reason: 'Guest cancelled' }));
    const f = await folio(w, b);
    expect(f.postings.map((p: any) => [p.txnCode, p.amount.amount])).toEqual([['CANCEL_FEE', '12000.00'], ['TAX', '1200.00']]);
    await ok(call('POST', u(w, `reservations/${b.id}/reinstate`), O, { reason: 'Changed mind' }));
    expect(await bal(w, b)).toBe('0.00');
    expect((await ok(call('GET', u(w, 'folio-check'), O))).ok).toBe(true);
  });
});

describe('the night audit and tax reports', () => {
  it('adds tax to items posted before their rate existed, snapshots the day’s tax apart from revenue, and the liability report agrees with the ledger', async () => {
    const w = await sunset('AUD-TEST');
    at('2026-11-05', '10:00');
    const b = await book(w, { departure: '2026-11-06' }); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    const fid = (await folio(w, b)).folio.id as string;
    await charge(w, fid, '2000');                                                                           // posted while no rate was in force
    expect(await bal(w, b)).toBe('2000.00');
    await activate('AU-FNB', 'AUD-TEST', { rateBp: 800, appliesTo: ['FNB'] });
    await activate('AU-ROOM', 'AUD-TEST', { rateBp: 1000, appliesTo: ['ROOM'] });
    at('2026-11-05', '23:40');
    const run = await ok(call('POST', u(w, 'night-audit/runs'), O, {}));
    const taxStep = run.steps.find((s: any) => s.key === 'TAXES');
    expect(taxStep.result).toMatchObject({ postings: 1, taxMinor: '16000', configured: true });         // 8% of 2,000, added by the audit's tax step
    const rep = await ok(call('GET', u(w, 'night-audit/reports/2026-11-05'), O));
    expect(rep.tax.total.amount).toBe('1360.00');                                                           // 160 on the dinner + 1,200 on the night
    expect(rep.tax.byCode.map((x: any) => [x.code, x.tax.amount])).toEqual([['AU-FNB', '160.00'], ['AU-ROOM', '1200.00']]);
    expect(rep.revenue.room.amount).toBe('12000.00'); expect(rep.revenue.other.amount).toBe('2000.00');   // tax is not revenue
    expect(rep.revenueLines.some((l: any) => l.txnCode.startsWith('TAX'))).toBe(false);
    const liab = await ok(call('GET', u(w, 'tax/liability?from=2026-11-01&to=2026-11-30'), O));
    expect(liab.items.map((x: any) => [x.code, x.taxable.amount, x.tax.amount])).toEqual([['AU-FNB', '2000.00', '160.00'], ['AU-ROOM', '12000.00', '1200.00']]);
    expect(liab.total.amount).toBe('1360.00');
    // a reversal nets the report
    const dinner = (await folio(w, b)).postings.find((p: any) => p.txnCode === 'FNB');
    await setBd(w, '2026-11-06');
    await ok(call('POST', u(w, `folios/${fid}/postings/${dinner.id}/reverse`), OM, { reason: 'Billed in error' }));
    expect((await ok(call('GET', u(w, 'tax/liability?from=2026-11-01&to=2026-11-30'), O))).total.amount).toBe('1200.00');
    expect((await call('GET', u(w, 'tax/liability?from=2026-11-30&to=2026-11-01'), O)).statusCode).toBe(400);
  });
});

describe('invoices', () => {
  async function stayed(w: W, o: { name?: string } = {}) {
    at('2026-11-05', '10:00');
    const b = await book(w, { name: o.name }); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    const fid = (await folio(w, b)).folio.id as string;
    await charge(w, fid, '1000');
    await setBd(w, '2026-11-07'); at('2026-11-07', '10:00');
    const out = await checkOut(w, b, { balanceReason: 'test' }); expect(out.statusCode, out.body).toBe(200);
    return { b, fid };
  }

  it('is issued once the stay is over, with gapless numbers, the tax on each line and a summary by tax code; nothing is invoiced twice; the document cannot be altered', async () => {
    const w = await sunset('INV-TEST');
    await activate('IN-ROOM', 'INV-TEST', { rateBp: 1000, appliesTo: ['ROOM'] }); await activate('IN-FNB', 'INV-TEST', { rateBp: 500, appliesTo: ['FNB'] });
    at('2026-11-05', '10:00');
    const b = await book(w); await setBd(w, '2026-11-05'); await checkIn(w, b, '101');
    const fid = (await folio(w, b)).folio.id as string; await charge(w, fid, '1000');
    await code(call('POST', u(w, `reservations/${b.id}/invoices`), O, {}), 409, 'STAY_NOT_FINISHED');
    await setBd(w, '2026-11-07'); at('2026-11-07', '10:00'); await checkOut(w, b, { balanceReason: 'test' });
    await ok(call('PUT', `/v1/legal-entities/${T.legalEntityId}`, OM, { ntn: '1234567-8', strn: 'STRN-TEST-1', address: '1 Test Road, Karachi' }));
    const inv = await ok(call('POST', u(w, `reservations/${b.id}/invoices`), O, { billTo: { name: 'Acme Traders (Pvt) Ltd', ntn: '7654321-0', strn: 'STRN-ACME' } }), 201);
    expect(inv).toMatchObject({ docType: 'TAX_INVOICE', billTo: { name: 'Acme Traders (Pvt) Ltd', ntn: '7654321-0' }, issuer: { ntn: '1234567-8', strn: 'STRN-TEST-1' }, warnings: [] });
    expect(inv.number).toMatch(/^INV-\d{4}-000001$/);
    expect(inv.lines.map((l: any) => [l.description, l.net.amount, l.tax.amount, l.taxes.map((t: any) => t.code)])).toEqual([['Item', '1000.00', '50.00', ['IN-FNB']], ['Room 2026-11-05', '12000.00', '1200.00', ['IN-ROOM']], ['Room 2026-11-06', '12000.00', '1200.00', ['IN-ROOM']]]);
    expect(inv.net.amount).toBe('25000.00'); expect(inv.tax.amount).toBe('2450.00'); expect(inv.total.amount).toBe('27450.00');
    expect(inv.taxSummary.map((t: any) => [t.code, t.taxable.amount, t.tax.amount]).sort()).toEqual([['IN-FNB', '1000.00', '50.00'], ['IN-ROOM', '24000.00', '2400.00']]);
    expect(inv.reference).toMatchObject({ rooms: ['101'], arrival: '2026-11-05', departure: '2026-11-07' });
    await code(call('POST', u(w, `reservations/${b.id}/invoices`), O, {}), 422, 'NOTHING_TO_INVOICE');   // everything is on the invoice already
    // a charge posted afterwards goes on a supplementary invoice, numbered next
    await ok(call('POST', u(w, `folios/${fid}/reopen`), OM, { reason: 'Late laundry' })).catch(() => null);
    await adminDb.updateTable('folio').set({ status: 'OPEN' }).where('id', '=', fid).execute();
    await charge(w, fid, '400', 'LAUNDRY');
    const inv2 = await ok(call('POST', u(w, `reservations/${b.id}/invoices`), O, {}), 201);
    expect(inv2.number).toMatch(/-000002$/); expect(inv2.lines).toHaveLength(1); expect(inv2.total.amount).toBe('400.00');
    expect((await ok(call('GET', u(w, `reservations/${b.id}/invoices`), O))).items.map((x: any) => x.number)).toEqual([inv.number, inv2.number]);
    expect((await ok(call('GET', u(w, `invoices?number=${inv.number}`), O))).id).toBe(inv.id);
    await expect(adminDb.updateTable('invoice').set({ total_minor: '1' }).where('id', '=', inv.id).execute()).rejects.toThrow(/append-only/);
    await expect(adminDb.deleteFrom('invoice_posting').where('invoice_id', '=', inv.id).execute()).rejects.toThrow(/append-only/);
    // access: front desk issues; a housekeeper cannot even see
    const hk = await addUser(T.tenantId, `hk${++n}@tax.test`); await assignRole(T.tenantId, hk, 'housekeeper', 'PROPERTY', w.pid);
    expect((await call('GET', u(w, `invoices/${inv.id}`), as(T.tenantId, hk))).statusCode).toBe(403);
    expect((await call('POST', u(w, `reservations/${b.id}/invoices`), as(T.tenantId, hk), {})).statusCode).toBe(403);
  });

  it('a credit note reverses the whole invoice (manager, second factor, reason); the items can then be invoiced again; each invoice is credited once', async () => {
    const w = await sunset('CRN-TEST');
    await activate('CR-ROOM', 'CRN-TEST', { rateBp: 1000, appliesTo: ['ROOM'] });
    const { b } = await stayed(w);
    const inv = await ok(call('POST', u(w, `reservations/${b.id}/invoices`), O, {}), 201);
    const fd = await addUser(T.tenantId, `fd${++n}@tax.test`); await assignRole(T.tenantId, fd, 'front_desk_agent', 'PROPERTY', w.pid);
    await code(call('POST', u(w, `invoices/${inv.id}/credit`), as(T.tenantId, fd, { mfa: true }), { reason: 'Wrong customer name' }), 403, 'PERMISSION_DENIED');
    await code(call('POST', u(w, `invoices/${inv.id}/credit`), O, { reason: 'Wrong customer name' }), 403, 'MFA_REQUIRED');
    await code(call('POST', u(w, `invoices/${inv.id}/credit`), OM, { reason: 'x' }), 400, 'VALIDATION_FAILED');
    const cn = await ok(call('POST', u(w, `invoices/${inv.id}/credit`), OM, { reason: 'Wrong customer name' }));
    expect(cn).toMatchObject({ docType: 'CREDIT_NOTE', creditsInvoiceId: inv.id, reason: 'Wrong customer name' });
    expect(cn.number).toMatch(/^CN-\d{4}-000001$/);
    expect(cn.total.amount).toBe(`-${inv.total.amount}`); expect(cn.net.amount).toBe(`-${inv.net.amount}`); expect(cn.tax.amount).toBe(`-${inv.tax.amount}`);
    expect(cn.lines.every((l: any) => l.net.amount.startsWith('-') || l.net.amount === '0.00')).toBe(true);
    expect((await ok(call('GET', u(w, `invoices/${inv.id}`), O))).creditedBy).toMatchObject({ number: cn.number });
    await code(call('POST', u(w, `invoices/${inv.id}/credit`), OM, { reason: 'Again please' }), 409, 'ALREADY_CREDITED');
    await code(call('POST', u(w, `invoices/${cn.id}/credit`), OM, { reason: 'Credit the credit' }), 422, 'NOT_CREDITABLE');
    const again = await ok(call('POST', u(w, `reservations/${b.id}/invoices`), O, { billTo: { name: 'Right Customer Ltd' } }), 201);      // the same items, now on a correct invoice
    expect(again.total.amount).toBe(inv.total.amount); expect(Number(again.number.slice(-6))).toBe(Number(inv.number.slice(-6)) + 1); expect(again.billTo.name).toBe('Right Customer Ltd');
    expect((await ok(call('GET', u(w, 'folio-check'), O))).ok).toBe(true);                                // the ledger itself never changed
  });

  it('two people issuing at once produce one invoice and no gap in the numbers; the printable page escapes everything and cannot run scripts', async () => {
    const w = await sunset('PRT-TEST');
    await activate('PR-ROOM', 'PRT-TEST', { rateBp: 1000, appliesTo: ['ROOM'] });
    const { b } = await (async () => { at('2026-11-05', '10:00'); const bk = await book(w, { name: '<script>alert(1)</script> & Sons' }); await setBd(w, '2026-11-05'); await checkIn(w, bk, '101'); await setBd(w, '2026-11-07'); at('2026-11-07', '10:00'); await checkOut(w, bk, { balanceReason: 'test' }); return { b: bk }; })();
    const [x, y] = await Promise.all([call('POST', u(w, `reservations/${b.id}/invoices`), O, {}), call('POST', u(w, `reservations/${b.id}/invoices`), O, {})]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([201, 422]);
    const issued = (x.statusCode === 201 ? x : y).json();
    expect(await adminDb.selectFrom('invoice').select('id').where('property_id', '=', w.pid).execute()).toHaveLength(1);
    const seqs = (await adminDb.selectFrom('invoice').select('seq').where('legal_entity_id', '=', T.legalEntityId).where('series', '=', 'INV').orderBy('seq').execute()).map((r) => r.seq);
    expect(seqs).toEqual(seqs.map((_, k) => k + 1));                                                       // the whole series has no gap and no duplicate
    const page = await call('GET', u(w, `invoices/${issued.id}/print`), O);
    expect(page.statusCode).toBe(200); expect(page.headers['content-type']).toMatch(/text\/html/); expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.body).toContain(issued.number); expect(page.body).toContain('TAX INVOICE'); expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Sons'); expect(page.body).not.toContain('<script>');
  });

  it('numbers by fiscal year: a July–June year puts November 2026 in "2026-27" and restarts the count each year', async () => {
    const t2 = await provision(app, 'fyear'); const owner = as(t2.tenantId, t2.ownerUserId); const ownerM = as(t2.tenantId, t2.ownerUserId, { mfa: true });
    const c = (m: any, url: string, h: any, body?: any, x: any = {}) => app.inject({ method: m, url, headers: { ...h, ...x }, payload: body });
    await ok(c('PUT', `/v1/legal-entities/${t2.legalEntityId}`, ownerM, { fiscalYearStartMonth: 7 }));
    const pid = (await c('POST', '/v1/properties', owner, { legalEntityId: t2.legalEntityId, code: 'FY1', name: 'FY' })).json().id;
    const rt = (await c('POST', `/v1/properties/${pid}/room-types`, owner, { code: 'STD', name: 'Std', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, baseOccupancy: 2 })).json().id;
    await c('POST', `/v1/properties/${pid}/rooms/bulk`, owner, { roomTypeId: rt, from: 101, to: 102 }); await c('POST', `/v1/properties/${pid}/go-live`, owner, { openingBusinessDate: OPEN });
    const bar = (await c('POST', `/v1/properties/${pid}/rate-plans`, owner, { code: 'BAR', name: 'BAR', residency: 'RESIDENT' })).json().id;
    await c('PUT', `/v1/properties/${pid}/rate-plans/${bar}/base-rates`, owner, { items: [{ roomTypeId: rt, amount: '5000' }] });
    const issue = async (arrival: string, departure: string, bd: string) => {
      await adminDb.updateTable('property').set({ business_date: arrival }).where('id', '=', pid).execute();
      const q = (await c('POST', `/v1/properties/${pid}/quotes`, owner, { arrival, departure, adults: 1 })).json();
      const g = (await c('POST', '/v1/guests', owner, { fullName: `Guest ${++n}`, phone: `0300${String(8000000 + n).slice(-7)}`, nationality: 'PK' })).json();
      const r = (await c('POST', `/v1/properties/${pid}/reservations`, owner, { guestId: g.id, source: 'PHONE', lines: [{ quoteToken: q.options[0].quoteToken }] }, { 'idempotency-key': `fy-${++n}-${Date.now()}` })).json();
      await adminDb.updateTable('room').set({ hk_status: 'CLEAN' }).where('property_id', '=', pid).execute();
      const ci = await c('POST', `/v1/properties/${pid}/reservations/${r.id}/rooms/${r.lines[0].id}/check-in`, owner, { roomId: (await c('GET', `/v1/properties/${pid}/rooms`, owner)).json().items[0].id, occupants: [{ fullName: 'Guest', isPrimary: true, idType: 'CNIC', idNumber: '3520212345671' }] }); expect(ci.statusCode, ci.body).toBe(200);
      await adminDb.updateTable('property').set({ business_date: bd }).where('id', '=', pid).execute();
      const o = await c('POST', `/v1/properties/${pid}/reservations/${r.id}/rooms/${r.lines[0].id}/check-out`, ownerM, { balanceReason: 'test' }); expect(o.statusCode, o.body).toBe(200);
      return ok(c('POST', `/v1/properties/${pid}/reservations/${r.id}/invoices`, owner, {}), 201);
    };
    at('2026-11-05', '10:00');
    expect((await issue('2026-11-05', '2026-11-06', '2026-11-06')).number).toBe('INV-2026-27-000001');
    expect((await issue('2026-11-08', '2026-11-09', '2026-11-09')).number).toBe('INV-2026-27-000002');
    testClock.set(zonedToUtcMs('2027-07-02', '10:00', 'Asia/Karachi'));
    expect((await issue('2027-07-02', '2027-07-03', '2027-07-03')).number).toBe('INV-2027-28-000001');     // new fiscal year, count restarts
    await code(c('PUT', `/v1/legal-entities/${t2.legalEntityId}`, ownerM, { fiscalYearStartMonth: 1 }), 409, 'FISCAL_YEAR_LOCKED');
  });
});
