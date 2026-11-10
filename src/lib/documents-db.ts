import { supabase } from './supabase';
import { resolvePublicInvoke } from './public-fetch';
import { addDaysToDate, businessDate } from './valid-until';
import { attachActorNames } from './actor-names';
import { publicDocumentOrigin } from './public-origin';
import { listStaffSigners, resolveSigner, signerImage, type StaffSigner } from './staff-signers';
import type {
  Document,
  DocumentEvent,
  DocumentEventType,
  DocumentSettings,
  DocumentSignature,
  DocumentTemplate,
} from './types';

// ---------------------------------------------------------------------------
// Settings

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  email: {
    from_name: 'ECD Digital Strategy',
    from_email: null,
    reply_to: null,
    team_notification_emails: [],
  },
  defaults: {
    valid_days: 0, // 0 = never expires
  },
  voice_profile: '',
};

export function mergeDocumentSettings(raw: unknown): DocumentSettings {
  const value = (raw ?? {}) as Partial<DocumentSettings>;
  return {
    email: { ...DEFAULT_DOCUMENT_SETTINGS.email, ...(value.email ?? {}) },
    defaults: { ...DEFAULT_DOCUMENT_SETTINGS.defaults, ...(value.defaults ?? {}) },
    voice_profile: typeof value.voice_profile === 'string' ? value.voice_profile : '',
  };
}

export async function getDocumentSettings(): Promise<DocumentSettings> {
  const { data, error } = await supabase
    .from('platform_settings')
    .select('document_settings')
    .eq('id', 'default')
    .maybeSingle();
  if (error || !data) return DEFAULT_DOCUMENT_SETTINGS;
  return mergeDocumentSettings(data.document_settings);
}

export async function updateDocumentSettings(settings: DocumentSettings): Promise<void> {
  const { error } = await supabase
    .from('platform_settings')
    .update({ document_settings: settings, updated_at: new Date().toISOString() })
    .eq('id', 'default');
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Documents CRUD

function mapDocumentRow(row: Record<string, unknown>): Document {
  return {
    ...(row as unknown as Document),
    content: typeof row.content === 'string' ? row.content : '',
  };
}

// Every Document column except the body: the list never shows it, so content comes back ''.
const DOCUMENT_LIST_COLUMNS =
  'id,document_number,template_id,title,status,recipient_name,recipient_email,sender_signature_enabled,' +
  'recipient_signature_enabled,public_token,valid_until,sent_at,first_viewed_at,signed_at,void_at,created_by,created_at,updated_at';

export async function listDocuments(): Promise<Document[]> {
  const { data, error } = await supabase
    .from('documents')
    .select(DOCUMENT_LIST_COLUMNS)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(mapDocumentRow);
}

export async function getDocument(id: string): Promise<Document | null> {
  const { data, error } = await supabase.from('documents').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? mapDocumentRow(data) : null;
}

export type CreateDocumentInput = {
  title: string;
  content?: string;
  template_id?: string | null;
  recipient_name?: string;
  recipient_email?: string;
  /** Defaults to true: documents from us normally carry our signature. */
  sender_signature_enabled?: boolean;
  recipient_signature_enabled?: boolean;
};

export async function createDocument(
  input: CreateDocumentInput,
  options: { aiAssisted?: boolean } = {},
): Promise<Document> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id ?? null;
  const { data, error } = await supabase
    .from('documents')
    .insert({
      title: input.title,
      content: input.content ?? '',
      template_id: input.template_id ?? null,
      recipient_name: input.recipient_name ?? '',
      recipient_email: input.recipient_email ?? '',
      sender_signature_enabled: input.sender_signature_enabled ?? true,
      recipient_signature_enabled: input.recipient_signature_enabled ?? true,
      created_by: userId,
    })
    .select('*')
    .single();
  if (error) throw error;
  const doc = mapDocumentRow(data);
  await recordDocumentEvent(doc.id, 'created', options.aiAssisted ? { via: 'ai_assistant' } : {}).catch(() => {});
  // Same as proposals: when the document carries a sender signature, apply it at
  // creation so it goes out already signed on our side. Best effort, never emails.
  if (doc.sender_signature_enabled) {
    try {
      await autoSignDocumentAsSender(doc.id);
    } catch (e) {
      console.error('Could not auto-sign the new document', e);
    }
  }
  return doc;
}

