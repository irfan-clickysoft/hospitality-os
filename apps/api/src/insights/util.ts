import { sql } from 'kysely';
import type { Ctx } from './types.js';

export const addDays = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
/** Minor units (a bigint string) as a decimal string with two places. */
export const dec = (m: string | number | bigint | null | undefined): string => { const n = BigInt(m ?? 0); const neg = n < 0n; const a = neg ? -n : n; return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`; };
export const big = (m: string | number | bigint | null | undefined): bigint => BigInt(m ?? 0);
/** A timestamp in the hotel's own time: 'YYYY-MM-DD HH:MM'. */
export const local = (col: ReturnType<typeof sql.raw>, c: Ctx) => sql`to_char(${col} AT TIME ZONE ${c.prop.timezone}, 'YYYY-MM-DD HH24:MI')`;
/** The room of a booking line: the latest one it was assigned. */
export const ROOM_OF = sql.raw(`(SELECT rm.number FROM room_assignment a JOIN room rm ON rm.id = a.room_id WHERE a.assignment_ref = l.id ORDER BY a.created_at DESC LIMIT 1)`);
export const ymd = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
