// Public proposal fetch by token. Deployed with --no-verify-jwt: anonymous
// clients call this with only the anon apikey. All data access uses the
// service role after validating the token server-side (proposal tables have
// no anon RLS policies by design).
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, getUserIdFromAuthorization } from "../_shared/auth.ts";
import {
  PROPOSAL_CORS_HEADERS,
  computeProposalTotals,
  fetchPublicProposal,
  isProposalExpired,
  proposalJson,
  serializePublicProposal,
  totalsEmailLine,
} from "../_shared/proposal-public.ts";
import { notificationRecipients, proposalEmailHtml, resolveFromAddress, resolveOrigin, sendEmail } from "../_shared/mailer.ts";
import { escapeHtml, proposalReferenceLink } from "../_shared/proposal-links.ts";
import { addDaysToDate, businessDate } from "../_shared/valid-until.ts";

// Email link scanners (Outlook SafeLinks, security proxies) prefetch URLs and
// would otherwise flip proposals to "viewed" before a human opens them.
const SCANNER_UA_RE = /bot|crawler|spider|preview|scanner|safelinks|proofpoint|mimecast|barracuda|urldefense|headless/i;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: PROPOSAL_CORS_HEADERS });
  if (req.method !== "POST") return proposalJson({ ok: false, error: { code: "method_not_allowed" } }, { status: 405 });

  const correlationId = crypto.randomUUID();
  try {
    const { token } = (await req.json().catch(() => ({}))) as { token?: string; preview?: boolean };
    const cleanToken = (token ?? "").trim().toLowerCase();

    const sb = assertServiceRoleClient();
    const bundle = await fetchPublicProposal(sb, cleanToken);
    if (!bundle) {
      return proposalJson({ ok: false, error: { code: "not_found" }, correlationId }, { status: 404 });
    }

    const { proposal } = bundle;
    const userAgent = req.headers.get("user-agent") ?? "";
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();

    // A view from any signed-in ECD session is us checking the proposal, not the
    // client, so it must never flip the status to "viewed". Clients have no app
    // login, so a resolvable session means staff. This covers opening the live
    // client link while logged in, not just the explicit preview.
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
      // Internal ECD view: never flips status to "viewed" (that is reserved for
      // the client) and never notifies the team. We still log it so the activity
      // timeline can show "Viewed by <team member>". Deduped per user so repeated
      // opens just refresh the timestamp of the single entry instead of spamming.
      const nowIso = new Date().toISOString();
      const meta = {
        internal: true,
        ip,
        user_agent: userAgent.slice(0, 400),
        signer_index: bundle.signerIndex,
      };
      const { data: existingView } = await sb
        .from("proposal_events")
        .select("id")
        .eq("proposal_id", proposal.id)
        .eq("event_type", "viewed")
        .eq("actor", "admin")
        .eq("actor_user_id", staffUserId)
        .maybeSingle();
      if (existingView?.id) {
        await sb
          .from("proposal_events")
          .update({ created_at: nowIso, metadata: meta })
          .eq("id", existingView.id);
      } else {
        await sb.from("proposal_events").insert({
          proposal_id: proposal.id,
          event_type: "viewed",
          actor: "admin",
          actor_user_id: staffUserId,
          metadata: meta,
        });
      }
    } else if (!isStaffView && !isScanner) {
      // The validity window starts NOW, on the client's first real view, rather
      // than when we copied the link or sent the email. Internal views and link
      // scanners are excluded above, so neither can start the clock early.
      const { data: validitySettingsRow } = await sb
        .from("platform_settings")
        .select("proposal_settings")
        .eq("id", "default")
        .maybeSingle();
      const validDays =
        ((validitySettingsRow?.proposal_settings ?? {}) as { defaults?: { valid_days?: number } })
          .defaults?.valid_days || 30;
      // Counted from today's New York date, the clock the expiry job uses (a UTC
      // date ran a day ahead for evening views in New York).
      const validUntil = proposal.valid_until ?? addDaysToDate(businessDate(), validDays);

      // Race-safe first-view transition: only one concurrent request wins the
      // sent -> viewed update (M4 hangs the team notification off this winner).
      const { data: transitioned } = await sb
        .from("proposals")
        .update({ status: "viewed", first_viewed_at: new Date().toISOString(), valid_until: validUntil })
        .eq("id", proposal.id)
        .eq("status", "sent")
        .select("id");
      const firstView = Boolean(transitioned && transitioned.length > 0);
      if (firstView) {
        proposal.status = "viewed";
        // Reflect it in this very response: the client is reading the page that
        // shows "valid until", and it was null a moment ago.
        proposal.valid_until = validUntil;
      }

      await sb.from("proposal_events").insert({
        proposal_id: proposal.id,
        event_type: "viewed",
        actor: "client",
        metadata: { ip, user_agent: userAgent.slice(0, 400), first_view: firstView, signer_index: bundle.signerIndex },
      });

      // Team notification exactly once, hung off the race-winning first view.
      if (firstView) {
        const { data: settingsRow } = await sb
          .from("platform_settings")
          .select("proposal_settings")
          .eq("id", "default")
          .maybeSingle();
        const settings = (settingsRow?.proposal_settings ?? {}) as {
          email?: { from_name?: string; from_email?: string; team_notification_emails?: string[] };
        };
        const teamEmails = (settings.email?.team_notification_emails ?? []).filter(Boolean);
        // The sender is always notified, whatever the team list says.
        const recipients = await notificationRecipients(sb, teamEmails, "proposals", proposal.id);
        if (recipients.length > 0) {
          const origin = resolveOrigin(req);
          const company = proposal.client?.company_name ?? "a client";
          // Same shape as the signed email: who, the totals, and a way in.
          const proposalUrl = origin ? `${origin}/proposals/${proposal.id}` : null;
          const viewerName = (bundle.signerIndex === 2 ? proposal.recipient2_name : proposal.recipient_name)?.trim() || "";
          const viewerEmail = (bundle.signerIndex === 2 ? proposal.recipient2_email : proposal.recipient_email)?.trim() || "";
          const viewerLink = viewerEmail
            ? `<a href="mailto:${escapeHtml(viewerEmail)}" style="color:#4b3afe;text-decoration:underline;">${escapeHtml(viewerEmail)}</a>`
            : "";
          const totals = computeProposalTotals(bundle.lineItems, proposal);
          await sendEmail({
            to: recipients,
            from: resolveFromAddress(settings.email),
            subject: `Proposal viewed by ${company}`,
            html: proposalEmailHtml({
              heading: viewerName
                ? `${escapeHtml(viewerName)} opened the ${escapeHtml(company)} proposal`
                : `${escapeHtml(company)} just opened their proposal`,
              bodyLines: [
                `${proposalReferenceLink(origin, proposal)} was viewed for the first time${viewerLink ? ` by ${viewerLink}` : ""}.`,
                totalsEmailLine(totals),
              ],
              ctaLabel: proposalUrl ? "Open the proposal" : undefined,
              ctaUrl: proposalUrl ?? undefined,
              logoUrl: origin ? `${origin}/favicon.png` : undefined,
            }),
          });
        }
      }
    }

    const payload = await serializePublicProposal(sb, bundle);
    return proposalJson({ ok: true, ...payload, expired: isProposalExpired(proposal), correlationId });
  } catch (e) {
    return proposalJson(
      { ok: false, error: { code: "request_failed", message: e instanceof Error ? e.message : "Unknown error" }, correlationId },
      { status: 200 },
    );
  }
});
