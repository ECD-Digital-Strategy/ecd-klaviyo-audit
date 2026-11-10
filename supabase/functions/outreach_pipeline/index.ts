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
const MAX_DRAFT_TRIES = 3;
const STUCK_AUDIT_MS = 2 * 3_600_000;

type AuditingRow = {
  id: string;
  domain: string;
  notes: string | null;
  auto_started_at: string | null;
  updated_at: string;
  audit: { status?: string; created_at?: string } | null;
};

// Draft tries are counted in one line of the prospect's notes (no extra column).
const DRAFT_NOTE = /^Draft failed .*$/m;
function draftTries(notes: string | null): number {
  const m = (notes ?? "").match(/^Draft failed \((\d+)\/\d+\)/m);
  return m ? Number(m[1]) : 0;
}
function withDraftNote(notes: string | null, line: string): string {
  const base = (notes ?? "").replace(DRAFT_NOTE, "").replace(/\n{2,}/g, "\n").trim();
  return [base, line].filter(Boolean).join("\n");
}

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
  // Any failure before the capture starts marks the prospect failed, so the same
  // store is not retried (and a client or audit made) every 30 minutes.
  const fail = async (msg: string) => {
    await sb.from("outreach_prospects").update({
      status: "failed",
      notes: [p.notes, msg].filter(Boolean).join("\n"),
    }).eq("id", p.id).eq("status", "new");
    return msg;
  };
  let clientId = p.client_id;
  if (!clientId) {
    // Reuse the prospect's client from an earlier try, by website, before making one.
    const { data: prior } = await sb
      .from("clients")
      .select("id")
      .eq("is_outreach", true)
      .eq("website_url", websiteUrl)
      .order("created_at", { ascending: true })
      .limit(1);
    clientId = ((prior ?? []) as Array<{ id: string }>)[0]?.id ?? null;
  }
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
    if (error) return await fail(`Could not create the client: ${error.message}`);
    clientId = (data as { id: string }).id;
  }
  // Saved straight away, so a later failure never leaves the client orphaned.
  if (clientId !== p.client_id) await sb.from("outreach_prospects").update({ client_id: clientId }).eq("id", p.id);
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
  if (auditErr) return await fail(`Could not create the audit: ${auditErr.message}`);
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
  if (secErr) {
    await sb.from("audits").delete().eq("id", auditId); // no half-made audit left behind
    return await fail(`Could not create the audit sections: ${secErr.message}`);
  }
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

  // 1. Draft finished audits, least recently tried first, so one that keeps
  // failing never starves the rest.
  const { data: auditing } = await sb
    .from("outreach_prospects")
    .select("id, domain, email_body, notes, auto_started_at, updated_at, audit:audits(status, created_at)")
    .eq("status", "auditing")
    .is("email_body", null)
    .order("updated_at", { ascending: true });
  const rows = (auditing ?? []) as AuditingRow[];
  const done = rows.filter((p) => p.audit?.status === "published");
  for (const p of done.slice(0, 3)) {
    const r = await callFn<{ message?: string; error?: string }>("outreach_draft", { prospect_id: p.id });
    if (r.ok) {
      log.push(`${p.domain}: drafted`);
      continue;
    }
    const why = String(r.data?.message ?? r.data?.error ?? `HTTP ${r.status}`);
    const tries = draftTries(p.notes) + 1;
    const giveUp = tries >= MAX_DRAFT_TRIES;
    await sb.from("outreach_prospects").update({
      ...(giveUp ? { status: "failed" } : {}),
      notes: withDraftNote(p.notes, giveUp
        ? `Draft failed ${tries} times, no more automatic tries: ${why}. Draft it by hand.`
        : `Draft failed (${tries}/${MAX_DRAFT_TRIES}): ${why}`),
    }).eq("id", p.id).eq("status", "auditing");
    log.push(`${p.domain}: draft failed (${why})${giveUp ? ", gave up" : ""}`);
  }

  // A capture that died leaves an audit that never finishes: after STUCK_AUDIT_MS
  // it is marked failed (shown on the page with the note) and stops counting.
  const nowMs = Date.now();
  let inFlight = 0;
  for (const p of rows) {
    if (p.audit?.status === "published") continue;
    const startedAt = Date.parse(p.audit?.created_at ?? p.auto_started_at ?? p.updated_at);
    if (Number.isFinite(startedAt) && nowMs - startedAt > STUCK_AUDIT_MS) {
      await sb.from("outreach_prospects").update({
        status: "failed",
        notes: [p.notes, "The audit did not finish within 2 hours. Skip it, or run the audit again from the web audit page."].filter(Boolean).join("\n"),
      }).eq("id", p.id).eq("status", "auditing");
      log.push(`${p.domain}: audit stuck, marked failed`);
      continue;
    }
    inFlight++;
  }

  // 2. Start the next best store, within the daily number and two at a time.
  const cap = settings.auto_audits_per_day ?? 3;
  const { count: startedToday } = await sb
    .from("outreach_prospects")
    .select("id", { count: "exact", head: true })
    .gte("auto_started_at", startOfSendDay(new Date()).toISOString());
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
