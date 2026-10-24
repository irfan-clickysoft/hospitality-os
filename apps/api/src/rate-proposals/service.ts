import { randomBytes } from 'node:crypto';
import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { DocumentsService } from '../documents/documents.service.js';
import { mediaUrl } from '../media/media.service.js';
import { currentTenant, runWithTenant } from '../tenancy/tenant-context.js';
import { DEFAULT_BILLING_STEPS, DEFAULT_FACILITIES, DEFAULT_INTRO, DEFAULT_NOTES, DEFAULT_TERMS, fill } from './defaults.js';
import { renderProposal } from './render.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
const TOKEN = /^[0-9a-f]{32}-[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const toUuid = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
type Trx = Parameters<Parameters<TenantDb['tx']>[0]>[0];

/** Corporate rate proposals: the hotel's rates for a company by room category and number of guests, with what is included, the terms, how to book and bill, and room photos. */
@Injectable()
export class RateProposalsService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(DocumentsService) private readonly docs: DocumentsService) {}

  /** What a new proposal starts from (Sunset BnB's own wording), with the hotel's name filled in. */
  async defaults(propertyId: string) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['name', 'business_date', 'currency']).where('id', '=', propertyId).executeTakeFirst();
      if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
      const yr = Number(p.business_date.slice(0, 4));
      return { currency: p.currency, issuedOn: p.business_date, validFrom: `${yr}-01-01`, validTo: `${yr}-11-30`, title: `Corporate Room Rates Proposal for ${yr}`, intro: fill(DEFAULT_INTRO, p.name), notes: DEFAULT_NOTES.map((x) => fill(x, p.name)),
        facilities: DEFAULT_FACILITIES.map((x) => fill(x, p.name)), terms: DEFAULT_TERMS.map((x) => fill(x, p.name)), billing: { steps: DEFAULT_BILLING_STEPS } };
    });
  }

  private async load(trx: Trx, propertyId: string, id: string) {
    const q = await trx.selectFrom('rate_proposal').selectAll().where('id', '=', id).where('property_id', '=', propertyId).executeTakeFirst();
    if (!q) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Proposal not found' });
    const rows = await trx.selectFrom('rate_proposal_row').selectAll().where('proposal_id', '=', id).orderBy('sort_order').execute();
    return { q, rows };
  }
  private view(q: Awaited<ReturnType<RateProposalsService['load']>>['q'], rows: Awaited<ReturnType<RateProposalsService['load']>>['rows']) {
    const m = (v: string | null) => (v === null ? null : Money.ofMinor(BigInt(v), q.currency).toDecimalString());
    return { id: q.id, number: q.number, reference: q.reference, status: q.status, companyId: q.company_id, companyName: q.company_name, attnName: q.attn_name, attnTitle: q.attn_title, issuedOn: q.issued_on, validFrom: q.valid_from, validTo: q.valid_to, title: q.title, intro: q.intro,
      notes: q.notes as string[], facilities: q.facilities as string[], terms: q.terms as string[], billing: q.billing as { contactName?: string | null; phone?: string | null; email?: string | null; steps: string[] }, signatory: q.signatory, withPhotos: q.with_photos, currency: q.currency,
      rows: rows.map((r) => ({ id: r.id, label: r.label, roomTypeId: r.room_type_id, p1: m(r.p1), p2: m(r.p2), p3: m(r.p3), p4: m(r.p4) })), version: q.version, sentAt: q.sent_at, views: q.views, createdAt: q.created_at };
  }

  async list(propertyId: string, q: z.infer<typeof S.ListQuery>) {
    return this.tdb.tx(async (trx) => {
      let qb = trx.selectFrom('rate_proposal').selectAll().where('property_id', '=', propertyId).orderBy('created_at', 'desc').limit(200);
      if (q.status === 'OPEN') qb = qb.where('status', 'in', ['DRAFT', 'SENT']); else if (q.status !== 'ALL') qb = qb.where('status', '=', q.status);
      if (q.q) { const like = `%${q.q.replace(/[%_\\]/g, '\\$&')}%`; qb = qb.where((eb) => eb.or([eb('company_name', 'ilike', like), eb('number', 'ilike', like), eb('reference', 'ilike', like)])); }
      return { items: (await qb.execute()).map((r) => ({ id: r.id, number: r.number, reference: r.reference, status: r.status, companyName: r.company_name, validFrom: r.valid_from, validTo: r.valid_to, views: r.views, sentAt: r.sent_at })) };
    });
  }
  async get(propertyId: string, id: string) { return this.tdb.tx(async (trx) => { const { q, rows } = await this.load(trx, propertyId, id); return this.view(q, rows); }); }

  private async write(trx: Trx, propertyId: string, id: string, i: z.infer<typeof S.ProposalBody>, cur: string) {
    for (const r of i.rows) if (r.roomTypeId && !(await trx.selectFrom('room_type').select('id').where('id', '=', r.roomTypeId).where('property_id', '=', propertyId).executeTakeFirst())) throw fail(422, 'REFERENCE_INVALID', 'A room type in the table was not found');
    if (i.companyId && !(await trx.selectFrom('company').select('id').where('id', '=', i.companyId).executeTakeFirst())) throw fail(422, 'REFERENCE_INVALID', 'Company not found');
    const minor = (v: string | null | undefined) => (v ? Money.parse(v, cur).minor.toString() : null);
    await trx.deleteFrom('rate_proposal_row').where('proposal_id', '=', id).execute();
    await trx.insertInto('rate_proposal_row').values(i.rows.map((r, k) => ({ tenant_id: currentTenant().tenantId, proposal_id: id, sort_order: k + 1, label: r.label, room_type_id: r.roomTypeId ?? null, p1: minor(r.p1), p2: minor(r.p2), p3: minor(r.p3), p4: minor(r.p4) }) as never)).execute();
    return { reference: i.reference || null, company_id: i.companyId ?? null, company_name: i.companyName, attn_name: i.attnName || null, attn_title: i.attnTitle || null, valid_from: i.validFrom, valid_to: i.validTo, title: i.title || null, intro: i.intro || null,
      notes: JSON.stringify(i.notes), facilities: JSON.stringify(i.facilities), terms: JSON.stringify(i.terms), billing: JSON.stringify({ contactName: i.billing.contactName || null, phone: i.billing.phone || null, email: i.billing.email || null, steps: i.billing.steps }),
      signatory: i.signatory || null, with_photos: i.withPhotos };
  }
  async create(propertyId: string, userId: string, i: z.infer<typeof S.ProposalBody>) {
    return this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select(['code', 'business_date', 'currency']).where('id', '=', propertyId).executeTakeFirstOrThrow();
      const seq = (await sql<{ v: string }>`INSERT INTO property_counter (tenant_id, property_id, name, value) VALUES (${currentTenant().tenantId}, ${propertyId}, 'rate_proposal', 1)
        ON CONFLICT (tenant_id, property_id, name) DO UPDATE SET value = property_counter.value + 1 RETURNING value::text AS v`.execute(trx)).rows[0]!.v;
      const number = `RP-${p.code}-${p.business_date.slice(2, 4)}${seq.padStart(4, '0')}`;
      const id = (await trx.insertInto('rate_proposal').values({ tenant_id: currentTenant().tenantId, property_id: propertyId, number, company_name: i.companyName, issued_on: i.issuedOn ?? p.business_date, valid_from: i.validFrom, valid_to: i.validTo, currency: p.currency, created_by: userId } as never).returning('id').executeTakeFirstOrThrow()).id;
      await trx.updateTable('rate_proposal').set(await this.write(trx, propertyId, id, i, p.currency) as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'rate_proposal.create', resourceType: 'rate_proposal', resourceId: id, propertyId, after: { number, company: i.companyName } });
      const r = await this.load(trx, propertyId, id); return this.view(r.q, r.rows);
    });
  }
  async update(propertyId: string, id: string, i: z.infer<typeof S.UpdateProposal>) {
    return this.tdb.tx(async (trx) => {
      const { q } = await this.load(trx, propertyId, id);
      if (q.version !== i.version) throw fail(412, 'VERSION_CONFLICT', 'Someone else changed this proposal. Reload it and try again.');
      const set = await this.write(trx, propertyId, id, i, q.currency);
      await trx.updateTable('rate_proposal').set({ ...set, ...(i.issuedOn ? { issued_on: i.issuedOn } : {}), updated_at: sql`now()`, version: sql`version + 1` } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'rate_proposal.update', resourceType: 'rate_proposal', resourceId: id, propertyId });
      const r = await this.load(trx, propertyId, id); return this.view(r.q, r.rows);
    });
  }
  /** A new draft with the same rates and wording (for the next company or the next year). */
  async duplicate(propertyId: string, userId: string, id: string) {
    const src = await this.get(propertyId, id);
    const { id: _i, number: _n, status: _s, version: _v, sentAt: _a, views: _w, createdAt: _c, rows, ...rest } = src; void [_i, _n, _s, _v, _a, _w, _c];
    return this.create(propertyId, userId, { ...rest, reference: null, companyId: null, issuedOn: undefined, rows: rows.map(({ id: _r, ...r }) => r) } as never);
  }
  async archive(propertyId: string, id: string) {
    return this.tdb.tx(async (trx) => { await this.load(trx, propertyId, id); await trx.updateTable('rate_proposal').set({ status: 'ARCHIVED', updated_at: sql`now()` } as never).where('id', '=', id).execute(); await this.audit.record(trx, { action: 'rate_proposal.archive', resourceType: 'rate_proposal', resourceId: id, propertyId }); const r = await this.load(trx, propertyId, id); return this.view(r.q, r.rows); });
  }

  /** Makes (or reuses) the private link and marks the proposal as sent. */
  async linkFor(propertyId: string, userId: string, id: string, origin?: string) {
    const tenantId = currentTenant().tenantId;
    return this.tdb.tx(async (trx) => {
      const { q } = await this.load(trx, propertyId, id);
      if (q.status === 'ARCHIVED') throw fail(409, 'WRONG_STATE', 'This proposal is archived');
      await trx.insertInto('document_link').values({ tenant_id: tenantId, property_id: propertyId, kind: 'RATE_PROPOSAL', ref_id: id, token: `${tenantId.replace(/-/g, '')}-${randomBytes(16).toString('hex')}`, created_by: userId } as never)
        .onConflict((oc) => oc.columns(['tenant_id', 'kind', 'ref_id']).where('revoked_at', 'is', null).doNothing()).execute();
      const l = await trx.selectFrom('document_link').select(['token']).where('kind', '=', 'RATE_PROPOSAL').where('ref_id', '=', id).where('revoked_at', 'is', null).executeTakeFirstOrThrow();
      if (q.status === 'DRAFT') { await trx.updateTable('rate_proposal').set({ status: 'SENT', sent_at: sql`now()` } as never).where('id', '=', id).execute(); await this.audit.record(trx, { action: 'rate_proposal.send', resourceType: 'rate_proposal', resourceId: id, propertyId }); }
      return { token: l.token, url: `${(origin ?? process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/v1/guest/rates/${l.token}` };
    });
  }

  private async page(trx: Trx, propertyId: string, id: string, nonce: string) {
    const { q, rows } = await this.load(trx, propertyId, id); const v = this.view(q, rows);
    const [brand, p] = await Promise.all([this.docs.brand(trx, propertyId), trx.selectFrom('property').select(['name']).where('id', '=', propertyId).executeTakeFirstOrThrow()]);
    const tenantId = currentTenant().tenantId; const photos = new Map<string, string[]>();
    if (v.withPhotos) {
      const ids = [...new Set(rows.map((r) => r.room_type_id).filter(Boolean) as string[])];
      if (ids.length) for (const m of await trx.selectFrom('room_type_media').select(['room_type_id', 'file_name']).where('room_type_id', 'in', ids).where('kind', '=', 'IMAGE').orderBy('sort_order').orderBy('created_at').execute()) {
        const list = photos.get(m.room_type_id) ?? []; if (list.length < 6) { list.push(mediaUrl(tenantId, m.file_name, '')); photos.set(m.room_type_id, list); }
      }
    }
    return renderProposal(brand, { ...v, property: p.name, rows: v.rows.map((r) => ({ ...r, photos: r.roomTypeId ? photos.get(r.roomTypeId) ?? [] : [] })) }, nonce);
  }
  async html(propertyId: string, id: string, nonce: string) { return this.tdb.tx((trx) => this.page(trx, propertyId, id, nonce)); }
  async htmlByToken(token: string, nonce: string): Promise<string | null> {
    if (!TOKEN.test(token) || !UUID.test(toUuid(token.slice(0, 32)))) return null;
    return runWithTenant({ tenantId: toUuid(token.slice(0, 32)) }, () => this.tdb.tx(async (trx) => {
      const l = await trx.selectFrom('document_link').selectAll().where('token', '=', token).where('kind', '=', 'RATE_PROPOSAL').where('revoked_at', 'is', null).executeTakeFirst();
      if (!l) return null;
      const p = await trx.selectFrom('rate_proposal').select(['status']).where('id', '=', l.ref_id).executeTakeFirst();
      if (!p || p.status === 'ARCHIVED') return null;
      await trx.updateTable('document_link').set({ views: sql`views + 1`, last_viewed_at: sql`now()` } as never).where('id', '=', l.id).execute();
      await trx.updateTable('rate_proposal').set({ views: sql`views + 1`, viewed_at: sql`now()` } as never).where('id', '=', l.ref_id).execute();
      return this.page(trx, l.property_id, l.ref_id, nonce);
    }));
  }
}
