import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, hasCronSecret } from "../_shared/auth.ts";
import { requireOutreachOwner } from "../_shared/outreach-access.ts";
import { sendEmail } from "../_shared/mailer.ts";
import { ImapSession } from "../_shared/imap-search.ts";
import { decryptString, encryptString } from "../_shared/crypto.ts";
import { isRoleAddress } from "../_shared/outreach-contacts.ts";
import { getSecret } from "../_shared/app-secrets.ts";
import { HubSpot, OUTREACH_HUBSPOT_SCOPES, type HubLeadStatus } from "../_shared/outreach-hubspot.ts";
import { ALERTING, PASSING, SUPPRESSING, classifyReply, type ReplyVerdict } from "../_shared/outreach-replies.ts";
import { extractGmailSignature, mailHeader, mailHtml, parseMail } from "../_shared/mail-parse.ts";
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
// out-of-office lets the sequence carry on. Emailed prospects, every email both
// ways and their lead status go into HubSpot (_shared/outreach-hubspot.ts).
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
  hubspot_log: boolean;
  reply_alerts: boolean;
  hot_lead_views: number;
  about_intro: string | null;
  auto_pipeline: boolean;
  auto_audits_per_day: number;
  min_lead_score: number;
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
  hubspot_log: true,
  reply_alerts: true,
  hot_lead_views: 3,
  about_intro: null,
  auto_pipeline: false,
  auto_audits_per_day: 3,
  min_lead_score: 40,
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
  hubspot_contact_id?: string | null;
  hubspot_company_id?: string | null;
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

async function hubspot(): Promise<HubSpot | null> {
  try {
    return new HubSpot(await getSecret("hubspot_private_app_token"));
  } catch {
    return null;
  }
}

