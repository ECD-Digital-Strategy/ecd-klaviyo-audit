import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getSecret } from "./app-secrets.ts";
import { decryptString, encryptString } from "./crypto.ts";

/**
 * Xero OAuth 2.0 (authorization code) token handling for the agency's own org.
 *
 * The moving parts that matter:
 *  - Access tokens live 30 minutes, so every call refreshes on demand.
 *  - Refresh tokens live 60 days AND ROTATE: the response's new refresh token
 *    must replace the stored one or the connection dies on the next call. That
 *    is the single easiest thing to get wrong here.
 *  - Because our trigger (a client signing) can be more than 60 days apart, a
 *    weekly cron calls keepAliveXero() so the token can never lapse from disuse.
 *  - Every API call needs the Xero-Tenant-Id header from /connections.
 */

const AUTH_URL = "https://login.xero.com/identity/connect/authorize";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONNECTIONS_URL = "https://api.xero.com/connections";
const API_BASE = "https://api.xero.com/api.xro/2.0";

// Granular scopes, because that is what this Xero app is configured with:
// accounting.invoices covers creating the draft ACCREC invoice (the older,
// broader accounting.transactions is not enabled and gets rejected as
// invalid_scope), accounting.contacts finds or creates the client, and
// accounting.settings.read reads the chart of accounts for the account picker.
// Do not add app.connections: it exists only for Custom Connections apps and a
// standard app gets access_denied ("Requested wrong apps scopes") for asking.
// The /connections endpoint works with any valid token regardless.
export const XERO_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.invoices",
  "accounting.contacts",
  "accounting.settings.read",
].join(" ");

export type XeroConnectionRow = {
  id: string;
  tenant_id: string | null;
  tenant_name: string | null;
  refresh_token_ciphertext: string | null;
  refresh_token_iv: string | null;
  access_token_ciphertext: string | null;
  access_token_iv: string | null;
  access_token_expires_at: string | null;
  sales_account_code: string | null;
  /** Where recurring lines post, unless a service overrides it. */
  mrr_account_code: string | null;
  tax_type: string | null;
  last_refreshed_at: string | null;
  last_error: string | null;
};

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function xeroCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  const [clientId, clientSecret] = await Promise.all([
    getSecret("xero_client_id"),
    getSecret("xero_client_secret"),
  ]);
  return { clientId, clientSecret };
}

/** The redirect URI registered on the Xero app. Must match byte for byte. */
export function xeroRedirectUri(): string {
  const explicit = (Deno.env.get("XERO_REDIRECT_URI") ?? "").trim();
  if (explicit) return explicit;
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  return `${base}/functions/v1/xero_oauth_callback`;
}

export function buildAuthorizeUrl(clientId: string, state: string): string {
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: xeroRedirectUri(),
    scope: XERO_SCOPES,
    state,
  });
  return `${AUTH_URL}?${qs.toString()}`;
}

type TokenSet = { access_token: string; refresh_token: string; expires_in: number };

