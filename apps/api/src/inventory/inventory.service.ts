import { HttpException, Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { DB } from '@hos/db';
import { addDays, assertBusinessDate, nightsOf } from '@hos/domain-types';
import { currentTenant } from '../tenancy/tenant-context.js';

export const HORIZON_DAYS = 730;

export class AvailabilityError extends HttpException {
  constructor(readonly soldOutDates: string[]) {
    super({ code: 'AVAILABILITY_CHANGED', message: `No availability for: ${soldOutDates.join(', ')}`, soldOutDates }, 409);
  }
}
export class HorizonError extends HttpException {
  constructor(readonly missingDates: string[]) {
    super({ code: 'DATES_OUTSIDE_INVENTORY', message: `Inventory is not open for: ${missingDates.slice(0, 5).join(', ')}${missingDates.length > 5 ? '…' : ''}` }, 422);
  }
}
export class OversellError extends HttpException {
  constructor(readonly dates: string[], readonly reason: 'BLOCK' | 'CAPACITY') {
    super({ code: reason === 'BLOCK' ? 'BLOCK_CAUSES_OVERSELL' : 'CAPACITY_BELOW_RESERVED',
      message: `This change would leave more rooms sold than exist on: ${dates.slice(0, 5).join(', ')}${dates.length > 5 ? '…' : ''}. Move or cancel reservations first${reason === 'BLOCK' ? ', or acknowledge the oversell with approval' : ''}.`, dates }, 409);
  }
}

export interface NightAvailability {
  date: string; physical: number; outOfOrder: number; outOfService: number; blocked: number; reserved: number; held: number;
  overbookLimit: number; sellable: number; available: number;
}
export interface InvariantIssue { kind: 'PHYSICAL_MISMATCH' | 'BLOCK_MISMATCH' | 'GAP' | 'OVERSOLD' | 'RESERVED_MISMATCH' | 'HELD_MISMATCH' | 'ORPHAN_ASSIGNMENT'; roomTypeId: string; date?: string; detail: string }

const AVAIL_EXPR = sql`(physical - out_of_order - out_of_service - blocked - reserved - held + overbook_limit)`;
type Trx = Transaction<DB>;

/**
 * The ONLY writer of inventory_day. Every method must run inside the caller's transaction; throwing aborts the whole booking.
 * Availability = physical − out-of-order − out-of-service − blocked − reserved − held + overbook limit.
 * Writes are conditional atomic UPDATEs, and rows are locked in date order, so concurrent bookings can neither oversell nor deadlock.
 */
@Injectable()
export class InventoryService {
  private ids() { return currentTenant().tenantId; }

  /** Creates any missing inventory rows for [from, to). Idempotent. Counters start from the current rooms and blocks. */
  async ensureHorizon(trx: Trx, propertyId: string, from: string, to: string, roomTypeId?: string): Promise<number> {
    assertBusinessDate(from); assertBusinessDate(to);
    const t = this.ids();
    const r = await sql`
      INSERT INTO inventory_day (tenant_id, property_id, room_type_id, business_date, physical, out_of_order, out_of_service, overbook_limit)
      SELECT rt.tenant_id, rt.property_id, rt.id, d::date,
        (SELECT count(*) FROM room r WHERE r.tenant_id = rt.tenant_id AND r.room_type_id = rt.id AND r.status = 'ACTIVE'),
        (SELECT count(*) FROM room_block b JOIN room r ON r.tenant_id = b.tenant_id AND r.id = b.room_id
           WHERE b.tenant_id = rt.tenant_id AND r.room_type_id = rt.id AND b.block_type = 'OUT_OF_ORDER' AND b.cancelled_at IS NULL
             AND d::date >= b.start_date AND d::date < b.end_date AND r.status = 'ACTIVE'),
        (SELECT count(*) FROM room_block b JOIN room r ON r.tenant_id = b.tenant_id AND r.id = b.room_id
           WHERE b.tenant_id = rt.tenant_id AND r.room_type_id = rt.id AND b.block_type = 'OUT_OF_SERVICE' AND b.cancelled_at IS NULL
             AND d::date >= b.start_date AND d::date < b.end_date AND r.status = 'ACTIVE'),
        rt.default_overbook_limit
      FROM room_type rt
      CROSS JOIN generate_series(${from}::date, ${to}::date - 1, interval '1 day') AS d
      WHERE rt.tenant_id = ${t} AND rt.property_id = ${propertyId} AND rt.status = 'ACTIVE'
        ${roomTypeId ? sql`AND rt.id = ${roomTypeId}` : sql``}
      ON CONFLICT DO NOTHING`.execute(trx);
    return Number(r.numAffectedRows ?? 0);
  }

  /**
   * Re-derives `physical` for a room type from its ACTIVE rooms for all dates >= fromDate. Refuses (and the caller's transaction must
   * abort) if the new capacity would leave existing reservations oversold.
   */
  async recomputePhysical(trx: Trx, propertyId: string, roomTypeId: string, fromDate: string): Promise<void> {
    const t = this.ids();
    await sql`
      UPDATE inventory_day i SET
        physical = (SELECT count(*) FROM room r WHERE r.tenant_id = i.tenant_id AND r.room_type_id = i.room_type_id AND r.status = 'ACTIVE'),
        version = version + 1
      WHERE i.tenant_id = ${t} AND i.property_id = ${propertyId} AND i.room_type_id = ${roomTypeId} AND i.business_date >= ${fromDate}::date`.execute(trx);
    const bad = await sql<{ d: string }>`
      SELECT business_date::text AS d FROM inventory_day
      WHERE tenant_id = ${t} AND property_id = ${propertyId} AND room_type_id = ${roomTypeId} AND business_date >= ${fromDate}::date
        AND ${AVAIL_EXPR} < 0 AND (reserved + held) > 0 ORDER BY business_date`.execute(trx);
    if (bad.rows.length) throw new OversellError(bad.rows.map((r) => r.d), 'CAPACITY');
  }

  /** Atomically takes `rooms` units of a room type for every night in [arrival, departure). Throws AvailabilityError if any night is full. */
  async reserve(trx: Trx, a: { propertyId: string; roomTypeId: string; arrival: string; departure: string; rooms?: number }): Promise<void> {
    await this.adjust(trx, a, 'reserved', +1);
  }
  async release(trx: Trx, a: { propertyId: string; roomTypeId: string; arrival: string; departure: string; rooms?: number }): Promise<void> {
    await this.adjust(trx, a, 'reserved', -1);
  }
  /** Short-lived holds (booking-engine checkout, options). Same guarantees as reserve. */
  async hold(trx: Trx, a: { propertyId: string; roomTypeId: string; arrival: string; departure: string; rooms?: number }): Promise<void> {
    await this.adjust(trx, a, 'held', +1);
  }
  async releaseHold(trx: Trx, a: { propertyId: string; roomTypeId: string; arrival: string; departure: string; rooms?: number }): Promise<void> {
    await this.adjust(trx, a, 'held', -1);
  }

  private async adjust(trx: Trx, a: { propertyId: string; roomTypeId: string; arrival: string; departure: string; rooms?: number }, col: 'reserved' | 'held', dir: 1 | -1): Promise<void> {
    const rooms = a.rooms ?? 1;
    if (!Number.isInteger(rooms) || rooms < 1 || rooms > 100) throw new RangeError('rooms must be an integer between 1 and 100');
    const nights = nightsOf(a.arrival, a.departure);
    const t = this.ids();
    const colSql = sql.ref(col);
    // 1) lock the rows in date order (no deadlocks between overlapping stays)
    const locked = await sql<{ d: string }>`
      SELECT business_date::text AS d FROM inventory_day
      WHERE tenant_id = ${t} AND property_id = ${a.propertyId} AND room_type_id = ${a.roomTypeId}
        AND business_date >= ${a.arrival}::date AND business_date < ${a.departure}::date
      ORDER BY business_date FOR UPDATE`.execute(trx);
    if (locked.rows.length !== nights.length) {
      const have = new Set(locked.rows.map((r) => r.d));
      throw new HorizonError(nights.filter((n) => !have.has(n)));
    }
    // 2) conditional atomic update
    const upd = dir === 1
      ? await sql<{ d: string }>`
          UPDATE inventory_day SET ${colSql} = ${colSql} + ${rooms}, version = version + 1
          WHERE tenant_id = ${t} AND property_id = ${a.propertyId} AND room_type_id = ${a.roomTypeId}
            AND business_date >= ${a.arrival}::date AND business_date < ${a.departure}::date AND ${AVAIL_EXPR} >= ${rooms}
          RETURNING business_date::text AS d`.execute(trx)
      : await sql<{ d: string }>`
          UPDATE inventory_day SET ${colSql} = ${colSql} - ${rooms}, version = version + 1
          WHERE tenant_id = ${t} AND property_id = ${a.propertyId} AND room_type_id = ${a.roomTypeId}
            AND business_date >= ${a.arrival}::date AND business_date < ${a.departure}::date AND ${colSql} >= ${rooms}
          RETURNING business_date::text AS d`.execute(trx);
    if (upd.rows.length !== nights.length) {
      const ok = new Set(upd.rows.map((r) => r.d));
      const failed = nights.filter((n) => !ok.has(n));
      if (dir === 1) throw new AvailabilityError(failed);
      throw new HttpException({ code: 'INVENTORY_INCONSISTENT', message: `Cannot release ${col}; counters are lower than expected on ${failed.join(', ')}` }, 500);
    }
  }

  /**
   * Locks the inventory rows of several room types over [from, to) in a fixed order (date, then room type). Multi-step changes
   * (modify a stay, change room type) call this first so concurrent changes can never deadlock on each other.
   */
  async lockNights(trx: Trx, propertyId: string, roomTypeIds: string[], from: string, to: string): Promise<void> {
    const t = this.ids();
    await sql`
      SELECT 1 FROM inventory_day
      WHERE tenant_id = ${t} AND property_id = ${propertyId} AND room_type_id IN (${sql.join([...new Set(roomTypeIds)])})
        AND business_date >= ${from}::date AND business_date < ${to}::date
      ORDER BY business_date, room_type_id FOR UPDATE`.execute(trx);
  }

  /**
   * Applies +1 / −1 to the out-of-order or out-of-service counters for a room-type over [from, to).
   * Adding a block that would leave rooms sold beyond capacity is refused unless `allowOversell` (needs inventory.overbook, checked by the caller).
   */
  async applyBlock(trx: Trx, a: { propertyId: string; roomTypeId: string; type: 'OUT_OF_ORDER' | 'OUT_OF_SERVICE'; from: string; to: string; delta: 1 | -1; allowOversell?: boolean }): Promise<{ oversoldDates: string[] }> {
    const t = this.ids();
    const col = sql.ref(a.type === 'OUT_OF_ORDER' ? 'out_of_order' : 'out_of_service');
    const nights = nightsOf(a.from, a.to, 3660);
    const locked = await sql<{ d: string }>`
      SELECT business_date::text AS d FROM inventory_day
      WHERE tenant_id = ${t} AND property_id = ${a.propertyId} AND room_type_id = ${a.roomTypeId}
        AND business_date >= ${a.from}::date AND business_date < ${a.to}::date ORDER BY business_date FOR UPDATE`.execute(trx);
    if (locked.rows.length !== nights.length) {
      const have = new Set(locked.rows.map((r) => r.d));
      throw new HorizonError(nights.filter((n) => !have.has(n)));
    }
    await sql`
      UPDATE inventory_day SET ${col} = ${col} + ${a.delta}, version = version + 1
      WHERE tenant_id = ${t} AND property_id = ${a.propertyId} AND room_type_id = ${a.roomTypeId}
        AND business_date >= ${a.from}::date AND business_date < ${a.to}::date`.execute(trx);
    const over = await sql<{ d: string }>`
      SELECT business_date::text AS d FROM inventory_day
      WHERE tenant_id = ${t} AND property_id = ${a.propertyId} AND room_type_id = ${a.roomTypeId}
        AND business_date >= ${a.from}::date AND business_date < ${a.to}::date AND ${AVAIL_EXPR} < 0 AND (reserved + held) > 0 ORDER BY business_date`.execute(trx);
    const oversoldDates = over.rows.map((r) => r.d);
    if (a.delta === 1 && oversoldDates.length && !a.allowOversell) throw new OversellError(oversoldDates, 'BLOCK');
    return { oversoldDates: a.delta === 1 ? oversoldDates : [] };
  }

  async setOverbookLimit(trx: Trx, a: { propertyId: string; roomTypeId: string; from: string; to: string; limit: number }): Promise<number> {
    nightsOf(a.from, a.to, 3660);
    if (!Number.isInteger(a.limit) || a.limit < 0 || a.limit > 50) throw new RangeError('overbooking limit must be an integer between 0 and 50');
    const t = this.ids();
    // Lowering the limit below what is already sold is allowed (existing bookings stay), but never takes effect retroactively on them.
    const r = await sql`
      UPDATE inventory_day SET overbook_limit = ${a.limit}, version = version + 1
      WHERE tenant_id = ${t} AND property_id = ${a.propertyId} AND room_type_id = ${a.roomTypeId}
        AND business_date >= ${a.from}::date AND business_date < ${a.to}::date`.execute(trx);
    return Number(r.numAffectedRows ?? 0);
  }

  async getAvailability(trx: Trx, propertyId: string, from: string, to: string): Promise<Array<{ roomTypeId: string; code: string; name: string; nights: NightAvailability[] }>> {
    const t = this.ids();
    nightsOf(from, to, 400);
    const rows = await sql<{ room_type_id: string; code: string; name: string; d: string; physical: number; ooo: number; oos: number; blocked: number; reserved: number; held: number; ob: number }>`
      SELECT i.room_type_id, rt.code, rt.name, i.business_date::text AS d, i.physical, i.out_of_order AS ooo, i.out_of_service AS oos,
             i.blocked, i.reserved, i.held, i.overbook_limit AS ob
      FROM inventory_day i JOIN room_type rt ON rt.tenant_id = i.tenant_id AND rt.id = i.room_type_id
      WHERE i.tenant_id = ${t} AND i.property_id = ${propertyId} AND i.business_date >= ${from}::date AND i.business_date < ${to}::date
      ORDER BY rt.sort_order, rt.code, i.business_date`.execute(trx);
    const out = new Map<string, { roomTypeId: string; code: string; name: string; nights: NightAvailability[] }>();
    for (const r of rows.rows) {
      const g = out.get(r.room_type_id) ?? { roomTypeId: r.room_type_id, code: r.code, name: r.name, nights: [] };
      const sellable = r.physical - r.ooo - r.oos;
      g.nights.push({ date: r.d, physical: r.physical, outOfOrder: r.ooo, outOfService: r.oos, blocked: r.blocked, reserved: r.reserved, held: r.held,
        overbookLimit: r.ob, sellable, available: sellable - r.blocked - r.reserved - r.held + r.ob });
      out.set(r.room_type_id, g);
    }
    return [...out.values()];
  }

  /** Recomputes expected counters from source tables and reports drift. Run nightly and on demand; never silently repairs. */
  async checkInvariants(trx: Trx, propertyId: string): Promise<InvariantIssue[]> {
    const t = this.ids();
    const issues: InvariantIssue[] = [];
    const phys = await sql<{ room_type_id: string; d: string; have: number; want: number }>`
      SELECT i.room_type_id, i.business_date::text AS d, i.physical AS have,
        (SELECT count(*)::int FROM room r WHERE r.tenant_id = i.tenant_id AND r.room_type_id = i.room_type_id AND r.status = 'ACTIVE') AS want
      FROM inventory_day i WHERE i.tenant_id = ${t} AND i.property_id = ${propertyId}
      AND i.physical <> (SELECT count(*)::int FROM room r WHERE r.tenant_id = i.tenant_id AND r.room_type_id = i.room_type_id AND r.status = 'ACTIVE')
      ORDER BY i.business_date LIMIT 100`.execute(trx);
    for (const r of phys.rows) issues.push({ kind: 'PHYSICAL_MISMATCH', roomTypeId: r.room_type_id, date: r.d, detail: `physical=${r.have}, active rooms=${r.want}` });

    const blocks = await sql<{ room_type_id: string; d: string; kind: string; have: number; want: number }>`
      SELECT * FROM (
        SELECT i.room_type_id, i.business_date::text AS d, 'OUT_OF_ORDER' AS kind, i.out_of_order AS have,
          (SELECT count(*)::int FROM room_block b JOIN room r ON r.tenant_id = b.tenant_id AND r.id = b.room_id
             WHERE b.tenant_id = i.tenant_id AND r.room_type_id = i.room_type_id AND b.block_type = 'OUT_OF_ORDER' AND b.cancelled_at IS NULL
               AND i.business_date >= b.start_date AND i.business_date < b.end_date AND r.status = 'ACTIVE') AS want
        FROM inventory_day i WHERE i.tenant_id = ${t} AND i.property_id = ${propertyId}
        UNION ALL
        SELECT i.room_type_id, i.business_date::text, 'OUT_OF_SERVICE', i.out_of_service,
          (SELECT count(*)::int FROM room_block b JOIN room r ON r.tenant_id = b.tenant_id AND r.id = b.room_id
             WHERE b.tenant_id = i.tenant_id AND r.room_type_id = i.room_type_id AND b.block_type = 'OUT_OF_SERVICE' AND b.cancelled_at IS NULL
               AND i.business_date >= b.start_date AND i.business_date < b.end_date AND r.status = 'ACTIVE')
        FROM inventory_day i WHERE i.tenant_id = ${t} AND i.property_id = ${propertyId}
      ) x WHERE have <> want ORDER BY d LIMIT 100`.execute(trx);
    for (const r of blocks.rows) issues.push({ kind: 'BLOCK_MISMATCH', roomTypeId: r.room_type_id, date: r.d, detail: `${r.kind}: counter=${r.have}, blocks=${r.want}` });

    const gaps = await sql<{ room_type_id: string; missing: number }>`
      SELECT room_type_id, ((max(business_date) - min(business_date)) + 1 - count(*))::int AS missing
      FROM inventory_day WHERE tenant_id = ${t} AND property_id = ${propertyId} GROUP BY room_type_id
      HAVING ((max(business_date) - min(business_date)) + 1 - count(*)) > 0`.execute(trx);
    for (const r of gaps.rows) issues.push({ kind: 'GAP', roomTypeId: r.room_type_id, detail: `${r.missing} missing day(s) inside the open horizon` });

    const over = await sql<{ room_type_id: string; d: string; avail: number }>`
      SELECT room_type_id, business_date::text AS d, ${AVAIL_EXPR} AS avail FROM inventory_day
      WHERE tenant_id = ${t} AND property_id = ${propertyId} AND ${AVAIL_EXPR} < 0 AND (reserved + held) > 0 ORDER BY business_date LIMIT 100`.execute(trx);
    for (const r of over.rows) issues.push({ kind: 'OVERSOLD', roomTypeId: r.room_type_id, date: r.d, detail: `available=${r.avail}` });

    // reserved / held counters must equal what the reservation lines say (the source of truth), night by night
    const resv = await sql<{ room_type_id: string; d: string; col: string; have: number; want: number }>`
      SELECT * FROM (
        SELECT i.room_type_id, i.business_date::text AS d, 'reserved' AS col, i.reserved AS have,
          (SELECT count(*)::int FROM reservation_room rr WHERE rr.tenant_id = i.tenant_id AND rr.room_type_id = i.room_type_id AND rr.status IN ('CONFIRMED','CHECKED_IN')
             AND i.business_date >= rr.arrival AND i.business_date < rr.departure) AS want
        FROM inventory_day i WHERE i.tenant_id = ${t} AND i.property_id = ${propertyId}
        UNION ALL
        SELECT i.room_type_id, i.business_date::text, 'held', i.held,
          (SELECT count(*)::int FROM reservation_room rr WHERE rr.tenant_id = i.tenant_id AND rr.room_type_id = i.room_type_id AND rr.status = 'OPTION'
             AND i.business_date >= rr.arrival AND i.business_date < rr.departure)
        FROM inventory_day i WHERE i.tenant_id = ${t} AND i.property_id = ${propertyId}
      ) x WHERE have <> want ORDER BY d LIMIT 100`.execute(trx);
    for (const r of resv.rows) issues.push({ kind: r.col === 'reserved' ? 'RESERVED_MISMATCH' : 'HELD_MISMATCH', roomTypeId: r.room_type_id, date: r.d, detail: `${r.col} counter=${r.have}, reservation lines=${r.want}` });

    // every live assignment must belong to a live reservation line of the same room type, and cover its dates (an in-house guest who moved rooms holds the new room only for the rest of the stay)
    const orphans = await sql<{ id: string; room_type_id: string }>`
      SELECT a.id, r.room_type_id FROM room_assignment a JOIN room r ON r.tenant_id = a.tenant_id AND r.id = a.room_id
      WHERE a.tenant_id = ${t} AND a.property_id = ${propertyId} AND a.status IN ('ASSIGNED','IN_HOUSE')
        AND NOT EXISTS (SELECT 1 FROM reservation_room rr WHERE rr.tenant_id = a.tenant_id AND rr.id = a.assignment_ref AND rr.status IN ('CONFIRMED','CHECKED_IN','OPTION')
                        AND rr.room_type_id = r.room_type_id
                        AND ((a.status = 'ASSIGNED' AND daterange(rr.arrival, rr.departure) = a.stay_range)
                          OR (a.status = 'IN_HOUSE' AND upper(a.stay_range) = rr.departure AND a.stay_range <@ daterange(rr.arrival, rr.departure)))) LIMIT 100`.execute(trx);
    for (const o of orphans.rows) issues.push({ kind: 'ORPHAN_ASSIGNMENT', roomTypeId: o.room_type_id, detail: `assignment ${o.id} has no matching live reservation line` });
    return issues;
  }

  horizonEnd(fromDate: string): string { return addDays(fromDate, HORIZON_DAYS); }
}
