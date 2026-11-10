import { supabase } from './supabase';
import { isImageFile, uploadChatImage } from './chat-image-upload';
import { createDocument, updateDocument, recordDocumentEvent, setDocumentSenderSigner } from './documents-db';
import { publicDocumentOrigin } from './public-origin';
import type { Document, ProposalAgentAttachment } from './types';

// ---------------------------------------------------------------------------
// Payload types (mirror supabase/functions/document_agent)

export type DocAgentQuestion = {
  question: string;
  options: Array<{ label: string; value: string }>;
  allow_other: boolean;
  multi_select?: boolean;
  /** Set when several questions were asked at once; the first mirrors the top level. */
  questions?: Array<{ question: string; options: Array<{ label: string; value: string }>; multi_select?: boolean }>;
};

export type DocDraftPayload = {
  title: string;
  content: string;
  summary: string;
  include_sender_signature?: boolean;
  /** Whose signature signs for ECD, as the user named them. Empty means Zak. */
  sender_signature_signer?: string;
  /** The body stops part-way and there is more to fetch. A long document is
   *  written across several calls because one call has 150s to finish. */
  more?: boolean;
};
export type DocEditPayload = {
  content: string;
  summary: string;
  /** Set only when the user asked to change who signs; empty leaves it alone. */
  sender_signature_signer?: string;
  /** See DocDraftPayload.more. */
  more?: boolean;
};

export type DocAgentResponse = {
  ok: true;
  conversation_id: string;
  assistant_message_id: string;
  assistant_text: string;
  question?: DocAgentQuestion;
  draft?: DocDraftPayload;
  edits?: DocEditPayload;
};

/** truncated: the body was too long to send in full, so a whole-body edit must not be applied. */
export type DocumentSnapshot = { id: string; title: string; content: string; truncated?: boolean };

export class DocAgentError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/** Remove em/en dashes; belt and braces (the edge function also sanitizes). */
export function sanitizeCopy(input: string): string {
  if (!input) return input;
  return input
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2')
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/[–—]/g, ', ');
}

// The document goes to the assistant in full up to this size. A longer one is
// cut and flagged truncated, and its edits (always a whole new body) are refused
// on apply: the old 12,000 cap plus a literal "[truncated]" let an edit write the
// cut copy back over the real document.
export const SNAPSHOT_CONTENT_CAP = 60000;

function documentTooLongForAgent(content: string): boolean {
  return (content ?? '').length > SNAPSHOT_CONTENT_CAP;
}

export function buildDocumentSnapshot(document: Document): DocumentSnapshot {
  if (documentTooLongForAgent(document.content)) {
    return { id: document.id, title: document.title, content: document.content.slice(0, SNAPSHOT_CONTENT_CAP), truncated: true };
  }
  return { id: document.id, title: document.title, content: document.content };
}

export const MAX_DOC_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export async function uploadDocumentAgentFile(
  file: File,
  conversationId: string | null,
): Promise<ProposalAgentAttachment> {
  if (isImageFile(file)) return uploadChatImage(file, `document-agent/${conversationId ?? 'new'}`);
  if (file.type !== 'application/pdf') throw new Error('Only PDF files and images are supported right now.');
  if (file.size > MAX_DOC_ATTACHMENT_BYTES) throw new Error('That PDF is too large. Please keep it under 20 MB.');
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'document.pdf';
  const path = `document-agent/${conversationId ?? 'new'}/${crypto.randomUUID()}-${safeName}`;
  const { error } = await supabase.storage
    .from('audit-assets')
    .upload(path, file, { upsert: false, contentType: 'application/pdf' });
  if (error) throw error;
  const { data } = supabase.storage.from('audit-assets').getPublicUrl(path);
  return { url: data.publicUrl, name: file.name, media_type: 'application/pdf', size: file.size };
}

