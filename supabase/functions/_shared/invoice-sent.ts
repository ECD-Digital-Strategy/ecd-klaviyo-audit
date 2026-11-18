// Invoices marked "Sent" in Xero (Maria, 2026-11-17). Since 2026-11-05 the app never sends a client email itself:
// the invoice is written as a Gmail draft (alone, or inside the welcome email) for a person to send. Xero only
// starts its own payment reminders on invoices marked sent, and nothing marked them, so a client Isa sent the pay
// link to weeks earlier never got a reminder. Now:
//   - every 15 minutes (cron welcome-email, invoice_followup "welcome_tick"), an approved, unpaid implementation
//     invoice whose Gmail draft (its own, or the welcome email carrying it) has left the sender's Drafts is
//     marked sent in Xero, with a note in its history;
//   - "Mark as sent in Xero" on the proposal's Xero card does it by hand, for an invoice sent another way
//     (pay link pasted into an email, sent from Xero, added to another invoice).
// Only AUTHORISED invoices are touched: a paid, voided or deleted one never is. The Gmail connection can list
// drafts but not read Sent mail, so "left Drafts" stands in for "sent"; a draft deleted on purpose looks the same,
// which is why the invoice must still be approved and unpaid in Xero first.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { xeroApi } from "./xero.ts";
import { draftMessageIdFromUrl, draftStillThere } from "./gmail.ts";
import { mailboxByEmail, patchInvoiceRecord, type InvoiceRecord } from "./invoice-delivery.ts";

type Sb = SupabaseClient;
export type SentHow = "gmail_draft" | "welcome_email" | "by_hand";
type XeroInv = { InvoiceID: string; Status?: string; SentToContact?: boolean; AmountDue?: number; FullyPaidOnDate?: string };

