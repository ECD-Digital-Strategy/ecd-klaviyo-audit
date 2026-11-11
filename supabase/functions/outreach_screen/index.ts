import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, hasCronSecret } from "../_shared/auth.ts";
import { OUTREACH_OWNER_EMAIL, requireOutreachOwner } from "../_shared/outreach-access.ts";
import { crmEventLeads, crmKnown, crmSkipReason, type CrmKnown } from "../_shared/outreach-crm.ts";
import { approachFor, groupGuests, guestName, OWN_DOMAINS, pickGuest, relevantMatches, type EventBrand } from "../_shared/outreach-events.ts";
import { createLlmClient } from "../_shared/llm-adapter.ts";
import { scoreLead, shopifyLocale, type LeadSignals } from "../_shared/outreach-score.ts";

// Outreach, step 1 (Emil, 2026-11-01): screen pasted store domains before anything
// is audited or emailed. Each domain is kept once in outreach_prospects, either as
// 'new' (worth auditing) or 'skipped' with the reason, so nobody is ever screened,
// audited or emailed twice. Skipped:
//  - already a client here,
//  - known to the ECD CRM (Revenue Desk, since 2026-11-11; HubSpot before): a client,
//    a deal in any stage, a company, any contact at that domain, a prospect, an event
//    guest, or the CRM's do-not-contact list (_shared/outreach-crm.ts). Past clients
//    and contacts are left alone entirely: no audit, no email,
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

/** Name and size signals from the homepage. shopify=false means it is not a Shopify store. */
/** "Astral Health &amp; Beauty" -> "Astral Health & Beauty". */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&(amp|quot|apos|lt|gt|nbsp|rsquo|lsquo|ndash|mdash);/g, (_, e) =>
      ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", rsquo: "'", lsquo: "'", ndash: "-", mdash: "-" })[e as string] ?? _);
}

type Homepage = {
  shopify: boolean;
  name: string | null;
  signals: string[];
  currency: string | null;
  country: string | null;
  /** For telling a brand from an agency or vendor (event guests). */
  title: string | null;
  description: string | null;
  text: string;
};

async function readHomepage(domain: string): Promise<Homepage | null> {
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
    const name = decodeEntities((og ?? title?.split(/[|\-–:]/)[0] ?? "").trim()) || null;
    const signals = [
      [/attn\.tv|attentivemobile/i, "Attentive"],
      [/postscript\.io/i, "Postscript"],
      [/klaviyo\.com/i, "Klaviyo"],
      [/gorgias/i, "Gorgias"],
      [/yotpo/i, "Yotpo"],
      [/okendo/i, "Okendo"],
      [/rechargeapps|rechargepayments/i, "Recharge"],
    ].filter(([re]) => (re as RegExp).test(html)).map(([, label]) => label as string);
    const description = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,400})["']/i)?.[1]?.trim() ?? null;
    const text = html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1200);
    return { shopify, name, signals, ...shopifyLocale(html), title: title?.trim() ?? null, description, text };
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

// ---- Event and webinar guests (Emil, 2026-11-11) -------------------------------------------------------------
// Zak, on the 2026-11-06 call: event and webinar guests already know ECD and nobody follows up with them; take the
// agencies out first. "event_list" shows the CRM's events with how many brands are in Outreach already;
// "event_import" brings one event's brands over a few at a time (the page keeps calling until done). Each brand is
// kept once, like a pasted store: 'new' (with the guest to email and the approach) or 'skipped' with why.

type Sb = ReturnType<typeof assertServiceRoleClient>;
type Kind = "brand" | "agency" | "software" | "other" | "unknown";
const EVENT_BATCH = 6;

/** Brand or not, for a few sites at once. A site that could not be read is judged on its name alone, or "unknown". */
async function classifyBrands(items: Array<{ domain: string; brand: string | null; home: Homepage | null }>): Promise<Map<string, { kind: Kind; why: string }>> {
  const out = new Map<string, { kind: Kind; why: string }>();
  if (!items.length) return out;
  const facts = items.map((i, n) => [
    `${n + 1}. ${i.domain}${i.brand ? ` (listed as "${i.brand}")` : ""}`,
    i.home ? `   title: ${i.home.title ?? "-"}\n   description: ${i.home.description ?? "-"}\n   page text: ${i.home.text.slice(0, 600)}` : "   (the website did not load)",
  ].join("\n")).join("\n\n");
  try {
    const llm = createLlmClient("anthropic", { model: "claude-sonnet-5-5" });
    const turn = await llm.runTurn({
      system: `You sort the companies that came to an ecommerce agency's events and webinars. The agency (ECD Digital Strategy) sells email, SMS, website and paid-ads work to brands that sell products online. For each website decide:
- brand: a company that sells its own products, or retails products, to customers online (DTC brands, ecommerce stores, retailers, consumer goods makers with an online store). These are the leads.
- agency: a marketing, design, development or consulting agency or freelancer (a competitor or partner, never a lead).
- software: a software, SaaS, app or technology vendor (Klaviyo partners, ecommerce tools).
- other: anything else (media, publisher, non-profit, B2B services with no online store, a parent group with no store).
- unknown: only when the site did not load and the name gives no clue.
Give a reason of at most 12 words. Judge only from what is given.`,
      messages: [{ role: "user", text: facts }],
      tools: [{
        name: "verdicts",
        description: "One verdict per website, in the same order.",
        input_schema: {
          type: "object",
          properties: {
            verdicts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  domain: { type: "string" },
                  kind: { type: "string", enum: ["brand", "agency", "software", "other", "unknown"] },
                  reason: { type: "string" },
                },
                required: ["domain", "kind", "reason"],
              },
            },
          },
          required: ["verdicts"],
        },
      }],
      toolChoice: { type: "tool", name: "verdicts" },
    });
    if (turn.kind === "tool_call") {
      for (const v of ((turn.input as { verdicts?: Array<{ domain: string; kind: Kind; reason: string }> }).verdicts ?? [])) {
        out.set(String(v.domain).toLowerCase(), { kind: v.kind, why: String(v.reason ?? "").replace(/\s*[–—]\s*/g, ", ") });
      }
    }
  } catch {
    // Unsorted ones stay "unknown" below: kept, for Emil to judge.
  }
  for (const i of items) if (!out.has(i.domain)) out.set(i.domain, { kind: "unknown", why: "Could not be sorted automatically" });
  return out;
}

