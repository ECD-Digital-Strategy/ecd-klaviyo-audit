import { describe, expect, it } from 'vitest';
import { safeInternalPath } from './safe-redirect';

describe('safeInternalPath', () => {
  it('keeps paths on this site', () => {
    expect(safeInternalPath('/')).toBe('/');
    expect(safeInternalPath('/proposals/123?tab=x#y')).toBe('/proposals/123?tab=x#y');
  });

  it('rejects protocol-relative and absolute URLs', () => {
    expect(safeInternalPath('//evil.example')).toBeNull();
    expect(safeInternalPath('/\\evil.example')).toBeNull();
    expect(safeInternalPath('https://evil.example')).toBeNull();
    expect(safeInternalPath('javascript:alert(1)')).toBeNull();
    expect(safeInternalPath('proposals/1')).toBeNull();
  });

  it('rejects control characters and non-strings', () => {
    expect(safeInternalPath('/\t/evil.example')).toBeNull();
    expect(safeInternalPath('/a\nb')).toBeNull();
    expect(safeInternalPath(undefined)).toBeNull();
    expect(safeInternalPath(42)).toBeNull();
    expect(safeInternalPath('')).toBeNull();
  });
});
