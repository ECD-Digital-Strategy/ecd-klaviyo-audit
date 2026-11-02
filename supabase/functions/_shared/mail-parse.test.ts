import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decodeHeader, extractGmailSignature, parseMail } from "./mail-parse.ts";

Deno.test("the Gmail signature from the new part, nested divs kept, quoted ones ignored", () => {
  const html = [
    '<div dir="ltr">Hi Sam,<br>Sounds good.<br clear="all"><br>',
    '<span class="gmail_signature_prefix">-- </span><br>',
    '<div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr"><b>Emil</b><div>Web Manager</div></div></div>',
    '</div><br><div class="gmail_quote">On Mon, Sam wrote:<div class="gmail_signature">Sam Smith</div></div>',
  ].join("");
  assertEquals(extractGmailSignature(html), '<div dir="ltr"><b>Emil</b><div>Web Manager</div></div>');
  assertEquals(extractGmailSignature('<div class="gmail_quote"><div class="gmail_signature">Sam</div></div>'), null);
  assertEquals(extractGmailSignature("<div>No signature here</div>"), null);
});

Deno.test("a Gmail multipart reply: plain text, quote removed", () => {
  const raw = [
    'From: "Jane Doe" <jane@brand.com>',
    "Subject: Re: =?UTF-8?Q?Your_homepage=E2=80=99s_hero?=",
    'Content-Type: multipart/alternative; boundary="b1"',
    "",
    "--b1",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Hi Emil, this is interesting. Can we talk Thursday?",
    "",
    "On Mon, Nov 2, 2026 at 10:00 AM Emil Gjorgjijev <emil@ecdigitalstrategy.com> wrote:",
    "> Hi Jane,",
    "> I looked at your store.",
    "--b1",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    "<div>Hi Emil</div>",
    "--b1--",
  ].join("\r\n");
  const m = parseMail(raw);
  assertEquals(m.from, '"Jane Doe" <jane@brand.com>');
  assertEquals(m.subject, "Re: Your homepage’s hero");
  assertEquals(m.text, "Hi Emil, this is interesting. Can we talk Thursday?");
});

Deno.test("base64 bodies and html-only mail", () => {
  const b64 = btoa("Not interested, thanks.");
  const raw = ["From: a@b.com", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64].join("\r\n");
  assertEquals(parseMail(raw).text, "Not interested, thanks.");
  const html = ["From: a@b.com", "Content-Type: text/html", "", "<p>I am out of the office until Monday.</p>"].join("\r\n");
  assertEquals(parseMail(html).text, "I am out of the office until Monday.");
});

Deno.test("encoded-word headers", () => {
  assertEquals(decodeHeader("=?utf-8?B?SGVsbG8=?= world"), "Hello world");
});
