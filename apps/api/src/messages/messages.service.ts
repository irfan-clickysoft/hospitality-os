import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { sql } from 'kysely';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { GuestPortalService } from '../guest-portal/guest-portal.service.js';
import { ArService } from '../companies/ar.service.js';
import { RateProposalsService } from '../rate-proposals/service.js';
import { QuotationsService } from '../quotations/service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { TaxService } from '../tax/tax.service.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import { CHANNELS, defaultTemplate, EVENTS, render, TITLES, unknownVariables, VARIABLES, type Channel, type MessageEvent } from './templates.js';
import type { z } from 'zod';
import type * as S from './schemas.js';

const longDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const date = (d: string) => longDate.format(new Date(`${d.slice(0, 10)}T00:00:00Z`));
const clock = (hhmm: string) => { const [h, m] = hhmm.slice(0, 5).split(':').map(Number); return `${(h! % 12) || 12}:${String(m).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`; };
/** 25000 → "25,000"; 1250.50 → "1,250.50". */
const amt = (minor: bigint | string, cur: string) => { const s = Money.ofMinor(BigInt(minor), cur).toDecimalString(); const [i, f] = s.replace('-', '').split('.'); return `${s.startsWith('-') ? '-' : ''}${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f && !/^0+$/.test(f) ? `.${f}` : ''}`; };
const METHOD: Record<string, string> = { CASH: 'Cash', CARD_SLIP: 'Card', WALLET: 'Wallet', BANK_TRANSFER: 'Bank transfer' };

