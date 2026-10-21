/** System role templates, copied into every tenant at provisioning (tenants may clone them). Keys must exist in `permission`. */
export interface RoleTemplate { key: string; name: string; permissions: readonly string[] }

const READ = ['property.view', 'reservation.view', 'guest.view', 'folio.view', 'report.view'] as const;

/**
 * Permissions that are sensitive enough to require a recently verified second factor (step-up).
 * Holders must enrol in MFA; sessions without a fresh MFA verification are refused with MFA_REQUIRED.
 */
export const SENSITIVE_PERMISSIONS: ReadonlySet<string> = new Set([
  'tenant.manage', 'user.manage', 'role.manage', 'tax.configure', 'tax.approve', 'cashier.handover', 'payment.refund', 'folio.adjust', 'audit.view', 'inventory.overbook', 'reservation.override_rate', 'reservation.waive_fee', 'frontdesk.view_id', 'frontdesk.override_room', 'folio.checkout_with_balance', 'nightaudit.override', 'invoice.credit', 'ar.override_credit', 'ota.writeoff', 'data.import', 'compliance.approve', 'paymentaccount.manage',
]);

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: 'group_owner', name: 'Group Owner', permissions: [
    'tenant.manage', 'property.manage', 'property.view', 'user.manage', 'role.manage', 'audit.view', 'reservation.view', 'reservation.create',
    'reservation.modify', 'reservation.cancel', 'rate.manage', 'folio.view', 'folio.post', 'folio.adjust', 'payment.take',
    'payment.refund', 'cashier.operate', 'nightaudit.run', 'report.view', 'tax.configure', 'tax.approve', 'inventory.block', 'inventory.overbook', 'reservation.override_rate', 'reservation.waive_fee', 'guest.view', 'guest.manage', 'frontdesk.check_in', 'frontdesk.check_out', 'frontdesk.override_room', 'frontdesk.view_id', 'housekeeping.view', 'housekeeping.update', 'housekeeping.assign', 'payment.verify', 'cashier.review', 'folio.checkout_with_balance', 'nightaudit.override', 'invoice.issue', 'invoice.credit', 'company.view', 'company.manage', 'ar.bill', 'ar.override_credit', 'ar.receipt', 'ar.verify', 'management.view', 'ota.claim', 'ota.writeoff', 'data.import', 'maintenance.view', 'maintenance.manage', 'maintenance.work', 'compliance.view', 'compliance.manage', 'compliance.approve', 'compliance.task', 'paymentaccount.view', 'paymentaccount.manage', 'fnb.order', 'fnb.manage', 'recipe.approve', 'space.view', 'space.book', 'space.manage', 'cashier.handover', 'visitor.log', 'arrivals.view_masked', 'maintenance.request', 'maintenance.approve', 'maintenance.vendor', 'maintenance.pay'] },
  { key: 'general_manager', name: 'General Manager', permissions: [
    'property.manage', 'property.view', 'user.manage', 'role.manage', 'audit.view', 'reservation.view', 'reservation.create', 'reservation.modify',
    'reservation.cancel', 'rate.manage', 'folio.view', 'folio.post', 'folio.adjust', 'payment.take', 'payment.refund',
    'cashier.operate', 'nightaudit.run', 'report.view', 'inventory.block', 'inventory.overbook', 'reservation.override_rate', 'reservation.waive_fee', 'guest.view', 'guest.manage', 'frontdesk.check_in', 'frontdesk.check_out', 'frontdesk.override_room', 'frontdesk.view_id', 'housekeeping.view', 'housekeeping.update', 'housekeeping.assign', 'payment.verify', 'cashier.review', 'folio.checkout_with_balance', 'nightaudit.override', 'invoice.issue', 'invoice.credit', 'company.view', 'company.manage', 'ar.bill', 'ar.override_credit', 'ar.receipt', 'ar.verify', 'management.view', 'ota.claim', 'ota.writeoff', 'data.import', 'maintenance.view', 'maintenance.manage', 'maintenance.work', 'compliance.view', 'compliance.manage', 'compliance.approve', 'compliance.task', 'paymentaccount.view', 'fnb.order', 'fnb.manage', 'recipe.approve', 'space.view', 'space.book', 'space.manage', 'cashier.handover', 'visitor.log', 'arrivals.view_masked', 'maintenance.request', 'maintenance.approve', 'maintenance.vendor', 'maintenance.pay'] },
  { key: 'front_desk_agent', name: 'Front Desk Agent', permissions: [
    'property.view', 'reservation.view', 'reservation.create', 'reservation.modify', 'reservation.cancel', 'guest.view', 'guest.manage', 'folio.view', 'folio.post', 'payment.take', 'cashier.operate', 'report.view', 'frontdesk.check_in', 'frontdesk.check_out', 'housekeeping.view', 'housekeeping.update', 'invoice.issue', 'company.view', 'ar.bill', 'maintenance.view', 'compliance.view', 'compliance.task', 'fnb.order', 'space.view', 'space.book', 'visitor.log', 'arrivals.view_masked', 'maintenance.request'] },
  { key: 'cashier', name: 'Cashier', permissions: ['property.view', 'folio.view', 'folio.post', 'payment.take', 'cashier.operate'] },
  { key: 'night_auditor', name: 'Night Auditor', permissions: [...READ, 'nightaudit.run', 'cashier.operate', 'folio.post', 'maintenance.request', 'maintenance.view'] },
  { key: 'accountant', name: 'Accountant', permissions: [...READ, 'folio.adjust', 'payment.take', 'tax.configure', 'payment.verify', 'cashier.review', 'invoice.issue', 'invoice.credit', 'company.view', 'company.manage', 'ar.bill', 'ar.receipt', 'ar.verify', 'management.view', 'ota.claim', 'data.import', 'maintenance.view', 'maintenance.pay', 'paymentaccount.view', 'paymentaccount.manage', 'space.view', 'maintenance.request'] },
  { key: 'read_only', name: 'Read-only', permissions: [...READ] },
  // Sunset staffing model (per property: manager, front desk/night auditor, housekeeping, kitchen, guards; central: GM, accountant, bookings)
  { key: 'group_gm', name: 'Group General Manager (central)', permissions: [
    'property.manage', 'property.view', 'user.manage', 'role.manage', 'audit.view', 'reservation.view', 'reservation.create',
    'reservation.modify', 'reservation.cancel', 'reservation.waive_fee', 'guest.view', 'guest.manage', 'rate.manage', 'folio.view', 'folio.adjust', 'payment.refund', 'report.view',
    'housekeeping.view', 'fnb.manage', 'recipe.approve', 'frontdesk.view_id', 'payment.verify', 'cashier.review', 'invoice.issue', 'company.view', 'company.manage', 'ar.receipt', 'ar.verify', 'management.view', 'ota.claim', 'ota.writeoff', 'maintenance.view', 'maintenance.manage', 'compliance.view', 'compliance.manage', 'compliance.approve', 'paymentaccount.view', 'fnb.order', 'space.view', 'space.book', 'space.manage', 'cashier.handover', 'visitor.log', 'arrivals.view_masked', 'maintenance.request', 'maintenance.approve', 'maintenance.vendor', 'maintenance.pay'] },
  // Day-to-day administrator: runs the system after the super admin has done the initial setup (structure, tenant settings, tax). Cannot change property structure.
  { key: 'property_admin', name: 'Property Admin', permissions: [
    'property.view', 'user.manage', 'reservation.view', 'reservation.create', 'reservation.modify', 'reservation.cancel', 'reservation.waive_fee', 'guest.view', 'guest.manage',
    'rate.manage', 'inventory.block', 'folio.view', 'folio.post', 'payment.take', 'cashier.operate', 'report.view',
    'frontdesk.check_in', 'frontdesk.check_out', 'frontdesk.override_room', 'frontdesk.view_id', 'housekeeping.view', 'housekeeping.update', 'housekeeping.assign', 'payment.verify', 'cashier.review', 'folio.checkout_with_balance', 'nightaudit.override', 'nightaudit.run', 'invoice.issue', 'invoice.credit', 'company.view', 'company.manage', 'ar.bill', 'ar.override_credit', 'ar.receipt', 'ar.verify', 'management.view', 'ota.claim', 'data.import', 'maintenance.view', 'maintenance.manage', 'maintenance.work', 'compliance.view', 'compliance.manage', 'compliance.approve', 'compliance.task', 'paymentaccount.view', 'fnb.order', 'fnb.manage', 'recipe.approve', 'space.view', 'space.book', 'space.manage', 'cashier.handover', 'visitor.log', 'arrivals.view_masked', 'maintenance.request', 'maintenance.approve', 'maintenance.vendor', 'maintenance.pay'] },
  { key: 'central_bookings_manager', name: 'Central Bookings Manager', permissions: [
    'property.view', 'reservation.view', 'reservation.create', 'reservation.modify', 'reservation.cancel', 'guest.view', 'guest.manage', 'rate.manage', 'report.view', 'company.view', 'compliance.view', 'space.view', 'space.book'] },
  { key: 'reservation_agent', name: 'Reservation Agent', permissions: ['property.view', 'reservation.view', 'reservation.create', 'reservation.modify', 'guest.view', 'guest.manage', 'compliance.view', 'space.view', 'space.book', 'maintenance.request', 'maintenance.view'] },
  { key: 'housekeeping_supervisor', name: 'Housekeeping Supervisor', permissions: ['property.view', 'housekeeping.view', 'housekeeping.update', 'housekeeping.assign', 'maintenance.view', 'maintenance.request'] },
  { key: 'housekeeper', name: 'Housekeeper', permissions: ['housekeeping.view', 'housekeeping.update', 'maintenance.request', 'maintenance.view'] },
  { key: 'maintenance_technician', name: 'Maintenance Technician', permissions: ['property.view', 'maintenance.view', 'maintenance.work', 'housekeeping.view', 'maintenance.request'] },
  { key: 'kitchen_cook', name: 'Cook', permissions: ['fnb.order', 'fnb.manage', 'maintenance.request', 'maintenance.view'] },
  { key: 'head_chef', name: 'Head Chef', permissions: ['fnb.order', 'fnb.manage', 'recipe.approve', 'maintenance.request', 'maintenance.view'] },
  { key: 'kitchen_support', name: 'Kitchen Support', permissions: ['fnb.order'] },
  { key: 'gate_security', name: 'Gate Security', permissions: ['arrivals.view_masked', 'visitor.log', 'compliance.view', 'compliance.task'] },
];
