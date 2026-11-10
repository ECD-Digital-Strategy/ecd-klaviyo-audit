// Adds the direct mail (PostPilot) section to a Klaviyo audit, when it earns it.
//
// Runs after the analysis pipeline has persisted, and on demand for a backfill.
// Reads the audit's own counts (profile scan, Placed Order metric, flows), the
// client's market and, when Shopify is connected, its traffic; sizes the
// audience email cannot reach; and applies a strict gate. A qualifying audit
// gets a "direct_mail" section with a model-written narrative around
// code-computed numbers, plus the PostPilot add-on highlighted in its layout so
// the proposal picks it up. An audit that does not qualify gets the same row
// with the verdict and reasons, hidden, so the strategist can see why.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { hasCronSecret, isServiceRoleAuthorization, requireStaffUserId } from "../_shared/auth.ts";
import { decryptString } from "../_shared/crypto.ts";
import { createLlmClient, type LlmTool } from "../_shared/llm-adapter.ts";
import { sanitizeDashDeep } from "../_shared/dash.ts";
import { KLAVIYO_BASE, KLAVIYO_REVISION } from "../_shared/klaviyo-api.ts";
import { exchangeClientCredentials, normalizeShopDomain, shopifyRest } from "../_shared/shopify-api.ts";
import { fetchSessions } from "../_shared/shopify-sessions.ts";
import {
  buildDirectMailPlan,
  type CoreFlowState,
  DIRECT_MAIL_SECTION_KEY,
  DIRECT_MAIL_TEMPLATE_SLUG,
  type DirectMailInputs,
  type DirectMailPlan,
  factsForNarrative,
  inferMarketFromKlaviyoAccount,
  type MarketSource,
} from "../_shared/direct-mail.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MODEL = "claude-sonnet-5-5";
const AOV_WINDOW_DAYS = 90;

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type, accept, origin, referer, user-agent, x-cron-secret",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
    ...init,
  });
}

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

type Sb = SupabaseClient;

// --- Inputs ------------------------------------------------------------------

/** Average order value from the conversion metric, over a fixed window. Asks
 * Klaviyo for count and sum together so the two cannot disagree. */
