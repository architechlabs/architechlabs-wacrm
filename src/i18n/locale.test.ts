import { describe, expect, it } from 'vitest';

import { resolveAppLocale } from './locale';

describe('resolveAppLocale', () => {
  it('uses English when the setting is absent or blank', () => {
    expect(resolveAppLocale(undefined)).toBe('en');
    expect(resolveAppLocale('  ')).toBe('en');
  });

  it('removes surrounding whitespace from a configured locale', () => {
    expect(resolveAppLocale('en\n')).toBe('en');
    expect(resolveAppLocale(' ko ')).toBe('ko');
  });
});
