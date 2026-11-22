// Never outreach to a client (Emil, 2026-11-22: "Please make sure we never have brands here that we are already working
// with"). A webinar guest from sbblooms.com was listed as "In the CRM (prospect)", but SB Blooms is an active client:
// the tracker knows it as somethingborrowedblooms.com, which sbblooms.com redirects to. A domain lookup alone misses
// that, and also clients filed under a subdomain (shop.brand.com) or with no website at all.
//
// So Outreach matches every brand against ECD's full client list (Hub crm-outreach action "clients", migration 0369:
// every client, past ones too, with every domain ECD knows for it) on:
//   - its domain, where its website ends up after redirects, and the myshopify store its storefront names;
//   - the email domains of its guests or contact (never free mail);
//   - subdomains either way (shop.brand.com and brand.com);
//   - its name: the store name, or the domain's own word ("sbblooms"), against client names, also as initials plus
//     the last word ("Something Borrowed Blooms" -> "sbblooms").
// A match is never listed, audited or emailed. Screening, the send-time check, follow-ups and a background sweep
// (outreach_send tick) all use the same matcher, and the sweep re-checks the whole list so a brand that becomes a
// client later drops off too.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type HubClient = { id: string; name: string; status: string | null; domains: string[] };
export type ClientMatch = { client: HubClient; why: string };

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "icloud.com",
  "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
]);
// Never treated as "the same company" when one domain sits under the other.
const SHARED_PARENTS = new Set(["myshopify.com", "co.uk", "com.au", "co.nz", "co.za", "com.br", "com.mx", "co.jp", "ecdigitalstrategy.com"]);
// ECD's own domain is a "client" in the tracker (internal work); its own team is skipped elsewhere, not as a client.
const IGNORED_CLIENT_DOMAINS = new Set(["ecdigitalstrategy.com"]);
const NAME_NOISE = new Set(["the", "co", "company", "inc", "llc", "ltd", "shop", "store", "official", "brand", "brands", "usa", "us"]);

/** "https://www.Brand.com/x" or "Brand.com" -> "brand.com". */
export function cleanDomain(v: string | null | undefined): string | null {
  const raw = String(v ?? "").trim().toLowerCase();
  if (!raw) return null;
  try {
    const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./, "").replace(/\.$/, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** The company domain of an email address, or null for free mail. */
export function emailDomain(email: string | null | undefined): string | null {
  const d = cleanDomain(String(email ?? "").split("@")[1] ?? "");
  return d && !FREE_MAIL.has(d) ? d : null;
}

function sameCompanyDomain(a: string, b: string): boolean {
  if (a === b) return true;
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.endsWith(`.${short}`) && !SHARED_PARENTS.has(short) && short.includes(".");
}

function words(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !NAME_NOISE.has(w));
}

/** The ways a name can be written as one word: "Something Borrowed Blooms" -> somethingborrowedblooms, sbblooms. */
export function nameKeys(name: string | null | undefined): string[] {
  const w = words(String(name ?? ""));
  if (!w.length) return [];
  const keys = new Set<string>();
  const compact = w.join("");
  if (compact.length >= 5) keys.add(compact);
  if (w.length >= 3) {
    const last = w[w.length - 1];
    if (last.length >= 4) keys.add(w.slice(0, -1).map((x) => x[0]).join("") + last);
  }
  return [...keys];
}

/** The word a domain is named after: "sbblooms.com" -> "sbblooms", "shop.brand.co.uk" -> "brand". */
export function domainWord(domain: string): string | null {
  const parts = domain.split(".");
  if (parts.length < 2) return null;
  const sld = parts.length >= 3 && SHARED_PARENTS.has(parts.slice(-2).join(".")) ? parts[parts.length - 3] : parts[parts.length - 2];
  const w = sld.replace(/-/g, "");
  return w.length >= 5 ? w : null;
}

export type ClientCandidate = {
  /** The brand's domain, where its site ends up, its myshopify store. */
  domains: Array<string | null | undefined>;
  /** Guest and contact addresses (free mail is ignored). */
  emails?: Array<string | null | undefined>;
  /** Store name, event brand. */
  names?: Array<string | null | undefined>;
};

/** The client this brand is, or null. Pure, tested. */
export function clientMatch(c: ClientCandidate, clients: HubClient[]): ClientMatch | null {
  const domains = [...new Set(c.domains.map(cleanDomain).filter((d): d is string => Boolean(d)))];
  const mailDomains = [...new Set((c.emails ?? []).map(emailDomain).filter((d): d is string => Boolean(d)))];
  const nameSet = new Set<string>();
  for (const n of c.names ?? []) for (const k of nameKeys(n)) nameSet.add(k);
  for (const d of domains) {
    const w = domainWord(d);
    if (w) nameSet.add(w);
  }

  for (const client of clients) {
    const own = client.domains.map(cleanDomain).filter((d): d is string => Boolean(d) && !IGNORED_CLIENT_DOMAINS.has(d!));
    for (const d of domains) {
      const hit = own.find((o) => sameCompanyDomain(d, o));
      if (hit) return { client, why: d === domains[0] ? hit : `${domains[0]} goes to ${hit}` };
    }
    for (const d of mailDomains) {
      const hit = own.find((o) => sameCompanyDomain(d, o));
      if (hit) return { client, why: `guest email at ${d}` };
    }
  }
  if (!nameSet.size) return null;
  for (const client of clients) {
    const keys = new Set([...nameKeys(client.name), ...client.domains.map((d) => cleanDomain(d)).filter(Boolean).map((d) => domainWord(d!)).filter((w): w is string => Boolean(w))]);
    if (IGNORED_CLIENT_DOMAINS.has(cleanDomain(client.domains[0]) ?? "")) continue;
    const hit = [...nameSet].find((k) => keys.has(k));
    if (hit) return { client, why: `name match: ${hit}` };
  }
  return null;
}

/** The skip reason shown on the card. */
export function clientReason(m: ClientMatch): string {
  const past = m.client.status && /complete|churn|past|inactive|cancel|lost/i.test(m.client.status) ? "a past ECD client" : "an ECD client";
  return `Already ${past}: ${m.client.name} (${m.why})`;
}

/** Where the brand's website ends up after redirects, and the myshopify store its storefront names. Never throws. */
export async function siteIdentity(domain: string): Promise<{ final: string | null; myshopify: string | null }> {
  try {
    const res = await fetch(`https://${domain}/`, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" },
    });
    const html = (await res.text()).slice(0, 400_000);
    return { final: cleanDomain(res.url), myshopify: myshopifyOf(html) };
  } catch {
    return { final: null, myshopify: null };
  }
}