async function readAov(
  apiKey: string,
  revision: string,
  metricId: string,
  timezone: string,
): Promise<{ aov: number | null; orders: number | null }> {
  const since = new Date(Date.now() - AOV_WINDOW_DAYS * 86_400_000);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 40_000);
  try {
    const res = await fetch(`${KLAVIYO_BASE}/api/metric-aggregates/`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Klaviyo-API-Key ${apiKey}`,
        revision,
      },
      body: JSON.stringify({
        data: {
          type: "metric-aggregate",
          attributes: {
            metric_id: metricId,
            measurements: ["count", "sum_value"],
            interval: "month",
            filter: [
              `greater-or-equal(datetime,${since.toISOString()})`,
              `less-than(datetime,${new Date().toISOString()})`,
            ],
            timezone: timezone || "UTC",
          },
        },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { aov: null, orders: null };
    const body = await res.json().catch(() => null);
    const points = body?.data?.attributes?.data ?? [];
    let count = 0;
    let sum = 0;
    const add = (v: unknown, into: (n: number) => void) => {
      if (Array.isArray(v)) for (const x of v) into(Number(x) || 0);
      else if (v != null) into(Number(v) || 0);
    };
    for (const p of points) {
      add(p?.measurements?.count, (n) => { count += n; });
      add(p?.measurements?.sum_value, (n) => { sum += n; });
    }
    if (count <= 0 || sum <= 0) return { aov: null, orders: count > 0 ? count : null };
    return { aov: sum / count, orders: count };
  } catch {
    return { aov: null, orders: null };
  } finally {
    clearTimeout(t);
  }
}

async function shopifyAccess(sb: Sb, clientId: string) {
  const [{ data: conn }, { data: sec }] = await Promise.all([
    sb.from("shopify_connections").select("shop_domain, auth_method, app_client_id").eq("client_id", clientId).maybeSingle(),
    sb.from("client_secrets").select("shopify_admin_token_ciphertext, shopify_admin_token_iv").eq("client_id", clientId).maybeSingle(),
  ]);
  const shopDomain = normalizeShopDomain(conn?.shop_domain ?? "");
  if (!shopDomain || !sec?.shopify_admin_token_ciphertext || !sec?.shopify_admin_token_iv) return null;
  try {
    const stored = await decryptString(sec.shopify_admin_token_ciphertext, sec.shopify_admin_token_iv);
    if (conn?.auth_method === "client_credentials") {
      const grant = await exchangeClientCredentials(shopDomain, conn.app_client_id ?? "", stored);
      if (!grant.ok) return null;
      return { shopDomain, token: grant.token };
    }
    return { shopDomain, token: stored };
  } catch {
    return null;
  }
}

async function collectInputs(sb: Sb, auditId: string, clientId: string, context: Record<string, unknown> | null) {
  const [rollupRes, kconnRes, secRes, flowsRes, segRes, tplRes] = await Promise.all([
    sb.from("klaviyo_reporting_rollups").select("computed").eq("audit_id", auditId).eq("timeframe_key", "last_30_days").maybeSingle(),
    sb.from("klaviyo_connections").select("conversion_metric_id, timezone, preferred_currency, revision").eq("client_id", clientId).maybeSingle(),
    sb.from("client_secrets").select("klaviyo_private_key_ciphertext, klaviyo_private_key_iv").eq("client_id", clientId).maybeSingle(),
    sb.from("audit_sections").select("section_details").eq("audit_id", auditId).eq("section_key", "flows").maybeSingle(),
    sb.from("audit_sections").select("section_details").eq("audit_id", auditId).eq("section_key", "segmentation").maybeSingle(),
    sb.from("revenue_opportunity_templates").select("*").eq("slug", DIRECT_MAIL_TEMPLATE_SLUG).maybeSingle(),
  ]);

  const snap = ((rollupRes.data?.computed as Record<string, unknown> | null)?.account_snapshot ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  // AOV from the verified conversion metric. Without a key or a metric there is
  // no AOV, and the gate says so rather than guessing.
  let aov: { aov: number | null; orders: number | null } = { aov: null, orders: null };
  const metricId = String(kconnRes.data?.conversion_metric_id ?? "").trim();
  if (metricId && secRes.data?.klaviyo_private_key_ciphertext && secRes.data?.klaviyo_private_key_iv) {
    try {
      const apiKey = await decryptString(secRes.data.klaviyo_private_key_ciphertext, secRes.data.klaviyo_private_key_iv);
      aov = await readAov(apiKey, String(kconnRes.data?.revision ?? KLAVIYO_REVISION), metricId, String(kconnRes.data?.timezone ?? "UTC"));
    } catch { /* recorded as unknown */ }
  }

  // Market and traffic. Shopify is the authority when connected; otherwise the
  // Klaviyo account's currency and timezone decide US or unknown. Only one of
  // nineteen Klaviyo clients has a store connected, so Shopify-only would have
  // switched this off for nearly everyone.
  let market: { country: string | null; source: MarketSource } = { country: null, source: "unknown" };
  let sessions: number | null = null;
  const shop = await shopifyAccess(sb, clientId);
  if (shop) {
    try {
      const res = await shopifyRest(shop.shopDomain, shop.token, "/shop.json?fields=country_code");
      const cc = String(res.body?.shop?.country_code ?? "").trim();
      if (res.ok && cc) market = { country: cc.toUpperCase(), source: "shopify" };
    } catch { /* fall through */ }
    try {
      const report = await fetchSessions(shop.shopDomain, shop.token, 30);
      if (report && !report.error && report.current.sessions > 0) sessions = report.current.sessions;
    } catch { /* traffic stays unknown */ }
  }
  if (!market.country) {
    const inferred = inferMarketFromKlaviyoAccount(kconnRes.data?.preferred_currency, kconnRes.data?.timezone);
    if (inferred) market = { country: inferred, source: "klaviyo_account" };
  }

  const coreFlows = (((flowsRes.data?.section_details as Record<string, unknown> | null)?.flows as { core_flows?: unknown[] } | undefined)?.core_flows ?? [])
    .map((f) => f as Record<string, unknown>)
    .filter((f) => typeof f.flow_name === "string")
    .map<CoreFlowState>((f) => ({ flow_name: String(f.flow_name), present: f.present === true, live: f.live === true }));
  const segDetails = ((segRes.data?.section_details as Record<string, unknown> | null)?.segmentation ?? null) as { has_vip_segments?: boolean } | null;

  const tpl = tplRes.data as Record<string, unknown> | null;
  const inputs: DirectMailInputs = {
    total_profiles: n(snap.total_profiles_count),
    email_subscribed: n(snap.email_subscribed_profiles_count),
    active_90d: n(snap.active_profiles_90d_count),
    suppressed: n(snap.suppressed_profiles_count),
    counts_partial: snap.profile_scan_status === "partial" || snap.suppressed_profiles_truncated === true,
    aov: aov.aov,
    aov_orders: aov.orders,
    aov_window_days: AOV_WINDOW_DAYS,
    market,
    monthly_sessions: sessions,
    store_revenue_30d: n(((snap.revenue_breakdown as Record<string, unknown> | undefined) ?? {}).total_store_revenue),
    core_flows: coreFlows,
    has_vip_segments: typeof segDetails?.has_vip_segments === "boolean" ? segDetails.has_vip_segments : null,
    sells_subscriptions: Boolean(context?.sells_subscriptions),
    fees: {
      setup: n(tpl?.one_time_price == null ? null : Number(tpl.one_time_price)),
      monthly: n(tpl?.monthly_price == null ? null : Number(tpl.monthly_price)),
    },
  };
  return { inputs, template: tpl, profileScanStatus: String(snap.profile_scan_status ?? "") };
}

// --- Narrative ---------------------------------------------------------------

type Narrative = {
  current_state_title: string;
  optimized_state_title: string;
  current_state_notes: string;
  optimized_notes: string;
  ai_findings: string;
  summary_text: string;
  key_findings: string[];
};

// Word caps, enforced in code after the model answers. The first version of
// this section came back at four paragraphs a side and five long findings, and
// the strategist's verdict was "very hard to digest". The section's tables carry
// the detail; the prose only has to say what the tables mean.
const CAPS = { notes: 60, findings: 80, summary: 30, key_finding: 20 } as const;

const NARRATIVE_TOOL: LlmTool = {
  name: "record_direct_mail_section",
  description: "Write the short narrative of the direct mail section of a Klaviyo audit from the facts supplied.",
  input_schema: {
    type: "object",
    required: ["current_state_title", "optimized_state_title", "current_state_notes", "optimized_notes", "ai_findings", "summary_text", "key_findings"],
    properties: {
      current_state_title: { type: "string", description: "Heading for what email cannot reach today. 3 to 6 words." },
      optimized_state_title: { type: "string", description: "Heading for the direct mail companion. 3 to 6 words." },
      current_state_notes: { type: "string", description: `ONE paragraph, at most ${CAPS.notes} words. The gap, in the client's own numbers.` },
      optimized_notes: { type: "string", description: `ONE paragraph, at most ${CAPS.notes} words. Postcards at the end of the flows they already run, plus the winback email cannot run, measured with holdouts.` },
      ai_findings: { type: "string", description: `ONE paragraph for the strategist, at most ${CAPS.findings} words: why this account, and the first two tests to run.` },
      summary_text: { type: "string", description: `One sentence, at most ${CAPS.summary} words.` },
      key_findings: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: { type: "string" },
        description: `Exactly 3. Each at most ${CAPS.key_finding} words, one number from the facts in each.`,
      },
    },
  },
};

