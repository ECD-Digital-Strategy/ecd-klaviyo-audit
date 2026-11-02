// Public audit report fetch by share token. Deployed with --no-verify-jwt:
// anonymous clients call this with only the anon apikey. All data access uses
// the service role after validating the token server-side (the audits table
// and its report-related child tables no longer have anon RLS policies for
// this path -- the previous "public can read published audits by share
// token" policies only checked that a token existed, not that it matched the
// caller's, which made every published report enumerable via a plain anon
// query). This function returns the same raw row shapes the frontend used to
// fetch directly so the existing client-side enrichment logic (revenue
// opportunity computation, account snapshot extraction, etc.) keeps working
// unchanged.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { teaserLockedTotal, teaserSections } from "../_shared/outreach-teaser.ts";
import { assertServiceRoleClient } from "../_shared/auth.ts";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type, accept, origin, referer, user-agent",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
    ...init,
  });
}

const FLOW_SNAPSHOT_SELECT =
  "id, audit_id, client_id, flow_id, name, status, trigger_type, archived, created_at_klaviyo, updated_at_klaviyo, fetched_at, action_count:raw->attributes->action_count, flow_actions:raw->relationships->flow_actions->data";
// Mirror of the same-named constants in src/lib/db.ts: project only the JSON paths the
// report UI actually reads out of `raw` (segment definitions, campaign audience refs)
// instead of the full blob. The frontend (fetchPublicAuditReportBundle) reassembles these
// narrow fields back into a `raw`-shaped object, so keep the field names (_definition,
// _audiences, etc.) in sync with db.ts.
//
// `_ecd_group_names`/`_ecd_metric_names` are account-wide lookup maps that get duplicated
// identically onto every single row's `raw` by the Klaviyo fetch -- selecting them per-row
// multiplied a ~40KB/~9KB map by hundreds of rows (tens of MB), which was the actual cause
// of WORKER_RESOURCE_LIMIT, dwarfing everything else in the payload. They're fetched once
// below via a single limit(1) row each and returned as top-level `groupNames`/`metricNames`
// instead.
const SEGMENT_SNAPSHOT_SELECT =
  "id, audit_id, client_id, segment_id, name, created_at_klaviyo, updated_at_klaviyo, fetched_at, is_hidden, display_name, display_notes, display_order, _definition:raw->attributes->definition, _definition_legacy:raw->definition";
const FORM_SNAPSHOT_SELECT =
  "id, audit_id, client_id, form_id, name, status, ab_test, created_at_klaviyo, updated_at_klaviyo, fetched_at, is_hidden, display_name, display_notes, display_order";
