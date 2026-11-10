// "Stay signed out" flag for the ECD Hub sign-in. It lives in a cookie on
// .ecdigitalstrategy.com (like this app's session), so signing out on one ECD
// subdomain is not undone by Hub signing straight back in on another. Outside
// that domain (localhost, previews) it is a plain cookie for this host.

export const SIGNED_OUT_COOKIE = 'ecd_hub_sso_off';
const SHARED_DOMAIN = '.ecdigitalstrategy.com';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function isSharedHost(hostname: string): boolean {
  return hostname === 'ecdigitalstrategy.com' || hostname.endsWith(SHARED_DOMAIN);
}

/** The document.cookie assignment that sets (signedOut true) or clears the flag. */
export function signedOutCookieString(signedOut: boolean, hostname: string, secure: boolean): string {
  const parts = [
    `${SIGNED_OUT_COOKIE}=${signedOut ? '1' : ''}`,
    'path=/',
    `max-age=${signedOut ? MAX_AGE_SECONDS : 0}`,
    'samesite=lax',
  ];
  if (isSharedHost(hostname)) parts.push(`domain=${SHARED_DOMAIN}`);
  if (secure) parts.push('secure');
  return parts.join('; ');
}

/** Whether a document.cookie string carries the flag. */
export function hasSignedOutCookie(cookie: string): boolean {
  return cookie.split(';').some(c => c.trim() === `${SIGNED_OUT_COOKIE}=1`);
}
