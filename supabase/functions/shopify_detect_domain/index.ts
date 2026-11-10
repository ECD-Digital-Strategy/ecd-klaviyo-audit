// Detect a store's real *.myshopify.com domain from its public storefront.
// Shopify storefronts expose the permanent domain in the page (Shopify.shop, the
// shopUrl monorail payload, or CDN/asset references), which the naive
// "strip the TLD" guess in the wizard cannot know. Best-effort; returns null if
// the site isn't a detectable Shopify storefront.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { requireStaffUserId } from "../_shared/auth.ts";

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, accept, origin, referer, user-agent",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
    ...init,
  });
}

function normalizeUrl(input: string): string | null {
  let raw = (input ?? "").trim();
  if (!raw) return null;
  // Any other explicit scheme (file:, ftp:, data:) is refused, not prefixed.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** True for loopback, private, link-local, CGNAT and other non-public IPv4. */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

/** True for loopback, unspecified, link-local, unique-local and mapped private IPv6. */
function isPrivateIpv6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::" || v === "::1") return true;
  if (/^fe[89ab]/.test(v)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(v)) return true; // unique local fc00::/7
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (v.startsWith("::ffff:")) return true; // hex-form mapped address, refuse to be safe
  return false;
}

/** Refuse anything that is not a public internet host, so this function cannot
 * be pointed at the platform's own network. Checks the literal host and, where
 * the runtime allows it, what the name resolves to. */
async function isPublicHost(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return false;
  }
  if (host.startsWith("[") || host.includes(":")) return !isPrivateIpv6(host);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !isPrivateIpv4(host);
  // Bare numbers or hex (e.g. 2130706433, 0x7f.1) are IP tricks, not store names.
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) return false;
  try {
    const [a, aaaa] = await Promise.all([
      Deno.resolveDns(host, "A").catch(() => [] as string[]),
      Deno.resolveDns(host, "AAAA").catch(() => [] as string[]),
    ]);
    if (a.some(isPrivateIpv4) || aaaa.some(isPrivateIpv6)) return false;
  } catch {
    // DNS lookups unavailable here: the literal checks above still apply.
  }
  return true;
}

/** Fetch with redirects followed by hand, so every hop is checked as public. */
async function fetchPublic(startUrl: string, signal: AbortSignal): Promise<Response | null> {
  let url = startUrl;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!(await isPublicHost(u.hostname))) return null;
    const res = await fetch(url, {
      redirect: "manual",
      signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; ECDAudit/1.0)", accept: "text/html" },
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      url = new URL(location, url).toString();
      continue;
    }
    return res;
  }
  return null;
}

/** Pull the first plausible *.myshopify.com handle from storefront HTML. */
function extractMyshopifyDomain(html: string): string | null {
  // Most reliable: the Shopify.shop global or the shopId/permanent-domain payload.
  const patterns = [
    /Shopify\.shop\s*=\s*["']([a-z0-9][a-z0-9-]*\.myshopify\.com)["']/i,
    /"shopDomain"\s*:\s*"([a-z0-9][a-z0-9-]*\.myshopify\.com)"/i,
    /"myshopifyDomain"\s*:\s*"([a-z0-9][a-z0-9-]*\.myshopify\.com)"/i,
    /permanent_domain["']?\s*[:=]\s*["']([a-z0-9][a-z0-9-]*\.myshopify\.com)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1].toLowerCase();
  }
  // Fallback: any *.myshopify.com token that isn't a CDN/asset host.
  const all = html.match(/\b([a-z0-9][a-z0-9-]*\.myshopify\.com)\b/gi) ?? [];
  for (const candidate of all) {
    const host = candidate.toLowerCase();
    if (host.startsWith("cdn.") || host.startsWith("checkout.")) continue;
    return host;
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, { status: 405 });
  // Staff with audit access only: this makes outbound requests on our behalf.
  try {
    await requireStaffUserId(req, "audits");
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Unauthorized" }, { status: 401 });
  }
  try {
    const { websiteUrl } = (await req.json()) as { websiteUrl?: string };
    const origin = normalizeUrl(websiteUrl ?? "");
    if (!origin) return json({ ok: false, error: "Invalid website URL" }, { status: 200 });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let html = "";
    try {
      const res = await fetchPublic(origin, controller.signal);
      if (!res) return json({ ok: false, error: "Invalid website URL" }, { status: 200 });
      html = await res.text();
    } finally {
      clearTimeout(timeout);
    }

    const domain = extractMyshopifyDomain(html);
    return json({ ok: true, domain: domain ?? null }, { status: 200 });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Detection failed" }, { status: 200 });
  }
});
