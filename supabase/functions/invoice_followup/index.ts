import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, hasCronSecret, requireStaffUserId } from "../_shared/auth.ts";
import { xeroApi } from "../_shared/xero.ts";
import { newYorkDate } from "../_shared/xero-plan.ts";
import { proposalEmailHtml, sendEmail } from "../_shared/mailer.ts";
import {
  emailInvoiceToClient,
  loadInvoicing,
  mailboxByEmail,
  patchInvoiceRecord,
  senderFirstName,
  type InvoiceRecord,
} from "../_shared/invoice-delivery.ts";
import { draftForClient } from "../_shared/client-draft.ts";
import { inlineLink, proposalLink } from "../_shared/app-links.ts";
import { daysOverdue, longDate, money, nudgeDue, renderInvoiceEmail, sentOn } from "../_shared/invoice-email.ts";
import { rebuildWelcome, saveWelcomeDraft, sendWelcomeNow, skipWelcome, welcomeTick } from "../_shared/welcome-delivery.ts";
import { holdsInvoice, type WelcomeStatus } from "../_shared/welcome-email.ts";

// Unpaid invoices (Emil + Isa, 2026-11-02): "if an invoice is not paid within 7
// days of sending, an email is sent to Xiomara, Maria and Isa". Daily (cron
// invoice-followup), only while proposal_settings.invoicing.overdue_nudges is on:
//  - reads each approved implementation invoice's status from Xero and records
//    when it is paid (shown on the proposal's Xero card);
//  - nudge_after_days (7) after it was sent, emails the reminder list (Xiomara,
//    Maria, Isa), then again every 7 days until it is paid;
//  - with client_reminders also on, the client gets a polite reminder on the same
//    days, from the Gmail the invoice came from, Maria copied.
// Invoices dated before reminders were turned on are left alone.
// Also "email_invoice" (staff, from the Xero card while auto-send is on): email
// an approved invoice to the client now, e.g. after connecting a Gmail.
// The welcome email (2026-11-04, _shared/welcome-delivery.ts): "welcome_tick"
// (cron welcome-email, every 15 minutes) and, from the proposal page,
// "welcome_save", "welcome_send", "welcome_rebuild" and "welcome_skip".

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" } });
}

type Sb = ReturnType<typeof assertServiceRoleClient>;
type Row = {
  id: string;
  title: string;
  proposal_number: number | null;
  recipient_name: string | null;
  invoice_sender_id: string | null;
  sent_by: string | null;
  created_by: string | null;
  xero_invoices: InvoiceRecord[] | null;
  client?: { company_name?: string | null } | null;
};
type XeroInv = { InvoiceID: string; Status?: string; AmountDue?: number; FullyPaidOnDate?: string; DueDateString?: string; CurrencyCode?: string };

