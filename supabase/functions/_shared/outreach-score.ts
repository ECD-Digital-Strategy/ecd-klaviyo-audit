// How likely a store is to be a $1M+ brand, from the outside only (Emil,
// 2026-11-02: "quality leads"). Nothing here sees revenue; it adds up signals
// that track it:
//  - traffic: the store's Tranco rank (a free, research-grade ranking of the
//    top million sites); a brand in the top 300k gets real traffic;
//  - catalogue size from /products.json (a handful of products is usually small);
//  - paid tools bigger brands buy: Attentive and Postscript (SMS), Recharge,
//    Yotpo or Okendo reviews, Gorgias;
//  - selling in USD to the US, the market Emil is after.
// Retuned 2026-11-23 (Emil: aim at $1M to $20M Shopify brands without a dev team, for web projects):
//  - the very busiest stores score less, not more: they almost always have their own developers;
//  - the theme counts: a free Shopify theme (Dawn and friends) or a theme-store theme says nobody codes the site
//    in-house; a fully custom theme says somebody does.
// outreach_screen scores each store; below the threshold on the Settings tab it
// is skipped (with the score, so Emil can keep it anyway), and the auto-pipeline
// takes the highest scores first.

export type LeadSignals = {
  tranco_rank: number | null;
  /** Products on the first page of /products.json (max 250); null when it is blocked. */
  products: number | null;
  currency: string | null;
  country: string | null;
  apps: string[];
  /** The storefront theme Shopify prints into the page (Shopify.theme), when it does. */
  theme?: ShopifyTheme | null;
};

export type ShopifyTheme = { name: string | null; schema_name: string | null; schema_version: string | null };

// Shopify's free themes (Online Store 2.0 family and the older free ones).
const FREE_THEMES = new Set([
  "dawn", "refresh", "sense", "craft", "studio", "taste", "crave", "colorblock", "ride", "origin", "publisher",
  "spotlight", "trade", "horizon", "heritage", "fabric", "atelier", "tinker", "savor", "vessel", "dwell", "pitch",
  "debut", "brooklyn", "minimal", "narrative", "simple", "supply", "venture", "boundless", "express",
]);
// Popular paid themes from the Shopify theme store.
const STORE_THEMES = new Set([
  "impulse", "prestige", "turbo", "warehouse", "empire", "motion", "symmetry", "broadcast", "focal", "impact",
  "expanse", "stiletto", "be yours", "local", "pipeline", "streamline", "palo alto", "flex", "booster", "ella",
  "kalles", "wokiee", "shrine", "enterprise", "district", "parallax", "showcase", "envy", "minimog", "athens",
  "concept", "xtra", "sleek", "eurus", "maestrooo", "release", "habitat", "hyper", "woodstock", "editions",
]);

/** The theme Shopify prints into every storefront page, or null. */
export function shopifyTheme(html: string): ShopifyTheme | null {
  const raw = html.match(/Shopify\.theme\s*=\s*(\{[^;<]*?\})\s*;/)?.[1];
  if (!raw) return null;
  const pick = (key: string) => raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]{1,80})"`))?.[1] ?? null;
  return { name: pick("name"), schema_name: pick("schema_name"), schema_version: pick("schema_version") };
}

/** "free", "store" (a paid theme-store theme) or "custom"; null when the page did not say. */
export function themeKind(t: ShopifyTheme | null | undefined): "free" | "store" | "custom" | null {
  if (!t || (!t.name && !t.schema_name)) return null;
  const schema = (t.schema_name ?? "").trim().toLowerCase();
  if (FREE_THEMES.has(schema)) return "free";
  if (STORE_THEMES.has(schema)) return "store";
  if (schema) return "store"; // any named theme-store schema we do not list is still a bought theme
  return "custom";
}

export type LeadScore = { score: number; reasons: string[] };

export function scoreLead(s: LeadSignals): LeadScore {
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(`${points > 0 ? "+" : ""}${points} ${reason}`);
  };

  // Traffic: the sweet spot is a real brand that is not yet a giant (roughly $1M to $20M a year).
  const r = s.tranco_rank;
  const rank = r ? `#${r.toLocaleString("en-US")}` : "";
  if (r && r <= 30_000) add(10, `very high traffic (${rank}): likely a big brand with its own developers`);
  else if (r && r <= 400_000) add(35, `traffic in the sweet spot (${rank})`);
  else if (r && r <= 700_000) add(25, `top 700k traffic (${rank})`);
  else if (r) add(10, `top 1M traffic (${rank})`);
  else reasons.push("+0 not in the top 1M sites");

  const kind = themeKind(s.theme);
  const themeName = s.theme?.schema_name || s.theme?.name || "";
  if (kind === "free") add(10, `free Shopify theme (${themeName}): likely no in-house developer`);
  else if (kind === "store") add(5, `theme-store theme (${themeName})`);
  else if (kind === "custom") add(-10, "custom-built theme: likely has developers");

  const p = s.products;
  if (p === null) reasons.push("+0 catalogue hidden");
  else if (p >= 100) add(15, `${p >= 250 ? "250+" : p} products`);
  else if (p >= 30) add(10, `${p} products`);
  else if (p >= 10) add(5, `${p} products`);
  else if (p < 5) add(-10, `only ${p} product${p === 1 ? "" : "s"}`);

  const apps = new Set(s.apps);
  if (apps.has("Attentive") || apps.has("Postscript")) add(20, `pays for SMS (${["Attentive", "Postscript"].filter((a) => apps.has(a)).join(", ")})`);
  for (const app of ["Recharge", "Gorgias"]) if (apps.has(app)) add(5, app);
  if (apps.has("Yotpo") || apps.has("Okendo")) add(5, apps.has("Yotpo") ? "Yotpo" : "Okendo");
  if (apps.has("Klaviyo")) add(5, "Klaviyo");

  const currency = (s.currency ?? "").toUpperCase();
  const country = (s.country ?? "").toUpperCase();
  if (currency === "USD" || country === "US") add(10, "sells in USD / US");
  else if (currency || country) add(-15, `sells outside the US (${[currency, country].filter(Boolean).join(", ")})`);

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

/** Currency and country Shopify prints into every storefront page. */
export function shopifyLocale(html: string): { currency: string | null; country: string | null } {
  const currency = html.match(/Shopify\.currency\s*=\s*\{[^}]*"active"\s*:\s*"([A-Z]{3})"/)?.[1] ?? null;
  const country = html.match(/Shopify\.country\s*=\s*"([A-Z]{2})"/)?.[1] ?? null;
  return { currency, country };
}
