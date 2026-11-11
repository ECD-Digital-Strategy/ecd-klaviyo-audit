import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, hasCronSecret } from "../_shared/auth.ts";
import { requireOutreachOwner } from "../_shared/outreach-access.ts";
import { sendEmail } from "../_shared/mailer.ts";
import { advanceCursor, ImapSession, newUids, uidSet } from "../_shared/imap-search.ts";
import { decryptString, encryptString } from "../_shared/crypto.ts";
import { isRoleAddress } from "../_shared/outreach-contacts.ts";
import { crmConfigured, crmKnown, crmLog, crmSkipReason, type CrmKnown, type CrmLeadStatus } from "../_shared/outreach-crm.ts";
import {
  classifyReply,
  pendingReplies,
  replyAction,
  staleClaimDecision,
  UNSORTED,
  type ReplyVerdict,
} from "../_shared/outreach-replies.ts";
import { extractGmailSignature, isAutoReply, mailHeader, mailHtml, matchMessage, parseMail } from "../_shared/mail-parse.ts";
import { imapDate } from "../_shared/imap-search.ts";
import { gmailSignature, NeedsReconnect } from "../_shared/gmail.ts";
import { mailboxByEmail } from "../_shared/invoice-delivery.ts";
import { OUTREACH_OWNER_EMAIL } from "../_shared/outreach-access.ts";
import {
  followUp,
  footer,
  inSendWindow,
  plainHtml,
  replySearchKey,
  startOfSendDay,
  withSignature,
  withoutCompanyLine,
} from "../_shared/outreach-email.ts";

// Outreach, step 2 (Emil, 2026-11-02): sends the outreach emails as Emil through
// Gmail. The mailbox and its app password are connected on the Outreach page
// ("connect_mailbox": checked by signing in, stored encrypted in app_secrets, never
// sent back to the browser). The same login reads his inbox for replies and
// bounces. Everything else is set on the page's Settings tab (outreach_settings):
//  - at most daily_new_cap first emails per US weekday, min_gap_minutes apart,
//    between send_start_hour and send_end_hour New York time;
//  - up to max_followups short follow-ups, followup_gap_days apart, threaded
//    under the first email;
//  - his Gmail signature (signature_html) under every email;
// and these always hold:
//  - anything from them (a reply, out-of-office, "no") stops the sequence;
//  - any bounce, or Gmail refusing the password, pauses ALL sending until Emil
//    looks (the hourly health check emails him about the pause);
//  - no follow-up goes out unless the inbox could be read.
// Replies (2026-11-02): each new message from them is read and sorted
// (_shared/outreach-replies.ts). Interested, a question, a referral or "later"
// stops the sequence and emails Emil an alert; "no" or "remove me" also puts the
// domain on the do-not-contact list (outreach_suppressions) for good; an
// out-of-office lets the sequence carry on. Emailed prospects, a line per email both
// ways and their lead status go into the ECD CRM (_shared/outreach-crm.ts; HubSpot
// until 2026-11-11, when Zak asked for Outreach to stop using HubSpot).
// Actions: "status", "connect_mailbox", "disconnect_mailbox", "save_settings",
// "send_now" and "test_send" (Emil, from the Outreach page); "tick" (the
// outreach-autopilot cron, every 20 minutes).

const REPORT_BASE = "https://audit.ecdigitalstrategy.com/report/";
// As his Gmail shows him, and as his signature spells it.
const SENDER_NAME = "Emil Gjorgjijev";
const MAILBOX_SECRET = "outreach_mailbox";

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

type Sb = ReturnType<typeof assertServiceRoleClient>;
type Mailbox = { user: string; pass: string };
type Settings = {
  paused: boolean;
  pause_reason: string | null;
  daily_new_cap: number;
  booking_url: string | null;
  max_followups: number;
  followup_gap_days: number;
  send_start_hour: number;
  send_end_hour: number;
  min_gap_minutes: number;
  signature_html: string | null;
  /** When the signature was last read from his Gmail (it follows Gmail, not a copy typed here). */
  signature_synced_at: string | null;
  /** Log emailed prospects and each email in the ECD CRM. */
  crm_log: boolean;
  reply_alerts: boolean;
  hot_lead_views: number;
  about_intro: string | null;
  auto_pipeline: boolean;
  auto_audits_per_day: number;
  min_lead_score: number;
  /** Inbox cursor (2026-11-10): All Mail's UIDVALIDITY and the last UID fully handled. */
  inbox_uidvalidity: number | null;
  inbox_last_uid: number | null;
};
const DEFAULT_SETTINGS: Settings = {
  paused: false,
  pause_reason: null,
  daily_new_cap: 3,
  booking_url: null,
  max_followups: 1,
  followup_gap_days: 3,
  send_start_hour: 9,
  send_end_hour: 16,
  min_gap_minutes: 45,
  signature_html: null,
  signature_synced_at: null,
  crm_log: true,
  reply_alerts: true,
  hot_lead_views: 3,
  about_intro: null,
  auto_pipeline: false,
  auto_audits_per_day: 3,
  min_lead_score: 40,
  inbox_uidvalidity: null,
  inbox_last_uid: null,
};
type Prospect = {
  id: string;
  domain: string;
  store_name: string | null;
  contact_name: string | null;
  contact_email: string | null;
  status: string;
  audit_id: string | null;
  email_subject: string | null;
  email_body: string | null;
  sent_at: string | null;
  last_sent_at: string | null;
  message_id: string | null;
  followups_sent: number;
  contact_title?: string | null;
  replies_seen?: number;
  report_views?: number;
  /** CRM records Outreach created (records that were already there are never stored here). */
  crm_contact_id?: string | null;
  crm_company_id?: string | null;
};

/** The connected mailbox, decrypted here only, or null. */
async function mailbox(sb: Sb): Promise<Mailbox | null> {
  const { data } = await sb.from("app_secrets").select("ciphertext, iv").eq("key", MAILBOX_SECRET).maybeSingle();
  if (!data?.ciphertext || !data?.iv) return null;
  try {
    const box = JSON.parse(await decryptString(data.ciphertext, data.iv)) as Partial<Mailbox>;
    return box.user && box.pass ? { user: box.user, pass: box.pass } : null;
  } catch {
    return null;
  }
}

async function loadSettings(sb: Sb): Promise<Settings> {
  const { data } = await sb.from("outreach_settings").select("*").eq("id", "default").maybeSingle();
  return { ...DEFAULT_SETTINGS, ...((data as Partial<Settings> | null) ?? {}) };
}

async function pause(sb: Sb, reason: string) {
  await sb.from("outreach_settings").update({ paused: true, pause_reason: reason.slice(0, 300), updated_at: new Date().toISOString() }).eq("id", "default");
}

