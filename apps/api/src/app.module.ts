import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuditController } from './audit/audit.controller.js';
import { CoreServicesModule } from './core-services.module.js';
import { AuthzModule } from './authz/authz.module.js';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import { DbModule } from './db/db.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { HealthController } from './health/health.controller.js';
import { RatesController } from './rates/rates.controller.js';
import { RatesService } from './rates/rates.service.js';
import { QuoteSigner } from './rates/quote-signer.js';
import { PropertySetupController } from './property-setup/property-setup.controller.js';
import { PropertySetupService } from './property-setup/property-setup.service.js';
import { TenantMiddleware } from './tenancy/tenant.middleware.js';

@Module({
  imports: [DbModule, CoreServicesModule, IdentityModule, AuthzModule, InventoryModule],
  controllers: [HealthController, PropertySetupController, RatesController, AuditController],
  providers: [TenantMiddleware, PropertySetupService, RatesService, QuoteSigner, { provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void { consumer.apply(TenantMiddleware).forRoutes('*'); }
}
