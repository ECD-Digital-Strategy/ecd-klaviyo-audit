// How likely a store is to be a $1M+ brand, from the outside only (Emil,
// 2026-11-02: "quality leads"). Nothing here sees revenue; it adds up signals
// that track it:
//  - traffic: the store's Tranco rank (a free, research-grade ranking of the
//    top million sites); a brand in the top 300k gets real traffic;
//  - catalogue size from /products.json (a handful of products is usually small);
//  - paid tools bigger brands buy: Attentive and Postscript (SMS), Recharge,
//    Yotpo or Okendo reviews, Gorgias;
//  - selling in USD to the US, the market Emil is after.
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
};

export type LeadScore = { score: number; reasons: string[] };

export function scoreLead(s: LeadSignals): LeadScore {
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(`${points > 0 ? "+" : ""}${points} ${reason}`);
  };

  const r = s.tranco_rank;
  if (r && r <= 100_000) add(40, `top 100k traffic (#${r.toLocaleString("en-US")})`);
  else if (r && r <= 300_000) add(30, `top 300k traffic (#${r.toLocaleString("en-US")})`);
  else if (r && r <= 600_000) add(20, `top 600k traffic (#${r.toLocaleString("en-US")})`);
  else if (r) add(10, `top 1M traffic (#${r.toLocaleString("en-US")})`);
  else reasons.push("+0 not in the top 1M sites");

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
