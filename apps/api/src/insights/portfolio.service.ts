import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuthorizationService } from '../authz/authorization.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { envelopeToCsv } from './insights.service.js';
import { PORTFOLIO, type PProp } from './portfolio.js';
import type { Col, Envelope, Row } from './types.js';
import { addDays, ymd } from './util.js';

const fail = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
const MAX_DAYS = 400;

/** Reports across every property the person may see reports for. Each property is included only if they hold the report permission there, so a portfolio report never shows a property the person could not open on its own. */
@Injectable()
export class PortfolioService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuthorizationService) private readonly authz: AuthorizationService) {}

  private async visible(userId: string, trx: Parameters<Parameters<TenantDb['tx']>[0]>[0]): Promise<PProp[]> {
    const all = await trx.selectFrom('property').select(['id', 'code', 'name', 'currency', 'timezone', 'business_date']).orderBy('name').execute();
    const out: PProp[] = [];
    for (const p of all) if ((await this.authz.check(userId, { permission: 'report.view', scope: { propertyId: p.id } })).effect === 'ALLOW') out.push({ id: p.id, code: p.code, name: p.name, currency: p.currency, timezone: p.timezone, businessDate: p.business_date });
    return out;
  }

  /** Offered only to people who can see reports at two or more properties. */
  async catalog(userId: string) {
    const n = await this.tdb.tx(async (trx) => (await this.visible(userId, trx)).length);
    if (n < 2) return { items: [], properties: n };
    return { properties: n, items: PORTFOLIO.map((d) => ({ id: d.id, name: d.name, category: 'portfolio', kind: d.kind, purpose: d.purpose, roles: ['manager', 'accounts'], basis: [{ id: 'asof', label: d.range === 'none' ? 'Each property’s business date' : 'Stay or posting date' }], range: d.range, params: d.params ?? [], portfolio: true })) };
  }

  async run(userId: string, id: string, q: { from?: string; to?: string; params?: Record<string, string> }): Promise<Envelope> {
    const d = PORTFOLIO.find((x) => x.id === id);
    if (!d) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such report' });
    const params: Record<string, string> = {}; for (const p of d.params ?? []) { const v = q.params?.[p.key]; params[p.key] = p.options.some((o) => o.value === v) ? v! : p.default; }
    return this.tdb.tx(async (trx) => {
      const props = await this.visible(userId, trx);
      if (props.length === 0) throw fail(403, 'PERMISSION_DENIED', 'You cannot see reports at any property');
      const latest = props.map((p) => p.businessDate).sort().at(-1)!; const def = d.range === 'month' ? [`${latest.slice(0, 8)}01`, latest] : [latest, latest];
      const from = q.from ?? def[0]!; const to = q.to ?? def[1]!;
      if (!ymd(from) || !ymd(to)) throw fail(400, 'VALIDATION_FAILED', 'Dates must look like 2026-11-05');
      if (to < from) throw fail(400, 'VALIDATION_FAILED', 'The end date is before the start date');
      if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_DAYS) throw fail(400, 'RANGE_TOO_LONG', `Choose a period of at most ${MAX_DAYS} days`);
      const res = await d.run({ trx, tenantId: currentTenant().tenantId, props, ids: props.map((p) => p.id), from, to, params });
      const currencies = [...new Set(props.map((p) => p.currency))]; const mixed = currencies.length > 1;
      const cols: Col[] = mixed ? res.columns.map((c) => (c.type === 'money' ? { ...c, total: false } : c)) : res.columns;
      const me = await trx.selectFrom('staff_user').select('full_name').where('id', '=', userId).executeTakeFirst();
      const t = cols.filter((c) => c.total); let totals: Row | null = null;
      if (t.length && res.rows.length) { totals = {}; for (const c of t) totals[c.key] = c.type === 'money' ? res.rows.reduce((s, r) => s + BigInt((r[c.key] as string | null) ?? 0), 0n).toString() : res.rows.reduce((s, r) => s + Number(r[c.key] ?? 0), 0); }
      const tz = [...new Set(props.map((p) => p.timezone))].join(', ');
      return { ...res, columns: cols, totals, warnings: [...(res.warnings ?? []), ...(mixed ? [`These properties use different currencies (${currencies.join(', ')}). Money is shown in each property’s own currency and is not added up.`] : []), ...(props.length === 1 ? ['Only one property is visible to you, so this is a single-property view.'] : [])], definitions: d.definitions,
        meta: { id: d.id, name: d.name, purpose: d.purpose, kind: d.kind, category: 'portfolio', property: { id: '', code: 'ALL', name: `All properties (${props.length}): ${props.map((p) => p.name).join(', ')}` }, timezone: tz, businessDate: latest, asOf: new Date().toISOString(), dateBasis: { id: 'asof', label: d.range === 'none' ? 'Each property’s business date' : 'Stay or posting date' }, from: d.range === 'none' ? null : from, to: d.range === 'none' ? null : to, params, currency: mixed ? 'MIXED' : currencies[0]!, taxBasis: 'Excluding tax unless a column says otherwise', definitionVersion: '1', freshness: 'live', generatedBy: me?.full_name ?? null } };
    });
  }

  async csv(userId: string, id: string, q: Parameters<PortfolioService['run']>[2]) { return envelopeToCsv(await this.run(userId, id, q)); }
}
void addDays;
