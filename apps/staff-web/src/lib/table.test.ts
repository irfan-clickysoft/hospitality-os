import { describe, expect, it } from 'vitest';
import { mapHeaders, parseTable, tableToRows } from './table.js';

describe('parseTable', () => {
  it('reads tab-separated cells pasted from Excel, comma and semicolon files, quotes, doubled quotes and line breaks inside quotes', () => {
    expect(parseTable('Name\tPhone\nAli\t0300\n')).toEqual([['Name', 'Phone'], ['Ali', '0300']]);
    expect(parseTable('Name,Notes\n"Khan, Ali","said ""hi""\nsecond line"')).toEqual([['Name', 'Notes'], ['Khan, Ali', 'said "hi"\nsecond line']]);
    expect(parseTable('a;b\r\n1;2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseTable('﻿Name,Phone\n\n,\nSara,1')).toEqual([['Name', 'Phone'], ['Sara', '1']]);                  // BOM, blank lines and empty rows are dropped
  });
});
describe('tableToRows', () => {
  it('maps columns by header text in any order and ignores columns it does not know', () => {
    const t = parseTable('Mobile No\tGuest Name\tRoom\tCountry\n03001234567\tAli Raza\t101\tPakistan');
    const r = tableToRows('guests', t);
    expect(r.usedHeaders).toBe(true); expect(r.ignored).toEqual(['Room']);
    expect(r.rows[0]).toEqual({ fullName: 'Ali Raza', phone: '03001234567', email: '', nationality: 'Pakistan', vip: '', notes: '' });
  });
  it('takes the default column order when the first row is data', () => {
    expect(tableToRows('guests', parseTable('Ali Raza\t0300\ta@b.co')).rows[0]).toMatchObject({ fullName: 'Ali Raza', phone: '0300', email: 'a@b.co' });
    expect(tableToRows('guests', parseTable('Ali Raza\t0300\ta@b.co')).usedHeaders).toBe(false);
  });
  it('knows the company headings', () => {
    const r = tableToRows('companies', parseTable('Company,NTN,Credit Limit,Payment Terms\nAcme,123,50000,30'));
    expect(r.rows[0]).toMatchObject({ name: 'Acme', ntn: '123', creditLimit: '50000', termsDays: '30' });
    expect(mapHeaders('companies', ['foo', 'bar'])).toBeNull();
  });
});
