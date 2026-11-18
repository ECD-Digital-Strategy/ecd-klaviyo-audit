// Public document fetch by token. Deployed --no-verify-jwt: anonymous recipients
// call this with only the anon apikey. All data access uses the service role
// after validating the token server-side (document tables have no anon RLS).
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, getUserIdFromAuthorization } from "../_shared/auth.ts";
import { DOCUMENT_CORS_HEADERS, documentJson, fetchPublicDocument, isDocumentExpired, pdfLinks, serializePublicDocument } from "../_shared/document-public.ts";
import { notificationRecipients, proposalEmailHtml, resolveFromAddress, resolveOrigin, sendEmail } from "../_shared/mailer.ts";
import { escapeHtml } from "../_shared/proposal-links.ts";

const SCANNER_UA_RE = /bot|crawler|spider|preview|scanner|safelinks|proofpoint|mimecast|barracuda|urldefense|headless/i;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: DOCUMENT_CORS_HEADERS });
  if (req.method !== "POST") return documentJson({ ok: false, error: { code: "method_not_allowed" } }, { status: 405 });

  const correlationId = crypto.randomUUID();
  try {
    const { token } = (await req.json().catch(() => ({}))) as { token?: string };
    const cleanToken = (token ?? "").trim().toLowerCase();

    const sb = assertServiceRoleClient();
    const bundle = await fetchPublicDocument(sb, cleanToken);
    if (!bundle) return documentJson({ ok: false, error: { code: "not_found" }, correlationId }, { status: 404 });

    const { document } = bundle;
    const userAgent = req.headers.get("user-agent") ?? "";
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();

    // A view from any signed-in ECD session is us checking the document, not the
    // recipient, so it must never flip status to "viewed".
    let isStaffView = false;
    let staffUserId: string | null = null;
    try {
      staffUserId = await getUserIdFromAuthorization(req);
      isStaffView = true;
    } catch {
      isStaffView = false;
    }
    const isScanner = SCANNER_UA_RE.test(userAgent);

    if (isStaffView && !isScanner && staffUserId) {
      // Internal ECD view: logged as "Viewed by <team member>", deduped, never
      // flips status.
      const nowIso = new Date().toISOString();
      const meta = { internal: true, ip, user_agent: userAgent.slice(0, 400) };
      const { data: existingView } = await sb
        .from("document_events")
        .select("id")
        .eq("document_id", document.id)
        .eq("event_type", "viewed")
        .eq("actor", "admin")
        .eq("actor_user_id", staffUserId)
        .maybeSingle();
      if (existingView?.id) {
        await sb.from("document_events").update({ created_at: nowIso, metadata: meta }).eq("id", existingView.id);
      } else {
        await sb.from("document_events").insert({
          document_id: document.id,
          event_type: "viewed",
          actor: "admin",
          actor_user_id: staffUserId,
          metadata: meta,
        });
      }
    } else if (!isStaffView && !isScanner) {
      // Race-safe first-view transition; only one concurrent request wins.
      const { data: transitioned } = await sb
        .from("documents")
        .update({ status: "viewed", first_viewed_at: new Date().toISOString() })
        .eq("id", document.id)
        .eq("status", "sent")
        .select("id");
      const firstView = Boolean(transitioned && transitioned.length > 0);
      if (firstView) document.status = "viewed";

      await sb.from("document_events").insert({
        document_id: document.id,
        event_type: "viewed",
        actor: "recipient",
        metadata: { ip, user_agent: userAgent.slice(0, 400), first_view: firstView },
      });

      if (firstView) {
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
            subject: `Document viewed: ${document.title || "Untitled"}`,
            html: proposalEmailHtml({
              heading: `${escapeHtml(document.recipient_name || document.recipient_email || "The recipient")} opened a document`,
              bodyLines: [`"${escapeHtml(document.title || "Untitled")}" was viewed for the first time.`],
              logoUrl: origin ? `${origin}/favicon.png` : undefined,
            }),
          });
        }
      }
    }

    const payload = serializePublicDocument(bundle);
    const pdf = await pdfLinks(sb, document);
    return documentJson({ ok: true, ...payload, ...(pdf ?? {}), expired: isDocumentExpired(document), correlationId });
  } catch (e) {
    return documentJson(
      { ok: false, error: { code: "request_failed", message: e instanceof Error ? e.message : "Unknown error" }, correlationId },
      { status: 200 },
    );
  }
});
