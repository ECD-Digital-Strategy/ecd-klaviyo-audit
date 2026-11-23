import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { scoreLead, shopifyLocale, shopifyTheme, themeKind } from "./outreach-score.ts";

Deno.test("a busy US brand with paid SMS scores high", () => {
  const { score } = scoreLead({ tranco_rank: 85_000, products: 250, currency: "USD", country: "US", apps: ["Attentive", "Klaviyo", "Recharge"] });
  assertEquals(score, 90); // 35 sweet-spot traffic (2026-11-23 bands), 15, 20, 5, 5, 10
});

Deno.test("a tiny store outside the US scores low", () => {
  const { score, reasons } = scoreLead({ tranco_rank: null, products: 3, currency: "EUR", country: "DE", apps: ["Klaviyo"] });
  assertEquals(score, 0);
  assertEquals(reasons.some((r) => r.includes("outside the US")), true);
});

Deno.test("a hidden catalogue costs nothing", () => {
  assertEquals(scoreLead({ tranco_rank: 250_000, products: null, currency: "USD", country: null, apps: [] }).score, 45);
});

Deno.test("reads Shopify's currency and country", () => {
  const html = `<script>Shopify.country = "US";\nShopify.currency = {"active":"USD","rate":"1.0"};</script>`;
  assertEquals(shopifyLocale(html), { currency: "USD", country: "US" });
  assertEquals(shopifyLocale("<html></html>"), { currency: null, country: null });
});

Deno.test("reads the storefront theme and what kind it is", () => {
  const html = `<script>Shopify.theme = {"name":"Dawn - live","id":123,"schema_name":"Dawn","schema_version":"15.2.0","theme_store_id":887,"role":"main"};</script>`;
  const t = shopifyTheme(html);
  assertEquals(t, { name: "Dawn - live", schema_name: "Dawn", schema_version: "15.2.0" });
  assertEquals(themeKind(t), "free");
  assertEquals(themeKind({ name: "Impulse", schema_name: "Impulse", schema_version: "7.0" }), "store");
  assertEquals(themeKind({ name: "brand-2024", schema_name: null, schema_version: null }), "custom");
  assertEquals(shopifyTheme("<html></html>"), null);
});

Deno.test("the busiest stores score lower than a mid-size brand on a free theme (2026-11-23 retune)", () => {
  const giant = scoreLead({ tranco_rank: 12_000, products: 250, currency: "USD", country: "US", apps: ["Attentive"], theme: { name: "custom", schema_name: null, schema_version: null } });
  const mid = scoreLead({ tranco_rank: 180_000, products: 80, currency: "USD", country: "US", apps: ["Klaviyo"], theme: { name: "Dawn", schema_name: "Dawn", schema_version: "15.0.0" } });
  assertEquals(mid.score > giant.score, true);
});
