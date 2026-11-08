import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createDraftAsPerson, type Attachment, type Mailbox, type SignatureState } from "./gmail.ts";
import { proposalEmailHtml, sendEmail } from "./mailer.ts";
import { proposalLink } from "./app-links.ts";

// Emails to clients are never sent by the app (2026-11-05, Zak: "at most, created
// as a draft in my email inbox, with me then slacked the link to the draft to
// review and then send"; Xiomara agreed). Each one is written as a draft in the
// sender's own Gmail, signature and attachments included, and the sender gets a
// Slack DM with a link that opens it. If Slack can't reach them, an email instead.

type Sb = SupabaseClient;

/** A DM from the ECD Slack app, through the Client Tracker (it holds the bot). */
export async function slackDm(email: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const url = Deno.env.get("HUB_ONBOARDING_URL") ?? "";
  const key = Deno.env.get("ONBOARDING_SHARED_KEY") ?? "";
  if (!url || !key) return { ok: false, error: "Slack isn't reachable from here (tracker settings missing)." };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-onboarding-key": key },
      body: JSON.stringify({ action: "slack_dm", email, text }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return { ok: Boolean(body.ok), error: body.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Slack's link format; the label can't contain "|" or ">". */
const slackLink = (url: string, label: string) => `<${url}|${label.replace(/[|>]/g, "")}>`;
const slackEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const htmlEsc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export type DraftNotice = {
  /** "Invoice INV-1234 for Burton", "Welcome email for Burton" */
  what: string;
  /** Who it's to, shown in the message. */
  to: string;
  /** Omitted only for a test draft, which has no proposal. */
  proposalId?: string;
  focus?: "welcome" | "xero";
  /** Things to check before sending (missing times, a custom deal...). */
  checks?: string[];
};

export type DraftResult = { url: string; draftId: string; signature: SignatureState; notified: "slack" | "email" | "none" };

/** Tells the sender a draft is waiting in their Gmail: Slack, else email. */
export async function notifyDraft(box: Mailbox, url: string, n: DraftNotice): Promise<"slack" | "email" | "none"> {
  const checks = n.checks?.filter(Boolean) ?? [];
  const text = [
    `:envelope_with_arrow: *${slackEsc(n.what)}* is drafted in your Gmail, to ${slackEsc(n.to)}. Nothing has gone to the client yet: check it and press Send.`,
    ...(checks.length ? ["*Check before sending:*", ...checks.map((c) => `• ${slackEsc(c)}`)] : []),
    n.proposalId
      ? `${slackLink(url, "Open the draft in Gmail")}  ·  ${slackLink(proposalLink(n.proposalId, n.focus), "Open the proposal")}`
      : slackLink(url, "Open the draft in Gmail"),
  ].join("\n");
  const dm = await slackDm(box.email, text);
  if (dm.ok) return "slack";
  console.warn("draft notice: Slack failed, emailing instead", dm.error);
  const mail = await sendEmail({
    to: [box.email],
    subject: `Draft to check and send: ${n.what}`,
    html: proposalEmailHtml({
      heading: `${htmlEsc(n.what)} is drafted in your Gmail`,
      bodyLines: [
        `It's to ${htmlEsc(n.to)}. Nothing has gone to the client yet: open the draft, check it and press Send.`,
        ...(checks.length ? [`Check before sending:<br>${checks.map((c) => `&bull; ${htmlEsc(c)}`).join("<br>")}`] : []),
      ],
      ctaLabel: "Open the draft in Gmail",
      ctaUrl: url,
    }),
  }).catch(() => ({ status: "failed" as const }));
  return mail.status === "sent" ? "email" : "none";
}

/** Writes the email as a draft in the sender's Gmail and tells them. */
export async function draftForClient(
  sb: Sb,
  box: Mailbox,
  mail: { fromName?: string | null; to: string[]; cc?: string[]; subject: string; html: string; text: string; attachments?: Attachment[] },
  notice: DraftNotice,
): Promise<DraftResult> {
  const d = await createDraftAsPerson(sb, box, mail);
  const notified = await notifyDraft(box, d.url, notice);
  return { url: d.url, draftId: d.draftId, signature: d.signature, notified };
}
