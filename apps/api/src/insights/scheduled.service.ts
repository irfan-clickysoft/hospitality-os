import { ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { MailService } from '../mail/mail.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { InsightsService, envelopeToCsv } from './insights.service.js';
import type * as SS from './schedule-schemas.js';
import type { Envelope } from './types.js';
import { addDays } from './util.js';

const fail = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
/** How long a delivered link stays valid; the stored copy is removed after this. */
export const DELIVERY_DAYS = 7;
const dayOf = (d: string) => Number(d.slice(8, 10));
const weekdayOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const OPS = { gt: (a: number, b: number) => a > b, gte: (a: number, b: number) => a >= b, lt: (a: number, b: number) => a < b, lte: (a: number, b: number) => a <= b, eq: (a: number, b: number) => a === b } as const;
const OP_WORDS = { gt: 'is above', gte: 'is at least', lt: 'is below', lte: 'is at most', eq: 'equals' } as const;

/** The dates a scheduled report covers, counted from the business day that just closed. */
export function periodFor(period: string, closed: string): { from: string; to: string } {
  const first = `${closed.slice(0, 8)}01`;
  switch (period) {
    case 'LAST_7': return { from: addDays(closed, -6), to: closed };
    case 'LAST_30': return { from: addDays(closed, -29), to: closed };
    case 'MONTH_TO_DATE': return { from: first, to: closed };
    case 'PREVIOUS_MONTH': { const end = addDays(first, -1); return { from: `${end.slice(0, 8)}01`, to: end }; }
    case 'NEXT_7': return { from: addDays(closed, 1), to: addDays(closed, 7) };
    case 'NEXT_30': return { from: addDays(closed, 1), to: addDays(closed, 30) };
    case 'NEXT_90': return { from: addDays(closed, 1), to: addDays(closed, 90) };
    default: return { from: closed, to: closed };
  }
}
/** Whether a schedule is due when business day `closed` has just closed. */
export function isDue(s: { frequency: string; weekday: number | null; month_day: number | null }, closed: string): boolean {
  if (s.frequency === 'DAILY') return true;
  if (s.frequency === 'WEEKLY') return weekdayOf(closed) === s.weekday;
  return s.month_day === 0 ? dayOf(addDays(closed, 1)) === 1 : dayOf(closed) === s.month_day;
}

@Injectable()
export class ScheduledReportsService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuthorizationService) private readonly authz: AuthorizationService, @Inject(AuditService) private readonly audit: AuditService,
    @Inject(InsightsService) private readonly insights: InsightsService, @Inject(MailService) private readonly mail: MailService) {}

  private async need(userId: string, permission: string, propertyId: string) {
    if ((await this.authz.check(userId, { permission, scope: { propertyId } })).effect !== 'ALLOW') throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: `This needs the “${permission}” permission` });
  }

  /** Staff who can be chosen as recipients: active, with an email, and (when a report is named) allowed to open it. */
  async people(userId: string, propertyId: string, reportId?: string) {
    await this.need(userId, 'report.schedule', propertyId);
    const all = await this.tdb.tx((trx) => trx.selectFrom('staff_user').select(['id', 'full_name as name', 'email']).where('status', '=', 'ACTIVE').orderBy('full_name').execute());
    const out = [];
    for (const u of all) out.push({ ...u, canOpen: reportId ? await this.insights.canOpen(u.id, reportId, propertyId) : true });
    return { items: out };
  }

  private view(s: Record<string, any>, names: Map<string, string>) {
    return { id: s.id, reportId: s.report_id, reportName: this.insights.reportName(s.report_id) ?? s.report_id, name: s.name, basis: s.basis, params: s.params ?? {}, period: s.period, frequency: s.frequency, weekday: s.weekday, monthDay: s.month_day,
      alert: s.alert_kpi ? { kpi: s.alert_kpi, op: s.alert_op, value: Number(s.alert_value) } : null, recipients: (s.recipient_ids as string[]).map((id) => ({ id, name: names.get(id) ?? '—' })), active: s.active, pausedReason: s.paused_reason, lastRunOn: s.last_run_on, lastStatus: s.last_status, createdAt: s.created_at };
  }

  async list(userId: string, propertyId: string) {
    await this.need(userId, 'report.schedule', propertyId);
    return this.tdb.tx(async (trx) => {
      const names = new Map((await trx.selectFrom('staff_user').select(['id', 'full_name']).execute()).map((u) => [u.id, u.full_name]));
      const rows = await trx.selectFrom('report_schedule').selectAll().where('property_id', '=', propertyId).orderBy('created_at', 'desc').execute();
      const recent = await sql<Record<string, any>>`SELECT d.id, d.schedule_name, d.report_name, d.for_date::text AS for_date, d.generated_at, d.expires_at, d.status, d.note, d.rows,
          (SELECT count(*) FROM report_delivery_recipient r WHERE r.delivery_id = d.id)::int AS recipients, (SELECT count(*) FROM report_delivery_recipient r WHERE r.delivery_id = d.id AND r.views > 0)::int AS opened,
          (SELECT count(*) FROM report_delivery_recipient r WHERE r.delivery_id = d.id AND r.mail_status = 'FAILED')::int AS mail_failed
        FROM report_delivery d WHERE d.property_id = ${propertyId} ORDER BY d.generated_at DESC LIMIT 30`.execute(trx);
      return { items: rows.map((s) => this.view(s, names)), recent: recent.rows.map((d) => ({ id: d.id, schedule: d.schedule_name, report: d.report_name, forDate: d.for_date, generatedAt: d.generated_at, expiresAt: d.expires_at, expired: new Date(d.expires_at).getTime() < Date.now(), status: d.status, note: d.note, rows: d.rows, recipients: d.recipients, opened: d.opened, mailFailed: d.mail_failed })) };
    });
  }

  private async checkInput(userId: string, propertyId: string, i: z.infer<typeof SS.ScheduleInput>) {
    await this.need(userId, 'report.schedule', propertyId);
    const def = this.insights.reportDef(i.reportId);
    if (!def) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such report' });
    if (!(await this.insights.canOpen(userId, i.reportId, propertyId))) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You cannot open this report, so you cannot schedule it' });
    if (i.basis && !def.basis.some((b) => b.id === i.basis)) throw fail(422, 'VALIDATION_FAILED', 'That date basis does not exist for this report');
    const users = await this.tdb.tx((trx) => trx.selectFrom('staff_user').select(['id', 'full_name', 'email', 'status']).where('id', 'in', i.recipientIds).execute());
    const bad: string[] = [];
    for (const id of i.recipientIds) { const u = users.find((x) => x.id === id); if (!u || u.status !== 'ACTIVE' || !(await this.insights.canOpen(id, i.reportId, propertyId))) bad.push(u?.full_name ?? id); }
    if (bad.length) throw fail(422, 'RECIPIENT_NO_ACCESS', `These people cannot open this report, so it cannot be sent to them: ${bad.join(', ')}`);
  }

  async create(userId: string, propertyId: string, i: z.infer<typeof SS.ScheduleInput>) {
    await this.checkInput(userId, propertyId, i);
    return this.tdb.tx(async (trx) => {
      const row = await trx.insertInto('report_schedule').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, report_id: i.reportId, name: i.name, basis: i.basis ?? null, params: JSON.stringify(i.params), period: i.period, frequency: i.frequency, weekday: i.weekday ?? null, month_day: i.monthDay ?? null,
        alert_kpi: i.alert?.kpi ?? null, alert_op: i.alert?.op ?? null, alert_value: i.alert ? String(i.alert.value) : null, recipient_ids: i.recipientIds, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'report.schedule.create', resourceType: 'report_schedule', resourceId: row.id, propertyId, after: { report: i.reportId, frequency: i.frequency, recipients: i.recipientIds.length } });
      return { id: row.id };
    });
  }

  async update(userId: string, propertyId: string, id: string, i: z.infer<typeof SS.ScheduleUpdate>) {
    await this.need(userId, 'report.schedule', propertyId);
    return this.tdb.tx(async (trx) => {
      const r = await trx.updateTable('report_schedule').set({ ...(i.active !== undefined ? { active: i.active, paused_reason: null } : {}), version: sql`version + 1` } as never).where('id', '=', id).where('property_id', '=', propertyId).returning('id').executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Schedule not found' });
      await this.audit.record(trx, { action: 'report.schedule.update', resourceType: 'report_schedule', resourceId: id, propertyId, after: i }); return { id };
    });
  }
  async remove(userId: string, propertyId: string, id: string) {
    await this.need(userId, 'report.schedule', propertyId);
    return this.tdb.tx(async (trx) => {
      const r = await trx.deleteFrom('report_schedule').where('id', '=', id).where('property_id', '=', propertyId).returning('id').executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Schedule not found' });
      await this.audit.record(trx, { action: 'report.schedule.delete', resourceType: 'report_schedule', resourceId: id, propertyId }); return { id };
    });
  }

  /** Generates one delivery from a schedule for the business day `closed`. Authorization is checked now, not when the schedule was made. */
  async runOne(scheduleId: string, closed: string, opts: { force?: boolean } = {}): Promise<{ status: string; id: string | null; note: string | null }> {
    const s = await this.tdb.tx((trx) => trx.selectFrom('report_schedule').selectAll().where('id', '=', scheduleId).executeTakeFirst());
    if (!s) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Schedule not found' });
    const note = async (status: 'SKIPPED' | 'FAILED', text: string, pause?: string) => {
      const id = await this.tdb.tx(async (trx) => {
        const d = await trx.insertInto('report_delivery').values({ tenant_id: currentTenant().tenantId, schedule_id: s.id, property_id: s.property_id, report_id: s.report_id, report_name: this.insights.reportName(s.report_id) ?? s.report_id, schedule_name: s.name, for_date: closed, expires_at: new Date(Date.now() + DELIVERY_DAYS * 86_400_000), status, note: text, created_by: s.created_by } as never).returning('id').executeTakeFirstOrThrow();
        await trx.updateTable('report_schedule').set({ last_run_on: closed, last_status: status === 'SKIPPED' ? 'Skipped' : 'Failed', ...(pause ? { active: false, paused_reason: pause } : {}) } as never).where('id', '=', s.id).execute();
        return d.id;
      });
      return { status, id, note: text };
    };
    if (!opts.force && await this.tdb.tx((trx) => trx.selectFrom('report_delivery').select('id').where('schedule_id', '=', s.id).where('for_date', '=', closed).executeTakeFirst())) return { status: 'ALREADY', id: null, note: 'Already delivered for this day' };
    const owner = await this.tdb.tx((trx) => trx.selectFrom('staff_user').select(['id', 'status']).where('id', '=', s.created_by).executeTakeFirst());
    if (!owner || owner.status !== 'ACTIVE') return note('FAILED', 'The person who made this schedule is no longer active, so it was paused.', 'Owner is no longer active');
    const range = periodFor(s.period, closed);
    let env: Envelope;
    try { env = await this.insights.run(s.created_by, s.property_id, s.report_id, { basis: s.basis ?? undefined, from: range.from, to: range.to, params: (s.params ?? {}) as Record<string, string> }, { scheduled: true }); }
    catch (e) {
      if (e instanceof ForbiddenException) return note('FAILED', 'The person who made this schedule can no longer open this report, so it was paused.', 'Owner can no longer open the report');
      return note('FAILED', `The report could not be generated: ${(e as Error).message}`.slice(0, 480));
    }
    let alertText = '';
    if (s.alert_kpi && s.alert_op && s.alert_value !== null) {
      const k = env.kpis.find((x) => x.key === s.alert_kpi); const v = k ? Number(k.value) : NaN; const limit = Number(s.alert_value);
      if (!k || Number.isNaN(v)) return note('SKIPPED', 'The figure this alert watches is not available in the report.');
      if (!opts.force && !OPS[s.alert_op](v, limit)) return note('SKIPPED', `Alert not triggered: “${k.label}” ${OP_WORDS[s.alert_op]} ${limit} was not true.`);
      alertText = `Alert: “${k.label}” ${OP_WORDS[s.alert_op]} ${limit}.`;
    }
    const people = await this.tdb.tx((trx) => trx.selectFrom('staff_user').select(['id', 'email', 'full_name', 'status']).where('id', 'in', s.recipient_ids).execute());
    const eligible: Array<{ id: string; email: string; full_name: string; status: string }> = []; const skipped: Array<{ id: string; email: string; why: string }> = [];
    for (const id of s.recipient_ids) { const u = people.find((x) => x.id === id); if (!u) continue; if (u.status === 'ACTIVE' && await this.insights.canOpen(id, s.report_id, s.property_id)) eligible.push(u); else skipped.push({ id, email: u.email, why: 'No longer has access to this report' }); }
    const delivery = await this.tdb.tx(async (trx) => {
      const d = await trx.insertInto('report_delivery').values({ tenant_id: currentTenant().tenantId, schedule_id: s.id, property_id: s.property_id, report_id: s.report_id, report_name: env.meta.name, schedule_name: s.name, for_date: closed, expires_at: new Date(Date.now() + DELIVERY_DAYS * 86_400_000), status: 'READY', note: [alertText, skipped.length ? `${skipped.length} recipient(s) skipped: no longer allowed to open this report.` : ''].filter(Boolean).join(' ') || null, rows: env.rows.length, snapshot: JSON.stringify(env), created_by: s.created_by } as never).returning('id').executeTakeFirstOrThrow();
      for (const u of eligible) await trx.insertInto('report_delivery_recipient').values({ tenant_id: currentTenant().tenantId, delivery_id: d.id, user_id: u.id, email: u.email } as never).execute();
      await trx.updateTable('report_schedule').set({ last_run_on: closed, last_status: 'Delivered' } as never).where('id', '=', s.id).execute();
      await this.audit.record(trx, { action: 'report.deliver', resourceType: 'report_delivery', resourceId: d.id, propertyId: s.property_id, after: { schedule: s.id, report: s.report_id, forDate: closed, recipients: eligible.length, skipped: skipped.length } });
      return d;
    });
    const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, ''); const link = `${base}/#/reports/center?d=${delivery.id}`;
    const configured = this.mail.status().configured;
    for (const u of eligible) {
      const text = [`Hello ${u.full_name},`, '', `“${s.name}” for ${env.meta.property.name} is ready (business day ${closed}).`, ...(alertText ? [alertText] : []), '', base ? `Open it here (you will be asked to sign in): ${link}` : 'Open Stay360 → Reports → Scheduled to read it.', `The link works for ${DELIVERY_DAYS} days and only for people who may open this report.`, '', 'No figures are included in this email on purpose.'].join('\n');
      let st: 'SENT' | 'FAILED' | 'SKIPPED' = 'SENT'; let why: string | null = null;
      if (!configured) { st = 'SKIPPED'; why = 'Email is not switched on; open it under Reports → Scheduled.'; }
      else { try { await this.mail.send(s.property_id, s.created_by, { purpose: 'REPORT', refId: delivery.id, to: u.email, subject: `${s.name} — ${env.meta.property.code} — ${closed}`.slice(0, 190), text }); } catch (e) { st = 'FAILED'; why = String((e as { message?: string }).message ?? e).slice(0, 280); } }
      await this.tdb.tx((trx) => trx.updateTable('report_delivery_recipient').set({ mail_status: st, mail_note: why } as never).where('delivery_id', '=', delivery.id).where('user_id', '=', u.id).execute());
    }
    return { status: 'READY', id: delivery.id, note: alertText || null };
  }

  /** Called when a business day has closed: delivers every schedule that falls due and removes stored copies whose links have expired. Never throws into the audit. */
  async onDayClosed(propertyId: string, closed: string): Promise<{ delivered: number }> {
    let delivered = 0;
    try {
      await this.tdb.tx((trx) => sql`UPDATE report_delivery SET snapshot = NULL WHERE snapshot IS NOT NULL AND expires_at < now()`.execute(trx));
      const list = await this.tdb.tx((trx) => trx.selectFrom('report_schedule').selectAll().where('property_id', '=', propertyId).where('active', '=', true).execute());
      for (const s of list) { if (!isDue(s, closed)) continue; try { const r = await this.runOne(s.id, closed); if (r.status === 'READY') delivered++; } catch { /* one schedule failing must not stop the others */ } }
    } catch { /* the day is already closed; delivery problems are shown in the delivery list */ }
    return { delivered };
  }

  async runNow(userId: string, propertyId: string, id: string) {
    await this.need(userId, 'report.schedule', propertyId);
    const p = await this.tdb.tx((trx) => trx.selectFrom('property').select('business_date').where('id', '=', propertyId).executeTakeFirstOrThrow());
    const s = await this.tdb.tx((trx) => trx.selectFrom('report_schedule').select('id').where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst());
    if (!s) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Schedule not found' });
    return this.runOne(id, addDays(p.business_date, -1), { force: true });
  }

  async mine(userId: string, propertyId: string) {
    return this.tdb.tx(async (trx) => {
      const r = await sql<Record<string, any>>`SELECT d.id, d.schedule_name, d.report_name, d.for_date::text AS for_date, d.generated_at, d.expires_at, d.note, d.rows, r.views FROM report_delivery d JOIN report_delivery_recipient r ON r.delivery_id = d.id AND r.user_id = ${userId} WHERE d.property_id = ${propertyId} AND d.status = 'READY' ORDER BY d.generated_at DESC LIMIT 30`.execute(trx);
      return { items: r.rows.filter((d) => d.id).map((d) => ({ id: d.id, schedule: d.schedule_name, report: d.report_name, forDate: d.for_date, generatedAt: d.generated_at, expiresAt: d.expires_at, expired: new Date(d.expires_at).getTime() < Date.now(), note: d.note, rows: d.rows, opened: d.views > 0 })) };
    });
  }

  /** Opens a stored copy. It must be addressed to this person, unexpired, and the person must still be allowed to open the report. */
  async open(userId: string, propertyId: string, id: string): Promise<{ envelope: Envelope; delivery: { id: string; schedule: string; generatedAt: Date; expiresAt: Date; note: string | null } }> {
    const d = await this.tdb.tx(async (trx) => {
      const row = await trx.selectFrom('report_delivery as d').innerJoin('report_delivery_recipient as r', (j) => j.onRef('r.delivery_id', '=', 'd.id').on('r.user_id', '=', userId)).select(['d.id', 'd.report_id', 'd.schedule_name', 'd.generated_at', 'd.expires_at', 'd.note', 'd.snapshot', 'd.status', 'r.mail_status']).where('d.id', '=', id).where('d.property_id', '=', propertyId).executeTakeFirst();
      return row;
    });
    if (!d || d.status !== 'READY') throw new NotFoundException({ code: 'NOT_FOUND', message: 'Report not found' });
    if (new Date(d.expires_at).getTime() < Date.now() || !d.snapshot) throw fail(410, 'DELIVERY_EXPIRED', 'This delivery has expired. Ask for a new one or run the report again.');
    if (!(await this.insights.canOpen(userId, d.report_id, propertyId))) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'You no longer have access to this report' });
    await this.tdb.tx(async (trx) => {
      await trx.updateTable('report_delivery_recipient').set({ views: sql`views + 1`, first_viewed_at: sql`coalesce(first_viewed_at, now())` } as never).where('delivery_id', '=', id).where('user_id', '=', userId).execute();
      await this.audit.record(trx, { action: 'report.delivery.view', resourceType: 'report_delivery', resourceId: id, propertyId });
    });
    return { envelope: d.snapshot as Envelope, delivery: { id: d.id, schedule: d.schedule_name, generatedAt: d.generated_at, expiresAt: d.expires_at, note: d.note } };
  }
  async csv(userId: string, propertyId: string, id: string) {
    const r = await this.open(userId, propertyId, id);
    await this.tdb.tx((trx) => this.audit.record(trx, { action: 'report.export', resourceType: 'report_delivery', resourceId: id, propertyId, note: r.envelope.meta.name, after: { rows: r.envelope.rows.length, delivery: true } }));
    return envelopeToCsv(r.envelope);
  }
}
