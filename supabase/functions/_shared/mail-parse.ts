// Just enough of an email parser to read a reply (Outreach, 2026-11-02): the
// From and Subject headers, and the plain-text body without the quoted email
// underneath. Handles multipart messages, base64 and quoted-printable; anything
// else comes back as best-effort text.

export type ParsedMail = { from: string; subject: string; text: string };

function splitHeaders(raw: string): { headers: Record<string, string>; body: string } {
  const at = raw.search(/\r?\n\r?\n/);
  const head = at === -1 ? raw : raw.slice(0, at);
  const body = at === -1 ? "" : raw.slice(at).replace(/^\r?\n\r?\n/, "");
  const headers: Record<string, string> = {};
  let last = "";
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) {
      headers[last] += " " + line.trim();
      continue;
    }
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) {
      last = m[1].toLowerCase();
      headers[last] = headers[last] ? `${headers[last]}, ${m[2]}` : m[2];
    }
  }
  return { headers, body };
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function decodeBody(body: string, encoding: string, charset: string): string {
  const enc = encoding.toLowerCase();
  if (enc === "base64") {
    try {
      const bin = atob(body.replace(/\s+/g, ""));
      return decodeBytes(Uint8Array.from(bin, (c) => c.charCodeAt(0)), charset);
    } catch {
      return body;
    }
  }
  if (enc === "quoted-printable") {
    const soft = body.replace(/=\r?\n/g, "");
    const bytes: number[] = [];
    for (let i = 0; i < soft.length; i++) {
      if (soft[i] === "=" && /^[0-9A-F]{2}$/i.test(soft.slice(i + 1, i + 3))) {
        bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        // Characters here are ASCII by definition of quoted-printable.
        bytes.push(soft.charCodeAt(i) & 0xff);
      }
    }
    return decodeBytes(new Uint8Array(bytes), charset);
  }
  return body;
}

/** RFC 2047 encoded words in headers: =?utf-8?B?...?= and =?utf-8?Q?...?=. */
export function decodeHeader(v: string): string {
  return v.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, kind: string, text: string) =>
    kind.toUpperCase() === "B"
      ? decodeBody(text, "base64", charset)
      : decodeBody(text.replace(/_/g, " "), "quoted-printable", charset)
  ).replace(/\?=\s+=\?/g, "");
}

const param = (contentType: string, name: string) =>
  contentType.match(new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, "i"))?.[1]?.trim() ?? "";

const stripHtml = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, " ");

/** The best text in a (possibly multipart) part: text/plain first, else text/html stripped. */
function partText(raw: string, depth = 0): { plain: string | null; html: string | null } {
  const { headers, body } = splitHeaders(raw);
  const type = (headers["content-type"] ?? "text/plain").toLowerCase();
  const encoding = headers["content-transfer-encoding"] ?? "";
  const charset = param(headers["content-type"] ?? "", "charset");
  if (type.startsWith("multipart/") && depth < 5) {
    const boundary = param(headers["content-type"] ?? "", "boundary");
    if (!boundary) return { plain: body, html: null };
    let plain: string | null = null;
    let html: string | null = null;
    for (const piece of body.split(`--${boundary}`).slice(1)) {
      if (piece.startsWith("--")) break;
      const r = partText(piece.replace(/^\r?\n/, ""), depth + 1);
      plain ??= r.plain;
      html ??= r.html;
    }
    return { plain, html };
  }
  if (type.startsWith("text/html")) return { plain: null, html: decodeBody(body, encoding, charset) };
  if (type.startsWith("text/")) return { plain: decodeBody(body, encoding, charset), html: null };
  return { plain: null, html: null };
}

/** The new part of a reply: everything above "On ... wrote:" and the quoted lines. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*On .{3,200}wrote:\s*$/.test(line) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^From: .+/.test(line) && out.length > 0) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The HTML part of a message (null when it is plain text only), and a header. */
export function mailHtml(raw: string): string | null {
  return partText(raw).html;
}
export function mailHeader(raw: string, name: string): string {
  return decodeHeader(splitHeaders(raw).headers[name.toLowerCase()] ?? "");
}

/**
 * The Gmail signature in an email someone wrote in Gmail (Outreach, 2026-11-02:
 * "I already updated it in my Gmail, can you just fetch it"). Gmail wraps it in
 * <div class="gmail_signature">; only the one in the new part counts, never one in
 * the quoted email below (class gmail_quote), which may be someone else's.
 * Scripts and inline event handlers are dropped.
 */
export function extractGmailSignature(html: string): string | null {
  const quoteAt = html.search(/class="[^"]*gmail_quote/i);
  const scope = quoteAt > 0 ? html.slice(0, quoteAt) : html;
  const open = /<div[^>]*class="[^"]*gmail_signature[^"]*"[^>]*>/i.exec(scope);
  if (!open) return null;
  const start = open.index + open[0].length;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 1;
  let end = scope.length;
  for (let t = tags.exec(scope); t; t = tags.exec(scope)) {
    depth += t[0][1] === "/" ? -1 : 1;
    if (depth === 0) {
      end = t.index;
      break;
    }
  }
  const sig = scope
    .slice(start, end)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .trim();
  return sig.replace(/<[^>]+>/g, "").trim() ? sig : null;
}

export function parseMail(raw: string): ParsedMail {
  const { headers } = splitHeaders(raw);
  const { plain, html } = partText(raw);
  const text = plain ?? (html ? stripHtml(html) : "");
  return {
    from: decodeHeader(headers["from"] ?? ""),
    subject: decodeHeader(headers["subject"] ?? ""),
    text: stripQuoted(text).slice(0, 6000),
  };
}
