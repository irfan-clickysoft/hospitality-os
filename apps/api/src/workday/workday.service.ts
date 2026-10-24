import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Money } from '@hos/domain-types';
import { AuthorizationService } from '../authz/authorization.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { FolioService } from '../folio/folio.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';

export type Level = 'BLOCKER' | 'ACTION' | 'INFO';
export interface Blocker { code: string; level: Level; amount?: { amount: string; currency: string } }
const fmt = (m: bigint | string | number, cur: string) => ({ amount: Money.ofMinor(BigInt(m), cur).toDecimalString(), currency: cur });
const RANK: Record<Level, number> = { BLOCKER: 0, ACTION: 1, INFO: 2 };

export interface InboxItem { id: string; kind: string; level: Level; at: string | null; reservationId?: string; roomNumber?: string; guest?: string; amount?: { amount: string; currency: string }; count?: number; title?: string }

/**
 * The day's work for the front desk, and the shared inbox. Everything here is *derived* from records that already exist, so nothing can go out of step: a blocker disappears the moment
 * the thing it describes is fixed. Blockers are decided on the server so the screen can show them before anyone starts a long workflow.
 */
@Injectable()
export class WorkdayService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(FolioService) private readonly folios: FolioService, @Inject(AuthorizationService) private readonly authz: AuthorizationService) {}

  private async can(userId: string, permission: string, propertyId: string) { return (await this.authz.check(userId, { permission, scope: { propertyId } })).effect === 'ALLOW'; }

  async today(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId); const bd = p.business_date; const t = currentTenant().tenantId; const cur = p.currency;
      const arr = await sql<{ reservation_id: string; line_id: string; confirmation_no: string; status: string; guest: string; vip: boolean; do_not_rent: boolean; residency: string; source: string; at_risk: boolean; special: string | null; eta: string | null;
        type_code: string; type_name: string; arrival: string; departure: string; adults: number; children: number; room_id: string | null; room_no: string | null; hk: string | null; blocked: boolean; deposit_paid: string; deposit_required: string }>`
        SELECT r.id AS reservation_id, l.id AS line_id, r.confirmation_no, l.status, g.full_name AS guest, g.vip, g.do_not_rent, r.residency, r.source, r.at_risk, r.special_requests AS special, to_char(r.expected_arrival, 'HH24:MI') AS eta,
          rt.code AS type_code, rt.name AS type_name, l.arrival::text, l.departure::text, l.adults, l.children, rm.id AS room_id, rm.number AS room_no, rm.hk_status AS hk,
          (rm.id IS NOT NULL AND EXISTS (SELECT 1 FROM room_block b WHERE b.tenant_id = rm.tenant_id AND b.room_id = rm.id AND b.cancelled_at IS NULL AND b.start_date <= ${bd}::date AND b.end_date > ${bd}::date)) AS blocked,
          r.deposit_paid_minor::text AS deposit_paid, r.deposit_required_minor::text AS deposit_required
        FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id JOIN room_type rt ON rt.id = l.room_type_id
        LEFT JOIN room_assignment a ON a.assignment_ref = l.id AND a.status IN ('ASSIGNED','IN_HOUSE') LEFT JOIN room rm ON rm.id = a.room_id
        WHERE l.tenant_id = ${t} AND l.property_id = ${propertyId} AND l.arrival = ${bd}::date AND l.status IN ('CONFIRMED','CHECKED_IN') ORDER BY l.status DESC, g.full_name`.execute(trx);
      const dep = await sql<{ reservation_id: string; line_id: string; confirmation_no: string; status: string; guest: string; vip: boolean; type_code: string; arrival: string; departure: string; room_no: string | null; balance: string | null; folio_status: string | null }>`
        SELECT r.id AS reservation_id, l.id AS line_id, r.confirmation_no, l.status, g.full_name AS guest, g.vip, rt.code AS type_code, l.arrival::text, l.departure::text, rm.number AS room_no, f.balance_minor::text AS balance, f.status AS folio_status
        FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id JOIN room_type rt ON rt.id = l.room_type_id
        LEFT JOIN room_assignment a ON a.assignment_ref = l.id AND ((l.status = 'CHECKED_IN' AND a.status = 'IN_HOUSE') OR (l.status = 'CHECKED_OUT' AND a.status = 'ENDED' AND a.end_reason = 'CHECK_OUT')) LEFT JOIN room rm ON rm.id = a.room_id
        LEFT JOIN folio f ON f.tenant_id = r.tenant_id AND f.reservation_id = r.id AND f.folio_type = 'GUEST' AND f.status <> 'VOID'
        WHERE l.tenant_id = ${t} AND l.property_id = ${propertyId} AND ((l.status = 'CHECKED_IN' AND l.departure <= ${bd}::date) OR (l.status = 'CHECKED_OUT' AND l.checked_out_business_date = ${bd}::date))
        ORDER BY l.status DESC, l.departure, g.full_name`.execute(trx);
      const inHouse = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM reservation_room WHERE tenant_id = ${t} AND property_id = ${propertyId} AND status = 'CHECKED_IN'`.execute(trx)).rows[0]!.n;
      const noShows = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM reservation_room WHERE tenant_id = ${t} AND property_id = ${propertyId} AND status = 'CONFIRMED' AND arrival < ${bd}::date`.execute(trx)).rows[0]!.n;

      const arrivals = arr.rows.map((a) => {
        const blockers: Blocker[] = [];
        if (a.status === 'CONFIRMED') {
          if (a.do_not_rent) blockers.push({ code: 'GUEST_FLAGGED', level: 'BLOCKER' });
          if (!a.room_id) blockers.push({ code: 'NO_ROOM', level: 'ACTION' });
          else if (a.blocked) blockers.push({ code: 'ROOM_OUT_OF_SERVICE', level: 'BLOCKER' });
          else if (a.hk === 'DIRTY' || a.hk === 'CLEANING') blockers.push({ code: 'ROOM_NOT_READY', level: 'BLOCKER' });
          if (a.at_risk) blockers.push({ code: 'AT_RISK', level: 'ACTION' });
          if (a.residency === 'NON_RESIDENT') blockers.push({ code: 'PASSPORT_NEEDED', level: 'INFO' });
          if (a.special) blockers.push({ code: 'SPECIAL_REQUEST', level: 'INFO' });
        }
        blockers.sort((x, y) => RANK[x.level] - RANK[y.level]);
        return { reservationId: a.reservation_id, lineId: a.line_id, confirmationNo: a.confirmation_no, status: a.status, guest: { name: a.guest, vip: a.vip }, roomType: { code: a.type_code, name: a.type_name }, adults: a.adults, children: a.children,
          room: a.room_id ? { id: a.room_id, number: a.room_no!, hkStatus: a.hk! } : null, specialRequests: a.special, expectedArrival: a.eta, source: a.source, blockers, depositPaid: fmt(a.deposit_paid, cur), nights: Math.round((Date.parse(a.departure) - Date.parse(a.arrival)) / 86_400_000) };
      });
      const departures = dep.rows.map((d) => {
        const blockers: Blocker[] = []; const bal = BigInt(d.balance ?? '0');
        if (d.status === 'CHECKED_IN') {
          if (bal > 0n) blockers.push({ code: 'BALANCE_DUE', level: 'ACTION', amount: fmt(bal, cur) });
          if (bal < 0n) blockers.push({ code: 'OVERPAID', level: 'INFO', amount: fmt(-bal, cur) });
          if (d.departure < bd) blockers.push({ code: 'OVERDUE_DEPARTURE', level: 'ACTION' });
        }
        blockers.sort((x, y) => RANK[x.level] - RANK[y.level]);
        return { reservationId: d.reservation_id, lineId: d.line_id, confirmationNo: d.confirmation_no, status: d.status, guest: { name: d.guest, vip: d.vip }, roomType: { code: d.type_code }, room: d.room_no, departure: d.departure, balance: fmt(bal, cur), blockers };
      });
      const worst = (xs: Array<{ blockers: Blocker[] }>) => xs.filter((x) => x.blockers.some((b) => b.level !== 'INFO')).length;
      return { businessDate: bd, summary: { arrivalsPending: arrivals.filter((a) => a.status === 'CONFIRMED').length, arrivalsDone: arrivals.filter((a) => a.status === 'CHECKED_IN').length, departuresPending: departures.filter((d) => d.status === 'CHECKED_IN').length,
        departuresDone: departures.filter((d) => d.status === 'CHECKED_OUT').length, inHouse, noShowCandidates: noShows, arrivalsWithProblems: worst(arrivals.filter((a) => a.status === 'CONFIRMED')), departuresWithProblems: worst(departures.filter((d) => d.status === 'CHECKED_IN')) }, arrivals, departures };
    });
  }

  /** What is waiting on someone, drawn from the records themselves and limited to what this user may act on. Most urgent first. */
  async inbox(propertyId: string, userId: string) {
    const [seeRes, seeFolio, verify, compliance, maint] = await Promise.all(['reservation.view', 'folio.view', 'payment.verify', 'compliance.view', 'maintenance.view'].map((x) => this.can(userId, x, propertyId)));
    return this.tdb.tx(async (trx) => {
      const p = await this.folios.property(trx, propertyId); const bd = p.business_date; const t = currentTenant().tenantId; const cur = p.currency;
      const items: InboxItem[] = [];
      if (seeRes) {
        const today = await this.today(propertyId);
        for (const a of today.arrivals.filter((x) => x.status === 'CONFIRMED')) {
          for (const b of a.blockers.filter((x) => x.level !== 'INFO' && x.code !== 'AT_RISK')) items.push({ id: `${b.code}:${a.lineId}`, kind: b.code, level: b.level, at: null, reservationId: a.reservationId, roomNumber: a.room?.number, guest: a.guest.name });
          if (a.blockers.some((x) => x.code === 'AT_RISK')) items.push({ id: `AT_RISK:${a.lineId}`, kind: 'AT_RISK', level: 'ACTION', at: null, reservationId: a.reservationId, guest: a.guest.name });
        }
        for (const d of today.departures.filter((x) => x.status === 'CHECKED_IN')) {
          for (const b of d.blockers.filter((x) => x.level === 'ACTION')) if (b.code === 'OVERDUE_DEPARTURE' || seeFolio) items.push({ id: `${b.code}:${d.lineId}`, kind: b.code, level: b.level, at: null, reservationId: d.reservationId, roomNumber: d.room ?? undefined, guest: d.guest.name, amount: b.amount });
        }
        const answered = await sql<{ id: string; number: string; customer_name: string; status: string; responded_at: Date }>`SELECT id, number, customer_name, status, responded_at FROM quotation WHERE tenant_id = ${t} AND property_id = ${propertyId}
          AND status IN ('ACCEPTED','DECLINED') AND responded_at IS NOT NULL AND desk_seen_at IS NULL ORDER BY responded_at`.execute(trx);
        for (const x of answered.rows) items.push({ id: `QUOTATION_${x.status}:${x.id}`, kind: `QUOTATION_${x.status}`, level: x.status === 'ACCEPTED' ? 'ACTION' : 'INFO', at: x.responded_at.toISOString(), guest: x.customer_name, title: x.number });
        if (today.summary.noShowCandidates > 0) items.push({ id: 'NO_SHOWS', kind: 'NO_SHOW_CANDIDATES', level: 'ACTION', at: null, count: today.summary.noShowCandidates });
      }
      if (verify) {
        const rows = await sql<{ id: string; amount: string; method: string; created_at: Date; reservation_id: string | null; guest: string | null }>`
          SELECT p.id, p.amount_minor::text AS amount, p.method, p.created_at, f.reservation_id, g.full_name AS guest FROM payment p JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id
          LEFT JOIN reservation r ON r.tenant_id = f.tenant_id AND r.id = f.reservation_id LEFT JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id
          WHERE p.tenant_id = ${t} AND p.property_id = ${propertyId} AND p.status = 'PENDING_VERIFICATION' ORDER BY p.created_at`.execute(trx);
        for (const r of rows.rows) items.push({ id: `PAYMENT_TO_VERIFY:${r.id}`, kind: 'PAYMENT_TO_VERIFY', level: 'ACTION', at: r.created_at.toISOString(), reservationId: r.reservation_id ?? undefined, guest: r.guest ?? undefined, amount: fmt(r.amount, cur) });
      }
      if (compliance) {
        const n = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM compliance_task WHERE tenant_id = ${t} AND property_id = ${propertyId} AND status = 'OPEN'`.execute(trx)).rows[0]!.n;
        if (n > 0) items.push({ id: 'COMPLIANCE_TASKS', kind: 'COMPLIANCE_TASKS', level: 'ACTION', at: null, count: n });
        const r = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM charge_review WHERE tenant_id = ${t} AND property_id = ${propertyId} AND status = 'OPEN'`.execute(trx)).rows[0]!.n;
        if (r > 0) items.push({ id: 'CHARGE_REVIEWS', kind: 'CHARGE_REVIEWS', level: 'ACTION', at: null, count: r });
      }
      if (maint) {
        const rows = await sql<{ id: string; title: string; priority: number; room_no: string | null; created_at: Date; assigned_to: string | null }>`
          SELECT w.id, w.title, w.priority, rm.number AS room_no, w.created_at, w.assigned_to FROM work_order w LEFT JOIN room rm ON rm.id = w.room_id
          WHERE w.tenant_id = ${t} AND w.property_id = ${propertyId} AND w.status IN ('OPEN','ASSIGNED','IN_PROGRESS','WAITING') AND (w.priority <= 2 OR w.assigned_to = ${userId}) ORDER BY w.priority, w.created_at LIMIT 20`.execute(trx);
        for (const r of rows.rows) items.push({ id: `WORK_ORDER:${r.id}`, kind: r.assigned_to === userId ? 'WORK_ORDER_MINE' : 'WORK_ORDER_URGENT', level: r.priority === 1 ? 'BLOCKER' : 'ACTION', at: r.created_at.toISOString(), roomNumber: r.room_no ?? undefined, title: r.title });
      }
      items.sort((a, b) => RANK[a.level] - RANK[b.level]);
      return { businessDate: bd, summary: { blockers: items.filter((i) => i.level === 'BLOCKER').length, actions: items.filter((i) => i.level === 'ACTION').length, total: items.length }, items };
    });
  }
}
