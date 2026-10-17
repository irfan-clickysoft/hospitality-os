import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuditController } from './audit/audit.controller.js';
import { CoreServicesModule } from './core-services.module.js';
import { AuthzModule } from './authz/authz.module.js';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import { DbModule } from './db/db.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { HealthController } from './health/health.controller.js';
import { PropertiesController } from './properties/properties.controller.js';
import { TenantMiddleware } from './tenancy/tenant.middleware.js';

@Module({
  imports: [DbModule, CoreServicesModule, IdentityModule, AuthzModule],
  controllers: [HealthController, PropertiesController, AuditController],
  providers: [TenantMiddleware, { provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void { consumer.apply(TenantMiddleware).forRoutes('*'); }
}
