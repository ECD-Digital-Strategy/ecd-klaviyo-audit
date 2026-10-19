import { supabase } from './supabase';

export type XeroStatus = {
  connected: boolean;
  /** False until XERO_CLIENT_ID / XERO_CLIENT_SECRET are configured. */
  credentials_configured: boolean;
  tenant_name: string | null;
  sales_account_code: string | null;
  /** Where recurring lines post, for every service without its own override. */
  mrr_account_code: string | null;
  tax_type: string | null;
  last_refreshed_at: string | null;
  last_error: string | null;
  /** Shown in Settings so it can be pasted into the Xero app config verbatim. */
  redirect_uri: string;
};

export type XeroAccount = { code: string; name: string; taxType: string };

/** One service family (Retention, Website, Paid ads) and the revenue accounts its
 * money posts to: one-time work to one_time_account_code (4011/4012/4013),
 * anything on an ongoing invoice to monthly_account_code (4002/4001/4003). */
export type XeroServiceAccount = {
  service_key: string;
  name: string;
  one_time_account_code: string | null;
  monthly_account_code: string | null;
  display_order: number;
};

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<any>('xero_admin', { body });
  if (error) throw new Error(error.message);
  if (data?.ok !== true) throw new Error(data?.error?.message ?? 'The Xero request failed');
  return data as T;
}

export function getXeroStatus(): Promise<XeroStatus & { ok: true }> {
  return call<XeroStatus & { ok: true }>({ action: 'status' });
}

/** Returns the Xero consent URL to send the admin to. */
export async function startXeroConnect(): Promise<string> {
  const { url } = await call<{ url: string }>({ action: 'connect' });
  return url;
}

export async function listXeroRevenueAccounts(): Promise<XeroAccount[]> {
  const { accounts } = await call<{ accounts: XeroAccount[] }>({ action: 'accounts' });
  return accounts;
}

export function saveXeroSettings(
  input: { account_code?: string; mrr_account_code?: string; tax_type?: string },
): Promise<unknown> {
  return call({ action: 'save_settings', ...input });
}

export async function listXeroServiceAccounts(): Promise<XeroServiceAccount[]> {
  const { services } = await call<{ services: XeroServiceAccount[] }>({ action: 'services' });
  return services;
}

export function saveXeroServiceAccounts(services: XeroServiceAccount[]): Promise<unknown> {
  return call({ action: 'save_services', services });
}

export function deleteXeroServiceAccount(serviceKey: string): Promise<unknown> {
  return call({ action: 'delete_service', delete_service_key: serviceKey });
}

/** A Xero Item a service or proposal line can be mapped to. `account` is the
 * Item's own account in Xero, shown for reference: the invoice posts by the
 * line's family either way. */
export type XeroItem = { code: string; name: string; account: string | null };

let itemsCache: Promise<XeroItem[]> | null = null;

/** Xero's sold Items, fetched once per page load (several pickers share it). */
export function listXeroItems(): Promise<XeroItem[]> {
  if (!itemsCache) {
    itemsCache = call<{ items: XeroItem[] }>({ action: 'items' })
      .then(r => r.items)
      .catch(e => {
        itemsCache = null;
        throw e;
      });
  }
  return itemsCache;
}

/** Code a proposal's uncoded lines: by name, then by Claude. Saves them on the
 * lines; returns how many were coded and how many still need a person. */
export function autoCodeXeroLines(proposalId: string): Promise<{ coded: number; remaining: number; notes: string[] }> {
  return call({ action: 'auto_code', proposal_id: proposalId });
}

export function disconnectXero(): Promise<unknown> {
  return call({ action: 'disconnect' });
}

/** Retry the draft invoice for one proposal (after a failure, or manually). */
export async function createXeroDraftInvoice(proposalId: string): Promise<{ invoice_id: string; invoice_number: string }> {
  const { data, error } = await supabase.functions.invoke<any>('xero_create_invoice', {
    body: { proposal_id: proposalId },
  });
  if (error) throw new Error(error.message);
  if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Could not create the Xero invoice');
  return { invoice_id: data.invoice_id, invoice_number: data.invoice_number };
}

/** Deep link to an invoice in Xero. */
export function xeroInvoiceUrl(invoiceId: string): string {
  return `https://go.xero.com/app/invoicing/edit/${invoiceId}`;
}

const RECONNECT = 'Reconnect Xero under Settings > API Connection, then try again.';

/**
 * A stored or thrown Xero failure in plain words, plus the raw text for
 * whoever needs to dig in. The invoice code keeps Xero's response verbatim
 * (`xero_api_403: {"Title":"Forbidden",...}`), which is right for debugging
 * and unreadable on a proposal page.
 */
export function xeroErrorMessage(raw: string | null | undefined): { message: string; detail: string | null } {
  const text = (raw ?? '').trim();
  const say = (message: string) => ({ message, detail: text && text !== message ? text : null });
  if (!text) return say('Something went wrong creating the invoice. Try again.');

  if (/not.connected|xero_not_connected/i.test(text)) return say(`Xero isn't connected. Connect it under Settings > API Connection, then try again.`);
  if (/xero_no_tenant/.test(text)) return say(`The Xero connection isn't linked to an organisation. ${RECONNECT}`);
  if (/xero_token_|invalid_grant|token_incomplete/.test(text)) return say(`The Xero connection has expired. ${RECONNECT}`);

  const api = /xero_api_(\d{3})/.exec(text);
  if (api) {
    const status = Number(api[1]);
    if (status === 401 || status === 403) {
      return say(`Xero refused the request: the connection has expired or lost access to the organisation. ${RECONNECT}`);
    }
    if (status === 429) return say('Xero is limiting how fast we can send requests. Wait a minute and try again.');
    if (status >= 500) return say('Xero had a problem on its side. Try again in a few minutes.');
    if (status === 400) {
      // Validation failures carry Xero's own readable sentence; use it.
      const messages = [...text.matchAll(/"Message"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
      const unique = [...new Set(messages)].slice(0, 3);
      return say(unique.length ? `Xero rejected the invoice: ${unique.join(' ')}` : 'Xero rejected the invoice. Check the proposal\'s fees and the account mapping, then try again.');
    }
    return say(`Xero returned an error (${status}). Try again, and if it keeps failing, reconnect Xero under Settings > API Connection.`);
  }

  const known: Record<string, string> = {
    xero_no_invoice_returned: "Xero didn't confirm the invoice was created. Check Xero before trying again, so you don't end up with two.",
    no_billable_fees: 'This proposal has no fees to invoice.',
    fully_discounted: "The discount covers the whole proposal, so there's nothing to invoice.",
    already_invoiced: 'This proposal already has a Xero invoice.',
    proposal_not_found: "This proposal couldn't be found.",
  };
  if (known[text]) return say(known[text]);
  // Anything else (like the unmapped-service note) is already written for people.
  return { message: text, detail: null };
}
