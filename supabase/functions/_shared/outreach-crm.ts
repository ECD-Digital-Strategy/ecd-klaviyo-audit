// Outreach and the ECD CRM (Emil, 2026-11-11). Zak, on the 2026-11-06 call: stop connecting Outreach to HubSpot and
// use the ECD CRM (Revenue Desk, schema sales in the ECD Hub). The Hub function crm-outreach answers two questions,
// server to server with a shared key (HUB_OUTREACH_URL + HUB_OUTREACH_KEY):
//   known: does ECD already know this store or this person? (client, deal, company, contact, prospect, event guest,
//          the CRM's do-not-contact list). Anyone known is never cold-emailed.
//   log:   an emailed prospect becomes a CRM company + contact (lead source "Cold outreach", owner Emil), with one
//          history line per email. Records that were already in the CRM are never changed, only noted.
// Every failure throws: callers treat "could not check" as "do not send" (fail closed), never as "unknown = fine".

import type { CrmEvent } from "./outreach-events.ts";

export type CrmMatch = { kind: string; id: string; label: string | null };
export type CrmKnown = { domains: Record<string, CrmMatch[]>; emails: Record<string, CrmMatch[]> };
export type CrmLogResult = { contact_id: string; company_id: string; owns_contact: boolean; owns_company: boolean };
export type CrmLogInput = {
  domain: string;
  email: string;
  store_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  contact_id?: string | null;
  company_id?: string | null;
  event: "sent" | "followup" | "reply";
  subject?: string | null;
  note?: string | null;
  lead_status?: CrmLeadStatus | null;
};
/** Same values HubSpot used, so the CRM reads them the same way. */
export type CrmLeadStatus = "ATTEMPTED_TO_CONTACT" | "CONNECTED" | "BAD_TIMING" | "UNQUALIFIED";

export function crmConfigured(): boolean {
  return Boolean(Deno.env.get("HUB_OUTREACH_URL") && Deno.env.get("HUB_OUTREACH_KEY"));
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const url = Deno.env.get("HUB_OUTREACH_URL") ?? "";
  const key = Deno.env.get("HUB_OUTREACH_KEY") ?? "";
  if (!url || !key) throw new Error("The CRM is not connected (HUB_OUTREACH_URL / HUB_OUTREACH_KEY missing).");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-outreach-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (!res.ok || !data?.ok) throw new Error(`CRM ${res.status}: ${data?.error ?? "no answer"}`);
  return data;
}

/** Everything the CRM knows about these domains and addresses. Throws when it cannot be asked. */
export async function crmKnown(domains: string[], emails: string[] = []): Promise<CrmKnown> {
  const data = await call<CrmKnown>({ action: "known", domains, emails });
  return { domains: data.domains ?? {}, emails: data.emails ?? {} };
}

/** Every CRM event with its guests (Hub migration 0340), newest first. Read only. */
export async function crmEventLeads(): Promise<CrmEvent[]> {
  const data = await call<{ events?: CrmEvent[] }>({ action: "event_leads" });
  return data.events ?? [];
}

export async function crmLog(input: CrmLogInput): Promise<CrmLogResult> {
  return await call<CrmLogResult>({ action: "log", ...input });
}

// Strongest reason first: a client outranks a deal, a deal outranks a bare contact, and so on. An event guest
// comes before company and contact because the event import makes both, and "came to an event" is the useful
// reason: those are warm leads for the event follow-up, not cold ones.
const ORDER = ["client", "deal", "event", "company", "contact", "prospect", "suppressed"];

/**
 * Why this store must not be cold-emailed, or null when the CRM does not know it. Records Outreach made itself
 * (their ids are on the prospect) do not count, or a prospect would block its own follow-up check.
 */
export function crmSkipReason(matches: CrmMatch[] | undefined, own: { contactId?: string | null; companyId?: string | null } = {}): string | null {
  const mine = new Set([own.contactId, own.companyId].filter(Boolean).map(String));
  const real = (matches ?? []).filter((m) => !mine.has(String(m.id)));
  if (!real.length) return null;
  real.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const m = real[0];
  switch (m.kind) {
    case "client":
      return "Already an ECD client (CRM)";
    case "deal":
      return `In the CRM (deal${m.label ? `, ${m.label}` : ""})`;
    case "company":
      return "In the CRM (company)";
    case "contact":
      return "In the CRM (contact)";
    case "prospect":
      return "In the CRM (prospect)";
    case "event":
      return `Came to an ECD event${m.label ? ` (${m.label})` : ""}`;
    case "suppressed":
      return `On the CRM's do-not-contact list${m.label ? ` (${m.label.replace(/_/g, " ")})` : ""}`;
    default:
      return `In the CRM (${m.kind})`;
  }
}
