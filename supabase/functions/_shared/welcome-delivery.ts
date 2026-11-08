import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { xeroApi, xeroInvoicePdf } from "./xero.ts";
import { deleteDraft, freeBusy, NeedsReconnect, type Attachment } from "./gmail.ts";
import { draftForClient, slackDm } from "./client-draft.ts";
import { loadInvoicing, patchInvoiceRecord, resolveSender, senderFirstName, type InvoiceRecord } from "./invoice-delivery.ts";
import { longDate, money, type InvoicingSettings } from "./invoice-email.ts";
import { fillSubject, fillWelcome, LINK_LABELS, welcomeHtml, type WelcomeSettings, type WelcomeVars } from "./welcome-email.ts";
import { candidateDays, findSlots, formatSlot, zonedTime } from "./launch-slots.ts";
import { proposalEmailHtml, sendEmail } from "./mailer.ts";
import { gmailSettingsLink, inlineLink, proposalLink } from "./app-links.ts";

// The welcome email after signing (see welcome-email.ts for what it says). Runs
// from the invoice_followup function every 15 minutes (cron welcome-email):
//  1. a proposal signed since the switch went on is queued ("waiting");
//  2. it waits, up to wait_hours, for what other systems make after signing: the
//     Xero invoice, the client's intake form and (new clients) the RS once the pod
//     is confirmed in the Client Tracker;
//  3. it reads Isa's and the RS's free/busy through the sender's Google
//     connection and picks launch call times;
//  4. then (2026-11-05: nothing is sent to clients automatically) it is written as
//     a DRAFT in the sender's own Gmail, Maria copied, invoice PDF attached, and
//     the sender gets a Slack DM with the link to check and send it, with anything
//     missing listed. If it can't go into Gmail it waits on the proposal page and
//     the sender is told why.
// While a proposal is covered, its implementation invoice is not emailed on its own
// (invoice-delivery.ts holds it): the welcome email carries it.

type Sb = SupabaseClient;

export type { WelcomeStatus } from "./welcome-email.ts";
import type { WelcomeStatus } from "./welcome-email.ts";

export type WelcomeRecord = {
  status: WelcomeStatus;
  queued_at: string;
  updated_at?: string;
  kind?: "new" | "project";
  /** Why it is waiting, or why it needs a look. */
  missing?: string[];
  subject?: string;
  body?: string;
  /** url -> the words it shows as, for the HTML version. */
  links?: Record<string, string>;
  times?: string[];
  to?: string | null;
  cc?: string[];
  from_email?: string | null;
  from_user_id?: string | null;
  fallback?: boolean;
  invoice_id?: string | null;
  sent_at?: string | null;
  sent_by?: string | null;
  /** The draft in the sender's Gmail (2026-11-05). */
  drafted_at?: string | null;
  draft_url?: string | null;
  draft_id?: string | null;
  /** How the sender was told about it. */
  notified?: "slack" | "email" | "none";
  notified_at?: string | null;
  error?: string | null;
};

type ProposalRow = {
  id: string;
  title: string;
  client_id: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  invoice_sender_id: string | null;
  sent_by: string | null;
  created_by: string | null;
  client_signed_at: string | null;
  xero_invoices: InvoiceRecord[] | null;
  welcome_email: WelcomeRecord | null;
  client?: { company_name?: string | null } | null;
};

const SELECT =
  "id, title, client_id, recipient_name, recipient_email, invoice_sender_id, sent_by, created_by, client_signed_at, xero_invoices, welcome_email, client:clients(company_name)";

type TrackerInfo = {
  found: boolean;
  kind?: string;
  intake_link?: string | null;
  intake_note?: string | null;
  pod_confirmed?: boolean;
  rs?: Array<{ name: string; email: string }>;
};

/** What the Client Tracker knows (client-onboarding welcome_info). Null when it can't be asked. */
async function trackerInfo(proposalId: string, makeIntake: boolean): Promise<TrackerInfo | null> {
  const url = Deno.env.get("HUB_ONBOARDING_URL") ?? "";
  const key = Deno.env.get("ONBOARDING_SHARED_KEY") ?? "";
  if (!url || !key) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-onboarding-key": key },
      body: JSON.stringify({ action: "welcome_info", proposal_id: proposalId, make_intake: makeIntake }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as TrackerInfo;
  } catch {
    return null;
  }
}

