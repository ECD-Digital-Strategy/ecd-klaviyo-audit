// The plan for one client sync from the ECD CRM (crm_client_sync, 2026-11-22). Pure, tested. Same rules hubspot_sync
// used: a company already linked is left alone; one whose name or website matches a client is linked to it; anything
// else with a name becomes a new client with its main contact. Test records are never imported.

import type { CrmCompany } from "./outreach-crm.ts";

export type ExistingClient = { id: string; company_name: string | null; website_url: string | null; hubspot_company_id: string | null };

export type NewClient = {
  company_name: string;
  name: string;
  email: string;
  website_url: string;
  industry: string;
  esp_platform: string;
  api_key_placeholder: string;
  notes: string;
  hubspot_company_id: string;
  crm_imported: boolean;
};

export type SyncPlan = {
  create: NewClient[];
  link: Array<{ clientId: string; companyId: string }>;
  skipped: { total: number; already_linked: number; no_name: number; test: number };
};

function domainOf(value: string | null | undefined): string {
  if (!value) return "";
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

/** "Pipeliner's Cloud" and "Pipeliners Cloud" are one name. */
function nameKey(name: string | null | undefined): string {
  return (name ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** shop.brand.com and brand.com are one site (brand.co.uk keeps its last three parts). */
function siteKey(domain: string): string {
  const parts = domain.split(".").filter(Boolean);
  const two = parts.slice(-2).join(".");
  return parts.length >= 3 && /^(co|com|org|net)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join(".") : two;
}

/** ZZ Booking Test Co, "S5 Test", example.com: the CRM team's test records. */
export function isTestRecord(c: Pick<CrmCompany, "name" | "domain">): boolean {
  const name = (c.name ?? "").toLowerCase();
  const domain = domainOf(c.domain);
  return /\btest\b/.test(name) || /^zz[\s-]/.test(name) || /(^|\.)example\.(com|org|net)$/.test(domain) || /(^|-)test(-|$)/.test(domain.split(".")[0] ?? "");
}

export function planClientSync(companies: CrmCompany[], existing: ExistingClient[]): SyncPlan {
  const linkedIds = new Set<string>();
  const byName = new Map<string, string>();
  const byDomain = new Map<string, string>();
  for (const c of existing) {
    if (c.hubspot_company_id) linkedIds.add(String(c.hubspot_company_id));
    const n = nameKey(c.company_name);
    if (n) byName.set(n, c.id);
    const d = domainOf(c.website_url);
    if (d) byDomain.set(siteKey(d), c.id);
  }
  const plan: SyncPlan = { create: [], link: [], skipped: { total: 0, already_linked: 0, no_name: 0, test: 0 } };
  const taken = new Set<string>();
  for (const co of companies) {
    const id = String(co.id);
    if (linkedIds.has(id)) {
      plan.skipped.already_linked++;
      continue;
    }
    const name = (co.name ?? "").trim();
    if (!name) {
      plan.skipped.no_name++;
      continue;
    }
    if (isTestRecord(co)) {
      plan.skipped.test++;
      continue;
    }
    const domain = domainOf(co.domain);
    const match = byName.get(nameKey(name)) ?? (domain ? byDomain.get(siteKey(domain)) : undefined);
    if (match) {
      // One CRM company per client: a second company with the same name or site is not linked over the first.
      if (!taken.has(match)) {
        plan.link.push({ clientId: match, companyId: id });
        taken.add(match);
      }
      linkedIds.add(id);
      continue;
    }
    plan.create.push({
      company_name: name,
      name: co.contact?.name ?? "",
      email: co.contact?.email ?? "",
      website_url: domain ? `https://${domain}` : "",
      industry: "",
      esp_platform: "Klaviyo",
      api_key_placeholder: "",
      notes: "Imported from Revenue Desk",
      hubspot_company_id: id,
      crm_imported: true,
    });
    byName.set(nameKey(name), `new:${id}`);
    if (domain) byDomain.set(siteKey(domain), `new:${id}`);
    linkedIds.add(id);
  }
  // A company matching one created earlier in this same run is neither created twice nor linked to a missing row.
  plan.link = plan.link.filter((l) => !l.clientId.startsWith("new:"));
  plan.skipped.total = plan.skipped.already_linked + plan.skipped.no_name + plan.skipped.test;
  return plan;
}
