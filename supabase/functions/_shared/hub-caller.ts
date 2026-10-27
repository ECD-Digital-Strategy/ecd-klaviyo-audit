// Calls from the ECD Hub connector in Athena (promo.ecdigitalstrategy.com/api/mcp),
// Emil, 2026-10-27: Claude drafts proposals through THIS app's own assistant,
// so every rule in proposal_agent, the house voice profile and the client
// memory apply exactly as they do here, and a rule changed here changes there.
//
// Athena signs its users in against ECD Hub, not this project, so it cannot
// call as them. It sends the shared hub key, the same one hub_proposals()
// checks (migration 20261019133846_hub_proposals_read.sql, which also says
// how to rotate it; rotate this hash with it), and the email of the person it
// has signed in. That person must be staff HERE, by this app's own rule
// (assertStaffProfile): Athena vouches for who is asking, never for what they
// may do.
import { assertServiceRoleClient, assertStaffProfile, type AppArea } from "./auth.ts";

/** SHA-256 of PROPOSALS_HUB_KEY in Athena's environment. Only the hash lives here. */
const HUB_KEY_SHA256 = "a172adab83af3760f6e8b49a9f9ed15b3412808798f6e59e37f8ffed04d5b122";

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** An email as a literal ilike pattern: % and _ match only themselves. */
const literal = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The staff user Athena is calling for, or null when this is not a hub call
 * (no x-hub-key), so the caller falls back to the normal session check.
 * Throws "Forbidden" for a wrong key, a missing or outside email, or someone
 * who is not staff with access to `area` here.
 */
export async function hubStaffUserId(req: Request, area?: AppArea): Promise<string | null> {
  const key = req.headers.get("x-hub-key");
  if (!key) return null;
  if ((await sha256Hex(key)) !== HUB_KEY_SHA256) throw new Error("Forbidden");

  const email = (req.headers.get("x-hub-user-email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@ecdigitalstrategy\.com$/.test(email)) throw new Error("Forbidden");

  const sb = assertServiceRoleClient();
  const { data, error } = await sb
    .from("profiles")
    .select("id, role, app_access")
    .ilike("email", literal(email))
    .limit(2);
  if (error) throw error;
  // None, or two accounts on one address: refuse rather than pick one.
  if (!data || data.length !== 1) throw new Error(`Forbidden: no Proposals account for ${email}`);
  assertStaffProfile(data[0] as { role?: string; app_access?: Record<string, unknown> | null }, area);
  return (data[0] as { id: string }).id;
}
