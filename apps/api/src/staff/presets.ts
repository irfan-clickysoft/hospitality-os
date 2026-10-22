/**
 * Common combinations for a small property, where one person wears several hats: a suggestion that ticks the boxes, which the administrator can still change. A preset only names roles; what the
 * person actually receives is still limited to what the administrator holds, and the rules that need a second person (approving tax, verifying a bank transfer, paying a bill) still apply.
 */
export interface Preset { key: string; name: string; description: string; roles: string[] }
export const ROLE_PRESETS: readonly Preset[] = [
  { key: 'runs_the_property', name: 'Manager who runs the property', description: 'Looks after the front desk, cash, housekeeping and the day’s close at a small hotel.', roles: ['property_admin', 'front_desk_agent', 'cashier', 'housekeeping_supervisor', 'night_auditor'] },
  { key: 'desk_and_cash', name: 'Front desk and cashier', description: 'Takes bookings, checks guests in and out, and takes payments.', roles: ['front_desk_agent', 'cashier'] },
  { key: 'desk_and_night', name: 'Front desk and night audit', description: 'Runs the desk and closes the day.', roles: ['front_desk_agent', 'night_auditor'] },
  { key: 'house_and_repairs', name: 'Housekeeping lead and maintenance', description: 'Runs the rooms and does the repairs.', roles: ['housekeeping_supervisor', 'maintenance_technician'] },
  { key: 'accounts_and_audit', name: 'Accounts and night audit', description: 'Keeps the books and closes the day.', roles: ['accountant', 'night_auditor'] },
  { key: 'kitchen_and_orders', name: 'Kitchen and room service', description: 'Cooks and takes room-service orders.', roles: ['kitchen_cook', 'kitchen_support'] },
];
