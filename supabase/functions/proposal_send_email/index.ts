// Send (or resend) a proposal to the client. Staff-only. Handles the full
// go-live transition server-side: token generation, contract snapshot,
// draft -> sent. The validity window is NOT started here; it starts when the
// client first opens the proposal. Email delivery is optional: without
// SMTP_USER/SMTP_PASS configured the transition still happens and the link
// is returned for the sender to copy.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, requireStaffUserId } from "../_shared/auth.ts";
import { PROPOSAL_CORS_HEADERS, proposalJson } from "../_shared/proposal-public.ts";
import { proposalEmailHtml, resolveFromAddress, sendEmail } from "../_shared/mailer.ts";
import { escapeHtml } from "../_shared/proposal-links.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: PROPOSAL_CORS_HEADERS });
  if (req.method !== "POST") return proposalJson({ ok: false, error: { code: "method_not_allowed" } }, { status: 405 });

  const correlationId = crypto.randomUUID();
  try {
    const userId = await requireStaffUserId(req, "proposals");
    const body = (await req.json().catch(() => ({}))) as {
      proposal_id?: string;
      recipient_email?: string;
      recipient_name?: string;
      recipient2_email?: string;
      recipient2_name?: string;
      message?: string;
      app_url?: string;
      reply_to_emails?: string[];
    };
    const proposalId = (body.proposal_id ?? "").trim();
    const recipientEmail = (body.recipient_email ?? "").trim();
    const recipientName = (body.recipient_name ?? "").trim();
    const recipient2Email = (body.recipient2_email ?? "").trim();
    const recipient2Name = (body.recipient2_name ?? "").trim();
    const message = (body.message ?? "").trim();
    const replyToEmails = (body.reply_to_emails ?? [])
      .map((e) => e.trim())
      .filter((e) => EMAIL_RE.test(e));

    if (!proposalId) {
      return proposalJson({ ok: false, error: { code: "bad_request", message: "Missing proposal_id" }, correlationId }, { status: 400 });
    }
    if (!EMAIL_RE.test(recipientEmail)) {
      return proposalJson({ ok: false, error: { code: "bad_request", message: "Valid recipient email required" }, correlationId }, { status: 400 });
    }
    if (recipient2Email && !EMAIL_RE.test(recipient2Email)) {
      return proposalJson({ ok: false, error: { code: "bad_request", message: "Valid second signer email required" }, correlationId }, { status: 400 });
    }

    const sb = assertServiceRoleClient();
    const { data: proposal, error: pErr } = await sb
      .from("proposals")
      .select("*, client:clients(company_name)")
      .eq("id", proposalId)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!proposal) {
      return proposalJson({ ok: false, error: { code: "not_found" }, correlationId }, { status: 404 });
    }
    if (proposal.status === "won" || proposal.status === "lost") {
      return proposalJson({ ok: false, error: { code: "closed", message: "Proposal is already closed" }, correlationId }, { status: 409 });
    }

    const { data: settingsRow } = await sb
      .from("platform_settings")
      .select("proposal_settings")
      .eq("id", "default")
      .maybeSingle();
    const settings = (settingsRow?.proposal_settings ?? {}) as {
      email?: { from_name?: string; from_email?: string; reply_to?: string };
      defaults?: { valid_days?: number };
    };

    // Go-live transition (idempotent for resends). Second signer: use the value
    // from the request when provided, otherwise whatever is already configured.
    const token = proposal.public_token ?? generateToken();
    const signer2Email = recipient2Email || (proposal.recipient2_email ?? "");
    const signer2Name = recipient2Name || (proposal.recipient2_name ?? "");
    const token2 = signer2Email ? (proposal.public_token2 ?? generateToken()) : null;
    // valid_until is NOT set at send time. The validity window starts when the
    // client first opens the proposal (proposal_public), so an email sitting
    // unopened in an inbox does not burn the window. Same rule as a copied link.
    const validDays = settings.defaults?.valid_days || 30;
    const wasDraft = proposal.status === "draft";
    const now = new Date().toISOString();

    const updates: Record<string, unknown> = {
      public_token: token,
      recipient_email: recipientEmail,
      updated_at: now,
    };
    if (recipientName) updates.recipient_name = recipientName;
    if (signer2Email) {
      updates.recipient2_email = signer2Email;
      updates.recipient2_name = signer2Name;
      updates.public_token2 = token2;
    }
    if (wasDraft) {
      updates.status = "sent";
      updates.sent_at = now;
    }

    // Refresh the contract snapshot while no client has signed yet so contract
    // edits reach the client (frozen from the first signature onward).
    const { count: clientSigCount } = await sb
      .from("proposal_signatures")
      .select("id", { count: "exact", head: true })
      .eq("proposal_id", proposalId)
      .eq("role", "client");
    if (!proposal.client_signed_at && (clientSigCount ?? 0) === 0) {
      // Same rules as buildContractsSnapshot in src/lib/contract-snapshot.ts (Deno cannot import src):
      // catalog order (display_order), only the included contracts, a per-proposal override wins.
      // The MSA-on-file swap is not redone here: it lives in include_contracts + contract_overrides,
      // exactly as the editor saved them, so both paths freeze the same text.
      const includeContracts = (proposal.include_contracts ?? []) as string[];
      const { data: docs, error: docsErr } = await sb
        .from("contract_documents")
        .select("slug, name, content, updated_at")
        .in("slug", includeContracts.length ? includeContracts : ["__none__"])
        .order("display_order", { ascending: true });
      // A failed read must not freeze an empty contract list.
      if (docsErr) throw docsErr;
      // A per-proposal rewrite (redlines, the "MSA on file" reference) is what
      // the client reads, so it is what gets frozen.
      const overrides = (proposal.contract_overrides ?? {}) as Record<string, string>;
      updates.contracts_snapshot = (docs ?? []).map((doc) => ({
        slug: doc.slug,
        name: doc.name,
        content: overrides[doc.slug]?.trim() ? overrides[doc.slug] : doc.content,
        version_updated_at: doc.updated_at,
      }));
    }

    // Whoever presses Send owns the deal: the viewed/signed notifications
    // always include them, on top of the Team notifications list. Re-sending
    // re-stamps, so the notification follows the latest sender.
    updates.sent_by = userId;
    const { error: updateErr } = await sb.from("proposals").update(updates).eq("id", proposalId);
    if (updateErr) throw updateErr;

    const origin = (body.app_url ?? "").trim() || (Deno.env.get("APP_URL") ?? "").trim() || (req.headers.get("origin") ?? "").trim();
    const cleanOrigin = origin.replace(/\/$/, "");
    const logoUrl = cleanOrigin ? `${cleanOrigin}/favicon.png` : undefined;
    const companyName = proposal.client?.company_name ?? "your company";

    const [primaryReplyTo, ...ccReplyTos] = replyToEmails.length
      ? replyToEmails
      : settings.email?.reply_to
      ? [settings.email.reply_to]
      : [];

    // One email per signer, each with their own signing link.
    const recipients = [
      { email: recipientEmail, name: recipientName, token },
      ...(signer2Email && token2 ? [{ email: signer2Email, name: signer2Name, token: token2 }] : []),
    ];

    const subject = `Proposal for ${companyName} from ECD Digital Strategy`;
    // Raw (unescaped) body lines, minus the per-recipient greeting/link, stored on
    // the event so the activity log can render a faithful preview of what was sent.
    const previewBodyLines = [
      ...(message ? [message] : []),
      `Please review the proposal we prepared for ${companyName}. You can read and sign it directly from the link below.`,
      ...(recipients.length > 1 ? [`This link is personal to you; each signer receives their own signing link.`] : []),
      `This proposal is valid for ${validDays} days from the day you first open it.`,
    ];

    const emailResults: Array<{ email: string; status: string; id?: string; reason?: string }> = [];
    for (const recipient of recipients) {
      const result = await sendEmail({
        to: [recipient.email],
        from: resolveFromAddress(settings.email),
        replyTo: primaryReplyTo,
        cc: ccReplyTos,
        subject,
        html: proposalEmailHtml({
          heading: `Your proposal is ready`,
          bodyLines: [
            `Hi${recipient.name ? ` ${escapeHtml(recipient.name.split(" ")[0])}` : ""},`,
            ...(message ? [escapeHtml(message)] : []),
            `Please review the proposal we prepared for ${escapeHtml(companyName)}. You can read and sign it directly from the link below.`,
            ...(recipients.length > 1 ? [`This link is personal to you; each signer receives their own signing link.`] : []),
            `This proposal is valid for ${validDays} days from the day you first open it.`,
          ],
          ctaLabel: "View & sign proposal",
          ctaUrl: `${cleanOrigin}/proposal/${recipient.token}`,
          logoUrl,
        }),
      });
      emailResults.push({
        email: recipient.email,
        status: result.status,
        ...(result.status === "sent" ? { id: result.id } : { reason: result.reason }),
      });
    }

    await sb.from("proposal_events").insert({
      proposal_id: proposalId,
      event_type: wasDraft ? "sent" : "resent",
      actor: "admin",
      actor_user_id: userId,
      metadata: {
        send_method: "email",
        email_to: recipients.map((r) => r.email).join(", "),
        email_results: emailResults,
        email_status: emailResults.every((r) => r.status === "sent")
          ? "sent"
          : emailResults.some((r) => r.status === "failed")
          ? "failed"
          : emailResults[0].status,
        // Rich preview payload so the activity log can show exactly what went out.
        subject,
        message: message || null,
        recipients: recipients.map((r) => ({ name: r.name || null, email: r.email })),
        reply_to: primaryReplyTo || null,
        cc: ccReplyTos,
        body_lines: previewBodyLines,
        cta_label: "View & sign proposal",
      },
    });

    const failed = emailResults.filter((r) => r.status === "failed");
    if (failed.length > 0) {
      return proposalJson(
        {
          ok: false,
          error: { code: "email_failed", message: failed.map((f) => `${f.email}: ${f.reason}`).join("; ") },
          public_token: token,
          public_token2: token2,
          correlationId,
        },
        { status: 200 },
      );
    }

    return proposalJson({
      ok: true,
      public_token: token,
      public_token2: token2,
      email_status: emailResults[0].status,
      ...(emailResults[0].status === "skipped" ? { email_note: emailResults[0].reason } : {}),
      correlationId,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status = message === "Forbidden" ? 403 : 200;
    return proposalJson({ ok: false, error: { code: "request_failed", message }, correlationId }, { status });
  }
});
