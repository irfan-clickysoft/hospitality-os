/**
 * CSV for Excel. Every cell is quoted when it needs to be, and a cell that starts with = + - @ (or a tab/CR) gets a leading apostrophe so a guest named "=HYPERLINK(…)" can never run as a formula
 * when the sheet is opened. A byte-order mark makes Excel read Urdu names as UTF-8. Amounts are plain decimals; dates are YYYY-MM-DD.
 */
export type Cell = string | number | boolean | null | undefined;
const DANGEROUS = /^[=+\-@\t\r]/;

export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : String(v);
  if (typeof v === 'string' && DANGEROUS.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;        // a plain negative number is a number, not a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(headers: string[], rows: Cell[][]): string {
  return `﻿${[headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
