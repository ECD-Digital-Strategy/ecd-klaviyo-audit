import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
// Reuse the generic public-token helpers from the proposals shared module.
export { PROPOSAL_CORS_HEADERS as DOCUMENT_CORS_HEADERS, proposalJson as documentJson, PUBLIC_TOKEN_RE, hashSignedPayload as hashContent } from "./proposal-public.ts";
import { PUBLIC_TOKEN_RE } from "./proposal-public.ts";
import { isPastValidUntil } from "./valid-until.ts";

/** Expired once the valid_until day is over in New York, the same clock as proposals. */
export function isDocumentExpired(doc: { status: string; valid_until: string | null }): boolean {
  if (doc.status !== "sent" && doc.status !== "viewed") return false;
  return isPastValidUntil(doc.valid_until);
}

/** Fetch a document by public token with its signature. Returns null for unknown
 * tokens AND drafts (no status oracle). */
export async function fetchPublicDocument(sb: SupabaseClient, token: string) {
  if (!PUBLIC_TOKEN_RE.test(token)) return null;
  const { data: document, error } = await sb
    .from("documents")
    .select("*")
    .eq("public_token", token)
    .maybeSingle();
  if (error) throw error;
  if (!document || document.status === "draft") return null;

  const { data: signatures, error: sigErr } = await sb
    .from("document_signatures")
    .select("id, document_id, signer_name, signer_email, signature_image, typed_name, ip_address, user_agent, signed_at, signer_role")
    .eq("document_id", document.id);
  if (sigErr) throw sigErr;

  const rows = signatures ?? [];
  const signature = rows.find((s) => (s.signer_role ?? "recipient") === "recipient") ?? null;
  const senderSignature = rows.find((s) => s.signer_role === "sender") ?? null;

  return { document, signature, senderSignature };
}

/** Public-safe payload: only the fields the recipient-facing page needs. */
export function serializePublicDocument(
  bundle: NonNullable<Awaited<ReturnType<typeof fetchPublicDocument>>>,
) {
  const { document, signature, senderSignature } = bundle;
  // Both signatures are shown on the page, but only the display-safe fields
  // (no email / IP / user agent): anyone holding the link can read this.
  const displayOnly = (s: typeof signature) =>
    s
      ? {
        signer_name: s.signer_name,
        typed_name: s.typed_name,
        signature_image: s.signature_image,
        signed_at: s.signed_at,
      }
      : null;
  const publicSender = displayOnly(senderSignature);
  return {
    document: {
      id: document.id,
      document_number: document.document_number,
      title: document.title,
      content: document.content,
      status: document.status,
      recipient_name: document.recipient_name,
      recipient_email: document.recipient_email,
      sender_signature_enabled: Boolean(document.sender_signature_enabled),
      // Absent on rows created before the column existed, which all wanted a
      // recipient signature, so a missing value means true.
      recipient_signature_enabled: document.recipient_signature_enabled !== false,
    },
    signature: displayOnly(signature),
    sender_signature: publicSender,
    signed: Boolean(signature),
    expired: isDocumentExpired(document),
  };
}
