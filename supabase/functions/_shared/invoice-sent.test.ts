import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sentCandidates } from "./invoice-sent.ts";
import { draftMessageIdFromUrl } from "./gmail.ts";

const now = new Date("2026-11-18T12:00:00Z");
const inv = (p: Record<string, unknown> = {}) => ({
  kind: "one_time" as const, id: "inv1", number: "INV-1", date: "2026-11-10", due_date: "2026-11-10", total: 100,
  status: "AUTHORISED", drafted_at: "2026-11-15T10:00:00Z", drafted_from: "isa@x.com",
  draft_url: "https://mail.google.com/mail/u/isa%40x.com/#drafts?compose=msg123", ...p,
});
const row = (invoices: unknown[], welcome: unknown = null) => ({ id: "p1", title: "T", xero_invoices: invoices as never, welcome_email: welcome as never, client: { company_name: "Brand" } });

Deno.test("draftMessageIdFromUrl reads the compose id", () => {
  assertEquals(draftMessageIdFromUrl("https://mail.google.com/mail/u/a%40b.com/#drafts?compose=abc123"), "abc123");
  assertEquals(draftMessageIdFromUrl(null), null);
});

Deno.test("an approved, unpaid, drafted invoice is checked; older records use the link's message id", () => {
  const c = sentCandidates([row([inv()])], now);
  assertEquals(c.length, 1);
  assertEquals([c[0].how, c[0].messageId, c[0].draftId, c[0].label], ["gmail_draft", "msg123", null, "Brand INV-1"]);
  assertEquals(sentCandidates([row([inv({ draft_id: "d9" })])], now)[0].draftId, "d9");
});

Deno.test("paid, already marked, unapproved, monthly or old drafts are left alone", () => {
  for (const p of [{ paid_at: "2026-11-16" }, { sent_marked_at: "2026-11-16T00:00:00Z" }, { status: "DRAFT" }, { kind: "monthly" }, { drafted_at: "2026-08-01T00:00:00Z" }, { drafted_from: null }]) {
    assertEquals(sentCandidates([row([inv(p)])], now).length, 0, JSON.stringify(p));
  }
});

Deno.test("the welcome email's invoice is checked through the welcome draft", () => {
  const welcome = { status: "drafted", invoice_id: "inv1", draft_id: "wd1", from_email: "xio@x.com", drafted_at: "2026-11-16T00:00:00Z" };
  const c = sentCandidates([row([inv({ drafted_at: null, drafted_from: null, draft_url: null })], welcome)], now);
  assertEquals(c.map((x) => [x.how, x.draftId, x.fromEmail]), [["welcome_email", "wd1", "xio@x.com"]]);
  // Never twice for one invoice.
  assertEquals(sentCandidates([row([inv()], welcome)], now).length, 1);
  // Not while the welcome email is still waiting.
  assertEquals(sentCandidates([row([inv({ drafted_at: null, drafted_from: null })], { ...welcome, status: "waiting" })], now).length, 0);
});
