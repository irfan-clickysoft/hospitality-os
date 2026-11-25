import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, HttpException, Inject, Injectable, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { DB } from '@hos/db';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { RequirePermission } from '../authz/decorators.js';
import { parse } from '../common/validate.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { FinanceService } from './finance.js';

type Trx = Transaction<DB>;
const ANY = { anyScope: true } as const;
const err = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-20');
const amount = z.string().trim().regex(/^-?\d{1,13}(\.\d{1,2})?$/, 'Use an amount like 15000 or 15000.50');
const uuid = z.string().uuid();
const WINDOW_DAYS = 5;

const Import = z.object({ bankId: uuid, filename: z.string().trim().max(200).optional(), csv: z.string().min(10).max(2_000_000) }).strict();
const LinesQ = z.object({ bankId: uuid, status: z.enum(['UNMATCHED', 'MATCHED', 'IGNORED']).optional(), from: date.optional(), to: date.optional() });
const LedgerQ = z.object({ bankId: uuid, to: date, around: date.optional() });
const MatchIn = z.object({ entryIds: z.array(uuid).min(1).max(50) }).strict();
const Reason = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
const Book = z.object({ kind: z.enum(['SUSPENSE', 'CHARGE']), note: z.string().trim().max(300).optional() }).strict();
const SummaryQ = z.object({ bankId: uuid, to: date, statementBalance: amount });
const ReconIn = z.object({ bankId: uuid, to: date, statementBalance: amount, note: z.string().trim().max(300).optional() }).strict();
const Allocate = z.object({ account: z.string().regex(/^[0-9]{4,8}$/), branchId: uuid.nullish(), reason: z.string().trim().min(5).max(300) }).strict();
const Assign = z.object({ userId: uuid.nullable(), note: z.string().trim().max(500).optional() }).strict();

// ---- statement file reading
function splitCsv(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? ''; const delim = (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? '\t' : (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = []; let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true; else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some((x) => x.trim())) rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim())) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}
const MON: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function parseDate(v: string): string | null {
  const s = v.trim().replace(/\s.*$/, '');
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (m) return s;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s); if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  m = /^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ,]*(\d{4})$/.exec(s); if (m && MON[m[2]!.toLowerCase()]) return `${m[3]}-${MON[m[2]!.toLowerCase()]}-${m[1]!.padStart(2, '0')}`;
  return null;
}
function parseMoney(v: string): bigint | null {
  let s = v.replace(/[,\s]/g, '').replace(/(DR|CR)$/i, ''); if (s === '' || s === '-') return 0n;
  let neg = false; if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); } if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [i, d = ''] = s.split('.'); const n = BigInt(i!) * 100n + BigInt(d.padEnd(2, '0')); return neg ? -n : n;
}
export interface ParsedLine { date: string; narration: string; reference: string | null; debit: bigint; credit: bigint; balance: bigint | null }
export function readStatement(csv: string): ParsedLine[] {
  const rows = splitCsv(csv.replace(/^﻿/, '')); if (rows.length < 2) throw err(400, 'STATEMENT_EMPTY', 'The file has no rows');
  const head = rows[0]!.map((h) => h.toLowerCase()); const find = (...names: string[]) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)));
  const iDate = (() => { const v = head.findIndex((h) => h.includes('value date')); return v >= 0 ? v : find('date'); })();
  const iNar = find('narration', 'description', 'particulars', 'details', 'remarks'); const iRef = find('reference', 'cheque', 'chq', 'instrument', 'transaction id', 'txn id', 'ref');
  const iDr = find('debit', 'withdrawal', 'paid out', 'money out'), iCr = find('credit', 'deposit', 'paid in', 'money in'); const iAmt = head.findIndex((h) => h === 'amount' || h.startsWith('amount')); const iBal = find('balance');
  if (iDate < 0 || (iDr < 0 && iCr < 0 && iAmt < 0)) throw err(400, 'STATEMENT_COLUMNS', 'The first row must name the columns: a date, a description, and debit and credit (or one signed amount).');
  const out: ParsedLine[] = [];
  rows.slice(1).forEach((r, n) => {
    const d = parseDate(r[iDate] ?? ''); if (!d) throw err(400, 'STATEMENT_ROW', `Row ${n + 2}: the date “${r[iDate] ?? ''}” is not readable. Use 2026-11-20 or 20/11/2026.`);
    let dr = 0n, cr = 0n;
    if (iDr >= 0 || iCr >= 0) { const a = iDr >= 0 ? parseMoney(r[iDr] ?? '') : 0n, b = iCr >= 0 ? parseMoney(r[iCr] ?? '') : 0n; if (a === null || b === null) throw err(400, 'STATEMENT_ROW', `Row ${n + 2}: an amount is not readable`); dr = a < 0n ? -a : a; cr = b < 0n ? -b : b; if (iAmt >= 0 && dr === 0n && cr === 0n) { const s = parseMoney(r[iAmt] ?? ''); if (s === null) throw err(400, 'STATEMENT_ROW', `Row ${n + 2}: an amount is not readable`); if (s < 0n) dr = -s; else cr = s; } }
    else { const s = parseMoney(r[iAmt] ?? ''); if (s === null) throw err(400, 'STATEMENT_ROW', `Row ${n + 2}: the amount is not readable`); if (s < 0n) dr = -s; else cr = s; }
    if (dr === 0n && cr === 0n) return;
    if (dr > 0n && cr > 0n) throw err(400, 'STATEMENT_ROW', `Row ${n + 2}: a row cannot be both a debit and a credit`);
    const bal = iBal >= 0 && (r[iBal] ?? '') !== '' ? parseMoney(r[iBal]!) : null;
    out.push({ date: d, narration: (iNar >= 0 ? r[iNar] ?? '' : '').slice(0, 400), reference: iRef >= 0 && r[iRef] ? r[iRef]!.slice(0, 120) : null, debit: dr, credit: cr, balance: bal });
  });
  if (!out.length) throw err(400, 'STATEMENT_EMPTY', 'The file has no money rows');
  return out;
}
const dayDiff = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);

