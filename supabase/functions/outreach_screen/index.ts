import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient } from "../_shared/auth.ts";
import { requireOutreachOwner } from "../_shared/outreach-access.ts";
import { getSecret } from "../_shared/app-secrets.ts";
import { scoreLead, shopifyLocale, type LeadSignals } from "../_shared/outreach-score.ts";

// Outreach, step 1 (Emil, 2026-11-01): screen pasted store domains before anything
// is audited or emailed. Each domain is kept once in outreach_prospects, either as
// 'new' (worth auditing) or 'skipped' with the reason, so nobody is ever screened,
// audited or emailed twice. Skipped:
//  - already a client here (HubSpot companies are mirrored into clients),
//  - in HubSpot as a company or as any contact at that email domain (past clients
//    and contacts are left alone entirely: no audit, no email),
//  - not a Shopify store.
// The homepage is read once for the store's name and a few size signals (Attentive
// and Postscript are sold to bigger brands; Klaviyo alone is weak).
// Lead score (2026-11-02): those signals, the store's traffic rank, catalogue size
// and currency add up to a 0-100 score (_shared/outreach-score.ts). Below the
// threshold on the Settings tab the store is skipped, with the score in the reason
// so Emil can keep it anyway.

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

/** "https://www.Brand.com/shop?x" -> "brand.com"; null when it is not a usable host. */
export function normalizeDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  try {
    const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

const hostOf = (url: string | null | undefined) => (url ? normalizeDomain(url) : null);

type Screened = { domain: string; status: "new" | "skipped" | "exists" | "invalid"; reason?: string; store_name?: string; lead_score?: number };

async function hubspotHas(token: string, object: "companies" | "contacts", property: string, domain: string): Promise<boolean | null> {
  const res = await fetch(`https://api.hubapi.com/crm/v3/objects/${object}/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value: domain }] }], limit: 1 }),
  }).catch(() => null);
  if (!res || !res.ok) return null; // unknown, not "no"
  const body = (await res.json().catch(() => null)) as { total?: number } | null;
  return (body?.total ?? 0) > 0;
}

/** Name and size signals from the homepage. shopify=false means it is not a Shopify store. */
async function readHomepage(domain: string): Promise<{ shopify: boolean; name: string | null; signals: string[]; currency: string | null; country: string | null } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`https://${domain}/`, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" },
    });
    const html = (await res.text()).slice(0, 600_000);
    const shopify = /cdn\.shopify\.com|Shopify\.theme|myshopify\.com/i.test(html);
    const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{1,80})["']/i)?.[1];
    const title = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1];
    const name = (og ?? title?.split(/[|\-–:]/)[0] ?? "").trim() || null;
    const signals = [
      [/attn\.tv|attentivemobile/i, "Attentive"],
      [/postscript\.io/i, "Postscript"],
      [/klaviyo\.com/i, "Klaviyo"],
      [/gorgias/i, "Gorgias"],
      [/yotpo/i, "Yotpo"],
      [/okendo/i, "Okendo"],
      [/rechargeapps|rechargepayments/i, "Recharge"],
    ].filter(([re]) => (re as RegExp).test(html)).map(([, label]) => label as string);
    return { shopify, name, signals, ...shopifyLocale(html) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The store's latest Tranco rank (top 1M sites), or null when it is not ranked. */
async function trancoRank(domain: string): Promise<number | null> {
  try {
    const res = await fetch(`https://tranco-list.eu/api/ranks/domain/${domain}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { ranks?: Array<{ rank?: number }> };
    return body.ranks?.[0]?.rank ?? null;
  } catch {
    return null;
  }
}

/** Products on the first page of the public catalogue (max 250), or null when it is closed. */
async function productCount(domain: string): Promise<number | null> {
  try {
    const res = await fetch(`https://${domain}/products.json?limit=250`, {
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { products?: unknown[] };
    return Array.isArray(body.products) ? body.products.length : null;
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let userId: string;
  try {
    userId = await requireOutreachOwner(req);
  } catch {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const body = (await req.json().catch(() => ({}))) as { domains?: unknown };
  // 15 per call keeps a batch well inside the function time limit; the page sends longer lists in batches.
  const inputs = Array.isArray(body.domains) ? body.domains.map(String).slice(0, 15) : [];
  if (inputs.length === 0) return json({ ok: false, error: "no_domains" }, 400);

  const sb = assertServiceRoleClient();
  const { data: settingsRow } = await sb.from("outreach_settings").select("min_lead_score").eq("id", "default").maybeSingle();
  const minScore = Number((settingsRow as { min_lead_score?: number } | null)?.min_lead_score ?? 40);
  let hubspotToken = "";
  try {
    hubspotToken = await getSecret("hubspot_private_app_token");
  } catch {
    // Without HubSpot the clients mirror is still checked; the result says so.
  }

  const seen = new Set<string>();
  const results: Screened[] = [];
  for (const input of inputs) {
    const domain = normalizeDomain(input);
    if (!domain) {
      results.push({ domain: input, status: "invalid", reason: "Not a website address" });
      continue;
    }
    if (seen.has(domain)) continue;
    seen.add(domain);

    const { data: existing } = await sb.from("outreach_prospects").select("status, skip_reason").eq("domain", domain).maybeSingle();
    if (existing) {
      results.push({ domain, status: "exists", reason: `Already on the list (${existing.status})` });
      continue;
    }

    let reason: string | null = null;

    // Someone there said no before (outreach_suppressions): never again.
    const { data: blocked } = await sb.from("outreach_suppressions").select("domain").eq("domain", domain).maybeSingle();
    if (blocked) reason = "Asked not to be contacted";

    // A client here, by website. Prospects are clients too, flagged is_outreach.
    const { data: clientRows } = await sb
      .from("clients")
      .select("website_url")
      .eq("is_outreach", false)
      .ilike("website_url", `%${domain.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      .limit(20);
    if ((clientRows ?? []).some((c) => hostOf((c as { website_url: string | null }).website_url) === domain)) {
      reason = "Already a client";
    }

    if (!reason && hubspotToken) {
      const [company, contact] = await Promise.all([
        hubspotHas(hubspotToken, "companies", "domain", domain),
        hubspotHas(hubspotToken, "contacts", "hs_email_domain", domain),
      ]);
      if (company) reason = "In HubSpot (company)";
      else if (contact) reason = "In HubSpot (contact)";
      else if (company === null && contact === null) reason = "HubSpot could not be checked, so skipped to be safe";
    } else if (!reason && !hubspotToken) {
      reason = "HubSpot is not connected, so skipped to be safe";
    }

    const [home, rank, products] = reason
      ? [null, null, null]
      : await Promise.all([readHomepage(domain), trancoRank(domain), productCount(domain)]);
    if (!reason && !home) reason = "Website did not load";
    if (!reason && home && !home.shopify) reason = "Not a Shopify store";

    let lead: (LeadSignals & { reasons: string[] }) | null = null;
    let leadScore: number | null = null;
    if (!reason && home) {
      const signals: LeadSignals = { tranco_rank: rank, products, currency: home.currency, country: home.country, apps: home.signals };
      const scored = scoreLead(signals);
      lead = { ...signals, reasons: scored.reasons };
      leadScore = scored.score;
      if (scored.score < minScore) reason = `Low lead score (${scored.score}, needs ${minScore})`;
    }

    const row = {
      domain,
      store_name: home?.name ?? null,
      status: reason ? "skipped" : "new",
      skip_reason: reason,
      notes: home?.signals.length ? `Signals: ${home.signals.join(", ")}` : null,
      lead_score: leadScore,
      lead_signals: lead,
      created_by: userId,
    };
    const { error } = await sb.from("outreach_prospects").insert(row);
    if (error) {
      results.push({ domain, status: "invalid", reason: error.message });
      continue;
    }
    results.push({ domain, status: row.status as "new" | "skipped", reason: reason ?? undefined, store_name: row.store_name ?? undefined, lead_score: leadScore ?? undefined });
  }

  return json({ ok: true, results });
});
