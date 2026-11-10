import { describe, expect, it } from 'vitest';
import { hasSignedOutCookie, signedOutCookieString } from './signed-out-flag';

describe('signedOutCookieString', () => {
  it('shares the flag across ECD subdomains', () => {
    const s = signedOutCookieString(true, 'proposal.ecdigitalstrategy.com', true);
    expect(s).toContain('ecd_hub_sso_off=1');
    expect(s).toContain('domain=.ecdigitalstrategy.com');
    expect(s).toContain('path=/');
    expect(s).toContain('secure');
    expect(s).toMatch(/max-age=\d{6,}/);
  });

  it('is a plain host cookie on localhost', () => {
    const s = signedOutCookieString(true, 'localhost', false);
    expect(s).toContain('ecd_hub_sso_off=1');
    expect(s).not.toContain('domain=');
    expect(s).not.toContain('secure');
  });

  it('clears with max-age 0 on the same domain', () => {
    const s = signedOutCookieString(false, 'audit.ecdigitalstrategy.com', true);
    expect(s).toContain('max-age=0');
    expect(s).toContain('domain=.ecdigitalstrategy.com');
  });

  it('does not share with look-alike hosts', () => {
    expect(signedOutCookieString(true, 'notecdigitalstrategy.com', true)).not.toContain('domain=');
  });
});

describe('hasSignedOutCookie', () => {
  it('finds the flag among other cookies', () => {
    expect(hasSignedOutCookie('a=1; ecd_hub_sso_off=1; b=2')).toBe(true);
    expect(hasSignedOutCookie('ecd_hub_sso_off=1')).toBe(true);
  });

  it('is false when missing or cleared', () => {
    expect(hasSignedOutCookie('')).toBe(false);
    expect(hasSignedOutCookie('a=1; ecd_hub_sso_off=')).toBe(false);
    expect(hasSignedOutCookie('x_ecd_hub_sso_off=1')).toBe(false);
  });
});
