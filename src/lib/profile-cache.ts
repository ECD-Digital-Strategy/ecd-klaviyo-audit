import type { Profile } from './types';

// Kept in localStorage, not sessionStorage (Emil, 2026-10-28): a new tab starts
// with an empty sessionStorage, so every fresh visit had to wait for the session
// and the profile before it knew who was signed in, and could show the login
// screen in the meantime. AuthContext still confirms the session in the
// background and clears this the moment it is gone, and signing out clears it.
const PROFILE_CACHE_KEY = 'ecd_auth_profile_v2';
const OLD_SESSION_KEY = 'ecd_auth_profile_v1';

export function readCachedProfile(): Profile | null {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_KEY) ?? sessionStorage.getItem(OLD_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { profile?: Profile };
    return parsed.profile ?? null;
  } catch {
    return null;
  }
}

export function writeCachedProfile(profile: Profile) {
  try {
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({ profile }));
  } catch {
    /* ignore quota errors */
  }
}

export function clearCachedProfile() {
  try {
    localStorage.removeItem(PROFILE_CACHE_KEY);
    sessionStorage.removeItem(OLD_SESSION_KEY);
  } catch {
    /* ignore */
  }
}
