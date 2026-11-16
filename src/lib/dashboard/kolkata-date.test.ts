import { describe, expect, it } from 'vitest';
import { kolkataDayStart } from './date-utils';

describe('Kolkata dashboard day', () => {
  it('uses India midnight regardless of the machine timezone', () => {
    expect(kolkataDayStart(new Date('2026-11-15T19:00:00Z')).toISOString()).toBe('2026-11-15T18:30:00.000Z');
    expect(kolkataDayStart(new Date('2026-11-15T18:00:00Z')).toISOString()).toBe('2026-11-14T18:30:00.000Z');
    expect(k(kolkataDayStart(new Date('2026-11-15T19:00:00Z'), 1))).toBe('2026-11-14T18:30:00.000Z');
  });
});
function k(d: Date) { return d.toISOString(); }
