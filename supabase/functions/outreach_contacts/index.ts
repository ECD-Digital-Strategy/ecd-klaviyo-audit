import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient } from "../_shared/auth.ts";
import { requireOutreachOwner } from "../_shared/outreach-access.ts";
import { decryptString, encryptString } from "../_shared/crypto.ts";
import {
  founderNames,
  fullName,
  rankContacts,
  verdictOf,
  type HunterEmail,
  type Verdict,
} from "../_shared/outreach-contacts.ts";

// Outreach decision-maker lookup (Emil, 2026-11-02): "sending it to support tickets
// is not ideal, we need decision makers". Hunter (free plan for now) knows people
// at most brand domains. For one prospect:
//  1. ask Hunter for the senior people at the domain, and rank them (founder/CEO,
//     then marketing and ecommerce leads; see _shared/outreach-contacts.ts);
//  2. if it knows no one, read the store's About page for a founder's name and
//     ask Hunter for that person's address;
//  3. check the best one or two addresses with Hunter's verifier and fill in the
//     first that is valid (a catch-all domain is filled in too, marked as such).
// Each lookup costs one search and up to two verifications. The key is connected
// on the Outreach page's Settings tab and stored encrypted (app_secrets
// outreach_hunter); it never goes back to the browser.
// Actions: "status", "connect", "disconnect", "find" (prospect_id).

const HUNTER = "https://api.hunter.io/v2";
const KEY_SECRET = "outreach_hunter";

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

type Sb = ReturnType<typeof assertServiceRoleClient>;

async function hunterKey(sb: Sb): Promise<string | null> {
  const { data } = await sb.from("app_secrets").select("ciphertext, iv").eq("key", KEY_SECRET).maybeSingle();
  if (!data?.ciphertext || !data?.iv) return null;
  try {
    return (await decryptString(data.ciphertext, data.iv)) || null;
  } catch {
    return null;
  }
}

class HunterError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function hunter<T>(path: string, params: Record<string, string>, key: string): Promise<{ status: number; data: T }> {
  const q = new URLSearchParams({ ...params, api_key: key });
  const res = await fetch(`${HUNTER}/${path}?${q.toString()}`, { headers: { accept: "application/json" } });
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: Array<{ details?: string; id?: string }> } | null;
  if (!res.ok && res.status !== 202) {
    const detail = body?.errors?.[0]?.details ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new HunterError("Hunter refused the API key. Reconnect it under Settings.", 401);
    if (res.status === 429) throw new HunterError(`Hunter's monthly limit is used up (${detail}).`, 429);
    if (res.status === 403) throw new HunterError("Hunter is rate limiting us. Try again in a minute.", 429);
    throw new HunterError(`Hunter: ${detail}`, res.status);
  }
  return { status: res.status, data: (body?.data ?? {}) as T };
}

type Account = {
  email?: string;
  plan_name?: string;
  reset_date?: string;
  requests?: {
    // Newer plans: one pool, a search costs 1 credit and a verification 0.5.
    credits?: { used?: number; available?: number };
    searches?: { used?: number; available?: number };
    verifications?: { used?: number; available?: number };
  };
};

async function account(key: string) {
  const { data } = await hunter<Account>("account", {}, key);
  return {
    email: data.email ?? null,
    plan: data.plan_name ?? null,
    reset_date: data.reset_date ?? null,
    credits: data.requests?.credits ? { used: data.requests.credits.used ?? 0, available: data.requests.credits.available ?? 0 } : null,
    searches: { used: data.requests?.searches?.used ?? 0, available: data.requests?.searches?.available ?? 0 },
    verifications: { used: data.requests?.verifications?.used ?? 0, available: data.requests?.verifications?.available ?? 0 },
  };
}

/** Hunter's own recent check when it has a clear one (free), else a verification. */
async function verify(email: string, key: string, known?: string | null): Promise<Verdict> {
  if (verdictOf(known) === "valid" || verdictOf(known) === "invalid") return verdictOf(known);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { status, data } = await hunter<{ status?: string; result?: string }>("email-verifier", { email }, key);
    // 202: Hunter is still checking; it asks to try again shortly.
    if (status !== 202) return verdictOf(data.status ?? data.result);
    await new Promise((r) => setTimeout(r, 4000));
  }
  return "unknown";
}

/** Visible text of the store's About page, if it has one. */
async function aboutText(domain: string): Promise<string> {
  for (const path of ["/pages/about-us", "/pages/about", "/pages/our-story", "/pages/story"]) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`https://${domain}${path}`, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" },
      });
      if (!res.ok) continue;
      const html = (await res.text()).slice(0, 400_000);
      return html
        .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&#39;|&rsquo;/g, "'")
        .replace(/\s+/g, " ");
    } catch {
      // Try the next path.
    } finally {
      clearTimeout(timer);
    }
  }
  return "";
}