/** Sign a new document for the agency. Defaults to the same signer proposals use
 * (Zak); `signerHint` names someone else, which is what the AI assistant passes
 * through when the user says whose signature to use. */
export async function autoSignDocumentAsSender(documentId: string, signerHint?: string | null): Promise<void> {
  await setDocumentSenderSigner({ document_id: documentId, signer_hint: signerHint });
}

export async function updateDocument(
  id: string,
  updates: Partial<
    Pick<
      Document,
      | 'title'
      | 'content'
      | 'recipient_name'
      | 'recipient_email'
      | 'valid_until'
      | 'sender_signature_enabled'
      | 'recipient_signature_enabled'
    >
  >,
): Promise<Document> {
  const { data, error } = await supabase
    .from('documents')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return mapDocumentRow(data);
}

export async function deleteDocument(id: string): Promise<void> {
  const { error } = await supabase.from('documents').delete().eq('id', id);
  if (error) throw error;
}

export async function voidDocument(id: string): Promise<Document> {
  const { data, error } = await supabase
    .from('documents')
    .update({ status: 'void', void_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  await recordDocumentEvent(id, 'void', {}).catch(() => {});
  return mapDocumentRow(data);
}

export async function reopenDocument(id: string): Promise<Document> {
  // Return a voided/expired doc to a sendable state. Never reopen a signed doc.
  const { data, error } = await supabase
    .from('documents')
    .update({ status: 'draft', void_at: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .neq('status', 'signed')
    .select('*')
    .single();
  if (error) throw error;
  await recordDocumentEvent(id, 'reopened', {}).catch(() => {});
  return mapDocumentRow(data);
}

function generatePublicToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Ensure a document is shareable via link (copy-link path): generate the token,
 * set valid_until, flip draft -> sent. Email sending goes through the edge fn. */
export async function markDocumentSent(document: Document): Promise<Document> {
  if (document.signed_at) return document;
  const settings = await getDocumentSettings();
  const wasDraft = document.status === 'draft';
  const validDays = settings.defaults.valid_days || 0;
  const validUntil =
    document.valid_until ??
    // Counted from today in New York, the same clock that expires the link.
    (validDays > 0 ? addDaysToDate(businessDate(), validDays) : null);

  const updates: Record<string, unknown> = {
    public_token: document.public_token ?? generatePublicToken(),
    valid_until: validUntil,
    updated_at: new Date().toISOString(),
  };
  if (wasDraft) {
    updates.status = 'sent';
    updates.sent_at = new Date().toISOString();
  }
  const { data, error } = await supabase.from('documents').update(updates).eq('id', document.id).select('*').single();
  if (error) throw error;
  if (wasDraft) await recordDocumentEvent(document.id, 'sent', { send_method: 'link' }).catch(() => {});
  return mapDocumentRow(data);
}

// ---------------------------------------------------------------------------
// Public + signing (edge functions)

export type PublicSenderSignature = {
  signer_name: string;
  typed_name: string;
  signature_image: string;
  signed_at: string;
};

export type PublicDocumentPayload = {
  ok: true;
  document: {
    id: string;
    document_number: number;
    title: string;
    content: string;
    status: Document['status'];
    recipient_name: string;
    recipient_email: string;
    sender_signature_enabled: boolean;
    recipient_signature_enabled: boolean;
  };
  /** The recipient's signature, display fields only (the server leaves out IP, browser and email). */
  signature: PublicSenderSignature | null;
  sender_signature: PublicSenderSignature | null;
  signed: boolean;
  expired: boolean;
};

export async function fetchPublicDocument(
  token: string,
  options: { preview?: boolean } = {},
): Promise<PublicDocumentPayload | null> {
  const { data, error } = await supabase.functions.invoke('document_public', {
    body: { token, preview: options.preview ?? false },
  });
  // Null only for an unknown token (404); other errors throw so the page can offer a retry.
  return resolvePublicInvoke<PublicDocumentPayload>(data, error);
}

export async function signDocumentPublic(input: {
  token: string;
  typed_name: string;
  signer_email: string;
  signature_image: string;
}): Promise<{ ok: boolean; code?: string; message?: string }> {
  const { data, error } = await supabase.functions.invoke('document_sign', { body: input });
  if (error) {
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = await context.json();
        return { ok: false, code: body?.error?.code, message: body?.error?.message };
      } catch {
        /* fall through */
      }
    }
    return { ok: false, message: error.message };
  }
  if (data?.ok !== true) return { ok: false, code: data?.error?.code, message: data?.error?.message };
  return { ok: true };
}

export async function sendDocumentEmail(input: {
  document_id: string;
  recipient_email: string;
  recipient_name?: string;
  message?: string;
  reply_to_emails?: string[];
}): Promise<{ public_token: string; email_status: 'sent' | 'skipped' }> {
  const { data, error } = await supabase.functions.invoke('document_send_email', {
    body: { ...input, app_url: publicDocumentOrigin() },
  });
  if (error) {
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = await context.json();
        throw new Error(body?.error?.message ?? error.message);
      } catch (e) {
        if (e instanceof Error && e.message !== error.message) throw e;
      }
    }
    throw error;
  }
  if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Failed to send document');
  return { public_token: data.public_token, email_status: data.email_status };
}

