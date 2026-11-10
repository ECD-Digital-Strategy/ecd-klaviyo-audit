import { AI_SCHEMA_VERSION } from "./schema.ts";
import { AUDIT_SECTION_KEYS, type SectionKey } from "./schema.ts";
import { buildBenchmarkReferenceBlock, formatBenchmarkRange, getFlowBenchmarks, type BenchmarkConfig, DEFAULT_BENCHMARK_CONFIG } from "../_shared/benchmarks.ts";

type WizardData = {
  auditId?: string;
  clientId?: string;
  clientName?: string;
  companyName?: string;
  industry?: string;
  espPlatform?: string;
  websiteUrl?: string;
  /** Total profiles from the full profile scan (audits.list_size). */
  listSize?: number;
  /** Flow revenue per recipient (audits.aov; the column name is historical). */
  aov?: number;
  /** Email-subscribed profiles (audits.monthly_traffic; historical name). */
  monthlyTraffic?: number;
  notes?: string;
  auditMethod?: "api" | "screenshot";
  requestedSectionKeys?: SectionKey[];
  /** When skipped, per-profile audience totals were not collected (fast audit). */
  profileAudienceScan?: "full" | "skipped" | "timed_out";
  /** Whether to treat subscription lifecycle as a core flow in the flows rubric. */
  clientSellsSubscriptions?: boolean;
  /** Highlighted ECD add-ons selected for this audit (emphasis in narrative + placements). */
  highlightedAddOns?: Array<{ template_slug: string; name: string; description?: string }>;
};

export type KlaviyoContext = {
  account?: { name?: string; timezone?: string; website_url?: string };
  flows?: Array<{ name: string; status: string; trigger_type?: string }>;
  campaigns?: Array<{ name: string; status: string; send_channel?: string; created_at?: string; updated_at?: string; send_time?: string }>;
  segments?: Array<{ name: string; created?: string; updated?: string }>;
  forms?: Array<{ name: string; status: string }>;
  lists?: Array<{ name: string }>;
  flowPerformance?: Array<{
    flow_name: string;
    flow_status: string;
    recipients_per_month?: number;
    actual_open_rate?: number;
    actual_click_rate?: number;
    actual_conv_rate?: number;
    monthly_revenue_current?: number;
    email_message_count?: number | null;
  }>;
  campaigns_truncated?: boolean;
  revenueBreakdown?: {
    total_store_revenue: number | null;
    attributed_revenue: number;
    campaign_revenue: number;
    flow_revenue: number;
    email_revenue: number;
    sms_revenue: number;
    timeframe: "last_30_days";
  } | null;
  competingSmsScan?: {
    website_url: string | null;
    detected_platforms: Array<{ id: string; name: string }>;
    klaviyo_sms_active: boolean;
    should_inject_finding: boolean;
  } | null;
  /** Email campaign deliverability (rates are 0-1), when the rollup has it. */
  deliverability?: {
    timeframe: string;
    open_rate: number | null;
    click_rate: number | null;
    bounce_rate: number | null;
    spam_complaint_rate: number | null;
    unsubscribe_rate: number | null;
    bounce_rate_90d?: number | null;
    spam_rate_90d?: number | null;
  } | null;
};

function pct(rate: number | null | undefined, digits = 2): string | null {
  return typeof rate === "number" && Number.isFinite(rate) ? `${(rate * 100).toFixed(digits)}%` : null;
}

/** Compact deliverability block for prompts, or null when there is no data. */
function summarizeDeliverability(d: KlaviyoContext["deliverability"]): Record<string, unknown> | null {
  if (!d) return null;
  const out: Record<string, unknown> = {
    timeframe: d.timeframe,
    campaign_open_rate: pct(d.open_rate, 1),
    campaign_click_rate: pct(d.click_rate),
    bounce_rate: pct(d.bounce_rate),
    spam_complaint_rate: pct(d.spam_complaint_rate, 3),
    unsubscribe_rate: pct(d.unsubscribe_rate),
  };
  if (d.bounce_rate_90d != null) out.bounce_rate_90d = pct(d.bounce_rate_90d);
  if (d.spam_rate_90d != null) out.spam_rate_90d = pct(d.spam_rate_90d, 3);
  return Object.values(out).some((v, i) => i > 0 && v != null) ? out : null;
}

/** One line per flow for the top-level step: name, status, monthly revenue.
 * Highest revenue first, capped so the prompt stays small. */
function compactFlowInventory(klaviyo: KlaviyoContext, limit = 40): string[] {
  const revenueByName = new Map(
    (klaviyo.flowPerformance ?? []).map((p) => [p.flow_name.toLowerCase(), Number(p.monthly_revenue_current) || 0]),
  );
  return [...(klaviyo.flows ?? [])]
    .map((f) => ({ f, revenue: revenueByName.get(f.name.toLowerCase()) ?? null }))
    .sort((a, b) => (b.revenue ?? -1) - (a.revenue ?? -1))
    .slice(0, limit)
    .map(({ f, revenue }) =>
      `${f.name} (${(f.status || "unknown").toLowerCase()}${revenue != null ? `, $${Math.round(revenue)}/mo` : ""})`
    );
}