/** Whether signing produced a one-time charge, so an invoice is worth waiting for. */
async function expectsInvoice(sb: Sb, proposalId: string): Promise<boolean> {
  const { data } = await sb.from("proposal_line_items").select("one_time_price, optional, client_selected").eq("proposal_id", proposalId);
  return ((data ?? []) as Array<{ one_time_price: number | string | null; optional?: boolean | null; client_selected?: boolean | null }>)
    .some((i) => (!i.optional || i.client_selected === true) && Number(i.one_time_price ?? 0) > 0);
}

async function earlierSigned(sb: Sb, p: ProposalRow): Promise<boolean> {
  if (!p.client_id) return false;
  const { count } = await sb
    .from("proposals")
    .select("id", { count: "exact", head: true })
    .eq("client_id", p.client_id)
    .neq("id", p.id)
    .not("client_signed_at", "is", null);
  return (count ?? 0) > 0;
}

const oneTimeInvoice = (p: ProposalRow) => (p.xero_invoices ?? []).find((i) => i.kind === "one_time" && i.online_url) ?? null;
const hoursSince = (iso: string | null | undefined) => (iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : 0);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function save(sb: Sb, id: string, rec: WelcomeRecord) {
  await sb.from("proposals").update({ welcome_email: { ...rec, updated_at: new Date().toISOString() } }).eq("id", id);
}

/** Moves a record from one status to the next only if nobody else did first.
 * from null: only if the proposal has no welcome record yet. */
async function claim(sb: Sb, id: string, from: WelcomeStatus | null, rec: WelcomeRecord): Promise<boolean> {
  let q = sb
    .from("proposals")
    .update({ welcome_email: { ...rec, updated_at: new Date().toISOString() } })
    .eq("id", id);
  q = from === null ? q.is("welcome_email", null) : q.eq("welcome_email->>status", from);
  const { data } = await q.select("id");
  return Boolean(data?.length);
}

/** A run that died while putting it into Gmail leaves it "sending" for good. After this long it is
 * treated as interrupted (no run takes longer: the function's own limit is 150 seconds). */
const STALE_SENDING_MS = 10 * 60_000;
export const isStaleSending = (rec: { status?: string; updated_at?: string } | null | undefined, now = Date.now()) =>
  rec?.status === "sending" && (!rec.updated_at || now - Date.parse(rec.updated_at) > STALE_SENDING_MS);

/** Launch call times everyone is free for, read through the sender's Google connection. */
async function launchTimes(
  sb: Sb,
  box: { userId: string; email: string },
  w: WelcomeSettings,
  rs: Array<{ name: string; email: string }>,
): Promise<{ times: string[]; problems: string[] }> {
  const calendars = [
    ...new Set([
      ...w.call_attendee_emails,
      ...(w.call_include_rs ? rs.map((r) => r.email) : []),
      ...(w.call_include_sender ? [box.email.toLowerCase()] : []),
    ]),
  ];
  if (!calendars.length) return { times: [], problems: ["No calendars are set for the launch call."] };
  const now = new Date();
  const rules = {
    timezone: w.call_timezone,
    day_start: w.call_day_start,
    day_end: w.call_day_end,
    minutes: w.call_minutes,
    first_day: w.call_first_day,
    last_day: w.call_last_day,
    count: w.call_count,
  };
  const days = candidateDays(now, rules);
  if (!days.length) return { times: [], problems: ["No days to offer for the launch call."] };
  try {
    const { busy, unreadable } = await freeBusy(sb, box, calendars, now, zonedTime(days[days.length - 1], 24 * 60, w.call_timezone));
    const times = findSlots(busy, rules, now).map((d) => formatSlot(d, w.call_timezone));
    const problems: string[] = [];
    if (unreadable.length) problems.push(`Could not see ${unreadable.join(", ")}'s calendar, so check the times suit them.`);
    if (!times.length) problems.push(`Nobody's calendars had a free ${w.call_minutes} minutes in the next ${w.call_last_day} business days, so add launch call times.`);
    return { times, problems };
  } catch (e) {
    const msg = e instanceof NeedsReconnect ? e.message : `Could not read calendars (${e instanceof Error ? e.message : String(e)}).`;
    return { times: [], problems: [`${msg} Add launch call times.`] };
  }
}

type Composed = { rec: WelcomeRecord; ready: boolean };

