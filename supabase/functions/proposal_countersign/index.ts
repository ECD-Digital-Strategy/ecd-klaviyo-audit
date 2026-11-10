// ECD countersign endpoint. Requires a staff (admin/auditor) session; the
// signature insert itself goes through the service role because
// proposal_signatures has no authenticated INSERT policy.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, requireStaffUserId } from "../_shared/auth.ts";
import { PROPOSAL_CORS_HEADERS, proposalJson } from "../_shared/proposal-public.ts";

const MAX_SIGNATURE_LENGTH = 300000;
// Proposals are auto-signed as Zak at creation, by whoever creates them (Members included, Hugo 2026-10-28).
// Keep in step with DEFAULT_SIGNER_EMAIL in src/lib/staff-signers.ts.
const DEFAULT_SIGNER_EMAIL = "zak@ecdigitalstrategy.com";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: PROPOSAL_CORS_HEADERS });
  if (req.method !== "POST") return proposalJson({ ok: false, error: { code: "method_not_allowed" } }, { status: 405 });

  const correlationId = crypto.randomUUID();
  try {
    const userId = await requireStaffUserId(req, "proposals");
    const body = (await req.json().catch(() => ({}))) as {
      proposal_id?: string;
      typed_name?: string;
      signature_image?: string;
      /** Team member the signature belongs to. Defaults to the caller. */
      signer_user_id?: string;
      /** Replace an existing agency signature (only while the client has not signed). */
      replace?: boolean;
    };
    const proposalId = (body.proposal_id ?? "").trim();
    const typedName = (body.typed_name ?? "").trim();
    const signatureImage = body.signature_image ?? "";
    const signerUserId = (body.signer_user_id ?? "").trim() || userId;
    const replace = body.replace === true;

    if (!proposalId || !typedName) {
      return proposalJson({ ok: false, error: { code: "bad_request", message: "Missing proposal_id or typed_name" }, correlationId }, { status: 400 });
    }
    // PNG for a drawn signature, SVG for one generated from the signer's name.
    const isSignatureImage = signatureImage.startsWith("data:image/png;base64,") ||
      signatureImage.startsWith("data:image/svg+xml;base64,");
    if (!isSignatureImage || signatureImage.length > MAX_SIGNATURE_LENGTH) {
      return proposalJson({ ok: false, error: { code: "bad_request", message: "Please draw your signature" }, correlationId }, { status: 400 });
    }

    const sb = assertServiceRoleClient();
    const { data: proposal, error: pErr } = await sb
      .from("proposals")
      .select("id, client_signed_at, countersigned_at")
      .eq("id", proposalId)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!proposal) {
      return proposalJson({ ok: false, error: { code: "not_found" }, correlationId }, { status: 404 });
    }
    // The agency now signs BEFORE the proposal goes out, so a client receives an
    // already-executed contract and only has to add their own name. Waiting for
    // the client first is no longer required.
    if (proposal.countersigned_at && !replace) {
      return proposalJson({ ok: false, error: { code: "already_countersigned" }, correlationId }, { status: 409 });
    }
    // Swapping the signer is fine while the deal is still open, but once ANY
    // client has signed (client_signed_at waits for the last signer), the
    // executed document must stop changing underneath them.
    const { count: clientSigCount, error: cErr } = await sb
      .from("proposal_signatures")
      .select("id", { count: "exact", head: true })
      .eq("proposal_id", proposalId)
      .eq("role", "client");
    if (cErr) throw cErr;
    if (replace && (proposal.client_signed_at || (clientSigCount ?? 0) > 0)) {
      return proposalJson(
        { ok: false, error: { code: "client_already_signed", message: "The client has signed; the signature can no longer be changed" }, correlationId },
        { status: 409 },
      );
    }

    const { data: signerRow } = await sb.from("profiles").select("email, name").eq("id", signerUserId).maybeSingle();
    if (!signerRow) {
      return proposalJson({ ok: false, error: { code: "bad_request", message: "Unknown signer" }, correlationId }, { status: 400 });
    }
    // Signing as someone else is for admins. The one exception is the first ECD
    // signature as the default signer, which is how every new proposal is signed.
    if (signerUserId !== userId) {
      const { data: caller } = await sb.from("profiles").select("role").eq("id", userId).maybeSingle();
      const isAdmin = (caller as { role?: string } | null)?.role === "admin";
      const firstDefaultSignature = !replace && !proposal.countersigned_at &&
        String((signerRow as { email?: string }).email ?? "").toLowerCase() === DEFAULT_SIGNER_EMAIL;
      if (!isAdmin && !firstDefaultSignature) {
        return proposalJson(
          { ok: false, error: { code: "forbidden", message: "Only an admin can sign for another team member" }, correlationId },
          { status: 403 },
        );
      }
    }
    const signedAt = new Date().toISOString();

    if (replace) {
      await sb.from("proposal_signatures").delete().eq("proposal_id", proposalId).eq("role", "agency");
    }

    const { error: sigError } = await sb.from("proposal_signatures").insert({
      proposal_id: proposalId,
      role: "agency",
      signer_name: typedName,
      signer_email: (signerRow as { email?: string } | null)?.email ?? "",
      signer_user_id: signerUserId,
      signature_image: signatureImage,
      typed_name: typedName,
      ip_address: (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim(),
      user_agent: (req.headers.get("user-agent") ?? "").slice(0, 400),
      signed_at: signedAt,
    });
    if (sigError) {
      if ((sigError as { code?: string }).code === "23505") {
        return proposalJson({ ok: false, error: { code: "already_countersigned" }, correlationId }, { status: 409 });
      }
      throw sigError;
    }

    const { error: updateError } = await sb
      .from("proposals")
      .update({ countersigned_at: signedAt, updated_at: signedAt })
      .eq("id", proposalId);
    if (updateError) throw updateError;

    await sb.from("proposal_events").insert({
      proposal_id: proposalId,
      event_type: "countersigned",
      actor: "admin",
      actor_user_id: userId,
      // Who the signature is FOR versus who applied it: when one admin signs on
      // behalf of another, the trail has to keep both.
      metadata: {
        typed_name: typedName,
        signer_user_id: signerUserId,
        on_behalf_of: signerUserId !== userId ? (signerRow as { name?: string } | null)?.name ?? null : null,
        replaced: replace || undefined,
      },
    });

    return proposalJson({ ok: true, signed_at: signedAt, correlationId });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status = message === "Forbidden" ? 403 : 200;
    return proposalJson({ ok: false, error: { code: "request_failed", message }, correlationId }, { status });
  }
});