// ---------------------------------------------------------------------------
// Events & signatures

export async function listDocumentEvents(documentId: string): Promise<DocumentEvent[]> {
  const { data, error } = await supabase
    .from('document_events')
    .select('*')
    .eq('document_id', documentId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return attachActorNames((data ?? []) as DocumentEvent[]);
}

export async function recordDocumentEvent(
  documentId: string,
  eventType: DocumentEventType,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return;
  const { error } = await supabase.from('document_events').insert({
    document_id: documentId,
    event_type: eventType,
    actor: 'admin',
    actor_user_id: userId,
    metadata,
  });
  if (error) throw error;
}

export async function listDocumentSignatures(documentId: string): Promise<DocumentSignature[]> {
  const { data, error } = await supabase
    .from('document_signatures')
    .select('*')
    .eq('document_id', documentId)
    .order('signed_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as DocumentSignature[];
}

export type SavedSignature = {
  signer_name: string;
  signature_image: string;
  /** How it was made, so the type-to-sign style can be reused. */
  signature_type?: 'draw' | 'type';
  typed_name?: string;
  signature_font?: string;
};

/** The current user's saved default signature, made once and reused. */
export async function getMySignature(): Promise<SavedSignature | null> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData?.user?.id;
  if (!uid) return null;
  const { data, error } = await supabase
    .from('user_signatures')
    .select('signer_name, signature_image, signature_type, typed_name, signature_font')
    .eq('user_id', uid)
    .maybeSingle();
  if (error || !data) return null;
  return {
    signer_name: data.signer_name,
    signature_image: data.signature_image,
    signature_type: (data.signature_type as 'draw' | 'type') ?? 'draw',
    typed_name: data.typed_name ?? '',
    signature_font: data.signature_font ?? '',
  };
}

/** Save (or update) the current user's default signature for reuse. */
export async function saveMySignature(input: SavedSignature): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData?.user?.id;
  if (!uid) return;
  const { error } = await supabase
    .from('user_signatures')
    .upsert(
      {
        user_id: uid,
        signer_name: input.signer_name,
        signature_image: input.signature_image,
        signature_type: input.signature_type ?? 'draw',
        typed_name: input.typed_name ?? '',
        signature_font: input.signature_font ?? '',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
  if (error) throw error;
}

/** Sender (staff) counter-signature, applied from the app. Upserts the single
 * sender-role row for the document, and remembers it as the user's default so it
 * pre-fills on future documents. */
export async function upsertSenderSignature(input: {
  document_id: string;
  signer_name: string;
  signature_image: string;
  typed_name?: string;
  /** How the signature was produced, persisted to the user's default. */
  signature_type?: 'draw' | 'type';
  signature_font?: string;
  /** When false, do not overwrite the user's saved default (e.g. applying the saved one). */
  saveAsDefault?: boolean;
}): Promise<DocumentSignature> {
  const { data: userData } = await supabase.auth.getUser();
  const email = userData?.user?.email ?? '';
  const { data, error } = await supabase
    .from('document_signatures')
    .upsert(
      {
        document_id: input.document_id,
        signer_role: 'sender',
        signer_name: input.signer_name,
        signer_email: email,
        // Drawing your own signature makes YOU the signer, so the picker on the
        // page reflects that instead of still showing the previous person.
        signer_user_id: userData?.user?.id ?? null,
        signature_image: input.signature_image,
        typed_name: input.typed_name ?? input.signer_name,
        signed_at: new Date().toISOString(),
      },
      { onConflict: 'document_id,signer_role' },
    )
    .select('*')
    .single();
  if (error) throw error;
  await recordDocumentEvent(input.document_id, 'signed', { role: 'sender' }).catch(() => {});
  if (input.saveAsDefault !== false) {
    await saveMySignature({
      signer_name: input.signer_name,
      signature_image: input.signature_image,
      signature_type: input.signature_type ?? 'draw',
      typed_name: input.typed_name ?? '',
      signature_font: input.signature_font ?? '',
    }).catch(() => {});
  }
  return data as DocumentSignature;
}

/** Put a named team member's signature on a document as the sender.
 *
 * This is the path that makes "send it with Zak's signature" possible: the
 * signature comes from the SIGNER'S profile, not from the signed-in user's
 * private user_signatures row, and a signer who never drew one gets their name
 * rendered in a script face. It deliberately never touches the caller's saved
 * default, since signing as a colleague says nothing about your own signature.
 *
 * Returns the signer actually used, so callers can report "signed as Zak"
 * truthfully when a hint did not match anyone. */
export async function setDocumentSenderSigner(input: {
  document_id: string;
  /** A name, first name or email. Falls back to the default signer (Zak). */
  signer_hint?: string | null;
  /** Skip resolution when the caller already picked from the list. */
  signer?: StaffSigner;
}): Promise<{ signer: StaffSigner; matched: boolean } | null> {
  let signer = input.signer ?? null;
  let matched = Boolean(input.signer);
  if (!signer) {
    const signers = await listStaffSigners();
    const resolved = resolveSigner(signers, input.signer_hint);
    signer = resolved.signer;
    matched = resolved.matched;
  }
  if (!signer) return null;
  const image = signerImage(signer);
  if (!image) return null;
  const { error } = await supabase
    .from('document_signatures')
    .upsert(
      {
        document_id: input.document_id,
        signer_role: 'sender',
        signer_name: signer.name,
        signer_email: signer.email,
        signer_user_id: signer.id,
        signature_image: image,
        typed_name: signer.name,
        signed_at: new Date().toISOString(),
      },
      { onConflict: 'document_id,signer_role' },
    );
  if (error) throw error;
  await recordDocumentEvent(input.document_id, 'signed', { role: 'sender', signer: signer.email }).catch(() => {});
  return { signer, matched };
}

export async function removeSenderSignature(documentId: string): Promise<void> {
  const { error } = await supabase
    .from('document_signatures')
    .delete()
    .eq('document_id', documentId)
    .eq('signer_role', 'sender');
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Templates

export async function listDocumentTemplates(
  options: { activeOnly?: boolean } = {},
): Promise<DocumentTemplate[]> {
  let query = supabase.from('document_templates').select('*').order('display_order', { ascending: true });
  if (options.activeOnly) query = query.eq('is_active', true);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as DocumentTemplate[];
}

export async function getDocumentTemplate(id: string): Promise<DocumentTemplate | null> {
  const { data, error } = await supabase.from('document_templates').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as DocumentTemplate) ?? null;
}

export async function createDocumentTemplate(
  input: Omit<DocumentTemplate, 'id' | 'created_at' | 'updated_at'>,
): Promise<DocumentTemplate> {
  const { data, error } = await supabase.from('document_templates').insert(input).select('*').single();
  if (error) throw error;
  return data as DocumentTemplate;
}

export async function updateDocumentTemplate(
  id: string,
  updates: Partial<Omit<DocumentTemplate, 'id' | 'created_at' | 'updated_at'>>,
): Promise<DocumentTemplate> {
  const { data, error } = await supabase
    .from('document_templates')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as DocumentTemplate;
}

export async function deleteDocumentTemplate(id: string): Promise<void> {
  const { error } = await supabase.from('document_templates').delete().eq('id', id);
  if (error) throw error;
}
