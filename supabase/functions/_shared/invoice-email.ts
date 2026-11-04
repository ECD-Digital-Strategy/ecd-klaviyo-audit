// The invoice email a client gets when they sign, and when an unpaid one is worth
// a nudge (Emil + Isa, 2026-11-02). The flow agreed with Isa:
//  - sent from the Gmail of whoever CREATED the proposal (a proposal can pick
//    someone else under "Invoice sent by");
//  - if that person hasn't connected their Gmail, it comes from the fallback
//    sender (Xiomara) with an intro email ("Hi, I'm Xiomara..."), since the client
//    may not know her;
//  - unpaid 7 days after it was sent: the reminder list (Xiomara, Maria, Isa) is
//    told, then weekly; optionally the client gets a polite reminder too;
//  - Maria is copied on all of it.
// Settings live in
// platform_settings.proposal_settings.invoicing; keep the defaults in sync with
// src/lib/proposals-db.ts DEFAULT_PROPOSAL_SETTINGS.invoicing.

import { DEFAULT_WELCOME, mergeWelcome, type WelcomeSettings } from "./welcome-email.ts";

export type InvoicingSettings = {
  /** Email the implementation invoice to the client at signing. OFF until turned on. */
  auto_send: boolean;
  /** Always copied on invoice emails and client reminders (Maria). */
  cc_emails: string[];
  /** Whose Gmail sends when the proposal's creator hasn't connected theirs (Xiomara). */
  fallback_sender_email: string;
  /** Tell the reminder list about unpaid invoices. OFF until turned on. */
  overdue_nudges: boolean;
  /** Who hears about unpaid invoices (Xiomara, Maria, Isa). */
  reminder_emails: string[];
  /** Also remind the CLIENT, from the same Gmail the invoice came from. OFF until turned on. */
  client_reminders: boolean;
  /** First reminder this many days after the invoice was sent, then weekly. */
  nudge_after_days: number;
  /** Only invoices dated on or after this (set when reminders are turned on), so old ones are left alone. */
  nudges_since: string | null;
  subject: string;
  body: string;
  /** The email when it comes from the fallback sender: introduces them first. */
  intro_subject: string;
  intro_body: string;
  /** The reminder the client gets, when client_reminders is on. */
  reminder_subject: string;
  reminder_body: string;
  /** The welcome email (invoice + next steps), see welcome-email.ts. */
  welcome: WelcomeSettings;
};

export const DEFAULT_INVOICING: InvoicingSettings = {
  auto_send: false,
  cc_emails: ["maria@ecdigitalstrategy.com"],
  fallback_sender_email: "xiomara@ecdigitalstrategy.com",
  overdue_nudges: false,
  reminder_emails: ["xiomara@ecdigitalstrategy.com", "maria@ecdigitalstrategy.com", "isa@ecdigitalstrategy.com"],
  client_reminders: false,
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
  intro_subject: "Invoice {invoice_number} from ECD Digital Strategy",
  intro_body: [
    "Hi {first_name},",
    "",
    "I'm {sender_first_name} from ECD Digital Strategy. I look after invoicing for the team you're working with, so you'll hear from me about payments.",
    "",
    "Thanks for signing. Here's the invoice for {proposal_title} ({total}, due {due_date}).",
    "",
    "You can view and pay it here: {pay_link}",
    "",
    "The PDF is attached too. If anything looks off, just reply to this email.",
    "",
    "{sender_first_name}",
  ].join("\n"),
  reminder_subject: "Reminder: invoice {invoice_number} from ECD Digital Strategy",
  welcome: DEFAULT_WELCOME,
  reminder_body: [
    "Hi {first_name},",
    "",
    "A quick reminder about invoice {invoice_number} for {proposal_title} ({total}, due {due_date}). If it's already on its way, thank you and please ignore this.",
    "",
    "You can view and pay it here: {pay_link}",
    "",
    "{sender_first_name}",
  ].join("\n"),
};

const emails = (v: unknown, fallback: string[]) =>
  Array.isArray(v) ? v.filter((e): e is string => typeof e === "string" && e.includes("@")).map((e) => e.trim().toLowerCase()) : fallback;
const text = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v : fallback);

export function mergeInvoicing(raw: unknown): InvoicingSettings {
  const v = (raw ?? {}) as Partial<InvoicingSettings>;
  const d = DEFAULT_INVOICING;
  return {
    ...d,
    ...v,
    auto_send: v.auto_send === true,
    overdue_nudges: v.overdue_nudges === true,
    client_reminders: v.client_reminders === true,
    cc_emails: emails(v.cc_emails, d.cc_emails),
    reminder_emails: emails(v.reminder_emails, d.reminder_emails),
    fallback_sender_email: text(v.fallback_sender_email, d.fallback_sender_email).trim().toLowerCase(),
    nudge_after_days: Math.max(1, Math.min(60, Math.round(Number(v.nudge_after_days ?? d.nudge_after_days)) || 7)),
    subject: text(v.subject, d.subject),
    body: text(v.body, d.body),
    intro_subject: text(v.intro_subject, d.intro_subject),
    intro_body: text(v.intro_body, d.intro_body),
    reminder_subject: text(v.reminder_subject, d.reminder_subject),
    reminder_body: text(v.reminder_body, d.reminder_body),
    welcome: mergeWelcome(v.welcome),
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

/** When the invoice went to the client: the day it was emailed, else its date. */
export const sentOn = (inv: { date: string; emailed_at?: string | null }) => (inv.emailed_at ? inv.emailed_at.slice(0, 10) : inv.date);

/** Whether an unpaid invoice gets a reminder today: first nudge_after_days after
 * it was sent (Isa: "not paid within 7 days of sending"), then every 7 days after
 * the last one. */
export function nudgeDue(
  inv: { date: string; emailed_at?: string | null; last_nudge_at?: string | null },
  s: Pick<InvoicingSettings, "nudge_after_days" | "nudges_since">,
  today: string,
): boolean {
  const sent = sentOn(inv);
  if (!sent) return false;
  if (s.nudges_since && inv.date && inv.date < s.nudges_since) return false;
  if (daysOverdue(sent, today) < s.nudge_after_days) return false;
  if (!inv.last_nudge_at) return true;
  return daysOverdue(inv.last_nudge_at.slice(0, 10), today) >= 7;
}
