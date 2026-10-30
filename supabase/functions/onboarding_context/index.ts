// Everything this app knows about a signed proposal's client, for the Client
// Tracker's onboarding to draft the Sales to Delivery doc from: the proposal
// itself, the audit behind it, and any call transcripts or docs pulled into the
// proposal assistant's chat while it was being written.
//
// Called server to server by the tracker (ECD Hub) with the shared onboarding
// key. Deploy with --no-verify-jwt; the key is the gate and it fails closed.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient } from "../_shared/auth.ts";

const DOC_CHAR_CAP = 40_000;
const MAX_DOCS = 6;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sameString(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function text(v: unknown, cap: number): string {
  return typeof v === "string" ? v.trim().slice(0, cap) : "";
}

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!sameString(req.headers.get("x-onboarding-key") ?? "", Deno.env.get("ONBOARDING_SHARED_KEY") ?? "")) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    const { proposal_id } = (await req.json().catch(() => ({}))) as { proposal_id?: string };
    if (!proposal_id) return json({ error: "proposal_id is required" }, 400);
    const sb = assertServiceRoleClient();

    const { data: p, error } = await sb
      .from("proposals")
      .select(
        "id, title, client_id, audit_id, content_blocks, recipient_name, recipient_email, recipient2_name, recipient2_email, " +
          "client_signed_at, created_by, sent_by, discount_type, discount_value, discount_label, " +
          "client:clients(company_name, website_url, industry, esp_platform, notes), " +
          "line_items:proposal_line_items(name, description, content, one_time_price, one_time_label, monthly_price, monthly_label, display_order, optional, client_selected)",
      )
      .eq("id", proposal_id)
      .maybeSingle();
    if (error) throw error;
    if (!p) return json({ error: "not_found" }, 404);
    const proposal = p as any;
    // What the client bought: an optional line they did not add was never sold (2026-10-30).
    proposal.line_items = (proposal.line_items ?? []).filter((li: any) => !li.optional || li.client_selected === true);

    // Who sold it: the sender reviews the draft.
    const staffIds = [proposal.sent_by, proposal.created_by].filter(Boolean);
    const { data: staff } = staffIds.length
      ? await sb.from("profiles").select("id, name, email").in("id", staffIds)
      : { data: [] };
    const person = (id: string | null) => (staff ?? []).find((s: any) => s.id === id) ?? null;

    // The audit this proposal was built from, else the client's latest.
    let auditQuery = sb
      .from("audits")
      .select("id, title, audit_type, executive_summary, total_revenue_opportunity, context, layout, created_at")
      .order("created_at", { ascending: false })
      .limit(1);
    auditQuery = proposal.audit_id ? auditQuery.eq("id", proposal.audit_id) : auditQuery.eq("client_id", proposal.client_id);
    const { data: audits } = await auditQuery;
    const audit = (audits ?? [])[0] as any;
    let sections: unknown[] = [];
    if (audit) {
      const { data: rows } = await sb
        .from("audit_sections")
        .select("section_key, summary_text, revenue_opportunity")
        .eq("audit_id", audit.id);
      sections = (rows ?? []).map((s: any) => ({
        section: s.section_key,
        summary: text(s.summary_text, 1200),
        revenue_opportunity: s.revenue_opportunity ?? null,
      }));
    }
    const addOns = Array.isArray(audit?.layout?.revenue_summary?.blocks?.addOns?.items)
      ? audit.layout.revenue_summary.blocks.addOns.items
        .filter((a: any) => a && !a.is_hidden)
        .map((a: any) => ({ name: a.name, description: text(a.description, 400) }))
      : [];

    // The client's other signed proposals: already sold, so never an upsell.
    // Lane 201 signed an Alia build the day after its SMS migration, and the
    // first preview recommended Alia because it only saw the migration.
    const { data: otherRows } = await sb
      .from("proposals")
      .select("id, title, client_signed_at, line_items:proposal_line_items(name, one_time_price, monthly_price, optional, client_selected)")
      .eq("client_id", proposal.client_id)
      .not("client_signed_at", "is", null)
      .neq("id", proposal.id)
      .order("client_signed_at", { ascending: false })
      .limit(10);
    const otherSigned = (otherRows ?? []).map((o: any) => ({
      title: o.title,
      signed_at: o.client_signed_at,
      line_items: (o.line_items ?? []).filter((li: any) => !li.optional || li.client_selected === true).map((li: any) => ({
        name: li.name,
        one_time_price: li.one_time_price,
        monthly_price: li.monthly_price,
      })),
    }));

    // Transcripts and docs fetched into the assistant's chat for this proposal
    // or this client.
    const { data: convs } = await sb
      .from("proposal_agent_conversations")
      .select("id")
      .or(`proposal_id.eq.${proposal.id},client_id.eq.${proposal.client_id}`);
    const convIds = (convs ?? []).map((c: any) => c.id);
    let documents: unknown[] = [];
    if (convIds.length) {
      const { data: msgs } = await sb
        .from("proposal_agent_messages")
        .select("payload, created_at")
        .in("conversation_id", convIds)
        .eq("payload_kind", "doc_fetch")
        .order("created_at", { ascending: false })
        .limit(20);
      const seen = new Set<string>();
      documents = (msgs ?? [])
        .map((m: any) => m.payload)
        .filter((d: any) => d?.ok && typeof d.content === "string" && d.content.trim())
        .filter((d: any) => {
          const key = d.transcript_id ?? d.doc_id ?? d.title ?? d.content.slice(0, 80);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, MAX_DOCS)
        .map((d: any) => ({
          kind: d.transcript_id ? "call_transcript" : "document",
          title: d.title ?? null,
          fireflies_id: d.transcript_id ?? null,
          content: d.content.slice(0, DOC_CHAR_CAP),
        }));
    }

    return json({
      ok: true,
      proposal: {
        title: proposal.title,
        signed_at: proposal.client_signed_at,
        recipients: [
          { name: proposal.recipient_name, email: proposal.recipient_email },
          ...(proposal.recipient2_email ? [{ name: proposal.recipient2_name, email: proposal.recipient2_email }] : []),
        ],
        sold_by: person(proposal.sent_by) ?? person(proposal.created_by),
        sections: (Array.isArray(proposal.content_blocks) ? proposal.content_blocks : []).map((b: any) => ({
          title: b?.title ?? "",
          content: text(b?.content, 4000),
        })),
        line_items: (proposal.line_items ?? [])
          .sort((a: any, b: any) => (a.display_order ?? 0) - (b.display_order ?? 0))
          .map((li: any) => ({
            name: li.name,
            description: text(li.description, 600),
            content: text(li.content, 2500),
            one_time_price: li.one_time_price,
            one_time_label: li.one_time_label,
            monthly_price: li.monthly_price,
            monthly_label: li.monthly_label,
          })),
        discount: proposal.discount_type && proposal.discount_type !== "none"
          ? { type: proposal.discount_type, value: proposal.discount_value, label: proposal.discount_label }
          : null,
      },
      other_signed_proposals: otherSigned,
      client: {
        company_name: proposal.client?.company_name ?? null,
        website: proposal.client?.website_url ?? null,
        industry: proposal.client?.industry ?? null,
        esp_platform: proposal.client?.esp_platform ?? null,
        notes: text(proposal.client?.notes, 2000),
      },
      audit: audit
        ? {
          title: audit.title,
          type: audit.audit_type,
          created_at: audit.created_at,
          executive_summary: text(audit.executive_summary, 5000),
          total_revenue_opportunity: audit.total_revenue_opportunity ?? null,
          client_background: text(audit.context?.client_background, 4000),
          meeting_notes: text(audit.context?.meeting_notes, 8000),
          sections,
          recommended_add_ons: addOns,
        }
        : null,
      documents,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
