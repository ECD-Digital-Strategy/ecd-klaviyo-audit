import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { isServiceRoleAuthorization, requireStaffUserId } from "../_shared/auth.ts";
import { createDraftInvoiceForProposal } from "../_shared/xero-invoice.ts";
import { loadConnection, serviceClient } from "../_shared/xero.ts";

// Posts the DRAFT invoice for one proposal. Called two ways:
//  - by proposal_sign (service role) the moment a client signs;
//  - by a staff user from the proposal page, to retry after a failure.
// Kept out of proposal_sign's own request so a slow or failing Xero can never
// delay or break a client's signature.

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type, accept, origin, referer, user-agent",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
    ...init,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: { code: "method_not_allowed" } }, { status: 405 });

  try {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token || !isServiceRoleAuthorization(token)) await requireStaffUserId(req);
  } catch (e) {
    return json(
      { ok: false, error: { code: "unauthorized", message: e instanceof Error ? e.message : "Unauthorized" } },
      { status: 200 },
    );
  }

  try {
    const body = (await req.json().catch(() => ({}))) as { proposal_id?: string };
    const proposalId = (body.proposal_id ?? "").trim();
    if (!proposalId) return json({ ok: false, error: { code: "bad_request", message: "Missing proposal_id" } });

    const sb = serviceClient();
    // Not connected yet is a normal state, not an error worth alarming about.
    const conn = await loadConnection(sb);
    if (!conn?.refresh_token_ciphertext || !conn.tenant_id) {
      return json({ ok: false, error: { code: "not_connected", message: "Xero is not connected" } });
    }

    const result = await createDraftInvoiceForProposal(sb, proposalId);
    if (!result.ok) {
      return json({ ok: false, error: { code: "invoice_failed", message: result.error } });
    }
    return json({
      ok: true,
      invoice_id: result.invoices[0]?.id ?? null,
      invoice_number: result.invoices[0]?.number ?? null,
      invoices: result.invoices,
    });
  } catch (e) {
    return json(
      { ok: false, error: { code: "request_failed", message: e instanceof Error ? e.message : "Unknown error" } },
      { status: 200 },
    );
  }
});
