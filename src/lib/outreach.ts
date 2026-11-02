import { supabase } from './supabase';
import { createAudit, createAuditSections, createClient } from './db';
import { WEB_AUDIT_SECTION_KEYS } from './audit-sections';
import type { Audit, Client } from './types';

// Outreach, step 1 (Emil, 2026-11-01): a test batch with Emil in the loop. Paste
// store domains; outreach_screen skips anyone already a client or in HubSpot and
// anything that is not Shopify; the rest get an outside-only web audit whose public
// link is a teaser (audit_public); outreach_draft writes the email; Emil edits it,
// sends it from his own mailbox and marks it sent.

// Step 2 (2026-11-02): sending from the page. Emil connects his mailbox here (its
// app password is stored encrypted on the server and never comes back), then either
// sends an email now or queues it; outreach_send's autopilot sends queued emails
// and two follow-ups in US working hours and watches his inbox for replies and
// bounces.

export type OutreachStatus =
  | 'new'
  | 'skipped'
  | 'auditing'
  | 'ready'
  | 'approved'
  | 'sent'
  | 'replied'
  | 'bounced'
  | 'unsubscribed'
  | 'failed';

export type OutreachProspect = {
  id: string;
  domain: string;
  store_name: string | null;
  contact_name: string | null;
  contact_email: string | null;
  /** From the decision-maker lookup (outreach_contacts). */
  contact_title?: string | null;
  contact_source?: 'hunter' | 'hunter_finder' | 'manual' | null;
  /** Hunter's check of the address: valid, catch_all (the domain accepts anything), invalid, unknown. */
  contact_verified?: 'valid' | 'catch_all' | 'invalid' | 'unknown' | null;
  contact_lookup_at?: string | null;
  /** 0-100 from outside signals (supabase/functions/_shared/outreach-score.ts). */
  lead_score?: number | null;
  lead_signals?: { tranco_rank: number | null; products: number | null; currency: string | null; country: string | null; apps: string[]; reasons: string[] } | null;
  /** Set when the auto-pipeline started its audit. */
  auto_started_at?: string | null;
  /** The latest reply, sorted by the autopilot (supabase/functions/_shared/outreach-replies.ts). */
  reply_kind?: ReplyKind | null;
  reply_summary?: string | null;
  reply_text?: string | null;
  hubspot_contact_id?: string | null;
  hubspot_error?: string | null;
  status: OutreachStatus;
  skip_reason: string | null;
  client_id: string | null;
  audit_id: string | null;
  email_subject: string | null;
  email_body: string | null;
  notes: string | null;
  sent_at: string | null;
  approved_at?: string | null;
  last_sent_at?: string | null;
  replied_at?: string | null;
  followups_sent?: number;
  /** Times their report was opened after they were emailed. */
  report_views?: number;
  last_viewed_at?: string | null;
  created_at: string;
  updated_at: string;
  /** Joined: the audit's progress and public link. */
  audit?: Pick<Audit, 'id' | 'status' | 'public_share_token'> | null;
};

export type ReplyKind = 'interested' | 'question' | 'referral' | 'not_now' | 'not_interested' | 'unsubscribe' | 'out_of_office' | 'other';

export const REPLY_LABELS: Record<ReplyKind, string> = {
  interested: 'Interested',
  question: 'Has a question',
  referral: 'Pointed to someone else',
  not_now: 'Not now',
  not_interested: 'Not interested',
  unsubscribe: 'Asked to be removed',
  out_of_office: 'Out of office',
  other: 'Replied',
};

export type ScreenResult = { domain: string; status: 'new' | 'skipped' | 'exists' | 'invalid'; reason?: string; store_name?: string; lead_score?: number };

export { OUTREACH_OWNER_EMAIL, canUseOutreach } from './outreach-access';

export const REPORT_BASE = 'https://audit.ecdigitalstrategy.com/report/';

