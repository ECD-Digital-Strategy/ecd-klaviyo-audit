import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createRemoteJWKSet, jwtVerify } from "https://deno.land/x/jose@v5.9.6/index.ts";
import { assertServiceRoleClient } from "../_shared/auth.ts";

// Sign in once (Emil, 2026-10-28): someone already signed in to ECD Hub (PTO, HR,
// the Client Tracker, the app rail) is signed in here too, instead of being sent a
// second magic link. This app's sign-in lives in its own project, so the browser
// cannot just reuse Hub's. It sends its Hub access token here; this function:
//
//  1. checks the token's signature against ECD Hub's published signing keys (its
//     JWKS: public, so no key is stored here), never trusting the browser,
//  2. accepts only an @ecdigitalstrategy.com address that already has an account
//     HERE: it never creates one, exactly like the magic-link sign-in,
//  3. answers with a one-time sign-in for this project (a magic-link token hash,
//     made without sending an email), which the browser exchanges at once.
//
// Nothing is stored. The Hub token is used for that one check only. Hub only signs
// in ECD staff by emailed link, so a Hub sign-in already proves the address.

const HUB_URL = "https://avvitrgppzroveurlxrl.supabase.co";
// Cached by jose between requests on a warm function; refetched when Hub rotates keys.
const HUB_KEYS = createRemoteJWKSet(new URL(`${HUB_URL}/auth/v1/.well-known/jwks.json`));

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-hub-token",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

/** An email as a literal ilike pattern: % and _ match only themselves. */
const literal = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const hubToken = (req.headers.get("x-hub-token") ?? "").trim();
  if (!hubToken) return json({ ok: false, error: "no_hub_session" }, 401);

  // 1. Who is this, according to Hub: a valid, unexpired Hub sign-in for a real user.
  let email = "";
  try {
    const { payload } = await jwtVerify(hubToken, HUB_KEYS, {
      issuer: `${HUB_URL}/auth/v1`,
      audience: "authenticated",
    });
    if (payload.role !== "authenticated" || payload.is_anonymous === true) throw new Error("not a user");
    email = String(payload.email ?? "").trim().toLowerCase();
  } catch {
    return json({ ok: false, error: "no_hub_session" }, 401);
  }
  if (!/^[^\s@]+@ecdigitalstrategy\.com$/.test(email)) return json({ ok: false, error: "not_allowed" }, 403);

  // 2. An account here already, exactly one.
  const sb = assertServiceRoleClient();
  const { data: profiles, error: profileErr } = await sb
    .from("profiles")
    .select("id")
    .ilike("email", literal(email))
    .limit(2);
  if (profileErr) return json({ ok: false, error: "lookup_failed" }, 500);
  if (!profiles || profiles.length !== 1) return json({ ok: false, error: "no_account" }, 403);

  // 3. A one-time sign-in for this project, without an email.
  const { data: link, error: linkErr } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link?.properties?.hashed_token;
  if (linkErr || !tokenHash) return json({ ok: false, error: "link_failed" }, 500);
  // The account the link is for must be the one found above.
  if (link.user?.id !== (profiles[0] as { id: string }).id) return json({ ok: false, error: "no_account" }, 403);

  return json({ ok: true, token_hash: tokenHash });
});
