import { describe, expect, it } from 'vitest';
import { impliesOptional } from './line-optional';

describe('impliesOptional', () => {
  it('flags names that start with Optional', () => {
    expect(impliesOptional('Optional: AfterShip Returns Setup')).toBe(true);
    expect(impliesOptional('Optional - SMS build')).toBe(true);
    expect(impliesOptional('(Optional) Popup design')).toBe(true);
    expect(impliesOptional('[optional] Popup design')).toBe(true);
    expect(impliesOptional('Optional add-on: Reviews')).toBe(true);
    expect(impliesOptional('  OPTIONAL Loyalty')).toBe(true);
    expect(impliesOptional('Optional')).toBe(true);
  });

  it('leaves other names alone', () => {
    expect(impliesOptional('Email retainer')).toBe(false);
    expect(impliesOptional('Flows (optional)')).toBe(false);
    expect(impliesOptional('Optionality review')).toBe(false);
    expect(impliesOptional('')).toBe(false);
    expect(impliesOptional(null)).toBe(false);
    expect(impliesOptional(undefined)).toBe(false);
  });
});
