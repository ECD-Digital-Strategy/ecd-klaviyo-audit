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

export type ScreenResult = { domain: string; status: 'new' | 'skipped' | 'exists' | 'invalid'; reason?: string; store_name?: string };

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

export async function screenDomains(domains: string[]): Promise<ScreenResult[]> {
  const { data, error } = await supabase.functions.invoke('outreach_screen', { body: { domains } });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? 'Screening failed');
  return data.results as ScreenResult[];
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
};

export type OutreachSendStatus = {
  /** The connected mailbox's address, or null. Its password never comes back. */
  mailbox: string | null;
  sent_today: number;
  settings: OutreachSettings;
  in_window: boolean;
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
