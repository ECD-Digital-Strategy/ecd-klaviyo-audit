import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { xeroApi, xeroInvoicePdf } from "./xero.ts";
import { mailboxFor, type Attachment, type Mailbox } from "./gmail.ts";
import { draftForClient } from "./client-draft.ts";
import { longDate, mergeInvoicing, money, renderInvoiceEmail, type InvoicingSettings } from "./invoice-email.ts";
import { holdsInvoice, type WelcomeStatus } from "./welcome-email.ts";

// Emails a signed proposal's implementation invoice to the client, with the PDF
// and the Xero pay link, Maria copied (Emil + Isa, 2026-11-02). Who it comes from,
// as agreed with Isa:
//  1. the person picked on the proposal ("Invoice sent by"), else whoever
//     CREATED it, when their Gmail is connected;
//  2. otherwise the fallback sender (Xiomara), with the intro email, because the
//     client may not know her;
//  3. otherwise nobody: the payment link goes to the proposal's sender to forward,
//     as before, and the reason is kept on the invoice.
// Only while proposal_settings.invoicing.auto_send is on; with it off (the
// default) nothing here runs.

type Sb = SupabaseClient;

export type InvoiceRecord = {
  kind: "one_time" | "monthly";
  id: string;
  number: string;
  date: string;
  due_date: string;
  total: number;
  status?: string;
  online_url?: string | null;
  /** Set once it is emailed to the client (before 2026-11-05, when the app still sent). */
  emailed_at?: string | null;
  emailed_from?: string | null;
  emailed_to?: string | null;
  /** True when it went from the fallback sender with the intro email. */
  emailed_as_fallback?: boolean | null;
  email_error?: string | null;
  /** Since 2026-11-05: written as a draft in the sender's Gmail for them to send. */
  drafted_at?: string | null;
  drafted_from?: string | null;
  drafted_to?: string | null;
  draft_url?: string | null;
  /** Client reminders drafted (client_reminders on). */
  last_client_reminder_at?: string | null;
  /** From Xero, by the daily follow-up. */
  paid_at?: string | null;
  amount_due?: number | null;
  last_nudge_at?: string | null;
};

type ProposalForEmail = {
  id: string;
  title: string;
  client_id?: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  invoice_sender_id: string | null;
  sent_by: string | null;
  created_by: string | null;
  xero_invoices: InvoiceRecord[] | null;
  client?: { company_name?: string | null } | null;
};

export async function loadInvoicing(sb: Sb): Promise<InvoicingSettings> {
  const { data } = await sb.from("platform_settings").select("proposal_settings").eq("id", "default").maybeSingle();
  return mergeInvoicing((data?.proposal_settings as { invoicing?: unknown } | null)?.invoicing);
}

/** Who the invoice should come from: the proposal's pick, else whoever created it (Isa, 2026-11-02). */
export const invoiceSenderId = (p: Pick<ProposalForEmail, "invoice_sender_id" | "sent_by" | "created_by">) =>
  p.invoice_sender_id ?? p.created_by ?? p.sent_by;

/** A connected mailbox by address (the fallback sender). */
export async function mailboxByEmail(sb: Sb, email: string | null | undefined): Promise<Mailbox | null> {
  const e = (email ?? "").trim().toLowerCase();
  if (!e) return null;
  const { data } = await sb.from("mailbox_connections").select("user_id, email").eq("email", e).maybeSingle();
  return data ? { userId: data.user_id as string, email: data.email as string } : null;
}

/** The mailbox an invoice goes from, and whether that is the fallback (so it introduces itself). */
export async function resolveSender(
  sb: Sb,
  p: Pick<ProposalForEmail, "invoice_sender_id" | "sent_by" | "created_by">,
  s: InvoicingSettings,
): Promise<{ box: Mailbox; fallback: boolean } | null> {
  const preferredId = invoiceSenderId(p);
  const preferred = await mailboxFor(sb, preferredId);
  if (preferred) return { box: preferred, fallback: false };
  const fallback = await mailboxByEmail(sb, s.fallback_sender_email);
  if (fallback) return { box: fallback, fallback: fallback.userId !== preferredId };
  return null;
}

