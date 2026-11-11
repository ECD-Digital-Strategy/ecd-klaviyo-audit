import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient } from "../_shared/auth.ts";
import { requireOutreachOwnerOrServer } from "../_shared/outreach-access.ts";
import { createLlmClient } from "../_shared/llm-adapter.ts";
import { TEASER_PAGE_KEYS, teaserFindings, teaserLockedTotal, type TeaserFinding } from "../_shared/outreach-teaser.ts";

// Outreach, step 1 (Emil, 2026-11-01): draft the cold email for a prospect whose
// outside-only web audit has finished. Emil reads, edits and sends it himself for
// now. The email opens on one concrete finding from THEIR site, picked from the
// findings the public teaser actually shows, and links that teaser. Short, plain
// text, from Emil, no agency boilerplate.

const REPORT_BASE = "https://audit.ecdigitalstrategy.com/report/";
const LINK = "{{REPORT_LINK}}";

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

const PAGE_LABEL: Record<string, string> = {
  web_homepage: "homepage",
  web_product_page: "product page",
  web_collection_page: "collection page",
  web_cart: "cart",
};
const RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
/** Statuses that may get a (new) draft: not yet emailed and not excluded. */
const DRAFTABLE = ["new", "auditing", "ready", "approved", "failed"];

const SYSTEM = `You write short cold emails for Emil Gorgijev at ECD Digital Strategy, an ecommerce agency that works with Shopify brands on their website, email and SMS. We ran a free audit of the prospect's storefront and published a short preview of it. Write the first email.

Rules:
- From Emil, first person ("I"), to a busy founder or marketing lead. Warm, direct, confident, never salesy or flattering.
- 70 to 110 words in the body. Plain text: no markdown, no bullet points, no emojis, no bold.
- Open with ONE concrete finding about their site, in plain words, using the finding given (the page it is on and what it costs them). No "I hope you're well", no "I came across your brand".
- Then one sentence on what the preview is: we looked at their key pages on desktop and mobile; the link shows the biggest issues on each page, and there is more.
- Put the link on its own line, exactly as the token ${LINK}. Do not write any other URL.
- Close with one low-pressure question asking if they'd like a short call to go through the rest. No "Best regards" style sign-off beyond the given signature.
- Never invent numbers, revenue, conversion rates, clients or results. Only use what the finding says.
- No em dashes or en dashes anywhere. Use commas or full stops.
- Subject: 3 to 6 words, lowercase except names, specific to them (e.g. "your mobile product page"). No clickbait, no "quick question".
- End the body with exactly:
Emil
ECD Digital Strategy`;

// Event and webinar guests (2026-11-11): they came to one of ECD's events, so the email opens with that instead of
// a cold hook. Never claim Emil met them: Zak or the team ran the events, Emil did not.
const EVENT_RULES = `
This person is not cold: they came to one of ECD's events (details below). Open with that, briefly and naturally, then the finding.
- A webinar: say they signed up for our webinar (never claim they attended or asked anything).
- An in-person event or party: say you saw they were at it. Never say you or Emil met them, talked to them or were there.
- If the event was more than 3 months ago, say when (e.g. "back in March"), never pretend it was recent.`;

const SYSTEM_DISCOVERY = `You write short follow-up emails for Emil Gorgijev at ECD Digital Strategy, an ecommerce agency that works with Shopify and other online brands on email and SMS (Klaviyo), their website, and paid ads. The recipient came to one of ECD's events or webinars (details below). There is no audit and no link: the point is to ask where they need the most help.

Rules:
- From Emil, first person ("I"), to a busy founder or marketing lead. Warm, direct, human, never salesy or flattering.
- 50 to 90 words in the body. Plain text: no markdown, no bullet points, no emojis, no bold.
- Open with the event, briefly and naturally:
  - a webinar: they signed up for our webinar (never claim they attended or asked anything);
  - an in-person event or party: you saw they were at it. Never say you or Emil met them, talked to them or were there;
  - more than 3 months ago: say when (e.g. "back in March"), never pretend it was recent.
- One sentence on what ECD does, in plain words, without claims, numbers, client names or results.
- The heart of the email is one easy question: where do they need the most help right now, for example email and SMS, the website, or paid ads. Make it easy to answer in one line.
- Offer a short call only as an option, no pressure. Do not write any URL.
- No em dashes or en dashes anywhere. Use commas or full stops.
- Subject: 3 to 6 words, lowercase except names, about the event or them (e.g. "after the postpilot webinar"). No clickbait, no "quick question".
- End the body with exactly:
Emil
ECD Digital Strategy`;