async function isLocalClient(sb: Sb, domain: string): Promise<boolean> {
  const { data } = await sb
    .from("clients")
    .select("website_url")
    .eq("is_outreach", false)
    .ilike("website_url", `%${domain.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    .limit(20);
  return (data ?? []).some((c) => hostOf((c as { website_url: string | null }).website_url) === domain);
}

async function eventList(sb: Sb) {
  const events = await crmEventLeads();
  const { data } = await sb.from("outreach_prospects").select("event_id, status").eq("source", "event");
  const rows = (data ?? []) as Array<{ event_id: string | null; status: string }>;
  return events.map((e) => {
    const { brands, unplaced } = groupGuests(e.guests);
    const mine = rows.filter((r) => r.event_id === e.id);
    return {
      id: e.id,
      name: e.name,
      kind: e.kind,
      held_on: e.held_on,
      guests: e.guests.length,
      brands: brands.length,
      removed: brands.filter((b) => b.removed).length,
      unplaced,
      imported: mine.length,
      kept: mine.filter((r) => r.status !== "skipped").length,
    };
  });
}

type EventResult = { domain: string; status: "new" | "skipped" | "exists"; reason?: string; store_name?: string; approach?: string };

async function eventImport(sb: Sb, userId: string, eventId: string, offset: number) {
  const event = (await crmEventLeads()).find((e) => e.id === eventId);
  if (!event) return { ok: false, error: "event_not_found" };
  const { brands } = groupGuests(event.guests);
  brands.sort((a, b) => a.domain.localeCompare(b.domain));
  const slice = brands.slice(offset, offset + EVENT_BATCH);
  const results: EventResult[] = [];

  // One CRM question for the batch: only clients, deals, prospects and the do-not-contact list count for a guest.
  const known = await crmKnown(slice.map((b) => b.domain));

  const todo: Array<{ b: EventBrand; existingId: string | null; reason: string | null; home: Homepage | null }> = [];
  for (const b of slice) {
    if (b.removed) {
      results.push({ domain: b.domain, status: "skipped", reason: "Taken off this event in the CRM" });
      continue;
    }
    if (OWN_DOMAINS.has(b.domain)) {
      results.push({ domain: b.domain, status: "skipped", reason: "ECD's own team" });
      continue;
    }
    const { data: existing } = await sb.from("outreach_prospects").select("id, status, source, sent_at, event_name").eq("domain", b.domain).maybeSingle();
    const ex = existing as { id: string; status: string; source: string; sent_at: string | null; event_name: string | null } | null;
    // A store pasted in earlier and never emailed becomes an event guest; anything else stays as it is.
    if (ex && (ex.sent_at || ex.source === "event" || !["new", "skipped"].includes(ex.status))) {
      results.push({ domain: b.domain, status: "exists", reason: ex.source === "event" ? `Already in from ${ex.event_name ?? "another event"}` : `Already on the list (${ex.status})` });
      continue;
    }
    let reason: string | null = null;
    const { data: blocked } = await sb.from("outreach_suppressions").select("domain").eq("domain", b.domain).maybeSingle();
    if (blocked) reason = "Asked not to be contacted";
    if (!reason && (await isLocalClient(sb, b.domain))) reason = "Already a client";
    if (!reason) reason = crmSkipReason(relevantMatches("event", known.domains[b.domain]));
    todo.push({ b, existingId: ex?.id ?? null, reason, home: null });
  }

  // Read the sites still in play, then sort brand from agency in one go.
  await Promise.all(todo.filter((t) => !t.reason).map(async (t) => { t.home = await readHomepage(t.b.domain); }));
  const verdicts = await classifyBrands(todo.filter((t) => !t.reason).map((t) => ({ domain: t.b.domain, brand: t.b.brand, home: t.home })));

  for (const t of todo) {
    const { b, home } = t;
    let reason = t.reason;
    const v = verdicts.get(b.domain);
    if (!reason && v && v.kind !== "brand" && v.kind !== "unknown") {
      reason = `Not a brand (${v.kind === "agency" ? "an agency" : v.kind === "software" ? "a software vendor" : "not an online store"}): ${v.why}`;
    }
    const guest = pickGuest(b);
    const approach = approachFor(b.domain, home?.shopify ?? false);
    const others = b.guests
      .filter((g) => g !== guest && g.email)
      .map((g) => ({ name: guestName(g), email: g.email, title: g.title }));
    const noteLines = [
      v?.kind === "unknown" ? `Check it is a brand: ${v.why.replace(/\.+$/, "")}.` : null,
      home && !home.shopify ? "Not on Shopify, so it gets the discovery email (no audit)." : null,
      !home ? "Their website did not load." : null,
      !guest ? "No guest email from this brand: use Find decision-maker." : null,
      home?.signals.length ? `Signals: ${home.signals.join(", ")}` : null,
    ].filter(Boolean);
    const row = {
      domain: b.domain,
      store_name: home?.name ?? b.brand ?? null,
      status: reason ? "skipped" : "new",
      skip_reason: reason,
      notes: noteLines.join("\n") || null,
      source: "event",
      event_id: event.id,
      event_name: event.name,
      event_kind: event.kind,
      event_date: event.held_on,
      approach: reason ? null : approach,
      contact_name: guest ? guestName(guest) : null,
      contact_email: guest?.email ?? null,
      contact_title: guest?.title ?? null,
      contact_source: guest ? "event" : null,
      contact_verified: null,
      other_guests: others.length ? others : null,
      lead_signals: home ? { tranco_rank: null, products: null, currency: home.currency, country: home.country, apps: home.signals, reasons: [] } : null,
    };
    const { error } = t.existingId
      ? await sb.from("outreach_prospects").update(row).eq("id", t.existingId).is("sent_at", null)
      : await sb.from("outreach_prospects").insert({ ...row, created_by: userId });
    if (error) {
      results.push({ domain: b.domain, status: "skipped", reason: error.message });
      continue;
    }
    results.push({ domain: b.domain, status: row.status as "new" | "skipped", reason: reason ?? undefined, store_name: row.store_name ?? undefined, approach: row.approach ?? undefined });
  }

  const next = offset + slice.length;
  return { ok: true, results, next_offset: next, total: brands.length, done: next >= brands.length };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const body = (await req.json().catch(() => ({}))) as { domains?: unknown; action?: string; event_id?: string; offset?: number };
  const eventAction = body.action === "event_list" || body.action === "event_import";

  // Event imports also run as the server (the outreach cron secret), for checks and a later nightly import.
  // They only add prospects; nothing is ever sent from here.
  let userId: string;
  try {
    if (eventAction && (await hasCronSecret(req, "outreach_cron_secret"))) {
      const { data } = await assertServiceRoleClient().from("profiles").select("id").eq("email", OUTREACH_OWNER_EMAIL).maybeSingle();
      userId = String((data as { id?: string } | null)?.id ?? "");
      if (!userId) throw new Error("no owner");
    } else {
      userId = await requireOutreachOwner(req);
    }
  } catch {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  if (eventAction) {
    const sb = assertServiceRoleClient();
    try {
      if (body.action === "event_list") return json({ ok: true, events: await eventList(sb) });
      if (!body.event_id) return json({ ok: false, error: "missing_event" }, 400);
      return json(await eventImport(sb, userId, String(body.event_id), Math.max(0, Number(body.offset ?? 0) || 0)));
    } catch (e) {
      // The CRM could not be asked: nothing was imported from this batch.
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  }
  // 15 per call keeps a batch well inside the function time limit; the page sends longer lists in batches.
  const inputs = Array.isArray(body.domains) ? body.domains.map(String).slice(0, 15) : [];
  if (inputs.length === 0) return json({ ok: false, error: "no_domains" }, 400);

  const sb = assertServiceRoleClient();
  const { data: settingsRow } = await sb.from("outreach_settings").select("min_lead_score").eq("id", "default").maybeSingle();
  const minScore = Number((settingsRow as { min_lead_score?: number } | null)?.min_lead_score ?? 40);
  // One question to the CRM for the whole batch (2026-11-11: the CRM, not HubSpot).
  let crm: CrmKnown | null = null;
  let crmError = "";
  const asked = [...new Set(inputs.map(normalizeDomain).filter((d): d is string => Boolean(d)))];
  try {
    crm = await crmKnown(asked);
  } catch (e) {
    crmError = e instanceof Error ? e.message : String(e);
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

    if (!reason) {
      // The CRM could not be asked: unknown, not "no". Fail closed (audit 2026-11-10).
      if (!crm) reason = `The CRM could not be checked (${crmError}), so skipped to be safe. Screen it again later`;
      else reason = crmSkipReason(crm.domains[domain]);
    }
    if (reason?.endsWith("Screen it again later")) {
      // Not saved, so screening it again later checks it afresh.
      results.push({ domain, status: "skipped", reason });
      continue;
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
