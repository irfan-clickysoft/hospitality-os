import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv.js';

describe('csv', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('Khan, Ali')).toBe('"Khan, Ali"'); expect(csvCell('say "hi"')).toBe('"say ""hi"""'); expect(csvCell('a\nb')).toBe('"a\nb"'); expect(csvCell(null)).toBe(''); expect(csvCell(12.5)).toBe('12.5');
  });
  it('defuses spreadsheet formulas but leaves real negative numbers alone', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`); expect(csvCell('+92300')).toBe("'+92300"); expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)"); expect(csvCell('-cmd|calc')).toBe("'-cmd|calc");
    expect(csvCell('-1500.00')).toBe('-1500.00');
  });
  it('starts with a byte-order mark and ends rows with CRLF', () => {
    const out = toCsv(['a', 'b'], [['1', 'x,y']]);
    expect(out.startsWith('﻿a,b\r\n')).toBe(true); expect(out.endsWith('1,"x,y"\r\n')).toBe(true);
  });
});
