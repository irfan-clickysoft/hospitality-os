import { sql } from 'kysely';
import type { Def, Row } from './types.js';
import { dec, local } from './util.js';

const PERMS = ['fnb.manage', 'report.view'];
const mins = (ms: number | null) => (ms == null ? '' : String(Math.max(0, Math.round(ms / 60_000))));
const ODATE = sql.raw(`coalesce(o.business_date, (o.created_at AT TIME ZONE 'UTC')::date)`);

export const sales: Def = {
  id: 'fnb-sales', name: 'Food and beverage revenue', category: 'fnb', kind: 'financial', permissions: PERMS, roles: ['manager', 'accounts'],
  purpose: 'Food and beverage sales posted to guest bills, by outlet or by day, with the number of orders and the average order value.',
  basis: [{ id: 'business', label: 'Business date of the order' }], range: 'month',
  params: [{ key: 'group', label: 'Group by', default: 'outlet', options: [{ value: 'outlet', label: 'Outlet' }, { value: 'day', label: 'Day' }] }],
  definitions: [{ term: 'Sales', text: 'Delivered orders, before tax. Cancelled orders and orders not yet delivered are not sales.' }, { term: 'Average order value', text: 'Sales ÷ delivered orders.' }, { term: 'Cancelled', text: 'Orders cancelled before delivery, with their value, shown apart.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT coalesce(ou.name, 'No outlet') AS outlet, ${ODATE}::text AS d, o.status, count(*)::int AS n, coalesce(sum(o.total_minor), 0)::text AS amt
      FROM fnb_order o LEFT JOIN outlet ou ON ou.id = o.outlet_id WHERE o.tenant_id = ${c.tenantId} AND o.property_id = ${c.propertyId} AND ${ODATE} BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY 1, 2, 3`.execute(c.trx);
    const g = c.params.group ?? 'outlet'; const map = new Map<string, { n: number; amt: bigint; cn: number; ca: bigint; open: number }>();
    for (const x of r.rows) { const k = g === 'day' ? x.d : x.outlet; const e = map.get(k) ?? { n: 0, amt: 0n, cn: 0, ca: 0n, open: 0 }; if (x.status === 'DELIVERED') { e.n += x.n; e.amt += BigInt(x.amt); } else if (x.status === 'CANCELLED') { e.cn += x.n; e.ca += BigInt(x.amt); } else e.open += x.n; map.set(k, e); }
    const rows: Row[] = [...map.entries()].sort((a, b) => (g === 'day' ? a[0].localeCompare(b[0]) : a[1].amt < b[1].amt ? 1 : -1)).map(([k, e]) => ({ what: k, n: e.n, amt: e.amt.toString(), aov: e.n ? (e.amt / BigInt(e.n)).toString() : '0', open: e.open, cn: e.cn, ca: e.ca.toString() }));
    const tn = rows.reduce((s, x) => s + Number(x.n), 0); const ta = rows.reduce((s, x) => s + BigInt(x.amt as string), 0n);
    return { kpis: [{ key: 'amt', label: 'Sales', value: dec(ta), type: 'money', definition: 'Delivered orders, before tax.' }, { key: 'n', label: 'Delivered orders', value: tn, type: 'int', definition: 'Orders delivered in the period.' }, { key: 'aov', label: 'Average order value', value: tn ? dec(ta / BigInt(tn)) : '0.00', type: 'money', definition: 'Sales ÷ delivered orders.' }, { key: 'cn', label: 'Cancelled orders', value: rows.reduce((s, x) => s + Number(x.cn), 0), type: 'int', definition: 'Orders cancelled in the period.' }],
      columns: [{ key: 'what', label: g === 'day' ? 'Business date' : 'Outlet', ...(g === 'day' ? { type: 'date' as const } : {}) }, { key: 'n', label: 'Delivered orders', type: 'int', total: true }, { key: 'amt', label: 'Sales', type: 'money', total: true }, { key: 'aov', label: 'Average order', type: 'money' }, { key: 'open', label: 'Not delivered yet', type: 'int', total: true }, { key: 'cn', label: 'Cancelled', type: 'int', total: true }, { key: 'ca', label: 'Cancelled value', type: 'money', total: true, hidden: true }],
      rows, chart: { kind: g === 'day' ? 'line' : 'bar', x: 'what', series: [{ key: 'amt', label: 'Sales' }] }, notes: ['Orders are charged to guest bills; walk-in restaurant sales without a room are not recorded. Food cost and margin are in the Recipe cost and margin report.'] };
  },
};

export const items: Def = {
  id: 'fnb-items', name: 'Sales by category and item', category: 'fnb', kind: 'analytical', permissions: PERMS, roles: ['manager', 'accounts'],
  purpose: 'What sells: quantity and value by menu item or category, best sellers first.',
  basis: [{ id: 'business', label: 'Business date of the order' }], range: 'month',
  params: [{ key: 'group', label: 'Group by', default: 'item', options: [{ value: 'item', label: 'Item' }, { value: 'category', label: 'Category' }, { value: 'variant', label: 'Item and size' }] }],
  definitions: [{ term: 'Quantity and value', text: 'Delivered orders only, at the price charged, before tax.' }, { term: 'Share', text: 'This row’s share of total value.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT l.name, l.variant_name AS variant, coalesce(m.category, 'Not recorded') AS category, sum(l.quantity)::int AS qty, sum(l.line_minor)::text AS amt, count(DISTINCT o.id)::int AS orders
      FROM fnb_order_line l JOIN fnb_order o ON o.tenant_id = l.tenant_id AND o.id = l.order_id LEFT JOIN menu_item m ON m.id = l.menu_item_id WHERE o.tenant_id = ${c.tenantId} AND o.property_id = ${c.propertyId} AND o.status = 'DELIVERED' AND ${ODATE} BETWEEN ${c.from}::date AND ${c.to}::date GROUP BY 1, 2, 3`.execute(c.trx);
    const g = c.params.group ?? 'item'; const map = new Map<string, { cat: string; qty: number; amt: bigint; orders: number }>();
    for (const x of r.rows) { const k = g === 'category' ? x.category : g === 'variant' && x.variant ? `${x.name} (${x.variant})` : x.name; const e = map.get(k) ?? { cat: x.category, qty: 0, amt: 0n, orders: 0 }; e.qty += x.qty; e.amt += BigInt(x.amt); e.orders += x.orders; map.set(k, e); }
    const total = [...map.values()].reduce((s, e) => s + e.amt, 0n);
    const rows: Row[] = [...map.entries()].sort((a, b) => (a[1].amt < b[1].amt ? 1 : -1)).map(([k, e]) => ({ what: k, cat: e.cat, qty: e.qty, amt: e.amt.toString(), share: total > 0n ? Math.round(Number((e.amt * 1000n) / total)) / 10 : 0 }));
    return { kpis: [{ key: 'amt', label: 'Sales', value: dec(total), type: 'money', definition: 'Delivered orders, before tax.' }, { key: 'qty', label: 'Items sold', value: rows.reduce((s, x) => s + Number(x.qty), 0), type: 'int', definition: 'Total quantity.' }, { key: 'n', label: g === 'category' ? 'Categories' : 'Different items', value: rows.length, type: 'int', definition: 'Rows in the view.' }],
      columns: [{ key: 'what', label: g === 'category' ? 'Category' : 'Item' }, ...(g === 'category' ? [] : [{ key: 'cat', label: 'Category' }]), { key: 'qty', label: 'Quantity', type: 'int', total: true }, { key: 'amt', label: 'Value', type: 'money', total: true }, { key: 'share', label: 'Share', type: 'pct' }], rows, chart: { kind: 'bar', x: 'what', series: [{ key: 'amt', label: 'Value' }] },
      notes: ['Modifier and add-on performance is not broken out: modifiers are recorded on the order line but not summarised here.'] };
  },
};

export const orders: Def = {
  id: 'fnb-orders', name: 'Room-service orders and timing', category: 'fnb', kind: 'operational', permissions: PERMS, roles: ['manager', 'frontdesk'],
  purpose: 'Every order: room, guest, value, how long it took to prepare and deliver, and the orders still open or cancelled.',
  basis: [{ id: 'business', label: 'Date of the order' }], range: 'today',
  params: [{ key: 'view', label: 'Show', default: 'all', options: [{ value: 'all', label: 'All orders' }, { value: 'open', label: 'Open (not delivered)' }, { value: 'delayed', label: 'Delayed' }, { value: 'cancelled', label: 'Cancelled' }] }],
  definitions: [{ term: 'Prepare', text: 'Minutes from ordered until ready.' }, { term: 'Deliver', text: 'Minutes from ready until delivered.' }, { term: 'Total', text: 'Minutes from ordered until delivered.' }, { term: 'Delayed', text: 'Not delivered after 60 minutes, or delivered more than 60 minutes after it was ordered. The 60-minute limit is fixed for this report: no target is set per item.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT o.number, ${local(sql.raw('o.created_at'), c)} AS at, o.room_number AS room, o.guest_name AS guest, coalesce(ou.name, '') AS outlet, o.status, o.total_minor::text AS amt, o.cancel_reason, extract(epoch FROM (o.ready_at - o.created_at))*1000 AS prep, extract(epoch FROM (o.delivered_at - o.ready_at))*1000 AS deliv, extract(epoch FROM (o.delivered_at - o.created_at))*1000 AS tot, extract(epoch FROM (now() - o.created_at))*1000 AS age, o.reservation_id AS rid,
        (SELECT string_agg(l.quantity || ' × ' || l.name, ', ') FROM fnb_order_line l WHERE l.tenant_id = o.tenant_id AND l.order_id = o.id) AS what
      FROM fnb_order o LEFT JOIN outlet ou ON ou.id = o.outlet_id WHERE o.tenant_id = ${c.tenantId} AND o.property_id = ${c.propertyId} AND ${ODATE} BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY o.created_at DESC`.execute(c.trx);
    const S: Record<string, string> = { NEW: 'New', PREPARING: 'Preparing', READY: 'Ready', DELIVERED: 'Delivered', CANCELLED: 'Cancelled' }; const LIMIT = 60 * 60_000;
    let rows = r.rows.map((x) => ({ x, delayed: x.status === 'DELIVERED' ? Number(x.tot) > LIMIT : x.status === 'CANCELLED' ? false : Number(x.age) > LIMIT }));
    const v = c.params.view ?? 'all'; if (v === 'open') rows = rows.filter((y) => ['NEW', 'PREPARING', 'READY'].includes(y.x.status)); else if (v === 'delayed') rows = rows.filter((y) => y.delayed); else if (v === 'cancelled') rows = rows.filter((y) => y.x.status === 'CANCELLED');
    const done = rows.filter((y) => y.x.status === 'DELIVERED'); const avg = (k: string) => (done.length ? Math.round(done.reduce((s, y) => s + Number(y.x[k] ?? 0), 0) / done.length / 60_000) : 0);
    return { kpis: [{ key: 'n', label: 'Orders', value: rows.length, type: 'int', definition: 'Orders in the view.' }, { key: 'open', label: 'Open', value: rows.filter((y) => ['NEW', 'PREPARING', 'READY'].includes(y.x.status)).length, type: 'int', definition: 'Not delivered or cancelled.' }, { key: 'late', label: 'Delayed', value: rows.filter((y) => y.delayed).length, type: 'int', tone: rows.some((y) => y.delayed) ? 'warn' : 'ok', definition: 'Over 60 minutes.' }, { key: 'avg', label: 'Average total (min)', value: avg('tot'), type: 'int', definition: 'Ordered to delivered, for delivered orders.' }],
      columns: [{ key: 'no', label: 'Order' }, { key: 'at', label: 'Ordered', type: 'datetime' }, { key: 'room', label: 'Room' }, { key: 'guest', label: 'Guest' }, { key: 'outlet', label: 'Outlet', hidden: true }, { key: 'what', label: 'Items' }, { key: 'amt', label: 'Value', type: 'money', total: true }, { key: 'status', label: 'Status', type: 'badge' }, { key: 'prep', label: 'Prepare (min)', type: 'text' }, { key: 'deliv', label: 'Deliver (min)', type: 'text' }, { key: 'tot', label: 'Total (min)', type: 'text' }, { key: 'late', label: '', type: 'badge' }, { key: 'why', label: 'Cancel reason', hidden: true }],
      rows: rows.map(({ x, delayed }): Row => ({ _res: x.rid, no: x.number, at: x.at, room: x.room, guest: x.guest, outlet: x.outlet, what: x.what ?? '', amt: x.amt, status: S[x.status] ?? x.status, prep: mins(x.prep == null ? null : Number(x.prep)), deliv: mins(x.deliv == null ? null : Number(x.deliv)), tot: mins(x.tot == null ? null : Number(x.tot)), late: delayed ? 'Delayed' : '', why: x.cancel_reason ?? '' })),
      notes: ['Refunds on orders are handled on the guest bill and show in the Refunds, voids and adjustments report.'] };
  },
};

interface Ver { recipe: string; kind: string; yieldQty: number; menuPrice: bigint | null; lines: Array<{ stock: string | null; sub: string | null; qty: number; waste: number }> }
export const margin: Def = {
  id: 'recipe-margin', name: 'Recipe cost and food margin', category: 'fnb', kind: 'analytical', permissions: PERMS, roles: ['manager', 'accounts'],
  purpose: 'What each dish costs to make at today’s stock prices, against the menu price: cost per portion and margin.',
  basis: [{ id: 'now', label: 'Current recipes and stock prices' }], range: 'none',
  definitions: [{ term: 'Cost per portion', text: 'Ingredients at the current stock cost, with each ingredient bought up to cover its trim waste (quantity ÷ (1 − waste %)), ÷ portions the recipe makes. Sub-recipes are costed through.' }, { term: 'Margin', text: '(Menu price − cost) ÷ menu price. Ingredient cost only: labour, energy and overheads are not included.' }, { term: 'Uncosted', text: 'An ingredient with no stock cost is counted as zero and the dish is flagged.' }],
  async run(c) {
    const rv = await sql<Record<string, any>>`SELECT r.id, r.name, r.kind, v.id AS vid, v.yield_qty::float AS y, m.price_minor::text AS price FROM recipe r JOIN recipe_version v ON v.id = r.current_version_id LEFT JOIN menu_item m ON m.id = r.menu_item_id WHERE r.tenant_id = ${c.tenantId} AND r.property_id = ${c.propertyId} AND r.active`.execute(c.trx);
    const ln = await sql<Record<string, any>>`SELECT l.version_id, l.stock_item_id, l.sub_recipe_id, l.qty::float AS qty, l.waste_pct::float AS waste FROM recipe_line l JOIN recipe r ON r.current_version_id = l.version_id WHERE l.tenant_id = ${c.tenantId} AND r.property_id = ${c.propertyId}`.execute(c.trx);
    const st = await sql<Record<string, any>>`SELECT id, unit_cost_minor::float AS cost FROM stock_item WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId}`.execute(c.trx);
    const cost = new Map(st.rows.map((s) => [s.id as string, Number(s.cost)])); const byRecipe = new Map<string, Ver>(); const lines = new Map<string, Ver['lines']>();
    for (const l of ln.rows) lines.set(l.version_id, [...(lines.get(l.version_id) ?? []), { stock: l.stock_item_id, sub: l.sub_recipe_id, qty: Number(l.qty), waste: Number(l.waste) }]);
    for (const x of rv.rows) byRecipe.set(x.id, { recipe: x.name, kind: x.kind, yieldQty: Number(x.y) || 1, menuPrice: x.price == null ? null : BigInt(x.price), lines: lines.get(x.vid) ?? [] });
    const memo = new Map<string, { total: number; missing: boolean }>();
    const costOf = (id: string, depth = 0): { total: number; missing: boolean } => { const hit = memo.get(id); if (hit) return hit; const v = byRecipe.get(id); if (!v || depth > 5) return { total: 0, missing: true }; let total = 0; let missing = false;
      for (const l of v.lines) { const f = 1 / (1 - Math.min(l.waste, 95) / 100); if (l.stock) { const k = cost.get(l.stock); if (!k) missing = true; total += l.qty * f * (k ?? 0); } else if (l.sub) { const s = costOf(l.sub, depth + 1); const sv = byRecipe.get(l.sub); if (s.missing) missing = true; total += l.qty * f * (s.total / (sv?.yieldQty || 1)); } }
      const out = { total, missing }; memo.set(id, out); return out; };
    const rows: Row[] = [...byRecipe.entries()].filter(([, v]) => v.kind === 'DISH').map(([id, v]) => { const k = costOf(id); const per = Math.round(k.total / v.yieldQty); const price = v.menuPrice; return { dish: v.recipe, price: price?.toString() ?? '', cost: String(per), margin: price && price > 0n ? Math.round((1 - per / Number(price)) * 1000) / 10 : '', profit: price ? (price - BigInt(per)).toString() : '', flag: k.missing ? 'Some ingredients have no cost' : !price ? 'Not on the menu' : '' } as Row; }).sort((a, b) => Number(a.margin === '' ? 999 : a.margin) - Number(b.margin === '' ? 999 : b.margin));
    const withM = rows.filter((x) => x.margin !== ''); const avg = withM.length ? Math.round((withM.reduce((s, x) => s + Number(x.margin), 0) / withM.length) * 10) / 10 : 0;
    return { kpis: [{ key: 'n', label: 'Dishes costed', value: rows.length, type: 'int', definition: 'Dishes with an active recipe.' }, { key: 'avg', label: 'Average margin', value: avg, type: 'pct', definition: 'Mean margin of dishes on the menu.' }, { key: 'low', label: 'Below 50% margin', value: withM.filter((x) => Number(x.margin) < 50).length, type: 'int', tone: withM.some((x) => Number(x.margin) < 50) ? 'warn' : 'ok', definition: 'Dishes whose ingredient cost is over half the price.' }],
      columns: [{ key: 'dish', label: 'Dish' }, { key: 'price', label: 'Menu price', type: 'money' }, { key: 'cost', label: 'Cost per portion', type: 'money' }, { key: 'profit', label: 'Gross profit', type: 'money' }, { key: 'margin', label: 'Margin', type: 'pct' }, { key: 'flag', label: 'Check', type: 'badge' }], rows, notes: ['Lowest margin first. Costs use today’s stock prices, not the prices at the time of sale.'] };
  },
};

const UNIT = (u: string) => (u === 'pcs' ? 'pcs' : u === 'g' ? 'g' : 'ml');
export const stock: Def = {
  id: 'stock-on-hand', name: 'Stock on hand and reorder', category: 'inventory', kind: 'operational', permissions: PERMS, roles: ['manager', 'accounts'],
  purpose: 'What is in stock, what it is worth, and what is at or below its reorder level.',
  basis: [{ id: 'now', label: 'Current stock' }], range: 'none',
  params: [{ key: 'view', label: 'Show', default: 'all', options: [{ value: 'all', label: 'All stock' }, { value: 'reorder', label: 'Reorder now' }, { value: 'negative', label: 'Negative or empty' }] }],
  definitions: [{ term: 'Value', text: 'On hand × the current unit cost.' }, { term: 'Reorder now', text: 'On hand is at or below the reorder level.' }, { term: 'To order', text: 'Twice the reorder level minus on hand: a simple suggestion, not a purchase plan.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT name, unit, on_hand::float AS oh, reorder_level::float AS rl, unit_cost_minor::float AS cost FROM stock_item WHERE tenant_id = ${c.tenantId} AND property_id = ${c.propertyId} AND active ORDER BY name`.execute(c.trx);
    let rows = r.rows.map((x) => { const oh = Number(x.oh); const rl = x.rl == null ? null : Number(x.rl); const low = rl != null && oh <= rl; return { x, oh, rl, low }; });
    const v = c.params.view ?? 'all'; if (v === 'reorder') rows = rows.filter((y) => y.low); else if (v === 'negative') rows = rows.filter((y) => y.oh <= 0);
    const out: Row[] = rows.map(({ x, oh, rl, low }): Row => ({ name: x.name, unit: UNIT(x.unit), oh: String(Math.round(oh * 100) / 100), rl: rl == null ? '' : String(rl), cost: String(Math.round(Number(x.cost) * 100) / 100), value: String(Math.round(oh * Number(x.cost))), state: oh < 0 ? 'Negative' : oh === 0 ? 'Empty' : low ? 'Reorder' : 'OK', order: low && rl != null ? String(Math.max(0, Math.round(rl * 2 - oh))) : '' }));
    const total = rows.reduce((s, y) => s + Math.round(y.oh * Number(y.x.cost)), 0);
    return { kpis: [{ key: 'n', label: 'Stock items', value: out.length, type: 'int', definition: 'Items in the view.' }, { key: 'val', label: 'Stock value', value: dec(BigInt(total)), type: 'money', definition: 'On hand × unit cost.' }, { key: 'low', label: 'To reorder', value: rows.filter((y) => y.low).length, type: 'int', tone: rows.some((y) => y.low) ? 'warn' : 'ok', definition: 'At or below the reorder level.' }],
      columns: [{ key: 'name', label: 'Item' }, { key: 'unit', label: 'Unit' }, { key: 'oh', label: 'On hand', type: 'text' }, { key: 'rl', label: 'Reorder level', type: 'text' }, { key: 'order', label: 'To order', type: 'text' }, { key: 'cost', label: 'Cost per unit', type: 'money', hidden: true }, { key: 'value', label: 'Value', type: 'money', total: true }, { key: 'state', label: 'State', type: 'badge' }], rows: out,
      notes: ['Cost per unit is in the smallest money unit per gram, millilitre or piece. Expiry and batch tracking, purchase orders, goods received, vendors and stock transfers are not recorded yet.'] };
  },
};

export const movements: Def = {
  id: 'stock-movements', name: 'Stock movement, waste and variance', category: 'inventory', kind: 'audit', permissions: PERMS, roles: ['manager', 'accounts'],
  purpose: 'Every stock change: goods received, sales consumption, waste, and count adjustments (the variance found on counting), with who did it.',
  basis: [{ id: 'when', label: 'Date of the movement' }], range: 'month',
  params: [{ key: 'group', label: 'Group by', default: 'kind', options: [{ value: 'kind', label: 'Kind of movement' }, { value: 'item', label: 'Item' }, { value: 'list', label: 'Each movement' }, { value: 'waste', label: 'Waste only' }] }],
  definitions: [{ term: 'Receive', text: 'Goods received into stock.' }, { term: 'Sale', text: 'Stock used by recipes when orders were delivered.' }, { term: 'Waste', text: 'Stock thrown away or spoiled, with the note given.' }, { term: 'Adjust', text: 'A count correction: the difference between what was counted and what the system held. This is the variance.' }, { term: 'Value', text: 'Quantity × the item’s current unit cost. Receipts use the cost entered at receiving where there is one.' }],
  async run(c) {
    const r = await sql<Record<string, any>>`SELECT m.kind, s.name, s.unit, m.qty::float AS qty, coalesce(m.unit_cost_minor, s.unit_cost_minor)::float AS cost, m.note, ${local(sql.raw('m.created_at'), c)} AS at, u.full_name AS by FROM stock_movement m JOIN stock_item s ON s.id = m.item_id LEFT JOIN staff_user u ON u.id = m.created_by WHERE m.tenant_id = ${c.tenantId} AND m.property_id = ${c.propertyId} AND (m.created_at AT TIME ZONE ${c.prop.timezone})::date BETWEEN ${c.from}::date AND ${c.to}::date ORDER BY m.created_at DESC`.execute(c.trx);
    const K: Record<string, string> = { RECEIVE: 'Received', ADJUST: 'Count adjustment', WASTE: 'Waste', SALE: 'Used in sales' }; const val = (x: Record<string, any>) => Math.round(Number(x.qty) * Number(x.cost));
    const g = c.params.group ?? 'kind'; const waste = r.rows.filter((x) => x.kind === 'WASTE'); const adj = r.rows.filter((x) => x.kind === 'ADJUST');
    const kp = [{ key: 'n', label: 'Movements', value: r.rows.length, type: 'int' as const, definition: 'Stock changes in the period.' }, { key: 'w', label: 'Waste value', value: dec(BigInt(-waste.reduce((s, x) => s + val(x), 0))), type: 'money' as const, tone: waste.length ? ('warn' as const) : ('ok' as const), definition: 'Value of stock wasted.' }, { key: 'v', label: 'Count variance (net)', value: dec(BigInt(adj.reduce((s, x) => s + val(x), 0))), type: 'money' as const, definition: 'Net value of count adjustments; negative means less stock than the system held.' }];
    const rowOf = (x: Record<string, any>): Row => ({ at: x.at, kind: K[x.kind] ?? x.kind, name: x.name, qty: String(Math.round(Number(x.qty) * 100) / 100), unit: UNIT(x.unit), value: String(val(x)), note: x.note ?? '', by: x.by ?? '' });
    const dcols = [{ key: 'at', label: 'When', type: 'datetime' as const }, { key: 'kind', label: 'Movement', type: 'badge' as const }, { key: 'name', label: 'Item' }, { key: 'qty', label: 'Quantity', type: 'text' as const }, { key: 'unit', label: 'Unit' }, { key: 'value', label: 'Value', type: 'money' as const, total: true }, { key: 'note', label: 'Note' }, { key: 'by', label: 'By', hidden: true }];
    if (g === 'list') return { kpis: kp, columns: dcols, rows: r.rows.map(rowOf) };
    if (g === 'waste') return { kpis: kp, columns: dcols, rows: waste.map(rowOf) };
    const map = new Map<string, { n: number; rec: number; sale: number; waste: number; adj: number }>(); for (const x of r.rows) { const k = g === 'item' ? x.name : K[x.kind] ?? x.kind; const e = map.get(k) ?? { n: 0, rec: 0, sale: 0, waste: 0, adj: 0 }; e.n++; const v = val(x); if (x.kind === 'RECEIVE') e.rec += v; else if (x.kind === 'SALE') e.sale += v; else if (x.kind === 'WASTE') e.waste += v; else e.adj += v; map.set(k, e); }
    return { kpis: kp, columns: [{ key: 'what', label: g === 'item' ? 'Item' : 'Movement' }, { key: 'n', label: 'Movements', type: 'int', total: true }, { key: 'rec', label: 'Received', type: 'money', total: true }, { key: 'sale', label: 'Used in sales', type: 'money', total: true }, { key: 'waste', label: 'Waste', type: 'money', total: true }, { key: 'adj', label: 'Count adjustments', type: 'money', total: true }], rows: [...map.entries()].map(([k, e]): Row => ({ what: k, n: e.n, rec: String(e.rec), sale: String(e.sale), waste: String(e.waste), adj: String(e.adj) })).sort((a, b) => Number(b.n) - Number(a.n)),
      notes: ['Theoretical versus actual consumption is the gap between “used in sales” and what the counts show. Expiry, purchase orders and vendor performance are not recorded yet.'] };
  },
};
