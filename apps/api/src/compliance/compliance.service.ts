import { ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authz/authorization.service.js';
import { CLOCK, type ClockLike } from '../common/clock.js';
import type { Trx } from '../companies/companies.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
const FRESH_MFA_MS = 15 * 60_000;
export type Stage = 'BOOKING' | 'CHECK_IN';
export interface Ctx { propertyId: string; stage: Stage; nationality: string | null; residency: 'RESIDENT' | 'NON_RESIDENT'; guests: number; nights: number; businessDate: string }
export interface Match { ruleId: string; name: string; action: string; message: string; messageUr: string | null; documentTypes: string[]; taskTitle: string | null; approved: boolean }
const ORDER = ['BLOCK_BOOKING', 'REQUIRE_APPROVAL', 'REQUIRE_DOCUMENT', 'REQUIRE_TASK', 'WARN', 'INFO'];

@Injectable()
export class ComplianceService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: ClockLike,
  ) {}

  private view(r: { id: string; name: string; description: string | null; status: string; stages: string[]; conditions: unknown; action: string; message: string; message_ur: string | null; document_types: string[]; task_title: string | null; reason_code: string | null; effective_from: string | null; effective_to: string | null; version: number }) {
    return { id: r.id, name: r.name, description: r.description, status: r.status, stages: r.stages, conditions: r.conditions, action: r.action, message: r.message, messageUr: r.message_ur, documentTypes: r.document_types, taskTitle: r.task_title,
      reasonCode: r.reason_code, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, version: r.version };
  }

  // ───────────── the rules ─────────────
  async list() { return this.tdb.tx(async (trx) => ({ items: (await trx.selectFrom('compliance_rule').selectAll().orderBy('status').orderBy('name').execute()).map((r) => this.view(r as never)) })); }
  async create(userId: string, i: z.infer<typeof S.CreateRule>) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.insertInto('compliance_rule').values({ tenant_id: currentTenant().tenantId, name: i.name, description: i.description ?? null, stages: i.stages as never, conditions: JSON.stringify(i.conditions), action: i.action, message: i.message, message_ur: i.messageUr ?? null,
        document_types: i.documentTypes as never, task_title: i.taskTitle ?? null, reason_code: i.reasonCode ?? null, effective_from: i.effectiveFrom ?? null, effective_to: i.effectiveTo ?? null, created_by: userId, updated_by: userId } as never).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'compliance.rule_create', resourceType: 'compliance_rule', resourceId: r.id, after: { name: i.name, action: i.action, stages: i.stages, conditions: i.conditions } });
      return this.view(r as never);
    });
  }
  async update(userId: string, id: string, i: z.infer<typeof S.UpdateRule>) {
    return this.tdb.tx(async (trx) => {
      const cur = await trx.selectFrom('compliance_rule').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Rule not found' });
      if (cur.version !== i.version) throw fail(412, 'VERSION_CONFLICT', 'Someone else changed this rule. Reload and try again.');
      const m: Record<string, unknown> = {};
      if (i.name !== undefined) m.name = i.name; if (i.description !== undefined) m.description = i.description; if (i.stages !== undefined) m.stages = i.stages; if (i.conditions !== undefined) m.conditions = JSON.stringify(i.conditions);
      if (i.action !== undefined) m.action = i.action; if (i.message !== undefined) m.message = i.message; if (i.messageUr !== undefined) m.message_ur = i.messageUr; if (i.documentTypes !== undefined) m.document_types = i.documentTypes;
      if (i.taskTitle !== undefined) m.task_title = i.taskTitle; if (i.reasonCode !== undefined) m.reason_code = i.reasonCode; if (i.effectiveFrom !== undefined) m.effective_from = i.effectiveFrom; if (i.effectiveTo !== undefined) m.effective_to = i.effectiveTo;
      let r;
      try { r = await trx.updateTable('compliance_rule').set({ ...m, updated_by: userId, updated_at: new Date(this.clock.now()), version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow(); }
      catch (e) { if ((e as { code?: string }).code === '23514') throw fail(422, 'RULE_INVALID', 'A document rule needs the accepted ID types; a task rule needs a task title'); throw e; }
      await this.audit.record(trx, { action: 'compliance.rule_update', resourceType: 'compliance_rule', resourceId: id, before: this.view(cur as never), after: this.view(r as never) });
      return this.view(r as never);
    });
  }
  async setStatus(userId: string, id: string, i: z.infer<typeof S.SetStatus>) {
    return this.tdb.tx(async (trx) => {
      const cur = await trx.selectFrom('compliance_rule').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Rule not found' });
      if (cur.version !== i.version) throw fail(412, 'VERSION_CONFLICT', 'Someone else changed this rule. Reload and try again.');
      const r = await trx.updateTable('compliance_rule').set({ status: i.status, updated_by: userId, updated_at: new Date(this.clock.now()), version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: `compliance.rule_${i.status.toLowerCase()}`, resourceType: 'compliance_rule', resourceId: id, before: { status: cur.status }, after: { status: i.status } });
      return this.view(r as never);
    });
  }

  // ───────────── evaluating ─────────────
  async matches(trx: Trx, c: Ctx): Promise<Match[]> {
    const rules = await trx.selectFrom('compliance_rule').selectAll().where('status', '=', 'ACTIVE').execute();
    const out: Match[] = [];
    for (const r of rules) {
      if (!r.stages.includes(c.stage)) continue;
      if (r.effective_from && c.businessDate < r.effective_from) continue;
      if (r.effective_to && c.businessDate > r.effective_to) continue;
      const k = r.conditions as z.infer<typeof S.Conditions>;
      if (k.propertyIds?.length && !k.propertyIds.includes(c.propertyId)) continue;
      if (k.residency && k.residency !== c.residency) continue;
      if (k.nationalities?.length && !(c.nationality && k.nationalities.includes(c.nationality))) continue;
      if (k.excludeNationalities?.length && c.nationality && k.excludeNationalities.includes(c.nationality)) continue;
      if (k.minGuests && c.guests < k.minGuests) continue;
      if (k.minNights && c.nights < k.minNights) continue;
      out.push({ ruleId: r.id, name: r.name, action: r.action, message: r.message, messageUr: r.message_ur, documentTypes: r.document_types, taskTitle: r.task_title, approved: false });
    }
    return out.sort((a, b) => ORDER.indexOf(a.action) - ORDER.indexOf(b.action) || a.name.localeCompare(b.name));
  }
  /** Preview for the desk: what would apply to this kind of guest and stay. Changes nothing. */
  async check(i: z.infer<typeof S.Check>) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['business_date']).where('id', '=', i.propertyId).executeTakeFirst();
      if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
      const m = await this.matches(trx, { propertyId: i.propertyId, stage: i.stage, nationality: i.nationality ?? null, residency: i.residency ?? (!i.nationality || i.nationality === 'PK' ? 'RESIDENT' : 'NON_RESIDENT'), guests: i.guests, nights: i.nights, businessDate: p.business_date });
      return { hits: m.map(({ approved, ...x }) => (void approved, x)) };
    });
  }

  /** Refuses what is blocked; for what needs approval, accepts one from a holder of the approval permission (with a reason and a fresh second factor), or one given earlier for this booking. Returns the matches with `approved` set. */
  async enforce(trx: Trx, c: Ctx, userId: string, reservationId: string | null, approval: { reason: string } | undefined): Promise<{ matches: Match[]; approvedBy: string | null; approvalReason: string | null }> {
    const matches = await this.matches(trx, c);
    const blocked = matches.filter((m) => m.action === 'BLOCK_BOOKING');
    if (blocked.length) throw fail(422, 'COMPLIANCE_BLOCKED', blocked.map((b) => b.message).join(' '), { hits: blocked.map(this.pub) });
    const needs = matches.filter((m) => m.action === 'REQUIRE_APPROVAL');
    if (needs.length && reservationId) {
      const prior = await trx.selectFrom('compliance_hit').select('rule_id').where('reservation_id', '=', reservationId).where('approved_by', 'is not', null).where('rule_id', 'in', needs.map((n) => n.ruleId)).execute();
      for (const n of needs) if (prior.some((p) => p.rule_id === n.ruleId)) n.approved = true;
    }
    const open = needs.filter((n) => !n.approved);
    let approvedBy: string | null = null, approvalReason: string | null = null;
    if (open.length) {
      if (!approval) throw fail(403, 'COMPLIANCE_APPROVAL_REQUIRED', open.map((o) => o.message).join(' '), { overridable: true, hits: open.map(this.pub) });
      if ((await this.authz.check(userId, { permission: 'compliance.approve', scope: { propertyId: c.propertyId } })).effect !== 'ALLOW') throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'This action needs the "compliance.approve" permission' });
      const m = currentTenant().mfaVerifiedAt;
      if (!m || this.clock.now() - m.getTime() > FRESH_MFA_MS) throw new ForbiddenException({ code: 'MFA_REQUIRED', message: 'Verify your second factor (step-up) to perform this action' });
      approvedBy = userId; approvalReason = approval.reason;
      for (const o of open) o.approved = true;
    }
    return { matches, approvedBy, approvalReason };
  }
  private pub = (m: Match) => ({ ruleId: m.ruleId, name: m.name, action: m.action, message: m.message, messageUr: m.messageUr });

  /** Writes down what matched (once per booking, rule and stage), creates the tasks, and returns what to show the user. */
  async record(trx: Trx, c: Ctx, userId: string, reservationId: string, e: { matches: Match[]; approvedBy: string | null; approvalReason: string | null }) {
    for (const m of e.matches) {
      const ins = await trx.insertInto('compliance_hit').values({ tenant_id: currentTenant().tenantId, property_id: c.propertyId, reservation_id: reservationId, rule_id: m.ruleId, rule_name: m.name, stage: c.stage, action: m.action, message: m.message, nationality: c.nationality,
        approved_by: m.action === 'REQUIRE_APPROVAL' && e.approvedBy ? e.approvedBy : null, approval_reason: m.action === 'REQUIRE_APPROVAL' && e.approvedBy ? e.approvalReason : null, created_by: userId } as never)
        .onConflict((oc) => oc.columns(['tenant_id', 'reservation_id', 'rule_id', 'stage']).doNothing()).returning('id').executeTakeFirst();
      if (ins) await this.audit.record(trx, { action: 'compliance.hit', resourceType: 'reservation', resourceId: reservationId, propertyId: c.propertyId, after: { rule: m.name, action: m.action, stage: c.stage, approved: m.approved }, reasonCode: 'COMPLIANCE', note: e.approvalReason ?? undefined });
      if (m.action === 'REQUIRE_TASK') await trx.insertInto('compliance_task').values({ tenant_id: currentTenant().tenantId, property_id: c.propertyId, reservation_id: reservationId, rule_id: m.ruleId, title: m.taskTitle ?? m.name, due_date: c.businessDate } as never)
        .onConflict((oc) => oc.columns(['tenant_id', 'reservation_id', 'rule_id']).doNothing()).execute();
    }
    if (e.matches.length) await this.outbox.publish(trx, { aggregateType: 'reservation', aggregateId: reservationId, eventType: 'ComplianceRulesMatched', propertyId: c.propertyId, payload: { reservationId, stage: c.stage, rules: e.matches.map((m) => ({ id: m.ruleId, action: m.action })) } });
    return e.matches.map((m) => ({ ...this.pub(m), approved: m.approved, documentTypes: m.documentTypes }));
  }

  /** At check-in: the primary guest must be registered with one of the accepted ID types. */
  assertDocuments(matches: Match[], primaryIdType: string) {
    for (const m of matches) if (m.action === 'REQUIRE_DOCUMENT' && !m.documentTypes.includes(primaryIdType)) throw fail(422, 'DOCUMENT_REQUIRED', `${m.message} Register the main guest with: ${m.documentTypes.join(' or ')}.`, { hits: [this.pub(m)], accepted: m.documentTypes });
  }

  // ───────────── reading ─────────────
  async forReservation(propertyId: string, reservationId: string) {
    return this.tdb.tx(async (trx) => {
      const hits = await trx.selectFrom('compliance_hit').selectAll().where('property_id', '=', propertyId).where('reservation_id', '=', reservationId).orderBy('created_at').execute();
      const tasks = await trx.selectFrom('compliance_task').selectAll().where('property_id', '=', propertyId).where('reservation_id', '=', reservationId).orderBy('created_at').execute();
      return { hits: hits.map((h) => ({ rule: h.rule_name, stage: h.stage, action: h.action, message: h.message, approved: !!h.approved_by, approvalReason: h.approval_reason, at: h.created_at })),
        tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, dueDate: t.due_date, note: t.note })) };
    });
  }
  async tasks(propertyId: string, status: 'OPEN' | 'DONE') {
    return this.tdb.tx(async (trx) => {
      const rows = await sql<{ id: string; title: string; status: string; due_date: string | null; note: string | null; confirmation_no: string; guest: string; nationality: string | null; arrival: string | null }>`
        SELECT t.id, t.title, t.status, t.due_date::text, t.note, r.confirmation_no, g.full_name AS guest, g.nationality, (SELECT min(l.arrival)::text FROM reservation_room l WHERE l.tenant_id = r.tenant_id AND l.reservation_id = r.id) AS arrival
        FROM compliance_task t JOIN reservation r ON r.tenant_id = t.tenant_id AND r.id = t.reservation_id JOIN guest g ON g.tenant_id = r.tenant_id AND g.id = r.guest_id
        WHERE t.tenant_id = ${currentTenant().tenantId} AND t.property_id = ${propertyId} AND t.status = ${status} ORDER BY t.due_date NULLS LAST, t.created_at LIMIT 200`.execute(trx);
      return { items: rows.rows.map((r) => ({ id: r.id, title: r.title, status: r.status, dueDate: r.due_date, note: r.note, confirmationNo: r.confirmation_no, guest: r.guest, nationality: r.nationality, arrival: r.arrival })) };
    });
  }
  async completeTask(propertyId: string, id: string, userId: string, note: string | null | undefined) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.updateTable('compliance_task').set({ status: 'DONE', completed_by: userId, completed_at: new Date(this.clock.now()), note: note ?? null } as never).where('id', '=', id).where('property_id', '=', propertyId).where('status', '=', 'OPEN').returning(['id', 'title']).executeTakeFirst();
      if (!r) throw fail(409, 'NOT_OPEN', 'Task not found or already done');
      await this.audit.record(trx, { action: 'compliance.task_done', resourceType: 'compliance_task', resourceId: id, propertyId, note: note ?? undefined });
      return { id, status: 'DONE' };
    });
  }
}
