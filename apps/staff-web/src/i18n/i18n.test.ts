import { describe, expect, it } from 'vitest';
import { en } from './en.js';
import { ur } from './ur.js';
import { errorText, isRtl, translate } from './index.js';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('translations', () => {
  it('Urdu defines exactly the English keys', () => {
    expect(Object.keys(ur).sort()).toEqual(Object.keys(en).sort());
  });
  it('every Urdu string is filled in, differs from English, and keeps the same {placeholders}', () => {
    for (const [k, v] of Object.entries(ur)) {
      const e = (en as Record<string, string>)[k]!;
      expect(v.trim(), k).not.toBe('');
      if (k !== 'nav.language' && k !== 'common.none') expect(v, `${k} is still English`).not.toBe(e);
      expect(placeholders(v), k).toEqual(placeholders(e));
    }
  });
  it('substitutes values and keeps unknown placeholders visible', () => {
    expect(translate('en', 'banner.pending', { n: 3 })).toBe('3 waiting to send');
    expect(translate('ur', 'banner.pending', { n: 3 })).toContain('3');
    expect(translate('en', 'task.rework', {})).toBe('Do again: {note}');
  });
  it('Urdu is right-to-left, English is not; unknown error codes fall back to a generic message', () => {
    expect(isRtl('ur')).toBe(true); expect(isRtl('en')).toBe(false);
    expect(errorText('en', 'NOT_YOUR_TASK')).toMatch(/someone else/);
    expect(errorText('ur', 'NOT_YOUR_TASK')).not.toBe(errorText('en', 'NOT_YOUR_TASK'));
    expect(errorText('en', 'SOMETHING_NEW')).toBe(translate('en', 'err.generic'));
  });
});
