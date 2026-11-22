import { Body, ConflictException, Controller, Delete, Get, Inject, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';

export const DEPARTMENTS = ['FRONT_DESK', 'HOUSEKEEPING', 'MAINTENANCE', 'FNB', 'SECURITY', 'MANAGEMENT'] as const;
const Dept = z.enum(DEPARTMENTS);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-20');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:00');
const Range = z.object({ from: date, to: date }).refine((r) => r.to >= r.from && (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 <= 42, 'Ask for at most 6 weeks at a time');
const Shift = z.object({ userId: z.string().uuid(), date, department: Dept, start: time, end: time, note: z.string().trim().max(200).optional() }).strict().refine((s) => s.start !== s.end, 'The shift must start and end at different times');
const Rule = z.object({ roomsPerStaff: z.number().int().min(1).max(1000), minStaff: z.number().int().min(0).max(100) }).strict();
const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };

/** Who works which shift, and the standard for how many staff each department needs for the rooms in use. */
@Injectable()
export class RosterService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService) {}

  async week(propertyId: string, from: string, to: string) {
    return this.tdb.tx(async (trx) => {
      const shifts = await trx.selectFrom('roster_shift as s').innerJoin('staff_user as u', (j) => j.onRef('u.id', '=', 's.user_id').onRef('u.tenant_id', '=', 's.tenant_id'))
        .select(['s.id', 's.user_id', 'u.full_name', 's.shift_date', 's.department', 's.start_time', 's.end_time', 's.note']).where('s.property_id', '=', propertyId).where('s.shift_date', '>=', from).where('s.shift_date', '<=', to).orderBy('s.shift_date').orderBy('s.start_time').execute();
      const staff = await trx.selectFrom('staff_user').select(['id', 'full_name']).where('status', '!=', 'DISABLED').orderBy('full_name').execute();
      const rules = await trx.selectFrom('staffing_rule').select(['department', 'rooms_per_staff', 'min_staff']).where('property_id', '=', propertyId).execute();
      const by = new Map(rules.map((r) => [r.department, r]));
      return {
        shifts: shifts.map((s) => ({ id: s.id, userId: s.user_id, name: s.full_name, date: String(s.shift_date).slice(0, 10), department: s.department, start: String(s.start_time).slice(0, 5), end: String(s.end_time).slice(0, 5), note: s.note })),
        staff: staff.map((u) => ({ id: u.id, name: u.full_name })),
        rules: DEPARTMENTS.map((d) => ({ department: d, roomsPerStaff: by.get(d)?.rooms_per_staff ?? null, minStaff: by.get(d)?.min_staff ?? null })),
      };
    });
  }

  async addShift(propertyId: string, userId: string, i: z.infer<typeof Shift>) {
    return this.tdb.tx(async (trx) => {
      const u = await trx.selectFrom('staff_user').select(['id', 'status']).where('id', '=', i.userId).executeTakeFirst();
      if (!u || u.status === 'DISABLED') throw new NotFoundException({ code: 'NOT_FOUND', message: 'That person is not an active member of staff' });
      const dup = await trx.selectFrom('roster_shift').select('id').where('property_id', '=', propertyId).where('user_id', '=', i.userId).where('shift_date', '=', i.date).where('start_time', '=', i.start).executeTakeFirst();
      if (dup) throw new ConflictException({ code: 'SHIFT_EXISTS', message: 'This person already has a shift starting at that time on that day' });
      const row = await trx.insertInto('roster_shift').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, user_id: i.userId, shift_date: i.date, department: i.department, start_time: i.start, end_time: i.end, note: i.note ?? null, created_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'roster.add', resourceType: 'roster_shift', resourceId: row.id, propertyId, after: { userId: i.userId, date: i.date, department: i.department, start: i.start, end: i.end } });
      return { id: row.id };
    });
  }

  async removeShift(propertyId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.deleteFrom('roster_shift').where('id', '=', id).where('property_id', '=', propertyId).returning(['user_id', 'shift_date', 'department']).executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'That shift does not exist' });
      await this.audit.record(trx, { action: 'roster.remove', resourceType: 'roster_shift', resourceId: id, propertyId, before: { userId: r.user_id, date: String(r.shift_date).slice(0, 10), department: r.department } });
      return { removed: true };
    });
  }

  async saveRule(propertyId: string, department: string, userId: string, i: z.infer<typeof Rule>) {
    return this.tdb.tx(async (trx) => {
      const v = { rooms_per_staff: i.roomsPerStaff, min_staff: i.minStaff, updated_by: userId, updated_at: new Date() };
      await trx.insertInto('staffing_rule').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, department, ...v } as never).onConflict((oc) => oc.columns(['tenant_id', 'property_id', 'department']).doUpdateSet(v as never)).execute();
      await this.audit.record(trx, { action: 'staffing_rule.save', resourceType: 'staffing_rule', resourceId: `${propertyId}:${department}`, propertyId, after: { department, ...i } });
      return { saved: true };
    });
  }
}

@Controller('v1/properties/:propertyId/roster')
export class RosterController {
  constructor(@Inject(RosterService) private readonly svc: RosterService) {}
  @Get() @RequirePermission('report.view', P)
  week(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Query() q: unknown) { const r = parse(Range, q); return this.svc.week(pid, r.from, r.to); }
  @Post('shifts') @RequirePermission('rate.manage', P)
  add(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Body() b: unknown) { return this.svc.addShift(pid, currentTenant().actorId!, parse(Shift, b)); }
  @Delete('shifts/:id') @RequirePermission('rate.manage', P)
  remove(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Param('id', new ParseUUIDPipe()) id: string) { return this.svc.removeShift(pid, id); }
  @Put('rules/:department') @RequirePermission('rate.manage', P)
  rule(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Param('department') d: string, @Body() b: unknown) { return this.svc.saveRule(pid, parse(Dept, d), currentTenant().actorId!, parse(Rule, b)); }
}
