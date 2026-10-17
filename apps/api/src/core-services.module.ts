import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service.js';
import { IdempotencyService } from './idempotency/idempotency.service.js';
import { InboxService } from './outbox/inbox.service.js';
import { OutboxService } from './outbox/outbox.service.js';
import { ProvisioningService } from './provisioning/provisioning.service.js';

/** Cross-cutting services every feature module may use (audit, outbox, inbox, idempotency, provisioning). */
@Global()
@Module({
  providers: [AuditService, OutboxService, InboxService, IdempotencyService, ProvisioningService],
  exports: [AuditService, OutboxService, InboxService, IdempotencyService, ProvisioningService],
})
export class CoreServicesModule {}
