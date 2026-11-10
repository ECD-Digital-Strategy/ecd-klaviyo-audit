import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { addressesIn, type MatchCandidate, matchMessage, messageIdsIn } from "./mail-parse.ts";

type C = MatchCandidate & { id: string };
const SENT = Date.UTC(2026, 10, 9, 15);
const jane: C = { id: "jane", contactEmail: "Jane@Brand.com", domain: "brand.com", messageIds: ["<outreach-1@ecdigitalstrategy.com>"], inSequence: true, sentAt: SENT };
const sam: C = { id: "sam", contactEmail: "sam.owner@gmail.com", domain: "shop.com", messageIds: ["<outreach-2@ecdigitalstrategy.com>", "<outreach-2b@ecdigitalstrategy.com>"], inSequence: true, sentAt: SENT };
const old: C = { id: "old", contactEmail: "lee@oldbrand.com", domain: "oldbrand.com", messageIds: ["<outreach-3@ecdigitalstrategy.com>"], inSequence: false, sentAt: SENT };
const all = [jane, sam, old];
const OWN = "emil@ecdigitalstrategy.com";
const who = (m: Parameters<typeof matchMessage>[0]) => {
  const r = matchMessage(m, all, OWN);
  return r ? `${r.prospect.id}:${r.by}` : null;
};

Deno.test("thread headers beat address beat domain", () => {
  // From Jane's address, but answering Sam's follow-up: the thread wins.
  assertEquals(who({ from: "Jane <jane@brand.com>", inReplyTo: "<outreach-2b@ecdigitalstrategy.com>" }), "sam:thread");
  assertEquals(who({ from: "x@elsewhere.org", references: "<a@b> <OUTREACH-1@ecdigitalstrategy.com>" }), "jane:thread");
  // Sam's exact address beats Jane's domain via Reply-To.
  assertEquals(who({ from: "Sam <sam.owner@gmail.com>", replyTo: "team@brand.com" }), "sam:address");
  assertEquals(who({ from: '"Jane Doe" <JANE@brand.com>' }), "jane:address");
  assertEquals(who({ from: "Ops <ops@mail.brand.com>" }), "jane:domain");
  // A helpdesk sending on their behalf: Reply-To counts.
  assertEquals(who({ from: "support@zendesk.com", replyTo: "Jane <jane@brand.com>" }), "jane:address");
});

Deno.test("role and unrelated senders are not matched", () => {
  assertEquals(who({ from: "Shopify <noreply@shopify.com>" }), null);
  assertEquals(who({ from: "support@notbrand.com" }), null);
  assertEquals(who({ from: "someone@gmail.com" }), null); // Sam is free mail: his address only, never gmail.com
  assertEquals(who({ from: '"jane@brand.com via LinkedIn" <messages@linkedin.com>' }), null); // a display name is not an address
  assertEquals(who({ from: "news@brand.com.evil.io" }), null);
  // Domain only for prospects in a sequence; their exact address still matches.
  assertEquals(who({ from: "info@oldbrand.com" }), null);
  assertEquals(who({ from: "lee@oldbrand.com" }), "old:address");
});

Deno.test("our own mail never matches, even in the thread", () => {
  assertEquals(who({ from: `Emil <${OWN}>`, inReplyTo: "<outreach-1@ecdigitalstrategy.com>" }), null);
});

Deno.test("address and domain only count from the day they were emailed; the thread always", () => {
  const before = Date.UTC(2026, 10, 8, 23);
  const sameDayEarlier = Date.UTC(2026, 10, 9, 1);
  assertEquals(who({ from: "jane@brand.com", internalDate: before }), null);
  assertEquals(who({ from: "jane@brand.com", internalDate: sameDayEarlier }), "jane:address");
  assertEquals(who({ from: "x@y.com", inReplyTo: "<outreach-1@ecdigitalstrategy.com>", internalDate: before }), "jane:thread");
});

Deno.test("address and message-id helpers", () => {
  assertEquals(addressesIn('"A, B" <A@x.com>, c@y.com'), ["a@x.com"]);
  assertEquals(addressesIn("plain@x.com, other@y.com"), ["plain@x.com", "other@y.com"]);
  assertEquals(messageIdsIn("<A@b> <c@d>"), ["<a@b>", "<c@d>"]);
});