const SYSTEM = `You write one short section of a Klaviyo lifecycle audit for ECD Digital Strategy: the direct mail companion, built on PostPilot.

Hard rules, none of them optional:
- Use only the facts you are given. Every number in your text must appear in the facts. If a fact is missing, do not fill it in.
- Never state, estimate or imply any PostPilot price, rate or plan. Pricing comes from the PostPilot partner contact. The recommended opening BUDGET (0.5% of trailing 30-day revenue, given in the facts) is the client's own spend and may be stated, always as a starting point to scale from on measured results.
- Direct mail is a companion to Klaviyo, never a replacement, and it does not fix deliverability or list health.
- Quote benchmarks as medians with their spread, exactly as given, and never as a forecast for this brand. Never quote a case-study result.
- Say "iROAS" only for holdout-measured figures.
- Postcards to suppressed or unsubscribed profiles are postal mail under separate consent rules, not a workaround for email suppression; say so in one clause where you mention that audience.
- Write for the client, not the analyst: no methodology, no tooling, no "should be sized". Say "site traffic was not sized in this audit", never mention connections.
- Respect the word caps. Short sentences. Plain business English, second person, no hype. Never use an em dash or en dash.
- Framing: the Klaviyo program is doing its job; this is about the profiles it is not allowed to touch.`;

