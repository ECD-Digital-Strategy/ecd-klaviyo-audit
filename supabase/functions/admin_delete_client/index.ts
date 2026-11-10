import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, requireAdminUserId } from "../_shared/auth.ts";

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type, accept, origin, referer, user-agent",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
    ...init,
  });
}

type DeleteResult = { error: { message: string; code?: string } | null };

/** Run one delete and stop on failure. Each one used to be fire-and-forget, so
 * a failed delete went unnoticed and the client delete then failed on a
 * foreign key, or left orphans behind. A table that does not exist is fine. */
async function mustDelete(label: string, op: PromiseLike<DeleteResult>) {
  const { error } = await op;
  if (!error) return;
  if (error.code === "42P01" || error.code === "PGRST205") return;
  throw new Error(`Could not delete ${label}: ${error.message}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: { code: "method_not_allowed" } }, { status: 405 });

  const correlationId = crypto.randomUUID();
  try {
    await requireAdminUserId(req);
    const { client_id } = (await req.json()) as { client_id?: string };
    const clientId = (client_id ?? "").trim();
    if (!clientId) return json({ ok: false, error: { code: "bad_request", message: "Missing client_id" }, correlationId }, { status: 400 });

    const sb = assertServiceRoleClient();

    // Gather audit ids for this client
    const { data: audits, error: aErr } = await sb.from("audits").select("id").eq("client_id", clientId);
    if (aErr) throw aErr;
    const auditIds = (audits ?? []).map((a: any) => a.id).filter(Boolean);

    // Delete in dependency order
    if (auditIds.length) {
      // annotations depend on audit_sections
      const { data: sectionIds, error: sErr } = await sb.from("audit_sections").select("id").in("audit_id", auditIds);
      if (sErr) throw sErr;
      const secIds = (sectionIds ?? []).map((s: any) => s.id).filter(Boolean);
      if (secIds.length) await mustDelete("annotations", sb.from("annotations").delete().in("audit_section_id", secIds));

      await mustDelete("audit_assets", sb.from("audit_assets").delete().in("audit_id", auditIds));
      await mustDelete("audit_sections", sb.from("audit_sections").delete().in("audit_id", auditIds));
      await mustDelete("recommendations", sb.from("recommendations").delete().in("audit_id", auditIds));
      await mustDelete("flow_performance", sb.from("flow_performance").delete().in("audit_id", auditIds));
      await mustDelete("health_scores", sb.from("health_scores").delete().in("audit_id", auditIds));

      await mustDelete("klaviyo_flow_snapshots", sb.from("klaviyo_flow_snapshots").delete().in("audit_id", auditIds));
      await mustDelete("klaviyo_campaign_snapshots", sb.from("klaviyo_campaign_snapshots").delete().in("audit_id", auditIds));
      await mustDelete("klaviyo_form_snapshots", sb.from("klaviyo_form_snapshots").delete().in("audit_id", auditIds));
      await mustDelete("klaviyo_segment_snapshots", sb.from("klaviyo_segment_snapshots").delete().in("audit_id", auditIds));
      await mustDelete("klaviyo_reporting_rollups", sb.from("klaviyo_reporting_rollups").delete().in("audit_id", auditIds));

      await mustDelete("audits", sb.from("audits").delete().in("id", auditIds));
    }

    // Client-scoped tables
    await mustDelete("client_secrets", sb.from("client_secrets").delete().eq("client_id", clientId));
    await mustDelete("klaviyo_connections", sb.from("klaviyo_connections").delete().eq("client_id", clientId));
    // proposals.client_id is ON DELETE RESTRICT; its children (line items,
    // signatures, events) cascade automatically once the proposal rows go.
    await mustDelete("proposals", sb.from("proposals").delete().eq("client_id", clientId));

    // Finally delete the client
    const { error: cErr } = await sb.from("clients").delete().eq("id", clientId);
    if (cErr) throw cErr;

    return json({ ok: true, correlationId }, { status: 200 });
  } catch (e) {
    return json(
      { ok: false, error: { code: "request_failed", message: e instanceof Error ? e.message : "Unknown error" }, correlationId },
      { status: 200 },
    );
  }
});

