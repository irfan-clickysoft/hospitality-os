import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Money, addDays } from '@hos/domain-types';
import { ArService } from '../companies/ar.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';

const fmt = (m: bigint | string | number, cur = 'PKR') => ({ amount: Money.ofMinor(BigInt(m), cur).toDecimalString(), currency: cur });
const pct = (num: bigint | number, den: bigint | number) => (Number(den) > 0 ? Math.round((Number(num) * 10000) / Number(den)) / 100 : 0);
const div = (a: bigint, b: bigint) => (b > 0n ? (a + b / 2n) / b : 0n);

/** The owner's view: snapshot-based (the closed days never change) with live tiles for today. Read-only. */
@Injectable()
export class ManagementService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(ArService) private readonly ar: ArService,
  ) {}

  async overview(userId: string, fromIn?: string, toIn?: string) {
    const props = await this.tdb.tx(async (trx) => (await trx.selectFrom('property').select(['id', 'code', 'name', 'currency', 'business_date', 'status']).where('status', '<>', 'ARCHIVED').orderBy('name').execute()));
    const allowed: typeof props = [];
    for (const p of props) if ((await this.authz.check(userId, { permission: 'management.view', scope: { propertyId: p.id } })).effect === 'ALLOW') allowed.push(p);
    if (!allowed.length) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'This action needs the "management.view" permission' });
    const tenantWide = allowed.length === props.length;
    const ids = allowed.map((p) => p.id);
    const latest = allowed.map((p) => p.business_date).sort().reverse()[0]!;
    const to = toIn ?? addDays(latest, -1);
    const from = fromIn ?? addDays(to, -13);
    const t = currentTenant().tenantId;
    const cur = allowed[0]!.currency;

    return this.tdb.tx(async (trx) => {
      const stats = await sql<{ property_id: string; d: string; sold: number; avail: number; rev: string; fees: string; other: string; tax: string; ns: number; cx: number; occ: number }>`
        SELECT property_id, business_date::text AS d, rooms_sold AS sold, rooms_available AS avail, room_revenue_minor::text AS rev, fees_minor::text AS fees, other_revenue_minor::text AS other, tax_minor::text AS tax, no_shows AS ns, cancellations AS cx, occupancy_bp AS occ
        FROM daily_property_stats WHERE tenant_id = ${t} AND property_id = ANY(${ids}::uuid[]) AND business_date BETWEEN ${from}::date AND ${to}::date ORDER BY business_date`.execute(trx);
      const live = await sql<{ property_id: string; arrivals: number; departures: number; in_house: number; rooms: number; ooo: number }>`
        SELECT p.id AS property_id,
          (SELECT count(*) FROM reservation_room l WHERE l.tenant_id = p.tenant_id AND l.property_id = p.id AND l.status = 'CONFIRMED' AND l.arrival = p.business_date)::int AS arrivals,
          (SELECT count(*) FROM reservation_room l WHERE l.tenant_id = p.tenant_id AND l.property_id = p.id AND l.status = 'CHECKED_IN' AND l.departure = p.business_date)::int AS departures,
          (SELECT count(*) FROM reservation_room l WHERE l.tenant_id = p.tenant_id AND l.property_id = p.id AND l.status = 'CHECKED_IN')::int AS in_house,
          (SELECT count(*) FROM room r WHERE r.tenant_id = p.tenant_id AND r.property_id = p.id AND r.status = 'ACTIVE')::int AS rooms,
          (SELECT count(DISTINCT b.room_id) FROM room_block b WHERE b.tenant_id = p.tenant_id AND b.property_id = p.id AND b.cancelled_at IS NULL AND b.start_date <= p.business_date AND b.end_date > p.business_date)::int AS ooo
        FROM property p WHERE p.tenant_id = ${t} AND p.id = ANY(${ids}::uuid[])`.execute(trx);
      const upcoming = await sql<{ property_id: string; lines: number; nights: number; value: string; risk_lines: number; risk_value: string }>`
        SELECT l.property_id, count(*)::int AS lines, coalesce(sum(l.departure - l.arrival),0)::int AS nights, coalesce(sum(l.total_minor),0)::text AS value,
          (count(*) FILTER (WHERE r.at_risk))::int AS risk_lines, coalesce(sum(l.total_minor) FILTER (WHERE r.at_risk),0)::text AS risk_value
        FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN property p ON p.tenant_id = l.tenant_id AND p.id = l.property_id
        WHERE l.tenant_id = ${t} AND l.property_id = ANY(${ids}::uuid[]) AND l.status = 'CONFIRMED' AND l.arrival >= p.business_date AND l.arrival < p.business_date + 14 GROUP BY l.property_id`.execute(trx);
      const bySource = await sql<{ source: string | null; amt: string }>`
        SELECT coalesce(source,'UNKNOWN') AS source, sum(amount_minor)::text AS amt FROM daily_revenue_line WHERE tenant_id = ${t} AND property_id = ANY(${ids}::uuid[]) AND business_date BETWEEN ${from}::date AND ${to}::date GROUP BY 1 ORDER BY sum(amount_minor) DESC`.execute(trx);
      const byCompany = await sql<{ company_id: string | null; name: string | null; amt: string }>`
        SELECT r.company_id, c.name, sum(p.amount_minor)::text AS amt FROM folio_posting p JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id JOIN reservation r ON r.tenant_id = f.tenant_id AND r.id = f.reservation_id
        LEFT JOIN company c ON c.tenant_id = r.tenant_id AND c.id = r.company_id
        WHERE p.tenant_id = ${t} AND p.property_id = ANY(${ids}::uuid[]) AND p.business_date BETWEEN ${from}::date AND ${to}::date AND r.company_id IS NOT NULL AND p.payment_id IS NULL
          AND p.txn_code NOT IN ('TAX','AR_TRANSFER','OTA_TRANSFER') AND p.posting_type IN ('CHARGE','DISCOUNT','REVERSAL','ADJUSTMENT') GROUP BY r.company_id, c.name HAVING sum(p.amount_minor) <> 0 ORDER BY sum(p.amount_minor) DESC LIMIT 10`.execute(trx);
      const cash = await sql<{ property_id: string; open_n: number; review_n: number; variance: string }>`
        SELECT property_id, (count(*) FILTER (WHERE status = 'OPEN'))::int AS open_n, (count(*) FILTER (WHERE status = 'CLOSED'))::int AS review_n,
          coalesce(sum(variance_minor) FILTER (WHERE status IN ('CLOSED','REVIEWED') AND opened_business_date BETWEEN ${from}::date AND ${to}::date),0)::text AS variance
        FROM cashier_session WHERE tenant_id = ${t} AND property_id = ANY(${ids}::uuid[]) GROUP BY property_id`.execute(trx);
      const pend = await sql<{ property_id: string; n: number; amt: string }>`
        SELECT property_id, count(*)::int AS n, coalesce(sum(amount_minor),0)::text AS amt FROM payment WHERE tenant_id = ${t} AND property_id = ANY(${ids}::uuid[]) AND status = 'PENDING_VERIFICATION' GROUP BY property_id`.execute(trx);
      const issues = await sql<{ property_id: string; n: number; oldest_h: number | null }>`
        SELECT property_id, count(*)::int AS n, max(extract(epoch FROM (now() - created_at)) / 3600)::int AS oldest_h FROM room_issue WHERE tenant_id = ${t} AND property_id = ANY(${ids}::uuid[]) AND status = 'OPEN' GROUP BY property_id`.execute(trx);
      const prot = await sql<{ property_id: string; ota_future: number; ota_guaranteed: number; ota_risk: number; ota_created: number; ota_deposit: number; fee_net: string }>`
        SELECT p.id AS property_id,
          (SELECT count(*) FROM reservation r WHERE r.tenant_id = p.tenant_id AND r.property_id = p.id AND r.source = 'OTA_BOOKING_COM' AND r.status = 'CONFIRMED')::int AS ota_future,
          (SELECT count(*) FROM reservation r WHERE r.tenant_id = p.tenant_id AND r.property_id = p.id AND r.source = 'OTA_BOOKING_COM' AND r.status = 'CONFIRMED' AND r.guarantee_type = 'DEPOSIT')::int AS ota_guaranteed,
          (SELECT count(*) FROM reservation r WHERE r.tenant_id = p.tenant_id AND r.property_id = p.id AND r.source = 'OTA_BOOKING_COM' AND r.status = 'CONFIRMED' AND r.at_risk)::int AS ota_risk,
          (SELECT count(*) FROM reservation r WHERE r.tenant_id = p.tenant_id AND r.property_id = p.id AND r.source = 'OTA_BOOKING_COM' AND r.created_at::date BETWEEN ${from}::date AND ${to}::date)::int AS ota_created,
          (SELECT count(*) FROM reservation r WHERE r.tenant_id = p.tenant_id AND r.property_id = p.id AND r.source = 'OTA_BOOKING_COM' AND r.created_at::date BETWEEN ${from}::date AND ${to}::date AND r.guarantee_type = 'DEPOSIT')::int AS ota_deposit,
          coalesce((SELECT sum(x.amount_minor) FROM folio_posting x WHERE x.tenant_id = p.tenant_id AND x.property_id = p.id AND x.business_date BETWEEN ${from}::date AND ${to}::date AND x.txn_code IN ('CANCEL_FEE','NOSHOW_FEE') AND x.posting_type IN ('CHARGE','REVERSAL')),0)::text AS fee_net
        FROM property p WHERE p.tenant_id = ${t} AND p.id = ANY(${ids}::uuid[])`.execute(trx);
      const otaRec = await sql<{ property_id: string; open_amt: string; written: string }>`
        SELECT r.property_id, coalesce(sum(r.amount_minor - r.received_minor - r.written_off_minor) FILTER (WHERE r.status IN ('CLAIMABLE','CLAIMED','DISPUTED')),0)::text AS open_amt,
          coalesce((SELECT sum(e.amount_minor) FROM ota_receivable_event e JOIN ota_receivable x ON x.tenant_id = e.tenant_id AND x.id = e.receivable_id WHERE e.tenant_id = r.tenant_id AND x.property_id = r.property_id AND e.action = 'WRITE_OFF' AND e.business_date BETWEEN ${from}::date AND ${to}::date),0)::text AS written
        FROM ota_receivable r WHERE r.tenant_id = ${t} AND r.property_id = ANY(${ids}::uuid[]) GROUP BY r.tenant_id, r.property_id`.execute(trx);
      const arPending = await sql<{ n: number; amt: string }>`SELECT count(*)::int AS n, coalesce(sum(amount_minor),0)::text AS amt FROM ar_receipt WHERE tenant_id = ${t} AND status = 'PENDING_VERIFICATION'`.execute(trx);
      const taxDrafts = tenantWide ? (await sql<{ n: number }>`SELECT count(*)::int AS n FROM tax_code_version WHERE tenant_id = ${t} AND status = 'DRAFT'`.execute(trx)).rows[0]!.n : 0;

      const byProp = new Map(allowed.map((p) => [p.id, p]));
      const per = allowed.map((p) => {
        const rows = stats.rows.filter((r) => r.property_id === p.id);
        const sold = rows.reduce((a, r) => a + r.sold, 0), avail = rows.reduce((a, r) => a + r.avail, 0);
        const rev = rows.reduce((a, r) => a + BigInt(r.rev), 0n), fees = rows.reduce((a, r) => a + BigInt(r.fees), 0n), other = rows.reduce((a, r) => a + BigInt(r.other), 0n), tax = rows.reduce((a, r) => a + BigInt(r.tax), 0n);
        const lv = live.rows.find((r) => r.property_id === p.id)!; const up = upcoming.rows.find((r) => r.property_id === p.id);
        const cs = cash.rows.find((r) => r.property_id === p.id); const pd = pend.rows.find((r) => r.property_id === p.id); const is = issues.rows.find((r) => r.property_id === p.id); const pr = prot.rows.find((r) => r.property_id === p.id)!;
        return {
          id: p.id, code: p.code, name: p.name, businessDate: p.business_date, closedDays: rows.length,
          period: { occupancyPct: pct(sold, avail), roomsSold: sold, roomsAvailable: avail, roomRevenue: fmt(rev, p.currency), adr: fmt(div(rev, BigInt(sold)), p.currency), revPar: fmt(div(rev, BigInt(avail)), p.currency),
            fees: fmt(fees, p.currency), otherRevenue: fmt(other, p.currency), tax: fmt(tax, p.currency), noShows: rows.reduce((a, r) => a + r.ns, 0), cancellations: rows.reduce((a, r) => a + r.cx, 0) },
          trend: rows.map((r) => ({ date: r.d, occupancyPct: r.occ / 100, roomRevenue: fmt(r.rev, p.currency) })),
          today: { arrivals: lv.arrivals, departures: lv.departures, inHouse: lv.in_house, rooms: lv.rooms, outOfOrder: lv.ooo, occupancyPct: pct(lv.in_house, Math.max(lv.rooms - lv.ooo, 0)) },
          upcoming: { reservations: up?.lines ?? 0, roomNights: up?.nights ?? 0, value: fmt(up?.value ?? '0', p.currency), atRisk: up?.risk_lines ?? 0, atRiskValue: fmt(up?.risk_value ?? '0', p.currency) },
          cash: { openSessions: cs?.open_n ?? 0, awaitingReview: cs?.review_n ?? 0, variance: fmt(cs?.variance ?? '0', p.currency) },
          approvals: { paymentsToVerify: pd?.n ?? 0, paymentsToVerifyAmount: fmt(pd?.amt ?? '0', p.currency), sessionsToReview: cs?.review_n ?? 0 },
          issues: { open: is?.n ?? 0, oldestHours: is?.oldest_h ?? 0 },
          revenueProtection: { otaConfirmed: pr.ota_future, otaGuaranteed: pr.ota_guaranteed, otaAtRisk: pr.ota_risk, depositConversionPct: pct(pr.ota_deposit, pr.ota_created), otaCreated: pr.ota_created, feesNet: fmt(pr.fee_net, p.currency), otaReceivable: fmt(otaRec.rows.find((x) => x.property_id === p.id)?.open_amt ?? '0', p.currency), otaWrittenOff: fmt(otaRec.rows.find((x) => x.property_id === p.id)?.written ?? '0', p.currency) },
        };
      });
      void byProp;
      const sumM = (f: (x: typeof per[number]) => { amount: string }) => per.reduce((a, x) => a + BigInt(f(x).amount.replace('.', '')), 0n);
      const sold = per.reduce((a, x) => a + x.period.roomsSold, 0), avail = per.reduce((a, x) => a + x.period.roomsAvailable, 0);
      const rev = sumM((x) => x.period.roomRevenue);
      const receivables = await this.ar.aging();
      return {
        from, to, currency: cur, scope: tenantWide ? 'ALL_PROPERTIES' : 'SOME_PROPERTIES',
        totals: { occupancyPct: pct(sold, avail), roomsSold: sold, roomsAvailable: avail, roomRevenue: fmt(rev, cur), adr: fmt(div(rev, BigInt(sold)), cur), revPar: fmt(div(rev, BigInt(avail)), cur),
          arrivalsToday: per.reduce((a, x) => a + x.today.arrivals, 0), departuresToday: per.reduce((a, x) => a + x.today.departures, 0), inHouse: per.reduce((a, x) => a + x.today.inHouse, 0) },
        properties: per,
        salesBySource: bySource.rows.map((r) => ({ source: r.source, amount: fmt(r.amt, cur) })),
        salesByCompany: byCompany.rows.map((r) => ({ companyId: r.company_id, company: r.name, amount: fmt(r.amt, cur) })),
        receivables: tenantWide ? { asOf: receivables.asOf, totalOpen: receivables.totalOpen, buckets: receivables.totals } : null,
        approvals: { companyReceiptsToVerify: tenantWide ? arPending.rows[0]!.n : 0, companyReceiptsAmount: fmt(tenantWide ? arPending.rows[0]!.amt : '0', cur), taxRatesAwaitingApproval: taxDrafts },
      };
    });
  }
}
