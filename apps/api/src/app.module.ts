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
import { GuestsController } from './guests/guests.controller.js';
import { GuestsService } from './guests/guests.service.js';
import { CashierService } from './folio/cashier.service.js';
import { FolioController } from './folio/folio.controller.js';
import { FolioService } from './folio/folio.service.js';
import { PaymentsService } from './folio/payments.service.js';
import { NightAuditController } from './night-audit/night-audit.controller.js';
import { NightAuditService } from './night-audit/night-audit.service.js';
import { ManagementController } from './management/management.controller.js';
import { ManagementService } from './management/management.service.js';
import { ImportsController } from './imports/imports.controller.js';
import { ImportsService } from './imports/imports.service.js';
import { MaintenanceController } from './maintenance/maintenance.controller.js';
import { MaintenanceService } from './maintenance/maintenance.service.js';
import { ComplianceController } from './compliance/compliance.controller.js';
import { ComplianceService } from './compliance/compliance.service.js';
import { PaymentAccountsController } from './payment-accounts/payment-accounts.controller.js';
import { PaymentAccountsService } from './payment-accounts/payment-accounts.service.js';
import { FnbController } from './fnb/fnb.controller.js';
import { FnbService } from './fnb/fnb.service.js';
import { SpacesController } from './spaces/spaces.controller.js';
import { SpacesService } from './spaces/spaces.service.js';
import { StaffController } from './staff/staff.controller.js';
import { StaffService } from './staff/staff.service.js';
import { ReportsController } from './reports/reports.controller.js';
import { ReportsService } from './reports/reports.service.js';
import { OtaController } from './ota/ota.controller.js';
import { OtaService } from './ota/ota.service.js';
import { CompaniesController } from './companies/companies.controller.js';
import { ArService } from './companies/ar.service.js';
import { CompaniesService } from './companies/companies.service.js';
import { InvoiceController } from './invoices/invoice.controller.js';
import { InvoiceService } from './invoices/invoice.service.js';
import { TaxController } from './tax/tax.controller.js';
import { TaxService } from './tax/tax.service.js';
import { HousekeepingController } from './housekeeping/housekeeping.controller.js';
import { HousekeepingService } from './housekeeping/housekeeping.service.js';
import { FrontDeskController } from './front-desk/front-desk.controller.js';
import { FrontDeskService } from './front-desk/front-desk.service.js';
import { ReservationsController } from './reservations/reservations.controller.js';
import { ReservationsService } from './reservations/reservations.service.js';
import { RatesController } from './rates/rates.controller.js';
import { RatesService } from './rates/rates.service.js';
import { QuoteSigner } from './rates/quote-signer.js';
import { PropertySetupController } from './property-setup/property-setup.controller.js';
import { PropertySetupService } from './property-setup/property-setup.service.js';
import { TenantMiddleware } from './tenancy/tenant.middleware.js';

@Module({
  imports: [DbModule, CoreServicesModule, IdentityModule, AuthzModule, InventoryModule],
  controllers: [HealthController, PropertySetupController, RatesController, GuestsController, ReservationsController, FrontDeskController, FolioController, HousekeepingController, NightAuditController, TaxController, InvoiceController, CompaniesController, ManagementController, OtaController, ReportsController, StaffController, FnbController, SpacesController, PaymentAccountsController, ComplianceController, MaintenanceController, ImportsController, AuditController],
  providers: [TenantMiddleware, PropertySetupService, RatesService, QuoteSigner, GuestsService, ReservationsService, FrontDeskService, FolioService, HousekeepingService, NightAuditService, TaxService, InvoiceService, CompaniesService, ArService, ManagementService, OtaService, ReportsService, StaffService, FnbService, SpacesService, PaymentAccountsService, ComplianceService, MaintenanceService, ImportsService, PaymentsService, CashierService, { provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void { consumer.apply(TenantMiddleware).forRoutes('*'); }
}
