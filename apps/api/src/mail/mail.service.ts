import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { TenantDb } from '../db/tenant-db.js';
import { currentTenant } from '../tenancy/tenant-context.js';
import type * as S from './schemas.js';

const fail = (status: number, code: string, message: string) => new HttpException({ code, message }, status);
const HOURLY_LIMIT = 200;

export interface MailTransport { send(m: { from: string; fromName: string; replyTo: string | null; to: string; subject: string; text: string }): Promise<{ id: string | null }> }

/** Amazon SES (API v2). Credentials come from the server's settings (an IAM role, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY); nothing is stored in the database. */
class SesTransport implements MailTransport {
  private client: Promise<{ send: (c: unknown) => Promise<{ MessageId?: string }>; cmd: new (i: unknown) => unknown }> | null = null;
  private load() {
    return (this.client ??= import('@aws-sdk/client-sesv2').then((m) => ({ send: (c: unknown) => new m.SESv2Client({ region: process.env.SES_REGION }).send(c as never) as Promise<{ MessageId?: string }>, cmd: m.SendEmailCommand as never })));
  }
  async send(m: { from: string; fromName: string; replyTo: string | null; to: string; subject: string; text: string }) {
    const { send, cmd } = await this.load();
    const r = await send(new cmd({
      FromEmailAddress: `"${m.fromName}" <${m.from}>`, Destination: { ToAddresses: [m.to] }, ReplyToAddresses: m.replyTo ? [m.replyTo] : undefined,
      Content: { Simple: { Subject: { Data: m.subject, Charset: 'UTF-8' }, Body: { Text: { Data: m.text, Charset: 'UTF-8' } } } },
    }));
    return { id: r.MessageId ?? null };
  }
}

/** Sends the hotel's messages by email and keeps a record of each one. */
@Injectable()
export class MailService {
  /** Replaceable so tests (and any other provider) can stand in for SES. */
  transport: MailTransport = new SesTransport();
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(AuditService) private readonly audit: AuditService) {}

  private from() { const f = (process.env.MAIL_FROM ?? '').trim(); return /^[^\s<>"@]+@[^\s<>"@]+\.[^\s<>"@]+$/.test(f) ? f : null; }
  status() { return { configured: !!this.from() && (!!process.env.SES_REGION || this.transport.constructor !== SesTransport), from: this.from() }; }

  async send(propertyId: string, userId: string, i: z.infer<typeof S.Send>) {
    const from = this.from();
    if (!this.status().configured || !from) throw fail(503, 'EMAIL_NOT_CONFIGURED', 'Email is not switched on for this system. Copy the message and send it from your own mail instead.');
    const tenantId = currentTenant().tenantId;
    const row = await this.tdb.tx(async (trx) => {
      const p = await trx.selectFrom('property').select('name').where('id', '=', propertyId).executeTakeFirst();
      if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Property not found' });
      if (i.purpose === 'GUEST') { if (!(await trx.selectFrom('reservation').select('id').where('id', '=', i.refId).where('property_id', '=', propertyId).executeTakeFirst())) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Booking not found' }); }
      else if (!(await trx.selectFrom('company').select('id').where('id', '=', i.refId).executeTakeFirst())) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found' });
      if (await trx.selectFrom('email_suppression').select('address').where('address', '=', i.to).executeTakeFirst()) throw fail(409, 'EMAIL_SUPPRESSED', 'This address bounced or was reported as spam before, so the system will not email it again. Check the address with the person, or ask a manager to allow it.');
      const recent = await sql<{ n: string }>`SELECT count(*)::text AS n FROM email_message WHERE tenant_id = ${tenantId} AND created_at > now() - interval '1 hour'`.execute(trx);
      if (Number(recent.rows[0]!.n) >= HOURLY_LIMIT) throw fail(429, 'EMAIL_LIMIT', 'Too many emails were sent in the last hour. Try again later.');
      const m = await trx.insertInto('email_message').values({ tenant_id: tenantId, property_id: propertyId, purpose: i.purpose, ref_id: i.refId, to_address: i.to, subject: i.subject, body: i.text, created_by: userId } as never).returning(['id']).executeTakeFirstOrThrow();
      return { id: m.id, name: p.name };
    });
    try {
      const r = await this.transport.send({ from, fromName: row.name.replace(/["\r\n<>]/g, ' ').trim(), replyTo: (process.env.MAIL_REPLY_TO ?? '').trim() || null, to: i.to, subject: i.subject, text: i.text });
      await this.tdb.tx(async (trx) => {
        await trx.updateTable('email_message').set({ status: 'SENT', provider_id: r.id, sent_at: sql`now()` } as never).where('id', '=', row.id).execute();
        await this.audit.record(trx, { action: 'email.send', resourceType: i.purpose.toLowerCase(), resourceId: i.refId, propertyId, after: { to: i.to, subject: i.subject } });
      });
      return { id: row.id, status: 'SENT' as const };
    } catch (e) {
      await this.tdb.tx((trx) => trx.updateTable('email_message').set({ status: 'FAILED', error: String((e as Error).message ?? e).slice(0, 300) } as never).where('id', '=', row.id).execute());
      throw fail(502, 'EMAIL_FAILED', 'The email could not be sent. Check the address and try again, or send the message from your own mail.');
    }
  }

  async recent(propertyId: string, limit: number) {
    return this.tdb.tx(async (trx) => ({ items: (await trx.selectFrom('email_message').select(['id', 'purpose', 'to_address', 'subject', 'status', 'error', 'feedback', 'created_at', 'sent_at']).where('property_id', '=', propertyId).orderBy('created_at', 'desc').limit(limit).execute())
      .map((m) => ({ id: m.id, purpose: m.purpose, to: m.to_address, subject: m.subject, status: m.status, error: m.error ?? m.feedback, createdAt: m.created_at, sentAt: m.sent_at })) }));
  }

  async suppressions() {
    return this.tdb.tx(async (trx) => ({ items: (await trx.selectFrom('email_suppression').selectAll().orderBy('created_at', 'desc').limit(200).execute()).map((x) => ({ address: x.address, reason: x.reason, detail: x.detail, since: x.created_at })) }));
  }
  /** A manager says the address is right after all (the mailbox was full, or it was fixed). */
  async allow(propertyId: string, address: string) {
    return this.tdb.tx(async (trx) => {
      await trx.deleteFrom('email_suppression').where('address', '=', address.trim().toLowerCase()).execute();
      await this.audit.record(trx, { action: 'email.allow', resourceType: 'email_suppression', resourceId: address.trim().toLowerCase(), propertyId });
      return { allowed: true };
    });
  }
}