/** Builds the email from what is there now. `ready`: nothing is missing. */
async function compose(sb: Sb, p: ProposalRow, s: InvoicingSettings, info: TrackerInfo | null, base: WelcomeRecord): Promise<Composed> {
  const w = s.welcome;
  const missing: string[] = [];
  const kind: "new" | "project" = info?.found ? (info.kind === "project" ? "project" : "new") : (await earlierSigned(sb, p)) ? "project" : "new";
  const inv = oneTimeInvoice(p);
  // Things to check that more waiting won't change: shown, but they never hold the email back.
  const notes: string[] = [];
  // A proposal that splits the payment gets a held draft with no pay link (payment-terms.ts):
  // Maria sends that invoice from Xero, so this email goes without one rather than waiting all day.
  const held = (p.xero_invoices ?? []).find((i) => i.kind === "one_time" && (i as { held_reason?: string | null }).held_reason);
  if (!inv && held) {
    notes.push("The invoice is held for Maria because the proposal splits the payment, so this email has no pay link. She sends the invoice from Xero.");
  } else if (!inv && (await expectsInvoice(sb, p.id))) {
    missing.push("The implementation invoice isn't in Xero yet, so there's no pay link.");
  }
  if (!info?.found) missing.push("The Client Tracker has no onboarding for this proposal, so there's no intake form.");
  else if (!info.intake_link) missing.push(info.intake_note ? `No intake form: ${info.intake_note}` : "The intake form hasn't been made yet.");

  const to = (p.recipient_email ?? "").trim();
  if (!to.includes("@")) missing.push("The proposal has no client email.");
  const sender = await resolveSender(sb, p, s);
  if (!sender) {
    return {
      ready: false,
      rec: { ...base, status: "draft", kind, missing: [...missing, ...notes, "Neither the proposal's creator nor the fallback sender has connected their Gmail."], error: null },
    };
  }
  const { box, fallback } = sender;
  const { first: senderFirst } = await senderFirstName(sb, box.userId);

  let times: string[] = [];
  if (kind === "new") {
    const rs = info?.rs ?? [];
    if (w.call_include_rs && (!info?.pod_confirmed || !rs.length)) missing.push("The RS isn't confirmed yet, so the times only fit the other calendars.");
    const got = await launchTimes(sb, box, w, rs);
    times = got.times;
    missing.push(...got.problems);
  }

  const vars: WelcomeVars = {
    first_name: (p.recipient_name ?? "").trim().split(/\s+/)[0] || "there",
    company: p.client?.company_name ?? "",
    proposal_title: p.title,
    invoice_number: inv?.number ?? "",
    total: inv ? money(inv.total) : "",
    due_date: inv ? (inv.due_date ? longDate(inv.due_date) : "on receipt") : "",
    pay_link: inv?.online_url ?? "",
    sender_first_name: senderFirst,
    intro: "",
    ecd_onboarding_form: kind === "new" ? w.ecd_onboarding_form_url : "",
    w9_link: kind === "new" ? w.w9_url : "",
    client_onboarding_form: info?.intake_link ?? "",
  };
  // From the fallback sender, who the client may not know: a line introducing them.
  if (fallback) vars.intro = fillWelcome(w.intro_line, vars, []);
  const template = kind === "new" ? { subject: w.new_subject, body: w.new_body } : { subject: w.project_subject, body: w.project_body };
  const links: Record<string, string> = {};
  for (const [k, label] of Object.entries(LINK_LABELS)) {
    const url = vars[k as keyof WelcomeVars];
    if (url) links[url] = label;
  }
  const cc = s.cc_emails.filter((e) => e !== box.email.toLowerCase() && e !== to.toLowerCase());
  return {
    ready: missing.length === 0,
    rec: {
      ...base,
      kind,
      missing: [...missing, ...notes],
      subject: fillSubject(template.subject, vars),
      body: fillWelcome(template.body, vars, times),
      links,
      times,
      to: to || null,
      cc,
      from_email: box.email,
      from_user_id: box.userId,
      fallback,
      invoice_id: inv?.id ?? null,
      error: null,
    },
  };
}

/**
 * Writes a composed record into its sender's Gmail as a DRAFT (2026-11-05: the app
 * never sends to clients) and Slacks them the link. A draft it wrote before for
 * this proposal is replaced, so a rebuild never leaves two in their Drafts.
 */