/** The store's own myshopify domain from storefront HTML (Shopify.shop = "x.myshopify.com"). */
export function myshopifyOf(html: string): string | null {
  const m = html.match(/Shopify\.shop\s*=\s*["']([a-z0-9-]+\.myshopify\.com)["']/i) ?? html.match(/["']myshopify_domain["']\s*:\s*["']([a-z0-9-]+\.myshopify\.com)["']/i);
  return m ? m[1].toLowerCase() : null;
}

// ---- Database side: one brand, and the background sweep (outreach_send tick). ----


export type ProspectForClientCheck = {
  id: string;
  domain: string;
  store_name: string | null;
  contact_email: string | null;
  other_guests?: Array<{ email?: string | null }> | null;
  site_domain?: string | null;
};

/**
 * Is this listed brand an ECD client? Reads where its site ends up the first time (stored as site_domain), so the
 * redirect is checked once per brand, not on every run.
 */
export async function prospectClient(sb: SupabaseClient, p: ProspectForClientCheck, clients: HubClient[]): Promise<ClientMatch | null> {
  const quick = clientMatch(candidateOf(p, []), clients);
  if (quick) return quick;
  let extra: string[] = [];
  if (p.site_domain === undefined || p.site_domain === null) {
    const site = await siteIdentity(p.domain);
    extra = [site.final, site.myshopify].filter((d): d is string => Boolean(d));
    // "" = read, nowhere else: not read again on every run.
    await sb.from("outreach_prospects").update({ site_domain: site.final ?? "" }).eq("id", p.id);
  } else if (p.site_domain) {
    extra = [p.site_domain];
  }
  return extra.length ? clientMatch(candidateOf(p, extra), clients) : null;
}

function candidateOf(p: ProspectForClientCheck, extra: string[]): ClientCandidate {
  return {
    domains: [p.domain, ...extra],
    emails: [p.contact_email, ...(p.other_guests ?? []).map((g) => g?.email ?? null)],
    names: [p.store_name],
  };
}

/** Take a client off the list: a brand never emailed is skipped for good; an emailed one gets no more follow-ups
 * (the follow-up run skips is_client rows). */
export async function markClient(sb: SupabaseClient, p: { id: string; sent_at?: string | null }, m: ClientMatch): Promise<void> {
  const now = new Date().toISOString();
  if (!p.sent_at) {
    await sb.from("outreach_prospects")
      .update({ is_client: true, client_checked_at: now, status: "skipped", skip_reason: clientReason(m), approved_at: null })
      .eq("id", p.id).is("sent_at", null);
  } else {
    await sb.from("outreach_prospects").update({ is_client: true, client_checked_at: now }).eq("id", p.id);
  }
}

const SWEEP_BATCH = 40;
const SWEEP_EVERY_MS = 20 * 3_600_000;

/**
 * Re-checks the list against ECD's clients (Emil, 2026-11-22: "some kind of auto-sync"): every brand at least once a
 * day, oldest check first, so a brand that becomes a client later drops off the list and gets no more emails.
 * Brands that replied, bounced or said no are left alone (no email goes to them anyway).
 */
export async function clientSweep(sb: SupabaseClient, loadClients: () => Promise<HubClient[]>): Promise<{ checked: number; clients: string[] }> {
  const due = new Date(Date.now() - SWEEP_EVERY_MS).toISOString();
  const { data, error } = await sb
    .from("outreach_prospects")
    .select("id, domain, store_name, contact_email, other_guests, site_domain, sent_at, status")
    .eq("is_client", false)
    .not("status", "in", "(replied,bounced,unsubscribed)")
    .or(`client_checked_at.is.null,client_checked_at.lt.${due}`)
    .order("client_checked_at", { ascending: true, nullsFirst: true })
    .limit(SWEEP_BATCH);
  if (error) throw new Error(`client sweep: ${error.message}`);
  const rows = (data ?? []) as Array<ProspectForClientCheck & { sent_at: string | null; status: string }>;
  if (!rows.length) return { checked: 0, clients: [] };
  const clients = await loadClients();
  const found: string[] = [];
  const now = new Date().toISOString();
  await Promise.all(rows.map(async (p) => {
    const m = await prospectClient(sb, p, clients);
    if (m) {
      await markClient(sb, p, m);
      found.push(p.domain);
    } else {
      await sb.from("outreach_prospects").update({ client_checked_at: now }).eq("id", p.id);
    }
  }));
  return { checked: rows.length, clients: found };
}