export function buildAuditSystemPrompt() {
  return [
    "You are a principal Klaviyo lifecycle strategist and conversion auditor.",
    "You have been given detailed data pulled directly from the client's Klaviyo account via the API.",
    "Analyze the ACTUAL data provided — do NOT say data is missing if it is present in the input.",
    "Return only valid JSON matching the provided schema.",
    `Set schemaVersion to '${AI_SCHEMA_VERSION}'.`,
    "Use crisp, client-facing writing with concrete findings and VERY CONSERVATIVE, realistic revenue opportunities.",
    "CRITICAL: This report is presented directly to clients. NEVER use internal or technical language such as 'API', 'extract', 'data pull', 'snapshot', 'endpoint', 'database', 'schema', 'payload', 'backend', 'frontend', or any reference to how the data was obtained. Write as if you personally reviewed their Klaviyo account. Say 'your account shows…', 'we found…', 'based on your Klaviyo data…' — never 'the API extract shows…'.",
    "",
    "WRITING STYLE — SOUND HUMAN, NOT AI-GENERATED:",
    "Write like a sharp senior strategist talking to a client, not like a language model.",
    "NEVER use em-dashes (—). Use commas, periods, or the word 'and' instead.",
    "NEVER use semicolons to join clauses. Use two separate sentences.",
    "Avoid these overused AI words/phrases: 'leverage', 'robust', 'comprehensive', 'utilize', 'facilitate', 'streamline', 'it's worth noting', 'notably', 'a testament to', 'holistic', 'synergy', 'in terms of', 'when it comes to', 'at the end of the day', 'dive deep', 'delve', 'landscape'.",
    "Vary your sentence length. Mix short punchy sentences with longer ones. Don't start every sentence the same way.",
    "Be direct. Say 'this is missing' not 'there is an absence of'. Say 'you should add' not 'it would be beneficial to incorporate'.",
    "Use contractions naturally (you're, it's, don't, we'd, that's) like a real person would.",
    "For strengths bullets, use a simple dash (-) not an em-dash (—) if you need a separator.",
    "",
    "BALANCED TONE — BE HONEST WHEN THINGS ARE GOOD:",
    "If a section is performing well, say so clearly and give it a LOW revenue_opportunity ($0-$500/mo). Not everything needs fixing.",
    "If the account is generally healthy, most sections should have small or zero opportunity. Only flag real, specific gaps.",
    "Do NOT inflate problems or manufacture findings to fill space. A well-run account should have a small total opportunity.",
    "Praise strong performance explicitly — clients need to know what's working, not just what's broken.",
    "",
    "REVENUE OPPORTUNITY — STRICT RULES (these are HARD constraints, not suggestions):",
    "revenue_opportunity is a MONTHLY dollar figure representing realistic incremental revenue from improvements.",
    "ANCHOR everything to the account's ACTUAL current monthly flow revenue provided in the data. Higher-revenue accounts should have proportionally larger opportunities.",
    "Per-section maximums: no single section's revenue_opportunity should exceed 35% of the current monthly flow revenue.",
    "MISSING CORE FLOWS are the BIGGEST opportunity. If a critical revenue flow is completely absent (e.g., no Welcome Series, no Abandoned Cart, no Browse Abandonment, no Post-Purchase), that section alone can go up to 50% of current monthly flow revenue. These are the highest-impact gaps.",
    "Total across ALL 6 sections combined should be 40-100% of the current monthly flow revenue for a typical account with real gaps. Example: $10,000/mo in flow revenue with several missing flows could realistically have $6,000-$10,000/mo total opportunity.",
    "For well-managed accounts with few gaps, total opportunity should be 15-35% of current flow revenue. Not everything needs a big number, but don't undersell real improvements either.",
    "SCALING BY ACCOUNT SIZE:",
    "If current flow revenue is under $5,000/mo, total opportunity: $1,000-$4,000/mo.",
    "If current flow revenue is $5,000-$20,000/mo, total opportunity: $3,000-$15,000/mo.",
    "If current flow revenue is $20,000-$100,000/mo, total opportunity: $8,000-$40,000/mo.",
    "If current flow revenue is $100,000+/mo, total opportunity: $20,000-$80,000/mo.",
    "NEVER produce a total opportunity that exceeds 100% of the current monthly flow revenue. A $5,000/mo account cannot realistically unlock $72,000/mo.",
    "Don't inflate numbers to look impressive, but don't undersell real gaps either. A missing Abandoned Cart flow on a $50,000/mo account is easily worth $10,000-$15,000/mo, not $1,200/mo.",
    "Reference specific flow names, campaign names, segment names, and form names from the data.",
    "",
    "KLAVIYO ENTITY TAGGING — REQUIRED:",
    "Whenever you mention a Klaviyo flow, campaign, segment, or signup form BY NAME, wrap the exact name in backtick entity tags (never bold the name itself):",
    "  Flows: `flow:Exact Flow Name`",
    "  Campaigns: `campaign:Exact Campaign Name`",
    "  Segments: `segment:Exact Segment Name`",
    "  Forms: `form:Exact Form Name`",
    "Use the EXACT name as it appears in the Klaviyo data (including prefixes like 'MM |').",
    "Apply in narrative fields: findings, strengths, executiveSummary, current_state_notes, optimized_notes, ai_findings, key_findings items, and timeline items. Do NOT use entity tags in core flows matrix structure notes.",
    "You may still use **bold** for problem phrases, metrics, and non-entity emphasis — but NOT for flow/campaign/segment/form names (use entity tags instead).",
    "Example: 'SMS cart recovery is not pulling its weight yet, `flow:MM | SMS Cart Abandonment` has 45 recipients and $0 in revenue.'",
    "",
    "Do not use placeholders, hedging, or vague generic statements.",
    "EXECUTIVE SUMMARY: Keep the top executiveSummary text to 1-2 sentences max (no long paragraphs). Do NOT include dollar amounts or revenue promises in executiveSummary.",
    "",
    "BENCHMARK CONTEXT — CRITICAL:",
    "Whenever you cite a percentage (open rate, click rate, conversion rate, bounce rate, spam rate, revenue share, etc.), immediately state the relevant benchmark range and whether the result is healthy, below benchmark, or needs attention.",
    "Use the benchmark_reference table in the user payload. Do NOT invent benchmark ranges or call a rate 'healthy' without naming the range.",
    "Example strength: '`flow:Abandoned Checkout` generated $9,246 from 1,187 recipients with a 3.11% conversion rate, comfortably above the 2–6% benchmark for high-intent recovery flows.'",
    "Example strength: '`flow:Browse Abandonment` has an 83.6% open rate (benchmark 25–45%, likely inflated by Apple MPP) and $5,034 in revenue.'",
    "",
    "REVENUE SHARE CONTEXT — CRITICAL:",
    "When citing a dollar revenue figure in strengths or section key_findings items, also express its share of total store revenue and/or Klaviyo-attributed revenue using the precomputed values in klaviyo_data.revenue_context and top_flows[].pct_of_store_revenue / pct_of_attributed_revenue.",
    "NEVER invent or calculate percentages yourself. Use ONLY the provided pct fields.",
    "Phrase naturally: '$55,319 (~13% of total store revenue)' or '$55,319 (~42% of Klaviyo-attributed revenue, ~13% of total store revenue)'.",
    "All revenue figures in the data are last 30 days unless stated otherwise.",
    "",
    "STRENGTHS: Return 3-6 items in the strengths array.",
    "These appear as the 'What's Working' block on the client report (after Account Snapshot, before Key Findings).",
    "Each item is a single sentence with a bold lead phrase followed by supporting detail.",
    "Format: '**Bold claim**, specific evidence from the data.'",
    "Example strengths: '**Abandoned Cart/Checkout flows** drive 57.5% of all flow revenue ($41,858, ~10% of total store revenue), which is a strong foundation to build on', '`flow:Browse Abandonment` has an 83.6% open rate (benchmark 25–45%) and $5,034 in revenue (~1.2% of total store revenue), performing well on engagement'.",
    "Be specific: use actual flow names (via entity tags), dollar amounts, percentages, and recipient counts from the data.",
    "Do NOT be generic. Every bullet must reference concrete data from this specific Klaviyo account.",
    "Use **bold** for category labels and metrics. Use entity tags for specific Klaviyo asset names.",
    "Every paragraph should include 2-4 tagged entity names or bold metrics so the report is easy to scan.",
    "",
    "FINDINGS: Return exactly 5 strings in the findings array.",
    "These are the numbered problem statements shown last in the Executive Summary (after Account Snapshot and What's Working).",
    "Each finding is a specific gap or issue with a bold lead phrase and supporting evidence from the data.",
    "Format: '**Bold problem**, specific evidence from the account.' Tag any flow/campaign/segment/form names with entity tags.",
    "Each finding MUST be one complete sentence. NEVER split a single finding across multiple array items.",
    "When citing multiple flows or assets, name at most 3 examples then summarize the rest (e.g. 'and 4 other draft subscription flows'). Do NOT enumerate long lists of flow names.",
    "Keep each finding under 500 characters. Shorter, punchier findings are better than exhaustive lists.",
    "Rank by business impact (most critical first).",
    "NEVER include dollar amounts, monthly revenue figures, 'unlock $X', or revenue opportunity language in findings.",
    "Example findings: '**No active post-purchase flow**, which means repeat purchase revenue is not being captured after the first order', '**45 draft flows sitting idle**, including flows that previously generated revenue'.",
    "",
    "SECTION key_findings — KEY FINDINGS:",
    "Each section must include key_findings.items: 3–5 bullet strings displayed under that section for the sales presenter.",
    "Format like executive findings: **bold lead phrase**, then evidence. Rank by business impact (most critical first).",
    "Keep each bullet under 350 characters. Tag flow, segment, form, and campaign names with entity tags where relevant.",
    "NEVER include dollar amounts or revenue opportunity language in key_findings bullets.",
    "",
    "IMPLEMENTATION TIMELINE: Return exactly 4 phases based on the audit findings.",
    "Phase 1 (Week 1-2, 'Quick Wins'): low-effort high-impact fixes found in the data (e.g., activating draft flows, fixing broken forms).",
    "Phase 2 (Week 3-6, 'Core Flows'): building/rebuilding key revenue flows identified as gaps.",
    "Phase 3 (Month 2-3, 'Strategic'): segmentation improvements, template redesigns, testing programs.",
    "Phase 4 (Month 3+, 'Long-Term'): advanced personalization, data programs, sophisticated automations.",
    "Each phase should have 2-4 specific items referencing actual findings from this account.",
    "",
    "FLOW CATEGORY AWARENESS — CRITICAL:",
    "Not all flows are designed to generate revenue. You MUST distinguish between REVENUE flows and NON-REVENUE (engagement-only) flows.",
    "REVENUE flows: Abandoned Cart, Browse Abandonment, Welcome Series, Post-Purchase Cross-Sell/Upsell, Price Drop, Back-in-Stock, Winback/Win-Back, Re-engagement, Birthday/Anniversary, Referral/Loyalty/Rewards.",
    "NON-REVENUE flows (strictly): Review Request, Feedback/Survey/NPS, Sunset/List Cleaning, Order Confirmation, Shipping/Delivery/Fulfillment, Transactional, Double Opt-in, Password Reset, Account Confirmation.",
    "IMPORTANT: Winback and Re-engagement flows ARE revenue flows — they aim to drive lapsed customers back to purchase. Do NOT mark them as non-revenue.",
    "Do NOT flag non-revenue flows for low conversion rates or $0 revenue. A Review Request flow with 0% conversion is EXPECTED and correct.",
    "For non-revenue flows, evaluate engagement metrics only (open rate, click rate). Their purpose is customer relationships, not direct sales.",
    "When discussing strengths about flows, clearly distinguish between revenue performance and engagement performance.",
    "",
    "SECTION RUBRIC REQUIREMENTS:",
    "For FLOWS, explicitly cover: Abandoned Cart, Abandoned Checkout, Browse Abandonment, Welcome Series, Post-Purchase, Winback/Re-engagement, Back-in-Stock (bonus), Sunset/List Cleaning (bonus).",
    "CORE FLOWS MATRIX flow_name — CRITICAL: flow_name must be EXACTLY one of the predefined ECD labels below. NEVER put Klaviyo flow names, entity tags, or combined flow strings in flow_name.",
    "Predefined flow_name values (use verbatim): Abandoned Cart | Abandoned Checkout | Browse Abandonment | Welcome Series | Post-Purchase | Winback / Re-engagement | Back-in-Stock | Sunset / List Cleaning. When client sells subscriptions, also include Subscription Lifecycle (9 rows total, inserted after Post-Purchase).",
    "In current_structure_note and recommended_structure use plain text only (no entity tags, backticks, or flow: prefixes). Mention the matched Klaviyo flow by name if helpful.",
    "For each core flow include: present/not present, live/not live, email_count (the number of email messages/steps in the flow sequence — NOT the recipient count; use the emails_in_sequence value from flow performance data when available), current structure note, and recommended structure note.",
    "CORE FLOWS MATRIX NOTES: current_structure_note must be ONE short phrase (max 15 words, no full sentences). recommended_structure is overwritten by ECD company standards at persist — still emit a brief placeholder if required by schema.",
    "Example current: '3 emails, no SMS, weak offer on email 2'. Example recommended placeholder: 'ECD standard'.",
    "Do NOT write paragraphs in these fields. The report shows them in an expandable detail panel, not inline.",
    "For SEGMENTATION, explicitly assess: full-list vs segmented sends, engaged/unengaged audience definition, VIP/high-LTV segments, and benchmark against ECD architecture.",
    "For CAMPAIGNS, explicitly assess: send frequency consistency, segmented targeting vs blasting, subject/preview hygiene, and campaign type mix (promotional/educational/seasonal).",
    "For SIGNUP FORMS, explicitly assess: popup presence, embedded form presence, offer quality (discount/lead magnet), mobile optimization, and benchmark conversion framing.",
    "Populate section_details objects for flows/segmentation/campaigns/signup_forms so the frontend can render structured checklists and matrices.",
  ].join(" ");
}