async function toGmail(sb: Sb, p: ProposalRow, rec: WelcomeRecord): Promise<WelcomeRecord> {
  if (!rec.from_user_id || !rec.from_email) throw new Error("No sender: connect a Gmail first.");
  if (!rec.to?.includes("@")) throw new Error("The proposal has no client email.");
  if (!rec.subject?.trim() || !rec.body?.trim()) throw new Error("The email is empty.");
  const box = { userId: rec.from_user_id, email: rec.from_email };
  const { full } = await senderFirstName(sb, box.userId);
  const inv = rec.invoice_id ? (p.xero_invoices ?? []).find((i) => i.id === rec.invoice_id) ?? null : null;
  const attachments: Attachment[] = [];
  if (inv) {
    try {
      attachments.push({ filename: `Invoice ${inv.number || inv.id}.pdf`, contentType: "application/pdf", data: await xeroInvoicePdf(sb, inv.id) });
    } catch (e) {
      console.warn("welcome: invoice PDF not attached", e);
    }
  }
  const prev = p.welcome_email;
  if (prev?.draft_id && prev.from_user_id === box.userId) await deleteDraft(sb, box, prev.draft_id).catch(() => {});
  const company = p.client?.company_name ?? p.title;
  const draft = await draftForClient(
    sb,
    box,
    { fromName: full || null, to: [rec.to], cc: rec.cc ?? [], subject: rec.subject, html: welcomeHtml(rec.body, rec.links ?? {}), text: rec.body, attachments },
    { what: `Welcome email for ${company}`, to: rec.to, proposalId: p.id, focus: "welcome", checks: rec.missing },
  );
  const now = new Date().toISOString();
  if (inv) {
    await xeroApi(sb, `/Invoices/${inv.id}/History`, {
      method: "PUT",
      body: { HistoryRecords: [{ Details: `Drafted to ${rec.to} with the welcome email in ${box.email}'s Gmail by the proposals app, for them to send.` }] },
    }).catch(() => {});
    await patchInvoiceRecord(sb, p.id, inv.id, {
      drafted_at: now,
      drafted_from: box.email,
      drafted_to: rec.to,
      draft_url: draft.url,
      emailed_as_fallback: rec.fallback ?? false,
      email_error: null,
    });
  }
  return { ...rec, status: "drafted", drafted_at: now, draft_url: draft.url, draft_id: draft.draftId, notified: draft.notified, notified_at: now, error: null };
}

/** When it couldn't be written into Gmail: the sender (else the creator and the fallback sender) is told why, and how to fix it. */
async function notifyProblem(sb: Sb, p: ProposalRow, rec: WelcomeRecord) {
  const company = p.client?.company_name ?? p.title;
  let to = rec.from_email ? [rec.from_email] : [];
  if (!to.length) {
    const s = await loadInvoicing(sb);
    const { data } = p.created_by ? await sb.from("profiles").select("email").eq("id", p.created_by).maybeSingle() : { data: null };
    to = [...new Set([(data as { email?: string } | null)?.email, s.fallback_sender_email].filter((e): e is string => Boolean(e)))];
  }
  if (!to.length) return;
  const reconnect = [...(rec.missing ?? []), rec.error ?? ""].some((m) => /reconnect|expired|connected their Gmail/i.test(m));
  const reasons = [...(rec.error ? [rec.error] : []), ...(rec.missing ?? [])];
  for (const email of to) {
    await slackDm(
      email,
      [
        `:warning: The welcome email for *${company}* couldn't be written into your Gmail. Nothing has gone to the client.`,
        ...reasons.map((r) => `• ${r}`),
        ...(reconnect ? [`Fix: <${gmailSettingsLink()}|Connected Gmail accounts>, click Reconnect next to your name.`] : []),
        `<${proposalLink(p.id, "welcome")}|Open the proposal> to finish it.`,
      ].join("\n"),
    ).catch(() => {});
  }
  await sendEmail({
    to,
    subject: `Needs you: the welcome email for ${company}`,
    html: proposalEmailHtml({
      heading: `The welcome email for ${esc(company)} couldn't be drafted in Gmail`,
      bodyLines: [
        "Nothing has gone to the client. It's on the proposal page instead, ready to check and put into Gmail.",
        ...(reasons.length ? [`Why:<br>${reasons.map((m) => `&bull; ${esc(m)}`).join("<br>")}`] : []),
        ...(reconnect
          ? [`Fix the Gmail connection once so the next one goes by itself: ${inlineLink(gmailSettingsLink(), "Connected Gmail accounts")} (click Reconnect next to your name).`]
          : []),
      ],
      ctaLabel: "Open the welcome email",
      ctaUrl: proposalLink(p.id, "welcome"),
    }),
  }).catch((e) => console.warn("welcome: problem notice failed", e));
}