/** The prospect and one email into HubSpot, best effort: a failure is noted on the prospect, never thrown. */
async function logToHubspot(
  sb: Sb,
  settings: Settings,
  p: Prospect,
  email: { direction: "out" | "in"; subject: string; text: string; from: string; to: string },
  status?: HubLeadStatus,
) {
  if (!settings.hubspot_log || !p.contact_email) return;
  const hs = await hubspot();
  if (!hs) return;
  try {
    const owner = await hs.ownerId(OUTREACH_OWNER_EMAIL);
    let companyId = p.hubspot_company_id ?? null;
    let contactId = p.hubspot_contact_id ?? null;
    if (!companyId) companyId = await hs.upsertCompany(p.domain, p.store_name || p.domain, owner);
    if (!contactId) {
      contactId = await hs.upsertContact(
        { email: p.contact_email, name: p.contact_name, title: p.contact_title ?? null, domain: p.domain },
        companyId,
        owner,
      );
    }
    await hs.logEmail({ contactId, companyId, ownerId: owner, ...email });
    if (status) await hs.setLeadStatus(contactId, status);
    p.hubspot_company_id = companyId;
    p.hubspot_contact_id = contactId;
    await sb.from("outreach_prospects").update({ hubspot_company_id: companyId, hubspot_contact_id: contactId, hubspot_error: null }).eq("id", p.id);
  } catch (e) {
    await sb.from("outreach_prospects").update({ hubspot_error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }).eq("id", p.id);
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

async function sendInitial(sb: Sb, box: Mailbox, p: Prospect, settings: Settings) {
  if (!p.contact_email?.includes("@")) return { ok: false, error: "Add their email first." };
  // A decision-maker only: never a support or info inbox (Emil, 2026-11-02).
  if (isRoleAddress(p.contact_email)) return { ok: false, error: `${p.contact_email} is a shared inbox, not a person. Find the decision-maker first.` };
  if (!p.email_subject?.trim() || !p.email_body?.trim()) return { ok: false, error: "The email is empty." };
  if (p.sent_at) return { ok: false, error: "Already sent." };
  if (await suppressed(sb, p.domain)) return { ok: false, error: "Someone at this company asked not to be contacted." };
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
  if (!mine?.length) return { ok: false, error: "Already sent." };
  const r = await deliver(sb, box, settings, p, "initial", subject, text);
  if (!r.ok) {
    // Not sent: free it again so it can be retried.
    await sb.from("outreach_prospects").update({ sent_at: null }).eq("id", p.id).eq("sent_at", claimedAt);
    return r;
  }
  const now = new Date().toISOString();
  await sb.from("outreach_prospects").update({ status: "sent", sent_at: now, last_sent_at: now, message_id: r.messageId }).eq("id", p.id);
  await logToHubspot(sb, settings, p, { direction: "out", subject, text, from: box.user, to: p.contact_email }, "ATTEMPTED_TO_CONTACT");
  return r;
}

/** Acts on a new message from a prospect: sorts it, then stops, remembers, alerts and logs as it says. */
async function handleReply(
  sb: Sb,
  settings: Settings,
  box: Mailbox,
  p: Prospect,
  seen: number,
  mail: { from: string; subject: string; text: string },
) {
  let verdict: ReplyVerdict;
  let sorted = true;
  try {
    verdict = await classifyReply(mail.text, mail.subject);
  } catch {
    // Unsorted: treat it as a person answering, so nobody is chased by mistake.
    verdict = { kind: "other", summary: "Could not be sorted automatically; read it in Gmail." };
    sorted = false;
  }
  const now = new Date().toISOString();
  const reply = { reply_kind: verdict.kind, reply_summary: verdict.summary, reply_text: mail.text.slice(0, 4000), replies_seen: seen };

  if (sorted && PASSING.has(verdict.kind)) {
    // An away message or an automatic receipt: the sequence carries on.
    await sb.from("outreach_prospects").update(reply).eq("id", p.id);
    return;
  }
  const stop = SUPPRESSING.has(verdict.kind);
  await sb.from("outreach_prospects").update({ ...reply, status: stop ? "unsubscribed" : "replied", replied_at: now }).eq("id", p.id);
  if (stop) {
    await sb.from("outreach_suppressions").upsert(
      { domain: p.domain, email: p.contact_email, reason: `${KIND_LABEL[verdict.kind]}: ${verdict.summary}`.slice(0, 300) },
      { onConflict: "domain" },
    );
  }
  const status: HubLeadStatus = stop ? "UNQUALIFIED" : verdict.kind === "not_now" ? "BAD_TIMING" : "CONNECTED";
  await logToHubspot(sb, settings, p, {
    direction: "in",
    subject: mail.subject || `Re: ${p.email_subject ?? ""}`,
    text: mail.text,
    from: p.contact_email ?? mail.from,
    to: box.user,
  }, status);
  if (settings.reply_alerts && (ALERTING.has(verdict.kind) || !sorted)) {
    await alertEmil(p, verdict, mail, await reportUrl(sb, p)).catch(() => {});
  }
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

/** Replies and bounces since each prospect was emailed. Returns false if the inbox could not be read. */
async function checkInbox(sb: Sb, box: Mailbox): Promise<boolean> {
  const { data } = await sb
    .from("outreach_prospects")
    .select("*")
    .eq("status", "sent")
    .gte("sent_at", new Date(Date.now() - 45 * 86_400_000).toISOString());
  const sent = (data ?? []) as Array<Prospect & { sent_at: string }>;
  if (sent.length === 0) return true;
  const settings = await loadSettings(sb);
  let imap: ImapSession;
  try {
    imap = await ImapSession.open(box);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (looksLikeAuthFailure(msg)) await pause(sb, `Gmail refused the outreach mailbox sign-in (inbox): ${msg}`);
    return false;
  }
  try {
    for (const p of sent) {
      if (!p.contact_email) continue;
      const since = new Date(p.sent_at);
      if ((await imap.bouncesFor(p.contact_email, since)) > 0) {
        await sb.from("outreach_prospects").update({ status: "bounced" }).eq("id", p.id);
        await pause(sb, `${p.contact_email} (${p.domain}) bounced. Sending is paused until you check the address list.`);
        continue;
      }
      const latest = await imap.latestFrom(replySearchKey(p.contact_email, p.domain), since);
      if (latest.count > (p.replies_seen ?? 0)) {
        await handleReply(sb, settings, box, p, latest.count, parseMail(latest.raw ?? ""));
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    await imap.close();
  }
}

async function tick(sb: Sb) {
  const box = await mailbox(sb);
  if (!box) return { ok: true, skipped: "mailbox_not_connected" };
  const now = new Date();
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
        break;
      }
      await sb.from("outreach_prospects").update({ last_sent_at: new Date().toISOString() }).eq("id", p.id);
      await logToHubspot(sb, settings, p, { direction: "out", subject, text, from: box.user, to: p.contact_email ?? "" });
      sent.push(`${p.domain}: follow-up ${n}`);
      if ((await loadSettings(sb)).paused) return { ok: true, sent, paused: true };
    }
  }

  // At most one first email per run, within the daily limit and spacing.
  const today = await sentToday(sb, now);
  if (today.initial < settings.daily_new_cap && now.getTime() - today.lastInitialAt >= settings.min_gap_minutes * 60_000) {
    const { data } = await sb
      .from("outreach_prospects")
      .select("*")
      .eq("status", "approved")
      .order("approved_at", { ascending: true })
      .limit(1);
    const next = ((data ?? []) as Prospect[])[0];
    if (next) {
      const r = await sendInitial(sb, box, next, settings);
      if (r.ok) sent.push(`${next.domain}: first email`);
      // "Already sent": "Send now" took it a moment ago. Leave it alone, it is going out.
      else if (r.error !== "Already sent.") await sb.from("outreach_prospects").update({ status: "ready", notes: `Not sent: ${r.error}` }).eq("id", next.id);
    }
  }
  return { ok: true, sent, inbox: inboxOk };
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

  try {
    await requireOutreachOwner(req);
  } catch {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  if (body.action === "status") {
    const settings = await loadSettings(sb);
    const today = await sentToday(sb, new Date());
    const box = await mailbox(sb);
    const hs = await hubspot();
    const scopes = hs ? await hs.scopes() : null;
    const { count: suppressedCount } = await sb.from("outreach_suppressions").select("domain", { count: "exact", head: true });
    // The address only: the password never leaves the server.
    return json({
      ok: true,
      mailbox: box?.user ?? null,
      sent_today: today.initial,
      settings,
      in_window: inSendWindow(new Date(), settings.send_start_hour, settings.send_end_hour),
      hubspot: {
        connected: Boolean(hs),
        // null when HubSpot would not say which scopes the token has.
        missing_scopes: scopes ? OUTREACH_HUBSPOT_SCOPES.filter((sc) => !scopes.includes(sc)) : null,
      },
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
    if ("hubspot_log" in s) patch.hubspot_log = Boolean(s.hubspot_log);
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
