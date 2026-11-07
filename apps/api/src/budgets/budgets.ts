import { Body, Controller, Get, Inject, Injectable, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';

const money = z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Use an amount like 4500000 or 4500000.50');
const Year = z.object({ year: z.coerce.number().int().min(2020).max(2100).optional() });
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-11');
const Body_ = z.object({ roomRevenue: money, fnbRevenue: money.default('0'), occupancyPct: z.number().min(0).max(100).nullish(), note: z.string().trim().max(300).nullish() }).strict();
const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };

/** What the owner expects each month: room revenue, food and beverage revenue and occupancy. Reports show the actual figures against it. */
@Injectable()
export class BudgetsService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService) {}

  async year(propertyId: string, year?: number) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['currency', 'business_date']).where('id', '=', propertyId).executeTakeFirstOrThrow();
      const y = year ?? Number(p.business_date.slice(0, 4));
      const rows = await trx.selectFrom('budget_month').selectAll().where('property_id', '=', propertyId).where('month', '>=', `${y}-01-01`).where('month', '<=', `${y}-12-01`).execute();
      const by = new Map(rows.map((r) => [r.month.slice(0, 7), r]));
      return { currency: p.currency, year: y, items: Array.from({ length: 12 }, (_, i) => { const m = `${y}-${String(i + 1).padStart(2, '0')}`; const r = by.get(m); return { month: m, roomRevenue: Money.ofMinor(BigInt(r?.room_revenue_minor ?? 0), p.currency).toDecimalString(), fnbRevenue: Money.ofMinor(BigInt(r?.fnb_revenue_minor ?? 0), p.currency).toDecimalString(), occupancyPct: r?.occupancy_pct == null ? null : Number(r.occupancy_pct), note: r?.note ?? null, set: !!r }; }) };
    });
  }

  async save(propertyId: string, month: string, userId: string, i: z.infer<typeof Body_>) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select('currency').where('id', '=', propertyId).executeTakeFirstOrThrow();
      const v = { room_revenue_minor: Money.parse(i.roomRevenue, p.currency).minor.toString(), fnb_revenue_minor: Money.parse(i.fnbRevenue, p.currency).minor.toString(), occupancy_pct: i.occupancyPct == null ? null : String(i.occupancyPct), note: i.note ?? null, updated_by: userId, updated_at: new Date() };
      await trx.insertInto('budget_month').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, month: `${month}-01`, ...v } as never).onConflict((oc) => oc.columns(['tenant_id', 'property_id', 'month']).doUpdateSet(v as never)).execute();
      await this.audit.record(trx, { action: 'budget.save', resourceType: 'budget_month', resourceId: `${propertyId}:${month}`, propertyId, after: { month, roomRevenue: i.roomRevenue, fnbRevenue: i.fnbRevenue, occupancyPct: i.occupancyPct ?? null } });
      return { month, saved: true };
    });
  }
}

@Controller('v1/properties/:propertyId/budgets')
export class BudgetsController {
  constructor(@Inject(BudgetsService) private readonly svc: BudgetsService) {}
  @Get() @RequirePermission('report.view', P)
  list(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Query() q: unknown) { return this.svc.year(pid, parse(Year, q).year); }
  @Put(':month') @RequirePermission('rate.manage', P)
  save(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Param('month') month: string, @Body() b: unknown) { return this.svc.save(pid, parse(Month, month), currentTenant().actorId!, parse(Body_, b)); }
}
