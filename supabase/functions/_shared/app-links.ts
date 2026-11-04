// Links in notification emails land on the exact place to act, which glows
// (2026-11-04: "redirected to the right page with a pulsing animation on where
// they need to look"). The app side is src/lib/use-focus-target.ts.

export const APP_ORIGIN = "https://proposal.ecdigitalstrategy.com";

/** A proposal's page, scrolled to one card: "welcome" or "xero". */
export const proposalLink = (proposalId: string, focus?: "welcome" | "xero") =>
  `${APP_ORIGIN}/proposals/${proposalId}${focus ? `?focus=${focus}` : ""}`;

/** Proposal settings, scrolled to the Connected Gmail accounts. */
export const gmailSettingsLink = () => `${APP_ORIGIN}/proposals?tab=settings&focus=gmail`;

/** A plain inline link for a line of a notification email. */
export const inlineLink = (url: string, label: string) =>
  `<a href="${url}" style="color:#4b3afe;text-decoration:underline;">${label}</a>`;
