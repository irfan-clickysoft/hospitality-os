/** System role templates, copied into every tenant at provisioning (tenants may clone them). Keys must exist in `permission`. */
export interface RoleTemplate { key: string; name: string; permissions: readonly string[] }

const READ = ['property.view', 'reservation.view', 'folio.view', 'report.view'] as const;

/**
 * Permissions that are sensitive enough to require a recently verified second factor (step-up).
 * Holders must enrol in MFA; sessions without a fresh MFA verification are refused with MFA_REQUIRED.
 */
export const SENSITIVE_PERMISSIONS: ReadonlySet<string> = new Set([
  'tenant.manage', 'user.manage', 'role.manage', 'tax.configure', 'tax.approve', 'payment.refund', 'folio.adjust', 'audit.view',
]);

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: 'group_owner', name: 'Group Owner', permissions: [
    'tenant.manage', 'property.manage', 'property.view', 'user.manage', 'role.manage', 'audit.view', 'reservation.view', 'reservation.create',
    'reservation.modify', 'reservation.cancel', 'rate.manage', 'folio.view', 'folio.post', 'folio.adjust', 'payment.take',
    'payment.refund', 'cashier.operate', 'nightaudit.run', 'report.view', 'tax.configure', 'tax.approve'] },
  { key: 'general_manager', name: 'General Manager', permissions: [
    'property.manage', 'property.view', 'user.manage', 'role.manage', 'audit.view', 'reservation.view', 'reservation.create', 'reservation.modify',
    'reservation.cancel', 'rate.manage', 'folio.view', 'folio.post', 'folio.adjust', 'payment.take', 'payment.refund',
    'cashier.operate', 'nightaudit.run', 'report.view'] },
  { key: 'front_desk_agent', name: 'Front Desk Agent', permissions: [
    'property.view', 'reservation.view', 'reservation.create', 'reservation.modify', 'folio.view', 'folio.post', 'payment.take', 'cashier.operate', 'report.view'] },
  { key: 'cashier', name: 'Cashier', permissions: ['property.view', 'folio.view', 'folio.post', 'payment.take', 'cashier.operate'] },
  { key: 'night_auditor', name: 'Night Auditor', permissions: [...READ, 'nightaudit.run', 'cashier.operate', 'folio.post'] },
  { key: 'accountant', name: 'Accountant', permissions: [...READ, 'folio.adjust', 'payment.take', 'tax.configure'] },
  { key: 'read_only', name: 'Read-only', permissions: [...READ] },
  // Sunset staffing model (per property: manager, front desk/night auditor, housekeeping, kitchen, guards; central: GM, accountant, bookings)
  { key: 'group_gm', name: 'Group General Manager (central)', permissions: [
    'property.manage', 'property.view', 'user.manage', 'role.manage', 'audit.view', 'reservation.view', 'reservation.create',
    'reservation.modify', 'reservation.cancel', 'rate.manage', 'folio.view', 'folio.adjust', 'payment.refund', 'report.view',
    'housekeeping.view', 'fnb.manage'] },
  { key: 'central_bookings_manager', name: 'Central Bookings Manager', permissions: [
    'property.view', 'reservation.view', 'reservation.create', 'reservation.modify', 'reservation.cancel', 'rate.manage', 'report.view'] },
  { key: 'reservation_agent', name: 'Reservation Agent', permissions: ['property.view', 'reservation.view', 'reservation.create', 'reservation.modify'] },
  { key: 'housekeeping_supervisor', name: 'Housekeeping Supervisor', permissions: ['property.view', 'housekeeping.view', 'housekeeping.update', 'housekeeping.assign'] },
  { key: 'housekeeper', name: 'Housekeeper', permissions: ['housekeeping.view', 'housekeeping.update'] },
  { key: 'kitchen_cook', name: 'Cook', permissions: ['fnb.order', 'fnb.manage'] },
  { key: 'kitchen_support', name: 'Kitchen Support', permissions: ['fnb.order'] },
  { key: 'gate_security', name: 'Gate Security', permissions: ['arrivals.view_masked', 'visitor.log'] },
];
