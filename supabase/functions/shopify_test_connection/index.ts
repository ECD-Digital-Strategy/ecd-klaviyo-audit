import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { normalizeShopDomain, shopifyRest, mapShopifyErrorCode, exchangeClientCredentials, fetchInstalledAppToken, SHOPIFY_API_VERSION } from "../_shared/shopify-api.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { decryptString } from "../_shared/crypto.ts";
import { requireStaffUserId } from "../_shared/auth.ts";

/** The scopes the audit reads, and what goes missing without each one. Checked on
 * every test so a gap is named while there is still time to fix it, rather than
 * turning up as a blank metric in a finished report. */
const SCOPE_NEEDS: Array<{ scope: string; loses: string }> = [
  { scope: "read_orders", loses: "revenue, orders and AOV" },
  { scope: "read_products", loses: "best sellers and product detail" },
  { scope: "read_customers", loses: "repeat purchase rate" },
  { scope: "read_all_orders", loses: "any window longer than 60 days" },
];

/** Read the token this client already has stored, so a saved connection can be
 * verified rather than assumed. A stored token that has been revoked looks
 * identical to a working one until something asks Shopify. */
async function tokenForSavedConnection(
  clientRecordId: string,
): Promise<{ ok: true; shopDomain: string; token: string } | { ok: false; reason: string }> {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return { ok: false, reason: "service_role_missing" };
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: conn } = await sb
    .from("shopify_connections")
    .select("shop_domain, auth_method, app_client_id")
    .eq("client_id", clientRecordId)
    .maybeSingle();
  const { data: sec } = await sb
    .from("client_secrets")
    .select("shopify_admin_token_ciphertext, shopify_admin_token_iv")
    .eq("client_id", clientRecordId)
    .maybeSingle();

  const shopDomain = normalizeShopDomain(conn?.shop_domain ?? "");
  if (!shopDomain || !sec?.shopify_admin_token_ciphertext || !sec?.shopify_admin_token_iv) {
    return { ok: false, reason: "no_connection" };
  }
  const stored = await decryptString(sec.shopify_admin_token_ciphertext, sec.shopify_admin_token_iv);
  // Same distinction the fetchers make: only client_credentials stores a secret
  // that has to be exchanged; everything else stores a usable token.
  if (conn?.auth_method === "client_credentials" && conn.app_client_id) {
    const grant = await exchangeClientCredentials(shopDomain, String(conn.app_client_id), stored);
    if (!grant.ok) return { ok: false, reason: "exchange_failed" };
    return { ok: true, shopDomain, token: grant.token };
  }
  return { ok: true, shopDomain, token: stored };
}

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

/**
 * One answer shape for every way of getting a token.
 *
 * Reads the shop, then asks the store which scopes it actually granted rather
 * than inferring them from whether a couple of endpoints happened to answer. A
 * scope named here is a scope somebody can go and tick; "orders may be missing"
 * is a guess that has cost this project two round trips with clients already.
 */
