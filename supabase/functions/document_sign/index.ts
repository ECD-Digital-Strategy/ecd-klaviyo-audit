// Recipient signs a document. Deployed --no-verify-jwt (anonymous). Validates the
// token server-side, records the signature via the service role, and flips the
// document to "signed". Single signer, no countersign.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, requireStaffUserId } from "../_shared/auth.ts";
import { cleanFields, recipientNeeds } from "../_shared/pdf-sign.ts";
import { finalizeSignedPdf } from "../_shared/pdf-finalize.ts";
import { DOCUMENT_CORS_HEADERS, documentJson, fetchPublicDocument, hashContent, isDocumentExpired } from "../_shared/document-public.ts";
import { notificationRecipients, proposalEmailHtml, resolveFromAddress, resolveOrigin, sendEmail } from "../_shared/mailer.ts";
import { escapeHtml } from "../_shared/proposal-links.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: DOCUMENT_CORS_HEADERS });
  if (req.method !== "POST") return documentJson({ ok: false, error: { code: "method_not_allowed" } }, { status: 405 });

  const correlationId = crypto.randomUUID();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      document_id?: string;
      token?: string;
      typed_name?: string;
      signer_email?: string;
      signature_image?: string;
      initials_image?: string;
    };

    // Staff: make the signed PDF again (if the run after signing failed). Needs a signed-in staff session.
    if (body.action === "finalize_pdf") {
      try {
        await requireStaffUserId(req, "documents");
      } catch {
        return documentJson({ ok: false, error: { code: "forbidden" }, correlationId }, { status: 403 });
      }
      const r = await finalizeSignedPdf(assertServiceRoleClient(), String(body.document_id ?? ""));
      return documentJson({ ok: true, ...r, correlationId });
    }
    const token = (body.token ?? "").trim().toLowerCase();
    const typedName = (body.typed_name ?? "").trim();
    const signerEmail = (body.signer_email ?? "").trim();
    const signatureImage = body.signature_image ?? "";

    if (!typedName) return documentJson({ ok: false, error: { code: "bad_request", message: "Full name is required" }, correlationId }, { status: 200 });
    if (!EMAIL_RE.test(signerEmail)) return documentJson({ ok: false, error: { code: "bad_request", message: "A valid email is required" }, correlationId }, { status: 200 });
    if (!signatureImage.startsWith("data:image/") || signatureImage.length > 400000) {
      return documentJson({ ok: false, error: { code: "bad_request", message: "A signature is required" }, correlationId }, { status: 200 });
    }

    const sb = assertServiceRoleClient();
    const bundle = await fetchPublicDocument(sb, token);
    if (!bundle) return documentJson({ ok: false, error: { code: "not_found" }, correlationId }, { status: 404 });

    const { document } = bundle;
    // A document sent as a statement rather than an agreement is not signable
    // by the recipient at all. The public page hides the pad, so reaching here
    // means a stale tab or a direct call.
    if (document.recipient_signature_enabled === false) {
      return documentJson({ ok: false, error: { code: "not_signable", message: "This document does not require your signature." }, correlationId }, { status: 200 });
    }
    if (document.status !== "sent" && document.status !== "viewed") {
      return documentJson({ ok: false, error: { code: "not_signable", message: "This document can no longer be signed." }, correlationId }, { status: 200 });
    }
    if (isDocumentExpired(document)) {
      return documentJson({ ok: false, error: { code: "expired", message: "This document has expired." }, correlationId }, { status: 200 });
    }
    if (bundle.signature) {
      return documentJson({ ok: false, error: { code: "already_signed", message: "This document has already been signed." }, correlationId }, { status: 200 });
    }

    // An uploaded PDF: there must be something for the recipient to fill, and initials when it asks for them.
    const isPdf = document.kind === "pdf";
    let initialsImage: string | null = null;
    if (isPdf) {
      const needs = recipientNeeds(cleanFields(document.pdf_fields, document.pdf_pages ?? 9999));
      if (!needs.any) {
        return documentJson({ ok: false, error: { code: "not_signable", message: "This PDF has no fields for you to sign." }, correlationId }, { status: 200 });
      }
      if (needs.initials) {
        initialsImage = body.initials_image ?? "";
        if (!initialsImage.startsWith("data:image/") || initialsImage.length > 400000) {
          return documentJson({ ok: false, error: { code: "bad_request", message: "Your initials are required" }, correlationId }, { status: 200 });
        }
      }
    }

    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
    const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 400);

    const { error: sigErr } = await sb.from("document_signatures").insert({
      initials_image: initialsImage,
      document_id: document.id,
      signer_role: "recipient",
      signer_name: typedName,
      signer_email: signerEmail,
      signature_image: signatureImage,
      typed_name: typedName,
      ip_address: ip,
      user_agent: userAgent,
    });
    if (sigErr) {
      // Unique violation = double-sign race.
      if ((sigErr as { code?: string }).code === "23505") {
        return documentJson({ ok: false, error: { code: "already_signed", message: "This document has already been signed." }, correlationId }, { status: 200 });
      }
      throw sigErr;
    }

    const signedAt = new Date().toISOString();
    await sb.from("documents").update({ status: "signed", signed_at: signedAt }).eq("id", document.id);

    const contentHash = await hashContent({ title: document.title, content: document.content });
    await sb.from("document_events").insert({
      document_id: document.id,
      event_type: "signed",
      actor: "recipient",
      metadata: { signer_email: signerEmail, typed_name: typedName, ip, content_hash: contentHash },
    });

    // Notify the team.
    const { data: settingsRow } = await sb
      .from("platform_settings")
      .select("document_settings")
      .eq("id", "default")
      .maybeSingle();
    const settings = (settingsRow?.document_settings ?? {}) as {
      email?: { from_name?: string; from_email?: string; team_notification_emails?: string[] };
    };
    const teamEmails = (settings.email?.team_notification_emails ?? []).filter(Boolean);
    // The sender is always notified, whatever the team list says.
    const recipients = await notificationRecipients(sb, teamEmails, "documents", document.id);
    if (recipients.length > 0) {
      const origin = resolveOrigin(req);
      await sendEmail({
        to: recipients,
        from: resolveFromAddress(settings.email),
        subject: `Document signed: ${document.title || "Untitled"}`,
        html: proposalEmailHtml({
          heading: `${escapeHtml(typedName)} signed a document`,
          bodyLines: [`"${escapeHtml(document.title || "Untitled")}" has been signed.`],
          logoUrl: origin ? `${origin}/favicon.png` : undefined,
        }),
      });
    }

    // An uploaded PDF: stamp the signatures into it now, and draft the signed copy to the client in the sender's
    // Gmail. A failure here never undoes the signature: it is logged, and staff can make it again from the app.
    let signedPdfUrl: string | null = null;
    if (isPdf) {
      try {
        const r = await finalizeSignedPdf(sb, document.id);
        const { data } = await sb.storage.from("signing-docs").createSignedUrl(r.path, 3600);
        signedPdfUrl = data?.signedUrl ?? null;
      } catch (e) {
        await sb.from("document_events").insert({
          document_id: document.id,
          event_type: "signed_pdf_failed",
          actor: "system",
          metadata: { error: (e instanceof Error ? e.message : String(e)).slice(0, 400) },
        });
      }
    }

    return documentJson({ ok: true, signed_pdf_url: signedPdfUrl, correlationId });
  } catch (e) {
    return documentJson(
      { ok: false, error: { code: "request_failed", message: e instanceof Error ? e.message : "Unknown error" }, correlationId },
      { status: 200 },
    );
  }
});