const clip = (t: string, max: number) => {
  const w = t.trim().split(/\s+/).filter(Boolean);
  if (w.length <= max) return t.trim();
  // Cut at the last sentence end inside the cap; otherwise at the cap.
  const head = w.slice(0, max).join(" ");
  const lastStop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("."));
  return lastStop > head.length * 0.5 ? head.slice(0, lastStop + 1) : head.replace(/[,;:]?$/, ".");
};

// Why the last narrative attempt gave up, surfaced in the response because the
// hosted log query is not reliable enough to lean on for a diagnosis.
let lastNarrativeError: string | null = null;

async function writeNarrative(plan: DirectMailPlan, companyName: string): Promise<Narrative | null> {
  lastNarrativeError = null;
  try {
    const llm = createLlmClient("anthropic", { model: MODEL });
    const turn = await llm.runTurn({
      system: SYSTEM,
      messages: [{
        role: "user",
        text: `FACTS FOR ${companyName}:\n${factsForNarrative(plan, companyName)}\n\nCall record_direct_mail_section exactly once.`,
      }],
      tools: [NARRATIVE_TOOL],
      toolChoice: { type: "tool", name: "record_direct_mail_section" },
    });
    if (turn.kind !== "tool_call") {
      lastNarrativeError = "model did not call the tool: " + JSON.stringify(turn).slice(0, 400);
      console.error("direct_mail narrative:", lastNarrativeError);
      return null;
    }
    const input = (turn.input ?? {}) as Partial<Narrative>;
    const items = Array.isArray(input.key_findings) ? input.key_findings.map((s) => String(s).trim()).filter(Boolean) : [];
    if (items.length < 3) {
      lastNarrativeError = "fewer than 3 key findings: " + items.length;
      console.error("direct_mail narrative:", lastNarrativeError);
      return null;
    }
    const text = String(input.current_state_notes ?? "") + String(input.optimized_notes ?? "") + String(input.ai_findings ?? "") + items.join(" ");
    // A per-piece or per-card figure is a PostPilot price and is refused. A
    // monthly dollar figure is the client's own budget (0.5 to 1% of revenue),
    // which the source asks us to state.
    if (/\$\s?\d[\d,]*(\.\d+)?\s*(a|per|\/)\s*(piece|card|postcard)/i.test(text)) {
      lastNarrativeError = "model wrote a price";
      console.error("direct_mail narrative:", lastNarrativeError);
      return null;
    }
    return sanitizeDashDeep({
      current_state_title: String(input.current_state_title ?? "").trim() || "What email cannot reach",
      optimized_state_title: String(input.optimized_state_title ?? "").trim() || "Postcards where email stops",
      current_state_notes: clip(String(input.current_state_notes ?? ""), CAPS.notes),
      optimized_notes: clip(String(input.optimized_notes ?? ""), CAPS.notes),
      ai_findings: clip(String(input.ai_findings ?? ""), CAPS.findings),
      summary_text: clip(String(input.summary_text ?? ""), CAPS.summary),
      key_findings: items.slice(0, 3).map((k) => clip(k, CAPS.key_finding + 4)),
    });
  } catch (e) {
    lastNarrativeError = e instanceof Error ? e.message : String(e);
    console.error("direct_mail narrative failed:", lastNarrativeError);
    return null;
  }
}