export async function senderFirstName(sb: Sb, userId: string): Promise<{ full: string; first: string }> {
  const { data } = await sb.from("profiles").select("name").eq("id", userId).maybeSingle();
  const full = String((data as { name?: string } | null)?.name ?? "").trim();
  return { full, first: full.split(/\s+/)[0] || "ECD Digital Strategy" };
}

/** Writes fields onto one invoice in proposals.xero_invoices, re-reading first so nothing else is lost. */
export async function patchInvoiceRecord(sb: Sb, proposalId: string, invoiceId: string, patch: Partial<InvoiceRecord>) {
  const { data } = await sb.from("proposals").select("xero_invoices").eq("id", proposalId).maybeSingle();
  const list = (Array.isArray(data?.xero_invoices) ? data!.xero_invoices : []) as InvoiceRecord[];
  const next = list.map((r) => (r.id === invoiceId ? { ...r, ...patch } : r));
  await sb.from("proposals").update({ xero_invoices: next }).eq("id", proposalId);
}

/** Picks who the client is: the proposal's recipient, else whoever signed for the client, else the client record. */
export function pickClientContact(
  recipient: { name?: string | null; email?: string | null },
  signer: { name?: string | null; email?: string | null } | null,
  clientEmail: string | null | undefined,
): { email: string; name: string } {
  const ok = (e: string | null | undefined) => {
    const v = (e ?? "").trim();
    return v.includes("@") ? v : "";
  };
  const rName = (recipient.name ?? "").trim();
  const sName = (signer?.name ?? "").trim();
  const fromRecipient = ok(recipient.email);
  if (fromRecipient) return { email: fromRecipient, name: rName || sName };
  const fromSigner = ok(signer?.email);
  if (fromSigner) return { email: fromSigner, name: sName || rName };
  return { email: ok(clientEmail), name: rName };
}

/**
 * The client's email and name for a signed proposal. A proposal shared by link has
 * no recipient email (12 of the 33 signed by 2026-11-10; the first live welcome
 * email, #78, stalled on it), but the person who signed gave theirs.
 */
