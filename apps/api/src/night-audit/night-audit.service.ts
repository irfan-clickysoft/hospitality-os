import { ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import type { DB } from '@hos/db';
import { Money, addDays, civilDateIn } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { TenantDb } from '../db/tenant-db.js';
import { FolioService } from '../folio/folio.service.js';
import { HousekeepingService } from '../housekeeping/housekeeping.service.js';
import { HORIZON_DAYS, InventoryService } from '../inventory/inventory.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { TaxService } from '../tax/tax.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { mapDbError } from '../common/db-errors.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

type Trx = Transaction<DB>;
type Kind = (typeof import('./schemas.js'))['EXCEPTION_KINDS'][number];
const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
const fmt = (m: bigint | string | number, cur: string) => ({ amount: Money.ofMinor(BigInt(m), cur).toDecimalString(), currency: cur });
const STALE_RUN_MS = 5 * 60_000;
const EARLY_BEFORE_HOUR = 20;
const BATCH = 25;

/** The steps, in order. Each is safe to repeat; a failed run resumes at the first step that is not DONE. */
export const STEPS = ['NO_SHOWS', 'OPTIONS', 'ROOM_CHARGES', 'TAXES', 'CLOSE_DAY'] as const;
type Step = (typeof STEPS)[number];

export interface AuditException { kind: Kind; severity: 'BLOCKING' | 'WARNING'; overridable: boolean; count: number; items: Array<Record<string, unknown>>; message: string }

@Injectable()
export class NightAuditService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(FolioService) private readonly folios: FolioService,
    @Inject(HousekeepingService) private readonly hk: HousekeepingService,
    @Inject(ReservationsService) private readonly res: ReservationsService,
    @Inject(InventoryService) private readonly inv: InventoryService,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  private async prop(trx: Trx, id: string, lock = false) {
    let q = trx.selectFrom('property').select(['id', 'code', 'currency', 'business_date', 'timezone', 'status']).where('id', '=', id);
    if (lock) q = q.forUpdate();
    const p = await q.executeTakeFirst();
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    return p;
  }

  // ───────────── checks before the audit ─────────────
  async precheck(propertyId: string): Promise<{ businessDate: string; exceptions: AuditException[] }> {
    const base = await this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const bd = p.business_date;
      const out: AuditException[] = [];
      const push = (kind: Kind, severity: 'BLOCKING' | 'WARNING', overridable: boolean, message: string, items: Array<Record<string, unknown>>) => { if (items.length) out.push({ kind, severity, overridable, count: items.length, items: items.slice(0, 50), message }); };

      const sessions = await trx.selectFrom('cashier_session as s').innerJoin('staff_user as u', 'u.id', 's.user_id').select(['s.id', 's.register_name', 'u.full_name']).where('s.property_id', '=', propertyId).where('s.status', '=', 'OPEN').execute();
      push('OPEN_CASHIER_SESSION', 'BLOCKING', false, 'Every cashier session must be closed and counted before the day can be closed.', sessions.map((s) => ({ sessionId: s.id, register: s.register_name, cashier: s.full_name })));

      const overdue = await sql<{ confirmation_no: string; departure: string; room: string | null }>`SELECT r.confirmation_no, l.departure::text AS departure,
          (SELECT rm.number FROM room_assignment a JOIN room rm ON rm.id = a.room_id WHERE a.assignment_ref = l.id AND a.status = 'IN_HOUSE' LIMIT 1) AS room
        FROM reservation_room l JOIN reservation r ON r.id = l.reservation_id WHERE l.tenant_id = ${currentTenant().tenantId} AND l.property_id = ${propertyId} AND l.status = 'CHECKED_IN' AND l.departure <= ${bd}::date ORDER BY l.departure`.execute(trx);
      push('DEPARTURE_OVERDUE', 'BLOCKING', true, 'These guests were due to leave. Check them out or extend the stay — otherwise their extra night is not charged.', overdue.rows.map((r) => ({ confirmationNo: r.confirmation_no, room: r.room, departure: r.departure })));

      const pending = await sql<{ confirmation_no: string; arrival: string; guest: string }>`SELECT r.confirmation_no, l.arrival::text AS arrival, g.full_name AS guest FROM reservation_room l JOIN reservation r ON r.id = l.reservation_id JOIN guest g ON g.id = r.guest_id
        WHERE l.tenant_id = ${currentTenant().tenantId} AND l.property_id = ${propertyId} AND l.status = 'CONFIRMED' AND l.arrival <= ${bd}::date ORDER BY l.arrival, r.confirmation_no`.execute(trx);
      push('ARRIVAL_PENDING', 'WARNING', false, 'These guests have not arrived. The audit will mark them as no-shows (and charge the no-show fee under their rate). Check in anyone who is here now.', pending.rows.map((r) => ({ confirmationNo: r.confirmation_no, guest: r.guest, arrival: r.arrival })));

      const bank = await trx.selectFrom('payment').select(['id', 'amount_minor', 'currency', 'reference']).where('property_id', '=', propertyId).where('status', '=', 'PENDING_VERIFICATION').execute();
      push('PENDING_BANK_TRANSFER', 'WARNING', false, 'These bank transfers or refunds are still waiting for a second person to verify them. They will carry over to the next day.', bank.map((b) => ({ paymentId: b.id, amount: fmt(b.amount_minor, b.currency).amount, reference: b.reference })));

      const inv = await this.inv.checkInvariants(trx, propertyId);
      push('INVENTORY_INVARIANT', 'BLOCKING', true, 'The availability counters disagree with the bookings. Find out why before closing the day.', inv.map((i) => ({ kind: i.kind, date: i.date ?? null, detail: i.detail })));

      const local = civilDateIn(p.timezone, this.clock.now());
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: p.timezone, hour: '2-digit', hour12: false }).format(new Date(this.clock.now()))) % 24;
      if (local < bd || (local === bd && hour < EARLY_BEFORE_HOUR)) push('EARLY_AUDIT', 'BLOCKING', true, `The business day (${bd}) is not over yet — it is before ${EARLY_BEFORE_HOUR}:00 on that day locally.`, [{ businessDate: bd, localDate: local, localHour: hour }]);
      return { businessDate: bd, exceptions: out };
    });
    const ledger = await this.folios.checkInvariants(propertyId);
    if (ledger.length) base.exceptions.push({ kind: 'LEDGER_INVARIANT', severity: 'BLOCKING', overridable: true, count: ledger.length, items: ledger.slice(0, 50), message: 'The folio ledger disagrees with itself. Find out why before closing the day.' });
    return base;
  }

  async status(propertyId: string) {
    const pre = await this.precheck(propertyId);
    return this.tdb.tx(async (trx) => {
      const last = await trx.selectFrom('night_audit_run').selectAll().where('property_id', '=', propertyId).where('status', '=', 'COMPLETED').orderBy('business_date', 'desc').limit(1).executeTakeFirst();
      const cur = await trx.selectFrom('night_audit_run').selectAll().where('property_id', '=', propertyId).where('business_date', '=', pre.businessDate).where('status', '<>', 'COMPLETED').orderBy('started_at', 'desc').limit(1).executeTakeFirst();
      const blocking = pre.exceptions.filter((e) => e.severity === 'BLOCKING');
      return { businessDate: pre.businessDate, lastCompleted: last ? { businessDate: last.business_date, completedAt: last.completed_at, runId: last.id } : null,
        currentRun: cur ? { id: cur.id, status: cur.status, startedAt: cur.started_at, error: cur.error } : null,
        exceptions: pre.exceptions, canStart: !blocking.some((e) => !e.overridable), needsOverride: blocking.filter((e) => e.overridable).map((e) => e.kind) };
    });
  }

  // ───────────── starting and resuming ─────────────
  async start(propertyId: string, userId: string, i: z.infer<typeof S.StartRun>) {
    const existing = await this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      return trx.selectFrom('night_audit_run').selectAll().where('property_id', '=', propertyId).where('business_date', '=', p.business_date).where('status', 'in', ['RUNNING', 'FAILED']).orderBy('started_at', 'desc').executeTakeFirst();
    });
    let runId: string;
    if (existing) {
      const stale = existing.status === 'RUNNING' && this.clock.now() - new Date(existing.updated_at).getTime() > STALE_RUN_MS;
      if (existing.status === 'RUNNING' && !stale) throw fail(409, 'AUDIT_RUNNING', 'A night audit is already running for this day.');
      runId = existing.id;                                                                       // resume: completed steps are not repeated
      await this.tdb.tx((trx) => trx.updateTable('night_audit_run').set({ status: 'RUNNING', error: null, resumed_count: existing.resumed_count + 1, updated_at: new Date(this.clock.now()) }).where('id', '=', runId).execute());
      await this.tdb.tx((trx) => this.audit.record(trx, { action: 'night_audit.resume', resourceType: 'night_audit_run', resourceId: runId, propertyId, note: stale ? 'resumed a stalled run' : 'resumed after a failed step' }));
    } else {
      const pre = await this.precheck(propertyId);
      const blocking = pre.exceptions.filter((e) => e.severity === 'BLOCKING');
      const hard = blocking.filter((e) => !e.overridable);
      const open = blocking.filter((e) => e.overridable && !i.overrides.some((o) => o.kind === e.kind));
      if (hard.length || open.length) throw fail(409, 'AUDIT_BLOCKED', 'The night audit cannot start until these are sorted out.', { exceptions: pre.exceptions, needsOverride: open.map((e) => e.kind), cannotOverride: hard.map((e) => e.kind) });
      const used = i.overrides.filter((o) => blocking.some((e) => e.kind === o.kind));
      if (used.length) { await this.res.requirePermission(userId, 'nightaudit.override', propertyId); await this.res.requireFreshMfa(); }
      runId = await this.createRun(propertyId, userId, pre.businessDate, used);
    }
    return this.execute(propertyId, runId, userId);
  }

  private async createRun(propertyId: string, userId: string, bd: string, overrides: Array<{ kind: string; reason: string }>): Promise<string> {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId, true);
      if (p.business_date !== bd) throw fail(409, 'STALE_BUSINESS_DATE', 'The business date changed while you were checking. Look again.');
      if (p.status !== 'LIVE') throw fail(422, 'PROPERTY_NOT_LIVE', 'This property is not live yet.');
      let run;
      try {
        run = await trx.insertInto('night_audit_run').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, business_date: bd, status: 'RUNNING', started_by: userId, overrides: JSON.stringify(overrides) } as never).returning('id').executeTakeFirstOrThrow();
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw fail(409, 'AUDIT_RUNNING', 'A night audit already exists for this day.');
        throw e;
      }
      await trx.insertInto('night_audit_step').values(STEPS.map((k, n) => ({ tenant_id: currentTenant().tenantId, run_id: run.id, step_key: k, seq: n + 1 }))  as never).execute();
      await this.audit.record(trx, { action: 'night_audit.start', resourceType: 'night_audit_run', resourceId: run.id, propertyId, after: { businessDate: bd, overrides }, reasonCode: overrides.length ? 'AUDIT_OVERRIDE' : undefined, note: overrides.map((o) => `${o.kind}: ${o.reason}`).join('; ') || undefined });
      return run.id;
    });
  }

  // ───────────── running the steps ─────────────
  private async execute(propertyId: string, runId: string, userId: string) {
    const run = await this.tdb.tx((trx) => trx.selectFrom('night_audit_run').selectAll().where('id', '=', runId).executeTakeFirstOrThrow());
    const bd = run.business_date;
    for (const key of STEPS) {
      const row = await this.tdb.tx((trx) => trx.selectFrom('night_audit_step').selectAll().where('run_id', '=', runId).where('step_key', '=', key).executeTakeFirstOrThrow());
      if (row.status === 'DONE') continue;
      await this.tdb.tx(async (trx) => {
        await trx.updateTable('night_audit_step').set({ status: 'RUNNING', attempts: row.attempts + 1, started_at: new Date(this.clock.now()), error: null }).where('run_id', '=', runId).where('step_key', '=', key).execute();
        await trx.updateTable('night_audit_run').set({ updated_at: new Date(this.clock.now()) }).where('id', '=', runId).execute();
      });
      try {
        if (key === 'CLOSE_DAY') await this.closeDay(propertyId, runId, bd, userId);
        else {
          const result = await this.runStep(key, propertyId, bd, userId);
          await this.tdb.tx((trx) => trx.updateTable('night_audit_step').set({ status: 'DONE', finished_at: new Date(this.clock.now()), result: JSON.stringify(result) }).where('run_id', '=', runId).where('step_key', '=', key).execute());
        }
      } catch (e) {
        const he = e instanceof HttpException ? e : mapDbError(e);
        const message = he ? `${(he.getResponse() as { code?: string }).code ?? 'ERROR'}: ${he.message}` : (e as Error).message;
        await this.tdb.tx(async (trx) => {
          await trx.updateTable('night_audit_step').set({ status: 'FAILED', finished_at: new Date(this.clock.now()), error: message }).where('run_id', '=', runId).where('step_key', '=', key).execute();
          await trx.updateTable('night_audit_run').set({ status: 'FAILED', error: `${key}: ${message}`, updated_at: new Date(this.clock.now()) }).where('id', '=', runId).execute();
          await this.audit.record(trx, { action: 'night_audit.fail', resourceType: 'night_audit_run', resourceId: runId, propertyId, note: `${key}: ${message}` });
        });
        throw fail(500, 'AUDIT_STEP_FAILED', `The audit stopped at "${key}". Fix the cause and start it again — it continues from this step.`, { runId, step: key, reason: message });
      }
    }
    return this.runView(propertyId, runId);
  }

  private async runStep(key: Exclude<Step, 'CLOSE_DAY'>, propertyId: string, bd: string, userId: string): Promise<Record<string, unknown>> {
    if (key === 'NO_SHOWS') {
      const due = await this.tdb.tx((trx) => trx.selectFrom('reservation_room').select(['reservation_id']).where('property_id', '=', propertyId).where('status', '=', 'CONFIRMED').where('arrival', '<=', bd).groupBy('reservation_id').execute());
      let lines = 0;
      for (const r of due) {
        await this.tdb.tx(async (trx) => {
          const { lines: ls } = await this.res.load(trx, propertyId, r.reservation_id, true);
          const ids = ls.filter((l) => l.status === 'CONFIRMED' && l.arrival <= bd).map((l) => l.id);
          if (!ids.length) return;
          await this.res.transition(trx, propertyId, r.reservation_id, 'NO_SHOW', { reason: 'Night audit: did not arrive', lineIds: ids, userId });
          lines += ids.length;
        });
      }
      return { reservations: due.length, lines };
    }
    if (key === 'OPTIONS') return this.res.expireOptions(propertyId);
    if (key === 'ROOM_CHARGES') {
      const lines = await this.tdb.tx((trx) => trx.selectFrom('reservation_room').select(['id', 'reservation_id']).where('property_id', '=', propertyId).where('status', '=', 'CHECKED_IN').where('arrival', '<=', bd).orderBy('id').execute());
      let nights = 0, total = 0n;
      for (let k = 0; k < lines.length; k += BATCH) {
        await this.tdb.tx(async (trx) => {
          for (const l of lines.slice(k, k + BATCH)) { const r = await this.folios.postRoomNights(trx, propertyId, l, bd, userId); nights += r.posted; total += r.total; }
        });
      }
      return { lines: lines.length, nightsPosted: nights, totalMinor: total.toString() };
    }
    return this.tdb.tx(async (trx) => { const r = await this.tax.catchUp(trx, propertyId, bd, userId); return { postings: r.postings, taxMinor: r.taxMinor.toString(), configured: (await this.tax.rulesFor(trx, propertyId)).length > 0 }; });   // tax is worked out as each charge is posted; this adds it to anything posted before its rate existed
  }

  /** One transaction: freeze postings, catch up stragglers, snapshot the day, roll the date, open the next day's inventory and housekeeping. */
  private async closeDay(propertyId: string, runId: string, bd: string, userId: string) {
    await this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId, true);                                          // exclusive lock: from here no posting can enter the day
      if (p.business_date !== bd) throw fail(409, 'STALE_BUSINESS_DATE', 'The business date has already moved on.');
      const open = await trx.selectFrom('cashier_session').select('id').where('property_id', '=', propertyId).where('status', '=', 'OPEN').executeTakeFirst();
      if (open) throw fail(409, 'AUDIT_BLOCKED', 'A cashier session was opened while the audit was running. Close it first.');
      const lines = await trx.selectFrom('reservation_room').select(['id', 'reservation_id']).where('property_id', '=', propertyId).where('status', '=', 'CHECKED_IN').where('arrival', '<=', bd).execute();
      for (const l of lines) await this.folios.postRoomNights(trx, propertyId, l, bd, userId);   // guests who checked in after the charge step
      await this.tax.catchUp(trx, propertyId, bd, userId);
      const prev = await trx.selectFrom('night_audit_run').select('completed_at').where('property_id', '=', propertyId).where('status', '=', 'COMPLETED').orderBy('business_date', 'desc').limit(1).executeTakeFirst();
      const run = await trx.selectFrom('night_audit_run').select('started_at').where('id', '=', runId).executeTakeFirstOrThrow();
      const since = prev?.completed_at ?? new Date(new Date(run.started_at).getTime() - 24 * 3_600_000);
      const snap = await this.snapshot(trx, propertyId, p.currency, bd, runId, since);
      const next = addDays(bd, 1);
      const rolled = await trx.updateTable('property').set({ business_date: next, version: sql`version + 1` as never }).where('id', '=', propertyId).where('business_date', '=', bd).returning('id').executeTakeFirst();   // compare-and-set
      if (!rolled) throw fail(409, 'STALE_BUSINESS_DATE', 'The business date has already moved on.');
      const horizon = await this.inv.ensureHorizon(trx, propertyId, next, addDays(next, HORIZON_DAYS));
      const hk = await this.hk.generateIn(trx, propertyId, userId);
      const summary = { businessDate: bd, nextBusinessDate: next, roomsSold: snap.roomsSold, roomsAvailable: snap.roomsAvailable, occupancyPct: snap.occupancyBp / 100, roomRevenue: fmt(snap.roomRevenue, p.currency), adr: fmt(snap.adr, p.currency),
        revPar: fmt(snap.revpar, p.currency), arrivals: snap.arrivals, departures: snap.departures, inHouse: snap.inHouse, noShows: snap.noShows, guestLedger: fmt(snap.guestLedger, p.currency), inventoryDaysAdded: horizon, housekeeping: hk, tax: fmt(snap.tax, p.currency) };
      await trx.updateTable('night_audit_step').set({ status: 'DONE', finished_at: new Date(this.clock.now()), result: JSON.stringify({ rolledTo: next, ...summary }) }).where('run_id', '=', runId).where('step_key', '=', 'CLOSE_DAY').execute();
      await trx.updateTable('night_audit_run').set({ status: 'COMPLETED', completed_at: new Date(this.clock.now()), updated_at: new Date(this.clock.now()), summary: JSON.stringify(summary), error: null }).where('id', '=', runId).execute();
      await this.audit.record(trx, { action: 'night_audit.complete', resourceType: 'night_audit_run', resourceId: runId, propertyId, after: summary });
      await this.outbox.publish(trx, { aggregateType: 'property', aggregateId: propertyId, eventType: 'NightAuditCompleted', propertyId, businessDate: bd, payload: { runId, ...summary } });
      await this.outbox.publish(trx, { aggregateType: 'property', aggregateId: propertyId, eventType: 'BusinessDateRolled', propertyId, businessDate: next, payload: { from: bd, to: next, runId } });
    });
  }

  // ───────────── the day's snapshot ─────────────
  private async snapshot(trx: Trx, propertyId: string, cur: string, bd: string, runId: string, since: Date) {
    const t = currentTenant().tenantId;
    const rooms = (await sql<{ total: number; ooo: number }>`SELECT count(*)::int AS total,
        (SELECT count(DISTINCT b.room_id)::int FROM room_block b JOIN room r2 ON r2.id = b.room_id WHERE b.tenant_id = ${t} AND b.property_id = ${propertyId} AND r2.status = 'ACTIVE' AND b.block_type = 'OUT_OF_ORDER' AND b.cancelled_at IS NULL AND ${bd}::date >= b.start_date AND ${bd}::date < b.end_date) AS ooo
      FROM room WHERE tenant_id = ${t} AND property_id = ${propertyId} AND status = 'ACTIVE'`.execute(trx)).rows[0]!;
    const available = rooms.total - rooms.ooo;
    const counts = (await sql<Record<string, number>>`SELECT
        (SELECT count(*)::int FROM reservation_room WHERE tenant_id = ${t} AND property_id = ${propertyId} AND status IN ('CHECKED_IN','CHECKED_OUT') AND arrival <= ${bd}::date AND departure > ${bd}::date) AS sold,
        (SELECT count(*)::int FROM reservation_room WHERE tenant_id = ${t} AND property_id = ${propertyId} AND checked_in_business_date = ${bd}::date) AS arrivals,
        (SELECT count(*)::int FROM reservation_room WHERE tenant_id = ${t} AND property_id = ${propertyId} AND checked_out_business_date = ${bd}::date) AS departures,
        (SELECT count(*)::int FROM reservation_room WHERE tenant_id = ${t} AND property_id = ${propertyId} AND status = 'CHECKED_IN') AS in_house,
        (SELECT count(*)::int FROM reservation_history WHERE tenant_id = ${t} AND property_id = ${propertyId} AND action = 'NO_SHOW' AND occurred_at > ${since}) AS no_shows,
        (SELECT count(*)::int FROM reservation_history WHERE tenant_id = ${t} AND property_id = ${propertyId} AND action = 'CANCEL' AND occurred_at > ${since}) AS cancellations`.execute(trx)).rows[0]!;
    const rev = await sql<{ txn_code: string; room_type_id: string | null; source: string | null; n: number; amount: string }>`
      SELECT p.txn_code, l.room_type_id, r.source, count(*)::int AS n, sum(p.amount_minor)::text AS amount
      FROM folio_posting p LEFT JOIN reservation_room l ON l.tenant_id = p.tenant_id AND l.id = p.reservation_room_id
        LEFT JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id LEFT JOIN reservation r ON r.tenant_id = f.tenant_id AND r.id = f.reservation_id
      WHERE p.tenant_id = ${t} AND p.property_id = ${propertyId} AND p.business_date = ${bd}::date AND p.payment_id IS NULL AND p.txn_code <> 'TAX' AND p.posting_type IN ('CHARGE','DISCOUNT','REVERSAL','ADJUSTMENT')
      GROUP BY p.txn_code, l.room_type_id, r.source ORDER BY p.txn_code`.execute(trx);
    let room = 0n, fees = 0n, other = 0n;
    for (const r of rev.rows) { const a = BigInt(r.amount); if (['ROOM', 'ROOM_EXTRAS', 'ROOM_DISCOUNT'].includes(r.txn_code)) room += a; else if (r.txn_code === 'CANCEL_FEE' || r.txn_code === 'NOSHOW_FEE') fees += a; else other += a; }
    const taxRows = await sql<{ tax_code: string; n: number; taxable: string; tax: string }>`SELECT tax_code, count(*)::int AS n, coalesce(sum(taxable_minor),0)::text AS taxable, coalesce(sum(amount_minor),0)::text AS tax FROM folio_posting
      WHERE tenant_id = ${t} AND property_id = ${propertyId} AND business_date = ${bd}::date AND tax_code IS NOT NULL GROUP BY tax_code ORDER BY tax_code`.execute(trx);
    const taxTotal = taxRows.rows.reduce((a, r) => a + BigInt(r.tax), 0n);
    const pay = await sql<{ txn_code: string; received: string }>`SELECT txn_code, (-sum(amount_minor))::text AS received FROM folio_posting WHERE tenant_id = ${t} AND property_id = ${propertyId} AND business_date = ${bd}::date
      AND (posting_type IN ('PAYMENT','DEPOSIT_RECEIVED','REFUND') OR (posting_type = 'REVERSAL' AND payment_id IS NOT NULL)) GROUP BY txn_code ORDER BY txn_code`.execute(trx);
    const ledger = (await sql<{ owed: string; held: string }>`SELECT coalesce(sum(balance_minor) FILTER (WHERE balance_minor > 0),0)::text AS owed, coalesce(-sum(balance_minor) FILTER (WHERE balance_minor < 0),0)::text AS held
      FROM folio WHERE tenant_id = ${t} AND property_id = ${propertyId} AND status = 'OPEN'`.execute(trx)).rows[0]!;
    const variance = (await sql<{ v: string }>`SELECT coalesce(sum(variance_minor),0)::text AS v FROM cashier_session WHERE tenant_id = ${t} AND property_id = ${propertyId} AND status IN ('CLOSED','REVIEWED') AND opened_business_date = ${bd}::date`.execute(trx)).rows[0]!;
    const sold = counts.sold ?? 0;
    const adr = sold > 0 ? (room + BigInt(sold) / 2n) / BigInt(sold) : 0n;
    const revpar = available > 0 ? (room + BigInt(available) / 2n) / BigInt(available) : 0n;
    const occ = available > 0 ? Math.round((sold * 10000) / available) : 0;

    const lists = {
      inHouse: (await sql`SELECT rm.number AS room, g.full_name AS guest, r.confirmation_no AS "confirmationNo", l.departure::text AS departure, f.balance_minor::text AS balance FROM reservation_room l JOIN reservation r ON r.id = l.reservation_id JOIN guest g ON g.id = r.guest_id
        LEFT JOIN room_assignment a ON a.assignment_ref = l.id AND a.status = 'IN_HOUSE' LEFT JOIN room rm ON rm.id = a.room_id LEFT JOIN folio f ON f.reservation_id = r.id AND f.folio_type = 'GUEST' AND f.status <> 'VOID'
        WHERE l.tenant_id = ${t} AND l.property_id = ${propertyId} AND l.status = 'CHECKED_IN' ORDER BY rm.number`.execute(trx)).rows,
      arrivals: (await sql`SELECT g.full_name AS guest, r.confirmation_no AS "confirmationNo", r.source FROM reservation_room l JOIN reservation r ON r.id = l.reservation_id JOIN guest g ON g.id = r.guest_id WHERE l.tenant_id = ${t} AND l.property_id = ${propertyId} AND l.checked_in_business_date = ${bd}::date ORDER BY r.confirmation_no`.execute(trx)).rows,
      departures: (await sql`SELECT g.full_name AS guest, r.confirmation_no AS "confirmationNo" FROM reservation_room l JOIN reservation r ON r.id = l.reservation_id JOIN guest g ON g.id = r.guest_id WHERE l.tenant_id = ${t} AND l.property_id = ${propertyId} AND l.checked_out_business_date = ${bd}::date ORDER BY r.confirmation_no`.execute(trx)).rows,
      noShows: (await sql`SELECT DISTINCT g.full_name AS guest, r.confirmation_no AS "confirmationNo" FROM reservation_history h JOIN reservation r ON r.id = h.reservation_id JOIN guest g ON g.id = r.guest_id WHERE h.tenant_id = ${t} AND h.property_id = ${propertyId} AND h.action = 'NO_SHOW' AND h.occurred_at > ${since}`.execute(trx)).rows,
      outstandingFolios: (await sql`SELECT f.folio_no AS "folioNo", r.confirmation_no AS "confirmationNo", g.full_name AS guest, f.balance_minor::text AS balance FROM folio f LEFT JOIN reservation r ON r.id = f.reservation_id LEFT JOIN guest g ON g.id = f.guest_id
        WHERE f.tenant_id = ${t} AND f.property_id = ${propertyId} AND f.status = 'OPEN' AND f.balance_minor <> 0 ORDER BY f.balance_minor DESC LIMIT 200`.execute(trx)).rows,
    };
    await trx.insertInto('daily_property_stats').values({ tenant_id: t, property_id: propertyId, business_date: bd, run_id: runId, currency: cur, rooms_total: rooms.total, rooms_out_of_order: rooms.ooo, rooms_available: available, rooms_sold: sold, occupancy_bp: occ,
      room_revenue_minor: room.toString(), fees_minor: fees.toString(), other_revenue_minor: other.toString(), adr_minor: adr.toString(), revpar_minor: revpar.toString(), arrivals: counts.arrivals ?? 0, departures: counts.departures ?? 0, in_house: counts.in_house ?? 0,
      no_shows: counts.no_shows ?? 0, cancellations: counts.cancellations ?? 0, guest_ledger_minor: ledger.owed, advance_deposits_minor: ledger.held, payments: JSON.stringify(Object.fromEntries(pay.rows.map((p) => [p.txn_code, p.received]))),
      cashier_variance_minor: variance.v, details: JSON.stringify({ ...lists, tax: taxRows.rows.map((r) => ({ code: r.tax_code, postings: r.n, taxable: r.taxable, tax: r.tax })) }), tax_minor: taxTotal.toString() } as never).execute();
    for (const r of taxRows.rows) await trx.insertInto('daily_revenue_line').values({ tenant_id: t, property_id: propertyId, business_date: bd, run_id: runId, txn_code: `TAX:${r.tax_code}`, room_type_id: null, source: null, posting_count: r.n, amount_minor: r.tax } as never).execute();
    for (const r of rev.rows) await trx.insertInto('daily_revenue_line').values({ tenant_id: t, property_id: propertyId, business_date: bd, run_id: runId, txn_code: r.txn_code, room_type_id: r.room_type_id, source: r.source, posting_count: r.n, amount_minor: r.amount } as never).execute();
    return { roomsSold: sold, roomsAvailable: available, occupancyBp: occ, roomRevenue: room, adr, revpar, arrivals: counts.arrivals ?? 0, departures: counts.departures ?? 0, inHouse: counts.in_house ?? 0, noShows: counts.no_shows ?? 0, guestLedger: BigInt(ledger.owed), tax: taxTotal };
  }

  // ───────────── reading ─────────────
  async runView(propertyId: string, runId: string) {
    return this.tdb.tx(async (trx) => {
      const run = await trx.selectFrom('night_audit_run').selectAll().where('id', '=', runId).where('property_id', '=', propertyId).executeTakeFirst();
      if (!run) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Night audit run not found' });
      const steps = await trx.selectFrom('night_audit_step').selectAll().where('run_id', '=', runId).orderBy('seq').execute();
      return { id: run.id, businessDate: run.business_date, status: run.status, startedBy: run.started_by, startedAt: run.started_at, completedAt: run.completed_at, resumedCount: run.resumed_count, overrides: run.overrides, error: run.error, summary: run.summary,
        steps: steps.map((s) => ({ key: s.step_key, status: s.status, attempts: s.attempts, startedAt: s.started_at, finishedAt: s.finished_at, result: s.result, error: s.error })) };
    });
  }
  async runs(propertyId: string, limit: number) {
    return this.tdb.tx(async (trx) => {
      await this.prop(trx, propertyId);
      const rows = await trx.selectFrom('night_audit_run').select(['id', 'business_date', 'status', 'started_at', 'completed_at', 'resumed_count', 'error']).where('property_id', '=', propertyId).orderBy('business_date', 'desc').orderBy('started_at', 'desc').limit(limit).execute();
      return { items: rows.map((r) => ({ id: r.id, businessDate: r.business_date, status: r.status, startedAt: r.started_at, completedAt: r.completed_at, resumedCount: r.resumed_count, error: r.error })) };
    });
  }
  async report(propertyId: string, date: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      const s = await trx.selectFrom('daily_property_stats').selectAll().where('property_id', '=', propertyId).where('business_date', '=', date).executeTakeFirst();
      if (!s) throw new NotFoundException({ code: 'NOT_FOUND', message: 'That day has not been closed yet' });
      const lines = await trx.selectFrom('daily_revenue_line as d').leftJoin('room_type as rt', 'rt.id', 'd.room_type_id').select(['d.txn_code', 'd.source', 'rt.code as room_type', 'd.posting_count', 'd.amount_minor']).where('d.property_id', '=', propertyId).where('d.business_date', '=', date).orderBy('d.txn_code').execute();
      const c = p.currency;
      return {
        businessDate: s.business_date, runId: s.run_id, generatedAt: s.generated_at,
        occupancy: { roomsTotal: s.rooms_total, outOfOrder: s.rooms_out_of_order, roomsAvailable: s.rooms_available, roomsSold: s.rooms_sold, occupancyPct: s.occupancy_bp / 100 },
        revenue: { room: fmt(s.room_revenue_minor, c), fees: fmt(s.fees_minor, c), other: fmt(s.other_revenue_minor, c), adr: fmt(s.adr_minor, c), revPar: fmt(s.revpar_minor, c), note: 'Revenue figures exclude tax.' },
        tax: { total: fmt(s.tax_minor, c), byCode: lines.filter((l) => l.txn_code.startsWith('TAX:')).map((l) => ({ code: l.txn_code.slice(4), postings: l.posting_count, tax: fmt(l.amount_minor, c) })) },
        movement: { arrivals: s.arrivals, departures: s.departures, inHouse: s.in_house, noShows: s.no_shows, cancellations: s.cancellations },
        ledger: { guestLedger: fmt(s.guest_ledger_minor, c), advanceDeposits: fmt(s.advance_deposits_minor, c) },
        paymentsByTender: Object.fromEntries(Object.entries(s.payments as Record<string, string>).map(([k, v]) => [k, fmt(v, c)])), cashierVariance: fmt(s.cashier_variance_minor, c),
        revenueLines: lines.filter((l) => !l.txn_code.startsWith('TAX:')).map((l) => ({ txnCode: l.txn_code, roomType: l.room_type, source: l.source, postings: l.posting_count, amount: fmt(l.amount_minor, c) })), lists: s.details,
      };
    });
  }
  async reports(propertyId: string, q: z.infer<typeof S.ReportsQuery>) {
    return this.tdb.tx(async (trx) => {
      const p = await this.prop(trx, propertyId);
      let b = trx.selectFrom('daily_property_stats').selectAll().where('property_id', '=', propertyId).orderBy('business_date', 'desc').limit(q.limit);
      if (q.from) b = b.where('business_date', '>=', q.from);
      if (q.to) b = b.where('business_date', '<=', q.to);
      const rows = await b.execute();
      return { items: rows.map((s) => ({ businessDate: s.business_date, roomsSold: s.rooms_sold, roomsAvailable: s.rooms_available, occupancyPct: s.occupancy_bp / 100, roomRevenue: fmt(s.room_revenue_minor, p.currency), adr: fmt(s.adr_minor, p.currency), revPar: fmt(s.revpar_minor, p.currency),
        arrivals: s.arrivals, departures: s.departures, inHouse: s.in_house, noShows: s.no_shows })) };
    });
  }
}
void ForbiddenException;
