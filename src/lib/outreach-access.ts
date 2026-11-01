/** Who may use the Outreach page: only Emil, for now (2026-11-01). The
 * outreach_prospects table and the outreach functions check the same address. */
export const OUTREACH_OWNER_EMAIL = 'emil@ecdigitalstrategy.com';

export const canUseOutreach = (email: string | null | undefined) =>
  (email ?? '').trim().toLowerCase() === OUTREACH_OWNER_EMAIL;
