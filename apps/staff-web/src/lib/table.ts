/** Reads pasted Excel cells (tab-separated) or a CSV file. Quotes may hold the separator and line breaks; "" is a quote. */
export function parseTable(text: string): string[][] {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const first = src.split('\n', 1)[0] ?? '';
  const count = (c: string) => first.split(c).length - 1;
  const sep = count('\t') > 0 ? '\t' : count(',') >= count(';') ? ',' : ';';
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) { if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; }
    else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some((v) => v !== ''));
}

export type Kind = 'guests' | 'companies';
export const FIELDS: Record<Kind, string[]> = {
  guests: ['fullName', 'phone', 'email', 'nationality', 'vip', 'notes'],
  companies: ['name', 'ntn', 'strn', 'address', 'contactName', 'contactPhone', 'contactEmail', 'creditLimit', 'termsDays', 'notes'],
};
const SYNONYMS: Record<Kind, Record<string, string[]>> = {
  guests: {
    fullName: ['name', 'full name', 'fullname', 'guest', 'guest name', 'customer', 'customer name'], phone: ['phone', 'mobile', 'mobile no', 'mobile number', 'phone number', 'contact', 'contact no', 'cell', 'whatsapp'],
    email: ['email', 'e-mail', 'email address', 'mail'], nationality: ['nationality', 'country', 'citizenship'], vip: ['vip', 'important'], notes: ['notes', 'note', 'remarks', 'comments'],
  },
  companies: {
    name: ['name', 'company', 'company name', 'organisation', 'organization', 'client', 'customer'], ntn: ['ntn', 'national tax number'], strn: ['strn', 'sales tax', 'sales tax no', 'gst', 'sales tax registration'],
    address: ['address', 'location'], contactName: ['contact', 'contact name', 'contact person', 'person'], contactPhone: ['phone', 'contact phone', 'mobile', 'telephone', 'contact no'], contactEmail: ['email', 'contact email', 'e-mail'],
    creditLimit: ['credit limit', 'limit', 'credit'], termsDays: ['terms', 'payment terms', 'terms days', 'days', 'credit days', 'net days'], notes: ['notes', 'note', 'remarks', 'comments'],
  },
};
const norm = (s: string) => s.toLowerCase().replace(/[_.:#()]/g, ' ').replace(/\s+/g, ' ').trim();

/** Which column holds which field, by header text. Returns null when the first row is data, not headers. */
export function mapHeaders(kind: Kind, headers: string[]): Record<string, number> | null {
  const map: Record<string, number> = {};
  headers.forEach((h, i) => { const n = norm(h); for (const f of FIELDS[kind]) if (!(f in map) && SYNONYMS[kind][f]!.includes(n)) { map[f] = i; break; } });
  return FIELDS[kind][0]! in map ? map : null;
}
export interface Parsed { rows: Array<Record<string, string>>; usedHeaders: boolean; ignored: string[] }
/** Rows as objects. With no recognisable header row, columns are taken in the default order. */
export function tableToRows(kind: Kind, table: string[][]): Parsed {
  if (!table.length) return { rows: [], usedHeaders: false, ignored: [] };
  const map = mapHeaders(kind, table[0]!);
  const fields = FIELDS[kind];
  const body = map ? table.slice(1) : table;
  const idx = map ?? Object.fromEntries(fields.map((f, i) => [f, i]));
  const ignored = map ? table[0]!.filter((_, i) => !Object.values(map).includes(i)).filter((h) => h) : [];
  return { rows: body.map((r) => Object.fromEntries(fields.map((f) => [f, idx[f] === undefined ? '' : r[idx[f]!] ?? '']))), usedHeaders: !!map, ignored };
}
export const templateCsv = (kind: Kind): string => `${FIELDS[kind].join(',')}\n`;