/** Bank statements against the ledger: nothing is guessed. A line matches when exactly one ledger entry fits, or when a person chooses; what is left over is shown, not hidden. */
@Injectable()
export class ReconService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(FinanceService) private readonly fin: FinanceService) {}

  private async bank(trx: Trx, bankId: string) {
    const b = await trx.selectFrom('payment_account').select(['id', 'name', 'gl_account_id']).where('id', '=', bankId).where('kind', '=', 'BANK').executeTakeFirst();
    if (!b) throw err(404, 'NOT_FOUND', 'No such bank account'); if (!b.gl_account_id) throw err(409, 'BANK_NO_LEDGER', `The bank account “${b.name}” has no ledger account yet. Create it under Banks.`);
    return { id: b.id, name: b.name, glId: b.gl_account_id };
  }
  private async lockedTo(trx: Trx, bankId: string): Promise<string | null> {
    const r = await trx.selectFrom('bank_reconciliation').select(sql<string | null>`max(period_to)::text`.as('d')).where('payment_account_id', '=', bankId).where('status', '=', 'APPROVED').executeTakeFirst();
    return r?.d ?? null;
  }
  private async assertUnlocked(trx: Trx, bankId: string, d: string) { const l = await this.lockedTo(trx, bankId); if (l && d <= l) throw err(409, 'RECON_LOCKED', `Reconciliation was signed off up to ${l}; that line can no longer be changed.`); }

  async importStatement(userId: string, i: z.infer<typeof Import>) {
    const rows = readStatement(i.csv);
    return this.tdb.tx(async (trx) => {
      const b = await this.bank(trx, i.bankId); const seen = new Map<string, number>(); let added = 0;
      const batch = await trx.insertInto('bank_statement_batch').values({ tenant_id: currentTenant().tenantId, payment_account_id: b.id, filename: i.filename ?? null, lines_total: rows.length, lines_new: 0, imported_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      for (const r of rows) {
        const base = `${r.date}|${r.narration}|${r.reference ?? ''}|${r.debit}|${r.credit}|${r.balance ?? ''}`; const occ = seen.get(base) ?? 0; seen.set(base, occ + 1);
        const hash = createHash('sha256').update(`${base}|${occ}`).digest('hex');
        const ins = await sql`INSERT INTO bank_statement_line (tenant_id, batch_id, payment_account_id, value_date, narration, reference, debit_minor, credit_minor, balance_minor, line_hash)
          VALUES (${currentTenant().tenantId}, ${batch.id}, ${b.id}, ${r.date}::date, ${r.narration}, ${r.reference}, ${r.debit.toString()}, ${r.credit.toString()}, ${r.balance?.toString() ?? null}, ${hash}) ON CONFLICT (tenant_id, payment_account_id, line_hash) DO NOTHING`.execute(trx);
        if (Number(ins.numAffectedRows ?? 0) > 0) added++;
      }
      await trx.updateTable('bank_statement_batch').set({ lines_new: added } as never).where('id', '=', batch.id).execute();
      const matched = await this.autoMatch(trx, userId, b);
      await this.audit.record(trx, { action: 'finance.recon.import', resourceType: 'bank_statement_batch', resourceId: batch.id, after: { bank: b.name, rows: rows.length, added, autoMatched: matched } });
      return { batchId: batch.id, rows: rows.length, added, duplicates: rows.length - added, autoMatched: matched };
    });
  }

  private async candidates(trx: Trx, glId: string, from: string, to: string) {
    const r = await sql<{ id: string; date: string; d: string; c: string; no: string | null; narration: string; ref: string | null; desc: string | null; vid: string }>`
      SELECT e.id, e.posting_date::text AS date, e.debit_minor::text AS d, e.credit_minor::text AS c, v.voucher_no AS no, v.narration, l.reference AS ref, l.description AS desc, v.id AS vid
      FROM gl_entry e JOIN voucher v ON v.tenant_id = e.tenant_id AND v.id = e.voucher_id JOIN voucher_line l ON l.tenant_id = e.tenant_id AND l.id = e.line_id
      WHERE e.account_id = ${glId} AND e.posting_date BETWEEN ${from}::date AND ${to}::date AND NOT EXISTS (SELECT 1 FROM bank_match m WHERE m.gl_entry_id = e.id) ORDER BY e.posting_date, e.id`.execute(trx);
    return r.rows;
  }
  /** Matches only where exactly one ledger entry fits the amount and date window (or the statement's reference points at exactly one). */
  private async autoMatch(trx: Trx, userId: string, b: { id: string; glId: string }): Promise<number> {
    const lines = await trx.selectFrom('bank_statement_line').selectAll().where('payment_account_id', '=', b.id).where('status', '=', 'UNMATCHED').orderBy('value_date').execute();
    if (!lines.length) return 0;
    const lo = lines[0]!.value_date, hi = lines[lines.length - 1]!.value_date; const pad = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
    const pool = await this.candidates(trx, b.glId, pad(String(lo), -WINDOW_DAYS), pad(String(hi), WINDOW_DAYS)); const used = new Set<string>(); let n = 0;
    for (const l of lines) {
      if (await this.lockedTo(trx, b.id).then((x) => !!x && String(l.value_date) <= x)) continue;
      const inn = BigInt(l.credit_minor) > 0n; const amt = inn ? BigInt(l.credit_minor) : BigInt(l.debit_minor);
      let c = pool.filter((e) => !used.has(e.id) && BigInt(inn ? e.d : e.c) === amt && dayDiff(e.date, String(l.value_date)) <= WINDOW_DAYS);
      if (c.length > 1 && l.reference) { const r = l.reference.toLowerCase(); const byRef = c.filter((e) => [e.ref, e.no, e.narration, e.desc].some((t) => t && t.toLowerCase().includes(r))); if (byRef.length === 1) c = byRef; }
      if (c.length !== 1) continue;
      used.add(c[0]!.id);
      await trx.insertInto('bank_match').values({ tenant_id: currentTenant().tenantId, statement_line_id: l.id, gl_entry_id: c[0]!.id, amount_minor: amt.toString(), match_type: 'AUTO', matched_by: userId } as never).execute();
      await trx.updateTable('bank_statement_line').set({ status: 'MATCHED' } as never).where('id', '=', l.id).execute(); n++;
    }
    return n;
  }
  async autoMatchNow(userId: string, bankId: string) { return this.tdb.tx(async (trx) => ({ matched: await this.autoMatch(trx, userId, await this.bank(trx, bankId)) })); }

  async lines(q: z.infer<typeof LinesQ>) {
    return this.tdb.tx(async (trx) => {
      const b = await this.bank(trx, q.bankId); const cur = (await this.fin.settings(trx)).base_currency; const f = (v: string | bigint) => Money.ofMinor(BigInt(v), cur).toDecimalString();
      let x = trx.selectFrom('bank_statement_line').selectAll().where('payment_account_id', '=', b.id).orderBy('value_date', 'desc').orderBy('id').limit(500);
      if (q.status) x = x.where('status', '=', q.status); if (q.from) x = x.where('value_date', '>=', q.from); if (q.to) x = x.where('value_date', '<=', q.to);
      const rows = await x.execute(); const ids = rows.map((r) => r.id);
      const ms = ids.length ? await sql<{ line: string; no: string | null; type: string }>`SELECT m.statement_line_id AS line, v.voucher_no AS no, m.match_type AS type FROM bank_match m JOIN gl_entry e ON e.id = m.gl_entry_id JOIN voucher v ON v.tenant_id = e.tenant_id AND v.id = e.voucher_id WHERE m.statement_line_id = ANY(${ids}::uuid[])`.execute(trx) : { rows: [] as Array<{ line: string; no: string | null; type: string }> };
      const sus = ids.length ? await trx.selectFrom('bank_suspense_item').select(['statement_line_id', 'status']).where('statement_line_id', 'in', ids).execute() : [];
      return { locked: await this.lockedTo(trx, b.id), items: rows.map((r) => ({ id: r.id, date: r.value_date, narration: r.narration, reference: r.reference, in: f(r.credit_minor), out: f(r.debit_minor), direction: BigInt(r.credit_minor) > 0n ? 'IN' : 'OUT', balance: r.balance_minor === null ? null : f(r.balance_minor), status: r.status, note: r.note,
        matchedTo: ms.rows.filter((m) => m.line === r.id).map((m) => `${m.no ?? ''}${m.type === 'BOOKED' ? ' (booked from the statement)' : ''}`), suspense: sus.find((s) => s.statement_line_id === r.id)?.status ?? null })) };
    });
  }
  async ledger(q: z.infer<typeof LedgerQ>) {
    return this.tdb.tx(async (trx) => {
      const b = await this.bank(trx, q.bankId); const cur = (await this.fin.settings(trx)).base_currency; const f = (v: string) => Money.ofMinor(BigInt(v), cur).toDecimalString();
      const from = new Date(Date.parse(q.to) - 90 * 86_400_000).toISOString().slice(0, 10);
      return { items: (await this.candidates(trx, b.glId, from, q.to)).map((e) => ({ id: e.id, date: e.date, voucherNo: e.no, narration: e.narration, reference: e.ref, in: f(e.d), out: f(e.c) })) };
    });
  }
  private async lineFor(trx: Trx, id: string) { const l = await trx.selectFrom('bank_statement_line').selectAll().where('id', '=', id).executeTakeFirst(); if (!l) throw err(404, 'NOT_FOUND', 'No such statement line'); await this.assertUnlocked(trx, l.payment_account_id, String(l.value_date)); return l; }
  async match(userId: string, id: string, entryIds: string[]) {
    return this.tdb.tx(async (trx) => {
      const l = await this.lineFor(trx, id); if (l.status !== 'UNMATCHED') throw err(409, 'NOT_UNMATCHED', 'This line is already matched or set aside');
      const b = await this.bank(trx, l.payment_account_id); const inn = BigInt(l.credit_minor) > 0n; const want = inn ? BigInt(l.credit_minor) : BigInt(l.debit_minor);
      const es = await trx.selectFrom('gl_entry').select(['id', 'account_id', 'debit_minor', 'credit_minor']).where('id', 'in', entryIds).execute();
      if (es.length !== new Set(entryIds).size) throw err(404, 'NOT_FOUND', 'One of the ledger entries does not exist');
      let sum = 0n; for (const e of es) { if (e.account_id !== b.glId) throw err(400, 'WRONG_ACCOUNT', 'That entry is not on this bank account'); const v = BigInt(inn ? e.debit_minor : e.credit_minor); if (v === 0n) throw err(400, 'WRONG_DIRECTION', 'A receipt on the statement matches money in, a payment matches money out'); sum += v; }
      if (await trx.selectFrom('bank_match').select('id').where('gl_entry_id', 'in', entryIds).executeTakeFirst()) throw err(409, 'ALREADY_MATCHED', 'One of those entries is already matched');
      if (sum !== want) throw err(409, 'AMOUNT_MISMATCH', `The entries add up to ${Money.ofMinor(sum, 'PKR').toDecimalString()} but the statement line is ${Money.ofMinor(want, 'PKR').toDecimalString()}`);
      await trx.insertInto('bank_match').values(es.map((e) => ({ tenant_id: currentTenant().tenantId, statement_line_id: id, gl_entry_id: e.id, amount_minor: (inn ? e.debit_minor : e.credit_minor).toString(), match_type: 'MANUAL', matched_by: userId })) as never).execute();
      await trx.updateTable('bank_statement_line').set({ status: 'MATCHED' } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'finance.recon.match', resourceType: 'bank_statement_line', resourceId: id, after: { entries: entryIds.length } });
      return { status: 'MATCHED' };
    });
  }
  async unmatch(userId: string, id: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      const l = await this.lineFor(trx, id); if (l.status !== 'MATCHED' && l.status !== 'IGNORED') throw err(409, 'NOT_MATCHED', 'This line is not matched');
      if ((await trx.selectFrom('bank_match').select('match_type').where('statement_line_id', '=', id).where('match_type', '=', 'BOOKED').executeTakeFirst())) throw err(409, 'BOOKED', 'This line was booked from the statement. Reverse its voucher instead.');
      await trx.deleteFrom('bank_match').where('statement_line_id', '=', id).execute(); await trx.updateTable('bank_statement_line').set({ status: 'UNMATCHED', note: null } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'finance.recon.unmatch', resourceType: 'bank_statement_line', resourceId: id, after: { reason } });
      return { status: 'UNMATCHED' };
    });
  }
  async ignore(userId: string, id: string, reason: string) {
    return this.tdb.tx(async (trx) => {
      const l = await this.lineFor(trx, id); if (l.status !== 'UNMATCHED') throw err(409, 'NOT_UNMATCHED', 'This line is already matched or set aside');
      await trx.updateTable('bank_statement_line').set({ status: 'IGNORED', note: reason } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'finance.recon.ignore', resourceType: 'bank_statement_line', resourceId: id, after: { reason } });
      return { status: 'IGNORED' };
    });
  }

  /** A line the books know nothing about. Money in goes to the unallocated queue (no guess at the branch or the income); a bank charge goes to the charges account. */
  async book(userId: string, id: string, i: z.infer<typeof Book>) {
    return this.tdb.tx(async (trx) => {
      const l = await this.lineFor(trx, id); if (l.status !== 'UNMATCHED') throw err(409, 'NOT_UNMATCHED', 'This line is already matched or set aside');
      const b = await this.bank(trx, l.payment_account_id); const inn = BigInt(l.credit_minor) > 0n; const amt = inn ? BigInt(l.credit_minor) : BigInt(l.debit_minor); const d = String(l.value_date);
      if (i.kind === 'SUSPENSE' && !inn) throw err(400, 'VALIDATION_FAILED', 'Only money received can go to the unallocated queue');
      if (i.kind === 'CHARGE' && inn) throw err(400, 'VALIDATION_FAILED', 'A bank charge is money paid out');
      const other = i.kind === 'SUSPENSE'
        ? await trx.selectFrom('gl_account').select('id').where('control_type', '=', 'SUSPENSE').where('is_group', '=', false).where('active', '=', true).executeTakeFirst()
        : await trx.selectFrom('gl_account').select('id').where('code', '=', '5130').where('active', '=', true).executeTakeFirst();
      if (!other) throw err(409, 'NO_CHART', i.kind === 'SUSPENSE' ? 'The unallocated receipts account does not exist. Load the chart of accounts.' : 'Account 5130 (bank charges) does not exist.');
      const vid = await this.fin.postSystem(trx, { type: 'JV', date: d, userId, module: 'BANK_STATEMENT', eventId: id, narration: i.kind === 'SUSPENSE' ? `Unallocated bank receipt: ${l.narration}` : `Bank charge: ${l.narration}`,
        lines: inn ? [{ accountId: b.glId, propertyId: null, debit: amt, credit: 0n, reference: l.reference }, { accountId: other.id, propertyId: null, debit: 0n, credit: amt, reference: l.reference }]
          : [{ accountId: other.id, propertyId: null, debit: amt, credit: 0n, reference: l.reference }, { accountId: b.glId, propertyId: null, debit: 0n, credit: amt, reference: l.reference }] });
      if (!vid) throw err(409, 'ALREADY_BOOKED', 'This line was already booked');
      const e = await trx.selectFrom('gl_entry').select('id').where('voucher_id', '=', vid).where('account_id', '=', b.glId).executeTakeFirstOrThrow();
      await trx.insertInto('bank_match').values({ tenant_id: currentTenant().tenantId, statement_line_id: id, gl_entry_id: e.id, amount_minor: amt.toString(), match_type: 'BOOKED', reason: i.note ?? null, matched_by: userId } as never).execute();
      await trx.updateTable('bank_statement_line').set({ status: 'MATCHED' } as never).where('id', '=', id).execute();
      if (i.kind === 'SUSPENSE') await trx.insertInto('bank_suspense_item').values({ tenant_id: currentTenant().tenantId, statement_line_id: id, voucher_id: vid, amount_minor: amt.toString(), note: i.note ?? null, created_by: userId } as never).execute();
      await this.audit.record(trx, { action: `finance.recon.book_${i.kind.toLowerCase()}`, resourceType: 'bank_statement_line', resourceId: id, after: { voucherId: vid, amount: amt.toString() } });
      return { voucherId: vid };
    });
  }

  // ---- the reconciliation statement and its sign-off
  async summary(q: z.infer<typeof SummaryQ>) {
    return this.tdb.tx(async (trx) => {
      const b = await this.bank(trx, q.bankId); const cur = (await this.fin.settings(trx)).base_currency; const f = (v: bigint) => Money.ofMinor(v, cur).toDecimalString();
      const st = Money.parse(q.statementBalance.replace(/^-/, ''), cur).minor * (q.statementBalance.startsWith('-') ? -1n : 1n);
      const led = await sql<{ s: string }>`SELECT coalesce(sum(debit_minor - credit_minor),0)::text AS s FROM gl_entry WHERE account_id = ${b.glId} AND posting_date <= ${q.to}::date`.execute(trx);
      const bo = await sql<{ r: string; p: string; n: number }>`SELECT coalesce(sum(e.debit_minor),0)::text AS r, coalesce(sum(e.credit_minor),0)::text AS p, count(*)::int AS n FROM gl_entry e WHERE e.account_id = ${b.glId} AND e.posting_date <= ${q.to}::date AND NOT EXISTS (SELECT 1 FROM bank_match m WHERE m.gl_entry_id = e.id)`.execute(trx);
      const so = await sql<{ c: string; d: string; n: number }>`SELECT coalesce(sum(credit_minor),0)::text AS c, coalesce(sum(debit_minor),0)::text AS d, count(*)::int AS n FROM bank_statement_line WHERE payment_account_id = ${b.id} AND value_date <= ${q.to}::date AND status = 'UNMATCHED'`.execute(trx);
      const ledger = BigInt(led.rows[0]!.s), R = BigInt(bo.rows[0]!.r), P = BigInt(bo.rows[0]!.p), C = BigInt(so.rows[0]!.c), D = BigInt(so.rows[0]!.d);
      const adjusted = st + R - P - C + D; const diff = adjusted - ledger;
      const rec = await trx.selectFrom('bank_reconciliation').select(['id', 'status']).where('payment_account_id', '=', b.id).where('period_to', '=', q.to).executeTakeFirst();
      return { currency: cur, bank: b.name, to: q.to, statement: f(st), booksOnlyReceipts: f(R), booksOnlyPayments: f(P), statementOnlyCredits: f(C), statementOnlyDebits: f(D), adjusted: f(adjusted), ledger: f(ledger), difference: f(diff < 0n ? -diff : diff), reconciled: diff === 0n, booksOnlyCount: bo.rows[0]!.n, statementOnlyCount: so.rows[0]!.n, signOff: rec ?? null };
    });
  }
  async prepare(userId: string, i: z.infer<typeof ReconIn>) {
    const s = await this.summary({ bankId: i.bankId, to: i.to, statementBalance: i.statementBalance });
    if (!s.reconciled) throw err(409, 'NOT_RECONCILED', `The statement and the books still differ by ${s.difference}. Match or book the remaining items first.`);
    return this.tdb.tx(async (trx) => {
      const b = await this.bank(trx, i.bankId); const cur = s.currency;
      const dup = await trx.selectFrom('bank_reconciliation').select('id').where('payment_account_id', '=', b.id).where('period_to', '=', i.to).executeTakeFirst(); if (dup) throw err(409, 'ALREADY_PREPARED', 'This date already has a reconciliation');
      const r = await trx.insertInto('bank_reconciliation').values({ tenant_id: currentTenant().tenantId, payment_account_id: b.id, period_to: i.to, statement_minor: Money.parse(s.statement.replace('-', ''), cur).minor.toString(), ledger_minor: Money.parse(s.ledger.replace('-', ''), cur).minor.toString(), difference_minor: '0', status: 'PENDING', note: i.note ?? null, prepared_by: userId } as never).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'finance.recon.prepare', resourceType: 'bank_reconciliation', resourceId: r.id, after: { to: i.to } });
      return { id: r.id, status: 'PENDING' };
    });
  }
  async approve(userId: string, id: string) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.selectFrom('bank_reconciliation').selectAll().where('id', '=', id).forUpdate().executeTakeFirst(); if (!r) throw err(404, 'NOT_FOUND', 'No such reconciliation');
      if (r.status !== 'PENDING') throw err(409, 'NOT_PENDING', 'This reconciliation is already signed off'); if (r.prepared_by === userId) throw err(403, 'FINANCE_SELF_APPROVAL', 'You prepared this reconciliation, so someone else has to sign it off');
      await trx.updateTable('bank_reconciliation').set({ status: 'APPROVED', approved_by: userId, approved_at: new Date() } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'finance.recon.approve', resourceType: 'bank_reconciliation', resourceId: id, after: { to: String(r.period_to) } });
      return { id, status: 'APPROVED' };
    });
  }
  async reconciliations(bankId: string) {
    return this.tdb.tx(async (trx) => {
      const cur = (await this.fin.settings(trx)).base_currency; const f = (v: string) => Money.ofMinor(BigInt(v), cur).toDecimalString();
      const rows = await trx.selectFrom('bank_reconciliation').selectAll().where('payment_account_id', '=', bankId).orderBy('period_to', 'desc').limit(60).execute();
      return { items: rows.map((r) => ({ id: r.id, to: r.period_to, statement: f(r.statement_minor), status: r.status, preparedBy: r.prepared_by, note: r.note })) };
    });
  }

  // ---- unallocated receipts
  async suspense() {
    return this.tdb.tx(async (trx) => {
      const cur = (await this.fin.settings(trx)).base_currency; const f = (v: string) => Money.ofMinor(BigInt(v), cur).toDecimalString();
      const today = (await trx.selectFrom('property').select('business_date').orderBy('business_date', 'desc').limit(1).executeTakeFirst())?.business_date ?? new Date().toISOString().slice(0, 10);
      const rows = await trx.selectFrom('bank_suspense_item as s').innerJoin('bank_statement_line as l', (j) => j.onRef('l.id', '=', 's.statement_line_id').onRef('l.tenant_id', '=', 's.tenant_id')).innerJoin('payment_account as p', (j) => j.onRef('p.id', '=', 'l.payment_account_id').onRef('p.tenant_id', '=', 'l.tenant_id')).leftJoin('staff_user as u', (j) => j.onRef('u.id', '=', 's.assigned_to').onRef('u.tenant_id', '=', 's.tenant_id'))
        .select(['s.id', 's.amount_minor', 's.status', 's.note', 's.assigned_to', 'u.full_name as owner', 'l.value_date', 'l.narration', 'l.reference', 'p.name as bank']).where('s.status', '<>', 'ALLOCATED').orderBy('l.value_date').execute();
      return { items: rows.map((r) => { const age = Math.max(0, Math.round((Date.parse(String(today)) - Date.parse(String(r.value_date))) / 86_400_000)); return { id: r.id, amount: f(r.amount_minor), status: r.status, note: r.note, ownerId: r.assigned_to, owner: r.owner, date: r.value_date, narration: r.narration, reference: r.reference, bank: r.bank, ageDays: age, alert: age >= 7 ? 'SEVEN' : age >= 3 ? 'THREE' : age >= 1 ? 'ONE' : null }; }) };
    });
  }
  async assign(userId: string, id: string, i: z.infer<typeof Assign>) {
    return this.tdb.tx(async (trx) => {
      const r = await trx.updateTable('bank_suspense_item').set({ assigned_to: i.userId, ...(i.note !== undefined ? { note: i.note } : {}) } as never).where('id', '=', id).returning('id').executeTakeFirst(); if (!r) throw err(404, 'NOT_FOUND', 'No such item');
      await this.audit.record(trx, { action: 'finance.suspense.assign', resourceType: 'bank_suspense_item', resourceId: id, after: { to: i.userId } });
      return { saved: true };
    });
  }
  /** Prepares the voucher that moves the money out of the unallocated account, to the branch and account the evidence supports. It still needs approving like any other voucher. */
  async allocate(userId: string, id: string, i: z.infer<typeof Allocate>) {
    const item = await this.tdb.tx(async (trx) => {
      const s = await trx.selectFrom('bank_suspense_item').selectAll().where('id', '=', id).executeTakeFirst(); if (!s) throw err(404, 'NOT_FOUND', 'No such item'); if (s.status !== 'OPEN') throw err(409, 'NOT_OPEN', 'This item is already being allocated');
      const sus = await trx.selectFrom('gl_account').select('code').where('control_type', '=', 'SUSPENSE').where('is_group', '=', false).executeTakeFirstOrThrow();
      const l = await trx.selectFrom('bank_statement_line').select(['narration', 'value_date']).where('id', '=', s.statement_line_id).executeTakeFirstOrThrow();
      return { s, sus: sus.code, narration: l.narration, date: String(l.value_date).slice(0, 10) };
    });
    const amt = Money.ofMinor(BigInt(item.s.amount_minor), 'PKR').toDecimalString();
    const v = await this.fin.create(userId, { type: 'JV', date: item.date, narration: `Allocate unallocated bank receipt (${item.narration}): ${i.reason}`.slice(0, 500), lines: [{ account: item.sus, debit: amt }, { account: i.account, branchId: i.branchId ?? null, credit: amt }] });
    await this.tdb.tx(async (trx) => {
      await trx.updateTable('bank_suspense_item').set({ status: 'ALLOCATING', allocated_voucher_id: v.id } as never).where('id', '=', id).execute();
      await this.audit.record(trx, { action: 'finance.suspense.allocate', resourceType: 'bank_suspense_item', resourceId: id, after: { voucherId: v.id, account: i.account, reason: i.reason } });
    });
    return { voucherId: v.id };
  }
}