type PromptMode = "full" | "sections_only" | "top_level_only";

function summarizeFlows(flows: KlaviyoContext["flows"]): string {
  if (!flows?.length) return "No flows found in the account.";
  const byStatus: Record<string, string[]> = {};
  for (const f of flows) {
    const s = (f.status || "unknown").toLowerCase();
    (byStatus[s] ??= []).push(f.name);
  }
  const lines = [`Total flows: ${flows.length}`];
  for (const [status, names] of Object.entries(byStatus)) {
    lines.push(`  ${status} (${names.length}): ${names.join(", ")}`);
  }
  const triggers = flows.filter(f => f.trigger_type).map(f => `${f.name} → ${f.trigger_type}`);
  if (triggers.length) lines.push(`Trigger types: ${triggers.join("; ")}`);
  return lines.join("\n");
}

function campaignRecency(c: NonNullable<KlaviyoContext["campaigns"]>[number]): number {
  for (const v of [c.send_time, c.updated_at, c.created_at]) {
    const ms = v ? Date.parse(v) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

/** Totals come from the full inventory; only the "recent" list is capped, and
 * it is sorted newest first by send time, then updated, then created. */
export function summarizeCampaigns(
  campaigns: KlaviyoContext["campaigns"],
  campaignsTruncated?: boolean,
  recentLimit = 20,
): string {
  if (!campaigns?.length) return "No campaigns found in the account.";
  const byStatus: Record<string, number> = {};
  for (const c of campaigns) {
    const s = (c.status || "unknown").toLowerCase();
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  const totalLabel = campaignsTruncated || campaigns.length > 500
    ? "Total campaigns: 500+ (partial scan, account may have more)"
    : `Total campaigns: ${campaigns.length}`;
  const lines = [totalLabel];
  for (const [status, count] of Object.entries(byStatus)) {
    lines.push(`  ${status}: ${count}`);
  }
  const recent = [...campaigns]
    .sort((a, b) => campaignRecency(b) - campaignRecency(a))
    .slice(0, recentLimit)
    .map(c => `${c.name} (${c.status})`);
  lines.push(`Recent campaigns (newest first, showing up to ${recentLimit}): ${recent.join(", ")}`);
  return lines.join("\n");
}

function summarizeSegments(segments: KlaviyoContext["segments"]): string {
  if (!segments?.length) return "No segments found in the account.";
  const names = segments.map(s => s.name);
  return `Total segments: ${segments.length}\nSegment names: ${names.join(", ")}`;
}

function summarizeForms(forms: KlaviyoContext["forms"]): string {
  if (!forms?.length) return "No signup forms found in the account.";
  const byStatus: Record<string, string[]> = {};
  for (const f of forms) {
    const s = (f.status || "unknown").toLowerCase();
    (byStatus[s] ??= []).push(f.name);
  }
  const lines = [`Total forms: ${forms.length}`];
  for (const [status, names] of Object.entries(byStatus)) {
    lines.push(`  ${status} (${names.length}): ${names.join(", ")}`);
  }
  return lines.join("\n");
}

function summarizeLists(lists: KlaviyoContext["lists"]): string {
  if (!lists?.length) return "No lists found.";
  return `Total lists: ${lists.length}\nList names: ${lists.map(l => l.name).join(", ")}`;
}


function summarizeFlowPerformance(
  perf: KlaviyoContext["flowPerformance"],
  config: BenchmarkConfig = DEFAULT_BENCHMARK_CONFIG,
): string {
  if (!perf?.length) return "No flow performance data available (metrics scope may be missing).";
  const lines = [`Flow performance data (last 30 days) for ${perf.length} flows (top 20 by revenue shown):`];
  // Highest revenue first, so the cap never drops the flows that matter most.
  const byRevenue = [...perf].sort((a, b) => (Number(b.monthly_revenue_current) || 0) - (Number(a.monthly_revenue_current) || 0));
  for (const fp of byRevenue.slice(0, 20)) {
    const b = getFlowBenchmarks(fp.flow_name, config);
    const tag = b.tier === "non_revenue" ? "[NON-REVENUE/engagement-only]" : "[REVENUE]";
    const parts = [`${fp.flow_name} ${tag} (${fp.flow_status}, ${b.tierLabel})`];
    if (fp.email_message_count != null) parts.push(`emails_in_sequence: ${fp.email_message_count}`);
    if (fp.recipients_per_month) parts.push(`recipients: ${fp.recipients_per_month}`);
    if (fp.actual_open_rate != null) {
      parts.push(`open: ${(fp.actual_open_rate * 100).toFixed(1)}% (benchmark ${formatBenchmarkRange(b.openRateLow, b.openRateHigh)})`);
    }
    if (fp.actual_click_rate != null) {
      parts.push(`click: ${(fp.actual_click_rate * 100).toFixed(1)}% (benchmark ${formatBenchmarkRange(b.clickRateLow, b.clickRateHigh)})`);
    }
    if (b.convApplicable && fp.actual_conv_rate != null) {
      parts.push(`conv: ${(fp.actual_conv_rate * 100).toFixed(2)}% (benchmark ${formatBenchmarkRange(b.convRateLow, b.convRateHigh)})`);
    }
    if (b.convApplicable && fp.monthly_revenue_current) parts.push(`revenue: $${fp.monthly_revenue_current.toFixed(0)}`);
    lines.push(`  - ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

const SUBSCRIPTION_FLOW_PATTERNS = [
  /\bsubscr/i,
  /subscribe\s*&\s*save/i,
  /\brenew(al)?\b/i,
  /\bre[-\s]?bill/i,
  /next\s*order/i,
  /\bmembership\b/i,
  /\brecharge\b/i,
  /\bskio\b/i,
  /\bloop\b/i,
  /ordergroove/i,
  /\bsmartrr\b/i,
  /stay\.?ai/i,
];

function summarizeSubscriptionFlowCandidates(
  flows: KlaviyoContext["flows"],
  perf: KlaviyoContext["flowPerformance"],
): string {
  if (!flows?.length) return "No flow inventory available to evaluate subscription lifecycle flows.";
  const perfByName = new Map((perf ?? []).map((p) => [p.flow_name.toLowerCase(), p]));
  const matches = flows.filter((f) => SUBSCRIPTION_FLOW_PATTERNS.some((re) => re.test(f.name)));
  if (!matches.length) return "No obvious subscription lifecycle flow names matched (soft match).";
  const lines = matches.slice(0, 15).map((f) => {
    const p = perfByName.get(f.name.toLowerCase());
    const metric = p?.monthly_revenue_current ? `, revenue: $${Math.round(p.monthly_revenue_current)}` : "";
    return `${f.name} (${f.status}${metric})`;
  });
  return `Soft-matched subscription lifecycle flows: ${lines.join("; ")}`;
}

function pctLabel(part: number, whole: number | null | undefined): string | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || !whole || whole <= 0) return null;
  return `${((part / whole) * 100).toFixed(2)}%`;
}

function buildRevenueContext(klaviyo: KlaviyoContext): Record<string, unknown> | null {
  const rb = klaviyo.revenueBreakdown;
  if (!rb) return null;
  const totalFlowRevenue = (klaviyo.flowPerformance ?? []).reduce(
    (s, f) => s + (Number(f.monthly_revenue_current) || 0),
    0,
  );
  return {
    timeframe: rb.timeframe ?? "last_30_days",
    total_store_revenue: rb.total_store_revenue,
    attributed_revenue: rb.attributed_revenue,
    campaign_revenue: rb.campaign_revenue,
    flow_revenue: rb.flow_revenue,
    email_revenue: rb.email_revenue,
    sms_revenue: rb.sms_revenue,
    total_flow_revenue_sum: totalFlowRevenue,
    total_flow_revenue_pct_of_store: pctLabel(totalFlowRevenue, rb.total_store_revenue),
    total_flow_revenue_pct_of_attributed: pctLabel(totalFlowRevenue, rb.attributed_revenue),
    attributed_pct_of_store: pctLabel(rb.attributed_revenue, rb.total_store_revenue),
  };
}

function buildTopFlowsWithPct(klaviyo: KlaviyoContext) {
  const rb = klaviyo.revenueBreakdown;
  const totalStore = rb?.total_store_revenue ?? null;
  const attributed = rb?.attributed_revenue ?? null;
  return [...(klaviyo.flowPerformance ?? [])]
    .sort((a, b) => (b.monthly_revenue_current ?? 0) - (a.monthly_revenue_current ?? 0))
    .slice(0, 8)
    .map((f) => {
      const revenue = f.monthly_revenue_current ?? 0;
      return {
        name: f.flow_name,
        revenue,
        recipients: f.recipients_per_month ?? 0,
        conv: f.actual_conv_rate ?? 0,
        pct_of_store_revenue: pctLabel(revenue, totalStore),
        pct_of_attributed_revenue: pctLabel(revenue, attributed),
      };
    });
}

function buildScopedKlaviyoData(
  klaviyo: KlaviyoContext,
  requestedKeys: readonly string[],
  benchmarkConfig: BenchmarkConfig = DEFAULT_BENCHMARK_CONFIG,
): Record<string, unknown> {
  const scoped: Record<string, unknown> = { account: klaviyo.account ?? null };
  const needs = new Set(requestedKeys);
  const needsAll = needs.size === 0 || needs.size >= 4;

  if (needsAll || needs.has("flows") || needs.has("account_health")) {
    scoped.flows_summary = summarizeFlows(klaviyo.flows);
    scoped.flow_performance = summarizeFlowPerformance(klaviyo.flowPerformance, benchmarkConfig);
  }
  if (needsAll || needs.has("campaigns") || needs.has("account_health")) {
    scoped.campaigns_summary = summarizeCampaigns(klaviyo.campaigns, klaviyo.campaigns_truncated);
  }
  if (needsAll || needs.has("segmentation") || needs.has("account_health")) {
    scoped.segments_summary = summarizeSegments(klaviyo.segments);
  }
  if (needsAll || needs.has("signup_forms")) {
    scoped.forms_summary = summarizeForms(klaviyo.forms);
  }
  if (needsAll) {
    scoped.lists_summary = summarizeLists(klaviyo.lists);
  }
  const revenueContext = buildRevenueContext(klaviyo);
  if (revenueContext) scoped.revenue_context = revenueContext;
  if (klaviyo.competingSmsScan?.should_inject_finding) {
    scoped.competing_sms_scan = {
      detected: klaviyo.competingSmsScan.detected_platforms.map((p) => p.name),
      klaviyo_sms_active: klaviyo.competingSmsScan.klaviyo_sms_active,
      note:
        "Storefront scan found a non-Klaviyo SMS platform while Klaviyo SMS revenue/subscribers are negligible. Mention fragmented SMS tracking and lost Browse/Cart abandonment attribution in findings if not already covered.",
    };
  }
  return scoped;
}

export function buildAuditUserPrompt(
  data: WizardData,
  klaviyo?: KlaviyoContext,
  mode: PromptMode = "full",
  benchmarkConfig: BenchmarkConfig = DEFAULT_BENCHMARK_CONFIG,
) {
  const requested = Array.isArray(data.requestedSectionKeys) && data.requestedSectionKeys.length > 0
    ? data.requestedSectionKeys
    : AUDIT_SECTION_KEYS;

  let klaviyoSection: Record<string, unknown> | null = null;
  if (klaviyo) {
    if (mode === "top_level_only") {
      const campaignCount = klaviyo.campaigns?.length ?? 0;
      const campaignsCapped = klaviyo.campaigns_truncated || campaignCount > 500;
      klaviyoSection = {
        account: klaviyo.account ?? null,
        flow_count: klaviyo.flows?.length ?? 0,
        campaign_count: campaignsCapped ? "500+" : campaignCount,
        campaigns_truncated: campaignsCapped,
        segment_count: klaviyo.segments?.length ?? 0,
        form_count: klaviyo.forms?.length ?? 0,
        live_form_count: (klaviyo.forms ?? []).filter((f) => /live|published/i.test(f.status ?? "")).length,
        // The findings and timeline need to know which flows exist, not just
        // how many: name, status and monthly revenue, compact.
        flow_inventory: compactFlowInventory(klaviyo),
        revenue_context: buildRevenueContext(klaviyo),
        top_flows: buildTopFlowsWithPct(klaviyo),
        ...(summarizeDeliverability(klaviyo.deliverability) ? { deliverability: summarizeDeliverability(klaviyo.deliverability) } : {}),
      };
    } else {
      klaviyoSection = buildScopedKlaviyoData(klaviyo, requested, benchmarkConfig);
      const deliverability = summarizeDeliverability(klaviyo.deliverability);
      const needs = new Set(requested);
      if (deliverability && (needs.has("account_health") || needs.has("campaigns"))) {
        klaviyoSection.deliverability = deliverability;
      }
    }
  }

  // Audience scale measured by the profile scan. The audit columns are named
  // for the old manual wizard: monthlyTraffic holds email-subscribed profiles
  // and aov holds flow revenue per recipient.
  const audienceScale: Record<string, number> = {};
  if (data.profileAudienceScan !== "skipped") {
    if (Number(data.listSize) > 0) audienceScale.total_profiles = Number(data.listSize);
    if (Number(data.monthlyTraffic) > 0) audienceScale.email_subscribed_profiles = Number(data.monthlyTraffic);
  }
  if (Number(data.aov) > 0) audienceScale.flow_revenue_per_recipient_usd = Number(data.aov);

  const payload: Record<string, unknown> = {
    task:
      mode === "sections_only"
        ? "Generate ONLY the requested audit sections below. Do NOT include executiveSummary, findings, strengths, or implementationTimeline."
        : mode === "top_level_only"
          ? "Generate ONLY top-level fields (executiveSummary, findings, strengths, implementationTimeline). Do NOT include section objects."
          : "Generate a full audit analysis based on the actual Klaviyo account data provided below.",
    client_info: {
      name: data.clientName || data.companyName,
      website: data.websiteUrl || klaviyo?.account?.website_url,
      esp: data.espPlatform || "Klaviyo",
      audit_method: data.auditMethod,
      notes: data.notes || undefined,
      audience_scale: Object.keys(audienceScale).length ? audienceScale : undefined,
    },
    business_model: {
      sells_subscriptions: Boolean(data.clientSellsSubscriptions),
    },
    klaviyo_data: klaviyoSection,
    benchmark_reference: buildBenchmarkReferenceBlock(benchmarkConfig),
    required_sections: mode === "top_level_only" ? [] : requested,
    style: {
      audience: "ecommerce founder/marketing lead",
      tone: "direct, practical, conversational. Write like a senior strategist talking to a peer. No em-dashes, no AI filler words, use contractions.",
      include_benchmarks: true,
    },
    constraints: {
      currency: "USD",
      no_negative_revenue_opportunity: true,
      revenue_realism: "revenue_opportunity is MONTHLY. Total across all 6 sections must NOT exceed 100% of the current monthly flow revenue. Per section: max 35%, or up to 50% if a critical flow is completely missing. Scale proportionally to account size: a $50K/mo account with a missing Welcome Series should show $10-15K opportunity for that section, not $1K. When things look good, use $0-$500. Don't undersell real gaps.",
      analyze_actual_data: "You MUST reference and analyze the actual Klaviyo data above. Do NOT claim data is missing if it is provided.",
      balanced_assessment: "If a section is healthy, say so and give it near-zero opportunity. Not every area needs a big number. Praise what works.",
      ...(data.profileAudienceScan === "skipped"
        ? {
          audience_list_metrics:
            "This run did not include a full Klaviyo profile scan. Do NOT state specific total profile counts, subscribed counts, suppressed counts, or active-profile counts. Infer scale only from flows, campaigns, segments, and performance metrics provided. If asked about list size in narrative, say it was not measured in this pass and point to flow/campaign reach instead.",
        }
        : {}),
      ...(klaviyo?.campaigns_truncated
        ? {
          campaign_total_count:
            "Campaign inventory was partially scanned (500+ email campaigns in account). Do NOT state an exact total campaign count such as 600. Say 500+ or 'hundreds of campaigns' when referencing account scale.",
        }
        : {}),
    },
    section_rubric: {
      flows: data.clientSellsSubscriptions
        ? "Cover Abandoned Cart, Abandoned Checkout, Browse Abandonment, Welcome Series, Post-Purchase, Subscription lifecycle, Winback/Re-engagement, Back-in-Stock (bonus), Sunset/List Cleaning (bonus). For Subscription lifecycle, use soft matching on flow names (subscription/subscr/recharge/skio/loop/renewal/rebill/next order/membership/etc.) and mark present/live accordingly."
        : "Cover Abandoned Cart, Abandoned Checkout, Browse Abandonment, Welcome Series, Post-Purchase, Winback/Re-engagement, Back-in-Stock (bonus), Sunset/List Cleaning (bonus).",
      segmentation: "Assess full-list vs segmented, engaged/unengaged definitions, VIP/high-LTV, and benchmark architecture.",
      campaigns: "Assess frequency consistency, segmented targeting, subject/preview hygiene, and campaign type mix.",
      signup_forms: "Assess popup + embedded presence, offer quality, mobile optimization, benchmark conversion framing.",
    },
  };

  if (data.clientSellsSubscriptions) {
    payload.klaviyo_subscription_flow_hints = summarizeSubscriptionFlowCandidates(
      klaviyo?.flows,
      klaviyo?.flowPerformance,
    );
  }

  const highlighted = Array.isArray(data.highlightedAddOns)
    ? data.highlightedAddOns.filter((a) => a?.template_slug && a?.name)
    : [];
  if (highlighted.length > 0) {
    payload.highlighted_add_ons = highlighted;
    payload.highlighted_add_on_instructions = [
      "The client selected these ECD add-on services to emphasize in this audit.",
      "Weave relevant add-ons into findings and implementationTimeline items where they naturally address a gap (do not force every add-on into every finding).",
      "Return addOnPlacements: for EACH highlighted add-on, pick 1-3 report section_keys where a presenter should demo that service (account_health, flows, segmentation, campaigns, email_design, signup_forms).",
      "Each placement needs a one-line presenter_note (what to show the client, tied to this account's data).",
    ];
    if (mode === "sections_only") {
      payload.highlighted_section_weave_instructions = [
        "Weave the highlighted ECD add-on services into this section's narrative where they naturally address a gap.",
        "Update summary_text, key_findings items, and optimized_notes when relevant — do not force add-ons into every paragraph.",
        "Keep revenue_opportunity realistic; only increase if the add-on directly unlocks measurable upside for this section.",
      ];
    }
  }

  if (mode !== "sections_only") {
    payload.required_top_level_fields = {
      strengths: "Array of 3-6 strings. Each is a specific positive finding with bold lead phrase and supporting data. Reference actual flow names, dollar amounts, percentages WITH benchmark ranges and health assessment. When citing revenue dollars, include pct_of_store_revenue from revenue_context/top_flows. Write naturally, no em-dashes, use commas and plain language.",
      findings: "Array of exactly 5 strings. Each is a problem statement ranked by impact. Bold lead phrase plus evidence. When citing percentages, include benchmark range. No dollar amounts or revenue language.",
      implementationTimeline: "Array of exactly 4 objects with {phase, timeframe, label, items}. Phase 1='Quick Wins' (Week 1-2), Phase 2='Core Flows' (Week 3-6), Phase 3='Strategic' (Month 2-3), Phase 4='Long-Term' (Month 3+). Items must be specific to this account's findings.",
      addOnPlacements: highlighted.length > 0
        ? "Array of { template_slug, section_keys, presenter_note } for each highlighted add-on (see highlighted_add_on_instructions)."
        : "Empty array when no add-ons are highlighted.",
    };
  }
  if (mode === "top_level_only") {
    payload.required_sections = [];
  }

  return JSON.stringify(payload, null, 2);
}

export function buildRepairUserPrompt(params: {
  failedSectionKeys: string[];
  originalInput: WizardData;
  previousOutput: unknown;
}) {
  return JSON.stringify(
    {
      task: "Regenerate only failed sections and keep schema compliance.",
      failed_sections: params.failedSectionKeys,
      original_input: params.originalInput,
      previous_output: params.previousOutput,
      instructions: [
        "Return a full valid object with all required sections.",
        "Prioritize section clarity, concrete opportunities, and valid numeric fields.",
      ],
    },
    null,
    2,
  );
}

const REFINE_MEETING_MAX = 25_000;

export type RefineBaselineSection = {
  section_key: string;
  key_findings?: { items?: string[] };
  ai_findings?: string;
  current_state_notes?: string;
  optimized_notes?: string;
  revenue_opportunity?: number;
};

export type RefineBaseline = {
  companyName?: string;
  clientName?: string;
  executiveSummary: string;
  findings: string[];
  strengths: string[];
  implementationTimeline: Array<{ phase: string; timeframe: string; label: string; items: string[] }>;
  sections: RefineBaselineSection[];
};

export type AuditContextInput = {
  meeting_notes?: string;
  client_background?: string;
  custom_instructions?: string;
  sells_subscriptions?: boolean;
};

export function buildRefineSystemPrompt() {
  return [
    "You are refining an existing Klaviyo audit report for a client using NEW context from sales calls, internal notes, and custom instructions.",
    "The baseline audit was generated from Klaviyo data alone and is technically sound.",
    "Your job: adjust priorities, tone, executive summary, findings, strengths, implementation timeline, and section narratives so they align with the client's stated goals, constraints, and conversation context.",
    "Do NOT invent Klaviyo facts or metrics that are not implied by the baseline. You may reprioritize and rephrase based on client context.",
    "Preserve realistic revenue_opportunity numbers unless context clearly warrants reprioritization. Do not multiply all numbers arbitrarily.",
    "Return only valid JSON matching the full audit schema (all six sections required).",
    `Set schemaVersion to '${AI_SCHEMA_VERSION}'.`,
    "Same writing rules as the main auditor: no em-dashes, client-facing language, no mention of APIs, snapshots, or internal tooling.",
    "Use entity tags for Klaviyo asset names: `flow:Name`, `campaign:Name`, `segment:Name`, `form:Name`. Do not bold entity names.",
  ].join("\n");
}

export function buildRefineUserPrompt(baseline: RefineBaseline, ctx: AuditContextInput) {
  const trim = (s: string | undefined, max: number) => (typeof s === "string" ? s.slice(0, max) : "");
  const safeCtx: AuditContextInput = {
    meeting_notes: trim(ctx.meeting_notes, REFINE_MEETING_MAX),
    client_background: trim(ctx.client_background, 12_000),
    custom_instructions: trim(ctx.custom_instructions, 8_000),
    sells_subscriptions: ctx.sells_subscriptions === true ? true : undefined,
  };
  return JSON.stringify(
    {
      task: "Refine the audit using client context.",
      baseline_audit: baseline,
      client_context: safeCtx,
      instructions: [
        "Return the complete refined audit JSON.",
        "Integrate meeting notes and background into the executive summary and timeline priorities where relevant.",
        "Where context adds nothing for a section, keep baseline substance; you may tighten wording only.",
      ],
    },
    null,
    2,
  );
}