/** Plain numbers in plain sentences, for when the model is unavailable. */
function fallbackNarrative(plan: DirectMailPlan): Narrative {
  const g = plan.gap!;
  const fmt = (v: number) => v.toLocaleString("en-US");
  const rec = plan.budget?.[0];
  return sanitizeDashDeep({
    current_state_title: "What email cannot reach",
    optimized_state_title: "Postcards where email stops",
    current_state_notes:
      `Of ${fmt(g.total_profiles)} profiles, ${fmt(g.suppressed)} (${g.suppressed_pct}%) are suppressed or unsubscribed and ${fmt(g.unengaged)} (${g.unengaged_pct}%) have gone quiet for 90 days. Email cannot reach the first group and should not send to the second. Roughly ${fmt(g.mailable.low)} to ${fmt(g.mailable.high)} of them can still be reached by post.`,
    optimized_notes:
      `Each flow you already run gets a postcard at the end of its email sequence, and the audience email cannot reach gets a winback program of its own. Postal mail runs under its own consent rules, not as a workaround for email suppression. Every campaign holds out a share of its audience so results read as incremental ROAS.`,
    ai_findings:
      `Retention programs to customers with orders have a holdout-tested median of ${plan.cannot_run[0].benchmark.median}x iROAS (${plan.cannot_run[0].benchmark.p25}x to ${plan.cannot_run[0].benchmark.p75}x). Start with the unreachable winback and the strongest flow pairing as one-off tests with holdouts, read at 30 days, then automate.` +
      (rec ? ` An opening budget of about $${fmt(rec.budget_per_month)} a month, 0.5% of trailing 30-day revenue, buys roughly ${fmt(rec.pieces_low)} to ${fmt(rec.pieces_high)} postcards.` : ""),
    summary_text:
      `Your Klaviyo program is doing its job; this is about the ${fmt(g.unreachable)} profiles it is not allowed to touch.`,
    key_findings: [
      `${fmt(g.suppressed)} suppressed or unsubscribed profiles (${g.suppressed_pct}%) are unreachable by email.`,
      `${fmt(g.unengaged)} subscribers (${g.unengaged_pct}%) have not engaged in 90 days.`,
      `About ${fmt(g.mailable.low)} to ${fmt(g.mailable.high)} of them can be reached by post.`,
    ],
  });
}

// --- Persist -----------------------------------------------------------------

async function upsertSection(sb: Sb, auditId: string, plan: DirectMailPlan, narrative: Narrative | null) {
  const { data: rows } = await sb.from("audit_sections").select("id, section_key, status, section_config").eq("audit_id", auditId);
  const existing = (rows ?? []).find((r) => r.section_key === DIRECT_MAIL_SECTION_KEY);
  // The public report shows approved sections when any exist, so this row has
  // to match its siblings or it vanishes from the client's view.
  const siblingStatus = (rows ?? []).find((r) => r.section_key === "flows")?.status ?? "approved";

  const existingConfig = ((existing?.section_config as Record<string, unknown> | null) ?? {});
  const dmConfig = { ...((existingConfig[DIRECT_MAIL_SECTION_KEY] as Record<string, unknown> | undefined) ?? {}) };
  // Not qualified: hide it. Qualified: unhide only if we were the ones who hid
  // it, so a strategist's own choice to hide the section survives a re-run.
  if (!plan.gate.qualified) {
    dmConfig.hidden = true;
    dmConfig.hidden_by_gate = true;
  } else if (dmConfig.hidden_by_gate === true) {
    delete dmConfig.hidden;
    delete dmConfig.hidden_by_gate;
  }
  const sectionConfig = { ...existingConfig, [DIRECT_MAIL_SECTION_KEY]: dmConfig };

  const n = narrative;
  const patch: Record<string, unknown> = {
    section_key: DIRECT_MAIL_SECTION_KEY,
    audit_id: auditId,
    status: siblingStatus,
    revenue_opportunity: 0,
    confidence: plan.gate.qualified ? (plan.gap?.counts_partial ? "medium" : "high") : "low",
    section_details: { [DIRECT_MAIL_SECTION_KEY]: plan },
    section_config: sectionConfig,
  };
  if (n) {
    Object.assign(patch, {
      current_state_title: n.current_state_title,
      optimized_state_title: n.optimized_state_title,
      current_state_notes: n.current_state_notes,
      optimized_notes: n.optimized_notes,
      ai_findings: n.ai_findings,
      summary_text: n.summary_text,
      key_findings: { items: n.key_findings, items_hidden: n.key_findings.map(() => false) },
    });
  } else if (!existing) {
    Object.assign(patch, {
      current_state_title: "", optimized_state_title: "", current_state_notes: "", optimized_notes: "",
      ai_findings: "", human_edited_findings: "", summary_text: "", key_findings: { items: [], items_hidden: [] },
    });
  }

  if (existing) {
    const { audit_id: _a, section_key: _k, ...rest } = patch;
    const { error } = await sb.from("audit_sections").update(rest).eq("id", existing.id);
    if (error) throw error;
    return existing.id as string;
  }
  const { data, error } = await sb.from("audit_sections").insert(patch).select("id").single();
  if (error) throw error;
  return data.id as string;
}

