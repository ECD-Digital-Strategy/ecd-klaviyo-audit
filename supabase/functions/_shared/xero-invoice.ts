import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { loadConnection, xeroApi } from "./xero.ts";
import {
  type AccountDefaults,
  describeUnmapped,
  type Resolved,
  resolveAccountCode,
  type RevenueAccountRow,
} from "./xero-accounts.ts";
import { type FeeKind, newYorkDate, type PlanLine, planInvoices } from "./xero-plan.ts";
import { autoCodeLines } from "./xero-autocode.ts";
import { notificationRecipients, proposalEmailHtml, sendEmail } from "./mailer.ts";

/**
 * Creates the DRAFT sales invoices for a signed proposal, by Zak's rules
 * (xero-plan.ts): the implementation and the first month of a retainer on
 * separate invoices, each dated and due by the rule for its kind, and nothing
 * for complimentary work.
 *
 * DRAFT is deliberate: Xero never emails a draft, so nothing reaches the client
 * until someone approves and sends it from Xero. Maria sets up the repeating
 * invoices from the first month's draft.
 *
 * Each line posts to its family's account (one-time 4011/4012/4013, ongoing
 * 4001/4002/4003) and carries the service's Xero Item when it has one. The
 * account is sent explicitly, so an Item coded to the wrong account in Xero
 * cannot misfile the revenue. If any line cannot be coded, NO invoice is
 * created and the reason names the lines.
 *
 * Every invoice made is recorded on proposals.xero_invoices by kind, so a retry
 * only creates what is missing, and each is posted with its own idempotency key.
 */

type LineItem = {
  id: string;
  name: string;
  description: string | null;
  one_time_price: number | string | null;
  monthly_price: number | string | null;
  xero_service_key: string | null;
  xero_item_one_time: string | null;
  xero_item_monthly: string | null;
  template_slug: string | null;
  display_order: number | null;
};

export type CreatedInvoice = {
  kind: FeeKind;
  id: string;
  number: string;
  date: string;
  due_date: string;
  total: number;
  /** AUTHORISED (approved, never sent) or DRAFT. */
  status?: string;
  /** The client-facing Xero payment link (in.xero.com/...), for approved ones. */
  online_url?: string | null;
};

