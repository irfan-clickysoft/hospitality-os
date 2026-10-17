-- 0002 Base permission registry (extended by later migrations as modules arrive).
INSERT INTO permission (key, description) VALUES
 ('tenant.manage',        'Manage tenant settings, legal entities and brands'),
 ('property.manage',      'Create and configure properties, rooms and room types'),
 ('user.manage',          'Invite, disable and edit staff users'),
 ('role.manage',          'Create roles and assign roles (cannot grant what you do not hold)'),
 ('audit.view',           'View the audit log'),
 ('reservation.view',     'View reservations'),
 ('reservation.create',   'Create reservations'),
 ('reservation.modify',   'Modify, move, extend or shorten reservations'),
 ('reservation.cancel',   'Cancel reservations and mark no-shows'),
 ('rate.manage',          'Manage rate plans, rates and restrictions'),
 ('folio.view',           'View folios'),
 ('folio.post',           'Post charges'),
 ('folio.adjust',         'Reverse, adjust, transfer or split folio postings'),
 ('payment.take',         'Take payments'),
 ('payment.refund',       'Issue refunds'),
 ('cashier.operate',      'Open and close cashier sessions'),
 ('nightaudit.run',       'Run the night audit'),
 ('report.view',          'View reports and dashboards'),
 ('tax.configure',        'Configure tax codes (maker)'),
 ('tax.approve',          'Approve tax codes and component allocations (checker)')
ON CONFLICT (key) DO NOTHING;
