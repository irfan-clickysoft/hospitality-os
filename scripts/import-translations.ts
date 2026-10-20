// Applies the corrections from the reviewed spreadsheet to the Urdu texts:
//     pnpm exec tsx scripts/import-translations.ts path/to/reviewed.csv
// Reads the "Urdu (your correction)" column; empty cells are ignored. A correction is refused if it drops or invents a {placeholder}, or if the key is unknown.
// Edits apps/staff-web/src/i18n/ur.ts or ux.ts in place; check with `git diff`, then run the tests.
import { readFileSync, writeFileSync } from 'node:fs';
import { en } from '../apps/staff-web/src/i18n/en.js';
import { ur } from '../apps/staff-web/src/i18n/ur.js';

const file = process.argv[2]; if (!file) { console.error('usage: tsx scripts/import-translations.ts reviewed.csv'); process.exit(1); }
const parse = (text: string): string[][] => {            // minimal CSV: quoted fields, "" escapes, CRLF or LF
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else if (c === '"') inQ = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
};
const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const lit = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const files = ['ur.ts', 'ux.ts'].map((n) => new URL(`../apps/staff-web/src/i18n/${n}`, import.meta.url));
const src = files.map((f) => readFileSync(f, 'utf8'));
const rows = parse(readFileSync(file, 'utf8').replace(/^﻿/, '')).slice(1);
let applied = 0; const refused: string[] = [];
for (const r of rows) {
  const [key, , , current, fix] = r; const next = (fix ?? '').trim();
  if (!key || !next || next === current) continue;
  if (!(key in en)) { refused.push(`${key}: unknown key`); continue; }
  if (ph(next) !== ph((en as Record<string, string>)[key]!)) { refused.push(`${key}: the {placeholders} must match the English (${ph((en as Record<string, string>)[key]!) || 'none'})`); continue; }
  const old = `'${key}': ${lit((ur as Record<string, string>)[key]!)}`;
  const at = src.findIndex((s) => s.includes(old));
  if (at < 0) { refused.push(`${key}: could not find the current Urdu text in the source files`); continue; }
  src[at] = src[at]!.replace(old, `'${key}': ${lit(next)}`); applied++;
}
files.forEach((f, i) => writeFileSync(f, src[i]!));
console.log(`applied ${applied} correction(s)${refused.length ? `; refused ${refused.length}:\n  - ${refused.join('\n  - ')}` : ''}`);
