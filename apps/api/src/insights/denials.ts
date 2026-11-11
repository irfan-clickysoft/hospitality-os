import { sql } from 'kysely';
import type { Def, Row } from './types.js';

const CH: Record<string, string> = { DIRECT: 'Direct', PHONE: 'Phone', WALKIN: 'Walk-in', WEBSITE: 'Website', OTA: 'Online travel agent', CORPORATE: 'Corporate', AGENT: 'Agent' };
export const denials: Def = {
  id: 'lost-business', name: 'Lost business and denials', category: 'sales', kind: 'analytical', permissions: ['reservation.view', 'report.view'], roles: ['manager'],
  purpose: 'Searches for dates where a room type was sold out: demand the property could not take, so the manager sees which dates and room types turn guests away.',
  basis: [{ id: 'searched', label: 'Date of the search' }, { id: 'arrival', label: 'Arrival date asked for' }], range: 'last30',
  params: [{ key: 'group', label: 'Group by', default: 'date', options: [{ value: 'date', label: 'Arrival date' }, { value: 'type', label: 'Room type' }, { value: 'channel', label: 'Channel' }, { value: 'list', label: 'Each search' }] }],
  definitions: [{ term: 'Denial', text: 'Someone at the desk (or the quote page) searched for dates where this room type had no room left. One line per person, dates, room type and day, so searching again does not count twice.' }, { term: 'Room nights asked for', text: 'Nights between arrival and departure for each denial. It is demand, not a lost sale: many of these guests book another room type or other dates.' }, { term: 'Value', text: 'Not estimated: the price the guest would have paid is not known.' }, { term: 'Recording starts', text: 'From the day this was introduced; earlier searches were not kept.' }],
  async run(c) {
    const col = c.basis === 'arrival' ? sql.raw('d.arrival') : sql.raw('d.searched_on');
    const r = await sql<Record<string, any>>`SELECT d.searched_on::text AS sd, d.arrival::text AS arrival, d.departure::text AS departure, (d.departure - d.arrival)::int AS nights, rt.name AS rtype, d.adults, d.children, d.channel, u.full_name AS who
      FROM quote_denial d JOIN room_type rt ON rt.id = d.room_type_id LEFT JOIN staff_user u ON u.id = d.user_id WHERE d.tenant_id = ${c.tenantId} AND d.property_id = ${c.propertyId} AND ${col} BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY d.arrival, rt.name`.execute(c.trx);
    const rows = r.rows; const g = c.params.group ?? 'date'; const nights = rows.reduce((s, x) => s + x.nights, 0);
    const top = (() => { const m = new Map<string, number>(); for (const x of rows) m.set(x.arrival, (m.get(x.arrival) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1])[0]; })();
    const kp = [{ key: 'n', label: 'Searches turned away', value: rows.length, type: 'int' as const, definition: 'Denials in the period.' }, { key: 'nights', label: 'Room nights asked for', value: nights, type: 'int' as const, definition: 'Nights across those searches.' }, { key: 'dates', label: 'Different arrival dates', value: new Set(rows.map((x) => x.arrival)).size, type: 'int' as const, definition: 'Distinct arrival dates asked for.' }, { key: 'top', label: 'Busiest arrival date', value: top ? `${top[0]} (${top[1]})` : '—', type: 'text' as const, definition: 'The arrival date turned away most often.' }];
    if (g === 'list') return { kpis: kp, columns: [{ key: 'sd', label: 'Searched', type: 'date' }, { key: 'arrival', label: 'Arrival', type: 'date' }, { key: 'departure', label: 'Departure', type: 'date', hidden: true }, { key: 'nights', label: 'Nights', type: 'int', total: true }, { key: 'rtype', label: 'Room type' }, { key: 'pax', label: 'Adults+children' }, { key: 'channel', label: 'Channel' }, { key: 'who', label: 'Searched by', hidden: true }],
      rows: rows.map((x): Row => ({ sd: x.sd, arrival: x.arrival, departure: x.departure, nights: x.nights, rtype: x.rtype, pax: `${x.adults}+${x.children}`, channel: CH[x.channel] ?? x.channel ?? '', who: x.who ?? '' })) };
    const map = new Map<string, { n: number; nights: number }>();
    for (const x of rows) { const k = g === 'type' ? x.rtype : g === 'channel' ? CH[x.channel] ?? x.channel ?? 'Not recorded' : x.arrival; const e = map.get(k) ?? { n: 0, nights: 0 }; e.n++; e.nights += x.nights; map.set(k, e); }
    const out: Row[] = [...map.entries()].sort((a, b) => (g === 'date' ? a[0].localeCompare(b[0]) : b[1].n - a[1].n)).map(([k, e]) => ({ what: k, n: e.n, nights: e.nights }));
    return { kpis: kp, rows: out, chart: { kind: g === 'date' ? 'line' : 'bar', x: 'what', series: [{ key: 'n', label: 'Searches turned away' }] }, columns: [{ key: 'what', label: g === 'type' ? 'Room type' : g === 'channel' ? 'Channel' : 'Arrival date', ...(g === 'date' ? { type: 'date' as const } : {}) }, { key: 'n', label: 'Searches turned away', type: 'int', total: true }, { key: 'nights', label: 'Room nights asked for', type: 'int', total: true }],
      notes: ['People who walked in, called or searched and left without a search at the desk are not recorded.'] };
  },
};
