import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { requireStaffUserId } from "../_shared/auth.ts";
import { normalizeStorefrontUrl } from "../_shared/competing-sms-detect.ts";
import { KLAVIYO_BASE, KLAVIYO_REVISION } from "../_shared/klaviyo-api.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const KMS_ENCRYPTION_KEY = Deno.env.get("KMS_ENCRYPTION_KEY") ?? "";

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type, accept, origin, referer, user-agent",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
    ...init,
  });
}

function assertServiceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function b64encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
function b64decode(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deriveAesKey(secret: string) {
  const enc = new TextEncoder();
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function encryptionSecret() {
  return (KMS_ENCRYPTION_KEY || SUPABASE_SERVICE_ROLE_KEY || "").trim();
}

async function encryptString(plaintext: string) {
  const secret = encryptionSecret();
  if (!secret) throw new Error("Encryption secret is missing");
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return {
    alg: "AES-256-GCM",
    ciphertext: b64encode(new Uint8Array(ct)),
    iv: b64encode(iv),
  };
}

async function klaviyoCall(apiKey: string, path: string) {
  const res = await fetch(`${KLAVIYO_BASE}${path}`, {
    headers: {
      accept: "application/json",
      authorization: `Klaviyo-API-Key ${apiKey}`,
      revision: KLAVIYO_REVISION,
    },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: { code: "method_not_allowed" } }, { status: 405 });

  const correlationId = crypto.randomUUID();
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ ok: false, error: { code: "config_missing", message: "Supabase env missing" }, correlationId }, { status: 500 });
    }
    await requireStaffUserId(req, "audits");

    const input = (await req.json()) as { client_id?: string; api_key?: string };
    const clientId = (input.client_id ?? "").trim();
    const apiKey = (input.api_key ?? "").trim();
    if (!clientId || !apiKey) {
      return json({ ok: false, error: { code: "bad_request", message: "Missing client_id or api_key" }, correlationId }, { status: 400 });
    }

    // Verify against Klaviyo
    const accountRes = await klaviyoCall(apiKey, "/api/accounts/");
    if (!accountRes.ok) {
      return json(
        { ok: false, error: { code: "invalid_key_or_scope", message: "Account lookup failed", status: accountRes.status }, correlationId },
        { status: 200 },
      );
    }

    const account = accountRes.body?.data?.[0] ?? null;
    const accountId = account?.id ?? null;
    const accountName = account?.attributes?.contact_information?.organization_name ?? null;
    const websiteUrl = account?.attributes?.contact_information?.website_url ?? null;
    const timezone = account?.attributes?.timezone ?? null;
    const preferredCurrency = account?.attributes?.preferred_currency ?? null;

    const sb = assertServiceClient();

    // Enforce 1 Klaviyo account = 1 client. If another client already connected this account, block.
    if (accountId) {
      const { data: existingConn, error: existingConnErr } = await sb
        .from("klaviyo_connections")
        .select("client_id")
        .eq("account_id", accountId)
        .neq("client_id", clientId)
        .maybeSingle();
      if (existingConnErr) throw existingConnErr;
      if (existingConn?.client_id) {
        return json(
          {
            ok: false,
            correlationId,
            error: {
              code: "client_exists",
              message: "A client with this Klaviyo account already exists.",
            },
          },
          { status: 200 },
        );
      }
    }

    // Store encrypted key
    const enc = await encryptString(apiKey);
    // Each write is checked: a failed key save used to report "connected"
    // and the first audit then died on "No Klaviyo key for client".
    const { error: secretErr } = await sb.from("client_secrets").upsert(
      {
        client_id: clientId,
        klaviyo_private_key_ciphertext: enc.ciphertext,
        klaviyo_private_key_iv: enc.iv,
        klaviyo_private_key_alg: enc.alg,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id" },
    );
    if (secretErr) throw new Error(`Could not save the Klaviyo key: ${secretErr.message}`);

    const normalizedWebsite = normalizeStorefrontUrl(websiteUrl);
    if (normalizedWebsite) {
      const { data: existingClient } = await sb.from("clients").select("website_url").eq("id", clientId).maybeSingle();
      if (!normalizeStorefrontUrl(existingClient?.website_url)) {
        const { error: siteErr } = await sb.from("clients").update({ website_url: normalizedWebsite }).eq("id", clientId);
        if (siteErr) throw new Error(`Could not save the website: ${siteErr.message}`);
      }
    }

    const { error: connErr } = await sb.from("klaviyo_connections").upsert(
      {
        client_id: clientId,
        account_id: accountId,
        account_name: accountName,
        website_url: normalizedWebsite,
        timezone,
        preferred_currency: preferredCurrency,
        revision: KLAVIYO_REVISION,
        scopes: { accounts: true },
        last_verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id" },
    );
    if (connErr) throw new Error(`Could not save the Klaviyo connection: ${connErr.message}`);

    // Marked connected only once the key and the connection are both stored.
    const { error: flagErr } = await sb.from("clients").update({ klaviyo_connected: true }).eq("id", clientId);
    if (flagErr) throw new Error(`Could not mark the client connected: ${flagErr.message}`);

    return json(
      {
        ok: true,
        correlationId,
        account: { id: accountId, name: accountName, websiteUrl: normalizedWebsite, timezone, preferredCurrency },
      },
      { status: 200 },
    );
  } catch (e) {
    return json(
      { ok: false, error: { code: "request_failed", message: e instanceof Error ? e.message : "Unknown error" }, correlationId },
      { status: 200 },
    );
  }
});