/** Drafts it in Gmail; if that can't happen, keeps it on the proposal page and says why. */
async function draftOrHold(sb: Sb, p: ProposalRow, rec: WelcomeRecord): Promise<WelcomeRecord> {
  try {
    const drafted = await toGmail(sb, p, rec);
    await save(sb, p.id, drafted);
    return drafted;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const held: WelcomeRecord = { ...rec, status: "draft", error, notified_at: new Date().toISOString() };
    await save(sb, p.id, held);
    await notifyProblem(sb, p, held);
    return held;
  }
}

async function load(sb: Sb, id: string): Promise<ProposalRow | null> {
  const { data } = await sb.from("proposals").select(SELECT).eq("id", id).maybeSingle();
  return (data as ProposalRow | null) ?? null;
}

/** One waiting proposal: wait longer, or draft it in the sender's Gmail. */
async function step(sb: Sb, p: ProposalRow, s: InvoicingSettings): Promise<string> {
  const w = s.welcome;
  const company = p.client?.company_name ?? p.title;
  const base = p.welcome_email!;
  const age = hoursSince(p.client_signed_at);
  const info = await trackerInfo(p.id, true);
  const composed = await compose(sb, p, s, info, base);
  // The tracker never picks some proposals up (an existing client it can't match): no point waiting all day.
  const trackerGaveUp = !info?.found && age >= 2;
  const timeUp = age >= w.wait_hours;
  if (!composed.ready && !timeUp && !trackerGaveUp) {
    // Conditional: a "Don't send" or a rebuild pressed meanwhile must not be undone.
    const still = await claim(sb, p.id, "waiting", { ...base, status: "waiting", missing: composed.rec.missing ?? [] });
    return still ? `${company}: waiting (${(composed.rec.missing ?? []).length} to come)` : `${company}: changed meanwhile, left alone`;
  }
  if (!(await claim(sb, p.id, "waiting", { ...composed.rec, status: "sending" }))) return `${company}: taken by another run`;
  const out = await draftOrHold(sb, p, composed.rec);
  return out.status === "drafted" ? `${company}: drafted in ${out.from_email}'s Gmail (${out.notified})` : `${company}: held, ${out.error}`;
}