async function sentToday(sb: Sb, now: Date): Promise<{ initial: number; lastInitialAt: number }> {
  const { data } = await sb
    .from("outreach_sends")
    .select("sent_at")
    .eq("kind", "initial")
    .eq("status", "sent")
    .gte("sent_at", startOfSendDay(now).toISOString())
    .order("sent_at", { ascending: false });
  const rows = (data ?? []) as Array<{ sent_at: string }>;
  return { initial: rows.length, lastInitialAt: rows[0] ? Date.parse(rows[0].sent_at) : 0 };
}

async function reportUrl(sb: Sb, p: Prospect): Promise<string | null> {
  if (!p.audit_id) return null;
  const { data } = await sb.from("audits").select("public_share_token").eq("id", p.audit_id).maybeSingle();
  const token = (data as { public_share_token?: string | null } | null)?.public_share_token;
  return token ? `${REPORT_BASE}${token}` : null;
}

/**
 * The prospect and one email into the ECD CRM, best effort: a failure is noted on the
 * prospect (crm_error), never thrown. Ids are saved only for records Outreach created;
 * a person or company that was already in the CRM only gets the history line, and its
 * lead status is never touched (same rule as HubSpot had, audit 2026-11-10).
 */
async function logToCrm(
  sb: Sb,
  settings: Settings,
  p: Prospect,
  email: { event: "sent" | "followup" | "reply"; subject: string; note?: string },
  status?: CrmLeadStatus,
) {
  if (!settings.crm_log || !p.contact_email) return;
  try {
    const [first, ...rest] = (p.contact_name ?? "").trim().split(/\s+/);
    const r = await crmLog({
      domain: p.domain,
      email: p.contact_email,
      store_name: p.store_name,
      first_name: first || null,
      last_name: rest.join(" ") || null,
      title: p.contact_title ?? null,
      contact_id: p.crm_contact_id ?? null,
      company_id: p.crm_company_id ?? null,
      event: email.event,
      subject: email.subject,
      note: email.note ?? null,
      lead_status: status ?? null,
    });
    const patch: Record<string, unknown> = { crm_error: null };
    if (r.owns_company) patch.crm_company_id = p.crm_company_id = r.company_id;
    if (r.owns_contact) patch.crm_contact_id = p.crm_contact_id = r.contact_id;
    await sb.from("outreach_prospects").update(patch).eq("id", p.id);
  } catch (e) {
    await sb.from("outreach_prospects").update({ crm_error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }).eq("id", p.id);
  }
}

/** On the do-not-contact list: someone at this company said no. */
async function suppressed(sb: Sb, domain: string): Promise<boolean> {
  const { data } = await sb.from("outreach_suppressions").select("domain").eq("domain", domain).maybeSingle();
  return Boolean(data);
}

