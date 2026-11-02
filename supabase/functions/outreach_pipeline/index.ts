import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, hasCronSecret } from "../_shared/auth.ts";
import { OUTREACH_OWNER_EMAIL } from "../_shared/outreach-access.ts";
import { startOfSendDay } from "../_shared/outreach-email.ts";

// Outreach auto-pipeline (Emil, 2026-11-02): "screens, audits and drafts about 3
// a day for approval". Off until Emil turns it on (outreach_settings.auto_pipeline).
// Every 30 minutes (cron outreach-pipeline), it:
//  1. drafts the email for every finished audit that has none yet (outreach_draft),
//     which moves it to Ready to send on the Prospects tab. Nothing is sent: Emil
//     still sends or queues each one himself;
//  2. starts at most one new prospect per run, highest lead score first, up to
//     auto_audits_per_day a day (New York days) and never more than two audits at
//     once. With Hunter connected it finds the decision-maker FIRST, and a store
//     with no one to email is skipped before an audit is spent on it.
// Stores scoring under min_lead_score were already skipped when screened.

const WEB_SECTION_KEYS = [
  "web_overview",
  "web_homepage",
  "web_product_page",
  "web_collection_page",
  "web_cart",
  "web_performance",
  "web_revenue_summary",
]; // as src/lib/audit-sections.ts WEB_AUDIT_SECTION_KEYS

const MAX_IN_FLIGHT = 2;
const MAX_LOOKUPS_PER_RUN = 3;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

type Sb = ReturnType<typeof assertServiceRoleClient>;
type Prospect = {
  id: string;
  domain: string;
  store_name: string | null;
  contact_email: string | null;
  client_id: string | null;
  audit_id: string | null;
  email_body: string | null;
  notes: string | null;
};