export async function listProspects(): Promise<OutreachProspect[]> {
  const { data, error } = await supabase
    .from('outreach_prospects')
    .select('*, audit:audits(id, status, public_share_token)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as OutreachProspect[];
}

/** Split pasted text (lines, commas, spaces) into candidate domains. */
export function parseDomains(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}

/** The server checks 15 stores per call; longer lists go in batches, reporting as they go. */
export const SCREEN_BATCH = 15;
export const SCREEN_MAX = 300;

export async function screenDomains(domains: string[], onProgress?: (done: number, results: ScreenResult[]) => void): Promise<ScreenResult[]> {
  const results: ScreenResult[] = [];
  const list = domains.slice(0, SCREEN_MAX);
  for (let i = 0; i < list.length; i += SCREEN_BATCH) {
    const { data, error } = await supabase.functions.invoke('outreach_screen', { body: { domains: list.slice(i, i + SCREEN_BATCH) } });
    if (error) throw new Error(error.message);
    if (!data?.ok) throw new Error(data?.error ?? 'Screening failed');
    results.push(...(data.results as ScreenResult[]));
    onProgress?.(Math.min(list.length, i + SCREEN_BATCH), [...results]);
  }
  return results;
}

export async function updateProspect(id: string, patch: Partial<OutreachProspect>): Promise<void> {
  const { audit: _audit, ...rest } = patch;
  void _audit;
  const { error } = await supabase.from('outreach_prospects').update(rest).eq('id', id);
  if (error) throw error;
}

export async function deleteProspect(id: string): Promise<void> {
  const { error } = await supabase.from('outreach_prospects').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Starts the outside-only web audit: a client row and an audit, both flagged
 * is_outreach so the usual lists leave them out, then the same server-side
 * capture chain the wizard starts. No Shopify step: we have no access, and the
 * pipeline hides the sales section on its own. The chain runs on the server, so
 * the page can be closed.
 */
export async function startOutreachAudit(p: OutreachProspect, userId: string): Promise<void> {
  const name = p.store_name?.trim() || p.domain;
  const websiteUrl = `https://${p.domain}`;
  let clientId = p.client_id;
  if (!clientId) {
    const client = await createClient({
      name,
      company_name: name,
      website_url: websiteUrl,
      industry: '',
      esp_platform: 'Shopify',
      api_key_placeholder: '',
      notes: 'Outreach prospect (Outreach page).',
      created_by: userId,
      is_outreach: true,
    } as Omit<Client, 'id' | 'created_at'>);
    clientId = client.id;
  }
  const audit = await createAudit({
    client_id: clientId,
    title: `${name} - Web Audit`,
    status: 'draft',
    audit_type: 'web',
    audit_method: 'screenshot' as Audit['audit_method'],
    list_size: 0,
    aov: 0,
    monthly_traffic: 0,
    total_revenue_opportunity: 0,
    executive_summary: '',
    created_by: userId,
    show_recommendations: true,
    is_outreach: true,
  } as unknown as Omit<Audit, 'id' | 'created_at' | 'updated_at' | 'published_at' | 'public_share_token'>);
  await createAuditSections(audit.id, [...WEB_AUDIT_SECTION_KEYS]);
  await updateProspect(p.id, { client_id: clientId, audit_id: audit.id, status: 'auditing' });

  const { data, error } = await supabase.functions.invoke('web_capture_screenshots', {
    body: { action: 'seed', audit_id: audit.id, client_id: clientId, pages: { homepage: websiteUrl } },
  });
  if (error || !data?.ok) {
    await updateProspect(p.id, { status: 'failed', notes: [p.notes, `Capture could not start: ${error?.message ?? data?.error?.message ?? 'unknown'}`].filter(Boolean).join('\n') });
    throw new Error(error?.message ?? data?.error?.message ?? 'Screenshot setup failed');
  }
}

export async function draftEmail(prospectId: string): Promise<{ subject: string; body: string }> {
  const { data, error } = await supabase.functions.invoke('outreach_draft', { body: { prospect_id: prospectId } });
  if (error) {
    // The function's own message (e.g. "The audit has not finished yet.") is more useful than the HTTP one.
    const ctx = (error as { context?: Response }).context;
    const body = ctx ? await ctx.json().catch(() => null) : null;
    throw new Error(body?.message ?? body?.error ?? error.message);
  }
  if (!data?.ok) throw new Error(data?.message ?? data?.error ?? 'Drafting failed');
  return { subject: data.subject, body: data.body };
}

/** Opens Gmail's compose window with the email filled in, signed in as whoever is signed in to Gmail. */
export function gmailComposeUrl(to: string, subject: string, body: string): string {
  const q = new URLSearchParams({ view: 'cm', fs: '1', to, su: subject, body });
  return `https://mail.google.com/mail/?${q.toString()}`;
}

// ---------------------------------------------------------------- sending (step 2)

export type OutreachSettings = {
  paused: boolean;
  pause_reason: string | null;
  daily_new_cap: number;
  booking_url: string | null;
  max_followups: number;
  followup_gap_days: number;
  send_start_hour: number;
  send_end_hour: number;
  min_gap_minutes: number;
  /** Emil's Gmail signature, added under every email. */
  signature_html: string | null;
  /** Log emailed prospects and every email in HubSpot. */
  hubspot_log: boolean;
  /** Email Emil when someone replies with something worth answering. */
  reply_alerts: boolean;
  /** Auto-pipeline: find the decision-maker, audit and draft the best new stores on its own. */
  auto_pipeline: boolean;
  auto_audits_per_day: number;
  /** Stores scoring under this are skipped when checked. */
  min_lead_score: number;
};

export type OutreachSendStatus = {
  /** The connected mailbox's address, or null. Its password never comes back. */
  mailbox: string | null;
  sent_today: number;
  settings: OutreachSettings;
  in_window: boolean;
  hubspot?: { connected: boolean; missing_scopes: string[] | null };
  /** Companies on the do-not-contact list. */
  suppressed?: number;
};

async function sendFn<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('outreach_send', { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    const parsed = ctx ? await ctx.json().catch(() => null) : null;
    throw new Error(parsed?.error ?? error.message);
  }
  if (!data?.ok) throw new Error(data?.error ?? 'Request failed');
  return data as T;
}

export const getSendStatus = () => sendFn<OutreachSendStatus>({ action: 'status' });
export const connectMailbox = (user: string, pass: string) => sendFn<{ mailbox: string }>({ action: 'connect_mailbox', user, pass });
export const disconnectMailbox = () => sendFn<void>({ action: 'disconnect_mailbox' });
export const saveSendSettings = (settings: Partial<OutreachSettings>) => sendFn<void>({ action: 'save_settings', settings });
export const sendNow = (prospectId: string) => sendFn<void>({ action: 'send_now', prospect_id: prospectId });
/** Stops everything for this company and never contacts it again. */
export const doNotContact = (prospectId: string) => sendFn<void>({ action: 'do_not_contact', prospect_id: prospectId });

/** Queue for the autopilot: it sends queued emails in order, within the daily limit. */
export const queueProspect = (id: string) => updateProspect(id, { status: 'approved', approved_at: new Date().toISOString() });
export const unqueueProspect = (id: string) => updateProspect(id, { status: 'ready', approved_at: null });

/** A copy to Emil's own mailbox, exactly as it would arrive: a prospect's email, or a sample. */
export const testSend = (prospectId?: string) => sendFn<{ to: string }>({ action: 'test_send', prospect_id: prospectId });

export type OutreachSend = {
  id: string;
  prospect_id: string;
  kind: 'initial' | 'followup_1' | 'followup_2';
  to_email: string;
  subject: string;
  status: 'sent' | 'failed';
  error: string | null;
  sent_at: string;
};

/** Every email sent, newest first, for the Overview's history. */
export async function listSends(limit = 200): Promise<OutreachSend[]> {
  const { data, error } = await supabase.from('outreach_sends').select('*').order('sent_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as OutreachSend[];
}

// ---------------------------------------------------------------- decision-makers

/** Shared inboxes (support@, info@...). outreach_send refuses them; keep in sync with
 * supabase/functions/_shared/outreach-contacts.ts. */
const ROLE_LOCAL_PARTS = new Set([
  'support', 'help', 'info', 'hello', 'hi', 'hey', 'contact', 'contactus', 'team', 'care', 'customercare',
  'customerservice', 'service', 'orders', 'order', 'sales', 'shop', 'store', 'admin', 'office', 'mail',
  'enquiries', 'inquiries', 'questions', 'returns', 'shipping', 'billing', 'accounts', 'careers', 'jobs',
  'press', 'media', 'pr', 'partners', 'partnerships', 'wholesale', 'marketing', 'social', 'noreply',
  'no-reply', 'donotreply', 'webmaster', 'hr', 'legal', 'privacy', 'feedback', 'community', 'ambassadors',
  'affiliates', 'collabs', 'influencers', 'general',
]);
export function isRoleAddress(email: string): boolean {
  const local = email.trim().toLowerCase().split('@')[0]?.split('+')[0] ?? '';
  return Boolean(local) && (ROLE_LOCAL_PARTS.has(local) || ROLE_LOCAL_PARTS.has(local.replace(/[._-]/g, '')));
}

type Quota = { used: number; available: number };
export type HunterStatus = {
  connected: boolean;
  account?: { email: string | null; plan: string | null; reset_date: string | null; credits: Quota | null; searches: Quota; verifications: Quota } | null;
  error?: string;
};

async function contactsFn<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('outreach_contacts', { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    const parsed = ctx ? await ctx.json().catch(() => null) : null;
    throw new Error(parsed?.error ?? error.message);
  }
  if (!data?.ok) throw new Error(data?.error ?? 'Request failed');
  return data as T;
}

export const getHunterStatus = () => contactsFn<HunterStatus>({ action: 'status' });
export const connectHunter = (key: string) => contactsFn<HunterStatus>({ action: 'connect', key });
export const disconnectHunter = () => contactsFn<void>({ action: 'disconnect' });
/** Looks up the store's decision-maker and fills in their name, title and checked email. */
export const findDecisionMaker = (prospectId: string) =>
  contactsFn<{ found: { name: string | null; email: string; title: string | null; verified: string } | null; message?: string }>({ action: 'find', prospect_id: prospectId });
