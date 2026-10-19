import { ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { Money } from '@hos/domain-types';
import { AuthorizationService } from '../authz/authorization.service.js';
import { ArService } from '../companies/ar.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { PaymentAccountsService } from '../payment-accounts/payment-accounts.service.js';
import { TaxService } from '../tax/tax.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { toCsv, type Cell } from './csv.js';

const fail = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
const dec = (m: string | bigint | number | undefined, cur = 'PKR') => Money.ofMinor(BigInt(m ?? 0), cur).toDecimalString();
export interface Report { filename: string; csv: string }
export const PROPERTY_REPORTS = ['daily-summary', 'revenue-by-code', 'payments', 'open-folios', 'invoices', 'tax-liability', 'in-house'] as const;
export const TENANT_REPORTS = ['ar-aging', 'payment-accounts'] as const;
const MAX_DAYS = 400;

/** Spreadsheet downloads of the figures the accountant and the owner ask for. Read-only; the same permissions as seeing the figures on screen. */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(ArService) private readonly ar: ArService,
    @Inject(PaymentAccountsService) private readonly accounts: PaymentAccountsService,
  ) {}

  private async need(userId: string, permission: string, propertyId: string) {
    if ((await this.authz.check(userId, { permission, scope: { propertyId } })).effect !== 'ALLOW') throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: `This report needs the "${permission}" permission` });
  }
  private range(from?: string, to?: string, bd?: string) {
    const end = to ?? bd ?? new Date().toISOString().slice(0, 10);
    const start = from ?? `${end.slice(0, 8)}01`;
    if (end < start) throw fail(400, 'VALIDATION_FAILED', 'The end date is before the start date');
    if ((Date.parse(end) - Date.parse(start)) / 86_400_000 > MAX_DAYS) throw fail(400, 'RANGE_TOO_LONG', `Choose a period of at most ${MAX_DAYS} days`);
    return { start, end };
  }

  async forProperty(userId: string, propertyId: string, name: string, from?: string, to?: string): Promise<Report> {
    if (!(PROPERTY_REPORTS as readonly string[]).includes(name)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such report' });
    await this.need(userId, 'report.view', propertyId);
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['id', 'code', 'currency', 'business_date']).where('id', '=', propertyId).executeTakeFirst();
      if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
      const t = currentTenant().tenantId; const cur = p.currency;
      const { start, end } = this.range(from, to, p.business_date);
      const file = (n: string) => `${p.code}-${n}-${start}_${end}.csv`;
      switch (name) {
        case 'daily-summary': {
          const r = await sql<Record<string, string | number>>`SELECT business_date::text AS d, rooms_available, rooms_sold, occupancy_bp, room_revenue_minor::text AS room, fees_minor::text AS fees, other_revenue_minor::text AS other, tax_minor::text AS tax, adr_minor::text AS adr, revpar_minor::text AS revpar,
              arrivals, departures, in_house, no_shows, cancellations, guest_ledger_minor::text AS ledger, advance_deposits_minor::text AS deposits, cashier_variance_minor::text AS variance
            FROM daily_property_stats WHERE tenant_id = ${t} AND property_id = ${propertyId} AND business_date BETWEEN ${start}::date AND ${end}::date ORDER BY business_date`.execute(trx);
          return { filename: file('daily-summary'), csv: toCsv(['Date', 'Rooms available', 'Rooms sold', 'Occupancy %', 'Room revenue', 'Fees', 'Other revenue', 'Tax', 'ADR', 'RevPAR', 'Arrivals', 'Departures', 'In house', 'No-shows', 'Cancellations', 'Guest ledger', 'Advance deposits', 'Cashier variance'],
            r.rows.map((x) => [x.d, x.rooms_available, x.rooms_sold, Number(x.occupancy_bp) / 100, dec(x.room, cur), dec(x.fees, cur), dec(x.other, cur), dec(x.tax, cur), dec(x.adr, cur), dec(x.revpar, cur), x.arrivals, x.departures, x.in_house, x.no_shows, x.cancellations, dec(x.ledger, cur), dec(x.deposits, cur), dec(x.variance, cur)])) };
        }
        case 'revenue-by-code': {
          const r = await sql<{ d: string; code: string; type: string | null; source: string | null; n: number; amt: string }>`SELECT l.business_date::text AS d, l.txn_code AS code, rt.name AS type, l.source, l.posting_count AS n, l.amount_minor::text AS amt
            FROM daily_revenue_line l LEFT JOIN room_type rt ON rt.tenant_id = l.tenant_id AND rt.id = l.room_type_id WHERE l.tenant_id = ${t} AND l.property_id = ${propertyId} AND l.business_date BETWEEN ${start}::date AND ${end}::date ORDER BY l.business_date, l.txn_code, rt.name, l.source`.execute(trx);
          return { filename: file('revenue-by-code'), csv: toCsv(['Date', 'Code', 'Room type', 'Source', 'Postings', 'Amount (excl. tax)'], r.rows.map((x) => [x.d, x.code, x.type, x.source, x.n, dec(x.amt, cur)])) };
        }
        case 'payments': {
          const r = await sql<{ d: string; folio: string; conf: string | null; kind: string; method: string; status: string; amt: string; ref: string | null; cp: string | null; acct: string | null; owner: string | null; by: string | null }>`
            SELECT p.business_date::text AS d, f.folio_no AS folio, r.confirmation_no AS conf, p.kind, p.method, p.status, p.amount_minor::text AS amt, p.reference AS ref, p.counterparty AS cp, a.name AS acct, a.owner_type AS owner, u.full_name AS by
            FROM payment p JOIN folio f ON f.tenant_id = p.tenant_id AND f.id = p.folio_id LEFT JOIN reservation r ON r.tenant_id = f.tenant_id AND r.id = f.reservation_id LEFT JOIN payment_account a ON a.tenant_id = p.tenant_id AND a.id = p.payment_account_id
            LEFT JOIN staff_user u ON u.tenant_id = p.tenant_id AND u.id = p.created_by WHERE p.tenant_id = ${t} AND p.property_id = ${propertyId} AND p.business_date BETWEEN ${start}::date AND ${end}::date ORDER BY p.business_date, p.created_at`.execute(trx);
          return { filename: file('payments'), csv: toCsv(['Date', 'Bill', 'Booking', 'Kind', 'Method', 'Status', 'Amount', 'Reference', 'Counterparty', 'Account', 'Account owner', 'Recorded by'], r.rows.map((x) => [x.d, x.folio, x.conf, x.kind, x.method, x.status, dec(x.amt, cur), x.ref, x.cp, x.acct, x.owner, x.by])) };
        }
        case 'open-folios': {
          const r = await sql<{ folio: string; conf: string | null; guest: string | null; co: string | null; bal: string }>`SELECT f.folio_no AS folio, r.confirmation_no AS conf, g.full_name AS guest, c.name AS co, f.balance_minor::text AS bal FROM folio f LEFT JOIN reservation r ON r.tenant_id = f.tenant_id AND r.id = f.reservation_id
            LEFT JOIN guest g ON g.tenant_id = f.tenant_id AND g.id = f.guest_id LEFT JOIN company c ON c.tenant_id = r.tenant_id AND c.id = r.company_id WHERE f.tenant_id = ${t} AND f.property_id = ${propertyId} AND f.status = 'OPEN' AND f.balance_minor <> 0 ORDER BY f.balance_minor DESC`.execute(trx);
          return { filename: `${p.code}-open-bills-${p.business_date}.csv`, csv: toCsv(['Bill', 'Booking', 'Guest', 'Company', 'Balance'], r.rows.map((x) => [x.folio, x.conf, x.guest, x.co, dec(x.bal, cur)])) };
        }
        case 'invoices': {
          const r = await sql<{ number: string; d: string; type: string; bill: string; ntn: string | null; net: string; tax: string; total: string; conf: string | null }>`SELECT i.number, i.issue_date::text AS d, i.doc_type AS type, i.bill_to->>'name' AS bill, i.bill_to->>'ntn' AS ntn, i.net_minor::text AS net, i.tax_minor::text AS tax, i.total_minor::text AS total, i.reference->>'confirmationNo' AS conf
            FROM invoice i WHERE i.tenant_id = ${t} AND i.property_id = ${propertyId} AND i.issue_date BETWEEN ${start}::date AND ${end}::date ORDER BY i.issued_at, i.number`.execute(trx);
          return { filename: file('invoices'), csv: toCsv(['Number', 'Date', 'Type', 'Billed to', 'Their NTN', 'Net', 'Tax', 'Total', 'Booking'], r.rows.map((x) => [x.number, x.d, x.type === 'CREDIT_NOTE' ? 'Credit note' : 'Tax invoice', x.bill, x.ntn, dec(x.net, cur), dec(x.tax, cur), dec(x.total, cur), x.conf])) };
        }
        case 'in-house': {
          const r = await sql<{ room: string; guest: string; conf: string; arrival: string; departure: string; nat: string | null; bal: string | null; co: string | null }>`
            SELECT rm.number AS room, g.full_name AS guest, r.confirmation_no AS conf, l.arrival::text AS arrival, l.departure::text AS departure, g.nationality AS nat, f.balance_minor::text AS bal, c.name AS co
            FROM reservation_room l JOIN reservation r ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id JOIN room_assignment a ON a.assignment_ref = l.id AND a.status = 'IN_HOUSE' JOIN room rm ON rm.id = a.room_id
            LEFT JOIN folio f ON f.tenant_id = r.tenant_id AND f.reservation_id = r.id AND f.folio_type = 'GUEST' AND f.status <> 'VOID' LEFT JOIN company c ON c.tenant_id = r.tenant_id AND c.id = r.company_id
            WHERE l.tenant_id = ${t} AND l.property_id = ${propertyId} AND l.status = 'CHECKED_IN' ORDER BY lpad(regexp_replace(rm.number, '\\D', '', 'g'), 8, '0'), rm.number`.execute(trx);
          return { filename: `${p.code}-in-house-${p.business_date}.csv`, csv: toCsv(['Room', 'Guest', 'Booking', 'Arrival', 'Departure', 'Nationality', 'Company', 'Bill balance'], r.rows.map((x) => [x.room, x.guest, x.conf, x.arrival, x.departure, x.nat, x.co, x.bal === null ? '' : dec(x.bal, cur)])) };
        }
        default: break;
      }
      // tax-liability (needs the tax-liability figures as well)
      return { filename: '', csv: '' };
    }).then(async (rep) => {
      if (name !== 'tax-liability') return rep;
      const prop = await this.tdb.tx((trx) => trx.selectFrom('property').select(['code', 'business_date']).where('id', '=', propertyId).executeTakeFirstOrThrow());
      const { start, end } = this.range(from, to, prop.business_date);
      const l = await this.tax.liability(propertyId, start, end);
      return { filename: `${prop.code}-tax-liability-${start}_${end}.csv`, csv: toCsv(['Tax', 'Name', 'Rate %', 'Postings', 'Taxable amount', 'Tax'], l.items.map((x) => [x.code, x.name, x.ratePercent, x.postings, x.taxable.amount, x.tax.amount])) };
    });
  }

  async forTenant(userId: string, name: string, from?: string, to?: string): Promise<Report> {
    if (name === 'ar-aging') {
      if (!(await this.authz.holdsAnywhere(userId, 'company.view'))) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'This report needs the "company.view" permission' });
      const a = await this.ar.aging(to);
      const cell = (x?: { amount: string }) => x?.amount ?? '0.00';
      return { filename: `receivables-ageing-${a.asOf}.csv`, csv: toCsv(['Company', 'Not yet due', '1–30 days late', '31–60 days late', '61–90 days late', 'Over 90 days late', 'Total owed', 'Credit on account'],
        a.items.map((x) => [x.company, cell((x.buckets as never as Record<string, { amount: string }>).current), cell((x.buckets as never as Record<string, { amount: string }>).d1_30), cell((x.buckets as never as Record<string, { amount: string }>).d31_60), cell((x.buckets as never as Record<string, { amount: string }>).d61_90), cell((x.buckets as never as Record<string, { amount: string }>).d90plus), x.totalOpen.amount, x.onAccount.amount])) };
    }
    if (name === 'payment-accounts') {
      if (!(await this.authz.holdsAnywhere(userId, 'paymentaccount.view'))) throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'This report needs the "paymentaccount.view" permission' });
      const s = await this.accounts.summary(from, to);
      return { filename: `payment-accounts-${s.from}_${s.to}.csv`, csv: toCsv(['Account', 'Kind', 'Bank', 'Last 4', 'Owner', 'Owned by', 'Receipts', 'Money in', 'Money out', 'Net'], s.items.map((x): Cell[] => [x.name, x.kind, x.bankName, x.last4, x.ownerType === 'COMPANY' ? 'Company' : 'NOT THE COMPANY', x.ownerName, x.count, x.in.amount, x.out.amount, x.net.amount])
        .concat([[`Receipts with no account named`, '', '', '', '', '', s.unassigned.count, s.unassigned.in.amount, s.unassigned.out.amount, ''] as Cell[]])) };
    }
    throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such report' });
  }
}
