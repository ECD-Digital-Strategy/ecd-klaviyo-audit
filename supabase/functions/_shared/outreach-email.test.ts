import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { followUp, footer, inSendWindow, plainHtml, replySearchKey, startOfSendDay, withSignature, withoutCompanyLine } from "./outreach-email.ts";

Deno.test("send window: New York weekday working hours only", () => {
  // Tue 4 Nov 2026: New York is UTC-5.
  assert(inSendWindow(new Date("2026-11-04T14:30:00Z"))); // 09:30
  assert(inSendWindow(new Date("2026-11-04T20:59:00Z"))); // 15:59
  assert(!inSendWindow(new Date("2026-11-04T21:00:00Z"))); // 16:00
  assert(!inSendWindow(new Date("2026-11-04T13:59:00Z"))); // 08:59
  assert(!inSendWindow(new Date("2026-11-07T15:00:00Z"))); // Saturday 10:00
});

Deno.test("start of the send day is New York midnight or just before", () => {
  const s = startOfSendDay(new Date("2026-11-04T15:00:00Z"));
  assertEquals(s.toISOString(), "2026-11-04T04:00:00.000Z");
});

Deno.test("reply search uses the brand domain, never a free mail domain", () => {
  assertEquals(replySearchKey("Jane@Brooklinen.com", "brooklinen.com"), "brooklinen.com");
  assertEquals(replySearchKey("jane@mail.brooklinen.com", "brooklinen.com"), "mail.brooklinen.com");
  assertEquals(replySearchKey("founder@gmail.com", "brooklinen.com"), "founder@gmail.com");
  assertEquals(replySearchKey("jane@otheragency.com", "brooklinen.com"), "jane@otheragency.com");
});

Deno.test("plain html keeps paragraphs, line breaks and links, escapes the rest", () => {
  const html = plainHtml("Hi <there>,\n\nLine one\nLine two\n\nhttps://audit.ecdigitalstrategy.com/report/abc");
  assertStringIncludes(html, "Hi &lt;there&gt;,");
  assertStringIncludes(html, "Line one<br>Line two");
  assertStringIncludes(html, '<a href="https://audit.ecdigitalstrategy.com/report/abc">');
});

Deno.test("footer is the opt-out line only", () => {
  assertStringIncludes(footer(), "reply \"no\"");
  assertEquals(footer().split("\n").length, 1);
});

Deno.test("send window hours are configurable", () => {
  // Tue 4 Nov 2026 17:30 New York.
  assert(!inSendWindow(new Date("2026-11-04T22:30:00Z")));
  assert(inSendWindow(new Date("2026-11-04T22:30:00Z"), 8, 18));
});

Deno.test("signature goes under the email, and the company line is dropped", () => {
  assertEquals(withSignature("<p>x</p>", null), "<p>x</p>");
  assertStringIncludes(withSignature("<p>x</p>", "<b>Emil</b>"), "<div class=\"gmail_signature\"><b>Emil</b></div>");
  assertEquals(withoutCompanyLine("Thanks\n\nEmil\nECD Digital Strategy"), "Thanks\n\nEmil");
  assertEquals(withoutCompanyLine("Thanks\n\nEmil"), "Thanks\n\nEmil");
});

Deno.test("follow-ups name the person when known and carry the report link", () => {
  const ask = followUp(1, { firstName: "Jane", brand: "Brooklinen", reportUrl: null });
  assertEquals(ask.includes("http"), false);
  assertEquals(ask.includes("Brooklinen"), true);
  assertEquals(/[–—]/.test(ask + followUp(2, { brand: "B", reportUrl: null })), false);
  const one = followUp(1, { firstName: "Jane", brand: "Brooklinen", reportUrl: "https://x/r" });
  assertStringIncludes(one, "Hi Jane,");
  assertStringIncludes(one, "https://x/r");
  const two = followUp(2, { brand: "Brooklinen", reportUrl: "https://x/r", bookingUrl: "https://cal/emil" });
  assertStringIncludes(two, "Hi there,");
  assertStringIncludes(two, "https://cal/emil");
  assert(!/[–—]/.test(one + two));
});
