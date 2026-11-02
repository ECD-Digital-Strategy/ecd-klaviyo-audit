import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { followUp, footer, inSendWindow, plainHtml, replySearchKey, startOfSendDay } from "./outreach-email.ts";

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

Deno.test("footer adds the address only once it is set", () => {
  assertEquals(footer(null).split("\n").length, 1);
  assertStringIncludes(footer("123 Main St, Austin, TX"), "ECD Digital Strategy, 123 Main St, Austin, TX");
});

Deno.test("follow-ups name the person when known and carry the report link", () => {
  const one = followUp(1, { firstName: "Jane", brand: "Brooklinen", reportUrl: "https://x/r" });
  assertStringIncludes(one, "Hi Jane,");
  assertStringIncludes(one, "https://x/r");
  const two = followUp(2, { brand: "Brooklinen", reportUrl: "https://x/r", bookingUrl: "https://cal/emil" });
  assertStringIncludes(two, "Hi there,");
  assertStringIncludes(two, "https://cal/emil");
  assert(!/[–—]/.test(one + two));
});
