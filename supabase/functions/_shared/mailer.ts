// SMTP mail sender (Gmail by default). Email is optional infrastructure: when
// SMTP_USER/SMTP_PASS are not configured, sendEmail reports `skipped` so
// callers can proceed (e.g. mark a proposal sent and hand back the link).
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

export type SendEmailInput = {
  to: string[];
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
  cc?: string[];
  /** Send through another mailbox than SMTP_USER (outreach sends as Emil, 2026-11-02). */
  smtp?: { user: string; pass: string; host?: string; port?: number };
  /** Our own Message-ID ("<id@domain>"), so a later email can thread under it. */
  messageId?: string;
  /** Thread this email under an earlier one (its Message-ID). */
  inReplyTo?: string;
};

export type SendEmailResult =
  | { status: "sent"; id: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export function mailerConfigured(): boolean {
  return Boolean((Deno.env.get("SMTP_USER") ?? "").trim() && (Deno.env.get("SMTP_PASS") ?? "").trim());
}

/** Strip trailing whitespace from every line so quoted-printable encoding never has to
 * escape a trailing space before a line break (the exact trigger for stray "=20" output). */
function sanitizeHtmlForQuotedPrintable(html: string): string {
  return html
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const host = (input.smtp?.host ?? Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com").trim();
  const port = Number(input.smtp?.port ?? Deno.env.get("SMTP_PORT") ?? "587");
  const user = (input.smtp?.user ?? Deno.env.get("SMTP_USER") ?? "").trim();
  const pass = (input.smtp?.pass ?? Deno.env.get("SMTP_PASS") ?? "").trim();

  if (!user || !pass) return { status: "skipped", reason: "SMTP not configured" };
  if (input.to.length === 0) return { status: "skipped", reason: "No recipients" };

  let client: SMTPClient;
  try {
    client = new SMTPClient({
      connection: {
        hostname: host,
        port,
        tls: port === 465,
        auth: { username: user, password: pass },
      },
    });
  } catch (e) {
    return { status: "failed", reason: e instanceof Error ? e.message : "SMTP client init failed" };
  }

  try {
    await client.send({
      from: input.from?.trim() || `ECD Digital Strategy <${user}>`,
      to: input.to,
      subject: input.subject,
      // HTML only: denomailer's quoted-printable encoder escapes any trailing
      // space before a line break as "=20"; adding a second (text/plain)
      // MIME part multiplies the boundary/encoding surface area and some
      // clients (observed with Gmail) leak a stray "=20" from it. A single
      // HTML part sidesteps that entirely.
      html: sanitizeHtmlForQuotedPrintable(input.html),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.cc?.length ? { cc: input.cc } : {}),
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo, references: input.inReplyTo } : {}),
      ...(input.messageId ? { headers: { "Message-ID": input.messageId } } : {}),
    });
    return { status: "sent", id: input.messageId ?? crypto.randomUUID() };
  } catch (e) {
    return { status: "failed", reason: e instanceof Error ? e.message : "SMTP send failed" };
  } finally {
    try {
      await client.close();
    } catch {
      // Connection may already be closed; nothing to do.
    }
  }
}

/** The request Origin is the real app domain the client/staff member is on;
 * APP_URL is only a fallback for server-triggered calls with no Origin header. */
export function resolveOrigin(req: Request): string {
  return (req.headers.get("origin") || Deno.env.get("APP_URL") || "").trim().replace(/\/$/, "");
}

type EmailSettings = {
  from_name?: string | null;
  from_email?: string | null;
  reply_to?: string | null;
  team_notification_emails?: string[];
};

/** Everyone a viewed/signed notification goes to: the Team notifications list
 * from Settings PLUS the person who sent this proposal or document.
 *
 * The sender is always notified, decided with Emil 2026-08-14: whoever pressed
 * Send owns the deal and must hear the client opened or signed it, whether or
 * not they are on the team list. sent_by is stamped by the send functions;
 * created_by covers everything sent before that column existed and share-link
 * flows where no send email happened. Deduped case-insensitively so the sender
 * being on the team list does not email them twice. Best effort by design: a
 * lookup failure falls back to the team list alone rather than blocking a
 * notification that already has recipients. */
export async function notificationRecipients(
  // deno-lint-ignore no-explicit-any
  sb: any,
  teamEmails: string[],
  table: "proposals" | "documents",
  rowId: string,
): Promise<string[]> {
  const out = new Map<string, string>();
  for (const e of teamEmails) {
    const v = (e ?? "").trim();
    if (v) out.set(v.toLowerCase(), v);
  }
  try {
    const { data: row } = await sb.from(table).select("sent_by, created_by").eq("id", rowId).maybeSingle();
    const senderId = (row?.sent_by ?? row?.created_by) as string | null | undefined;
    if (senderId) {
      const { data: prof } = await sb.from("profiles").select("email").eq("id", senderId).maybeSingle();
      const email = (prof?.email ?? "").trim();
      if (email) out.set(email.toLowerCase(), email);
    }
  } catch {
    // fall back to the team list alone
  }
  return [...out.values()];
}

export function resolveFromAddress(settings: EmailSettings | null | undefined): string | undefined {
  const configuredAccount = (Deno.env.get("SMTP_USER") ?? "").trim();
  const email = settings?.from_email?.trim() || configuredAccount;
  if (!email) return undefined;
  const name = settings?.from_name?.trim() || "ECD Digital Strategy";
  return `${name} <${email}>`;
}

/** Branded HTML shell for proposal emails, with the ECD icon in the header and the raw URL as a text fallback. */
export function proposalEmailHtml(options: {
  heading: string;
  bodyLines: string[];
  ctaLabel?: string;
  ctaUrl?: string;
  logoUrl?: string;
}): string {
  const { heading, bodyLines, ctaLabel, ctaUrl, logoUrl } = options;
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f8;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:576px;margin:0 auto;padding:32px 20px;">
      <div style="background:#ffffff;border-radius:16px;padding:32px;border:1px solid #ececf3;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
          <tr>
            ${logoUrl
              ? `<td style="vertical-align:middle;padding-right:8px;"><img src="${logoUrl}" width="26" height="26" alt="" style="display:block;border-radius:6px;" /></td>`
              : ""}
            <td style="vertical-align:middle;">
              <span style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#4b3afe;">ECD Digital Strategy</span>
            </td>
          </tr>
        </table>
        <h1 style="margin:0 0 16px;font-size:20px;color:#111827;">${heading}</h1>
        ${bodyLines.map(line => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#374151;">${line}</p>`).join("")}
        ${ctaUrl && ctaLabel
          ? `<a href="${ctaUrl}" style="display:inline-block;margin-top:8px;background:#4b3afe;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;">${ctaLabel}</a>
             <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;">Or copy this link:</p>
             <p style="margin:4px 0 0;font-size:11px;line-height:1.5;color:#6b7280;word-break:break-all;">${ctaUrl}</p>`
          : ""}
      </div>
      <p style="margin:16px 0 0;text-align:center;font-size:11px;color:#9ca3af;">Sent by ECD Digital Strategy</p>
    </div>
  </body>
</html>`;
}