/** Xero's "/Date(1700000000000+0000)/" as yyyy-mm-dd. */
const xeroDay = (v: string | undefined) => {
  const ms = Number(v?.match(/\/Date\((\d+)/)?.[1]);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null;
};

const HOW_NOTE: Record<SentHow, string> = {
  gmail_draft: "the invoice email left the sender's Gmail Drafts (sent)",
  welcome_email: "the welcome email carrying it left the sender's Gmail Drafts (sent)",
  by_hand: "marked by hand on the proposal's Xero card",
};

/** Only drafts from the last 60 days are watched: an older one that is still sitting there was not the route. */
const WATCH_DAYS = 60;

/**
 * Marks one invoice sent in Xero and records it on the proposal. Returns marked=false with the reason when Xero
 * says it can't be (not approved, already paid, voided).
 */
export async function markSentInXero(
  sb: Sb,
  proposalId: string,
  invoiceId: string,
  how: SentHow,
  who?: string | null,
): Promise<{ marked: boolean; reason?: string }> {
  const read = await xeroApi<{ Invoices?: XeroInv[] }>(sb, `/Invoices/${invoiceId}`);
  const x = read.Invoices?.[0];
  if (!x) throw new Error("Xero doesn't have that invoice.");
  // Paid or gone already (Moto Machines paid INV-1630 within 15 minutes of the email): record that straight
  // away, so the card says so and the 15-minute check stops looking, instead of waiting for the daily check.
  if (x.Status === "PAID") {
    await patchInvoiceRecord(sb, proposalId, invoiceId, { status: "PAID", paid_at: xeroDay(x.FullyPaidOnDate) ?? new Date().toISOString().slice(0, 10), amount_due: 0 });
    return { marked: false, reason: "It's already paid." };
  }
  if (x.Status === "VOIDED" || x.Status === "DELETED") {
    await patchInvoiceRecord(sb, proposalId, invoiceId, { status: x.Status });
    return { marked: false, reason: `It's ${x.Status.toLowerCase()} in Xero.` };
  }
  if (x.Status !== "AUTHORISED") return { marked: false, reason: `It's ${String(x.Status ?? "not approved").toLowerCase()} in Xero, and only an approved invoice can be marked sent.` };

  if (!x.SentToContact) {
    await xeroApi(sb, "/Invoices", { method: "POST", body: { Invoices: [{ InvoiceID: invoiceId, SentToContact: true }] } });
    const check = await xeroApi<{ Invoices?: XeroInv[] }>(sb, `/Invoices/${invoiceId}`);
    if (!check.Invoices?.[0]?.SentToContact) throw new Error("Xero didn't take the change. Mark it as sent in Xero itself.");
    await xeroApi(sb, `/Invoices/${invoiceId}/History`, {
      method: "PUT",
      body: { HistoryRecords: [{ Details: `Marked as sent by the proposals app: ${HOW_NOTE[how]}${who ? ` (${who})` : ""}. Xero's reminders now apply.` }] },
    }).catch(() => {});
  }
  await patchInvoiceRecord(sb, proposalId, invoiceId, {
    sent_marked_at: new Date().toISOString(),
    sent_marked_how: how,
    sent_marked_by: who ?? null,
  });
  return { marked: true };
}

type WelcomeRec = { status?: string; invoice_id?: string | null; draft_id?: string | null; draft_url?: string | null; from_email?: string | null; drafted_at?: string | null };
type Row = { id: string; xero_invoices: InvoiceRecord[] | null; welcome_email: WelcomeRec | null; client?: { company_name?: string | null } | null; title: string };

export type SentCandidate = {
  proposalId: string;
  invoiceId: string;
  label: string;
  how: Exclude<SentHow, "by_hand">;
  fromEmail: string;
  draftId: string | null;
  messageId: string | null;
};

/** The invoices whose Gmail draft should be checked. Pure, so it is tested directly. */
export function sentCandidates(rows: Row[], now: Date): SentCandidate[] {
  const since = now.getTime() - WATCH_DAYS * 86_400_000;
  const recent = (iso: string | null | undefined) => Boolean(iso) && Date.parse(iso!) >= since;
  const out: SentCandidate[] = [];
  for (const p of rows) {
    const company = p.client?.company_name || p.title;
    const open = (inv: InvoiceRecord) => inv.kind === "one_time" && inv.status === "AUTHORISED" && !inv.paid_at && !inv.sent_marked_at;
    for (const inv of p.xero_invoices ?? []) {
      if (!open(inv) || !inv.drafted_from || !recent(inv.drafted_at)) continue;
      const messageId = draftMessageIdFromUrl(inv.draft_url);
      if (!inv.draft_id && !messageId) continue;
      out.push({ proposalId: p.id, invoiceId: inv.id, label: `${company} ${inv.number}`, how: "gmail_draft", fromEmail: inv.drafted_from, draftId: inv.draft_id ?? null, messageId });
    }
    const w = p.welcome_email;
    if (w?.status === "drafted" && w.invoice_id && w.from_email && recent(w.drafted_at)) {
      const inv = (p.xero_invoices ?? []).find((i) => i.id === w.invoice_id);
      if (inv && open(inv) && !out.some((c) => c.invoiceId === inv.id)) {
        out.push({ proposalId: p.id, invoiceId: inv.id, label: `${company} ${inv.number}`, how: "welcome_email", fromEmail: w.from_email, draftId: w.draft_id ?? null, messageId: draftMessageIdFromUrl(w.draft_url) });
      }
    }
  }
  return out;
}

/** The 15-minute check: invoices whose draft has left Drafts are marked sent in Xero. */
export async function invoiceSentTick(sb: Sb): Promise<string[]> {
  const { data } = await sb
    .from("proposals")
    .select("id, title, xero_invoices, welcome_email, client:clients(company_name)")
    .not("xero_invoices", "is", null)
    .not("client_signed_at", "is", null);
  const log: string[] = [];
  for (const c of sentCandidates((data ?? []) as Row[], new Date())) {
    const box = await mailboxByEmail(sb, c.fromEmail);
    if (!box) continue;
    const still = await draftStillThere(sb, box, { draftId: c.draftId, messageId: c.messageId });
    if (still !== false) continue;
    try {
      const r = await markSentInXero(sb, c.proposalId, c.invoiceId, c.how, c.fromEmail);
      log.push(r.marked ? `${c.label}: marked sent in Xero` : `${c.label}: not marked (${r.reason})`);
    } catch (e) {
      log.push(`${c.label}: could not mark sent (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return log;
}
