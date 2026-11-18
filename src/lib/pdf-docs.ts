import { supabase } from './supabase';
import { autoSignDocumentAsSender, recordDocumentEvent } from './documents-db';
import type { Document, PdfField, PdfFieldRole, PdfFieldType } from './types';

// Uploaded PDFs signed on any page (Emil, 2026-11-18: "signatures on pages 47 and 32", like DocuSign).
// The file lives in the private "signing-docs" bucket (originals/<document id>.pdf); fields are stored on the
// document as fractions of each page as shown (supabase/functions/_shared/pdf-sign.ts stamps them).
// pdf.js is only loaded on pages that show a PDF.

export const PDF_MAX_BYTES = 25 * 1024 * 1024;
const BUCKET = 'signing-docs';

type PdfJs = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= (async () => {
    const pdfjs = await import('pdfjs-dist');
    const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = worker;
    return pdfjs;
  })();
  return pdfjsPromise;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Pages and fingerprint of a PDF file, read in the browser before it is uploaded. */
export async function inspectPdf(file: File): Promise<{ pages: number; sha256: string; bytes: ArrayBuffer }> {
  if (file.size > PDF_MAX_BYTES) throw new Error('That PDF is over 25 MB.');
  const bytes = await file.arrayBuffer();
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
  const pages = doc.numPages;
  await doc.destroy();
  return { pages, sha256: await sha256Hex(bytes), bytes };
}

/** A new document from an uploaded PDF, signed on our side by default (as text documents are). */
export async function createPdfDocument(input: {
  file: File;
  title: string;
  recipient_name?: string;
  recipient_email?: string;
}): Promise<Document> {
  const { pages, sha256, bytes } = await inspectPdf(input.file);
  const { data: userData } = await supabase.auth.getUser();
  const { data: row, error } = await supabase
    .from('documents')
    .insert({
      title: input.title,
      content: '',
      kind: 'pdf',
      recipient_name: input.recipient_name ?? '',
      recipient_email: input.recipient_email ?? '',
      sender_signature_enabled: true,
      recipient_signature_enabled: true,
      pdf_pages: pages,
      pdf_sha256: sha256,
      created_by: userData?.user?.id ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  const path = `originals/${row.id}.pdf`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, new Blob([bytes], { type: 'application/pdf' }), {
    contentType: 'application/pdf',
    upsert: true,
  });
  if (upErr) {
    await supabase.from('documents').delete().eq('id', row.id);
    throw new Error(`The PDF couldn't be uploaded: ${upErr.message}`);
  }
  const { data: saved, error: saveErr } = await supabase.from('documents').update({ pdf_path: path }).eq('id', row.id).select('*').single();
  if (saveErr) throw saveErr;
  await recordDocumentEvent(row.id, 'created', { via: 'pdf_upload', pages }).catch(() => {});
  await autoSignDocumentAsSender(row.id).catch(() => {});
  return saved as Document;
}

export async function savePdfFields(documentId: string, fields: PdfField[]): Promise<void> {
  const { error } = await supabase
    .from('documents')
    .update({ pdf_fields: fields, updated_at: new Date().toISOString() })
    .eq('id', documentId);
  if (error) throw error;
}

/** An hour-long link to a stored PDF, for the signed-in team. */
export async function pdfLink(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error) return null;
  return data.signedUrl;
}

/** Makes the signed PDF again (if the run after signing failed). */
export async function remakeSignedPdf(documentId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('document_sign', { body: { action: 'finalize_pdf', document_id: documentId } });
  if (error) throw new Error(error.message);
  if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Could not make the signed PDF');
}

export const FIELD_LABEL: Record<PdfFieldType, string> = {
  signature: 'Signature',
  initials: 'Initials',
  date: 'Date signed',
  name: 'Full name',
};

export const ROLE_LABEL: Record<PdfFieldRole, string> = {
  recipient: 'Recipient',
  sender: 'Us (ECD)',
};

/** Default size of a new field, as fractions of the page. */
export const FIELD_SIZE: Record<PdfFieldType, { w: number; h: number }> = {
  signature: { w: 0.3, h: 0.055 },
  initials: { w: 0.09, h: 0.04 },
  date: { w: 0.2, h: 0.025 },
  name: { w: 0.28, h: 0.025 },
};

export const newFieldId = () => (crypto.randomUUID ? crypto.randomUUID() : `f${Date.now()}${Math.random().toString(16).slice(2)}`);
