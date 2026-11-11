// Event and webinar guests as Outreach leads (Emil, 2026-11-11). Zak, on the 2026-11-06 call: guests of ECD's
// webinars and events are the warmest leads we have and nobody follows up with them; take out agencies first, and
// try a plain "where do you need the most help?" email against the audit-led one. The lists live in the ECD CRM
// (sales.events, sales.event_attendees) and come over through crm-outreach (event_leads). Pure helpers, tested.

import type { CrmMatch } from "./outreach-crm.ts";

export type EventGuest = {
  brand: string | null;
  domain: string | null;
  contact_id: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  removed: boolean;
};
export type CrmEvent = { id: string; name: string; kind: string | null; held_on: string | null; guests: EventGuest[] };
export type EventBrand = { domain: string; brand: string | null; guests: EventGuest[]; removed: boolean };
export type Approach = "audit" | "discovery";

/** Personal mailboxes: an address there says nothing about the company. */
export const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "protonmail.com", "proton.me", "gmx.com", "mail.com", "comcast.net",
]);
export const OWN_DOMAINS = new Set(["ecdigitalstrategy.com"]);

const emailDomain = (email: string | null) => (email && email.includes("@") ? email.split("@")[1].trim().toLowerCase() : null);

/**
 * Guests grouped by their company's website. A guest with no website takes it from a work email; one with only a
 * personal email cannot be placed and is counted, not imported. A brand counts as removed when Zak took the brand
 * off, or every guest from it.
 */
export function groupGuests(guests: EventGuest[]): { brands: EventBrand[]; unplaced: number } {
  const by = new Map<string, EventBrand>();
  let unplaced = 0;
  for (const g of guests) {
    const fromEmail = emailDomain(g.email);
    const domain = (g.domain || (fromEmail && !FREE_MAIL.has(fromEmail) ? fromEmail : null))?.replace(/^www\./, "") ?? null;
    if (!domain) {
      unplaced++;
      continue;
    }
    const b = by.get(domain) ?? { domain, brand: null, guests: [], removed: false };
    b.brand ??= g.brand?.trim() || null;
    b.guests.push(g);
    by.set(domain, b);
  }
  for (const b of by.values()) b.removed = b.guests.every((g) => g.removed);
  return { brands: [...by.values()], unplaced };
}

/** Who gets the email: a guest Zak did not take off, with an address at the brand's own domain first. */
export function pickGuest(b: EventBrand): EventGuest | null {
  const live = b.guests.filter((g) => !g.removed && g.email?.includes("@"));
  return live.find((g) => emailDomain(g.email) === b.domain) ?? live.find((g) => !FREE_MAIL.has(emailDomain(g.email) ?? "")) ?? live[0] ?? null;
}

/** Zak's A/B: Shopify brands split by their domain (stable across imports); anyone else gets the discovery email. */
export function approachFor(domain: string, shopify: boolean): Approach {
  if (!shopify) return "discovery";
  let h = 0;
  for (const c of domain) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 2 === 0 ? "audit" : "discovery";
}

// For an event guest, the event itself (and the company and contact its import created) is the reason to email
// them, not a reason to skip. These still are: a client, anyone with a deal in any stage, a CRM prospect, the CRM's
// do-not-contact list.
const BLOCKING = new Set(["client", "deal", "prospect", "suppressed"]);

/** The CRM matches that matter for this source: everything for a cold store, only the blocking kinds for a guest. */
export function relevantMatches(source: string | null | undefined, matches: CrmMatch[] | undefined): CrmMatch[] {
  const all = matches ?? [];
  return source === "event" ? all.filter((m) => BLOCKING.has(m.kind)) : all;
}

export function eventLabel(e: { name: string; kind: string | null; held_on: string | null }): string {
  const when = e.held_on ? new Date(`${e.held_on}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : null;
  return when ? `${e.name} (${e.kind ?? "event"}, ${when})` : e.name;
}