/** Xero's "/Date(1700000000000+0000)/" as yyyy-mm-dd. */
const xeroDate = (v: string | undefined) => {
  const ms = Number(v?.match(/\/Date\((\d+)/)?.[1]);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null;
};

async function tick(sb: Sb) {
  const s = await loadInvoicing(sb);
  if (!s.overdue_nudges) return { ok: true, skipped: "off" };
  const today = newYorkDate(new Date());

  const { data } = await sb
    .from("proposals")
    .select("id, title, proposal_number, recipient_name, invoice_sender_id, sent_by, created_by, xero_invoices, client:clients(company_name)")
    .not("xero_invoices", "is", null);
  const watch: Array<{ p: Row; inv: InvoiceRecord }> = [];
  for (const p of (data ?? []) as Row[]) {
    for (const inv of p.xero_invoices ?? []) {
      if (inv.kind !== "one_time" || inv.status !== "AUTHORISED" || inv.paid_at) continue;
      if (s.nudges_since && inv.date && inv.date < s.nudges_since) continue;
      watch.push({ p, inv });
    }
  }
  if (watch.length === 0) return { ok: true, checked: 0 };

  // Xero takes up to 100 ids a call.
  const live = new Map<string, XeroInv>();
  for (let i = 0; i < watch.length; i += 100) {
    const ids = watch.slice(i, i + 100).map((w) => w.inv.id).join(",");
    const out = await xeroApi<{ Invoices?: XeroInv[] }>(sb, `/Invoices?IDs=${ids}`);
    for (const x of out.Invoices ?? []) live.set(x.InvoiceID, x);
  }

  const log: string[] = [];
  for (const { p, inv } of watch) {
    const x = live.get(inv.id);
    if (!x) continue;
    const company = p.client?.company_name ?? p.title;
    if (x.Status === "PAID") {
      await patchInvoiceRecord(sb, p.id, inv.id, { paid_at: xeroDate(x.FullyPaidOnDate) ?? today, amount_due: 0, status: "PAID" });
      log.push(`${company} ${inv.number}: paid`);
      continue;
    }
    if (x.Status === "VOIDED" || x.Status === "DELETED") {
      await patchInvoiceRecord(sb, p.id, inv.id, { status: x.Status });
      continue;
    }
    const due = xeroDate(x.DueDateString) ?? inv.due_date;
    if (typeof x.AmountDue === "number" && x.AmountDue !== inv.amount_due) await patchInvoiceRecord(sb, p.id, inv.id, { amount_due: x.AmountDue });
    if (!nudgeDue(inv, s, today)) continue;

    const to = s.reminder_emails;
    if (to.length === 0) continue;
    const sent = sentOn(inv);
    const days = daysOverdue(sent, today);
    const owed = money(typeof x.AmountDue === "number" ? x.AmountDue : inv.total, x.CurrencyCode || "USD");
    const mail = await sendEmail({
      to,
      subject: `Unpaid: ${company} invoice ${inv.number}, sent ${days} days ago`,
      html: proposalEmailHtml({
        heading: `${company}: invoice ${inv.number} is still unpaid`,
        bodyLines: [
          `${owed} is still due. It was sent ${longDate(sent)}${due ? ` and is due ${longDate(due)}` : ""}.`,
          inv.emailed_at
            ? `It was emailed to ${inv.emailed_to ?? "the client"} from ${inv.emailed_from ?? "us"}.`
            : inv.drafted_at
              ? `It was drafted to ${inv.drafted_to ?? "the client"} in ${inv.drafted_from ?? "the sender"}'s Gmail for them to send.`
              : "It was not emailed to the client by the proposals app.",
          s.client_reminders && (inv.emailed_at || inv.drafted_at)
            ? `A short reminder to the client is drafted in ${inv.emailed_from ?? inv.drafted_from}'s Gmail today, for them to send.`
            : "Worth a follow-up with the client.",
          "This comes again in a week until it is paid.",
          `The proposal: ${inlineLink(proposalLink(p.id, "xero"), "open its Xero card")}.`,
        ],
        ctaLabel: "Open it in Xero",
        ctaUrl: `https://go.xero.com/app/invoicing/edit/${inv.id}`,
      }),
    });
    // Whether this round did anything. The round is marked done if EITHER the team email
    // or the client reminder happened: marking it only on the team email meant a failing
    // email made a fresh client reminder draft every day.
    let acted = mail.status === "sent";
    if (acted) log.push(`${company} ${inv.number}: team reminded (${days} days)`);
    else log.push(`${company} ${inv.number}: team email not sent (${mail.status})`);

    // The client too, when turned on: a DRAFT in the Gmail it came from, Maria
    // copied, and the sender Slacked to check and send it (2026-11-05).
    const clientTo = inv.emailed_to ?? inv.drafted_to ?? null;
    const clientFrom = inv.emailed_from ?? inv.drafted_from ?? null;
    if (s.client_reminders && clientTo && clientFrom && inv.online_url) {
      try {
        const box = await mailboxByEmail(sb, clientFrom);
        if (!box) throw new Error(`${clientFrom} is no longer connected`);
        const { full, first } = await senderFirstName(sb, box.userId);
        const email = renderInvoiceEmail({ subject: s.reminder_subject, body: s.reminder_body }, {
          first_name: (p.recipient_name ?? "").trim().split(/\s+/)[0] || "there",
          company: p.client?.company_name ?? "",
          proposal_title: p.title,
          invoice_number: inv.number,
          total: owed,
          due_date: due ? longDate(due) : "on receipt",
          pay_link: inv.online_url,
          sender_first_name: first,
        });
        const cc = s.cc_emails.filter((e) => e !== box.email.toLowerCase() && e !== clientTo.toLowerCase());
        await draftForClient(
          sb,
          box,
          { fromName: full || null, to: [clientTo], cc, subject: email.subject, html: email.html, text: email.text },
          { what: `Payment reminder for ${company} (${inv.number})`, to: clientTo, proposalId: p.id, focus: "xero" },
        );
        await patchInvoiceRecord(sb, p.id, inv.id, { last_client_reminder_at: new Date().toISOString() });
        acted = true;
        log.push(`${company} ${inv.number}: client reminder drafted`);
      } catch (e) {
        log.push(`${company} ${inv.number}: client reminder failed (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    if (acted) await patchInvoiceRecord(sb, p.id, inv.id, { last_nudge_at: new Date().toISOString() });
  }
  return { ok: true, checked: watch.length, log };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const body = (await req.json().catch(() => ({}))) as { action?: string; proposal_id?: string; invoice_id?: string; subject?: string; email_body?: string };
  const sb = assertServiceRoleClient();

  // An end-to-end check of the draft path (2026-11-08), run by an admin with the cron
  // secret: the usual invoice email, with example values, written as a DRAFT in that
  // person's Gmail addressed to THEMSELVES, and the Slack DM with its link. No client,
  // no real invoice.
  if (body.action === "draft_test") {
    if (!(await hasCronSecret(req, "invoice_cron_secret"))) return json({ ok: false, error: "forbidden" }, 403);
    try {
      const box = await mailboxByEmail(sb, (body as { email?: string }).email);
      if (!box) return json({ ok: false, error: "That Gmail isn't connected." }, 404);
      const s = await loadInvoicing(sb);
      const { full, first } = await senderFirstName(sb, box.userId);
      const email = renderInvoiceEmail(s, {
        first_name: first,
        company: "Example Brand",
        proposal_title: "Website retainer",
        invoice_number: "INV-0000",
        total: money(700),
        due_date: longDate(new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)),
        pay_link: "https://in.xero.com/example",
        sender_first_name: first,
      });
      const r = await draftForClient(
        sb,
        box,
        { fromName: full || null, to: [box.email], subject: `[Test draft] ${email.subject}`, html: email.html, text: email.text },
        { what: "A test invoice email (to yourself)", to: box.email },
      );
      return json({ ok: true, draft_url: r.url, notified: r.notified, signature: r.signature });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  if (body.action === "tick" || body.action === "welcome_tick") {
    if (!(await hasCronSecret(req, "invoice_cron_secret"))) return json({ ok: false, error: "forbidden" }, 403);
    try {
      return json(body.action === "tick" ? await tick(sb) : await welcomeTick(sb));
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  let userId: string;
  try {
    // Welcome and invoice emails are proposals work, so a Member without
    // Proposals access can't drive them.
    userId = await requireStaffUserId(req, "proposals");
  } catch {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  if (body.action?.startsWith("welcome_")) {
    const id = body.proposal_id ?? "";
    const edit = { subject: body.subject, body: body.email_body };
    try {
      if (body.action === "welcome_save") return json({ ok: true, welcome: await saveWelcomeDraft(sb, id, edit) });
      if (body.action === "welcome_send") return json({ ok: true, welcome: await sendWelcomeNow(sb, id, userId, edit) });
      if (body.action === "welcome_rebuild") return json({ ok: true, welcome: await rebuildWelcome(sb, id) });
      if (body.action === "welcome_skip") return json({ ok: true, welcome: await skipWelcome(sb, id) });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 409);
    }
  }

  if (body.action === "email_invoice") {
    const s = await loadInvoicing(sb);
    if (!s.auto_send) return json({ ok: false, error: "Invoice emails are switched off in Proposal settings." }, 409);
    // The welcome email carries this invoice (or will, once its run picks the proposal up):
    // drafting it on its own as well would put it in front of the client twice.
    const { data: row } = await sb.from("proposals").select("client_signed_at, welcome_email").eq("id", body.proposal_id ?? "").maybeSingle();
    if (row && holdsInvoice(s.welcome, row as { client_signed_at: string | null; welcome_email: { status?: WelcomeStatus } | null })) {
      return json({ ok: false, error: "This invoice goes with the welcome email, so it isn't drafted on its own. See the Welcome email card." }, 409);
    }
    try {
      const r = await emailInvoiceToClient(sb, body.proposal_id ?? "", body.invoice_id ?? "", s);
      return json({ ok: true, ...r });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (body.proposal_id && body.invoice_id) await patchInvoiceRecord(sb, body.proposal_id, body.invoice_id, { email_error: reason.slice(0, 300) });
      return json({ ok: false, error: reason }, 409);
    }
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
