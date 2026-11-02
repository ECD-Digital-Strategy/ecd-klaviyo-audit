// Outreach, step 2 (Emil, 2026-11-02): what goes out, and when. Pure functions so
// they can be tested without sending anything.

/** Emails go out on US weekdays between these hours, New York time. */
export const SEND_WINDOW = { tz: "America/New_York", startHour: 9, endHour: 16 } as const;
/** Days after the previous email that each follow-up waits. */
export const FOLLOWUP_GAP_DAYS = [3, 4] as const;
/** How many follow-ups go out (Emil, 2026-11-02: one, 3 days after the first email). */
export const MAX_FOLLOWUPS = 1;
/** Minutes between two first emails, so a batch never lands at once. */
export const MIN_GAP_MINUTES = 45;

/** Whether `now` is a weekday inside the send window, New York time. */
export function inSendWindow(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SEND_WINDOW.tz,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  return !["Sat", "Sun"].includes(weekday) && hour >= SEND_WINDOW.startHour && hour < SEND_WINDOW.endHour;
}

/** Start of today in New York, as a UTC instant (for "sent today" counts). */
export function startOfSendDay(now: Date): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: SEND_WINDOW.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  // Midnight in New York is 04:00 or 05:00 UTC; take the earlier so nothing from today is missed.
  return new Date(`${ymd}T04:00:00Z`);
}

const FREE_MAIL = /^(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|me|aol|proton|protonmail)\./i;

/** What to search the inbox for to notice a reply: the brand's domain when the
 * contact is on it, otherwise their exact address (never "gmail.com"). */
export function replySearchKey(contactEmail: string, storeDomain: string): string {
  const email = contactEmail.trim().toLowerCase();
  const domain = email.split("@")[1] ?? "";
  if (!domain || FREE_MAIL.test(domain)) return email;
  return domain === storeDomain || domain.endsWith(`.${storeDomain}`) ? domain : email;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A plain-text email as the simplest HTML: paragraphs, line breaks, links. Reads
 * like a normal email typed in Gmail, no styling, no images, no tracking. */
export function plainHtml(text: string): string {
  const paras = text.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  const html = paras
    .map((p) =>
      esc(p)
        .replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`)
        .replace(/\n/g, "<br>")
    )
    .map((p) => `<p style="margin:0 0 12px">${p}</p>`)
    .join("\n");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">\n${html}\n</div>`;
}

/** The lines under every first email: an easy way out, and the postal address once set. */
export function footer(postalAddress: string | null | undefined): string {
  const lines = ["P.S. Not relevant? Just reply \"no\" and I won't email again."];
  if (postalAddress?.trim()) lines.push(`ECD Digital Strategy, ${postalAddress.trim()}`);
  return lines.join("\n");
}

/** The short follow-ups, threaded under the first email as "Re: <subject>". */
export function followUp(
  n: 1 | 2,
  ctx: { firstName?: string | null; brand: string; reportUrl: string; bookingUrl?: string | null },
): string {
  const hi = ctx.firstName ? `Hi ${ctx.firstName},` : "Hi there,";
  const book = ctx.bookingUrl ? `\n\nIf it's easier, grab a time here: ${ctx.bookingUrl}` : "";
  if (n === 1) {
    return `${hi}\n\nJust bumping this in case it got buried. The preview of ${ctx.brand}'s audit is here:\n${ctx.reportUrl}\n\nHappy to walk you through the rest in 20 minutes if it's useful.${book}\n\nEmil`;
  }
  return `${hi}\n\nLast note from me on this. If the site isn't a priority right now, no problem at all. The preview stays up if you want it later:\n${ctx.reportUrl}${book}\n\nEmil`;
}
