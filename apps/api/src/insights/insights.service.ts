import { ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { toCsv } from '../reports/csv.js';
import * as FD from './frontdesk.js';
import * as FIN from './finance.js';
import * as RM from './rooms.js';
import * as MG from './management.js';
import * as CS from './cases.js';
import * as PC from './pace.js';
import { takeBookingSnapshot } from './snapshots.js';
import type { Col, Def, Envelope, Row } from './types.js';
import { addDays, dec, ymd } from './util.js';

const fail = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
export const REGISTRY: Def[] = [MG.flash, FD.expectedArrivals, FD.checkins, FD.roomMoves, FD.roomReassignments, FD.cancellations, FD.earlyLate, FD.rateChanges, RM.roomStatus, FIN.cashier, FIN.outstanding, FIN.discounts, RM.lostFound, CS.damageCharges, CS.complaints, MG.nightAudit, MG.futureBookings, PC.bookingPace, PC.forecast, MG.historical];
/** Reports in the plan that need new information to be captured first. Listed so nobody wonders where they are. */
export const PLANNED: ReadonlyArray<{ id: string; name: string; category: string; purpose: string; needs: string }> = [];
const MAX_DAYS = 400;
const QUOTE = /[^A-Za-z0-9._-]/g;

/** The report as a spreadsheet file: a header block (what, where, which dates and filters, currency and tax basis, time zone, who and when), the rows, and a totals row. */
export function envelopeToCsv(e: Envelope): { filename: string; csv: string } {
  const cols = e.columns.filter((c) => !!c.label);
  const cell = (c: Col, r: Row) => { const v = r[c.key]; if (v === null || v === undefined || v === '') return ''; if (c.type === 'money') return dec(v as string); if (r._fmt === 'money') return typeof v === 'string' ? v : String(v); return v as string | number; };
  const m = e.meta;
  const head: Array<Array<string | number>> = [[m.name], [`Property: ${m.property.name} (${m.property.code})`], [`Date basis: ${m.dateBasis.label}${m.from ? ` — ${m.from} to ${m.to}` : ''}`], [`Filters: ${Object.entries(m.params).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`], [`Currency: ${m.currency}. Tax basis: ${m.taxBasis}`],
    [`Time zone: ${m.timezone}. Business date: ${m.businessDate}`], [`Generated: ${m.asOf} by ${m.generatedBy ?? 'unknown'}. Data as of: ${m.asOf}. Report definition v${m.definitionVersion}`], []];
  const body = e.rows.map((r) => cols.map((c) => cell(c, r)));
  if (e.totals) body.push(cols.map((c, i) => (i === 0 ? 'Total' : e.totals![c.key] === undefined ? '' : c.type === 'money' ? dec(e.totals![c.key] as string) : (e.totals![c.key] as number))));
  const lines = toCsv(cols.map((c) => c.label), body as never);
  const csv = head.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n' + lines;
  return { filename: `${m.property.code}-${m.id}-${(m.from ?? m.businessDate)}${m.to ? `_${m.to}` : ''}.csv`.replace(QUOTE, '_'), csv };
}

@Injectable()
export class InsightsService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuthorizationService) private readonly authz: AuthorizationService, @Inject(AuditService) private readonly audit: AuditService) {}

  /** Whether this person may open the report at the property right now. Checked again whenever a stored copy is opened. */
  async canOpen(userId: string, reportId: string, propertyId: string): Promise<boolean> { const d = REGISTRY.find((x) => x.id === reportId); return !!d && this.allowed(userId, d, propertyId); }
  reportName(reportId: string) { return REGISTRY.find((x) => x.id === reportId)?.name ?? null; }
  reportDef(reportId: string) { return REGISTRY.find((x) => x.id === reportId) ?? null; }

  private async allowed(userId: string, d: Def, propertyId: string): Promise<boolean> {
    for (const permission of d.permissions) if ((await this.authz.check(userId, { permission, scope: { propertyId } })).effect === 'ALLOW') return true;
    return false;
  }

  async catalog(userId: string, propertyId: string) {
    const mine: Array<Record<string, unknown>> = [];
    for (const d of REGISTRY) if (await this.allowed(userId, d, propertyId)) mine.push({ id: d.id, name: d.name, category: d.category, kind: d.kind, purpose: d.purpose, roles: d.roles, basis: d.basis, range: d.range, params: d.params ?? [] });
    return { items: mine, planned: PLANNED };
  }

  private rangeOf(d: Def, bd: string, from?: string, to?: string) {
    const def = d.range === 'month' ? [`${bd.slice(0, 8)}01`, bd] : d.range === 'last30' ? [addDays(bd, -29), bd] : d.range === 'next30' ? [bd, addDays(bd, 29)] : d.range === 'next90' ? [bd, addDays(bd, 89)] : [bd, bd];
    const f = from ?? def[0]!; const t = to ?? def[1]!;
    if (!ymd(f) || !ymd(t)) throw fail(400, 'VALIDATION_FAILED', 'Dates must look like 2026-11-05');
    if (t < f) throw fail(400, 'VALIDATION_FAILED', 'The end date is before the start date');
    if ((Date.parse(t) - Date.parse(f)) / 86_400_000 > MAX_DAYS) throw fail(400, 'RANGE_TOO_LONG', `Choose a period of at most ${MAX_DAYS} days`);
    return { from: f, to: t };
  }

  async run(userId: string, propertyId: string, id: string, q: { basis?: string; from?: string; to?: string; params?: Record<string, string> }, opts: { exported?: boolean; scheduled?: boolean } = {}): Promise<Envelope> {
    const d = REGISTRY.find((x) => x.id === id);
    if (!d) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such report' });
    if (!(await this.allowed(userId, d, propertyId))) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: `You do not have access to the “${d.name}” report` });
    const basis = d.basis.find((b) => b.id === q.basis) ?? d.basis[0]!;
    const params: Record<string, string> = {};
    for (const p of d.params ?? []) { const v = q.params?.[p.key]; params[p.key] = p.options.some((o) => o.value === v) ? v! : p.default; }
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['id', 'code', 'name', 'currency', 'timezone', 'business_date', 'check_in_time', 'check_out_time']).where('id', '=', propertyId).executeTakeFirst();
      if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
      const { from, to } = this.rangeOf(d, p.business_date, q.from, q.to);
      const tenantId = currentTenant().tenantId;
      const canRestricted = !opts.scheduled && (await this.authz.check(userId, { permission: 'case.restricted', scope: { propertyId } })).effect === 'ALLOW';      // a scheduled copy never carries restricted cases: it is read by other people later
      const res = await d.run({ trx, tenantId, propertyId, prop: { code: p.code, name: p.name, currency: p.currency, timezone: p.timezone, businessDate: p.business_date, checkIn: p.check_in_time, checkOut: p.check_out_time }, from, to, basis: basis.id, params, canRestricted });
      const totals = this.totalsOf(res.columns, res.rows);
      const me = await trx.selectFrom('staff_user').select('full_name').where('id', '=', userId).executeTakeFirst();
      if (opts.exported) await this.audit.record(trx, { action: 'report.export', resourceType: 'report', resourceId: d.id, propertyId, after: { basis: basis.id, from, to, params, rows: res.rows.length }, note: d.name });
      return { ...res, totals, definitions: d.definitions, meta: { id: d.id, name: d.name, purpose: d.purpose, kind: d.kind, category: d.category, property: { id: p.id, code: p.code, name: p.name }, timezone: p.timezone, businessDate: p.business_date, asOf: new Date().toISOString(), dateBasis: basis,
        from: d.range === 'none' ? null : from, to: d.range === 'none' ? null : to, params, currency: p.currency, taxBasis: 'Excluding tax unless a column says otherwise', definitionVersion: '1', freshness: 'live', generatedBy: me?.full_name ?? null } };
    });
  }

  private totalsOf(columns: Col[], rows: Row[]): Row | null {
    const t = columns.filter((c) => c.total); if (!t.length || !rows.length) return null;
    const out: Row = {};
    for (const c of t) { if (c.type === 'money') out[c.key] = rows.reduce((s, r) => s + BigInt((r[c.key] as string | null) ?? 0), 0n).toString(); else out[c.key] = rows.reduce((s, r) => s + Number(r[c.key] ?? 0), 0); }
    return out;
  }

  async csv(userId: string, propertyId: string, id: string, q: Parameters<InsightsService['run']>[3]) {
    return envelopeToCsv(await this.run(userId, propertyId, id, q, { exported: true }));
  }

  /** What snapshots exist: how many days, the first and latest, and whether today's is saved. */
  async snapshotStatus(userId: string, propertyId: string) {
    const ok = (await this.authz.check(userId, { permission: 'management.view', scope: { propertyId } })).effect === 'ALLOW' || (await this.authz.check(userId, { permission: 'report.view', scope: { propertyId } })).effect === 'ALLOW';
    if (!ok) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You do not have access to this' });
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select('business_date').where('id', '=', propertyId).executeTakeFirstOrThrow();
      const r = await trx.selectFrom('booking_snapshot_run').select(({ fn }) => [fn.countAll<string>().as('n'), fn.min('snapshot_date').as('first'), fn.max('snapshot_date').as('latest')]).where('property_id', '=', propertyId).executeTakeFirstOrThrow();
      const last = await trx.selectFrom('booking_snapshot_run').select(['source', 'taken_at']).where('property_id', '=', propertyId).orderBy('snapshot_date', 'desc').limit(1).executeTakeFirst();
      return { days: Number(r.n), first: r.first, latest: r.latest, lastSource: last?.source ?? null, lastTakenAt: last?.taken_at ?? null, businessDate: p.business_date, todaySaved: r.latest === p.business_date };
    });
  }

  /** Saves the books for the current business date now (replaced by the night audit's own when the day closes). */
  async takeSnapshot(userId: string, propertyId: string) {
    if ((await this.authz.check(userId, { permission: 'nightaudit.run', scope: { propertyId } })).effect !== 'ALLOW') throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Saving a snapshot needs the night-audit permission' });
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select('business_date').where('id', '=', propertyId).executeTakeFirstOrThrow();
      const r = await takeBookingSnapshot(trx, currentTenant().tenantId, propertyId, p.business_date, 'MANUAL', userId);
      await this.audit.record(trx, { action: 'report.snapshot', resourceType: 'property', resourceId: propertyId, propertyId, after: { date: p.business_date, rows: r.rows } });
      return { snapshotDate: p.business_date, rows: r.rows };
    });
  }
}
