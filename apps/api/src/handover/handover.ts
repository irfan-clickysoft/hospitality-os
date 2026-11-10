import { Body, Controller, Get, HttpCode, Inject, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, UnprocessableEntityException, HttpException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';

const Create = z.object({ shift: z.enum(['MORNING', 'EVENING', 'NIGHT']), notes: z.string().trim().min(3).max(2000), items: z.array(z.string().trim().min(1).max(200)).max(10).default([]) }).strict();
const ItemDone = z.object({ done: z.boolean() }).strict();
const ListQ = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });
const P = { scope: (req: any) => ({ propertyId: req.params.propertyId }) };
const me = () => currentTenant().actorId!;
interface Item { text: string; done: boolean; doneBy: string | null; doneAt: string | null }

/** The note one shift leaves for the next. The next person reads it and marks it read; open items stay visible until someone ticks them off. */
@Injectable()
export class HandoverService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService) {}

  private view(r: Record<string, any>, names: Map<string, string>, viewer: string) {
    const items = (r.items as Item[]) ?? [];
    return { id: r.id, businessDate: r.business_date, shift: r.shift, author: names.get(r.author_id) ?? '—', mine: r.author_id === viewer, notes: r.notes, items: items.map((x) => ({ text: x.text, done: x.done, doneBy: x.doneBy ? names.get(x.doneBy) ?? null : null })), openItems: items.filter((x) => !x.done).length, acknowledgedBy: r.acknowledged_by ? names.get(r.acknowledged_by) ?? null : null, acknowledgedAt: r.acknowledged_at, createdAt: r.created_at };
  }
  async list(propertyId: string, userId: string, limit: number) {
    return this.tdb.tx(async (trx) => {
      const names = new Map((await trx.selectFrom('staff_user').select(['id', 'full_name']).execute()).map((u) => [u.id, u.full_name]));
      const rows = await trx.selectFrom('shift_handover').selectAll().where('property_id', '=', propertyId).orderBy('created_at', 'desc').limit(limit).execute();
      return { items: rows.map((r) => this.view(r, names, userId)) };
    });
  }
  async create(propertyId: string, userId: string, i: z.infer<typeof Create>) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select('business_date').where('id', '=', propertyId).executeTakeFirstOrThrow();
      const items: Item[] = i.items.map((text) => ({ text, done: false, doneBy: null, doneAt: null }));
      const r = await trx.insertInto('shift_handover').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, business_date: p.business_date, shift: i.shift, author_id: userId, notes: i.notes, items: JSON.stringify(items) } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'handover.create', resourceType: 'shift_handover', resourceId: r.id, propertyId, after: { shift: i.shift, items: items.length } });
      return { id: r.id };
    });
  }
  async acknowledge(propertyId: string, userId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.selectFrom('shift_handover').selectAll().where('id', '=', id).where('property_id', '=', propertyId).forUpdate().executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such handover' });
      if (r.author_id === userId) throw new UnprocessableEntityException({ code: 'OWN_HANDOVER', message: 'The next shift marks a handover as read, not the person who wrote it.' });
      if (r.acknowledged_at) return { id, alreadyRead: true };
      await trx.updateTable('shift_handover').set({ acknowledged_by: userId, acknowledged_at: new Date() } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'handover.acknowledge', resourceType: 'shift_handover', resourceId: id, propertyId });
      return { id, alreadyRead: false };
    });
  }
  async tick(propertyId: string, userId: string, id: string, index: number, done: boolean) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.selectFrom('shift_handover').selectAll().where('id', '=', id).where('property_id', '=', propertyId).forUpdate().executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such handover' });
      const items = ((r.items as Item[]) ?? []).slice(); const it = items[index];
      if (!it) throw new HttpException({ code: 'NOT_FOUND', message: 'No such item' }, 404);
      items[index] = { ...it, done, doneBy: done ? userId : null, doneAt: done ? new Date().toISOString() : null };
      await trx.updateTable('shift_handover').set({ items: JSON.stringify(items) } as never).where('id', '=', id).execute();
      return { id, index, done };
    });
  }
}

@Controller('v1/properties/:propertyId/handovers')
export class HandoverController {
  constructor(@Inject(HandoverService) private readonly svc: HandoverService) {}
  @Get() @RequirePermission('reservation.view', P)
  list(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Query() q: unknown) { return this.svc.list(pid, me(), parse(ListQ, q).limit); }
  @Post() @RequirePermission('reservation.create', P)
  create(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Body() b: unknown) { return this.svc.create(pid, me(), parse(Create, b)); }
  @Post(':id/acknowledge') @RequirePermission('reservation.create', P) @HttpCode(200)
  ack(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Param('id', new ParseUUIDPipe()) id: string) { return this.svc.acknowledge(pid, me(), id); }
  @Put(':id/items/:index') @RequirePermission('reservation.create', P)
  tick(@Param('propertyId', new ParseUUIDPipe()) pid: string, @Param('id', new ParseUUIDPipe()) id: string, @Param('index') index: string, @Body() b: unknown) { return this.svc.tick(pid, me(), id, Math.max(0, Number.parseInt(index, 10) || 0), parse(ItemDone, b).done); }
}
