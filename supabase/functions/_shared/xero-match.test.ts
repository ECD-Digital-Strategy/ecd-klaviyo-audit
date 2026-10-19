import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { familyForAccount, type MatchCandidate, matchLine } from "./xero-match.ts";

// A slice of the real catalog and Xero Items (Oct 19, 2026).
const catalog: MatchCandidate[] = [
  { name: "ECD Mini Implementation", itemCode: "1223", family: "retention", account: null },
  { name: "ECD Full Implementation", itemCode: "1222", family: "retention", account: null },
  { name: "Klaviyo Customer Agent", itemCode: "1126", family: "retention", account: null },
  { name: "Ongoing Account Management - Tier 1", itemCode: "1213", family: "retention", account: null },
  { name: "Ongoing Account Management - Tier 2", itemCode: "1214", family: "retention", account: null },
];
const items: MatchCandidate[] = [
  { name: "Mini Klaviyo Implementation", itemCode: "1223", family: null, account: "4011" },
  { name: "Klaviyo Implementation", itemCode: "1222", family: null, account: "4011" },
  { name: "K: Customer Agent", itemCode: "1126", family: null, account: "4012" },
  { name: "K: Migration", itemCode: "1226", family: null, account: "4011" },
  { name: "Shopify", itemCode: "1238", family: null, account: "4012" },
];
const all = [...catalog, ...items];

Deno.test("iHome's freehand line finds its Item", () => {
  const m = matchLine("Klaviyo Mini Implementation", all);
  assertEquals([m?.itemCode, m?.family], ["1223", "retention"]);
});

Deno.test("a catalog service's family wins over the Item's account", () => {
  // K: Customer Agent sits on 4012 in Xero, but the Klaviyo team's agent work is Retention.
  const m = matchLine("Klaviyo Customer Agent", all);
  assertEquals([m?.itemCode, m?.family], ["1126", "retention"]);
});

Deno.test("retainer tiers match the catalog wording", () => {
  assertEquals(matchLine("Ongoing Account Management: Tier 2", all)?.itemCode, "1214");
});

Deno.test("no clear match is left for a person", () => {
  assertEquals(matchLine("Holiday CRM Upgrade (Tier 2 Growth Plan)", all), null);
  assertEquals(matchLine("Flow Redesign (7 Emails + SMS)", all), null);
  // "Klaviyo Implementation" alone is 1222; "Klaviyo SMS Migration" is too far from any.
  assertEquals(matchLine("Klaviyo Implementation", all)?.itemCode, "1222");
});

Deno.test("accounts place a bare Item in its family", () => {
  assertEquals([familyForAccount("4011"), familyForAccount("4001"), familyForAccount("4013"), familyForAccount("200")], [
    "retention",
    "website",
    "paid_ads",
    null,
  ]);
});