/** The scheduled run. */
export async function welcomeTick(sb: Sb) {
  const s = await loadInvoicing(sb);
  const w = s.welcome;
  if (!w.enabled || !w.since) return { ok: true, skipped: "off" };
  const log: string[] = [];

  // 1. Queue what was signed since it went on.
  const { data: fresh } = await sb
    .from("proposals")
    .select("id")
    .gte("client_signed_at", w.since)
    .is("welcome_email", null)
    .limit(50);
  for (const r of fresh ?? []) {
    const rec: WelcomeRecord = { status: "waiting", queued_at: new Date().toISOString(), missing: [] };
    await sb.from("proposals").update({ welcome_email: rec }).eq("id", r.id).is("welcome_email", null);
  }

  // 2. One interrupted while going into Gmail goes back on the page for the sender, who is told.
  const { data: sending } = await sb.from("proposals").select(SELECT).eq("welcome_email->>status", "sending").limit(20);
  for (const p of (sending ?? []) as ProposalRow[]) {
    const rec = p.welcome_email!;
    if (!isStaleSending(rec)) continue;
    const held: WelcomeRecord = {
      ...rec,
      status: "draft",
      error: "It was interrupted while going into Gmail. Look in your Gmail Drafts first: it may already be there.",
    };
    const { data: moved } = await sb
      .from("proposals")
      .update({ welcome_email: { ...held, updated_at: new Date().toISOString() } })
      .eq("id", p.id)
      .eq("welcome_email->>status", "sending")
      .eq("welcome_email->>updated_at", rec.updated_at ?? "")
      .select("id");
    if (moved?.length) {
      await notifyProblem(sb, p, held);
      log.push(`${p.client?.company_name ?? p.id}: interrupted, back on the page`);
    }
  }

  // 3. Move each waiting one on.
  const { data: waiting } = await sb.from("proposals").select(SELECT).eq("welcome_email->>status", "waiting").limit(20);
  for (const p of (waiting ?? []) as ProposalRow[]) {
    try {
      log.push(await step(sb, p, s));
    } catch (e) {
      log.push(`${p.client?.company_name ?? p.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: true, queued: fresh?.length ?? 0, log };
}

/** From the proposal page: save edits to one held on the page (couldn't be put into Gmail). */
export async function saveWelcomeDraft(sb: Sb, proposalId: string, edit: { subject?: string; body?: string }) {
  const p = await load(sb, proposalId);
  if (!p?.welcome_email) throw new Error("This proposal has no welcome email.");
  if (p.welcome_email.status !== "draft") throw new Error("Only one waiting on this page can be edited here. A Gmail draft is edited in Gmail.");
  const rec = {
    ...p.welcome_email,
    subject: typeof edit.subject === "string" ? edit.subject.slice(0, 300) : p.welcome_email.subject,
    body: typeof edit.body === "string" ? edit.body.slice(0, 20_000) : p.welcome_email.body,
  };
  await save(sb, p.id, rec);
  return rec;
}

/** From the proposal page: put one held on the page (with any edits) into the sender's Gmail as a draft. Never sends. */
export async function sendWelcomeNow(sb: Sb, proposalId: string, _userId: string, edit: { subject?: string; body?: string }) {
  const p = await load(sb, proposalId);
  if (!p?.welcome_email) throw new Error("This proposal has no welcome email.");
  if (p.welcome_email.status !== "draft") throw new Error("It isn't waiting on this page.");
  const rec: WelcomeRecord = {
    ...p.welcome_email,
    subject: typeof edit.subject === "string" && edit.subject.trim() ? edit.subject.slice(0, 300) : p.welcome_email.subject,
    body: typeof edit.body === "string" && edit.body.trim() ? edit.body.slice(0, 20_000) : p.welcome_email.body,
  };
  // The invoice may have arrived since: carry it.
  if (!rec.invoice_id) rec.invoice_id = oneTimeInvoice(p)?.id ?? null;
  // A sender may have connected since: pick them up.
  if (!rec.from_user_id) {
    const sender = await resolveSender(sb, p, await loadInvoicing(sb));
    if (sender) Object.assign(rec, { from_user_id: sender.box.userId, from_email: sender.box.email, fallback: sender.fallback });
  }
  if (!(await claim(sb, p.id, "draft", { ...rec, status: "sending" }))) throw new Error("Someone else is doing this right now.");
  const out = await draftOrHold(sb, { ...p, welcome_email: rec }, rec);
  if (out.status !== "drafted") throw new Error(out.error ?? "Could not put it into Gmail.");
  return out;
}

/** From the proposal page: build it again from what is there now (new times, the intake form) and replace the Gmail draft. Never sends. */
export async function rebuildWelcome(sb: Sb, proposalId: string) {
  const s = await loadInvoicing(sb);
  const p = await load(sb, proposalId);
  if (!p) throw new Error("Proposal not found.");
  const cur = p.welcome_email;
  if (cur?.status === "sending" && !isStaleSending(cur)) throw new Error("It's being drafted right now.");
  const base: WelcomeRecord = cur ?? { status: "draft", queued_at: new Date().toISOString() };
  // Take it first, from whatever it is now: the 15-minute run can't draft it at the same time.
  if (!(await claim(sb, p.id, cur ? cur.status : null, { ...base, status: "sending" }))) {
    throw new Error("Someone else changed it just now. Refresh and try again.");
  }
  try {
    const info = await trackerInfo(p.id, true);
    const { rec } = await compose(sb, p, s, info, base);
    return await draftOrHold(sb, p, { ...rec, status: "draft" });
  } catch (e) {
    await save(sb, p.id, { ...base, status: cur?.status === "sending" ? "draft" : (cur?.status ?? "draft") });
    throw e;
  }
}

/** From the proposal page: don't do it here (e.g. handled by hand). A Gmail draft it wrote stays in Drafts; the invoice can still be drafted from the Xero card. */
export async function skipWelcome(sb: Sb, proposalId: string) {
  const p = await load(sb, proposalId);
  if (!p?.welcome_email) throw new Error("This proposal has no welcome email.");
  if (p.welcome_email.status === "sending" && !isStaleSending(p.welcome_email)) throw new Error("It's being drafted right now.");
  const rec: WelcomeRecord = { ...p.welcome_email, status: "skipped" };
  if (!(await claim(sb, p.id, p.welcome_email.status, rec))) throw new Error("Someone else changed it just now. Refresh and try again.");
  return rec;
}
