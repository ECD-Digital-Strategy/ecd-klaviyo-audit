import { supabase } from './supabase';
import { hubAccessToken } from './hub';
import { hasSignedOutCookie, SIGNED_OUT_COOKIE, signedOutCookieString } from './signed-out-flag';

// Sign in once (Emil, 2026-10-28): someone signed in to ECD Hub (PTO, HR, the
// Client Tracker) is signed in here too, instead of being sent a second magic
// link. The hub_sso function checks the Hub sign-in with Hub itself and answers
// with a one-time sign-in for this app, for an account that already exists here.
//
// Signing out here sticks: it turns this off until the next sign-in by email, so
// pressing "Sign out" does not sign you straight back in from Hub.

// The flag is a cookie shared across the ECD subdomains (see signed-out-flag.ts).
// It used to be in this site's localStorage only, so signing out on one
// subdomain did not stick on the others; an old localStorage flag still counts.
const OFF_KEY = SIGNED_OUT_COOKIE;

function legacyOffFlag(): boolean {
  try {
    return localStorage.getItem(OFF_KEY) === '1';
  } catch {
    return false;
  }
}

export function hubSsoEnabled(): boolean {
  try {
    if (hasSignedOutCookie(document.cookie)) return false;
  } catch {
    // no cookies: fall through
  }
  return !legacyOffFlag();
}

export function setHubSsoEnabled(on: boolean) {
  try {
    document.cookie = signedOutCookieString(!on, window.location.hostname, window.location.protocol === 'https:');
  } catch {
    // no cookies: nothing to remember
  }
  try {
    localStorage.removeItem(OFF_KEY);
  } catch {
    // no storage
  }
}

/**
 * Signs in with the person's ECD Hub sign-in, if they have one. Resolves true once
 * this app has a session (onAuthStateChange then reports SIGNED_IN as usual), false
 * when there is no Hub sign-in or Hub's person has no account here.
 */
export async function signInWithHub(): Promise<boolean> {
  if (!hubSsoEnabled()) return false;
  const token = await hubAccessToken();
  if (!token) return false;
  const { data, error } = await supabase.functions.invoke('hub_sso', { headers: { 'x-hub-token': token } });
  const tokenHash = (data as { token_hash?: string } | null)?.token_hash;
  if (error || !tokenHash) return false;
  const { data: verified, error: verifyErr } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
  return !verifyErr && Boolean(verified.session);
}
