import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { HUB_CODE_KEY } from './hubCapture';

// The ECD app rail (Zak, 2026-10-27), copied from Revenue Desk (src/data/rail.ts in
// ECD-Digital-Strategy/ecd-revenue-desk). Zak decides on ECD Hub which apps exist
// and who sees each; everyone arranges their own rail.
//
// This app signs in with its own Supabase project, so the rail has a second client
// of its own, pointed at ECD Hub, with its own sign-in kept apart from the app's.
// It calls only the two rail functions below: never a table, and the app list is
// never copied into this app.

export type RailPlace = 'rail' | 'more' | 'hidden';
export type RailApp = {
  id: string;
  name: string;
  label: string;
  url: string;
  icon: string;
  this_app: boolean;
  place: RailPlace;
};

/** This app's id in Hub's list. Its tile is "you are here", always on the rail. */
export const RAIL_APP_ID = 'proposals';

const HUB_URL = import.meta.env.VITE_ECD_HUB_URL as string | undefined;
const HUB_KEY = import.meta.env.VITE_ECD_HUB_PUBLISHABLE_KEY as string | undefined;

let client: SupabaseClient | null = null;
function hub(): SupabaseClient | null {
  if (!HUB_URL || !HUB_KEY) return null;
  client ??= createClient(HUB_URL, HUB_KEY, {
    auth: {
      storageKey: 'ecd-hub-proposals',
      flowType: 'pkce',
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return client;
}

/** Whether the rail can be shown at all: false when Hub is not configured for this build. */
export const hubConfigured = () => hub() !== null;

let signingIn: Promise<boolean> | null = null;
/**
 * Finishes a Hub sign-in link that came back to this page (hubCapture.ts kept its
 * code), then says whether Hub knows who this is.
 */
export function hubSignedIn(): Promise<boolean> {
  signingIn ??= (async () => {
    const h = hub();
    if (!h) return false;
    let code: string | null = null;
    try {
      code = window.sessionStorage.getItem(HUB_CODE_KEY);
      window.sessionStorage.removeItem(HUB_CODE_KEY);
    } catch {
      // no storage
    }
    if (code) await h.auth.exchangeCodeForSession(code).catch(() => undefined);
    const { data } = await h.auth.getSession();
    return Boolean(data.session);
  })().finally(() => {
    signingIn = null;
  });
  return signingIn;
}

/** Emails a Hub sign-in link that comes back to this page. Hub never creates an account here. */
export async function sendHubLink(email: string): Promise<void> {
  const h = hub();
  if (!h) throw new Error('ECD Hub is not set up for this app');
  const back = new URL(window.location.href);
  back.hash = '';
  back.searchParams.set('ecd_hub', '1');
  const { error } = await h.auth.signInWithOtp({
    email: email.trim(),
    options: { shouldCreateUser: false, emailRedirectTo: back.toString() },
  });
  if (error) throw new Error(error.message);
}

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const h = hub();
  if (!h) throw new Error('ECD Hub is not set up for this app');
  const { data, error } = await h.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

// A person's rail, in their order. this_app in Hub's answer means Revenue Desk, so it
// is set here for this app's own tile instead. Nothing is added or removed: the list
// is exactly what Hub returns.
export async function fetchRail(): Promise<RailApp[]> {
  const apps = await call<RailApp[]>('sales_rail_get', { p_owner: null });
  return (apps ?? []).map((a) => {
    const here = a.id === RAIL_APP_ID;
    return { ...a, this_app: here, place: here ? 'rail' : a.place === 'rail' || a.place === 'more' ? a.place : 'hidden' };
  });
}

// Replaces the person's whole arrangement; [] goes back to the default.
export const saveRail = (apps: Pick<RailApp, 'id' | 'place'>[]) =>
  call<void>('sales_rail_save', { p_places: apps.map((a) => ({ app_id: a.id, place: a.place })) });

// Rail first, then More, then hidden, each in the person's order: the order sales_rail_save stores.
export function railOrder(apps: RailApp[]): RailApp[] {
  const rank: Record<RailPlace, number> = { rail: 0, more: 1, hidden: 2 };
  return apps
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank[x.a.place] - rank[y.a.place] || x.i - y.i)
    .map((x) => x.a);
}
