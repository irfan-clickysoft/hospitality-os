import { Global, Module } from '@nestjs/common';
import { CLOCK, SystemClock } from './common/clock.js';
import { AuditService } from './audit/audit.service.js';
import { IdempotencyService } from './idempotency/idempotency.service.js';
import { InboxService } from './outbox/inbox.service.js';
import { OutboxService } from './outbox/outbox.service.js';
import { ProvisioningService } from './provisioning/provisioning.service.js';

/** Cross-cutting services every feature module may use (audit, outbox, inbox, idempotency, provisioning). */
@Global()
@Module({
  providers: [AuditService, OutboxService, InboxService, IdempotencyService, ProvisioningService, { provide: CLOCK, useClass: SystemClock }],
  exports: [AuditService, OutboxService, InboxService, IdempotencyService, ProvisioningService, CLOCK],
})
export class CoreServicesModule {}
