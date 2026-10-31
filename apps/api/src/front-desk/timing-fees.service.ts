import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { z } from 'zod';
import { Money } from '@hos/domain-types';
import type { DB } from '@hos/db';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import { TenantDb } from '../db/tenant-db.js';
import { FolioService, fmt } from '../folio/folio.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';
import { localHM, parseTimingRule, percentFor, toMinutes, type Kind } from './timing-fees.js';

type Trx = Transaction<DB>;
const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
const share = (total: bigint, percent: number): bigint => (total * BigInt(Math.round(percent * 100)) + 5000n) / 10000n;
const LABEL: Record<Kind, string> = { EARLY_CHECKIN: 'Early check-in', LATE_CHECKOUT: 'Late checkout' };
interface Line { id: string; reservation_id: string; arrival: string; departure: string; status: string }
interface Prop { business_date: string; timezone: string; check_in_time: string; check_out_time: string; timing_fee_rule: unknown; currency: string }

@Injectable()
export class TimingFeesService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(FolioService) private readonly folios: FolioService,
    @Inject(ReservationsService) private readonly res: ReservationsService, @Inject(CLOCK) private readonly clock: ClockLike) {}

  /** Whether this guest is early (before the standard check-in time on the arrival day) or late (after the standard checkout time on the departure day), by how much, and what the property's tiers suggest. */
  async info(trx: Trx, p: Prop, line: Line, kind: Kind) {
    const eligible = kind === 'EARLY_CHECKIN' ? line.status === 'CONFIRMED' && p.business_date === line.arrival : line.status === 'CHECKED_IN' && p.business_date === line.departure;
    const standard = (kind === 'EARLY_CHECKIN' ? p.check_in_time : p.check_out_time).slice(0, 5); const now = localHM(this.clock.now(), p.timezone);
    const minutes = kind === 'EARLY_CHECKIN' ? toMinutes(standard) - toMinutes(now) : toMinutes(now) - toMinutes(standard);
    const base = { kind, standardTime: standard, localTime: now, minutes: Math.max(0, minutes), applies: eligible && minutes > 0 };
    const decided = await trx.selectFrom('timing_fee_event').selectAll().where('reservation_room_id', '=', line.id).where('kind', '=', kind).executeTakeFirst();
    const req = await trx.selectFrom('guest_request').select(['needed_time', 'status']).where('reservation_id', '=', line.reservation_id).where('kind', '=', kind).orderBy('created_at', 'desc').executeTakeFirst();
    const night = await sql<{ n: string | null }>`SELECT total_minor::text AS n FROM stay_night WHERE reservation_room_id = ${line.id} ORDER BY business_date ${kind === 'EARLY_CHECKIN' ? sql.raw('ASC') : sql.raw('DESC')} LIMIT 1`.execute(trx);
    const nightMinor = BigInt(night.rows[0]?.n ?? 0); const rule = parseTimingRule(p.timing_fee_rule)[kind === 'EARLY_CHECKIN' ? 'early' : 'late'];
    const percent = base.applies ? percentFor(rule, minutes) : 0; const suggested = base.applies ? share(nightMinor, percent) : 0n;
    return { ...base, nightMinor, percent, suggestedMinor: suggested, requested: req ? { time: req.needed_time ? String(req.needed_time).slice(0, 5) : null, status: req.status } : null, decided, currency: p.currency };
  }

  private view(i: Awaited<ReturnType<TimingFeesService['info']>>) {
    return { kind: i.kind, applies: i.applies, standardTime: i.standardTime, localTime: i.localTime, minutes: i.minutes, percent: i.percent, night: fmt(i.nightMinor, i.currency), suggested: fmt(i.suggestedMinor, i.currency), requested: i.requested,
      required: i.applies && i.suggestedMinor > 0n && !i.decided, decided: i.decided ? { action: i.decided.action, charged: fmt(i.decided.charged_minor, i.currency), waived: fmt(i.decided.waived_minor, i.currency), reason: i.decided.reason, at: i.decided.created_at } : null };
  }

  private async loadLine(trx: Trx, propertyId: string, id: string, lineId: string) {
    const p = await trx.selectFrom('property').select(['business_date', 'timezone', 'check_in_time', 'check_out_time', 'timing_fee_rule', 'currency']).where('id', '=', propertyId).executeTakeFirst();
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
    const line = await trx.selectFrom('reservation_room').select(['id', 'reservation_id', 'arrival', 'departure', 'status']).where('id', '=', lineId).where('reservation_id', '=', id).where('property_id', '=', propertyId).executeTakeFirst();
    if (!line) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Room line not found on this reservation' });
    return { p: p as Prop, line: line as Line };
  }

  async get(propertyId: string, id: string, lineId: string, kind: Kind) {
    return this.tdb.tx(async (trx) => { const { p, line } = await this.loadLine(trx, propertyId, id, lineId); return this.view(await this.info(trx, p, line, kind)); });
  }

  /** Called by check-in and check-out: a fee the property's tiers suggest must be charged or waived (and recorded) first. */
  async require(trx: Trx, propertyId: string, line: Line, kind: Kind) {
    const p = (await trx.selectFrom('property').select(['business_date', 'timezone', 'check_in_time', 'check_out_time', 'timing_fee_rule', 'currency']).where('id', '=', propertyId).executeTakeFirstOrThrow()) as Prop;
    const i = await this.info(trx, p, line, kind);
    if (i.applies && i.suggestedMinor > 0n && !i.decided) throw fail(422, 'TIMING_FEE_DECISION_REQUIRED', `${LABEL[kind]}: ${i.minutes} minutes from the standard time (${i.standardTime}). Charge the fee or waive it with a reason first.`, { kind, minutes: i.minutes, suggested: fmt(i.suggestedMinor, i.currency) });
  }

  async decide(propertyId: string, id: string, lineId: string, userId: string, i: z.infer<typeof S.TimingFeeDecision>) {
    return this.tdb.tx(async (trx) => {
      const { p, line } = await this.loadLine(trx, propertyId, id, lineId); const x = await this.info(trx, p, line, i.kind);
      if (!x.applies) throw fail(409, 'NOT_APPLICABLE', i.kind === 'EARLY_CHECKIN' ? 'This guest is not arriving before the standard check-in time today.' : 'This guest is not leaving after the standard checkout time on the departure day.');
      if (x.decided) throw fail(409, 'ALREADY_DECIDED', 'This has already been charged or waived. A wrong charge is reversed on the guest bill.');
      let charged = 0n, waived = 0n, reason: string | null = i.reason ?? null;
      if (i.action === 'WAIVE') {
        await this.res.requirePermission(userId, 'reservation.waive_fee', propertyId); await this.res.requireFreshMfa();
        if (!reason || reason.length < 3) throw fail(422, 'REASON_REQUIRED', 'Give a reason for waiving the fee');
        waived = x.suggestedMinor;
      } else {
        charged = i.amount ? Money.parse(i.amount, p.currency).minor : x.suggestedMinor;
        if (charged <= 0n) throw fail(422, 'AMOUNT_INVALID', 'There is no fee to charge. Choose “No fee” and give a reason, or enter an amount.');
        if (charged !== x.suggestedMinor) { await this.res.requirePermission(userId, 'reservation.override_rate', propertyId); await this.res.requireFreshMfa(); if (!reason || reason.length < 3) throw fail(422, 'REASON_REQUIRED', 'Give a reason for charging a different amount'); }
        if (x.nightMinor > 0n && charged > x.nightMinor) throw fail(422, 'AMOUNT_INVALID', 'The fee cannot be more than the night’s price');
        waived = x.suggestedMinor > charged ? x.suggestedMinor - charged : 0n;
      }
      let postingId: string | null = null; const ev = crypto.randomUUID();
      if (charged > 0n) {
        await this.folios.ensureGuestFolio(trx, propertyId, id);                            // the bill is opened at check-in; an early fee is decided just before it
        const f = await trx.selectFrom('folio').select(['id', 'currency', 'status']).where('reservation_id', '=', id).where('folio_type', '=', 'GUEST').where('status', '<>', 'VOID').executeTakeFirst();
        if (!f) throw fail(409, 'NO_FOLIO', 'The booking has no guest bill'); if (f.status !== 'OPEN') throw fail(409, 'FOLIO_NOT_OPEN', 'The guest bill is closed');
        postingId = await this.folios.post(trx, { folioId: f.id, propertyId, currency: f.currency, type: 'CHARGE', txnCode: 'MISC', amount: charged, businessDate: p.business_date, sourceType: 'TIMING_FEE', sourceRef: ev, description: `${LABEL[i.kind]} fee (${x.minutes} min ${i.kind === 'EARLY_CHECKIN' ? 'early' : 'late'})`, userId, lineId });
      }
      await trx.insertInto('timing_fee_event').values({ tenant_id: currentTenant().tenantId, id: ev, property_id: propertyId, reservation_id: id, reservation_room_id: lineId, kind: i.kind, business_date: p.business_date, standard_time: x.standardTime, actual_time: x.localTime, minutes_off: x.minutes,
        requested_time: x.requested?.time ?? null, night_minor: x.nightMinor.toString(), suggested_percent: String(x.percent), suggested_minor: x.suggestedMinor.toString(), action: i.action, charged_minor: charged.toString(), waived_minor: waived.toString(), reason, posting_id: postingId, decided_by: userId } as never).execute();
      await this.audit.record(trx, { action: `frontdesk.timing_fee.${i.action.toLowerCase()}`, resourceType: 'reservation', resourceId: id, propertyId, after: { kind: i.kind, minutes: x.minutes, charged: charged.toString(), waived: waived.toString(), postingId }, note: reason ?? undefined });
      return { id: ev, charged: fmt(charged, p.currency), waived: fmt(waived, p.currency) };
    });
  }
}