const CAMPAIGN_SNAPSHOT_SELECT =
  "id, audit_id, client_id, campaign_id, name, status, send_channel, created_at_klaviyo, updated_at_klaviyo, fetched_at, is_hidden, display_name, display_notes, display_order, _audiences:raw->attributes->audiences";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: { code: "method_not_allowed" } }, { status: 405 });

  const correlationId = crypto.randomUUID();
  try {
    const { token } = (await req.json().catch(() => ({}))) as { token?: string };
    const cleanToken = (token ?? "").trim();
    if (!cleanToken) {
      return json({ ok: false, error: { code: "bad_request", message: "Missing token" }, correlationId }, { status: 400 });
    }

    const sb = assertServiceRoleClient();

    // Token match + published status enforced here, server-side, with no
    // dependence on RLS -- this is the actual security boundary.
    const { data: audit, error: auditErr } = await sb
      .from("audits")
      .select("*")
      .eq("public_share_token", cleanToken)
      .eq("status", "published")
      .maybeSingle();
    if (auditErr) throw auditErr;
    if (!audit) {
      return json({ ok: false, error: { code: "not_found" }, correlationId }, { status: 404 });
    }

    // Redact the internal-only fields before anything is returned. This is a
    // public link: `audits.context` is the strategist's private brief (meeting
    // notes, client background, custom instructions) and `clients.notes` is
    // internal, and the report renders neither. `select("*")` was handing both
    // to whoever holds the share link. Redact in place so the same raw row
    // shapes the frontend enrichment expects still arrive, minus these keys.
    const redactAudit = (row: Record<string, unknown> | null) => {
      if (row) {
        delete (row as Record<string, unknown>).context;
      }
      return row;
    };
    const redactClient = (row: Record<string, unknown> | null) => {
      if (row) {
        delete (row as Record<string, unknown>).notes;
      }
      return row;
    };
    redactAudit(audit as Record<string, unknown>);

    // Web audits carry a much lighter payload — skip the Klaviyo child selects.
    if ((audit as { audit_type?: string }).audit_type === "web") {
      const [webClient, webSections, pageSnaps, shopifySnaps] = await Promise.all([
        sb.from("clients").select("*").eq("id", audit.client_id).maybeSingle(),
        sb.from("audit_sections").select("*").eq("audit_id", audit.id),
        sb.from("web_page_snapshots").select("*").eq("audit_id", audit.id).order("page_type").order("viewport"),
        // Newest first. Every refetch inserts another row, so without an order
        // the public link served an arbitrary one: Pipeliner's Cloud showed a
        // client $407,324 of a 7-day window days after the real 30-day figure of
        // $1.9M had been fetched.
        sb.from("shopify_data_snapshots").select("id, audit_id, client_id, snapshot_kind, timeframe_key, computed, fetched_at").eq("audit_id", audit.id).order("fetched_at", { ascending: false }),
      ]);
      if (webClient.error) throw webClient.error;
      if (webSections.error) throw webSections.error;
      if (pageSnaps.error) throw pageSnaps.error;
      if (shopifySnaps.error) throw shopifySnaps.error;
      if (!webClient.data) {
        return json({ ok: false, error: { code: "not_found" }, correlationId }, { status: 404 });
      }
      const isOutreach = (audit as { is_outreach?: boolean }).is_outreach === true;
      // Where the teaser's "Book a walkthrough" leads: Emil's booking link once he has set one.
      const bookingUrl = isOutreach
        ? ((await sb.from("outreach_settings").select("booking_url").eq("id", "default").maybeSingle()).data?.booking_url ?? null)
        : null;
      return json({
        ok: true,
        audit,
        client: redactClient(webClient.data as Record<string, unknown>),
        // Outreach audits (Emil, 2026-11-01) are a teaser: the strongest finding per page
        // and screen size, the rest only counted, and no roadmap, pricing or sales data.
        sections: isOutreach ? teaserSections(webSections.data ?? []) : webSections.data ?? [],
        teaser: isOutreach ? { locked_total: teaserLockedTotal(webSections.data ?? []), booking_url: bookingUrl } : null,
        webPageSnapshots: pageSnaps.data ?? [],
        shopifySnapshots: isOutreach ? [] : shopifySnaps.data ?? [],
        correlationId,
      });
    }

    const [client, sections, assets, flows, flowSnaps, segSnaps, formSnaps, campSnaps, rollups, emailDesignRes, segNamesRow, campNamesRow] =
      await Promise.all([
        sb.from("clients").select("*").eq("id", audit.client_id).maybeSingle(),
        sb.from("audit_sections").select("*, annotations(*)").eq("audit_id", audit.id),
        sb.from("audit_assets").select("*").eq("audit_id", audit.id),
        sb.from("flow_performance").select("*").eq("audit_id", audit.id),
        sb.from("klaviyo_flow_snapshots").select(FLOW_SNAPSHOT_SELECT).eq("audit_id", audit.id),
        sb.from("klaviyo_segment_snapshots").select(SEGMENT_SNAPSHOT_SELECT).eq("audit_id", audit.id),
        sb.from("klaviyo_form_snapshots").select(FORM_SNAPSHOT_SELECT).eq("audit_id", audit.id),
        sb.from("klaviyo_campaign_snapshots").select(CAMPAIGN_SNAPSHOT_SELECT).eq("audit_id", audit.id),
        sb.from("klaviyo_reporting_rollups").select("timeframe_key, computed, campaigns").eq("audit_id", audit.id),
        sb.from("audit_email_design").select("*, ecd_example:industry_email_library(*)").eq("audit_id", audit.id).maybeSingle(),
        sb.from("klaviyo_segment_snapshots")
          .select("_ecd_group_names:raw->_ecd_group_names, _ecd_metric_names:raw->_ecd_metric_names")
          .eq("audit_id", audit.id)
          .limit(1)
          .maybeSingle(),
        sb.from("klaviyo_campaign_snapshots")
          .select("_ecd_group_names:raw->_ecd_group_names")
          .eq("audit_id", audit.id)
          .limit(1)
          .maybeSingle(),
      ]);

    if (client.error) throw client.error;
    if (sections.error) throw sections.error;
    if (assets.error) throw assets.error;
    if (flows.error) throw flows.error;
    if (flowSnaps.error) throw flowSnaps.error;
    if (segSnaps.error) throw segSnaps.error;
    if (formSnaps.error) throw formSnaps.error;
    if (campSnaps.error) throw campSnaps.error;
    if (rollups.error) throw rollups.error;
    if (emailDesignRes.error) throw emailDesignRes.error;
    if (segNamesRow.error) throw segNamesRow.error;
    if (campNamesRow.error) throw campNamesRow.error;

    if (!client.data) {
      return json({ ok: false, error: { code: "not_found" }, correlationId }, { status: 404 });
    }

    const segNamesData = segNamesRow.data as { _ecd_group_names?: unknown; _ecd_metric_names?: unknown } | null;
    const campNamesData = campNamesRow.data as { _ecd_group_names?: unknown } | null;

    return json({
      ok: true,
      audit,
      client: redactClient(client.data as Record<string, unknown>),
      sections: sections.data ?? [],
      assets: assets.data ?? [],
      flowPerformance: flows.data ?? [],
      flowSnapshots: flowSnaps.data ?? [],
      segmentSnapshots: segSnaps.data ?? [],
      formSnapshots: formSnaps.data ?? [],
      campaignSnapshots: campSnaps.data ?? [],
      rollups: rollups.data ?? [],
      emailDesign: emailDesignRes.data ?? null,
      groupNames: segNamesData?._ecd_group_names ?? campNamesData?._ecd_group_names ?? null,
      metricNames: segNamesData?._ecd_metric_names ?? null,
      correlationId,
    });
  } catch (e) {
    return json(
      {
        ok: false,
        error: {
          code: "request_failed",
          message: e instanceof Error ? e.message : (e as { message?: string })?.message ?? JSON.stringify(e),
        },
        correlationId,
      },
      { status: 200 },
    );
  }
});