@Controller('v1/finance/bank')
export class ReconController {
  constructor(@Inject(ReconService) private readonly svc: ReconService) {}
  private me() { return currentTenant().actorId!; }
  @Post('statements') @RequirePermission('finance.prepare', ANY) import(@Body() b: unknown) { return this.svc.importStatement(this.me(), parse(Import, b)); }
  @Post('automatch') @HttpCode(200) @RequirePermission('finance.prepare', ANY) auto(@Body() b: unknown) { return this.svc.autoMatchNow(this.me(), parse(z.object({ bankId: uuid }), b).bankId); }
  @Get('lines') @RequirePermission('finance.view', ANY) lines(@Query() q: unknown) { return this.svc.lines(parse(LinesQ, q)); }
  @Get('ledger') @RequirePermission('finance.view', ANY) ledger(@Query() q: unknown) { return this.svc.ledger(parse(LedgerQ, q)); }
  @Post('lines/:id/match') @HttpCode(200) @RequirePermission('finance.prepare', ANY) match(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.match(this.me(), id, parse(MatchIn, b).entryIds); }
  @Post('lines/:id/unmatch') @HttpCode(200) @RequirePermission('finance.prepare', ANY) unmatch(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.unmatch(this.me(), id, parse(Reason, b).reason); }
  @Post('lines/:id/ignore') @HttpCode(200) @RequirePermission('finance.prepare', ANY) ignore(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.ignore(this.me(), id, parse(Reason, b).reason); }
  @Post('lines/:id/book') @HttpCode(200) @RequirePermission('finance.approve', ANY) book(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.book(this.me(), id, parse(Book, b)); }
  @Get('summary') @RequirePermission('finance.view', ANY) summary(@Query() q: unknown) { return this.svc.summary(parse(SummaryQ, q)); }
  @Post('reconciliations') @RequirePermission('finance.prepare', ANY) prepare(@Body() b: unknown) { return this.svc.prepare(this.me(), parse(ReconIn, b)); }
  @Post('reconciliations/:id/approve') @HttpCode(200) @RequirePermission('finance.approve', ANY) approve(@Param('id', new ParseUUIDPipe()) id: string) { return this.svc.approve(this.me(), id); }
  @Get('reconciliations') @RequirePermission('finance.view', ANY) list(@Query('bankId') bankId: string) { return this.svc.reconciliations(parse(uuid, bankId)); }
  @Get('suspense') @RequirePermission('finance.view', ANY) suspense() { return this.svc.suspense(); }
  @Post('suspense/:id/assign') @HttpCode(200) @RequirePermission('finance.prepare', ANY) assign(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.assign(this.me(), id, parse(Assign, b)); }
  @Post('suspense/:id/allocate') @RequirePermission('finance.prepare', ANY) allocate(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: unknown) { return this.svc.allocate(this.me(), id, parse(Allocate, b)); }
}
