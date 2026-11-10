import { describe, expect, it } from 'vitest';
import { addDaysToDate, businessDate, dateDiffDays, isPastValidUntil, validUntilCutoff } from './valid-until';

// Same cases as supabase/functions/_shared/valid-until.test.ts. Times carry explicit offsets so the
// result does not depend on the machine's time zone.
describe('valid-until (New York clock)', () => {
  it('cuts off at midnight New York after the day, in summer (EDT)', () => {
    expect(validUntilCutoff('2026-08-01')?.toISOString()).toBe('2026-08-02T04:00:00.000Z');
  });

  it('cuts off at midnight New York after the day, in winter (EST)', () => {
    expect(validUntilCutoff('2026-12-01')?.toISOString()).toBe('2026-12-02T05:00:00.000Z');
  });

  it('handles the DST change days', () => {
    expect(validUntilCutoff('2026-03-07')?.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(validUntilCutoff('2026-03-08')?.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(validUntilCutoff('2026-10-31')?.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(validUntilCutoff('2026-11-01')?.toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  it('is still valid late on the last day in New York, even when it is already the next day in Europe', () => {
    expect(isPastValidUntil('2026-08-01', new Date('2026-08-01T23:59:00-04:00'))).toBe(false);
    expect(isPastValidUntil('2026-08-01', new Date('2026-08-02T02:00:00+02:00'))).toBe(false);
  });

  it('is expired from midnight New York', () => {
    expect(isPastValidUntil('2026-08-01', new Date('2026-08-02T00:00:00-04:00'))).toBe(true);
  });

  it('never expires without a date, and ignores junk', () => {
    expect(isPastValidUntil(null)).toBe(false);
    expect(isPastValidUntil('not a date')).toBe(false);
    expect(validUntilCutoff('2026-02-30')).toBeNull();
  });

  it('gives the New York date and adds days', () => {
    expect(businessDate(new Date('2026-08-02T03:00:00Z'))).toBe('2026-08-01');
    expect(businessDate(new Date('2026-08-02T05:00:00Z'))).toBe('2026-08-02');
    expect(addDaysToDate('2026-08-01', 30)).toBe('2026-08-31');
    expect(addDaysToDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(dateDiffDays('2026-08-01', '2026-08-31')).toBe(30);
  });
});