/** Put the PostPilot add-on on the audit, highlighted, or take our own copy
 * off again if the audit no longer qualifies. An item the strategist added by
 * hand (no auto_added flag) is never touched. */
async function syncAddOn(sb: Sb, auditId: string, template: Record<string, unknown> | null, plan: DirectMailPlan) {
  if (!template) return { changed: false, reason: "no_template" };
  // Read the layout fresh, right before patching it. The copy read at the
  // start of this invocation is a model call old, and writing it back lost
  // whatever the editor saved in the meantime. Only the add-on item changes.
  const { data: fresh, error: readErr } = await sb.from("audits").select("layout").eq("id", auditId).single();
  if (readErr) throw readErr;
  const layout = ((fresh?.layout as Record<string, unknown> | null) ?? {});
  const revenueSummary = { ...((layout.revenue_summary as Record<string, unknown> | undefined) ?? {}) };
  const blocks = { ...((revenueSummary.blocks as Record<string, unknown> | undefined) ?? {}) };
  const addOns = { ...((blocks.addOns as Record<string, unknown> | undefined) ?? {}) };
  const items = Array.isArray(addOns.items) ? [...(addOns.items as Array<Record<string, unknown>>)] : [];
  const idx = items.findIndex((it) => String(it?.template_slug ?? "") === DIRECT_MAIL_TEMPLATE_SLUG);

  const presenterNote = plan.gap
    ? `Show the ${plan.gap.suppressed.toLocaleString("en-US")} suppressed and ${plan.gap.unengaged.toLocaleString("en-US")} unengaged profiles, then the flow pairings table: the postcard goes at the end of each flow they already run.`
    : "Show the reachability gap and the flow pairings table.";

  if (plan.gate.qualified) {
    if (idx >= 0) {
      items[idx] = { ...items[idx], highlighted: true, related_section_keys: ["flows", "segmentation"], presenter_note: presenterNote, is_hidden: false };
      // An item we added ourselves keeps its fees in step with the catalog, so
      // a price change in Admin reaches old audits on a regenerate instead of
      // leaving a stale figure to go out in a proposal. An item a strategist
      // added or re-priced by hand is left exactly as they left it.
      if (items[idx].auto_added === true) {
        items[idx] = {
          ...items[idx],
          content: template.content ? String(template.content) : items[idx].content,
          one_time_price: template.one_time_price == null ? null : Number(template.one_time_price),
          one_time_label: template.one_time_label ? String(template.one_time_label) : null,
          monthly_price: template.monthly_price == null ? null : Number(template.monthly_price),
          monthly_label: template.monthly_label ? String(template.monthly_label) : null,
        };
      }
    } else {
      const maxOrder = items.reduce((m, it) => Math.max(m, Number(it?.display_order ?? 0)), 0);
      items.push({
        template_slug: DIRECT_MAIL_TEMPLATE_SLUG,
        name: String(template.name ?? "Direct Mail via PostPilot"),
        description: template.description ? String(template.description) : undefined,
        content: template.content ? String(template.content) : undefined,
        bullets: [],
        revenue_monthly: 0,
        one_time_price: template.one_time_price == null ? null : Number(template.one_time_price),
        one_time_label: template.one_time_label ? String(template.one_time_label) : null,
        monthly_price: template.monthly_price == null ? null : Number(template.monthly_price),
        monthly_label: template.monthly_label ? String(template.monthly_label) : null,
        image_url: template.image_url ? String(template.image_url) : null,
        details_url: template.details_url ? String(template.details_url) : null,
        display_order: maxOrder + 10,
        is_hidden: false,
        highlighted: true,
        related_section_keys: ["flows", "segmentation"],
        presenter_note: presenterNote,
        investment_included: true,
        auto_added: true,
      });
    }
  } else {
    if (idx < 0) return { changed: false, reason: "not_qualified" };
    if (items[idx].auto_added !== true) return { changed: false, reason: "manual_item_kept" };
    items.splice(idx, 1);
  }

  addOns.items = items;
  blocks.addOns = addOns;
  revenueSummary.blocks = blocks;
  const nextLayout = { ...layout, revenue_summary: revenueSummary };
  const { error } = await sb.from("audits").update({ layout: nextLayout, updated_at: new Date().toISOString() }).eq("id", auditId);
  if (error) throw error;
  return { changed: true, reason: plan.gate.qualified ? "added_or_refreshed" : "removed" };
}