type ProposalRow = {
  id: string;
  proposal_number: number | null;
  title: string;
  recipient_name: string | null;
  recipient_email: string | null;
  discount_type: string | null;
  discount_value: number | string | null;
  discount_applies_to: string | null;
  discount_label: string | null;
  client_signed_at: string | null;
  xero_invoice_id: string | null;
  xero_invoices: CreatedInvoice[] | null;
  client?: { company_name?: string | null; email?: string | null } | null;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Mirrors computeProposalTotals in src/lib/proposal-pricing.ts. The discount is
 * per bucket, and a 'fixed' discount applies its full value to EACH bucket it
 * covers, so the invoice total matches what the client saw on the proposal. */
function bucketDiscount(
  subtotal: number,
  type: string | null,
  value: number,
  applies: boolean,
): number {
  if (!applies || type === "none" || !type || value <= 0 || subtotal <= 0) return 0;
  if (type === "fixed") return Math.min(value, subtotal);
  if (type === "percent") return (subtotal * Math.min(Math.max(value, 0), 100)) / 100;
  return 0;
}

/** Xero's where-clause string, quotes escaped. */
const quoted = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The client's existing Xero contact by name, then by email, so a draft never
 * starts a second "A Ma Maniere" next to "A Ma Maniere LLC" when the email
 * matches. Null means a new contact is made with the invoice. */
async function findContactId(sb: SupabaseClient, name: string, email: string | undefined): Promise<string | null> {
  const lookups = [`Name.ToLower()==${quoted(name.toLowerCase())}`];
  if (email) lookups.push(`EmailAddress!=null&&EmailAddress.ToLower()==${quoted(email.toLowerCase())}`);
  for (const where of lookups) {
    const out = await xeroApi<{ Contacts?: Array<{ ContactID?: string; ContactStatus?: string }> }>(
      sb,
      `/Contacts?where=${encodeURIComponent(where)}`,
    ).catch(() => null);
    const hit = out?.Contacts?.find((c) => c.ContactID && c.ContactStatus !== "ARCHIVED");
    if (hit?.ContactID) return hit.ContactID;
  }
  return null;
}

/** The payment link, to the person who sent the proposal (Xiomara, usually),
 * so she can share it with the client. Never to the client. */
async function emailPaymentLinks(sb: SupabaseClient, proposalId: string, clientName: string, invoices: CreatedInvoice[]) {
  const to = await notificationRecipients(sb, [], "proposals", proposalId);
  if (!to.length) return;
  const money = (n: number) => `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  for (const inv of invoices) {
    await sendEmail({
      to,
      subject: `Payment link: ${clientName} invoice ${inv.number}`,
      html: proposalEmailHtml({
        heading: `${clientName}: invoice ${inv.number} is ready to share`,
        bodyLines: [
          `The implementation invoice for ${clientName} (${money(inv.total)}, due ${inv.due_date}) is approved in Xero. It has not been sent to the client.`,
          "Share the link below with them. They can view and pay it there.",
        ],
        ctaLabel: "Open the invoice",
        ctaUrl: inv.online_url!,
      }),
    });
  }
}

async function recordError(sb: SupabaseClient, proposalId: string, error: string) {
  await sb.from("proposals").update({ xero_invoice_error: error.slice(0, 400) }).eq("id", proposalId);
}

export async function createDraftInvoiceForProposal(
  sb: SupabaseClient,
  proposalId: string,
): Promise<{ ok: true; invoices: CreatedInvoice[] } | { ok: false; error: string }> {
  const { data: proposalRow } = await sb
    .from("proposals")
    .select(
      "id, proposal_number, title, recipient_name, recipient_email, discount_type, discount_value, discount_applies_to, discount_label, client_signed_at, xero_invoice_id, xero_invoices, client:clients(company_name, email)",
    )
    .eq("id", proposalId)
    .maybeSingle();
  const proposal = proposalRow as ProposalRow | null;
  if (!proposal) return { ok: false, error: "proposal_not_found" };
  const already = Array.isArray(proposal.xero_invoices) ? proposal.xero_invoices : [];
  // An invoice from before invoices were split by kind: never post again.
  if (proposal.xero_invoice_id && already.length === 0) return { ok: false, error: "already_invoiced" };

  const { data: itemRows } = await sb
    .from("proposal_line_items")
    .select(
      "id, name, description, one_time_price, monthly_price, xero_service_key, xero_item_one_time, xero_item_monthly, template_slug, display_order",
    )
    .eq("proposal_id", proposalId);
  const items = ((itemRows ?? []) as LineItem[])
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));

  // Lines on signed proposals cannot be edited, so ones signed before Items
  // were mapped take their service's Items from the catalog by slug.
  const slugs = [...new Set(items.map((i) => i.template_slug).filter((s): s is string => Boolean(s)))];
  const catalog = new Map<string, { one: string | null; monthly: string | null; family: string | null }>();
  if (slugs.length) {
    const { data } = await sb
      .from("revenue_opportunity_templates")
      .select("slug, xero_item_one_time, xero_item_monthly, xero_service_key")
      .in("slug", slugs);
    for (const t of data ?? []) {
      catalog.set(t.slug as string, {
        one: (t.xero_item_one_time as string | null) ?? null,
        monthly: (t.xero_item_monthly as string | null) ?? null,
        family: (t.xero_service_key as string | null) ?? null,
      });
    }
  }

  const oneTimeSubtotal = items.reduce((s, i) => s + (num(i.one_time_price) ?? 0), 0);
  const monthlySubtotal = items.reduce((s, i) => s + (num(i.monthly_price) ?? 0), 0);
  if (oneTimeSubtotal <= 0 && monthlySubtotal <= 0) return { ok: false, error: "no_billable_fees" };

  const dType = proposal.discount_type ?? "none";
  const dValue = num(proposal.discount_value) ?? 0;
  const appliesTo = proposal.discount_applies_to ?? "one_time";
  const oneTimeDiscount = bucketDiscount(oneTimeSubtotal, dType, dValue, appliesTo === "one_time" || appliesTo === "both");
  const monthlyDiscount = bucketDiscount(monthlySubtotal, dType, dValue, appliesTo === "monthly" || appliesTo === "both");
  const ratio = (subtotal: number, discount: number) => (subtotal > 0 ? (subtotal - discount) / subtotal : 1);
  const ratios: Record<FeeKind, number> = {
    one_time: ratio(oneTimeSubtotal, oneTimeDiscount),
    monthly: ratio(monthlySubtotal, monthlyDiscount),
  };

  const conn = await loadConnection(sb);
  const defaults: AccountDefaults = {
    mrrAccountCode: conn?.mrr_account_code ?? null,
    salesAccountCode: conn?.sales_account_code ?? null,
  };
  const { data: mappingRows } = await sb
    .from("xero_revenue_accounts")
    .select("service_key, name, one_time_account_code, monthly_account_code");
  const mapping = (mappingRows ?? []) as RevenueAccountRow[];

  // Lines from the catalog take its coding; freehand ones (most proposals) are
  // coded from their name, then by Claude (xero-autocode.ts), saved on the
  // line, and listed on the draft so Maria can check them.
  for (const item of items) {
    const fromCatalog = item.template_slug ? catalog.get(item.template_slug) : undefined;
    if (!fromCatalog) continue;
    item.xero_service_key = item.xero_service_key ?? fromCatalog.family;
    item.xero_item_one_time = item.xero_item_one_time ?? fromCatalog.one;
    item.xero_item_monthly = item.xero_item_monthly ?? fromCatalog.monthly;
  }
  const { notes: autoCoded } = await autoCodeLines(sb, items, { title: proposal.title, ai: true });

  // Code every line BEFORE building anything, so one unmapped line stops all
  // of it instead of posting a partial invoice. Complimentary (zero after the
  // discount) lines need no coding: they are not invoiced.
  const failures: Extract<Resolved, { ok: false }>[] = [];
  const lines: PlanLine[] = [];
  for (const item of items) {
    const label = item.name?.trim() || "Untitled line";
    const detail = [label, item.description?.trim()].filter(Boolean).join(" - ").slice(0, 4000);
    const fromCatalog = item.template_slug ? catalog.get(item.template_slug) : undefined;
    for (const kind of ["one_time", "monthly"] as const) {
      const gross = num(kind === "one_time" ? item.one_time_price : item.monthly_price) ?? 0;
      const amount = gross * ratios[kind];
      if (Math.round(amount * 100) <= 0) continue;
      const resolved = resolveAccountCode(
        { label, serviceKey: item.xero_service_key ?? fromCatalog?.family ?? null, kind },
        mapping,
        defaults,
      );
      if (!resolved.ok) {
        failures.push(resolved);
        continue;
      }
      const itemCode = (kind === "one_time" ? item.xero_item_one_time ?? fromCatalog?.one : item.xero_item_monthly ?? fromCatalog?.monthly) ?? null;
      lines.push({
        kind,
        description: kind === "monthly" ? `${detail} (first month)`.slice(0, 4000) : detail,
        amount,
        accountCode: resolved.accountCode,
        itemCode,
      });
    }
  }
  if (failures.length > 0) {
    const error = describeUnmapped(failures);
    await recordError(sb, proposalId, error);
    return { ok: false, error };
  }

  const signedOn = newYorkDate(proposal.client_signed_at ? new Date(proposal.client_signed_at) : new Date());
  const plan = planInvoices(lines, signedOn);
  if (plan.length === 0) return { ok: false, error: "fully_discounted" };

  const reference = proposal.proposal_number ? `ECD-${String(proposal.proposal_number).padStart(4, "0")}` : proposal.title;
  const contactName = proposal.client?.company_name?.trim() || proposal.recipient_name?.trim() || "Client";
  const contactEmail = proposal.recipient_email?.trim() || proposal.client?.email?.trim() || undefined;
  const totalDiscount = oneTimeDiscount + monthlyDiscount;

  const created: CreatedInvoice[] = [...already];
  try {
    const contactId = await findContactId(sb, contactName, contactEmail);
    const contact = contactId
      ? { ContactID: contactId }
      : { Name: contactName, ...(contactEmail ? { EmailAddress: contactEmail } : {}) };

    for (const inv of plan) {
      if (created.some((c) => c.kind === inv.kind)) continue;
      const payload = {
        Invoices: [
          {
            Type: "ACCREC",
            // The implementation is approved but never sent (Zak, Oct 20): the API
            // emails nothing unless asked, and its payment link goes on the
            // proposal and to whoever sold it. The retainer's first month stays a
            // draft dated the 1st, for Maria to review and set up as repeating.
            Status: inv.kind === "one_time" ? "AUTHORISED" : "DRAFT",
            Contact: contact,
            Date: inv.date,
            DueDate: inv.dueDate,
            Reference: reference,
            LineAmountTypes: "Exclusive",
            LineItems: inv.lines.map((l) => ({
              Description: l.description,
              Quantity: 1,
              // Xero recomputes totals from UnitAmount, so the discount is folded
              // into the unit price proportionally rather than sent separately.
              UnitAmount: Math.round(l.amount * 100) / 100,
              AccountCode: l.accountCode,
              ...(l.itemCode ? { ItemCode: l.itemCode } : {}),
              ...(conn?.tax_type ? { TaxType: conn.tax_type } : {}),
            })),
          },
        ],
      };
      const out = await xeroApi<{ Invoices?: Array<{ InvoiceID?: string; InvoiceNumber?: string; Total?: number }> }>(
        sb,
        "/Invoices",
        // One key per proposal and kind: a retried call cannot make a second copy.
        { method: "POST", body: payload, idempotencyKey: `proposal-${proposalId}-${inv.kind}` },
      );
      const made = out.Invoices?.[0];
      if (!made?.InvoiceID) throw new Error("xero_no_invoice_returned");

      const notes = [
        `Created automatically from signed proposal ${reference}.`,
        totalDiscount > 0 ? `The ${proposal.discount_label || "discount"} was applied proportionally across the lines.` : "",
        autoCoded.length ? `Coded automatically, please check: ${autoCoded.join("; ")}.` : "",
        inv.kind === "monthly"
          ? "First month of the retainer. Set up the repeating invoice for the months after this one."
          : "",
      ].filter(Boolean).join(" ");
      await xeroApi(sb, `/Invoices/${made.InvoiceID}/History`, {
        method: "PUT",
        body: { HistoryRecords: [{ Details: notes.slice(0, 1000) }] },
      }).catch(() => {});

      // The link the client pays from, for an approved invoice.
      let onlineUrl: string | null = null;
      if (inv.kind === "one_time") {
        const online = await xeroApi<{ OnlineInvoices?: Array<{ OnlineInvoiceUrl?: string }> }>(
          sb,
          `/Invoices/${made.InvoiceID}/OnlineInvoice`,
        ).catch(() => null);
        onlineUrl = online?.OnlineInvoices?.[0]?.OnlineInvoiceUrl ?? null;
      }

      created.push({
        kind: inv.kind,
        id: made.InvoiceID,
        number: made.InvoiceNumber ?? "",
        date: inv.date,
        due_date: inv.dueDate,
        total: Math.round(inv.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100,
        status: inv.kind === "one_time" ? "AUTHORISED" : "DRAFT",
        online_url: onlineUrl,
      });
      // Saved after each one, so a failure on the second keeps the first.
      await sb
        .from("proposals")
        .update({
          xero_invoices: created,
          xero_invoice_id: created[0].id,
          xero_invoice_number: created[0].number || null,
          xero_invoiced_at: new Date().toISOString(),
          xero_invoice_error: null,
        })
        .eq("id", proposalId);
    }
    // Whoever sent the proposal gets the payment link to share with the client.
    const fresh = created.filter((c) => c.online_url && !already.some((a) => a.id === c.id));
    if (fresh.length) await emailPaymentLinks(sb, proposalId, contactName, fresh).catch((e) => console.warn("xero: payment link email failed", e));
    return { ok: true, invoices: created };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await recordError(sb, proposalId, error);
    return { ok: false, error };
  }
}
