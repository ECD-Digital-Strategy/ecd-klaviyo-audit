import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { decryptString, encryptString } from "./crypto.ts";

// Sending email as a person, through their own Gmail (invoices, 2026-11-02).
// They connect once with Google sign-in (gmail_connect) and grant send-only
// permission (gmail.send: it cannot read their mail). The Google app is an
// Internal app in the ECD Workspace, so only ecdigitalstrategy.com accounts can
// connect and Google does not need to review it. Its client id and secret are
// entered on the Proposals settings tab and stored encrypted in app_secrets.
// Each person's refresh token is stored encrypted in mailbox_connections.

export const GOOGLE_CLIENT_ID_KEY = "google_oauth_client_id";
export const GOOGLE_CLIENT_SECRET_KEY = "google_oauth_client_secret";
// gmail.settings.basic (2026-11-02): read their Gmail signature, so outreach (and
// any email sent as them) signs off exactly as Gmail does. Still no reading mail.
// calendar.freebusy (2026-11-04): only when people are busy, never what the
// events are, so the welcome email can offer launch call times that fit the team.
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
export const GMAIL_SCOPES =
  `openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.settings.basic ${CALENDAR_SCOPE}`;
/** Only ECD accounts may send ECD invoices. */
export const ALLOWED_DOMAIN = "ecdigitalstrategy.com";

type Sb = SupabaseClient;

/** The redirect URI to register on the Google OAuth client. Must match exactly. */
export function gmailRedirectUri(): string {
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  return `${base}/functions/v1/gmail_connect`;
}

async function readSecret(sb: Sb, key: string): Promise<string | null> {
  const { data } = await sb.from("app_secrets").select("ciphertext, iv").eq("key", key).maybeSingle();
  if (!data?.ciphertext || !data?.iv) return null;
  try {
    return (await decryptString(data.ciphertext, data.iv)) || null;
  } catch {
    return null;
  }
}

