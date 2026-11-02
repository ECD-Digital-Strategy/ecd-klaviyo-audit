import { supabase } from './supabase';

// Invoices emailed to the client from a person's own Gmail (Emil + Isa,
// 2026-11-02). People connect their Gmail in Proposal settings (gmail_connect);
// each proposal picks whose Gmail its invoice comes from. Switched on and off in
// Proposal settings (proposal_settings.invoicing); off until then. Server side:
// supabase/functions/_shared/gmail.ts, invoice-delivery.ts, invoice_followup.

export type GmailConnection = {
  user_id: string;
  name: string;
  email: string;
  connected_at: string;
  last_used_at: string | null;
  /** The last thing that went wrong sending from it, e.g. it needs reconnecting. */
  last_error: string | null;
  is_me: boolean;
};

export type GmailStatus = {
  /** Google sign-in is set up (the OAuth client is saved). */
  configured: boolean;
  /** Admins only: which Google client is saved (never the secret). */
  client_id_hint: string | null;
  /** The redirect URI to add on the Google OAuth client. */
  redirect_uri: string;
  is_admin: boolean;
  mine: GmailConnection | null;
  /** Everyone whose Gmail is connected. */
  connections: GmailConnection[];
};

export type InvoiceSender = { user_id: string; name: string; email: string; connected_at: string };

async function call<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    const parsed = ctx ? await ctx.json().catch(() => null) : null;
    throw new Error(parsed?.error ?? error.message);
  }
  if (!data?.ok) throw new Error(data?.error ?? 'Request failed');
  return data as T;
}

export const getGmailStatus = () => call<GmailStatus>('gmail_connect', { action: 'status' });
/** Your own Gmail, or (admins) someone else's. */
export const disconnectGmail = (userId?: string) => call<void>('gmail_connect', { action: 'disconnect', user_id: userId });
export const sendGmailTest = () => call<{ to: string }>('gmail_connect', { action: 'test' });
export const saveGoogleClient = (clientId: string, clientSecret: string) =>
  call<void>('gmail_connect', { action: 'save_client', client_id: clientId, client_secret: clientSecret });

/** Goes to Google sign-in; Google sends the browser back to this page. */
export async function connectGmail(): Promise<void> {
  const { url } = await call<{ url: string }>('gmail_connect', { action: 'start', return_to: window.location.href });
  window.location.assign(url);
}

/** Everyone whose Gmail is connected, for the "Invoice sent by" picker. */
export async function listInvoiceSenders(): Promise<InvoiceSender[]> {
  const { data, error } = await supabase.rpc('invoice_senders');
  if (error) throw error;
  return (data ?? []) as InvoiceSender[];
}

/** Emails an approved invoice to the client now (only while invoice emails are on). */
export const emailInvoiceNow = (proposalId: string, invoiceId: string) =>
  call<{ to: string; from: string }>('invoice_followup', { action: 'email_invoice', proposal_id: proposalId, invoice_id: invoiceId });
