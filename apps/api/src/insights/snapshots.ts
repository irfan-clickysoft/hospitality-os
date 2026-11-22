import { sql } from 'kysely';
import type { Trx } from './types.js';
import { addDays } from './util.js';
import { BUCKETS, MIN_SAMPLES, bucketOf } from './pace.js';

/** How many days ahead each night's forecast is kept. */
export const FORECAST_HORIZON_DAYS = 60;

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
  await saveForecast(trx, tenantId, propertyId, date);
  return { rows };
}

/**
 * Keeps the room-night forecast as it stood when `date` closed (the same method as the forecast report: nights on the books + the typical pickup for that distance, capped at sellable rooms),
 * for the next FORECAST_HORIZON_DAYS stay dates. Dates without enough history are not saved. Repeating a date replaces it.
 */
export async function saveForecast(trx: Trx, tenantId: string, propertyId: string, date: string): Promise<{ rows: number }> {
  await trx.deleteFrom('forecast_saved').where('property_id', '=', propertyId).where('made_on', '=', date).execute();
  const hist = await sql<{ lead: number; pickup: number }>`WITH h AS (SELECT snapshot_date AS sd, stay_date AS d, sum(rooms)::int AS otb FROM booking_snapshot WHERE tenant_id = ${tenantId} AND property_id = ${propertyId} AND stay_date BETWEEN ${addDays(date, -89)}::date AND ${date}::date AND snapshot_date <= stay_date GROUP BY 1, 2)
    SELECT (h.d - h.sd)::int AS lead, (s.rooms_sold - h.otb)::int AS pickup FROM h JOIN daily_property_stats s ON s.tenant_id = ${tenantId} AND s.property_id = ${propertyId} AND s.business_date = h.d WHERE h.sd < h.d`.execute(trx);
  const stats = BUCKETS.map(() => ({ n: 0, sum: 0 })); for (const x of hist.rows) { const b = bucketOf(x.lead); if (b >= 0) { stats[b]!.n++; stats[b]!.sum += x.pickup; } }
  const last = addDays(date, FORECAST_HORIZON_DAYS);
  const books = await sql<{ d: string; n: number; s: number }>`WITH d AS (SELECT generate_series(${addDays(date, 1)}::date, ${last}::date, '1 day')::date AS day)
    SELECT d.day::text AS d, coalesce((SELECT sum(rooms) FROM booking_snapshot WHERE tenant_id = ${tenantId} AND property_id = ${propertyId} AND snapshot_date = ${date}::date AND stay_date = d.day), 0)::int AS n,
      ((SELECT count(*) FROM room WHERE tenant_id = ${tenantId} AND property_id = ${propertyId} AND status = 'ACTIVE') - (SELECT count(DISTINCT b.room_id) FROM room_block b WHERE b.tenant_id = ${tenantId} AND b.property_id = ${propertyId} AND b.cancelled_at IS NULL AND b.start_date <= d.day AND b.end_date > d.day))::int AS s FROM d`.execute(trx);
  const out = [];
  for (const x of books.rows) {
    const lead = Math.round((Date.parse(x.d) - Date.parse(date)) / 86_400_000); const b = bucketOf(lead); const st = b >= 0 ? stats[b]! : { n: 0, sum: 0 };
    if (st.n < MIN_SAMPLES) continue;
    const avg = st.sum / st.n; out.push({ tenant_id: tenantId, property_id: propertyId, made_on: date, stay_date: x.d, lead, on_books: x.n, expected_pickup: String(Math.round(avg * 100) / 100), forecast_nights: Math.min(x.s, Math.max(0, Math.round(x.n + avg))), sellable: x.s, samples: st.n });
  }
  for (let i = 0; i < out.length; i += 500) await trx.insertInto('forecast_saved').values(out.slice(i, i + 500) as never).execute();
  return { rows: out.length };
}