export async function writeSecret(sb: Sb, key: string, value: string) {
  const enc = await encryptString(value);
  const { error } = await sb.from("app_secrets").upsert(
    { key, ciphertext: enc.ciphertext, iv: enc.iv, alg: enc.alg, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  if (error) throw error;
}

export async function googleClient(sb: Sb): Promise<{ clientId: string; clientSecret: string } | null> {
  const [clientId, clientSecret] = await Promise.all([readSecret(sb, GOOGLE_CLIENT_ID_KEY), readSecret(sb, GOOGLE_CLIENT_SECRET_KEY)]);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function authorizeUrl(clientId: string, state: string, loginHint?: string): string {
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: gmailRedirectUri(),
    scope: GMAIL_SCOPES,
    // A refresh token every time, so a reconnect always works.
    access_type: "offline",
    prompt: "consent",
    hd: ALLOWED_DOMAIN,
    include_granted_scopes: "true",
    state,
  });
  if (loginHint) qs.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${qs.toString()}`;
}

type Tokens = { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string };

async function tokenCall(body: URLSearchParams): Promise<Tokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { error?: string; error_description?: string };
      msg = j.error_description || j.error || msg;
    } catch {
      // keep the raw text
    }
    throw new Error(`google_token_${res.status}: ${msg}`);
  }
  return JSON.parse(text) as Tokens;
}

/** The address an ID token belongs to (Google signs it; we only read it here,
 * straight from Google's token endpoint over TLS). */
function idTokenEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Finishes Google sign-in: stores the person's refresh token. Returns their address. */
export async function completeConnection(sb: Sb, userId: string, code: string): Promise<string> {
  const client = await googleClient(sb);
  if (!client) throw new Error("Google sign-in is not set up yet.");
  const tokens = await tokenCall(new URLSearchParams({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: gmailRedirectUri(),
    grant_type: "authorization_code",
  }));
  const email = idTokenEmail(tokens.id_token);
  if (!email) throw new Error("Google did not say which account this is.");
  if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) throw new Error(`Connect your @${ALLOWED_DOMAIN} account, not ${email}.`);
  if (!tokens.refresh_token) throw new Error("Google did not grant offline access. Try connecting again.");
  const enc = await encryptString(tokens.refresh_token);
  const { error } = await sb.from("mailbox_connections").upsert({
    user_id: userId,
    email,
    refresh_token_ciphertext: enc.ciphertext,
    refresh_token_iv: enc.iv,
    // What they allowed, so the settings page can say when a reconnect adds something.
    scopes: tokens.scope ?? null,
    connected_at: new Date().toISOString(),
    last_error: null,
  });
  if (error) throw error;
  return email;
}

export type Mailbox = { userId: string; email: string };

/** A connected person's mailbox, or null. */
export async function mailboxFor(sb: Sb, userId: string | null | undefined): Promise<Mailbox | null> {
  if (!userId) return null;
  const { data } = await sb.from("mailbox_connections").select("user_id, email").eq("user_id", userId).maybeSingle();
  return data ? { userId: data.user_id as string, email: data.email as string } : null;
}

async function accessTokenFor(sb: Sb, userId: string): Promise<string> {
  const client = await googleClient(sb);
  if (!client) throw new Error("Google sign-in is not set up yet.");
  const { data } = await sb.from("mailbox_connections").select("refresh_token_ciphertext, refresh_token_iv").eq("user_id", userId).maybeSingle();
  if (!data) throw new Error("This mailbox is not connected.");
  const refresh = await decryptString(data.refresh_token_ciphertext as string, data.refresh_token_iv as string);
  try {
    const t = await tokenCall(new URLSearchParams({
      refresh_token: refresh,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
    }));
    return t.access_token;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from("mailbox_connections").update({ last_error: msg.slice(0, 300) }).eq("user_id", userId);
    // invalid_grant: they revoked it, or the password changed. They must reconnect.
    throw new Error(/invalid_grant/i.test(msg) ? "The Gmail connection has expired. Reconnect it in Proposal settings." : msg);
  }
}

export type Attachment = { filename: string; contentType: string; data: Uint8Array };

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64url = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const wrap = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");
/** RFC 2047 for non-ASCII headers (names, subjects). */
const header = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(new TextEncoder().encode(s))}?=`);

/** A MIME message: HTML with a plain-text alternative, plus attachments. */
export function buildMime(m: {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  text: string;
  attachments?: Attachment[];
}): string {
  const boundary = `mix_${crypto.randomUUID()}`;
  const alt = `alt_${crypto.randomUUID()}`;
  const lines = [
    `From: ${m.from}`,
    `To: ${m.to.join(", ")}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    `Subject: ${header(m.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(b64(new TextEncoder().encode(m.text))),
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(b64(new TextEncoder().encode(m.html))),
    `--${alt}--`,
  ];
  for (const a of m.attachments ?? []) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap(b64(a.data)),
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

export class NeedsReconnect extends Error {}

/** Their Gmail signature, from Gmail's own settings (the "send as" address).
 * Throws NeedsReconnect when they connected before this permission was asked for. */
export async function gmailSignature(sb: Sb, box: Mailbox): Promise<string | null> {
  const token = await accessTokenFor(sb, box.userId);
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(box.email)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 403 || res.status === 401) {
    throw new NeedsReconnect("Reconnect your Gmail once so the app can read your signature.");
  }
  if (!res.ok) throw new Error(`gmail_signature_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { signature?: string };
  const sig = String(body.signature ?? "").trim();
  return sig.replace(/<[^>]+>/g, "").trim() ? sig : null;
}

export type SignatureState = "added" | "none_set" | "needs_reconnect" | "off";

/** Plain-text version of a Gmail signature, for the text part of the email. */
const signatureText = (html: string) =>
  html
    .replace(/<br\s*\/?>|<\/(p|div|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * Sends as the connected person. It lands in their Sent folder like any email they
 * write, and (2026-11-03: "show the signatures always") ends with their own Gmail
 * signature, read live from their Gmail settings. If it cannot be read (connected
 * before that permission existed) the email still goes, and signature says why.
 */
export async function sendAsPerson(
  sb: Sb,
  box: Mailbox,
  m: { fromName?: string | null; to: string[]; cc?: string[]; subject: string; html: string; text: string; attachments?: Attachment[]; signature?: boolean },
): Promise<{ id: string; signature: SignatureState }> {
  let signature: SignatureState = "off";
  if (m.signature !== false) {
    try {
      const sig = await gmailSignature(sb, box);
      if (sig) {
        m = {
          ...m,
          html: `${m.html}<br><div class="gmail_signature" style="margin-top:12px">${sig}</div>`,
          text: `${m.text}\n\n-- \n${signatureText(sig)}`,
        };
        signature = "added";
      } else {
        signature = "none_set";
      }
    } catch (e) {
      signature = e instanceof NeedsReconnect ? "needs_reconnect" : "none_set";
    }
  }
  const token = await accessTokenFor(sb, box.userId);
  const from = m.fromName ? `${header(m.fromName)} <${box.email}>` : box.email;
  const raw = b64url(b64(new TextEncoder().encode(buildMime({ ...m, from }))));
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  const text = await res.text();
  if (!res.ok) {
    const msg = `gmail_send_${res.status}: ${text.slice(0, 300)}`;
    await sb.from("mailbox_connections").update({ last_error: msg.slice(0, 300) }).eq("user_id", box.userId);
    throw new Error(msg);
  }
  await sb.from("mailbox_connections").update({ last_used_at: new Date().toISOString(), last_error: null }).eq("user_id", box.userId);
  return { id: (JSON.parse(text) as { id?: string }).id ?? "", signature };
}

/**
 * When people are busy (Google Calendar free/busy), read with the connected
 * person's access. In the ECD Workspace everyone can see colleagues' free/busy,
 * so one connected sender is enough to check Isa's and the RS's calendars.
 * Calendars it could not read come back in `unreadable`. Throws NeedsReconnect when
 * the person connected before the calendar permission was asked for.
 */
export async function freeBusy(
  sb: Sb,
  box: Mailbox,
  calendars: string[],
  from: Date,
  to: Date,
): Promise<{ busy: Array<{ start: string; end: string }>; unreadable: string[] }> {
  const token = await accessTokenFor(sb, box.userId);
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: calendars.map((id) => ({ id })) }),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    // Not granted (connected before 2026-11-04), or the Calendar API is off in the Google project.
    if (/insufficient|scope|PERMISSION_DENIED/i.test(text) && !/has not been used|disabled/i.test(text)) {
      throw new NeedsReconnect(`${box.email} needs to reconnect their Gmail once so the app can check calendars.`);
    }
    throw new Error(`Google Calendar refused (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`calendar_freebusy_${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> };
  const busy: Array<{ start: string; end: string }> = [];
  const unreadable: string[] = [];
  for (const id of calendars) {
    const c = body.calendars?.[id];
    if (!c || (c.errors && c.errors.length)) unreadable.push(id);
    else busy.push(...(c.busy ?? []));
  }
  return { busy, unreadable };
}