export async function sendDocAgentMessage(input: {
  conversation_id?: string | null;
  document_id?: string | null;
  message: string;
  attachments?: ProposalAgentAttachment[];
  snapshot?: DocumentSnapshot | null;
}): Promise<DocAgentResponse> {
  const maxAttempts = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { data, error } = await supabase.functions.invoke<DocAgentResponse | { ok: false; error: { code: string; message: string } }>(
      'document_agent',
      {
        body: {
          conversation_id: input.conversation_id ?? undefined,
          document_id: input.document_id ?? undefined,
          message: input.message,
          attachments: input.attachments?.length ? input.attachments : undefined,
          snapshot: input.snapshot ?? undefined,
        },
      },
    );
    if (error) {
      lastErr = new DocAgentError(error.message || 'Request failed', 'request_failed');
      // A 504 here is the gateway's 150s wall clock, not a blip. The work that
      // hit it was one LLM turn producing a whole document, so repeating the
      // identical request spends another 150s arriving at the same place while
      // the panel looks like it is still thinking. Only genuine transport
      // failures are worth a second go.
      const message = error.message ?? '';
      const timedOut = /504|timeout|timed out/i.test(message);
      const retryable = !timedOut && /546|502|503|Failed to send/i.test(message);
      if (timedOut) {
        throw new DocAgentError(
          'That one part took too long to build. Ask again and it will pick up from what is already written.',
          'timeout',
        );
      }
      if (retryable && attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 1500 + attempt * 1000));
        continue;
      }
      throw lastErr;
    }
    if (!data || data.ok !== true) {
      const err = (data as { error?: { code?: string; message?: string } })?.error;
      throw new DocAgentError(err?.message ?? 'The assistant request failed', err?.code ?? 'request_failed');
    }
    return data;
  }
  throw lastErr instanceof Error ? lastErr : new DocAgentError('Request failed', 'request_failed');
}

/** Ask for the next part of a document the assistant stopped part-way through.
 *  The reply carries the WHOLE body written so far, not just the new part, so a
 *  caller can simply replace what it is holding. */
export async function continueDocDraft(
  conversationId: string,
  opts?: { document_id?: string | null; snapshot?: DocumentSnapshot | null },
): Promise<DocAgentResponse> {
  const { data, error } = await supabase.functions.invoke<DocAgentResponse | { ok: false; error: { code: string; message: string } }>(
    'document_agent',
    {
      body: {
        conversation_id: conversationId,
        continue_draft: true,
        document_id: opts?.document_id ?? undefined,
        snapshot: opts?.snapshot ?? undefined,
      },
    },
  );
  if (error) {
    const message = error.message ?? '';
    if (/504|timeout|timed out/i.test(message)) {
      throw new DocAgentError(
        'That part took too long to build. Ask again and it will pick up from what is already written.',
        'timeout',
      );
    }
    throw new DocAgentError(message || 'Request failed', 'request_failed');
  }
  if (!data || data.ok !== true) {
    const err = (data as { error?: { code?: string; message?: string } })?.error;
    throw new DocAgentError(err?.message ?? 'The rest of the document did not come through', err?.code ?? 'request_failed');
  }
  return data;
}

/** How many parts a single document may be written across. Ten parts is far
 *  beyond any document this tool produces, and stops a model that never lowers
 *  the flag from looping forever. */
export const MAX_DOC_PARTS = 10;

// ---------------------------------------------------------------------------
// Apply helpers

/** origin for the (unused here) public link parity; kept for symmetry. */
export const docPublicOrigin = publicDocumentOrigin;

export async function applyDraftAsNewDocument(draft: DocDraftPayload): Promise<Document> {
  const doc = await createDocument(
    {
      title: sanitizeCopy(draft.title),
      content: sanitizeCopy(draft.content),
      // Signed by us unless the assistant was told otherwise, matching the
      // toggle's default. Only an explicit false turns it off.
      sender_signature_enabled: draft.include_sender_signature !== false,
    },
    { aiAssisted: true },
  );
  // createDocument already signed as the default (Zak) when the signature is on;
  // re-sign only when the user named someone else. Best effort: a document that
  // fails to re-sign is still a valid draft carrying the default signature, and
  // the signer picker on the page can fix it.
  const hint = (draft.sender_signature_signer ?? '').trim();
  if (doc.sender_signature_enabled && hint) {
    try {
      await setDocumentSenderSigner({ document_id: doc.id, signer_hint: hint });
    } catch (e) {
      console.error('Could not apply the named signer to the new document', e);
    }
  }
  return doc;
}

export async function applyDocumentEdits(document: Document, edits: DocEditPayload): Promise<Document> {
  // An edit replaces the whole body, and the assistant only saw the start of a
  // document this long, so applying it would delete the rest.
  if (documentTooLongForAgent(document.content)) {
    throw new Error('This document is too long for the assistant to rewrite safely, so nothing was changed. Edit it by hand.');
  }
  let updated = await updateDocument(document.id, { content: sanitizeCopy(edits.content) });
  // "Use Zak's signature instead" arrives as an edit carrying a signer, so the
  // switch happens on apply alongside any wording change.
  const hint = (edits.sender_signature_signer ?? '').trim();
  if (hint) {
    try {
      await setDocumentSenderSigner({ document_id: document.id, signer_hint: hint });
      if (!updated.sender_signature_enabled) {
        updated = await updateDocument(document.id, { sender_signature_enabled: true });
      }
    } catch (e) {
      console.error('Could not change the document signer', e);
    }
  }
  await recordDocumentEvent(document.id, 'updated', { via: 'ai_assistant' }).catch(() => {});
  return updated;
}
