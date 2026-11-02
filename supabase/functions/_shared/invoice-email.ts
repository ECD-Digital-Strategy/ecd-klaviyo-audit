// The invoice email a client gets when they sign, and when an unpaid one is worth
// a nudge (Emil + Isa, 2026-11-02). Settings live in
// platform_settings.proposal_settings.invoicing; keep the defaults in sync with
// src/lib/proposals-db.ts DEFAULT_PROPOSAL_SETTINGS.invoicing.

export type InvoicingSettings = {
  /** Email the implementation invoice to the client at signing. OFF until turned on. */
  auto_send: boolean;
  /** Always copied on invoice emails (Maria). */
  cc_emails: string[];
  /** Nudge Maria and the sender about unpaid invoices. OFF until turned on. */
  overdue_nudges: boolean;
  /** First nudge this many days after the due date, then weekly. */
  nudge_after_days: number;
  /** Only invoices dated on or after this (set when nudges are turned on), so old ones are left alone. */
  nudges_since: string | null;
  subject: string;
  body: string;
};

export const DEFAULT_INVOICING: InvoicingSettings = {
  auto_send: false,
  cc_emails: ["maria@ecdigitalstrategy.com"],
  overdue_nudges: false,
  nudge_after_days: 7,
  nudges_since: null,
  subject: "Invoice {invoice_number} from ECD Digital Strategy",
  body: [
    "Hi {first_name},",
    "",
    "Thanks again for signing. Here's the invoice for {proposal_title} ({total}, due {due_date}).",
    "",
    "You can view and pay it here: {pay_link}",
    "",
    "The PDF is attached too. Let me know if anything looks off.",
    "",
    "{sender_first_name}",
  ].join("\n"),
};

export function mergeInvoicing(raw: unknown): InvoicingSettings {
  const v = (raw ?? {}) as Partial<InvoicingSettings>;
  return {
    ...DEFAULT_INVOICING,
    ...v,
    cc_emails: Array.isArray(v.cc_emails) ? v.cc_emails.filter((e) => typeof e === "string" && e.includes("@")) : DEFAULT_INVOICING.cc_emails,
    nudge_after_days: Math.max(1, Math.min(60, Math.round(Number(v.nudge_after_days ?? DEFAULT_INVOICING.nudge_after_days)) || 7)),
    subject: typeof v.subject === "string" && v.subject.trim() ? v.subject : DEFAULT_INVOICING.subject,
    body: typeof v.body === "string" && v.body.trim() ? v.body : DEFAULT_INVOICING.body,
  };
}

export type InvoiceVars = {
  first_name: string;
  company: string;
  proposal_title: string;
  invoice_number: string;
  total: string;
  due_date: string;
  pay_link: string;
  sender_first_name: string;
};

/** Fills {placeholders}; unknown ones are left as typed so a typo is visible, not silent. */
export function fill(template: string, vars: InvoiceVars): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k as keyof InvoiceVars] : m));
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The email as plain text and as simple HTML (the pay link clickable). */
export function renderInvoiceEmail(s: Pick<InvoicingSettings, "subject" | "body">, vars: InvoiceVars): { subject: string; text: string; html: string } {
  const text = fill(s.body, vars);
  const html = esc(text)
    .replace(esc(vars.pay_link), `<a href="${esc(vars.pay_link)}">View and pay the invoice</a>`)
    .replace(/\n/g, "<br>");
  return {
    subject: fill(s.subject, vars).replace(/\s+/g, " ").trim(),
    text,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">${html}</div>`,
  };
}

/** "March 4, 2026" from a yyyy-mm-dd date. */
export function longDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export const money = (n: number, currency = "USD") =>
  n.toLocaleString("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Days from the due date to today (New York dates); negative before it is due. */
export function daysOverdue(dueDate: string, today: string): number {
  return Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${dueDate}T12:00:00Z`)) / 86_400_000);
}

/** Whether an unpaid invoice gets a nudge today: first at nudge_after_days past
 * due, then every 7 days after the last one. */
export function nudgeDue(
  inv: { due_date: string; date: string; last_nudge_at?: string | null },
  s: Pick<InvoicingSettings, "nudge_after_days" | "nudges_since">,
  today: string,
): boolean {
  if (!inv.due_date) return false;
  if (s.nudges_since && inv.date && inv.date < s.nudges_since) return false;
  if (daysOverdue(inv.due_date, today) < s.nudge_after_days) return false;
  if (!inv.last_nudge_at) return true;
  return daysOverdue(inv.last_nudge_at.slice(0, 10), today) >= 7;
}
