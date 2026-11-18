// The signed copy of an uploaded PDF (2026-11-18). Run by document_sign right after the recipient signs, and again
// by staff ("Make the signed PDF") if that first run failed. It:
//   1. loads the original from private storage and checks it is the file that was sent (SHA-256 kept at upload);
//   2. stamps every field and adds the signing certificate (pdf-sign.ts);
//   3. stores signed/<document id>.pdf and its fingerprint on the document;
//   4. writes a Gmail draft in the sender's Gmail, to the client, with the signed PDF attached, and tells them on
//      Slack. The app never emails the client itself (2026-11-05); without a connected Gmail, the sender is emailed
//      to download it from the app instead.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { cleanFields, sha256Hex, stampPdf, type Signer } from "./pdf-sign.ts";
import { mailboxFor } from "./gmail.ts";
import { draftForClient } from "./client-draft.ts";
import { documentLink } from "./app-links.ts";
import { proposalEmailHtml, sendEmail } from "./mailer.ts";

type Sb = SupabaseClient;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function finalizeSignedPdf(sb: Sb, documentId: string): Promise<{ path: string; draft: string }> {
  const { data: doc, error } = await sb.from("documents").select("*").eq("id", documentId).maybeSingle();
  if (error) throw error;
  if (!doc || doc.kind !== "pdf" || !doc.pdf_path) throw new Error("Not an uploaded PDF document.");
  const { data: sigRows } = await sb.from("document_signatures").select("*").eq("document_id", documentId);
  const recipient = (sigRows ?? []).find((s) => (s.signer_role ?? "recipient") === "recipient");
  const sender = (sigRows ?? []).find((s) => s.signer_role === "sender");
  if (!recipient) throw new Error("The recipient hasn't signed yet.");

  const { data: file, error: dlErr } = await sb.storage.from("signing-docs").download(doc.pdf_path);
  if (dlErr || !file) throw new Error(`The original PDF couldn't be read: ${dlErr?.message ?? "missing"}`);
  const original = new Uint8Array(await file.arrayBuffer());
  const sha = await sha256Hex(original);
  if (doc.pdf_sha256 && sha !== doc.pdf_sha256) throw new Error("The stored PDF is not the file that was sent (fingerprint mismatch), so it was not signed.");

  const signers: Signer[] = [{
    role: "recipient",
    name: recipient.typed_name || recipient.signer_name,
    email: recipient.signer_email,
    signatureImage: recipient.signature_image,
    initialsImage: recipient.initials_image,
    signedAt: recipient.signed_at,
    ip: recipient.ip_address,
    device: recipient.user_agent,
  }];
  if (sender) {
    signers.push({
      role: "sender",
      name: sender.typed_name || sender.signer_name,
      email: sender.signer_email ?? null,
      signatureImage: sender.signature_image,
      signedAt: sender.signed_at,
    });
  }
  const fields = cleanFields(doc.pdf_fields, doc.pdf_pages ?? 9999);
  const signed = await stampPdf(original, fields, signers, {
    title: doc.title,
    documentNumber: doc.document_number,
    documentId: doc.id,
    originalSha256: sha,
    sentAt: doc.sent_at,
    firstViewedAt: doc.first_viewed_at,
  });

  const path = `signed/${doc.id}.pdf`;
  const { error: upErr } = await sb.storage.from("signing-docs").upload(path, signed, { contentType: "application/pdf", upsert: true });
  if (upErr) throw new Error(`The signed PDF couldn't be stored: ${upErr.message}`);
  await sb.from("documents").update({ signed_pdf_path: path, signed_pdf_sha256: await sha256Hex(signed) }).eq("id", doc.id);
  await sb.from("document_events").insert({ document_id: doc.id, event_type: "signed_pdf", actor: "system", metadata: { path, pages: fields.length } });

  // The signed copy to the client: a draft in the sender's Gmail, never sent by the app.
  const title = doc.title || "Untitled document";
  const filename = `${title.replace(/[^\w\- ]+/g, "").trim() || "document"} - signed.pdf`;
  const to = recipient.signer_email || doc.recipient_email;
  const senderId = doc.sent_by ?? doc.created_by;
  const box = await mailboxFor(sb, senderId);
  if (box && to) {
    const first = String(recipient.typed_name || recipient.signer_name || "").split(/\s+/)[0] || "there";
    const text = `Hi ${first},\n\nThanks for signing. The signed copy of "${title}" is attached for your records.\n`;
    const html = `<p>Hi ${esc(first)},</p><p>Thanks for signing. The signed copy of "${esc(title)}" is attached for your records.</p>`;
    const d = await draftForClient(
      sb,
      box,
      { to: [to], subject: `Signed: ${title}`, html, text, attachments: [{ filename, contentType: "application/pdf", data: signed }] },
      { what: `The signed copy of "${title}"`, to, appLink: { url: documentLink(doc.id), label: "Open the document" } },
    );
    await sb.from("document_events").insert({ document_id: doc.id, event_type: "signed_pdf_drafted", actor: "system", metadata: { from: box.email, to, notified: d.notified } });
    return { path, draft: `drafted in ${box.email}'s Gmail` };
  }
  // No connected Gmail: the sender downloads it from the app instead.
  const { data: prof } = await sb.from("profiles").select("email").eq("id", senderId ?? "").maybeSingle();
  const senderEmail = (prof as { email?: string } | null)?.email;
  if (senderEmail) {
    await sendEmail({
      to: [senderEmail],
      subject: `Signed: ${title}`,
      html: proposalEmailHtml({
        heading: `"${esc(title)}" is signed`,
        bodyLines: [
          `${esc(recipient.typed_name || recipient.signer_name || "The client")} signed it. The signed PDF, with a signing certificate, is ready in the app.`,
          "Connect your Gmail in Proposal settings and the signed copy is drafted to the client for you next time.",
        ],
        ctaLabel: "Open the document",
        ctaUrl: documentLink(doc.id),
      }),
    }).catch(() => {});
  }
  return { path, draft: "no connected Gmail, sender emailed" };
}