async function postToken(body: URLSearchParams): Promise<TokenSet> {
  const { clientId, clientSecret } = await xeroCredentials();
  const basic = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`xero_token_${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as TokenSet;
  if (!json.access_token || !json.refresh_token) throw new Error("xero_token_incomplete");
  return json;
}

async function storeTokens(sb: SupabaseClient, tokens: TokenSet, extra: Record<string, unknown> = {}) {
  const [refresh, access] = await Promise.all([
    encryptString(tokens.refresh_token),
    encryptString(tokens.access_token),
  ]);
  const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 1800) * 1000).toISOString();
  const { error } = await sb.from("xero_connection").upsert({
    id: "default",
    refresh_token_ciphertext: refresh.ciphertext,
    refresh_token_iv: refresh.iv,
    access_token_ciphertext: access.ciphertext,
    access_token_iv: access.iv,
    access_token_expires_at: expiresAt,
    last_refreshed_at: new Date().toISOString(),
    last_error: null,
    ...extra,
  });
  if (error) throw error;
}

/** Exchange the authorization code, then record which Xero org was connected. */
export async function completeAuthorization(sb: SupabaseClient, code: string, connectedBy: string | null) {
  const tokens = await postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: xeroRedirectUri(),
    }),
  );
  const conns = await fetch(CONNECTIONS_URL, {
    headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" },
  });
  const list = (await conns.json().catch(() => [])) as Array<{ tenantId?: string; tenantName?: string; tenantType?: string }>;
  const org = list.find((c) => c.tenantType === "ORGANISATION") ?? list[0];
  if (!org?.tenantId) throw new Error("xero_no_tenant");
  await storeTokens(sb, tokens, {
    tenant_id: org.tenantId,
    tenant_name: org.tenantName ?? null,
    connected_by: connectedBy,
    connected_at: new Date().toISOString(),
  });
  return { tenantName: org.tenantName ?? "" };
}

export async function loadConnection(sb: SupabaseClient): Promise<XeroConnectionRow | null> {
  const { data } = await sb.from("xero_connection").select("*").eq("id", "default").maybeSingle();
  return (data as XeroConnectionRow | null) ?? null;
}

/** A valid access token, refreshing when it is missing or close to expiry. */
export async function accessToken(sb: SupabaseClient): Promise<{ token: string; tenantId: string }> {
  const row = await loadConnection(sb);
  if (!row?.refresh_token_ciphertext || !row.refresh_token_iv) throw new Error("xero_not_connected");
  if (!row.tenant_id) throw new Error("xero_no_tenant");

  const expiresAt = row.access_token_expires_at ? Date.parse(row.access_token_expires_at) : 0;
  // Refresh a couple of minutes early so a slow call can't cross the boundary.
  const stillValid = row.access_token_ciphertext && row.access_token_iv && expiresAt - Date.now() > 120_000;
  if (stillValid) {
    const token = await decryptString(row.access_token_ciphertext!, row.access_token_iv!);
    return { token, tenantId: row.tenant_id };
  }

  const refreshToken = await decryptString(row.refresh_token_ciphertext, row.refresh_token_iv);
  try {
    const tokens = await postToken(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    );
    await storeTokens(sb, tokens);
    return { token: tokens.access_token, tenantId: row.tenant_id };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sb.from("xero_connection").update({ last_error: message.slice(0, 400) }).eq("id", "default");
    throw e;
  }
}

/** Keep the refresh token from expiring during a quiet stretch (weekly cron). */
export async function keepAliveXero(sb: SupabaseClient): Promise<{ ok: boolean; message: string }> {
  try {
    const { token, tenantId } = await accessToken(sb);
    // A token can keep refreshing after the app is removed from the
    // organisation in Xero; every API call then 403s (Oct 2026, unnoticed for
    // weeks). So also check the organisation is still connected, and say so in
    // Settings when it is not.
    const res = await fetch(CONNECTIONS_URL, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (res.ok) {
      const list = (await res.json().catch(() => [])) as Array<{ tenantId?: string }>;
      if (!list.some((c) => c.tenantId === tenantId)) {
        const message = "Xero no longer lists this organisation for the app. Disconnect and connect Xero again in Settings.";
        await sb.from("xero_connection").update({ last_error: message }).eq("id", "default");
        return { ok: false, message };
      }
    }
    return { ok: true, message: "refreshed" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function xeroApi<T>(
  sb: SupabaseClient,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const { token, tenantId } = await accessToken(sb);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "xero-tenant-id": tenantId,
    accept: "application/json",
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  // Xero honours Idempotency-Key, which is what stops a retry double-posting.
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) {
    // 429 carries Retry-After; surface it so callers can report it plainly.
    const retry = res.headers.get("retry-after");
    throw new Error(`xero_api_${res.status}${retry ? ` (retry after ${retry}s)` : ""}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as T;
}

export function disconnectPatch() {
  return {
    tenant_id: null,
    tenant_name: null,
    refresh_token_ciphertext: null,
    refresh_token_iv: null,
    access_token_ciphertext: null,
    access_token_iv: null,
    access_token_expires_at: null,
    connected_at: null,
    last_error: null,
  };
}
