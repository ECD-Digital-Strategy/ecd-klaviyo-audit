import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, hasCronSecret } from "../_shared/auth.ts";
import { requireOutreachOwner } from "../_shared/outreach-access.ts";
import { sendEmail } from "../_shared/mailer.ts";
import { ImapSession } from "../_shared/imap-search.ts";
import { decryptString, encryptString } from "../_shared/crypto.ts";
import {
  FOLLOWUP_GAP_DAYS,
  MAX_FOLLOWUPS,
  MIN_GAP_MINUTES,
  followUp,
  footer,
  inSendWindow,
  plainHtml,
  replySearchKey,
  startOfSendDay,
} from "../_shared/outreach-email.ts";

// Outreach, step 2 (Emil, 2026-11-02): sends the outreach emails as Emil through
// Gmail. The mailbox and its app password are connected on the Outreach page
// ("connect_mailbox": checked by signing in, stored encrypted in app_secrets, never
// sent back to the browser). The same login reads his inbox for replies and
// bounces. The guardrails agreed with Emil:
//  - at most daily_new_cap (3) first emails per US weekday, 45 minutes apart,
//    in New York working hours; follow-ups go in the same window;
//  - MAX_FOLLOWUPS (1) short follow-up, 3 days later, threaded under the first email;
//  - anything from them (a reply, out-of-office, "no") stops the sequence;
//  - any bounce, or Gmail refusing the password, pauses ALL sending until Emil
//    looks (the hourly health check emails him about the pause).
// Actions: "status", "connect_mailbox", "disconnect_mailbox", "save_settings" and
// "send_now" (Emil, from the Outreach page); "tick" (the outreach-autopilot cron,
// every 20 minutes).

const REPORT_BASE = "https://audit.ecdigitalstrategy.com/report/";
const SENDER_NAME = "Emil Gorgijev";
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
type Settings = { paused: boolean; pause_reason: string | null; daily_new_cap: number; booking_url: string | null; postal_address: string | null };
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
  return (data as Settings | null) ?? { paused: false, pause_reason: null, daily_new_cap: 3, booking_url: null, postal_address: null };
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

const looksLikeAuthFailure = (reason: string) => /auth|535|534|password|credentials|login/i.test(reason);

/** Sends one email and records it. Pauses everything if Gmail refuses the password. */
async function deliver(
  sb: Sb,
  box: Mailbox,
  p: Prospect,
  kind: "initial" | "followup_1" | "followup_2",
  subject: string,
  text: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const to = String(p.contact_email ?? "").trim();
  const messageId = `<outreach-${crypto.randomUUID()}@ecdigitalstrategy.com>`;
  const result = await sendEmail({
    to: [to],
    from: `${SENDER_NAME} <${box.user}>`,
    subject,
    html: plainHtml(text),
    smtp: box,
    messageId,
    ...(kind !== "initial" && p.message_id ? { inReplyTo: p.message_id } : {}),
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
  if (!p.email_subject?.trim() || !p.email_body?.trim()) return { ok: false, error: "The email is empty." };
  if (p.sent_at) return { ok: false, error: "Already sent." };
  const text = `${p.email_body.trim()}\n\n${footer(settings.postal_address)}`;
  const r = await deliver(sb, box, p, "initial", p.email_subject.trim(), text);
  if (!r.ok) return r;
  const now = new Date().toISOString();
  await sb.from("outreach_prospects").update({ status: "sent", sent_at: now, last_sent_at: now, message_id: r.messageId }).eq("id", p.id);
  return r;
}

/** Replies and bounces since each prospect was emailed. Returns false if the inbox could not be read. */
async function checkInbox(sb: Sb, box: Mailbox): Promise<boolean> {
  const { data } = await sb
    .from("outreach_prospects")
    .select("id, domain, contact_email, sent_at")
    .eq("status", "sent")
    .gte("sent_at", new Date(Date.now() - 45 * 86_400_000).toISOString());
  const sent = (data ?? []) as Array<{ id: string; domain: string; contact_email: string | null; sent_at: string }>;
  if (sent.length === 0) return true;
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
      if ((await imap.repliesFrom(replySearchKey(p.contact_email, p.domain), since)) > 0) {
        await sb.from("outreach_prospects").update({ status: "replied", replied_at: new Date().toISOString() }).eq("id", p.id);
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
  const settings = await loadSettings(sb);
  if (settings.paused) return { ok: true, skipped: "paused", reason: settings.pause_reason };
  if (!inSendWindow(now)) return { ok: true, skipped: "outside_send_window", inbox: inboxOk };
  const sent: string[] = [];

  // Follow-ups, only when the inbox could be read: never chase someone who may have replied.
  if (inboxOk) {
    const { data } = await sb.from("outreach_prospects").select("*").eq("status", "sent").lt("followups_sent", MAX_FOLLOWUPS);
    for (const p of (data ?? []) as Prospect[]) {
      const gap = FOLLOWUP_GAP_DAYS[p.followups_sent] * 86_400_000;
      if (!p.last_sent_at || now.getTime() - Date.parse(p.last_sent_at) < gap) continue;
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
      const r = await deliver(sb, box, p, n === 1 ? "followup_1" : "followup_2", subject, text);
      if (!r.ok) break;
      await sb.from("outreach_prospects").update({ followups_sent: n, last_sent_at: new Date().toISOString() }).eq("id", p.id);
      sent.push(`${p.domain}: follow-up ${n}`);
      if ((await loadSettings(sb)).paused) return { ok: true, sent, paused: true };
    }
  }

  // At most one first email per run: the cap per day and 45 minutes between them.
  const today = await sentToday(sb, now);
  if (today.initial < settings.daily_new_cap && now.getTime() - today.lastInitialAt >= MIN_GAP_MINUTES * 60_000) {
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
      else await sb.from("outreach_prospects").update({ status: "ready", notes: `Not sent: ${r.error}` }).eq("id", next.id);
    }
  }
  return { ok: true, sent, inbox: inboxOk };
}

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
    // The address only: the password never leaves the server.
    return json({ ok: true, mailbox: box?.user ?? null, sent_today: today.initial, settings, in_window: inSendWindow(new Date()) });
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

  if (body.action === "disconnect_mailbox") {
    await sb.from("app_secrets").delete().eq("key", MAILBOX_SECRET);
    return json({ ok: true });
  }

  if (body.action === "save_settings") {
    const s = body.settings ?? {};
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if ("paused" in s) {
      patch.paused = Boolean(s.paused);
      patch.pause_reason = s.paused ? "Paused by hand." : null;
    }
    if ("booking_url" in s) patch.booking_url = String(s.booking_url ?? "").trim() || null;
    if ("postal_address" in s) patch.postal_address = String(s.postal_address ?? "").trim() || null;
    if ("daily_new_cap" in s) patch.daily_new_cap = Math.max(0, Math.min(10, Number(s.daily_new_cap) || 0));
    const { error } = await sb.from("outreach_settings").update(patch).eq("id", "default");
    return error ? json({ ok: false, error: error.message }, 500) : json({ ok: true });
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
