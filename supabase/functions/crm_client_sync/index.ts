import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, hasCronSecret, requireStaffUserId } from "../_shared/auth.ts";
import { crmCompanies } from "../_shared/outreach-crm.ts";
import { planClientSync, type ExistingClient } from "../_shared/crm-client-sync.ts";

// Clients from the ECD CRM (Revenue Desk), not HubSpot (Emil, 2026-11-22: "we have cancelled the subscription there").
// Replaces hubspot_sync, which imported every new HubSpot company as a client every 15 minutes. Same behaviour, new
// source: every CRM company (Hub crm-outreach action "companies", migration 0374) is created here as a client with its
// main contact's name and email, or linked to the client that already has its name or website. Test records are
// skipped. Runs on pg_cron (x-cron-secret, the old hubspot_cron_secret) and from "Sync now" (staff).
// Rows it creates are flagged crm_imported: they are CRM companies, not necessarily clients, so Outreach does not
// treat them as "already a client" (real clients come from the tracker, _shared/outreach-clients.ts).
// {dry_run: true} returns the plan without writing.

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: { code: "method_not_allowed" } }, 405);

  let authorized = await hasCronSecret(req, "hubspot_cron_secret");
  if (!authorized) {
    try {
      await requireStaffUserId(req);
      authorized = true;
    } catch {
      /* not staff */
    }
  }
  if (!authorized) return json({ ok: false, error: { code: "unauthorized", message: "Not authorized" } });

  const body = (await req.json().catch(() => ({}))) as { dry_run?: boolean };
  const sb = assertServiceRoleClient();
  const runStarted = new Date();
  const saveResult = async (result: Record<string, unknown>, ok: boolean) => {
    await sb.from("hubspot_sync_state").update({
      last_result: { ...result, source: "revenue_desk", at: runStarted.toISOString() },
      updated_at: new Date().toISOString(),
      ...(ok ? { last_synced_at: runStarted.toISOString() } : {}),
    }).eq("id", "default");
  };

  try {
    const [companies, existing] = await Promise.all([
      crmCompanies(),
      sb.from("clients").select("id, company_name, website_url, hubspot_company_id").then(({ data, error }) => {
        if (error) throw error;
        return (data ?? []) as ExistingClient[];
      }),
    ]);
    const plan = planClientSync(companies, existing);
    if (body.dry_run) {
      return json({ ok: true, dry_run: true, scanned: companies.length, create: plan.create.map((c) => `${c.company_name} (${c.website_url || "no site"})`), link: plan.link.length, skipped: plan.skipped });
    }

    let linked = 0;
    for (const l of plan.link) {
      const { data } = await sb.from("clients").update({ hubspot_company_id: l.companyId }).eq("id", l.clientId).is("hubspot_company_id", null).select("id");
      if (data?.length) linked++;
    }
    let created = 0;
    let skipped = plan.skipped.total;
    for (const row of plan.create) {
      const { error } = await sb.from("clients").insert(row);
      if (error) {
        // A parallel run or a manual sync made it first: fine.
        if (!/duplicate key/i.test(error.message ?? "")) throw error;
        skipped++;
      } else {
        created++;
      }
    }
    const result = { ok: true, mode: "revenue_desk", scanned: companies.length, created, linked, skipped, backfill_remaining: false };
    await saveResult(result, true);
    return json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await saveResult({ ok: false, error: { code: "sync_failed", message } }, false).catch(() => {});
    return json({ ok: false, error: { code: "sync_failed", message } });
  }
});
