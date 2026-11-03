import { supabase } from './supabase';

// "What's new" dismissal state, stored server-side so it is shared across the
// audit. and proposal. subdomains (localStorage is per-origin) and across devices.
//
// 2026-11-03: during a Supabase slowdown the user lookup timed out, this returned
// "seen nothing", and the popup came back for people who had dismissed it (and a
// "Got it" then could have saved a shorter list). Now: the user id comes from the
// stored session (no network), any failure THROWS so the modal stays quiet, the
// seen list is also remembered in this browser, and saving only ever adds.

const LOCAL_KEY = 'ecd_seen_announcements';

function localSeen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rememberLocally(ids: string[]) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(Array.from(new Set([...localSeen(), ...ids]))));
  } catch {
    // private mode: the server copy still holds it
  }
}

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const uid = data.session?.user?.id;
  if (!uid) throw new Error('not_signed_in');
  return uid;
}

/** Everything this user has dismissed. Throws when it cannot tell (the caller then shows nothing). */
export async function getSeenAnnouncements(): Promise<string[]> {
  const uid = await currentUserId();
  const { data, error } = await supabase
    .from('user_announcement_state')
    .select('seen')
    .eq('user_id', uid)
    .maybeSingle();
  if (error) throw error;
  const server = Array.isArray(data?.seen) ? (data!.seen as string[]) : [];
  const merged = Array.from(new Set([...server, ...localSeen()]));
  rememberLocally(merged);
  return merged;
}

export async function markAnnouncementsSeen(ids: string[]): Promise<void> {
  rememberLocally(ids);
  const uid = await currentUserId();
  // Only ever adds: if the current list can't be read, don't overwrite it with a shorter one.
  const existing = await getSeenAnnouncements();
  const merged = Array.from(new Set([...existing, ...ids]));
  const { error } = await supabase
    .from('user_announcement_state')
    .upsert({ user_id: uid, seen: merged, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw error;
}