type Found = { name: string | null; email: string; title: string | null; source: "hunter" | "hunter_finder"; verified: Verdict };

async function find(domain: string, key: string): Promise<{ found: Found | null; tried: string[] }> {
  const tried: string[] = [];
  const search = await hunter<{ emails?: HunterEmail[] }>(
    "domain-search",
    { domain, type: "personal", seniority: "senior,executive", limit: "10" },
    key,
  );
  let candidates: Array<HunterEmail & { source: Found["source"] }> = rankContacts(search.data.emails ?? []).map((e) => ({ ...e, source: "hunter" }));

  if (candidates.length === 0) {
    for (const name of founderNames(await aboutText(domain))) {
      const { data } = await hunter<{ email?: string | null; position?: string | null; first_name?: string; last_name?: string; verification?: { status?: string } }>(
        "email-finder",
        { domain, full_name: name },
        key,
      );
      if (data.email) {
        candidates = [{ value: data.email, first_name: data.first_name ?? name.split(" ")[0], last_name: data.last_name ?? name.split(" ").slice(1).join(" "), position: data.position ?? "Founder", verification: data.verification, source: "hunter_finder" }];
        break;
      }
    }
  }

  let fallback: Found | null = null;
  for (const c of candidates.slice(0, 2)) {
    tried.push(c.value);
    const verdict = await verify(c.value, key, c.verification?.status);
    const f: Found = { name: fullName(c), email: c.value.toLowerCase(), title: c.position ?? null, source: c.source, verified: verdict };
    if (verdict === "valid") return { found: f, tried };
    if (verdict === "catch_all" && !fallback) fallback = f;
  }
  return { found: fallback, tried };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  try {
    await requireOutreachOwner(req);
  } catch {
    return json({ ok: false, error: "forbidden" }, 403);
  }
  const body = (await req.json().catch(() => ({}))) as { action?: string; key?: string; prospect_id?: string };
  const sb = assertServiceRoleClient();

  try {
    if (body.action === "status") {
      const key = await hunterKey(sb);
      if (!key) return json({ ok: true, connected: false });
      try {
        return json({ ok: true, connected: true, account: await account(key) });
      } catch (e) {
        return json({ ok: true, connected: true, account: null, error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (body.action === "connect") {
      const key = String(body.key ?? "").trim();
      if (key.length < 20) return json({ ok: false, error: "Paste the API key from hunter.io/api-keys." }, 400);
      // Prove it works before storing it (the account call costs no credits).
      const info = await account(key);
      const enc = await encryptString(key);
      const { error } = await sb.from("app_secrets").upsert(
        { key: KEY_SECRET, ciphertext: enc.ciphertext, iv: enc.iv, alg: enc.alg, updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, account: info });
    }

    if (body.action === "disconnect") {
      await sb.from("app_secrets").delete().eq("key", KEY_SECRET);
      return json({ ok: true });
    }

    if (body.action === "find") {
      const key = await hunterKey(sb);
      if (!key) return json({ ok: false, error: "Connect Hunter under Settings first." }, 409);
      const { data: p } = await sb.from("outreach_prospects").select("id, domain, status").eq("id", body.prospect_id ?? "").maybeSingle();
      if (!p) return json({ ok: false, error: "not_found" }, 404);
      if (["sent", "replied", "bounced", "unsubscribed", "skipped"].includes(String(p.status))) {
        return json({ ok: false, error: "Only stores not emailed yet can be looked up." }, 409);
      }
      const { found, tried } = await find(String(p.domain), key);
      const now = new Date().toISOString();
      if (!found) {
        await sb.from("outreach_prospects").update({ contact_lookup_at: now }).eq("id", p.id);
        return json({
          ok: true,
          found: null,
          message: tried.length
            ? `Hunter found ${tried.length === 1 ? "someone" : "people"}, but no address checked out (${tried.join(", ")}).`
            : "Hunter knows no senior people at this domain, and the About page names no founder.",
        });
      }
      await sb.from("outreach_prospects").update({
        contact_name: found.name,
        contact_email: found.email,
        contact_title: found.title,
        contact_source: found.source,
        contact_verified: found.verified,
        contact_lookup_at: now,
      }).eq("id", p.id);
      return json({ ok: true, found });
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (e) {
    const status = e instanceof HunterError ? (e.status === 401 || e.status === 429 ? 409 : 502) : 500;
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, status);
  }
});
