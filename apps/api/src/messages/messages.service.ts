import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Money } from '@hos/domain-types';
import { AuditService } from '../audit/audit.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { GuestPortalService } from '../guest-portal/guest-portal.service.js';
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
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService, @Inject(GuestPortalService) private readonly portal: GuestPortalService, @Inject(TaxService) private readonly tax: TaxService) {}

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
        trx.selectFrom('guest').select(['full_name', 'phone']).where('id', '=', r.guest_id).executeTakeFirstOrThrow(),
        trx.selectFrom('reservation_room').select(['arrival', 'departure', 'checked_out_at', 'status']).where('reservation_id', '=', i.reservationId).orderBy('arrival').execute(),
        trx.selectFrom('folio').select(['balance_minor', 'currency']).where('reservation_id', '=', i.reservationId).orderBy('created_at').executeTakeFirst(),
        actorId ? trx.selectFrom('staff_user').select('full_name').where('id', '=', actorId).executeTakeFirst() : undefined,
        trx.selectFrom('message_template').selectAll().where('event', '=', i.event).where('channel', '=', i.channel).executeTakeFirst(),
      ]);
      const pay = i.paymentId ? await trx.selectFrom('payment').selectAll().where('id', '=', i.paymentId).executeTakeFirst() : undefined;
      return { r, p, g, lines, folio, actor, stored, pay, owed: await this.owed(trx, propertyId, i.reservationId, p.business_date, r.residency) };
    });
    const { r, p, g, lines, folio, actor, stored, pay, owed } = data;
    const cur = folio?.currency ?? r.currency;
    const arrival = lines.map((l) => l.arrival).sort()[0], departure = lines.map((l) => l.departure).sort().slice(-1)[0];
    const place = p.city ? `${p.name}, ${p.city}` : p.name;
    const { token } = await this.portal.tokenFor(propertyId, i.reservationId);
    const bal = owed;
    const vars: Record<string, string | null> = {
      guest_name: `${i.salutation ? `${i.salutation} ` : ''}${g.full_name}`, property_name: place, property_address: p.city ?? null, property_contact: null, manager_name: actor?.full_name ?? null,
      booking_reference: r.confirmation_no, secure_link: `${(i.origin ?? process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/#/b/${token}`,
      check_in_date_time: arrival ? `${date(arrival)} at ${clock(String(p.check_in_time))}` : null, check_out_date_time: departure ? `${date(departure)} at ${clock(String(p.check_out_time))}` : null, maps_link: p.maps_url,
      currency: cur, balance: bal > 0n ? amt(bal, cur) : null, amount: null, payment_method: null, payment_date: null, receipt_number: null,
      ...i.extra,
    };
    if (pay) {
      vars.amount = amt(pay.amount_minor, pay.currency); vars.payment_method = METHOD[pay.method] ?? pay.method; vars.payment_date = date(pay.business_date); vars.receipt_number = pay.receipt_no;
    }
    const d = defaultTemplate(i.event, i.channel);
    const body = stored?.body ?? d.body, subject = stored ? stored.subject : d.subject;
    return { text: render(body, vars), subject: subject ? render(subject, vars) : null, phone: g.phone, missing: [] as string[] };
  }
}
