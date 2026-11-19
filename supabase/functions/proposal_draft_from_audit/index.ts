// Writes the narrative of a proposal from the audit it came out of.
//
// A proposal used to inherit whichever template sorted first, which is how a
// website audit produced an SMS migration scope of work. Dropping the template
// fixed the wrongness but left the proposal with no scope at all, so this writes
// one from the audit's own findings and the line items already priced on it.
//
// Anything the audit does not settle comes back as a question rather than an
// invention: a proposal that guesses at scope is worse than one that asks.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createLlmClient, type LlmMessage, type LlmTool } from "../_shared/llm-adapter.ts";
import { readKnowledge } from "../_shared/proposal-knowledge.ts";
import { isServiceRoleAuthorization, requireStaffUserId } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MODEL = "claude-sonnet-5-5";

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, accept",
  "access-control-allow-methods": "POST, OPTIONS",
};

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...corsHeaders, ...(init?.headers ?? {}) },
  });

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Service role not configured");
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const DRAFT_TOOL: LlmTool = {
  name: "record_proposal_draft",
  description:
    "Write the narrative sections of a proposal built from an audit, and list anything you could not settle from the audit alone.",
  input_schema: {
    type: "object",
    required: ["blocks", "questions"],
    properties: {
      blocks: {
        type: "array",
        minItems: 3,
        maxItems: 5,
        description:
          "The narrative sections, in reading order. Titles must be exactly: What We Will Do, then What Is Included, then What Is Not Included, then optionally Timeline.",
        items: {
          type: "object",
          required: ["title", "content"],
          properties: {
            title: { type: "string" },
            content: {
              type: "string",
              description:
                "Markdown. Use - for bullets and **bold** for emphasis. Never write a markdown link; write a bare URL if a link is needed.",
            },
          },
        },
      },
      questions: {
        type: "array",
        maxItems: 6,
        description:
          "Things a strategist must confirm before this goes to the client: anything about scope, access, dependencies or pricing that the audit does not answer. Empty when the audit genuinely settles everything.",
        items: { type: "string" },
      },
    },
  },
};

const SYSTEM = `You write proposals for ECD Digital Strategy, an ecommerce growth agency.

You are given an audit and the line items already priced on the proposal. Write the
narrative that surrounds those line items.

Hard rules:
- The scope is the line items. Never propose work that is not among them, and never
  quote a price: the proposal renders its own pricing table underneath your text.
- Ground every claim in the audit. If the audit does not say it, either leave it out
  or raise it as a question.
- "What Is Not Included" is the most valuable section and the one people skip. Name
  the things a client will assume are included and are not: work the audit found but
  the line items do not cover, third-party costs, content or asset creation, platform
  or app subscriptions, anything needing their developer.
- Write in plain British-influenced business English, second person, no hype, no
  filler, no em dashes. Short paragraphs and bullets over walls of text.
- Never invent a timeline you cannot support. Only include a Timeline section if the
  line items imply a sensible sequence, and describe it in relative terms.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const correlationId = crypto.randomUUID();

  try {
    const body = (await req.json()) as { audit_id?: string; proposal_id?: string; provider?: string };
    const auditId = (body.audit_id ?? "").trim();
    const proposalId = (body.proposal_id ?? "").trim();
    if (!auditId || !proposalId) {
      return json({ ok: false, error: "Missing audit_id or proposal_id", correlationId }, { status: 400 });
    }

    // Service role, or a staff member with the Proposals area. This used to
    // swallow the failure and carry on with uid = null, which meant there was no
    // check at all: the gateway only asks that SOME valid JWT is present, and
    // the anon key that satisfies it ships in the frontend bundle. So anyone
    // could read an audit and start a proposal draft from it.
    let uid: string | null = null;
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!isServiceRoleAuthorization(bearer)) {
      try {
        uid = await requireStaffUserId(req, "proposals");
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unauthorized";
        return json({ ok: false, error: message, correlationId }, { status: message === "Forbidden" ? 403 : 401 });
      }
    }

    const sb = serviceClient();

    const [auditRes, proposalRes, sectionsRes, itemsRes] = await Promise.all([
      sb.from("audits").select("id, title, audit_type, client_id, context").eq("id", auditId).maybeSingle(),
      sb.from("proposals").select("id, content_blocks").eq("id", proposalId).maybeSingle(),
      sb.from("audit_sections").select("section_key, summary_text, section_details").eq("audit_id", auditId),
      sb.from("proposal_line_items")
        .select("name, description, one_time_price, one_time_label, monthly_price, monthly_label, display_order")
        .eq("proposal_id", proposalId)
        .order("display_order", { ascending: true }),
    ]);

    const audit = auditRes.data;
    const proposal = proposalRes.data;
    if (!audit || !proposal) return json({ ok: false, error: "not_found", correlationId }, { status: 404 });

    const client = audit.client_id
      ? (await sb.from("clients").select("company_name, website_url").eq("id", audit.client_id).maybeSingle()).data
      : null;

    const lineItems = itemsRes.data ?? [];
    if (lineItems.length === 0) {
      return json({ ok: true, skipped: "no_line_items", correlationId });
    }

    // What the audit actually found, compact enough to read in one prompt. Only
    // the parts that bear on scope: findings, the roadmap, and the intro copy.
    const sections = (sectionsRes.data ?? []) as Array<{
      section_key: string;
      summary_text: string | null;
      section_details: Record<string, unknown> | null;
    }>;

    const findingLines: string[] = [];
    const roadmapLines: string[] = [];
    for (const s of sections) {
      const details = (s.section_details ?? {}) as Record<string, unknown>;
      const web = (details.web ?? null) as { findings?: Array<{ text?: string; recommendation?: string; hidden?: boolean }> } | null;
      for (const f of web?.findings ?? []) {
        if (f.hidden) continue;
        findingLines.push(`- [${s.section_key}] ${f.text ?? ""}${f.recommendation ? ` (fix: ${f.recommendation})` : ""}`);
      }
      const roadmap = (details.web_roadmap ?? null) as { rows?: Array<Record<string, unknown>> } | null;
      for (const r of roadmap?.rows ?? []) {
        if (r.hidden === true) continue;
        roadmapLines.push(`- [${String(r.priority ?? "")}] ${String(r.item_name ?? "")}${r.note ? `: ${String(r.note)}` : ""}`);
      }
      // Klaviyo audits carry their narrative in summary_text per section.
      if (audit.audit_type !== "web" && s.summary_text) {
        findingLines.push(`- [${s.section_key}] ${s.summary_text}`);
      }
    }

    const itemLines = lineItems.map((i) => {
      const price = i.one_time_price != null
        ? "one-time"
        : i.monthly_price != null
          ? "monthly"
          : (i.one_time_label || i.monthly_label || "unpriced");
      return `- ${i.name} (${price})${i.description ? `: ${i.description}` : ""}`;
    });

    const context = typeof audit.context === "string" && audit.context.trim()
      ? `\n\nWHAT THE STRATEGIST TOLD US ABOUT THIS CLIENT:\n${audit.context.trim().slice(0, 2000)}`
      : "";

    const kind = audit.audit_type === "web" ? "website audit" : "Klaviyo lifecycle audit";
    const messages: LlmMessage[] = [{
      role: "user",
      text: [
        `Write the proposal narrative for ${client?.company_name ?? "this client"}, off the back of a ${kind}.`,
        `THE WORK BEING PROPOSED (this is the scope, and the proposal prices it separately):\n${itemLines.join("\n")}`,
        roadmapLines.length ? `THE AUDIT ROADMAP:\n${roadmapLines.slice(0, 25).join("\n")}` : "",
        findingLines.length ? `WHAT THE AUDIT FOUND:\n${findingLines.slice(0, 40).join("\n")}` : "",
        `Call record_proposal_draft exactly once.`,
      ].filter(Boolean).join("\n\n") + context,
    }];

    // Agency Knowledge (Proposal settings): e.g. the current email warmup rules (2026-11-19).
    const knowledge = await readKnowledge(sb).catch(() => "");
    const llm = createLlmClient((body.provider as never) ?? "anthropic", { model: MODEL });
    const turn = await llm.runTurn({
      system: knowledge ? `${SYSTEM}

