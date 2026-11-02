// Outreach, step 2 (Emil, 2026-11-02): what goes out, and when. Pure functions so
// they can be tested without sending anything. The numbers (emails per day,
// follow-ups, hours, spacing) are set on the Outreach page's Settings tab and
// stored in outreach_settings; these are the defaults it starts with.

/** Emails go out on US weekdays between these hours, New York time. */
export const SEND_WINDOW = { tz: "America/New_York", startHour: 9, endHour: 16 } as const;

/** Whether `now` is a weekday between startHour and endHour, New York time. */
export function inSendWindow(
  now: Date,
  startHour: number = SEND_WINDOW.startHour,
  endHour: number = SEND_WINDOW.endHour,
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SEND_WINDOW.tz,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  return !["Sat", "Sun"].includes(weekday) && hour >= startHour && hour < endHour;
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
 * like a normal email typed in Gmail, no styling, no tracking. */
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

/** The line under every first email: an easy way out. No postal address (Emil, 2026-11-02). */
export function footer(): string {
  return "P.S. Not relevant? Just reply \"no\" and I won't email again.";
}

/** With his own signature under the email, the drafted "ECD Digital Strategy" line
 * under his name would say it twice. */
export function withoutCompanyLine(text: string): string {
  return text.replace(/\n+ECD Digital Strategy\s*$/i, "").trimEnd();
}

/** Emil's Gmail signature under the email, the way Gmail itself adds one: Gmail
 * only adds it to mail written in Gmail, not to mail sent through an app password. */
export function withSignature(html: string, signatureHtml: string | null | undefined): string {
  const sig = (signatureHtml ?? "").trim();
  if (!sig) return html;
  return `${html}\n<br><div class="gmail_signature_prefix">-- </div><div class="gmail_signature">${sig}</div>`;
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
