// Writes every screen text in English and Urdu to a spreadsheet file for a native Urdu speaker to review:
//     pnpm exec tsx scripts/export-translations.ts            -> docs/urdu-review.csv
// Open the CSV in Excel or Google Sheets (UTF-8). The reviewer fills the "Urdu (your correction)" column only where the current Urdu is wrong or awkward.
import { writeFileSync } from 'node:fs';
import { en } from '../apps/staff-web/src/i18n/en.js';
import { ur } from '../apps/staff-web/src/i18n/ur.js';

const AREA: Record<string, string> = {
  nav: 'Menu', shell: 'Top bar and menu', sys: 'Online / offline status', role: 'Role names', cp: 'Search and commands', sc: 'Keyboard shortcuts', today: 'Today', q: 'Today queue', bl: 'Blockers (what stops a check-in/out)', lvl: 'Urgency labels', ib: 'Inbox',
  inbox: 'Inbox', ws: 'Reservation page', done: 'Confirmation cards', ci: 'Check-in', co: 'Check-out', mv: 'Move room panel', rl: 'Bookings list', rooms: 'Rooms page', hk2: 'Room cleaning status', hk: 'Housekeeping', guests: 'Guests', gp: 'Guest profile',
  app: 'General', common: 'General', banner: 'Offline / sending banners', property: 'Property selector', grp: 'Menu groups', stepup: 'Second-factor prompt', acct: 'My account', inv2: 'Accepting an invitation',
  occ: 'Room occupancy', room: 'Housekeeping', task: 'Housekeeping', priority: 'Housekeeping', my: 'Housekeeping', act: 'Housekeeping', board: 'Housekeeping board', issue: 'Housekeeping issues', cat: 'Housekeeping issues', lf: 'Lost and found',
  d: 'Bookings and rooms', bk: 'Bookings', wi: 'Walk-in', chg: 'Add a charge', src: 'Booking source', hist: 'Booking history', pol: 'Cancellation policy', wa: 'WhatsApp message', rack: 'Calendar (rack)',
  au: 'Night audit', au2: 'Night audit', ar: 'Companies and credit', mt: 'Repairs', sp: 'Conference room', tax: 'Tax', kt: 'Kitchen', cash: 'Cashier', safe: 'Cash safe', cr: 'Charges to review', gt: 'Gate', st: 'Staff', rd: 'Setup check', rp: 'Reports',
  mg: 'Management overview', imp: 'Data import', ota: 'OTA claims', cmp: 'Compliance', pa: 'Payment accounts', rt: 'Rates', rm: 'Rooms setup', inv: 'Invoices',
  save: 'Saving states', conflict: 'Changed-by-someone-else', state: 'Empty / error states', perm: 'Permission messages', err: 'Error messages', field: 'Form fields', rs: 'Reservation status', pay: 'Payments', fo: 'Bill', login: 'Sign in',
};
const area = (k: string) => AREA[k.split('.')[0]!] ?? k.split('.')[0]!;
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const keys = Object.keys(en) as Array<keyof typeof en>;
const rows = keys.map((k) => [k, area(k), en[k], (ur as Record<string, string>)[k] ?? '', '', ''].map(q).join(','));
const head = ['Key (do not change)', 'Where it appears', 'English', 'Urdu (current)', 'Urdu (your correction)', 'Note'].map(q).join(',');
writeFileSync(new URL('../docs/urdu-review.csv', import.meta.url), `﻿${[head, ...rows].join('\r\n')}\r\n`);
console.log(`wrote docs/urdu-review.csv: ${keys.length} texts`);
