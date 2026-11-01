import { assertServiceRoleClient, requireAdminUserId } from "./auth.ts";

/** Outreach is Emil's alone for now (Emil, 2026-11-01); the page, the
 * outreach_prospects policy and these functions all check this address. */
export const OUTREACH_OWNER_EMAIL = "emil@ecdigitalstrategy.com";

/** The caller's user id when they are Emil (and an admin); throws "Forbidden" otherwise. */
export async function requireOutreachOwner(req: Request): Promise<string> {
  const userId = await requireAdminUserId(req);
  const { data } = await assertServiceRoleClient().from("profiles").select("email").eq("id", userId).maybeSingle();
  const email = String((data as { email?: string } | null)?.email ?? "").trim().toLowerCase();
  if (email !== OUTREACH_OWNER_EMAIL) throw new Error("Forbidden");
  return userId;
}