// --- Entry -------------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: { code: "method_not_allowed" } }, { status: 405 });
  const correlationId = crypto.randomUUID();

  try {
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!isServiceRoleAuthorization(bearer) && !(await hasCronSecret(req, "web_pipeline_cron_secret"))) {
      try {
        await requireStaffUserId(req, "audits");
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unauthorized";
        return json({ ok: false, error: { code: "unauthorized", message }, correlationId }, { status: message === "Forbidden" ? 403 : 401 });
      }
    }

    const body = (await req.json().catch(() => ({}))) as { audit_id?: string; skip_narrative?: boolean };
    const auditId = String(body.audit_id ?? "").trim();
    if (!auditId) return json({ ok: false, error: { code: "bad_request", message: "Missing audit_id" }, correlationId }, { status: 400 });

    const sb = serviceClient();
    const { data: audit, error: auditErr } = await sb
      .from("audits")
      .select("id, client_id, audit_type, audit_method, layout, context")
      .eq("id", auditId)
      .maybeSingle();
    if (auditErr) throw auditErr;
    if (!audit) return json({ ok: false, error: { code: "not_found" }, correlationId }, { status: 404 });
    if ((audit.audit_type ?? "klaviyo") !== "klaviyo" || audit.audit_method !== "api") {
      return json({ ok: true, correlationId, status: "skipped", reason: "not_klaviyo_api_audit" });
    }

    const { data: client } = await sb.from("clients").select("company_name, name").eq("id", audit.client_id).maybeSingle();
    const companyName = String(client?.company_name || client?.name || "the brand");
    const context = (audit.context && typeof audit.context === "object") ? audit.context as Record<string, unknown> : null;

    const { inputs, template, profileScanStatus } = await collectInputs(sb, auditId, audit.client_id as string, context);
    // The counts come from the profile scan. Until it has finished there is
    // nothing honest to size, so the run waits for the next trigger.
    if (inputs.total_profiles == null || (profileScanStatus !== "complete" && profileScanStatus !== "partial")) {
      return json({ ok: true, correlationId, status: "skipped", reason: "profile_scan_not_ready", profile_scan_status: profileScanStatus || null });
    }

    const plan = buildDirectMailPlan(inputs);
    let narrative: Narrative | null = null;
    let narrativeSource = "none";
    if (plan.gate.qualified) {
      narrative = body.skip_narrative ? null : await writeNarrative(plan, companyName);
      narrativeSource = narrative ? "model" : "fallback";
      if (!narrative) narrative = fallbackNarrative(plan);
    }

    const sectionId = await upsertSection(sb, auditId, plan, narrative);
    const addOn = await syncAddOn(sb, auditId, template, plan);

    return json({
      ok: true,
      correlationId,
      status: "complete",
      qualified: plan.gate.qualified,
      reasons: plan.gate.reasons,
      checks: plan.gate.checks,
      market: plan.market,
      gap: plan.gap ? { mailable_mid: plan.gap.mailable.mid, suppressed: plan.gap.suppressed, unengaged: plan.gap.unengaged, sitematch: plan.gap.sitematch } : null,
      aov: plan.aov,
      section_id: sectionId,
      add_on: addOn,
      narrative: narrativeSource,
      narrative_error: lastNarrativeError,
    });
  } catch (e) {
    return json({ ok: false, error: { code: "request_failed", message: e instanceof Error ? e.message : String(e) }, correlationId }, { status: 200 });
  }
});