export async function clientContact(
  sb: Sb,
  p: { id: string; client_id?: string | null; recipient_name: string | null; recipient_email: string | null },
): Promise<{ email: string; name: string }> {
  const recipient = { name: p.recipient_name, email: p.recipient_email };
  const direct = pickClientContact(recipient, null, null);
  if (direct.email) return direct;
  const { data: sig } = await sb
    .from("proposal_signatures")
    .select("signer_name, signer_email")
    .eq("proposal_id", p.id)
    .eq("role", "client")
    .order("signed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  let clientEmail: string | null = null;
  if (p.client_id) {
    const { data: c } = await sb.from("clients").select("email").eq("id", p.client_id).maybeSingle();
    clientEmail = (c as { email?: string | null } | null)?.email ?? null;
  }
  const s = sig as { signer_name?: string | null; signer_email?: string | null } | null;
  return pickClientContact(recipient, s ? { name: s.signer_name, email: s.signer_email } : null, clientEmail);
}

async function loadProposal(sb: Sb, proposalId: string): Promise<ProposalForEmail | null> {
  const { data } = await sb
    .from("proposals")
    .select("id, title, client_id, recipient_name, recipient_email, invoice_sender_id, sent_by, created_by, xero_invoices, client:clients(company_name)")
    .eq("id", proposalId)
    .maybeSingle();
  return (data as ProposalForEmail | null) ?? null;
}

/**
 * Writes the invoice email for one approved invoice as a DRAFT in the sender's
 * Gmail (PDF attached, Maria copied) and Slacks them the link to check and send it
 * (2026-11-05: nothing goes to a client automatically). Throws with a plain reason
 * when it cannot.
 */
export async function emailInvoiceToClient(sb: Sb, proposalId: string, invoiceId: string, settings?: InvoicingSettings) {
  const s = settings ?? (await loadInvoicing(sb));
  const p = await loadProposal(sb, proposalId);
  if (!p) throw new Error("Proposal not found.");
  const inv = (p.xero_invoices ?? []).find((r) => r.id === invoiceId);
  if (!inv) throw new Error("That invoice is not on this proposal.");
  if (inv.kind !== "one_time" || !inv.online_url) throw new Error("Only the approved implementation invoice is emailed; monthly ones stay drafts for Maria.");
  const contact = await clientContact(sb, p);
  const to = contact.email;
  if (!to) throw new Error("There's no client email: none on the proposal, from the signer or on the client.");
  const sender = await resolveSender(sb, p, s);
  if (!sender) throw new Error("Neither the proposal's creator nor the fallback sender has connected their Gmail.");
  const { box, fallback } = sender;
  const { full: senderName, first: senderFirst } = await senderFirstName(sb, box.userId);

  const company = p.client?.company_name ?? "";
  const vars = {
    first_name: contact.name.split(/\s+/)[0] || "there",
    company,
    proposal_title: p.title,
    invoice_number: inv.number,
    total: money(inv.total),
    due_date: inv.due_date ? longDate(inv.due_date) : "on receipt",
    pay_link: inv.online_url,
    sender_first_name: senderFirst,
  };
  // From the fallback sender, the client may not know them: the intro email.
  const email = renderInvoiceEmail(fallback ? { subject: s.intro_subject, body: s.intro_body } : s, vars);

  // The PDF is a nice-to-have: without it the pay link still carries everything.
  const attachments: Attachment[] = [];
  try {
    attachments.push({ filename: `Invoice ${inv.number || inv.id}.pdf`, contentType: "application/pdf", data: await xeroInvoicePdf(sb, inv.id) });
  } catch (e) {
    console.warn("invoice: PDF not attached", e);
  }

  const cc = s.cc_emails.filter((e) => e.toLowerCase() !== box.email.toLowerCase() && e.toLowerCase() !== to.toLowerCase());
  const draft = await draftForClient(
    sb,
    box,
    { fromName: senderName || null, to: [to], cc, subject: email.subject, html: email.html, text: email.text, attachments },
    { what: `Invoice ${inv.number || ""} for ${company || p.title}`.replace(/\s+/g, " "), to, proposalId, focus: "xero" },
  );

  // A note in Xero of where it is. Not marked sent: the person sends it.
  await xeroApi(sb, `/Invoices/${inv.id}/History`, {
    method: "PUT",
    body: { HistoryRecords: [{ Details: `Drafted to ${to} in ${box.email}'s Gmail by the proposals app${cc.length ? `, copying ${cc.join(", ")}` : ""}, for them to send.` }] },
  }).catch(() => {});

  await patchInvoiceRecord(sb, proposalId, inv.id, {
    drafted_at: new Date().toISOString(),
    drafted_from: box.email,
    drafted_to: to,
    draft_url: draft.url,
    emailed_as_fallback: fallback,
    email_error: null,
  });
  return { to, from: box.email, cc, fallback, draft_url: draft.url, notified: draft.notified };
}

/**
 * After signing: drafts the invoice email for the new implementation invoices in
 * the sender's Gmail when invoice emails are on. Returns the ones NOT drafted, for
 * the usual payment-link email to the sender.
 */
export async function deliverNewInvoices(sb: Sb, proposalId: string, fresh: InvoiceRecord[]): Promise<InvoiceRecord[]> {
  const s = await loadInvoicing(sb);
  // The welcome email carries the implementation invoice (welcome-delivery.ts):
  // neither emailed on its own nor sent to the sender as a payment link.
  if (s.welcome.enabled) {
    const { data } = await sb.from("proposals").select("client_signed_at, welcome_email").eq("id", proposalId).maybeSingle();
    const row = data as { client_signed_at: string | null; welcome_email: { status?: WelcomeStatus } | null } | null;
    if (row && holdsInvoice(s.welcome, row)) return fresh.filter((inv) => inv.kind !== "one_time");
  }
  if (!s.auto_send) return fresh;
  const left: InvoiceRecord[] = [];
  for (const inv of fresh) {
    if (inv.kind !== "one_time" || !inv.online_url) {
      left.push(inv);
      continue;
    }
    try {
      await emailInvoiceToClient(sb, proposalId, inv.id, s);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await patchInvoiceRecord(sb, proposalId, inv.id, { email_error: reason.slice(0, 300) });
      left.push({ ...inv, email_error: reason });
    }
  }
  return left;
}