${knowledge}` : SYSTEM,
      messages,
      tools: [DRAFT_TOOL],
      toolChoice: { type: "tool", name: "record_proposal_draft" },
    });
    if (turn.kind !== "tool_call") {
      return json({ ok: false, error: "model_did_not_call_tool", correlationId }, { status: 200 });
    }

    const input = (turn.input ?? {}) as { blocks?: Array<{ title?: string; content?: string }>; questions?: unknown[] };
    const drafted = (input.blocks ?? [])
      .map((b, i) => ({
        key: `ai_${i + 1}_${String(b.title ?? "section").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24)}`,
        title: String(b.title ?? "").trim(),
        content: String(b.content ?? "").trim(),
      }))
      .filter((b) => b.title && b.content);

    if (drafted.length === 0) {
      return json({ ok: false, error: "model_returned_no_blocks", correlationId }, { status: 200 });
    }

    // Slot the drafted sections between the intro and whatever closes the
    // proposal, so the audit link and the terms stay where they were put.
    const existing = (proposal.content_blocks ?? []) as Array<{ key: string; title: string; content: string }>;
    const tailKeys = new Set(["terms", "audit_report_link"]);
    const head = existing.filter((b) => !tailKeys.has(b.key));
    const tail = existing.filter((b) => tailKeys.has(b.key));
    const next = [...head, ...drafted, ...tail];

    const { error: updErr } = await sb
      .from("proposals")
      .update({ content_blocks: next, updated_at: new Date().toISOString() })
      .eq("id", proposalId);
    if (updErr) throw updErr;

    // Questions land in the proposal's assistant thread, so they are waiting in
    // the place the answers would be given rather than in a toast that vanishes.
    const questions = (input.questions ?? [])
      .map((q) => String(q ?? "").trim())
      .filter(Boolean)
      .slice(0, 6);

    if (questions.length > 0) {
      const { data: convo } = await sb
        .from("proposal_agent_conversations")
        .insert({
          proposal_id: proposalId,
          client_id: audit.client_id ?? null,
          title: "Drafted from the audit",
          created_by: uid,
        })
        .select("id")
        .single();
      if (convo?.id) {
        await sb.from("proposal_agent_messages").insert({
          conversation_id: convo.id,
          role: "assistant",
          content: [
            `I drafted this proposal from the ${kind}. Before it goes out, these are the things the audit did not settle:`,
            ...questions.map((q, i) => `${i + 1}. ${q}`),
            "",
            "Answer any of them here and I will fold it into the wording.",
          ].join("\n"),
        });
      }
    }

    return json({
      ok: true,
      blocks_written: drafted.length,
      block_titles: drafted.map((b) => b.title),
      questions,
      correlationId,
    });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e), correlationId }, { status: 500 });
  }
});