type ProspectRow = Record<string, unknown> & {
  domain: string;
  store_name: string | null;
  contact_name: string | null;
  source?: string | null;
  event_name?: string | null;
  event_kind?: string | null;
  event_date?: string | null;
};

function eventFacts(p: ProspectRow): string {
  if (p.source !== "event" || !p.event_name) return "";
  const when = p.event_date ? new Date(`${p.event_date}T12:00:00Z`) : null;
  const months = when ? Math.floor((Date.now() - when.getTime()) / (30.4 * 86_400_000)) : null;
  return [
    `Event: ${p.event_name}`,
    `Kind: ${p.event_kind === "webinar" ? "a webinar" : "an in-person event"}`,
    when ? `When: ${when.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })} (${months === 0 ? "this month" : `about ${months} month${months === 1 ? "" : "s"} ago`})` : "",
  ].filter(Boolean).join("\n");
}

const tidyText = (s: string) => s.replace(/\s*[–—]\s*/g, ", ").trim();

async function writeEmail(system: string, facts: string): Promise<{ subject: string; body: string } | null> {
  const llm = createLlmClient("anthropic", { model: "claude-sonnet-5-5" });
  const turn = await llm.runTurn({
    system,
    messages: [{ role: "user", text: `${facts}\n\nWrite the email.` }],
    tools: [{
      name: "email",
      description: "The finished email.",
      input_schema: {
        type: "object",
        properties: { subject: { type: "string" }, body: { type: "string" } },
        required: ["subject", "body"],
      },
    }],
    toolChoice: { type: "tool", name: "email" },
  });
  if (turn.kind !== "tool_call") return null;
  const input = turn.input as { subject?: string; body?: string };
  const subject = tidyText(String(input.subject ?? "")).slice(0, 120);
  const body = tidyText(String(input.body ?? ""));
  return subject && body ? { subject, body } : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  try {
    await requireOutreachOwnerOrServer(req);
  } catch {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const { prospect_id } = (await req.json().catch(() => ({}))) as { prospect_id?: string };
  if (!prospect_id) return json({ ok: false, error: "missing_prospect" }, 400);

  const sb = assertServiceRoleClient();
  const { data: prospect } = await sb.from("outreach_prospects").select("*").eq("id", prospect_id).maybeSingle();
  if (!prospect) return json({ ok: false, error: "not_found" }, 404);
  // Only before the first email: a sent (or replied, stopped) prospect keeps the
  // email it got, and never goes back to Ready (audit 2026-11-10).
  if (prospect.sent_at || !DRAFTABLE.includes(String(prospect.status))) {
    return json({ ok: false, error: "already_sent", message: "This prospect was already emailed or excluded, so the email can't be redrafted." }, 409);
  }

  // An event guest on the discovery email: no audit, just "where do you need the most help?".
  if (prospect.approach === "discovery") {
    const p = prospect as ProspectRow;
    const facts = [
      `Brand: ${p.store_name || p.domain} (${p.domain})`,
      p.contact_name ? `Recipient's first name: ${String(p.contact_name).split(" ")[0]}` : "Recipient's name is unknown: open with \"Hi there,\", never a guessed name.",
      eventFacts(p),
    ].filter(Boolean).join("\n");
    const email = await writeEmail(SYSTEM_DISCOVERY, facts);
    if (!email) return json({ ok: false, error: "draft_failed" }, 502);
    const { data: saved } = await sb
      .from("outreach_prospects")
      .update({ email_subject: email.subject, email_body: email.body, status: "ready" })
      .eq("id", prospect_id)
      .is("sent_at", null)
      .in("status", DRAFTABLE)
      .select("id");
    if (!saved?.length) {
      return json({ ok: false, error: "already_sent", message: "This prospect was emailed while the draft was being written, so it was not changed." }, 409);
    }
    return json({ ok: true, ...email });
  }

  if (!prospect.audit_id) return json({ ok: false, error: "no_audit" }, 409);

  const { data: audit } = await sb.from("audits").select("id, status, public_share_token, client_id").eq("id", prospect.audit_id).maybeSingle();
  if (!audit || audit.status !== "published" || !audit.public_share_token) {
    return json({ ok: false, error: "audit_not_ready", message: "The audit has not finished yet." }, 409);
  }
  const [{ data: sections }, { data: client }] = await Promise.all([
    sb.from("audit_sections").select("section_key, section_details").eq("audit_id", audit.id),
    sb.from("clients").select("company_name").eq("id", audit.client_id).maybeSingle(),
  ]);

  // The strongest finding the teaser shows, homepage first on a tie.
  const shown: Array<{ page: string; f: TeaserFinding }> = [];
  for (const key of TEASER_PAGE_KEYS) {
    const s = (sections ?? []).find((x) => x.section_key === key);
    const findings = ((s?.section_details as { web?: { findings?: TeaserFinding[] } } | null)?.web?.findings) ?? [];
    for (const f of teaserFindings(findings).kept) shown.push({ page: PAGE_LABEL[key], f });
  }
  if (shown.length === 0) return json({ ok: false, error: "no_findings", message: "The audit found nothing to show." }, 409);
  const hook = [...shown].sort((a, b) => (RANK[String(a.f.priority)] ?? 1) - (RANK[String(b.f.priority)] ?? 1))[0];
  const more = teaserLockedTotal(sections ?? []);

  const brand = (prospect.store_name || client?.company_name || prospect.domain) as string;
  const facts = [
    `Brand: ${brand} (${prospect.domain})`,
    prospect.contact_name ? `Recipient's first name: ${String(prospect.contact_name).split(" ")[0]}` : "Recipient's name is unknown: open with \"Hi there,\" or the brand name, never a guessed name.",
    `Finding to open with, on their ${hook.page}${hook.f.viewport && hook.f.viewport !== "both" ? ` (${hook.f.viewport})` : ""}:`,
    `  Title: ${hook.f.title ?? ""}`,
    `  What we saw: ${hook.f.text ?? ""}`,
    `  What we'd change: ${hook.f.recommendation ?? ""}`,
    `Other pages in the preview: ${[...new Set(shown.map((s) => s.page))].join(", ")}.`,
    more > 0 ? `Further findings not shown in the preview: ${more}.` : "",
    eventFacts(prospect as ProspectRow),
  ].filter(Boolean).join("\n");

  const llm = createLlmClient("anthropic", { model: "claude-sonnet-5-5" });
  const turn = await llm.runTurn({
    system: prospect.source === "event" ? `${SYSTEM}\n${EVENT_RULES}` : SYSTEM,
    messages: [{ role: "user", text: `${facts}\n\nWrite the email.` }],
    tools: [{
      name: "email",
      description: "The finished email.",
      input_schema: {
        type: "object",
        properties: {
          subject: { type: "string" },
          body: { type: "string", description: `Plain text, with ${LINK} on its own line.` },
        },
        required: ["subject", "body"],
      },
    }],
    toolChoice: { type: "tool", name: "email" },
  });
  if (turn.kind !== "tool_call") return json({ ok: false, error: "draft_failed" }, 502);
  const input = turn.input as { subject?: string; body?: string };
  const link = `${REPORT_BASE}${audit.public_share_token}`;
  // Dashes out, in case the model slipped; the real link in, exactly once.
  const tidy = (s: string) => s.replace(/\s*[–—]\s*/g, ", ").trim();
  let body = tidy(String(input.body ?? ""));
  body = body.includes(LINK) ? body.replace(LINK, link).replaceAll(LINK, "") : `${body}\n\n${link}`;
  const subject = tidy(String(input.subject ?? "")).slice(0, 120);
  if (!subject || !body) return json({ ok: false, error: "draft_failed" }, 502);

  // Guarded again here: a send may have started while the model was writing. An
  // approved one goes back to Ready, since Emil approves every first email as written.
  const { data: saved } = await sb
    .from("outreach_prospects")
    .update({ email_subject: subject, email_body: body, status: "ready" })
    .eq("id", prospect_id)
    .is("sent_at", null)
    .in("status", DRAFTABLE)
    .select("id");
  if (!saved?.length) {
    return json({ ok: false, error: "already_sent", message: "This prospect was emailed while the draft was being written, so it was not changed." }, 409);
  }
  return json({ ok: true, subject, body });
});
