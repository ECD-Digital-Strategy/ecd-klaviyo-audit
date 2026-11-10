import { createContext, useCallback, useContext, useMemo, useState, useEffect, useRef, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import type { Profile, UserRole } from '../lib/types';
import { clearCachedProfile, readCachedProfile, writeCachedProfile } from '../lib/profile-cache';
import { isAllowedSignInEmail, signInErrorMessage } from '../lib/sign-in-policy';
import { hubSsoEnabled, setHubSsoEnabled, signInWithHub } from '../lib/hubSso';
import { safeInternalPath } from '../lib/safe-redirect';

interface AuthState {
  user: Profile | null;
  isLoading: boolean;
  /** A saved session is being refreshed; signed in again in a moment. */
  isRestoring: boolean;
  authError: string;
  /** Signed in, but the profile could not be read (timeout or server error). */
  serverUnreachable: boolean;
  /** Try the profile read again after serverUnreachable. */
  retryAuth: () => void;
  sendMagicLink: (email: string, redirectPath?: string) => Promise<void>;
  signOut: () => Promise<void>;
  hasRole: (role: UserRole | UserRole[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

const PROFILE_COLUMNS = 'id,name,email,role,app_access,created_at';

// This app's own project ref. The app rail keeps ECD Hub's sign-in in a cookie of
// the same shape (sb-<hub ref>-auth-token), which must not count as signed in here.
const PROJECT_REF = (() => {
  try {
    return new URL(import.meta.env.VITE_SUPABASE_URL).hostname.split('.')[0];
  } catch {
    return '';
  }
})();

/** Whether the browser holds this app's Supabase session cookie (sb-<ref>-auth-token,
 *  possibly split into .0/.1 chunks), i.e. someone has signed in here before. */
function hasSessionCookie(): boolean {
  if (typeof document === 'undefined' || !PROJECT_REF) return false;
  const name = new RegExp(`^\\s*sb-${PROJECT_REF}-auth-token(\\.\\d+)?=.`);
  return document.cookie.split(';').some((c) => name.test(c));
}
const ADMIN_DOMAIN = 'ecdigitalstrategy.com';

// How long the profile read (with its refresh retries) may take before we say
// the server cannot be reached, instead of a loading screen that never ends.
const PROFILE_LOAD_TIMEOUT_MS = 6000;

/** Same profile as far as the app can tell (the columns we read). */
function sameProfile(a: Profile | null, b: Profile): boolean {
  if (!a) return false;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.email === b.email &&
    a.role === b.role &&
    a.created_at === b.created_at &&
    JSON.stringify(a.app_access ?? null) === JSON.stringify(b.app_access ?? null)
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // The cached profile is shared by every tab on this origin but the session
  // cookie is what says someone is signed in (it is cleared on sign-out on any
  // ECD subdomain), so without the cookie the cache is stale.
  const [cachedProfile] = useState(() => {
    if (hasSessionCookie()) return readCachedProfile();
    clearCachedProfile();
    return null;
  });
  const [user, setUser] = useState<Profile | null>(cachedProfile);
  const [isLoading, setIsLoading] = useState(!cachedProfile);
  const [authError, setAuthError] = useState('');
  const [serverUnreachable, setServerUnreachable] = useState(false);
  // True while a saved but expired session is being refreshed, so the app can
  // say "Signing you in" instead of flashing the login screen.
  const [isRestoring, setIsRestoring] = useState(false);
  // The profile read in flight, so a second auth event for the same user waits
  // for it instead of finishing the initial load while it is still running.
  const inFlight = useRef<{ userId: string; promise: Promise<void> } | null>(null);
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    let isMounted = true;

    const applyProfile = (profile: Profile) => {
      // Every auth event (the hourly token refresh too) reads the profile again;
      // only a real change should re-render the app.
      setUser((prev) => (sameProfile(prev, profile) ? prev : profile));
      writeCachedProfile(profile);
      setAuthError('');
      setServerUnreachable(false);
    };

    const loadSessionUser = async (sessionUser: { id: string; email?: string | null }) => {
      const email = (sessionUser.email ?? '').toLowerCase().trim();

      const fetchProfile = () => supabase
        .from('profiles')
        .select(PROFILE_COLUMNS)
        .eq('id', sessionUser.id)
        .maybeSingle();
      const readProfile = async () => {
        let { data: existing, error: profileErr } = await fetchProfile();
        // The usual cause of "login screen, then signed in a second later": the
        // profile read went out on an access token that was just expiring, it
        // failed, and a failed read looked like being signed out until the
        // refresh landed. Refresh and read again before giving up. One retry was
        // not enough (Emil, 2026-10-28): the refresh supabase-js starts on its own
        // can still be in flight, so ours fails and the second read goes out on
        // the same old token. A few spaced tries ride that out (about 5s at most).
        for (let attempt = 1; profileErr && isMounted && attempt <= 4; attempt++) {
          await supabase.auth.refreshSession().catch(() => null);
          ({ data: existing, error: profileErr } = await fetchProfile());
          if (profileErr) await new Promise((r) => setTimeout(r, 400 * attempt));
        }
        return { existing, profileErr };
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), PROFILE_LOAD_TIMEOUT_MS);
      });
      const read = readProfile().catch(() => 'failed' as const);
      const result = await Promise.race([read, timedOut]);
      clearTimeout(timer);

      if (!isMounted) return;
      if (result === 'timeout') {
        // A late answer still signs them in without pressing Retry.
        void read.then((late) => {
          if (isMounted && late !== 'failed' && !late.profileErr && late.existing) applyProfile(late.existing as Profile);
        });
      }
      if (result === 'timeout' || result === 'failed' || result.profileErr) {
        // Not "signed out" and not raw database text: say the server is not
        // answering and offer a retry. A cached profile keeps the app usable.
        setServerUnreachable(true);
        return;
      }
      const { existing } = result;

      if (existing) {
        applyProfile(existing as Profile);
        return;
      }

      setServerUnreachable(false);
      const isEcdEmail = email.endsWith(`@${ADMIN_DOMAIN}`);
      if (!isEcdEmail) {
        setAuthError('Your account has not been set up yet. Please contact the ECD team.');
        await supabase.auth.signOut();
        if (!isMounted) return;
        setUser(null);
        clearCachedProfile();
        return;
      }

      const defaultName = (email.split('@')[0] || '').replace(/\./g, ' ').trim();
      // A first sign-in from the company domain self-provisions as a MEMBER
      // with all three areas (the column default), not as an admin: this is
      // exactly how every account ended up admin before roles existed. Admins
      // are made by other admins in Settings, never by signing in.
      const { data: created, error: insertErr } = await supabase
        .from('profiles')
        .insert({
          id: sessionUser.id,
          name: defaultName,
          email,
          role: 'auditor',
        })
        .select(PROFILE_COLUMNS)
        .single();

      if (!isMounted) return;
      if (insertErr) {
        setAuthError(insertErr.message);
        return;
      }

      applyProfile(created as Profile);
    };

    const handleSessionUser = (sessionUser: { id: string; email?: string | null }): Promise<void> => {
      // Same user already loading: share that read so this event's follow-up
      // (finishing the initial load) waits for it too.
      if (inFlight.current?.userId === sessionUser.id) return inFlight.current.promise;
      const entry = {
        userId: sessionUser.id,
        promise: loadSessionUser(sessionUser).finally(() => {
          if (inFlight.current === entry) inFlight.current = null;
        }),
      };
      inFlight.current = entry;
      return entry.promise;
    };

    // Retry after "Can't reach the server": read the profile for the current session again.
    retryRef.current = () => {
      if (isMounted) {
        setServerUnreachable(false);
        setIsLoading(true);
      }
      void supabase.auth
        .getSession()
        .then(({ data }) => {
          const sessionUser = data.session?.user;
          if (sessionUser) return handleSessionUser({ id: sessionUser.id, email: sessionUser.email });
        })
        .catch(() => {
          if (isMounted) setServerUnreachable(true);
        })
        .finally(() => {
          if (isMounted) setIsLoading(false);
        });
    };

    // A saved session whose access token has expired comes back as "no session"
    // first and only signs in once the refresh lands, a second or two later.
    // Showing the login screen in that gap told a signed-in person they were
    // signed out (Emil, Oct 8). While a session cookie is there, we wait for the
    // refresh behind a "Signing you in" screen, and only show the login once it
    // has really failed.
    let restoring = false;
    let restoreTimer: ReturnType<typeof setTimeout> | null = null;
    const endRestore = () => {
      restoring = false;
      if (restoreTimer) clearTimeout(restoreTimer);
      restoreTimer = null;
      if (isMounted) {
        setIsRestoring(false);
        setIsLoading(false);
      }
    };
    const signedOut = () => {
      inFlight.current = null;
      setUser(null);
      setServerUnreachable(false);
      clearCachedProfile();
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const finishInitialLoad = () => {
        if (event === 'INITIAL_SESSION' && isMounted) setIsLoading(false);
      };

      if (session?.user) {
        // Wait for the profile fetch to resolve before clearing isLoading -- otherwise
        // there's a window where the session is known but `user` is still null, which
        // App.tsx reads as "logged out" and bounces to /login, losing the deep link the
        // user actually clicked (e.g. a proposal notification email).
        // A session is there, so the loading screen says what is happening.
        if (event === 'INITIAL_SESSION' && isMounted) setIsRestoring(true);
        void handleSessionUser({ id: session.user.id, email: session.user.email }).finally(() => {
          if (restoring) endRestore();
          else {
            if (event === 'INITIAL_SESSION' && isMounted) setIsRestoring(false);
            finishInitialLoad();
          }
        });
        return;
      }

      if (event === 'INITIAL_SESSION' && hasSessionCookie()) {
        restoring = true;
        if (isMounted) {
          setIsRestoring(true);
          setIsLoading(true);
        }
        // The refresh reports back through this same listener on success.
        void supabase.auth.refreshSession().then(async ({ data, error }) => {
          if (!restoring) return;
          if (error || !data.session) {
            // The saved sign-in here is gone for good; an ECD Hub one may still do.
            if (await signInWithHub().catch(() => false)) return;
            if (!restoring) return;
            signedOut();
            endRestore();
          }
        });
        // Never strand someone on the loading screen if the refresh hangs.
        restoreTimer = setTimeout(() => {
          if (!restoring) return;
          signedOut();
          endRestore();
        }, 8000);
        return;
      }

      // No sign-in here, but maybe one with ECD Hub (PTO, HR, the Client Tracker):
      // try that behind the "Signing you in" screen before showing the login. On
      // success this same listener hears SIGNED_IN and finishes the restore.
      if (event === 'INITIAL_SESSION' && hubSsoEnabled()) {
        restoring = true;
        if (isMounted) {
          setIsRestoring(true);
          setIsLoading(true);
        }
        void signInWithHub()
          .catch(() => false)
          .then((ok) => {
            if (!restoring || ok) return;
            signedOut();
            endRestore();
          });
        restoreTimer = setTimeout(() => {
          if (!restoring) return;
          signedOut();
          endRestore();
        }, 8000);
        return;
      }

      signedOut();
      if (restoring) endRestore();
      else finishInitialLoad();
    });

    return () => {
      isMounted = false;
      if (restoreTimer) clearTimeout(restoreTimer);
      subscription.unsubscribe();
    };
  }, []);

  const sendMagicLink = useCallback(async (email: string, redirectPath?: string) => {
    const trimmed = email.trim().toLowerCase();
    setAuthError('');

    // Preserve the page the user was trying to reach (e.g. a proposal link from an
    // email notification) so the magic link drops them back there instead of at "/".
    const safePath = safeInternalPath(redirectPath);
    const target = safePath ? `${window.location.origin}${safePath}` : window.location.origin;

    // Refuse anything off the agency's domain before an email is even sent.
    if (!isAllowedSignInEmail(trimmed)) {
      throw new Error('Use your ECD Digital Strategy email address to sign in.');
    }

    const { error } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        emailRedirectTo: target,
        // Invited accounts only. This used to create an account for whatever
        // address was typed in, which is how three strangers ended up with
        // accounts here. Signing in can no longer bring an account into being.
        shouldCreateUser: false,
      },
    });
    if (error) throw new Error(signInErrorMessage(error.message));
    // Signing in on purpose turns "signed in with ECD Hub" back on.
    setHubSsoEnabled(true);
  }, []);

  const signOut = useCallback(async () => {
    // Stay signed out: without this the Hub sign-in would sign straight back in.
    setHubSsoEnabled(false);
    await supabase.auth.signOut();
    setUser(null);
    setServerUnreachable(false);
    clearCachedProfile();
  }, []);

  const hasRole = useCallback((role: UserRole | UserRole[]) => {
    if (!user) return false;
    const roles = Array.isArray(role) ? role : [role];
    return roles.includes(user.role);
  }, [user]);

  const retryAuth = useCallback(() => retryRef.current(), []);

  // Memoized so consumers re-render only when something here really changes.
  const value = useMemo(
    () => ({ user, isLoading, isRestoring, authError, serverUnreachable, retryAuth, sendMagicLink, signOut, hasRole }),
    [user, isLoading, isRestoring, authError, serverUnreachable, retryAuth, sendMagicLink, signOut, hasRole],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
