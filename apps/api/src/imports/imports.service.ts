import { HttpException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { CompaniesService, type Trx } from '../companies/companies.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { normalizePhone } from '../guests/phone.js';
import { GuestsService } from '../guests/guests.service.js';
import { residencyOf } from '../guests/schemas.js';
import { IdempotencyService, hashRequest } from '../idempotency/idempotency.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { nationalityCode } from './nationality.js';
import type * as CS from '../companies/schemas.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string, extra: object = {}) => new HttpException({ code, message, ...extra }, status);
export type RowStatus = 'NEW' | 'EXISTS' | 'DUPLICATE_IN_FILE' | 'INVALID';
export interface RowResult { row: number; status: RowStatus; errors: string[]; existing?: { id: string; name: string }; action?: 'CREATED' | 'FILLED' | 'SKIPPED' }
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TRUE = /^(1|y|yes|true|vip|x|✓)$/i;
/** Excel strips the leading zero of 0300-1234567. */
function cleanPhone(raw: string): string { const d = raw.replace(/[^\d+]/g, ''); return /^3\d{9}$/.test(d) ? `0${d}` : raw; }

@Injectable()
export class ImportsService {
  constructor(
    @Inject(TenantDb) private readonly tdb: TenantDb,
    @Inject(GuestsService) private readonly guests: GuestsService,
    @Inject(CompaniesService) private readonly companies: CompaniesService,
    @Inject(IdempotencyService) private readonly idem: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ───────────── guests ─────────────
  private async classifyGuests(trx: Trx, rows: z.infer<typeof S.GuestImport>['rows']) {
    const out: Array<RowResult & { clean?: { fullName: string; phone: string | null; email: string | null; nationality: string | null; vip: boolean; notes: string | null; norm: string | null } }> = [];
    const seenPhone = new Map<string, number>(), seenEmail = new Map<string, number>();
    const norms = new Set<string>(), emails = new Set<string>();
    const parsed = rows.map((r, i) => {
      const errors: string[] = [];
      const name = r.fullName.replace(/\s+/g, ' ');
      if (name.length < 2) errors.push('NAME_REQUIRED'); else if (name.length > 160) errors.push('NAME_TOO_LONG');
      const phoneRaw = r.phone ? cleanPhone(r.phone) : '';
      const norm = phoneRaw ? normalizePhone(phoneRaw) : null;
      if (phoneRaw && !norm) errors.push('PHONE_INVALID');
      const email = r.email.toLowerCase();
      if (email && (!EMAIL.test(email) || email.length > 254)) errors.push('EMAIL_INVALID');
      const nat = nationalityCode(r.nationality);
      if (nat === null) errors.push('NATIONALITY_UNKNOWN');
      if (r.notes.length > 2000) errors.push('NOTES_TOO_LONG');
      if (norm) norms.add(norm);
      if (email) emails.add(email);
      return { i, errors, name, phone: phoneRaw || null, norm, email: email || null, nat: nat ?? null, vip: TRUE.test(r.vip), notes: r.notes || null };
    });
    const existing = norms.size || emails.size ? await trx.selectFrom('guest').select(['id', 'full_name', 'phone_norm', 'email', 'nationality', 'notes'])
      .where((eb) => eb.or([...(norms.size ? [eb('phone_norm', 'in', [...norms])] : []), ...(emails.size ? [eb('email', 'in', [...emails])] : [])])).execute() : [];
    for (const p of parsed) {
      if (p.errors.length) { out.push({ row: p.i + 1, status: 'INVALID', errors: p.errors }); continue; }
      const ex = existing.find((g) => (p.norm && g.phone_norm === p.norm) || (p.email && g.email === p.email));
      const dupAt = (p.norm && seenPhone.get(p.norm)) || (p.email && seenEmail.get(p.email)) || 0;
      if (dupAt) { out.push({ row: p.i + 1, status: 'DUPLICATE_IN_FILE', errors: [`SAME_AS_ROW_${dupAt}`] }); continue; }
      if (p.norm) seenPhone.set(p.norm, p.i + 1); if (p.email) seenEmail.set(p.email, p.i + 1);
      const clean = { fullName: p.name, phone: p.phone, email: p.email, nationality: p.nat, vip: p.vip, notes: p.notes, norm: p.norm };
      out.push(ex ? { row: p.i + 1, status: 'EXISTS', errors: [], existing: { id: ex.id, name: ex.full_name }, clean } : { row: p.i + 1, status: 'NEW', errors: [], clean });
    }
    return { out, existing };
  }
  private summary(rs: RowResult[]) {
    const c = { total: rs.length, new: 0, exists: 0, duplicateInFile: 0, invalid: 0 };
    for (const r of rs) { if (r.status === 'NEW') c.new++; else if (r.status === 'EXISTS') c.exists++; else if (r.status === 'DUPLICATE_IN_FILE') c.duplicateInFile++; else c.invalid++; }
    return c;
  }
  async previewGuests(i: z.infer<typeof S.GuestImport>) {
    return this.tdb.tx(async (trx) => { const { out } = await this.classifyGuests(trx, i.rows); return { summary: this.summary(out), rows: out.map(({ clean, ...r }) => (void clean, r)) }; });
  }
  async commitGuests(userId: string, key: string, i: z.infer<typeof S.GuestImport>) {
    const hash = hashRequest('POST', '/v1/imports/guests', i);
    return this.tdb.tx(async (trx) => {
      const r = await this.idem.run(trx, key, hash, async () => ({ statusCode: 201, body: await this.commitGuestsIn(trx, userId, i) }));
      return { ...r.body, replayed: r.replayed };
    });
  }
  private async commitGuestsIn(trx: Trx, userId: string, i: z.infer<typeof S.GuestImport>) {
    const { out, existing } = await this.classifyGuests(trx, i.rows);      // never trust an earlier preview: classify again, inside this transaction
    let created = 0, filled = 0;
    for (const r of out) {
      if (r.status === 'NEW' && r.clean) {
        await this.guests.createIn(trx, { fullName: r.clean.fullName, phone: r.clean.phone, email: r.clean.email, nationality: r.clean.nationality, vip: r.clean.vip, notes: r.clean.notes, allowDuplicate: true });
        r.action = 'CREATED'; created++;
      } else if (r.status === 'EXISTS' && r.clean && i.onExisting === 'FILL_BLANKS') {
        const ex = existing.find((g) => g.id === r.existing!.id)!;
        const set: Record<string, unknown> = {};
        if (!ex.email && r.clean.email) set.email = r.clean.email;
        if (!ex.nationality && r.clean.nationality) { set.nationality = r.clean.nationality; set.residency = residencyOf(r.clean.nationality); }
        if (!ex.notes && r.clean.notes) set.notes = r.clean.notes;
        if (Object.keys(set).length) { await trx.updateTable('guest').set({ ...set, version: sql`version + 1` } as never).where('id', '=', ex.id).execute(); r.action = 'FILLED'; filled++; } else r.action = 'SKIPPED';
      } else r.action = 'SKIPPED';
    }
    const summary = { ...this.summary(out), created, filled };
    await this.audit.record(trx, { action: 'import.guests', resourceType: 'import', resourceId: currentTenant().tenantId, after: { ...summary, onExisting: i.onExisting }, note: `${created} guests created by import` });
    return { summary, rows: out.map(({ clean, ...r }) => (void clean, r)) };
  }

  // ───────────── companies ─────────────
  private async classifyCompanies(trx: Trx, rows: z.infer<typeof S.CompanyImport>['rows']) {
    const names = new Set<string>();
    const parsed = rows.map((r, i) => {
      const errors: string[] = [];
      const name = r.name.replace(/\s+/g, ' ');
      if (name.length < 2) errors.push('NAME_REQUIRED'); else if (name.length > 160) errors.push('NAME_TOO_LONG');
      if (r.contactEmail && !EMAIL.test(r.contactEmail)) errors.push('EMAIL_INVALID');
      let limit = '0';
      if (r.creditLimit) { const v = r.creditLimit.replace(/[,\s]/g, '').replace(/^(?:rs\.?|pkr)/i, ''); try { Money.parse(v, 'PKR'); if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) throw new Error(); limit = v; } catch { errors.push('CREDIT_LIMIT_INVALID'); } }
      let terms = 30;
      if (r.termsDays) { const n = Number(r.termsDays.replace(/\D/g, '')); if (!Number.isInteger(n) || n < 0 || n > 365 || !/\d/.test(r.termsDays)) errors.push('TERMS_INVALID'); else terms = n; }
      for (const [k, v, max] of [['NTN', r.ntn, 40], ['STRN', r.strn, 40], ['ADDRESS', r.address, 400], ['CONTACT', r.contactName, 120], ['PHONE', r.contactPhone, 40], ['NOTES', r.notes, 500]] as const) if (v.length > max) errors.push(`${k}_TOO_LONG`);
      if (name.length >= 2) names.add(name.toLowerCase());
      return { i, errors, name, r, limit, terms };
    });
    const existing = names.size ? await sql<{ id: string; name: string; key: string }>`SELECT id, name, lower(btrim(name)) AS key FROM company WHERE tenant_id = ${currentTenant().tenantId} AND status <> 'ARCHIVED' AND lower(btrim(name)) = ANY(${[...names]}::text[])`.execute(trx).then((x) => x.rows) : [];
    const seen = new Map<string, number>(); const out: Array<RowResult & { clean?: z.infer<typeof CS.CreateCompany> }> = [];
    for (const p of parsed) {
      if (p.errors.length) { out.push({ row: p.i + 1, status: 'INVALID', errors: p.errors }); continue; }
      const key = p.name.toLowerCase();
      const ex = existing.find((e) => e.key === key);
      if (ex) { out.push({ row: p.i + 1, status: 'EXISTS', errors: [], existing: { id: ex.id, name: ex.name } }); continue; }
      if (seen.has(key)) { out.push({ row: p.i + 1, status: 'DUPLICATE_IN_FILE', errors: [`SAME_AS_ROW_${seen.get(key)}`] }); continue; }
      seen.set(key, p.i + 1);
      out.push({ row: p.i + 1, status: 'NEW', errors: [], clean: { name: p.name, ntn: p.r.ntn || null, strn: p.r.strn || null, address: p.r.address || null, contactName: p.r.contactName || null, contactPhone: p.r.contactPhone || null,
        contactEmail: p.r.contactEmail || null, creditLimit: p.limit, termsDays: p.terms, notes: p.r.notes || null } });
    }
    return out;
  }
  async previewCompanies(i: z.infer<typeof S.CompanyImport>) {
    return this.tdb.tx(async (trx) => { const out = await this.classifyCompanies(trx, i.rows); return { summary: this.summary(out), rows: out.map(({ clean, ...r }) => (void clean, r)) }; });
  }
  async commitCompanies(userId: string, key: string, i: z.infer<typeof S.CompanyImport>) {
    const hash = hashRequest('POST', '/v1/imports/companies', i);
    return this.tdb.tx(async (trx) => {
      const r = await this.idem.run(trx, key, hash, async () => ({ statusCode: 201, body: await this.commitCompaniesIn(trx, userId, i) }));
      return { ...r.body, replayed: r.replayed };
    });
  }
  private async commitCompaniesIn(trx: Trx, userId: string, i: z.infer<typeof S.CompanyImport>) {
    const out = await this.classifyCompanies(trx, i.rows);
    if (out.some((r) => r.clean && r.clean.creditLimit !== '0')) this.companies.requireFreshMfa();     // credit is a second-factor decision, one company or two hundred
    let created = 0;
    for (const r of out) { if (r.status === 'NEW' && r.clean) { await this.companies.createIn(trx, userId, r.clean); r.action = 'CREATED'; created++; } else r.action = 'SKIPPED'; }
    const summary = { ...this.summary(out), created };
    await this.audit.record(trx, { action: 'import.companies', resourceType: 'import', resourceId: currentTenant().tenantId, after: summary, note: `${created} companies created by import` });
    return { summary, rows: out.map(({ clean, ...r }) => (void clean, r)) };
  }
}
void fail;
