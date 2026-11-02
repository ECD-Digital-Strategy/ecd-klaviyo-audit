import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DEFAULT_INVOICING, daysOverdue, type InvoiceVars, longDate, mergeInvoicing, money, nudgeDue, renderInvoiceEmail } from "./invoice-email.ts";

const buildVarsForTest = (): InvoiceVars => ({
  first_name: "Sarah",
  company: "Carnegie Daily",
  proposal_title: "Website retainer",
  invoice_number: "INV-1234",
  total: money(700),
  due_date: longDate("2026-11-16"),
  pay_link: "https://in.xero.com/abc",
  sender_first_name: "Isa",
});

Deno.test("the default email fills in and links the pay page", () => {
  const r = renderInvoiceEmail(DEFAULT_INVOICING, buildVarsForTest());
  assertEquals(r.subject, "Invoice INV-1234 from ECD Digital Strategy");
  assertEquals(r.text.startsWith("Hi Sarah,\n\nThanks again for signing. Here's the invoice for Website retainer ($700.00, due November 16, 2026)."), true);
  assertEquals(r.html.includes('<a href="https://in.xero.com/abc">View and pay the invoice</a>'), true);
  assertEquals(r.text.trim().endsWith("Isa"), true);
});

Deno.test("an unknown placeholder stays visible", () => {
  assertEquals(renderInvoiceEmail({ subject: "x {nope}", body: "b" }, buildVarsForTest()).subject, "x {nope}");
});

Deno.test("settings: off by default, Maria copied, bad values fixed", () => {
  const s = mergeInvoicing({ nudge_after_days: "abc", cc_emails: ["maria@ecdigitalstrategy.com", "nope"] });
  assertEquals(s.auto_send, false);
  assertEquals(s.overdue_nudges, false);
  assertEquals(s.cc_emails, ["maria@ecdigitalstrategy.com"]);
  assertEquals(s.nudge_after_days, 7);
  assertEquals(mergeInvoicing(null).cc_emails, ["maria@ecdigitalstrategy.com"]);
});

Deno.test("nudges: 7 days past due, then weekly; old invoices left alone", () => {
  const s = { nudge_after_days: 7, nudges_since: "2026-11-01" };
  const inv = { date: "2026-11-02", due_date: "2026-11-10" };
  assertEquals(daysOverdue("2026-11-10", "2026-11-17"), 7);
  assertEquals(nudgeDue(inv, s, "2026-11-16"), false);
  assertEquals(nudgeDue(inv, s, "2026-11-17"), true);
  assertEquals(nudgeDue({ ...inv, last_nudge_at: "2026-11-17T14:00:00Z" }, s, "2026-11-20"), false);
  assertEquals(nudgeDue({ ...inv, last_nudge_at: "2026-11-17T14:00:00Z" }, s, "2026-11-24"), true);
  assertEquals(nudgeDue({ date: "2026-10-01", due_date: "2026-10-01" }, s, "2026-11-24"), false);
});