async function report(shopDomain: string, accessTokenFinal: string): Promise<Response> {
  const shopRes = await shopifyRest(shopDomain, accessTokenFinal, "/shop.json");
  if (!shopRes.ok) {
    const code = mapShopifyErrorCode(shopRes.status);
    let message: string;
    if (code === "invalid_token" || code === "insufficient_scope") {
      message = `Shopify accepted the credentials but the token cannot read the shop (${shopRes.status}). Add the read_products, read_orders and read_analytics scopes to the app, then try again.`;
    } else if (code === "shop_not_found") {
      message = `Store not found (404). Check the store domain, it must be the real .myshopify.com domain for this store (currently ${shopDomain}).`;
    } else if (code === "rate_limited") {
      message = "Shopify rate limited the request (429). Wait a moment and try again.";
    } else if (code === "provider_unavailable") {
      message = `Shopify is temporarily unavailable (${shopRes.status}). Try again shortly.`;
    } else {
      message = `Failed shop access (${shopRes.status}).`;
    }
    return json({ ok: false, apiVersion: SHOPIFY_API_VERSION, error: { code, message, status: shopRes.status } }, { status: 200 });
  }

  // access_scopes lives outside the versioned API, so it is fetched directly.
  let granted: string[] = [];
  try {
    const scopeRes = await fetch(`https://${shopDomain}/admin/oauth/access_scopes.json`, {
      headers: { "X-Shopify-Access-Token": accessTokenFinal, accept: "application/json" },
    });
    if (scopeRes.ok) {
      const body = await scopeRes.json().catch(() => ({}));
      granted = ((body?.access_scopes ?? []) as Array<{ handle?: string }>)
        .map((x) => String(x.handle ?? ""))
        .filter(Boolean)
        .sort();
    }
  } catch { /* a scope read failing is not a connection failing */ }

  const missing = granted.length > 0 ? SCOPE_NEEDS.filter((n) => !granted.includes(n.scope)) : [];
  const shop = shopRes.body?.shop ?? null;

  return json({
    ok: true,
    apiVersion: SHOPIFY_API_VERSION,
    shop: shop
      ? {
          id: shop.id ?? null,
          name: shop.name ?? null,
          domain: shopDomain,
          currency: shop.currency ?? null,
          timezone: shop.iana_timezone ?? null,
          plan: shop.plan_display_name ?? null,
        }
      : null,
    scopes: { granted, missing: missing.map((m) => m.scope) },
    warnings: missing.map((m) => `Missing ${m.scope}, so the audit cannot report ${m.loses}.`),
  }, { status: 200 });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });
  // Staff with audit access only: this decrypts stored store tokens and makes
  // outbound calls with whatever credentials it is handed.
  try {
    await requireStaffUserId(req, "audits");
  } catch (e) {
    return json({ ok: false, error: { code: "unauthorized", message: e instanceof Error ? e.message : "Unauthorized" } }, { status: 401 });
  }
  try {
    const { shopDomain: rawDomain, accessToken, clientId, clientSecret, useInstalledApp, websiteUrl, auditClientId } =
      (await req.json()) as {
        shopDomain?: string;
        accessToken?: string;
        clientId?: string;
        clientSecret?: string;
        useInstalledApp?: boolean;
        websiteUrl?: string;
        /** An ECD client id: verify the connection already stored for them. */
        auditClientId?: string;
      };

    // Verifying a saved connection needs no domain from the caller: the stored
    // connection knows which store it belongs to.
    if ((auditClientId ?? "").trim()) {
      const saved = await tokenForSavedConnection(auditClientId!.trim());
      if (!saved.ok) {
        return json({
          ok: false,
          apiVersion: SHOPIFY_API_VERSION,
          error: {
            code: saved.reason,
            message: saved.reason === "no_connection"
              ? "This client has no Shopify connection saved yet."
              : "The saved Shopify connection could not be used. It may have been uninstalled or revoked.",
          },
        }, { status: 200 });
      }
      return await report(saved.shopDomain, saved.token);
    }

    const shopDomain = normalizeShopDomain(rawDomain ?? "");
    if (!shopDomain) return json({ error: "Enter a valid *.myshopify.com store domain" }, { status: 400 });

    // Resolve an access token. Preferred: reuse the offline token from the app
    // already installed on the store (installed_app). Otherwise a Dev Dashboard
    // client_credentials grant, or a pasted legacy admin token.
    let accessTokenResolved = "";
    if (useInstalledApp) {
      const token = await fetchInstalledAppToken(shopDomain, websiteUrl);
      if (!token) {
        return json({
          ok: false,
          apiVersion: SHOPIFY_API_VERSION,
          error: { code: "not_installed", message: `No token found for ${shopDomain} in the promo calendar app. Connect this store there first, then retry.` },
        }, { status: 200 });
      }
      accessTokenResolved = token;
    } else if (clientId && clientSecret) {
      const grant = await exchangeClientCredentials(shopDomain, clientId.trim(), clientSecret.trim());
      if (!grant.ok) {
        const sameOrgHint =
          " The client_credentials grant only works when the app and the store are in the same Shopify organization. If this is a client's store, the app must be installed there (OAuth) instead.";
        return json({
          ok: false,
          apiVersion: SHOPIFY_API_VERSION,
          error: {
            code: grant.status ? mapShopifyErrorCode(grant.status) : "token_exchange_failed",
            message: `Could not get an access token from Shopify (${grant.status || "network error"}): ${grant.error}. Check the Client ID, Client secret, and store domain.${sameOrgHint}`,
            status: grant.status,
          },
        }, { status: 200 });
      }
      accessTokenResolved = grant.token;
    } else if (accessToken && typeof accessToken === "string") {
      accessTokenResolved = accessToken.trim();
    } else {
      return json({ error: "Provide a Client ID and Client secret (or a legacy access token)" }, { status: 400 });
    }
    const accessTokenFinal = accessTokenResolved;

    return await report(shopDomain, accessTokenFinal);
  } catch (e) {
    return json({
      ok: false,
      error: {
        code: "request_failed",
        message: e instanceof Error ? e.message : "Unknown error",
      },
    }, { status: 200 });
  }
});