@Injectable()
export class MessagesService {
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(GuestPortalService) private readonly portal: GuestPortalService, @Inject(TaxService) private readonly tax: TaxService, @Inject(DocumentsService) private readonly docs: DocumentsService, @Inject(ArService) private readonly ar: ArService, @Inject(QuotationsService) private readonly quotes: QuotationsService, @Inject(RateProposalsService) private readonly proposals: RateProposalsService) {}

  /** Every message the system sends, with the wording in use (the owner's, or the built-in one). */
  async list() {
    const rows = await this.tdb.tx((trx) => trx.selectFrom('message_template').selectAll().execute());
    return { items: EVENTS.flatMap((event) => CHANNELS.map((channel) => {
      const mine = rows.find((r) => r.event === event && r.channel === channel); const d = defaultTemplate(event, channel);
      return { event, channel, title: TITLES[event], subject: mine ? mine.subject : d.subject, body: mine?.body ?? d.body, custom: !!mine, variables: VARIABLES[event], defaultBody: d.body, defaultSubject: d.subject };
    })) };
  }

  async save(event: MessageEvent, channel: Channel, i: z.infer<typeof S.SaveTemplate>) {
    const bad = unknownVariables(event, `${i.body}\n${i.subject ?? ''}`);
    if (bad.length) throw new UnprocessableEntityException({ code: 'UNKNOWN_PLACEHOLDER', message: `This message cannot use ${bad.map((b) => `{{${b}}}`).join(', ')}. Available: ${VARIABLES[event].map((v) => `{{${v}}}`).join(' ')}` });
    await this.tdb.tx(async (trx) => {
      await trx.insertInto('message_template').values({ tenant_id: currentTenant().tenantId, event, channel, subject: channel === 'EMAIL' ? (i.subject ?? null) : null, body: i.body, updated_by: currentTenant().actorId ?? null })
        .onConflict((oc) => oc.columns(['tenant_id', 'event', 'channel']).doUpdateSet({ subject: channel === 'EMAIL' ? (i.subject ?? null) : null, body: i.body, updated_by: currentTenant().actorId ?? null, updated_at: new Date() as never })).execute();
      await this.audit.record(trx, { action: 'message_template.save', resourceType: 'message_template', resourceId: `${event}/${channel}`, after: { event, channel } });
    });
    return (await this.list()).items.find((x) => x.event === event && x.channel === channel)!;
  }

  async reset(event: MessageEvent, channel: Channel) {
    await this.tdb.tx(async (trx) => {
      await trx.deleteFrom('message_template').where('event', '=', event).where('channel', '=', channel).execute();
      await this.audit.record(trx, { action: 'message_template.reset', resourceType: 'message_template', resourceId: `${event}/${channel}` });
    });
  }

  /**
   * What the guest still has to pay: what is on the bill now, plus the nights still to be charged with their taxes, less nothing twice. A booking that has not arrived has an empty bill,
   * so the nights are counted from the booking itself.
   */
  private async owed(trx: Parameters<Parameters<TenantDb['tx']>[0]>[0], propertyId: string, reservationId: string, _bd: string, residency: 'RESIDENT' | 'NON_RESIDENT') {
    const folio = await trx.selectFrom('folio').select(['id', 'balance_minor']).where('reservation_id', '=', reservationId).where('folio_type', '=', 'GUEST').where('status', '<>', 'VOID').executeTakeFirst();
    const lines = await trx.selectFrom('reservation_room').select('id').where('reservation_id', '=', reservationId).where('status', 'in', ['CONFIRMED', 'OPTION', 'CHECKED_IN']).execute();
    if (!lines.length) return BigInt(folio?.balance_minor ?? '0');
    const nights = await trx.selectFrom('stay_night').selectAll().where('reservation_room_id', 'in', lines.map((l) => l.id)).execute();
    const posted = new Set(folio ? (await trx.selectFrom('folio_posting').select('source_ref').where('folio_id', '=', folio.id).where('source_type', '=', 'ROOM_NIGHT').execute()).map((x) => x.source_ref) : []);
    let total = BigInt(folio?.balance_minor ?? '0');
    for (const n of nights) {
      if (posted.has(`${n.reservation_room_id}:${n.business_date}`)) continue;
      const net = BigInt(n.room_minor) + BigInt(n.extras_minor) - BigInt(n.discount_minor);
      const tax = await this.tax.previewIn(trx, propertyId, { date: n.business_date, residency, lines: [{ txnCode: 'ROOM', netMinor: BigInt(n.room_minor) }, { txnCode: 'ROOM_EXTRAS', netMinor: BigInt(n.extras_minor) }, { txnCode: 'ROOM', netMinor: -BigInt(n.discount_minor) }] });
      total += net + tax.taxMinor;
    }
    return total;
  }

  /** The message for one booking (and payment), ready to send. Only what the booking really has is filled in; lines with nothing to say are left out. */
  async compose(propertyId: string, i: z.infer<typeof S.Compose>) {
    const tenantId = currentTenant().tenantId, actorId = currentTenant().actorId;
    const data = await this.tdb.tx(async (trx) => {
      const r = await trx.selectFrom('reservation').selectAll().where('id', '=', i.reservationId).where('property_id', '=', propertyId).executeTakeFirst();
      if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Booking not found' });
      const [p, g, lines, folio, actor, stored] = await Promise.all([
        trx.selectFrom('property').selectAll().where('id', '=', propertyId).executeTakeFirstOrThrow(),
        trx.selectFrom('guest').select(['full_name', 'phone', 'email']).where('id', '=', r.guest_id).executeTakeFirstOrThrow(),
        trx.selectFrom('reservation_room').select(['arrival', 'departure', 'checked_out_at', 'status']).where('reservation_id', '=', i.reservationId).orderBy('arrival').execute(),
        trx.selectFrom('folio').select(['balance_minor', 'currency']).where('reservation_id', '=', i.reservationId).orderBy('created_at').executeTakeFirst(),
        actorId ? trx.selectFrom('staff_user').select('full_name').where('id', '=', actorId).executeTakeFirst() : undefined,
        trx.selectFrom('message_template').selectAll().where('event', '=', i.event).where('channel', '=', i.channel).executeTakeFirst(),
      ]);
      const pay = i.paymentId ? await trx.selectFrom('payment').selectAll().where('id', '=', i.paymentId).executeTakeFirst() : undefined;
      const rooms = await sql<{ number: string }>`SELECT DISTINCT rm.number FROM reservation_room l JOIN room_assignment a ON a.assignment_ref = l.id JOIN room rm ON rm.id = a.room_id WHERE l.tenant_id = ${tenantId} AND l.reservation_id = ${i.reservationId} ORDER BY rm.number`.execute(trx);
      const payFolio = pay ? await trx.selectFrom('folio as f').leftJoin('company as c', 'c.id', 'f.company_id').select(['c.name as company']).where('f.id', '=', pay.folio_id).executeTakeFirst() : undefined;
      return { rooms: rooms.rows.map((x) => x.number), company: payFolio?.company ?? null, r, p, g, lines, folio, actor, stored, pay, owed: await this.owed(trx, propertyId, i.reservationId, p.business_date, r.residency) };
    });
    const { r, p, g, lines, folio, actor, stored, pay, owed, rooms, company } = data;
    const cur = folio?.currency ?? r.currency;
    const arrival = lines.map((l) => l.arrival).sort()[0], departure = lines.map((l) => l.departure).sort().slice(-1)[0];
    const place = p.city ? `${p.name}, ${p.city}` : p.name;
    const { token } = await this.portal.tokenFor(propertyId, i.reservationId);
    const bal = owed;
    const vars: Record<string, string | null> = {
      guest_name: `${i.salutation ? `${i.salutation} ` : ''}${g.full_name}`, property_name: place, property_address: p.city ?? null, property_contact: null, manager_name: actor?.full_name ?? null,
      booking_reference: r.confirmation_no, secure_link: `${(i.origin ?? process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/#/b/${token}`,
      check_in_date_time: arrival ? `${date(arrival)} at ${clock(String(p.check_in_time))}` : null, check_out_date_time: departure ? `${date(departure)} at ${clock(String(p.check_out_time))}` : null, maps_link: p.maps_url,
      currency: cur, balance: bal > 0n ? amt(bal, cur) : null, document_link: null, room_number: rooms.length ? rooms.join(', ') : null, payment_description: null, paid_by: null, amount: null, payment_method: null, payment_date: null, receipt_number: null,
      ...i.extra,
    };
    if (pay) {
      vars.amount = amt(pay.amount_minor, pay.currency); vars.payment_method = METHOD[pay.method] ?? pay.method; vars.payment_date = date(pay.business_date); vars.receipt_number = pay.receipt_no;
      vars.payment_description = `${pay.kind === 'DEPOSIT' ? 'Advance deposit' : pay.kind === 'REFUND' ? 'Refund' : 'Payment toward your stay'}${pay.note ? ` — ${pay.note}` : ''}`;
      vars.paid_by = `${company ?? g.full_name}${pay.counterparty ? ` (${pay.counterparty})` : ''}`;
    }
    if ((i.event === 'PAYMENT_RECEIVED' || i.event === 'REFUND') && pay) vars.document_link = (await this.docs.linkFor(propertyId, { kind: 'PAYMENT', refId: pay.id }, actorId ?? null, i.origin)).url;
    else if (i.event === 'CHECK_OUT') vars.document_link = (await this.docs.linkFor(propertyId, { kind: 'STATEMENT', refId: i.reservationId }, actorId ?? null, i.origin).catch(() => null))?.url ?? null;
    const d = defaultTemplate(i.event, i.channel);
    const body = stored?.body ?? d.body, subject = stored ? stored.subject : d.subject;
    return { text: render(body, vars), subject: subject ? render(subject, vars) : null, phone: g.phone, email: g.email, missing: [] as string[] };
  }

  /** The message that tells a technician or contractor about a job, in the owner's wording. The phone is the contractor's, or the technician's if one is on file. */
  async composeWorkOrder(propertyId: string, workOrderId: string) {
    const actorId = currentTenant().actorId;
    const d = await this.tdb.tx(async (trx) => {
      const w = await trx.selectFrom('work_order').selectAll().where('id', '=', workOrderId).where('property_id', '=', propertyId).executeTakeFirst();
      if (!w) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Work order not found' });
      const [p, room, vendor, tech, reporter, actor, stored] = await Promise.all([
        trx.selectFrom('property').select(['name', 'city']).where('id', '=', propertyId).executeTakeFirstOrThrow(),
        w.room_id ? trx.selectFrom('room').select('number').where('id', '=', w.room_id).executeTakeFirst() : undefined,
        w.vendor_id ? trx.selectFrom('maintenance_vendor').select(['name', 'contact_name', 'phone']).where('id', '=', w.vendor_id).executeTakeFirst() : undefined,
        w.assigned_to ? trx.selectFrom('staff_user').select(['full_name', 'phone']).where('id', '=', w.assigned_to).executeTakeFirst() : undefined,
        trx.selectFrom('staff_user').select('full_name').where('id', '=', w.reported_by).executeTakeFirst(),
        actorId ? trx.selectFrom('staff_user').select('full_name').where('id', '=', actorId).executeTakeFirst() : undefined,
        trx.selectFrom('message_template').selectAll().where('event', '=', 'MAINTENANCE_ASSIGNED').where('channel', '=', 'WHATSAPP').executeTakeFirst(),
      ]);
      return { w, p, room, vendor, tech, reporter, actor, stored };
    });
    const { w, p, room, vendor, tech, reporter, actor, stored } = d;
    if (!vendor && !tech) throw new UnprocessableEntityException({ code: 'NOT_ASSIGNED', message: 'Give the job to a technician or a contractor first' });
    const priority = ['URGENT', 'High-priority', 'Normal', 'Low-priority'][w.priority - 1] ?? 'Normal';
    const vars: Record<string, string | null> = {
      recipient_name: vendor ? (vendor.contact_name ? `${vendor.contact_name} (${vendor.name})` : vendor.name) : tech!.full_name, property_name: p.city ? `${p.name}, ${p.city}` : p.name, manager_name: actor?.full_name ?? null,
      work_order_number: w.number, work_title: w.title, work_details: w.description, work_room: room ? `Room ${room.number}` : w.area, work_priority: priority, work_kind: w.kind === 'PREVENTIVE' ? 'preventive maintenance' : 'repair',
      work_due: w.due_date ? date(w.due_date) : null, requested_by: reporter?.full_name ?? null,
    };
    return { text: render(stored?.body ?? defaultTemplate('MAINTENANCE_ASSIGNED', 'WHATSAPP').body, vars), phone: vendor?.phone ?? tech?.phone ?? null, recipient: vars.recipient_name };
  }

  /** The message that sends a company its statement ("Bill to company"): the account for the last 90 days and a private link to view or print it. Goes to the company's contact. */
  async composeCompany(propertyId: string, companyId: string, origin?: string, channel: Channel = 'WHATSAPP') {
    const actorId = currentTenant().actorId;
    const probe = await this.ar.statement(companyId);
    const to = probe.to; const from = new Date(new Date(`${to}T00:00:00Z`).getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
    const v = await this.ar.statement(companyId, from, to);
    const d = await this.tdb.tx(async (trx) => {
      const [p, actor, stored] = await Promise.all([
        trx.selectFrom('property').select(['name', 'city']).where('id', '=', propertyId).executeTakeFirstOrThrow(),
        actorId ? trx.selectFrom('staff_user').select('full_name').where('id', '=', actorId).executeTakeFirst() : undefined,
        trx.selectFrom('message_template').selectAll().where('event', '=', 'COMPANY_STATEMENT').where('channel', '=', channel).executeTakeFirst(),
      ]);
      const c = await trx.selectFrom('company').select(['contact_name', 'contact_phone', 'contact_email']).where('id', '=', companyId).executeTakeFirstOrThrow();
      return { p, actor, stored, c };
    });
    const cur = v.closing.currency;
    const minor = (a: { amount: string }) => Money.parse(a.amount, cur).minor;
    const due = minor(v.closing as never);
    const overdue = ['d1_30', 'd31_60', 'd61_90', 'd90plus'].reduce((t, k) => t + (v.aging.buckets[k as never] ? minor(v.aging.buckets[k as never] as never) : 0n), 0n);
    const link = (await this.docs.companyLink(propertyId, companyId, actorId ?? null, origin)).url;
    const vars: Record<string, string | null> = {
      recipient_name: d.c.contact_name ?? v.company.name, company_name: v.company.name, property_name: d.p.city ? `${d.p.name}, ${d.p.city}` : d.p.name, manager_name: d.actor?.full_name ?? null, property_contact: null,
      statement_period: `${date(v.from)} to ${date(v.to)}`, currency: cur, balance_due: due > 0n ? amt(due, cur) : null, overdue_amount: overdue > 0n ? amt(overdue, cur) : null,
      payment_terms: `${v.company.termsDays} days`, document_link: link,
    };
    const dt = defaultTemplate('COMPANY_STATEMENT', channel); const subj = d.stored ? d.stored.subject : dt.subject;
    return { text: render(d.stored?.body ?? dt.body, vars), subject: channel === 'EMAIL' && subj ? render(subj, vars) : null, phone: d.c.contact_phone, email: d.c.contact_email, recipient: vars.recipient_name };
  }

  /** The message that sends a customer their quotation: the figures in short, and the private link to view, print and accept it. Making it marks the quotation as sent. */
  async composeQuotation(propertyId: string, quotationId: string, origin?: string, channel: Channel = 'WHATSAPP') {
    const actorId = currentTenant().actorId;
    const link = (await this.quotes.linkFor(propertyId, actorId!, quotationId, origin)).url;
    const q = await this.quotes.get(propertyId, quotationId);
    const d = await this.tdb.tx(async (trx) => {
      const [p, actor, stored] = await Promise.all([
        trx.selectFrom('property').select(['name', 'city']).where('id', '=', propertyId).executeTakeFirstOrThrow(),
        actorId ? trx.selectFrom('staff_user').select('full_name').where('id', '=', actorId).executeTakeFirst() : undefined,
        trx.selectFrom('message_template').selectAll().where('event', '=', 'QUOTATION').where('channel', '=', channel).executeTakeFirst(),
      ]);
      return { p, actor, stored };
    });
    const pr = q.pricing!; const cur = pr.currency;
    const rooms = pr.lines.reduce((a, l) => a + l.rooms, 0); const from = pr.lines.map((l) => l.arrival).sort()[0]!, to = pr.lines.map((l) => l.departure).sort().slice(-1)[0]!;
    const vars: Record<string, string | null> = {
      recipient_name: q.contactName ?? q.customerName, customer_name: q.customerName, property_name: d.p.city ? `${d.p.name}, ${d.p.city}` : d.p.name, manager_name: d.actor?.full_name ?? null, property_contact: null, quotation_number: q.number,
      stay_summary: `${rooms} room${rooms === 1 ? '' : 's'} · ${date(from)} to ${date(to)}`, currency: cur, total: amt(pr.total, cur), saving: BigInt(pr.discount) > 0n ? amt(pr.discount, cur) : null, advance: BigInt(pr.deposit.amount) > 0n ? amt(pr.deposit.amount, cur) : null,
      valid_until: date(q.validUntil), document_link: link,
    };
    const dt = defaultTemplate('QUOTATION', channel); const subj = d.stored ? d.stored.subject : dt.subject;
    return { text: render(d.stored?.body ?? dt.body, vars), subject: channel === 'EMAIL' && subj ? render(subj, vars) : null, phone: q.phone, email: q.email, recipient: vars.recipient_name, url: link };
  }

  /** The message that sends a company its rate proposal, with the private link. Making it marks the proposal as sent. */
  async composeProposal(propertyId: string, proposalId: string, origin?: string, channel: Channel = 'WHATSAPP') {
    const actorId = currentTenant().actorId;
    const link = (await this.proposals.linkFor(propertyId, actorId!, proposalId, origin)).url;
    const q = await this.proposals.get(propertyId, proposalId);
    const d = await this.tdb.tx(async (trx) => {
      const [p, actor, stored, co] = await Promise.all([
        trx.selectFrom('property').select(['name', 'city']).where('id', '=', propertyId).executeTakeFirstOrThrow(),
        actorId ? trx.selectFrom('staff_user').select('full_name').where('id', '=', actorId).executeTakeFirst() : undefined,
        trx.selectFrom('message_template').selectAll().where('event', '=', 'RATE_PROPOSAL').where('channel', '=', channel).executeTakeFirst(),
        q.companyId ? trx.selectFrom('company').select(['contact_name', 'contact_phone', 'contact_email']).where('id', '=', q.companyId).executeTakeFirst() : undefined,
      ]);
      return { p, actor, stored, co };
    });
    const vars: Record<string, string | null> = {
      recipient_name: q.attnName ?? d.co?.contact_name ?? q.companyName, company_name: q.companyName, property_name: d.p.city ? `${d.p.name}, ${d.p.city}` : d.p.name, manager_name: d.actor?.full_name ?? null, property_contact: null,
      proposal_title: q.title ?? 'corporate room rates proposal', reference_number: q.reference ?? q.number, valid_from: date(q.validFrom), valid_to: date(q.validTo), document_link: link,
    };
    const dt = defaultTemplate('RATE_PROPOSAL', channel); const subj = d.stored ? d.stored.subject : dt.subject;
    return { text: render(d.stored?.body ?? dt.body, vars), subject: channel === 'EMAIL' && subj ? render(subj, vars) : null, phone: d.co?.contact_phone ?? null, email: d.co?.contact_email ?? null, recipient: vars.recipient_name, url: link };
  }
}