const KIND_LABEL: Record<string, string> = {
  interested: "Interested",
  question: "Has a question",
  referral: "Pointed you to someone else",
  not_now: "Not now",
  not_interested: "Not interested",
  unsubscribe: "Asked to be removed",
  out_of_office: "Out of office",
  other: "Replied",
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Emails Emil about a reply worth answering (from the app's own mailer, not his mailbox). */
async function alertEmil(p: Prospect, verdict: ReplyVerdict, mail: { from: string; subject: string; text: string }, report: string | null) {
  const label = KIND_LABEL[verdict.kind] ?? "Replied";
  const gmail = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(`from:${p.contact_email ?? p.domain}`)}`;
  const html = [
    `<p style="font-size:15px"><b>${esc(p.store_name || p.domain)}</b> replied: <b>${esc(label)}</b></p>`,
    `<p>${esc(verdict.summary)}</p>`,
    `<blockquote style="margin:12px 0;padding:8px 12px;border-left:3px solid #ddd;color:#444;white-space:pre-wrap">${esc(mail.text.slice(0, 2000))}</blockquote>`,
    `<p style="color:#666;font-size:13px">From ${esc(mail.from)}${p.contact_title ? `, ${esc(p.contact_title)}` : ""}.`,
    (p.report_views ?? 0) > 0 ? ` They opened their report ${p.report_views} time${p.report_views === 1 ? "" : "s"}.` : "",
    `</p>`,
    `<p><a href="${gmail}">Answer in Gmail</a>${report ? ` &middot; <a href="${report}?preview=1">Their report</a>` : ""} &middot; <a href="https://audit.ecdigitalstrategy.com/outreach?tab=prospects">Outreach page</a></p>`,
  ].join("");
  await sendEmail({ to: [OUTREACH_OWNER_EMAIL], subject: `Outreach reply: ${p.store_name || p.domain} (${label})`, html });
}

const looksLikeAuthFailure = (reason: string) => /auth|535|534|password|credentials|login/i.test(reason);

/** The first email's text: his drafted email, then the opt-out line. With his own
 * signature underneath, the drafted company line under his name is dropped. */
function initialText(body: string, settings: Settings): string {
  const main = settings.signature_html?.trim() ? withoutCompanyLine(body.trim()) : body.trim();
  return `${main}\n\n${footer()}`;
}

/** Sends one email as Emil, with his signature. */
async function sendAs(
  box: Mailbox,
  settings: Settings,
  to: string,
  subject: string,
  text: string,
  thread?: { messageId: string; inReplyTo?: string | null },
) {
  return await sendEmail({
    to: [to],
    from: `${SENDER_NAME} <${box.user}>`,
    subject,
    html: withSignature(plainHtml(text), settings.signature_html),
    smtp: box,
    ...(thread ? { messageId: thread.messageId } : {}),
    ...(thread?.inReplyTo ? { inReplyTo: thread.inReplyTo } : {}),
  });
}

/** Sends one outreach email and records it. Pauses everything if Gmail refuses the password. */
async function deliver(
  sb: Sb,
  box: Mailbox,
  settings: Settings,
  p: Prospect,
  kind: "initial" | "followup_1" | "followup_2",
  subject: string,
  text: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const to = String(p.contact_email ?? "").trim();
  const messageId = `<outreach-${crypto.randomUUID()}@ecdigitalstrategy.com>`;
  const result = await sendAs(box, settings, to, subject, text, {
    messageId,
    inReplyTo: kind !== "initial" ? p.message_id : null,
  });
  const ok = result.status === "sent";
  const error = ok ? undefined : (result as { reason?: string }).reason ?? "not sent";
  await sb.from("outreach_sends").insert({ prospect_id: p.id, kind, to_email: to, subject, message_id: messageId, status: ok ? "sent" : "failed", error: error ?? null });
  if (!ok && error && looksLikeAuthFailure(error)) {
    await pause(sb, `Gmail refused the outreach mailbox sign-in: ${error}`);
  }
  return ok ? { ok, messageId } : { ok, error };
}

/** "https://www.Brand.com/x" -> "brand.com", as outreach_screen reads client websites. */
function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const raw = url.trim().toLowerCase();
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** A past or current client with this website (not an Outreach prospect row), as outreach_screen decides it. */
async function isClient(sb: Sb, domain: string): Promise<boolean> {
  const { data, error } = await sb
    .from("clients")
    .select("website_url")
    .eq("is_outreach", false)
    .ilike("website_url", `%${domain.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    .limit(20);
  if (error) throw new Error(`clients could not be checked: ${error.message}`);
  return (data ?? []).some((c) => hostOf((c as { website_url: string | null }).website_url) === domain);
}

type SendCheck = { ok: true } | { ok: false; outcome: "blocked" | "retry"; error: string };

/**
 * Checked again right before a first email goes out (audit 2026-11-10), not only
 * at screening: the do-not-contact list, past clients, and the ECD CRM (the exact
 * address as a contact, the domain as anything the CRM knows). A CRM record Outreach
 * did not create blocks it for good; the CRM unreachable means not this run.
 */
async function sendTimeCheck(sb: Sb, p: Prospect): Promise<SendCheck> {
  const email = String(p.contact_email ?? "").trim().toLowerCase();
  try {
    if (await suppressed(sb, p.domain)) return { ok: false, outcome: "blocked", error: "Someone at this company asked not to be contacted." };
    if (await isClient(sb, p.domain)) return { ok: false, outcome: "blocked", error: "Already a client (found at send time)." };
  } catch (e) {
    return { ok: false, outcome: "retry", error: `Not sent yet, the do-not-contact checks could not run: ${e instanceof Error ? e.message : String(e)}` };
  }
  let known: CrmKnown;
  try {
    known = await crmKnown([p.domain], email ? [email] : []);
  } catch (e) {
    return { ok: false, outcome: "retry", error: `Not sent yet: the CRM could not be checked (${e instanceof Error ? e.message : String(e)}).` };
  }
  const own = { contactId: p.crm_contact_id, companyId: p.crm_company_id };
  if (crmSkipReason(known.emails[email], own)) {
    return { ok: false, outcome: "blocked", error: `${email} is already a contact in the CRM (found at send time).` };
  }
  const byDomain = crmSkipReason(known.domains[p.domain], own);
  if (byDomain) return { ok: false, outcome: "blocked", error: `${byDomain} (found at send time).` };
  return { ok: true };
}

type InitialResult =
  | { ok: true; messageId?: string }
  | { ok: false; error: string; outcome: "invalid" | "blocked" | "retry" | "busy" };

async function sendInitial(sb: Sb, box: Mailbox, p: Prospect, settings: Settings): Promise<InitialResult> {
  if (!p.contact_email?.includes("@")) return { ok: false, outcome: "invalid", error: "Add their email first." };
  // A decision-maker only: never a support or info inbox (Emil, 2026-11-02).
  if (isRoleAddress(p.contact_email)) return { ok: false, outcome: "invalid", error: `${p.contact_email} is a shared inbox, not a person. Find the decision-maker first.` };
  if (!p.email_subject?.trim() || !p.email_body?.trim()) return { ok: false, outcome: "invalid", error: "The email is empty." };
  if (p.sent_at) return { ok: false, outcome: "busy", error: "Already sent." };
  const check = await sendTimeCheck(sb, p);
  if (!check.ok) {
    if (check.outcome === "blocked") {
      // Excluded for good, like a store screened out: never sent.
      await sb.from("outreach_prospects").update({ status: "skipped", skip_reason: check.error }).eq("id", p.id).is("sent_at", null);
    }
    return check;
  }
  const subject = p.email_subject.trim();
  const text = initialText(p.email_body, settings);
  // Take it first: sent_at is set only if nobody else set it, so "Send now" and the
  // scheduled run can never both send the same first email (audit, 2026-11-08).
  const claimedAt = new Date().toISOString();
  const { data: mine } = await sb
    .from("outreach_prospects")
    .update({ sent_at: claimedAt })
    .eq("id", p.id)
    .is("sent_at", null)
    .select("id");
  if (!mine?.length) return { ok: false, outcome: "busy", error: "Already sent." };
  const r = await deliver(sb, box, settings, p, "initial", subject, text);
  if (!r.ok) {
    // Not sent: free it again so it can be retried.
    await sb.from("outreach_prospects").update({ sent_at: null }).eq("id", p.id).eq("sent_at", claimedAt);
    return { ok: false, outcome: "retry", error: r.error ?? "not sent" };
  }
  const now = new Date().toISOString();
  await sb.from("outreach_prospects").update({ status: "sent", sent_at: now, last_sent_at: now, message_id: r.messageId }).eq("id", p.id);
  await logToCrm(sb, settings, p, { event: "sent", subject }, "ATTEMPTED_TO_CONTACT");
  return { ok: true, messageId: r.messageId };
}

/**
 * Acts on one new message from a prospect: sorts it, then stops, remembers, alerts
 * and logs as it says. Returns true only when the sequence carries on (an away
 * message, or a machine reply by its headers). Anything unsorted stops it and
 * alerts Emil, so nobody is chased by mistake (audit 2026-11-10).
 */
async function handleReply(
  sb: Sb,
  settings: Settings,
  box: Mailbox,
  p: Prospect,
  seen: number,
  mail: { from: string; subject: string; text: string },
  autoReply: boolean,
): Promise<boolean> {
  let verdict: ReplyVerdict;
  try {
    verdict = await classifyReply(mail.text, mail.subject);
  } catch {
    verdict = UNSORTED;
  }
  const decision = replyAction(verdict, autoReply);
  const now = new Date().toISOString();
  const reply = { reply_kind: verdict.kind, reply_summary: verdict.summary, reply_text: mail.text.slice(0, 4000), replies_seen: seen };

  if (decision.action === "pass") {
    // An away message or an automatic receipt: the sequence carries on.
    await sb.from("outreach_prospects").update(reply).eq("id", p.id);
    return true;
  }
  const stop = decision.action === "suppress";
  await sb.from("outreach_prospects").update({ ...reply, status: stop ? "unsubscribed" : "replied", replied_at: now }).eq("id", p.id);
  if (stop) {
    await sb.from("outreach_suppressions").upsert(
      { domain: p.domain, email: p.contact_email, reason: `${KIND_LABEL[verdict.kind]}: ${verdict.summary}`.slice(0, 300) },
      { onConflict: "domain" },
    );
  }
  const status: CrmLeadStatus = stop ? "UNQUALIFIED" : verdict.kind === "not_now" ? "BAD_TIMING" : "CONNECTED";
  await logToCrm(sb, settings, p, {
    event: "reply",
    subject: mail.subject || `Re: ${p.email_subject ?? ""}`,
    note: `Replied (${KIND_LABEL[verdict.kind] ?? "Replied"}): ${verdict.summary}`,
  }, status);
  if (settings.reply_alerts && decision.alert) {
    await alertEmil(p, verdict, mail, await reportUrl(sb, p)).catch(() => {});
  }
  return false;
}

/**
 * His Gmail signature, read from the newest email he wrote in Gmail (Emil,
 * 2026-11-02: "I already updated it in my Gmail, can you just fetch it"). Emails
 * this tool sent are skipped, so an old saved copy can never feed itself back.
 * Null when none of his recent emails carries one.
 */
async function fetchGmailSignature(box: Mailbox): Promise<string | null> {
  const imap = await ImapSession.open(box);
  try {
    const since = new Date(Date.now() - 120 * 86_400_000);
    const seqs = await imap.search(`SINCE ${imapDate(since)} FROM "${box.user.replace(/"/g, "")}"`);
    for (const seq of seqs.slice(-15).reverse()) {
      const raw = await imap.fetchRaw(seq, 150_000);
      const id = mailHeader(raw, "message-id");
      const subject = mailHeader(raw, "subject");
      if (/outreach-/i.test(id) || /^\[test\]|^test: your outreach/i.test(subject)) continue;
      const html = mailHtml(raw);
      const sig = html ? extractGmailSignature(html) : null;
      if (sig) return sig.slice(0, 30_000);
    }
    return null;
  } finally {
    await imap.close();
  }
}

/**
 * The signature, from the best source there is: Gmail's own signature setting,
 * through his "Connect Gmail" sign-in (Proposal settings); else the newest email
 * he wrote in Gmail that carries one. needsReconnect: his Google sign-in predates
 * the read-signature permission, so one reconnect is needed.
 */
async function syncSignature(
  sb: Sb,
  box: Mailbox,
): Promise<{ ok: boolean; changed?: boolean; error?: string; needsReconnect?: boolean; source?: "settings" | "sent_mail" }> {
  let sig: string | null = null;
  let source: "settings" | "sent_mail" = "settings";
  let needsReconnect = false;
  const google = await mailboxByEmail(sb, box.user);
  if (google) {
    try {
      sig = await gmailSignature(sb, google);
    } catch (e) {
      if (e instanceof NeedsReconnect) needsReconnect = true;
    }
  }
  if (!sig) {
    source = "sent_mail";
    sig = await fetchGmailSignature(box).catch(() => null);
  }
  const now = new Date().toISOString();
  if (!sig) {
    // Still mark it checked, so the daily try does not hammer the inbox.
    await sb.from("outreach_settings").update({ signature_synced_at: now }).eq("id", "default");
    return {
      ok: false,
      needsReconnect: needsReconnect || !google,
      error: needsReconnect || !google
        ? "To read the signature set in your Gmail, connect your Google account once (it only asks to read settings and send email)."
        : "Your Gmail has no signature set. Add one in Gmail (Settings, General, Signature), then refresh.",
    };
  }
  const { signature_html } = await loadSettings(sb);
  await sb.from("outreach_settings").update({ signature_html: sig.slice(0, 30_000), signature_synced_at: now, updated_at: now }).eq("id", "default");
  return { ok: true, changed: sig !== signature_html, source };
}

/** Someone who keeps opening their report without answering is worth a call:
 * one email to Emil when they reach hot_lead_views opens. */
async function hotLeads(sb: Sb, settings: Settings) {
  if (settings.hot_lead_views <= 0) return;
  const { data } = await sb
    .from("outreach_prospects")
    .select("*")
    .eq("status", "sent")
    .is("hot_alert_at", null)
    .gte("report_views", settings.hot_lead_views);
  for (const p of (data ?? []) as Prospect[]) {
    await sb.from("outreach_prospects").update({ hot_alert_at: new Date().toISOString() }).eq("id", p.id);
    const report = await reportUrl(sb, p);
    const who = p.contact_name ? `${esc(p.contact_name)}${p.contact_title ? `, ${esc(p.contact_title)},` : ""}` : "They";
    const html = [
      `<p style="font-size:15px"><b>${esc(p.store_name || p.domain)}</b> keeps opening their report.</p>`,
      `<p>${who} opened it ${p.report_views} times and has not replied yet. A good moment for a short personal note or a call.</p>`,
      `<p>${report ? `<a href="${report}?preview=1">Their report</a> &middot; ` : ""}<a href="https://audit.ecdigitalstrategy.com/outreach?tab=prospects">Outreach page</a></p>`,
    ].join("");
    await sendEmail({ to: [OUTREACH_OWNER_EMAIL], subject: `Outreach: ${p.store_name || p.domain} opened their report ${p.report_views} times`, html }).catch(() => {});
  }
}

// Each new message is read and sorted, oldest first, up to this many per prospect
// per run in the per-prospect scan; the rest wait for the next run (and hold that
// prospect's follow-ups).
const MAX_REPLIES_PER_PROSPECT = 5;
// The cron allows about 120s per run; the inbox gets this much of it. The IMAP
// session enforces it on every read, so a stalled connection can't outlast it.
const INBOX_BUDGET_MS = 70_000;
// New messages looked at per run with the inbox cursor; the rest next run.
const MAX_NEW_MESSAGES = 50;
// Fetched for every new message in one round trip; bodies only for prospects' mail.
const HEADER_FIELDS = [
  "FROM",
  "REPLY-TO",
  "MESSAGE-ID",
  "IN-REPLY-TO",
  "REFERENCES",
  "AUTO-SUBMITTED",
  "PRECEDENCE",
  "LIST-UNSUBSCRIBE",
  "X-AUTOREPLY",
  "X-AUTORESPOND",
];

/** A prospect a new message may be from. claimed: a first email is being sent or
 * a dead run's send is not sorted out yet (status approved, sent_at set). */
type InboxCandidate = Prospect & {
  contactEmail: string | null;
  messageIds: string[];
  inSequence: boolean;
  sentAt: number | null;
  claimed: boolean;
};

/** Prospects in a sequence (sent, emailed in the last 45 days) and claimed first
 * emails, with every Message-ID we sent them. Null when the database can't say. */
async function inboxCandidates(sb: Sb): Promise<InboxCandidate[] | null> {
  const [sent, claimed] = await Promise.all([
    sb.from("outreach_prospects").select("*").eq("status", "sent").gte("sent_at", new Date(Date.now() - 45 * 86_400_000).toISOString()),
    sb.from("outreach_prospects").select("*").eq("status", "approved").not("sent_at", "is", null),
  ]);
  if (sent.error || claimed.error) return null;
  const rows = [
    ...((sent.data ?? []) as Prospect[]).map((p) => ({ p, claimed: false })),
    ...((claimed.data ?? []) as Prospect[]).map((p) => ({ p, claimed: true })),
  ];
  const ids = new Map<string, string[]>();
  if (rows.length) {
    const { data, error } = await sb
      .from("outreach_sends")
      .select("prospect_id, message_id")
      .in("prospect_id", rows.map((r) => r.p.id))
      .eq("status", "sent");
    if (error) return null;
    for (const s of (data ?? []) as Array<{ prospect_id: string; message_id: string | null }>) {
      if (s.message_id) ids.set(s.prospect_id, [...(ids.get(s.prospect_id) ?? []), s.message_id]);
    }
  }
  return rows.map(({ p, claimed }) => ({
    ...p,
    contactEmail: p.contact_email,
    messageIds: [...(p.message_id ? [p.message_id] : []), ...(ids.get(p.id) ?? [])],
    inSequence: !claimed,
    sentAt: p.sent_at ? Date.parse(p.sent_at) : null,
    claimed,
  }));
}

async function saveCursor(sb: Sb, uidValidity: number, lastUid: number): Promise<boolean> {
  const { error } = await sb.from("outreach_settings").update({ inbox_uidvalidity: uidValidity, inbox_last_uid: lastUid }).eq("id", "default");
  return !error;
}

async function markBounced(sb: Sb, p: Prospect) {
  await sb.from("outreach_prospects").update({ status: "bounced" }).eq("id", p.id);
  await pause(sb, `${p.contact_email} (${p.domain}) bounced. Sending is paused until you check the address list.`);
}

/**
 * Replies and bounces since each prospect was emailed. ok=false if the inbox could
 * not be read in full this run: then no follow-up goes out at all.
 * Since 2026-11-10 each run reads only mail that is new since the last run (an
 * inbox cursor on outreach_settings); the per-prospect scan runs only when there
 * is no cursor yet or Gmail renumbered the mailbox (UIDVALIDITY changed).
 */
async function checkInbox(sb: Sb, box: Mailbox): Promise<boolean> {
  const deadline = Date.now() + INBOX_BUDGET_MS;
  const cands = await inboxCandidates(sb);
  if (!cands) return false;
  const settings = await loadSettings(sb);
  let imap: ImapSession;
  try {
    imap = await ImapSession.open(box, { deadline });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (looksLikeAuthFailure(msg)) await pause(sb, `Gmail refused the outreach mailbox sign-in (inbox): ${msg}`);
    // Nobody to protect: nothing is held up.
    return cands.length === 0;
  }
  try {
    const validity = imap.uidValidity;
    const max = await imap.maxUid();
    const hasCursor = validity !== null && settings.inbox_uidvalidity === validity && settings.inbox_last_uid !== null;
    if (!hasCursor) {
      const complete = await scanPerProspect(sb, settings, box, imap, cands.filter((c) => !c.claimed), max, deadline);
      // The cursor starts where the scan stopped looking. Not while a first email is
      // claimed: its replies would fall behind the cursor, so scan again next run.
      // A failed save only means the next run scans again.
      if (complete && validity !== null && !cands.some((c) => c.claimed)) await saveCursor(sb, validity, max);
      return complete;
    }
    if (cands.length === 0) {
      // Nobody in a sequence: everything so far is not a prospect's.
      if (max > settings.inbox_last_uid!) await saveCursor(sb, validity!, max);
      return true;
    }
    return await readNewMail(sb, settings, box, imap, cands, validity!, settings.inbox_last_uid!, deadline);
  } catch {
    return false;
  } finally {
    await imap.close();
  }
}

/**
 * One pass over the mail that arrived since the cursor, oldest first: headers for
 * all of it in one fetch, bodies only for prospects' mail, each classified as
 * before. The cursor moves past each message once it is fully handled and stops at
 * the first one that can't be (read again next run; no follow-ups this run).
 */
async function readNewMail(
  sb: Sb,
  settings: Settings,
  box: Mailbox,
  imap: ImapSession,
  cands: InboxCandidate[],
  validity: number,
  last: number,
  deadline: number,
): Promise<boolean> {
  const { batch, more } = newUids(await imap.uidSearch(`UID ${last + 1}:*`), last, MAX_NEW_MESSAGES);
  if (!batch.length) return true;
  const heads = await imap.fetchHeaders(batch, HEADER_FIELDS);
  // Not in the fetch: gone from All Mail (trashed or deleted) unless a search still finds it.
  const missing = batch.filter((u) => !heads.has(u));
  const stillThere = new Set(missing.length ? await imap.uidSearch(`UID ${uidSet(missing)}`) : []);
  const live = [...cands];
  const results: Array<{ uid: number; handled: boolean }> = [];
  let saved = last;
  for (const uid of batch) {
    if (Date.now() > deadline) break;
    const h = heads.get(uid);
    const outcome = h ? await handleNewMessage(sb, settings, box, imap, live, uid, h) : stillThere.has(uid) ? "unhandled" : "skipped";
    results.push({ uid, handled: outcome !== "unhandled" });
    if (outcome === "unhandled") break;
    if (outcome === "handled") {
      // Saved straight away, so a run cut off later never handles it twice.
      if (!(await saveCursor(sb, validity, uid))) return false;
      saved = uid;
    }
  }
  const cursor = advanceCursor(last, results);
  if (cursor > saved && !(await saveCursor(sb, validity, cursor))) return false;
  return !more && results.length === batch.length && results.every((r) => r.handled);
}

/** One new message: a bounce, a prospect's reply (classified), or not ours. */
async function handleNewMessage(
  sb: Sb,
  settings: Settings,
  box: Mailbox,
  imap: ImapSession,
  live: InboxCandidate[],
  uid: number,
  h: { header: string; internalDate: number | null },
): Promise<"handled" | "skipped" | "unhandled"> {
  const from = mailHeader(h.header, "from");
  const heads = {
    from,
    replyTo: mailHeader(h.header, "reply-to"),
    inReplyTo: mailHeader(h.header, "in-reply-to"),
    references: mailHeader(h.header, "references"),
    internalDate: h.internalDate,
  };
  const drop = (p: InboxCandidate) => live.splice(live.indexOf(p), 1);
  if (/mailer-daemon/i.test(from)) {
    // A bounce: whose address it names (or whose email it answers).
    const raw = await imap.fetchRawUid(uid);
    if (!raw) return "unhandled";
    const text = raw.toLowerCase();
    const thread = matchMessage(heads, live, box.user);
    const p = thread?.by === "thread"
      ? thread.prospect
      : live.find((c) => c.contact_email && text.includes(c.contact_email.trim().toLowerCase()));
    if (!p) return "skipped";
    if (p.claimed) return "unhandled";
    await markBounced(sb, p);
    drop(p);
    return "handled";
  }
  const match = matchMessage(heads, live, box.user);
  if (!match) return "skipped";
  const p = match.prospect;
  // Wait until the claimed first email is sorted out (reconcileStaleClaims).
  if (p.claimed) return "unhandled";
  const raw = await imap.fetchRawUid(uid);
  if (!raw) return "unhandled";
  // replies_seen counts what the per-prospect scan's FROM search would find, so a
  // later scan (new UIDVALIDITY) never skips a message it hasn't seen.
  const counted = Boolean(p.contact_email) && from.toLowerCase().includes(replySearchKey(p.contact_email!, p.domain));
  const seen = (p.replies_seen ?? 0) + (counted ? 1 : 0);
  p.replies_seen = seen;
  if (!(await handleReply(sb, settings, box, p, seen, parseMail(raw), isAutoReply(raw)))) drop(p);
  return "handled";
}

/**
 * The per-prospect scan (before 2026-11-10 it ran every time): per prospect, a
 * bounce search and a FROM search since they were emailed, then each message past
 * replies_seen. Only mail up to maxUid, where the cursor will start.
 */
async function scanPerProspect(
  sb: Sb,
  settings: Settings,
  box: Mailbox,
  imap: ImapSession,
  sent: InboxCandidate[],
  maxUid: number,
  deadline: number,
): Promise<boolean> {
  let complete = true;
  for (const p of sent) {
    if (!p.contact_email || !p.sent_at) continue;
    if (Date.now() > deadline) {
      // Out of time: the rest are read next run, and no follow-up goes out now.
      return false;
    }
    const since = new Date(p.sent_at);
    if ((await imap.bounceUids(p.contact_email, since, maxUid)).length > 0) {
      await markBounced(sb, p);
      continue;
    }
    const uids = await imap.replyUids(replySearchKey(p.contact_email, p.domain), since, maxUid);
    const seen = p.replies_seen ?? 0;
    const todo = pendingReplies(uids, seen, MAX_REPLIES_PER_PROSPECT);
    // Every new message, oldest first; the first one that is not an away
    // message stops the sequence and the rest are not needed.
    let read = seen;
    let stopped = false;
    for (const uid of todo) {
      if (Date.now() > deadline) break;
      const raw = await imap.fetchRawUid(uid);
      if (!raw) break;
      read += 1;
      if (!(await handleReply(sb, settings, box, p, read, parseMail(raw), isAutoReply(raw)))) {
        stopped = true;
        break;
      }
    }
    // Unread messages left (over the cap or out of time): no follow-up this run.
    if (!stopped && read < uids.length) complete = false;
  }
  return complete;
}

async function tick(sb: Sb) {
  const box = await mailbox(sb);
  if (!box) return { ok: true, skipped: "mailbox_not_connected" };
  const now = new Date();
  const reconciled = await reconcileStaleClaims(sb, box).catch(() => [] as string[]);
  const inboxOk = await checkInbox(sb, box);
  let settings = await loadSettings(sb);
  await hotLeads(sb, settings);
  // Once a day, pick up any change he made to his signature in Gmail.
  if (!settings.signature_synced_at || Date.now() - Date.parse(settings.signature_synced_at) > 86_400_000) {
    await syncSignature(sb, box).catch(() => null);
    settings = await loadSettings(sb);
  }
  if (settings.paused) return { ok: true, skipped: "paused", reason: settings.pause_reason };
  if (!inSendWindow(now, settings.send_start_hour, settings.send_end_hour)) {
    return { ok: true, skipped: "outside_send_window", inbox: inboxOk };
  }
  const sent: string[] = [];

  // Follow-ups, only when the inbox could be read: never chase someone who may have replied.
  if (inboxOk && settings.max_followups > 0) {
    const { data } = await sb.from("outreach_prospects").select("*").eq("status", "sent").lt("followups_sent", settings.max_followups);
    for (const p of (data ?? []) as Prospect[]) {
      if (!p.last_sent_at || now.getTime() - Date.parse(p.last_sent_at) < settings.followup_gap_days * 86_400_000) continue;
      // Put on the do-not-contact list since the first email: no more follow-ups.
      if (await suppressed(sb, p.domain)) continue;
      const url = await reportUrl(sb, p);
      if (!url || !p.email_subject) continue;
      const n = (p.followups_sent + 1) as 1 | 2;
      const text = followUp(n, {
        firstName: p.contact_name?.split(" ")[0] ?? null,
        brand: p.store_name || p.domain,
        reportUrl: url,
        bookingUrl: settings.booking_url,
      });
      const subject = /^re:/i.test(p.email_subject) ? p.email_subject : `Re: ${p.email_subject}`;
      // Take this follow-up first, so two overlapping runs can't both send it.
      const { data: mine } = await sb
        .from("outreach_prospects")
        .update({ followups_sent: n })
        .eq("id", p.id)
        .eq("followups_sent", p.followups_sent)
        .select("id");
      if (!mine?.length) continue;
      const r = await deliver(sb, box, settings, p, n === 1 ? "followup_1" : "followup_2", subject, text);
      if (!r.ok) {
        await sb.from("outreach_prospects").update({ followups_sent: p.followups_sent }).eq("id", p.id).eq("followups_sent", n);
        // A refused sign-in pauses everything: then no first email this run either.
        settings = await loadSettings(sb);
        if (settings.paused) return { ok: true, sent, paused: true, reason: settings.pause_reason };
        break;
      }
      await sb.from("outreach_prospects").update({ last_sent_at: new Date().toISOString() }).eq("id", p.id);
      await logToCrm(sb, settings, p, { event: "followup", subject: `Follow-up ${n}: ${subject}` });
      sent.push(`${p.domain}: follow-up ${n}`);
      if ((await loadSettings(sb)).paused) return { ok: true, sent, paused: true };
    }
  }

  // At most one first email per run, within the daily limit and spacing.
  const today = await sentToday(sb, now);
  if (today.initial < settings.daily_new_cap && now.getTime() - today.lastInitialAt >= settings.min_gap_minutes * 60_000) {
    // Only unclaimed ones: a claim left by a dead run is sorted out above, and
    // never holds up the rest of the queue.
    const { data } = await sb
      .from("outreach_prospects")
      .select("*")
      .eq("status", "approved")
      .is("sent_at", null)
      .order("approved_at", { ascending: true })
      .limit(1);
    const next = ((data ?? []) as Prospect[])[0];
    if (next) {
      const r = await sendInitial(sb, box, next, settings);
      if (r.ok) sent.push(`${next.domain}: first email`);
      else if (r.outcome === "invalid") {
        // Needs Emil (no address, a shared inbox, empty email): back to Ready.
        await sb.from("outreach_prospects").update({ status: "ready", notes: `Not sent: ${r.error}` }).eq("id", next.id).eq("status", "approved");
      } else if (r.outcome === "retry") {
        // A passing problem (Gmail, the CRM): stays approved and is tried again,
        // unless Gmail refused it MAX_INITIAL_TRIES times.
        const { count } = await sb
          .from("outreach_sends")
          .select("id", { count: "exact", head: true })
          .eq("prospect_id", next.id)
          .eq("kind", "initial")
          .eq("status", "failed");
        const giveUp = (count ?? 0) >= MAX_INITIAL_TRIES;
        await sb
          .from("outreach_prospects")
          .update(giveUp ? { status: "ready", notes: `Not sent after ${count} tries: ${r.error}` } : { notes: `Not sent yet, will retry: ${r.error}` })
          .eq("id", next.id)
          .eq("status", "approved")
          .is("sent_at", null);
      }
      // "blocked" is already skipped with the reason; "busy" is being sent by "Send now".
    }
  }
  return { ok: true, sent, inbox: inboxOk, reconciled };
}

const MAX_INITIAL_TRIES = 3;
// A claim older than this belongs to a run that died mid-send.
const STALE_CLAIM_MS = 10 * 60_000;

/**
 * First emails claimed (sent_at set) by a run that died before marking them sent
 * (audit 2026-11-10). Marked sent when the send log or his mailbox shows the
 * email went; released for a retry only when the mailbox was read and shows
 * nothing, so nobody is emailed twice.
 */
async function reconcileStaleClaims(sb: Sb, box: Mailbox): Promise<string[]> {
  const { data } = await sb
    .from("outreach_prospects")
    .select("*")
    .eq("status", "approved")
    .not("sent_at", "is", null)
    .lt("sent_at", new Date(Date.now() - STALE_CLAIM_MS).toISOString())
    .limit(5);
  const stale = (data ?? []) as Array<Prospect & { sent_at: string }>;
  if (stale.length === 0) return [];
  const log: string[] = [];
  let imap: ImapSession | null = null;
  try {
    imap = await ImapSession.open(box);
  } catch {
    imap = null; // the mailbox can't say: nothing is released this run
  }
  try {
    for (const p of stale) {
      const { data: rows } = await sb
        .from("outreach_sends")
        .select("message_id, sent_at")
        .eq("prospect_id", p.id)
        .eq("kind", "initial")
        .eq("status", "sent")
        .order("sent_at", { ascending: false })
        .limit(1);
      const row = ((rows ?? []) as Array<{ message_id: string | null; sent_at: string }>)[0];
      let inMailbox: boolean | null = null;
      let mailboxId: string | null = null;
      if (!row && imap && p.contact_email) {
        try {
          const since = new Date(Date.parse(p.sent_at) - 86_400_000);
          const seqs = await imap.sentTo(box.user, p.contact_email.trim(), since);
          inMailbox = seqs.length > 0;
          if (inMailbox) mailboxId = mailHeader(await imap.fetchRaw(seqs[seqs.length - 1], 8_000), "message-id").trim() || null;
        } catch {
          inMailbox = null;
        }
      }
      const decision = staleClaimDecision({ sentLogged: Boolean(row), inMailbox });
      if (decision === "mark_sent") {
        const at = row?.sent_at ?? p.sent_at;
        await sb
          .from("outreach_prospects")
          .update({ status: "sent", sent_at: at, last_sent_at: at, message_id: row?.message_id ?? mailboxId })
          .eq("id", p.id)
          .eq("status", "approved");
        log.push(`${p.domain}: interrupted send found, marked sent`);
      } else if (decision === "release") {
        await sb.from("outreach_prospects").update({ sent_at: null }).eq("id", p.id).eq("status", "approved").eq("sent_at", p.sent_at);
        log.push(`${p.domain}: interrupted send not found, released for a retry`);
      }
    }
  } finally {
    await imap?.close();
  }
  return log;
}

const clampInt = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    prospect_id?: string;
    user?: string;
    pass?: string;
    settings?: Partial<Settings>;
  };
  const sb = assertServiceRoleClient();

  if (body.action === "tick") {
    if (!(await hasCronSecret(req, "outreach_cron_secret"))) return json({ ok: false, error: "forbidden" }, 403);
    try {
      return json(await tick(sb));
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  if (body.action === "crm_check") {
    // Read-only: can the CRM be asked? For the health check and after a deploy. Counts only, no records.
    if (!(await hasCronSecret(req, "outreach_cron_secret"))) return json({ ok: false, error: "forbidden" }, 403);
    const domains = Array.isArray((body as { domains?: unknown }).domains) ? ((body as { domains: unknown[] }).domains).map(String).slice(0, 5) : [];
    try {
      const known = await crmKnown(domains.length ? domains : ["example.com"]);
      return json({ ok: true, matches: Object.fromEntries(Object.entries(known.domains).map(([d, m]) => [d, { count: m.length, reason: crmSkipReason(m) }])) });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
    }
  }

  try {
    await requireOutreachOwner(req);
  } catch {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  if (body.action === "status") {
    const settings = await loadSettings(sb);
    const today = await sentToday(sb, new Date());
    const box = await mailbox(sb);
    const { count: suppressedCount } = await sb.from("outreach_suppressions").select("domain", { count: "exact", head: true });
    // A real question to the CRM, so "connected" means it answers, not only that it is set up.
    const crmProblem = crmConfigured()
      ? await crmKnown(["example.com"]).then(() => null, (e) => (e instanceof Error ? e.message : String(e)))
      : "not set up";
    // The address only: the password never leaves the server.
    return json({
      ok: true,
      mailbox: box?.user ?? null,
      sent_today: today.initial,
      settings,
      in_window: inSendWindow(new Date(), settings.send_start_hour, settings.send_end_hour),
      crm: { connected: crmProblem === null, error: crmProblem },
      suppressed: suppressedCount ?? 0,
    });
  }

  if (body.action === "do_not_contact") {
    // By hand from a prospect's card: stop everything and never contact this company again.
    const { data } = await sb.from("outreach_prospects").select("*").eq("id", body.prospect_id ?? "").maybeSingle();
    if (!data) return json({ ok: false, error: "not_found" }, 404);
    const p = data as Prospect;
    await sb.from("outreach_suppressions").upsert({ domain: p.domain, email: p.contact_email, reason: "Marked by hand" }, { onConflict: "domain" });
    await sb.from("outreach_prospects").update({ status: p.sent_at ? "unsubscribed" : "skipped", skip_reason: p.sent_at ? null : "Do not contact" }).eq("id", p.id);
    return json({ ok: true });
  }

  if (body.action === "connect_mailbox") {
    const address = String(body.user ?? "").trim().toLowerCase();
    const password = String(body.pass ?? "").replace(/\s+/g, "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || password.length < 8) {
      return json({ ok: false, error: "Enter the email address and its app password." }, 400);
    }
    // Prove it works before storing it: sign in to the inbox with it.
    try {
      const imap = await ImapSession.open({ user: address, pass: password });
      await imap.close();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({
        ok: false,
        error: looksLikeAuthFailure(msg)
          ? "Gmail refused that address and app password. Check both and try again."
          : `Could not reach Gmail to check it: ${msg}`,
      }, 400);
    }
    const enc = await encryptString(JSON.stringify({ user: address, pass: password }));
    const { error } = await sb.from("app_secrets").upsert(
      { key: MAILBOX_SECRET, ciphertext: enc.ciphertext, iv: enc.iv, alg: enc.alg, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, mailbox: address });
  }

  if (body.action === "sync_signature") {
    const box = await mailbox(sb);
    if (!box) return json({ ok: false, error: "Connect the mailbox first." }, 409);
    try {
      const r = await syncSignature(sb, box);
      // 200 either way, so the page can read needs_reconnect and offer the button.
      return json(r.ok
        ? { ok: true, changed: r.changed, source: r.source }
        : { ok: false, error: r.error, needs_reconnect: Boolean(r.needsReconnect) });
    } catch (e) {
      return json({ ok: false, error: `Could not read your Gmail: ${e instanceof Error ? e.message : String(e)}` }, 502);
    }
  }

  if (body.action === "disconnect_mailbox") {
    await sb.from("app_secrets").delete().eq("key", MAILBOX_SECRET);
    return json({ ok: true });
  }

  if (body.action === "save_settings") {
    const s = body.settings ?? {};
    const current = await loadSettings(sb);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if ("paused" in s) {
      patch.paused = Boolean(s.paused);
      patch.pause_reason = s.paused ? "Paused by hand." : null;
    }
    if ("booking_url" in s) patch.booking_url = String(s.booking_url ?? "").trim() || null;
    if ("signature_html" in s) patch.signature_html = String(s.signature_html ?? "").trim().slice(0, 30_000) || null;
    if ("daily_new_cap" in s) patch.daily_new_cap = clampInt(s.daily_new_cap, 0, 10, current.daily_new_cap);
    if ("crm_log" in s) patch.crm_log = Boolean(s.crm_log);
    if ("reply_alerts" in s) patch.reply_alerts = Boolean(s.reply_alerts);
    if ("hot_lead_views" in s) patch.hot_lead_views = clampInt(s.hot_lead_views, 0, 20, current.hot_lead_views);
    if ("about_intro" in s) patch.about_intro = String(s.about_intro ?? "").trim().slice(0, 1500) || null;
    if ("auto_pipeline" in s) patch.auto_pipeline = Boolean(s.auto_pipeline);
    if ("auto_audits_per_day" in s) patch.auto_audits_per_day = clampInt(s.auto_audits_per_day, 0, 10, current.auto_audits_per_day);
    if ("min_lead_score" in s) patch.min_lead_score = clampInt(s.min_lead_score, 0, 100, current.min_lead_score);
    if ("max_followups" in s) patch.max_followups = clampInt(s.max_followups, 0, 2, current.max_followups);
    if ("followup_gap_days" in s) patch.followup_gap_days = clampInt(s.followup_gap_days, 1, 14, current.followup_gap_days);
    if ("min_gap_minutes" in s) patch.min_gap_minutes = clampInt(s.min_gap_minutes, 5, 240, current.min_gap_minutes);
    const start = "send_start_hour" in s ? clampInt(s.send_start_hour, 0, 23, current.send_start_hour) : current.send_start_hour;
    const end = "send_end_hour" in s ? clampInt(s.send_end_hour, 1, 24, current.send_end_hour) : current.send_end_hour;
    if (end <= start) return json({ ok: false, error: "The sending hours must end after they start." }, 400);
    if ("send_start_hour" in s) patch.send_start_hour = start;
    if ("send_end_hour" in s) patch.send_end_hour = end;
    const { error } = await sb.from("outreach_settings").update(patch).eq("id", "default");
    return error ? json({ ok: false, error: error.message }, 500) : json({ ok: true });
  }

  if (body.action === "test_send") {
    // A copy to Emil's own mailbox, exactly as a prospect would get it. Not recorded,
    // not counted, and nothing about the prospect changes.
    const box = await mailbox(sb);
    if (!box) return json({ ok: false, error: "Connect the mailbox first." }, 409);
    const settings = await loadSettings(sb);
    let subject = "Test: your outreach email";
    let text = "Hi there,\n\nThis is how your outreach emails look, signature included.\n\nEmil\nECD Digital Strategy";
    if (body.prospect_id) {
      const { data } = await sb.from("outreach_prospects").select("email_subject, email_body").eq("id", body.prospect_id).maybeSingle();
      const p = data as { email_subject?: string | null; email_body?: string | null } | null;
      if (p?.email_subject && p.email_body) {
        subject = `[Test] ${p.email_subject}`;
        text = p.email_body;
      }
    }
    const r = await sendAs(box, settings, box.user, subject, initialText(text, settings));
    return r.status === "sent" ? json({ ok: true, to: box.user }) : json({ ok: false, error: (r as { reason?: string }).reason ?? "Not sent" }, 502);
  }

  if (body.action === "send_now") {
    const box = await mailbox(sb);
    if (!box) return json({ ok: false, error: "Connect the mailbox first." }, 409);
    const settings = await loadSettings(sb);
    if (settings.paused) return json({ ok: false, error: `Sending is paused: ${settings.pause_reason ?? "no reason given"}` }, 409);
    const today = await sentToday(sb, new Date());
    if (today.initial >= settings.daily_new_cap) {
      return json({ ok: false, error: `Today's limit of ${settings.daily_new_cap} is reached. Queue it and it goes out on the next weekday.` }, 409);
    }
    const { data } = await sb.from("outreach_prospects").select("*").eq("id", body.prospect_id ?? "").maybeSingle();
    if (!data) return json({ ok: false, error: "not_found" }, 404);
    const r = await sendInitial(sb, box, data as Prospect, settings);
    return r.ok ? json({ ok: true }) : json({ ok: false, error: r.error }, 409);
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
