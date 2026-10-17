/** System role templates, copied into every tenant at provisioning (tenants may clone them). Keys must exist in `permission`. */
export interface RoleTemplate { key: string; name: string; permissions: readonly string[] }

const READ = ['property.view', 'reservation.view', 'folio.view', 'report.view'] as const;

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
];
