import { lazy, type ComponentType } from 'react';
import type { Key } from '../i18n/en.js';
import type { IconName } from '../ui/icons.js';

const L = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));

export type Can = (permission: string) => boolean;
export interface Tab { id: string; label: Key; show: (can: Can) => boolean; Page: ComponentType }
export interface Section { id: string; path: string; label: Key; icon: IconName; show: (can: Can) => boolean; tabs?: Tab[]; primary?: boolean }
const any = (...p: string[]) => (can: Can) => p.some(can);

/**
 * The ten places staff can go. Each section shows only what the signed-in person may use; the screens built earlier live on as tabs inside the section they belong to,
 * so nothing was removed — it was put where a hotel person would look for it.
 */
export const SECTIONS: Section[] = [
  { id: 'today', path: '/today', label: 'nav.today', icon: 'today', show: () => true, primary: true },
  { id: 'reservations', path: '/reservations', label: 'nav.reservations', icon: 'reservations', show: any('reservation.view', 'cashier.operate', 'company.view', 'ota.claim', 'space.view'), primary: true, tabs: [
    { id: 'bookings', label: 'nav.bookings', show: any('reservation.view'), Page: L(() => import('../pages/ReservationsList.js'), 'ReservationsList') },
    { id: 'cashier', label: 'nav.cashier', show: any('cashier.operate'), Page: L(() => import('../desk/Cashier.js'), 'Cashier') },
    { id: 'companies', label: 'nav.companies', show: any('company.view'), Page: L(() => import('../desk/Companies.js'), 'Companies') },
    { id: 'ota', label: 'nav.ota', show: any('ota.claim'), Page: L(() => import('../desk/OtaClaims.js'), 'OtaTab') },
    { id: 'requests', label: 'nav.requests', show: any('reservation.view'), Page: L(() => import('../desk/GuestRequests.js'), 'GuestRequests') },
    { id: 'spaces', label: 'nav.spaces', show: any('space.view'), Page: L(() => import('../desk/Spaces.js'), 'Spaces') },
  ] },
  { id: 'calendar', path: '/calendar', label: 'nav.calendar', icon: 'calendar', show: any('reservation.view'), tabs: [{ id: 'rack', label: 'nav.rack', show: any('reservation.view'), Page: L(() => import('../desk/Rack.js'), 'Rack') }] },
  { id: 'rooms', path: '/rooms', label: 'nav.rooms2', icon: 'rooms', show: any('reservation.view') },
  { id: 'housekeeping', path: '/housekeeping', label: 'nav.housekeeping', icon: 'housekeeping', show: any('housekeeping.update', 'housekeeping.view'), primary: true, tabs: [
    { id: 'mine', label: 'nav.myRooms', show: any('housekeeping.update'), Page: L(() => import('../screens/MyRooms.js'), 'MyRooms') },
    { id: 'board', label: 'nav.board', show: any('housekeeping.view'), Page: L(() => import('../screens/Board.js'), 'Board') },
    { id: 'issues', label: 'nav.issues', show: any('housekeeping.view'), Page: L(() => import('../screens/Issues.js'), 'Issues') },
    { id: 'lost', label: 'nav.lostFound', show: any('housekeeping.view'), Page: L(() => import('../screens/LostFound.js'), 'LostFound') },
  ] },
  { id: 'guests', path: '/guests', label: 'nav.guests', icon: 'guests', show: any('guest.view') },
  { id: 'inbox', path: '/inbox', label: 'nav.inbox', icon: 'inbox', show: () => true, primary: true },
  { id: 'tasks', path: '/tasks', label: 'nav.tasks', icon: 'tasks', show: any('maintenance.view', 'compliance.view', 'fnb.order', 'visitor.log', 'arrivals.view_masked'), tabs: [
    { id: 'gate', label: 'nav.gate', show: any('visitor.log', 'arrivals.view_masked'), Page: L(() => import('../desk/Gate.js'), 'Gate') },
    { id: 'maintenance', label: 'nav.maintenance', show: any('maintenance.view'), Page: L(() => import('../desk/Maintenance.js'), 'Maintenance') },
    { id: 'compliance', label: 'nav.compliance', show: any('compliance.view'), Page: L(() => import('../desk/Compliance.js'), 'Compliance') },
    { id: 'kitchen', label: 'nav.kitchen', show: any('fnb.order'), Page: L(() => import('../desk/Kitchen.js'), 'Kitchen') },
  ] },
  { id: 'reports', path: '/reports', label: 'nav.reports', icon: 'reports', show: any('management.view', 'report.view', 'nightaudit.run', 'audit.view'), tabs: [
    { id: 'overview', label: 'nav.management', show: any('management.view'), Page: L(() => import('../desk/Management.js'), 'Management') },
    { id: 'downloads', label: 'nav.downloads', show: any('report.view'), Page: L(() => import('../desk/Reports.js'), 'Reports') },
    { id: 'nightaudit', label: 'nav.audit', show: any('nightaudit.run'), Page: L(() => import('../desk/NightAudit.js'), 'NightAudit') },
    { id: 'trail', label: 'nav.audit2', show: any('audit.view'), Page: L(() => import('../desk/AuditLog.js'), 'AuditLog') },
  ] },
  { id: 'admin', path: '/admin', label: 'nav.admin', icon: 'admin', show: any('property.manage', 'rate.manage', 'tax.configure', 'tax.approve', 'paymentaccount.view', 'management.view', 'user.manage', 'data.import'), tabs: [
    { id: 'properties', label: 'nav.properties', show: any('property.manage'), Page: L(() => import('../pages/PropertyAdmin.js'), 'PropertiesTab') },
    { id: 'rooms', label: 'nav.rooms', show: any('property.manage'), Page: L(() => import('../desk/Rooms.js'), 'Rooms') },
    { id: 'rates', label: 'nav.rates', show: any('rate.manage'), Page: L(() => import('../desk/Rates.js'), 'Rates') },
    { id: 'tax', label: 'nav.tax', show: any('tax.configure', 'tax.approve'), Page: L(() => import('../desk/Tax.js'), 'Tax') },
    { id: 'accounts', label: 'nav.accounts', show: any('paymentaccount.view'), Page: L(() => import('../desk/Accounts.js'), 'Accounts') },
    { id: 'messages', label: 'nav.messages', show: any('tenant.manage'), Page: L(() => import('../pages/MessageTemplates.js'), 'MessageTemplates') },
    { id: 'readiness', label: 'nav.readiness', show: any('management.view'), Page: L(() => import('../desk/Readiness.js'), 'Readiness') },
    { id: 'staff', label: 'nav.staff', show: any('user.manage'), Page: L(() => import('../desk/Staff.js'), 'Staff') },
    { id: 'import', label: 'nav.import', show: any('data.import'), Page: L(() => import('../desk/Import.js'), 'Import') },
  ] },
];

/** The first section that has something this person may open (where a person with a narrow job lands). */
export const sectionFor = (path: string): Section | undefined => SECTIONS.find((s) => path === s.path || path.startsWith(`${s.path}/`));

/** What kind of work this person mostly does. Drives their Today and the label in the profile menu. */
export type Persona = 'manager' | 'frontdesk' | 'housekeeping' | 'maintenance' | 'accounts' | 'staff';
export function personaOf(can: Can): Persona {
  if (can('management.view')) return 'manager';
  if (can('frontdesk.check_in') || can('reservation.view')) return 'frontdesk';
  if (can('housekeeping.update') || can('housekeeping.view')) return 'housekeeping';
  if (can('maintenance.view')) return 'maintenance';
  if (can('cashier.operate') || can('report.view')) return 'accounts';
  return 'staff';
}
