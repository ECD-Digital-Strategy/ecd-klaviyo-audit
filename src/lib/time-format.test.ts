import { describe, expect, it } from 'vitest';
import { relativeTime } from './time-format';

describe('relativeTime', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  it('counts minutes, hours and days', () => {
    expect(relativeTime('2026-11-10T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-11-10T11:55:00Z', now)).toBe('5m ago');
    expect(relativeTime('2026-11-10T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2026-11-08T12:00:00Z', now)).toBe('2d ago');
  });
  it('is empty for an unreadable date', () => {
    expect(relativeTime('nope', now)).toBe('');
  });
});
