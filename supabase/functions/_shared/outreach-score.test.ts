import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { scoreLead, shopifyLocale } from "./outreach-score.ts";

Deno.test("a busy US brand with paid SMS scores high", () => {
  const { score } = scoreLead({ tranco_rank: 85_000, products: 250, currency: "USD", country: "US", apps: ["Attentive", "Klaviyo", "Recharge"] });
  assertEquals(score, 95);
});

Deno.test("a tiny store outside the US scores low", () => {
  const { score, reasons } = scoreLead({ tranco_rank: null, products: 3, currency: "EUR", country: "DE", apps: ["Klaviyo"] });
  assertEquals(score, 0);
  assertEquals(reasons.some((r) => r.includes("outside the US")), true);
});

Deno.test("a hidden catalogue costs nothing", () => {
  assertEquals(scoreLead({ tranco_rank: 250_000, products: null, currency: "USD", country: null, apps: [] }).score, 40);
});

Deno.test("reads Shopify's currency and country", () => {
  const html = `<script>Shopify.country = "US";\nShopify.currency = {"active":"USD","rate":"1.0"};</script>`;
  assertEquals(shopifyLocale(html), { currency: "USD", country: "US" });
  assertEquals(shopifyLocale("<html></html>"), { currency: null, country: null });
});
