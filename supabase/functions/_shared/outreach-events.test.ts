import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { approachFor, groupGuests, pickGuest, relevantMatches, type EventGuest } from "./outreach-events.ts";

const g = (p: Partial<EventGuest>): EventGuest => ({
  brand: null, domain: null, contact_id: null, email: null, first_name: null, last_name: null, title: null, removed: false, ...p,
});

Deno.test("groupGuests: by website, work email fills a missing one, personal email is unplaced", () => {
  const { brands, unplaced } = groupGuests([
    g({ domain: "brand.com", email: "a@brand.com", brand: "Brand" }),
    g({ domain: "www.brand.com", email: "b@brand.com" }),
    g({ email: "c@other.co" }),
    g({ email: "d@gmail.com" }),
  ]);
  assertEquals(brands.map((b) => [b.domain, b.guests.length, b.brand]), [["brand.com", 2, "Brand"], ["other.co", 1, null]]);
  assertEquals(unplaced, 1);
});

Deno.test("groupGuests: a brand is removed only when every guest is", () => {
  const { brands } = groupGuests([
    g({ domain: "x.com", email: "a@x.com", removed: true }),
    g({ domain: "x.com", email: "b@x.com" }),
    g({ domain: "y.com", email: "c@y.com", removed: true }),
  ]);
  assertEquals(brands.map((b) => [b.domain, b.removed]), [["x.com", false], ["y.com", true]]);
});

Deno.test("pickGuest: skips removed guests and prefers the brand's own domain", () => {
  const { brands } = groupGuests([
    g({ domain: "x.com", email: "boss@gmail.com" }),
    g({ domain: "x.com", email: "gone@x.com", removed: true }),
    g({ domain: "x.com", email: "lead@x.com" }),
  ]);
  assertEquals(pickGuest(brands[0])?.email, "lead@x.com");
});

Deno.test("approachFor: non-Shopify always discovery, Shopify split stably", () => {
  assertEquals(approachFor("anything.com", false), "discovery");
  const a = approachFor("jockofuel.com", true);
  assertEquals(approachFor("jockofuel.com", true), a);
  const split = ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com", "g.com", "h.com"].map((d) => approachFor(d, true));
  assertEquals(split.includes("audit") && split.includes("discovery"), true);
});

Deno.test("relevantMatches: an event guest is not blocked by the event's own records", () => {
  const m = [
    { kind: "event", id: "e", label: "Webinar" },
    { kind: "contact", id: "1", label: "event" },
    { kind: "company", id: "2", label: "Brand" },
  ];
  assertEquals(relevantMatches("event", m), []);
  assertEquals(relevantMatches("cold", m).length, 3);
  assertEquals(relevantMatches("event", [...m, { kind: "deal", id: "9", label: "Closed Lost" }]).map((x) => x.kind), ["deal"]);
});