/** Calls another outreach function as the server. */
async function callFn<T>(name: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: T | null }> {
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  try {
    const res = await fetch(`${base}/functions/v1/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, apikey: key, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(110_000),
    });
    const data = (await res.json().catch(() => null)) as T | null;
    return { ok: res.ok && Boolean((data as { ok?: boolean } | null)?.ok), status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

/** Emil's user id: the audits the pipeline starts are his, as if he had clicked Run audit. */
async function ownerId(sb: Sb): Promise<string | null> {
  const { data } = await sb.from("profiles").select("id").eq("email", OUTREACH_OWNER_EMAIL).maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

/** Same as Run audit on the page (src/lib/outreach.ts startOutreachAudit), done here. */
async function startAudit(sb: Sb, p: Prospect, userId: string | null): Promise<string | null> {
  const name = p.store_name?.trim() || p.domain;
  const websiteUrl = `https://${p.domain}`;
  let clientId = p.client_id;
  if (!clientId) {
    const { data, error } = await sb.from("clients").insert({
      name,
      company_name: name,
      website_url: websiteUrl,
      industry: "",
      esp_platform: "Shopify",
      api_key_placeholder: "",
      notes: "Outreach prospect (auto-pipeline).",
      created_by: userId,
      is_outreach: true,
    }).select("id").single();
    if (error) return `Could not create the client: ${error.message}`;
    clientId = (data as { id: string }).id;
  }
  const { data: audit, error: auditErr } = await sb.from("audits").insert({
    client_id: clientId,
    title: `${name} - Web Audit`,
    status: "draft",
    audit_type: "web",
    audit_method: "screenshot",
    list_size: 0,
    aov: 0,
    monthly_traffic: 0,
    total_revenue_opportunity: 0,
    executive_summary: "",
    created_by: userId,
    show_recommendations: true,
    is_outreach: true,
  }).select("id").single();
  if (auditErr) return `Could not create the audit: ${auditErr.message}`;
  const auditId = (audit as { id: string }).id;
  const { error: secErr } = await sb.from("audit_sections").insert(WEB_SECTION_KEYS.map((section_key) => ({
    audit_id: auditId,
    section_key,
    current_state_title: "",
    optimized_state_title: "",
    current_state_notes: "",
    optimized_notes: "",
    ai_findings: "",
    human_edited_findings: "",
    summary_text: "",
    key_findings: { items: [], items_hidden: [] },
    revenue_opportunity: 0,
    confidence: "medium",
    status: "approved",
    section_details: null,
  })));
  if (secErr) return `Could not create the audit sections: ${secErr.message}`;
  await sb.from("outreach_prospects").update({
    client_id: clientId,
    audit_id: auditId,
    status: "auditing",
    auto_started_at: new Date().toISOString(),
  }).eq("id", p.id);

  const seed = await callFn<{ ok?: boolean; error?: { message?: string } }>("web_capture_screenshots", {
    action: "seed",
    audit_id: auditId,
    client_id: clientId,
    pages: { homepage: websiteUrl },
  });
  if (!seed.ok) {
    const msg = seed.data?.error?.message ?? `HTTP ${seed.status}`;
    await sb.from("outreach_prospects").update({
      status: "failed",
      notes: [p.notes, `Capture could not start: ${msg}`].filter(Boolean).join("\n"),
    }).eq("id", p.id);
    return `Capture could not start: ${msg}`;
  }
  return null;
}

async function tick(sb: Sb) {
  const { data: s } = await sb.from("outreach_settings").select("auto_pipeline, auto_audits_per_day, min_lead_score").eq("id", "default").maybeSingle();
  const settings = (s ?? {}) as { auto_pipeline?: boolean; auto_audits_per_day?: number; min_lead_score?: number };
  if (!settings.auto_pipeline) return { ok: true, skipped: "off" };
  const log: string[] = [];

  // 1. Draft finished audits.
  const { data: auditing } = await sb
    .from("outreach_prospects")
    .select("id, domain, email_body, audit:audits(status)")
    .eq("status", "auditing")
    .is("email_body", null);
  const done = ((auditing ?? []) as Array<{ id: string; domain: string; audit: { status?: string } | null }>)
    .filter((p) => p.audit?.status === "published");
  for (const p of done.slice(0, 3)) {
    const r = await callFn<{ message?: string; error?: string }>("outreach_draft", { prospect_id: p.id });
    log.push(r.ok ? `${p.domain}: drafted` : `${p.domain}: draft failed (${r.data?.message ?? r.data?.error ?? r.status})`);
  }

  // 2. Start the next best store, within the daily number and two at a time.
  const cap = settings.auto_audits_per_day ?? 3;
  const { count: startedToday } = await sb
    .from("outreach_prospects")
    .select("id", { count: "exact", head: true })
    .gte("auto_started_at", startOfSendDay(new Date()).toISOString());
  const inFlight = ((auditing ?? []) as Array<{ audit: { status?: string } | null }>).filter((p) => p.audit?.status !== "published").length;
  if ((startedToday ?? 0) >= cap) return { ok: true, log, skipped_start: `daily limit (${cap}) reached` };
  if (inFlight >= MAX_IN_FLIGHT) return { ok: true, log, skipped_start: `${inFlight} audits already running` };

  const { data: candidates } = await sb
    .from("outreach_prospects")
    .select("id, domain, store_name, contact_email, client_id, audit_id, email_body, notes")
    .eq("status", "new")
    .gte("lead_score", settings.min_lead_score ?? 40)
    .order("lead_score", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(MAX_LOOKUPS_PER_RUN);
  const { data: hunter } = await sb.from("app_secrets").select("key").eq("key", "outreach_hunter").maybeSingle();
  const userId = await ownerId(sb);

  for (const p of (candidates ?? []) as Prospect[]) {
    if (hunter && !p.contact_email) {
      const r = await callFn<{ found?: { email: string } | null; message?: string; error?: string }>("outreach_contacts", { action: "find", prospect_id: p.id });
      if (!r.ok) {
        // Hunter itself failed (limit used up, key refused): stop for this run, retry later.
        log.push(`${p.domain}: lookup failed (${r.data?.error ?? r.status})`);
        break;
      }
      if (!r.data?.found) {
        await sb.from("outreach_prospects").update({ status: "skipped", skip_reason: `No decision-maker found. ${r.data?.message ?? ""}`.trim() }).eq("id", p.id);
        log.push(`${p.domain}: skipped, no decision-maker`);
        continue;
      }
    }
    const err = await startAudit(sb, p, userId);
    log.push(err ? `${p.domain}: ${err}` : `${p.domain}: audit started`);
    break; // one per run
  }
  return { ok: true, log };
}

serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!(await hasCronSecret(req, "outreach_cron_secret"))) return json({ ok: false, error: "forbidden" }, 403);
  try {
    return json(await tick(assertServiceRoleClient()));
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
