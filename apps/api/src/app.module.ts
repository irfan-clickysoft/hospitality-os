import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuditService } from './audit/audit.service.js';
import { AuthzModule } from './authz/authz.module.js';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health/health.controller.js';
import { IdempotencyService } from './idempotency/idempotency.service.js';
import { InboxService } from './outbox/inbox.service.js';
import { OutboxService } from './outbox/outbox.service.js';
import { ProvisioningService } from './provisioning/provisioning.service.js';
import { PropertiesController } from './properties/properties.controller.js';
import { TenantMiddleware } from './tenancy/tenant.middleware.js';

@Module({
  imports: [DbModule, AuthzModule],
  controllers: [HealthController, PropertiesController],
  providers: [
    AuditService, OutboxService, InboxService, IdempotencyService, ProvisioningService, TenantMiddleware,
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
  exports: [AuditService, OutboxService, InboxService, IdempotencyService, ProvisioningService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void { consumer.apply(TenantMiddleware).forRoutes('*'); }
}
