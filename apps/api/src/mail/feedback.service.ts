import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@hos/db';
import { DB_ADMIN } from '../db/db.module.js';
import { TenantDb } from '../db/tenant-db.js';
import { runWithTenant } from '../tenancy/tenant-context.js';
import { isAmazonUrl, verifySns, type CertFetcher, fetchCert, type SnsMessage } from './sns.js';

interface Feedback {
  notificationType?: string; eventType?: string; mail?: { messageId?: string };
  bounce?: { bounceType?: string; bounceSubType?: string; bouncedRecipients?: Array<{ emailAddress?: string; diagnosticCode?: string }> };
  complaint?: { complainedRecipients?: Array<{ emailAddress?: string }>; complaintFeedbackType?: string };
}

/** Learns from Amazon what became of each email: delivered, bounced or reported as spam. A bad address is not tried again. */
@Injectable()
export class MailFeedbackService {
  /** Replaceable in tests; production reads Amazon's certificate. */
  certs: CertFetcher = fetchCert;
  /** Replaceable in tests; production confirms the subscription with Amazon. */
  confirm: (url: string) => Promise<void> = async (url) => { await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' }); };
  constructor(@Inject(TenantDb) private readonly tdb: TenantDb, @Inject(DB_ADMIN) private readonly admin: Kysely<DB> | null) {}

  topic() { return (process.env.SES_SNS_TOPIC_ARN ?? '').trim() || null; }

  /** Returns false when the message is not to be believed (the caller answers 403 and does nothing). */
  async receive(m: SnsMessage): Promise<boolean> {
    const topic = this.topic();
    if (!topic || m?.TopicArn !== topic || !(await verifySns(m, this.certs))) return false;
    if (m.Type === 'SubscriptionConfirmation') { if (m.SubscribeURL && isAmazonUrl(m.SubscribeURL)) await this.confirm(m.SubscribeURL); return true; }
    if (m.Type !== 'Notification') return true;
    let f: Feedback; try { f = JSON.parse(m.Message) as Feedback; } catch { return true; }
    const id = f.mail?.messageId; const kind = f.notificationType ?? f.eventType;
    if (!id || !this.admin || !kind) return true;
    // The message carries no tenant, so the platform connection finds whose email it was; everything after runs as that tenant, under row-level security.
    const row = await sql<{ tenant_id: string }>`SELECT tenant_id FROM email_message WHERE provider_id = ${id}`.execute(this.admin);
    const tenantId = row.rows[0]?.tenant_id; if (!tenantId) return true;
    await runWithTenant({ tenantId }, () => this.apply(id, kind, f));
    return true;
  }

  private async apply(providerId: string, kind: string, f: Feedback) {
    await this.tdb.tx(async (trx) => {
      const note = (s: string) => s.slice(0, 400);
      if (kind === 'Delivery') {
        await trx.updateTable('email_message').set({ status: 'DELIVERED', feedback_at: sql`now()` } as never).where('provider_id', '=', providerId).where('status', '=', 'SENT').execute();
      } else if (kind === 'Bounce' && f.bounce) {
        const permanent = f.bounce.bounceType === 'Permanent';
        const why = note(`${f.bounce.bounceType ?? 'Bounce'}${f.bounce.bounceSubType ? ` (${f.bounce.bounceSubType})` : ''}: ${f.bounce.bouncedRecipients?.[0]?.diagnosticCode ?? 'the mailbox did not accept the message'}`);
        await trx.updateTable('email_message').set({ ...(permanent ? { status: 'BOUNCED' } : {}), feedback: why, feedback_at: sql`now()` } as never).where('provider_id', '=', providerId).where('status', 'in', ['SENT', 'DELIVERED', 'BOUNCED']).execute();
        if (permanent) for (const r of f.bounce.bouncedRecipients ?? []) await this.suppress(trx, r.emailAddress, 'BOUNCE', why);
      } else if (kind === 'Complaint' && f.complaint) {
        const why = note(`Reported as spam${f.complaint.complaintFeedbackType ? ` (${f.complaint.complaintFeedbackType})` : ''}`);
        await trx.updateTable('email_message').set({ status: 'COMPLAINED', feedback: why, feedback_at: sql`now()` } as never).where('provider_id', '=', providerId).execute();
        for (const r of f.complaint.complainedRecipients ?? []) await this.suppress(trx, r.emailAddress, 'COMPLAINT', why);
      }
    });
  }

  private async suppress(trx: Parameters<Parameters<TenantDb['tx']>[0]>[0], address: string | undefined, reason: 'BOUNCE' | 'COMPLAINT', detail: string) {
    const a = address?.trim().toLowerCase(); if (!a || a.length > 254) return;
    const { currentTenant } = await import('../tenancy/tenant-context.js');
    await trx.insertInto('email_suppression').values({ tenant_id: currentTenant().tenantId, address: a, reason, detail } as never)
      .onConflict((oc) => oc.columns(['tenant_id', 'address']).doUpdateSet({ reason, detail } as never)).execute();
  }
}
