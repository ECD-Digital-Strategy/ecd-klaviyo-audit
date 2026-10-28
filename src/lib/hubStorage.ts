/**
 * Where the app rail keeps its ECD Hub sign-in: the same place PTO, HR and the
 * Client Tracker keep theirs (their src/lib/authStorage.ts), a cookie on
 * .ecdigitalstrategy.com under Hub's default key. So someone already signed in
 * to any of those apps sees their rail here at once, and signing in from here
 * signs them in there too. Outside that domain (localhost, deploy previews) it
 * falls back to this site's localStorage.
 *
 * This is ECD Hub's sign-in only. This app's own sign-in is a different project
 * and a different cookie (src/lib/supabase.ts), and neither touches the other.
 */

const SHARED_DOMAIN = '.ecdigitalstrategy.com';
const COOKIE_MAX_AGE_DAYS = 30;

function onSharedDomain(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  return h === 'ecdigitalstrategy.com' || h.endsWith(SHARED_DOMAIN);
}

function getCookie(name: string): string | null {
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${name}=`));
  if (!match) return null;
  try {
    return decodeURIComponent(match.split('=').slice(1).join('=').replace(/^"/, '').replace(/"$/, ''));
  } catch {
    return null;
  }
}

function setCookie(name: string, value: string): void {
  const encoded = encodeURIComponent(value);
  const maxAge = COOKIE_MAX_AGE_DAYS * 24 * 60 * 60;
  document.cookie = `${name}=${encoded}; path=/; domain=${SHARED_DOMAIN}; max-age=${maxAge}; secure; samesite=lax`;
}

function removeCookie(name: string): void {
  document.cookie = `${name}=; path=/; domain=${SHARED_DOMAIN}; max-age=0`;
}

export function createHubStorage(): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
} {
  const shared = onSharedDomain();
  return {
    getItem(key) {
      if (shared) {
        const fromCookie = getCookie(key);
        if (fromCookie != null && fromCookie !== '') return fromCookie;
      }
      return localStorage.getItem(key);
    },
    setItem(key, value) {
      localStorage.setItem(key, value);
      if (shared) {
        try {
          setCookie(key, value);
        } catch {
          // Too big for a cookie: the sign-in still lives in this site's localStorage.
        }
      }
    },
    removeItem(key) {
      localStorage.removeItem(key);
      if (shared) removeCookie(key);
    },
  };
}
