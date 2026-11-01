import { sql } from 'kysely';
import type { Trx } from './types.js';
import { addDays } from './util.js';

/** How far ahead the books are saved. */
export const SNAPSHOT_HORIZON_DAYS = 365;

/**
 * Saves how many room nights (and how much room revenue, excluding tax) were on the books for every coming stay date, by room type and channel, as at the close of `date`.
 * Safe to repeat: the same business date is replaced. The night audit calls this in the transaction that closes the day.
 */
export async function takeBookingSnapshot(trx: Trx, tenantId: string, propertyId: string, date: string, source: 'NIGHT_AUDIT' | 'MANUAL', userId: string | null): Promise<{ rows: number }> {
  await trx.deleteFrom('booking_snapshot').where('property_id', '=', propertyId).where('snapshot_date', '=', date).execute();
  const ins = await sql<{ n: number }>`WITH ins AS (
      INSERT INTO booking_snapshot (tenant_id, property_id, snapshot_date, stay_date, room_type_id, channel, rooms, revenue_minor, tentative, tentative_minor)
      SELECT ${tenantId}, ${propertyId}, ${date}::date, n.business_date, l.room_type_id, r.channel,
             count(*) FILTER (WHERE l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT'))::int, coalesce(sum(n.total_minor) FILTER (WHERE l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT')), 0),
             count(*) FILTER (WHERE l.status = 'OPTION')::int, coalesce(sum(n.total_minor) FILTER (WHERE l.status = 'OPTION'), 0)
      FROM stay_night n JOIN reservation_room l ON l.tenant_id = n.tenant_id AND l.id = n.reservation_room_id JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id
      WHERE n.tenant_id = ${tenantId} AND n.property_id = ${propertyId} AND n.business_date BETWEEN ${date}::date AND ${addDays(date, SNAPSHOT_HORIZON_DAYS)}::date AND l.status IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT','OPTION')
      GROUP BY n.business_date, l.room_type_id, r.channel RETURNING 1) SELECT count(*)::int AS n FROM ins`.execute(trx);
  const rows = ins.rows[0]?.n ?? 0;
  await sql`INSERT INTO booking_snapshot_run (tenant_id, property_id, snapshot_date, source, taken_by, horizon_days, rows) VALUES (${tenantId}, ${propertyId}, ${date}::date, ${source}, ${userId}, ${SNAPSHOT_HORIZON_DAYS}, ${rows})
    ON CONFLICT (tenant_id, property_id, snapshot_date) DO UPDATE SET source = EXCLUDED.source, taken_at = now(), taken_by = EXCLUDED.taken_by, horizon_days = EXCLUDED.horizon_days, rows = EXCLUDED.rows`.execute(trx);
  return { rows };
}
