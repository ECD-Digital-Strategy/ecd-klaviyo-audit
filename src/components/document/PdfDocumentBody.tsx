import { useEffect, useRef, useState } from 'react';
import { Check, Download, Loader2, RefreshCw } from 'lucide-react';
import PdfFieldEditor from './PdfFieldEditor';
import PdfPages from './PdfPages';
import { pdfLink, remakeSignedPdf, savePdfFields } from '../../lib/pdf-docs';
import { useToast } from '../ui/Toast';
import type { Document, PdfField } from '../../lib/types';

/**
 * The body of an uploaded-PDF document on its page in the app (2026-11-18): place fields while it's a draft
 * (saved as you go), see them read-only once sent, and the signed copy once the recipient has signed.
 */
export default function PdfDocumentBody({ doc, onSaved }: { doc: Document; onSaved: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [fields, setFields] = useState<PdfField[]>(doc.pdf_fields ?? []);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [remaking, setRemaking] = useState(false);
  const timer = useRef<number | null>(null);
  const editable = doc.status === 'draft';
  const signed = doc.status === 'signed';

  useEffect(() => {
    void pdfLink(doc.pdf_path).then(setUrl);
    void pdfLink(doc.signed_pdf_path).then(setSignedUrl);
  }, [doc.pdf_path, doc.signed_pdf_path]);

  useEffect(() => setFields(doc.pdf_fields ?? []), [doc.id, doc.pdf_fields]);

  const change = (next: PdfField[]) => {
    setFields(next);
    if (timer.current) window.clearTimeout(timer.current);
    setSaving('saving');
    timer.current = window.setTimeout(async () => {
      try {
        await savePdfFields(doc.id, next);
        setSaving('saved');
        onSaved();
      } catch (e) {
        setSaving('idle');
        toast(e instanceof Error ? e.message : 'Could not save the fields');
      }
    }, 600);
  };

  const remake = async () => {
    setRemaking(true);
    try {
      await remakeSignedPdf(doc.id);
      toast('Signed PDF made, and the copy to the client is drafted in your Gmail');
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not make the signed PDF');
    } finally {
      setRemaking(false);
    }
  };

  const recipientFields = fields.filter(f => f.role === 'recipient').length;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-gray-500">
          PDF, {doc.pdf_pages ?? '?'} page{doc.pdf_pages === 1 ? '' : 's'}
          {editable ? ': place the fields, then send it to sign.' : signed ? ', signed.' : ': sent, fields locked.'}
        </span>
        {editable && (
          <span className="flex items-center gap-1 text-gray-400">
            {saving === 'saving' ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</> : saving === 'saved' ? <><Check className="h-3.5 w-3.5 text-emerald-500" /> Saved</> : null}
          </span>
        )}
        {editable && recipientFields === 0 && (
          <span className="rounded bg-amber-50 px-2 py-0.5 font-medium text-amber-800">Add at least one field for the recipient before sending.</span>
        )}
        <span className="ml-auto flex gap-1.5">
          {signed && signedUrl && (
            <a href={signedUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-3 py-1.5 font-semibold text-white hover:bg-brand-primary-dark">
              <Download className="h-3.5 w-3.5" /> Signed PDF
            </a>
          )}
          {signed && (
            <button type="button" onClick={() => void remake()} disabled={remaking} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50" title="Stamps the signatures into the PDF again and drafts the signed copy to the client">
              {remaking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} {doc.signed_pdf_path ? 'Make it again' : 'Make the signed PDF'}
            </button>
          )}
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-50">
              <Download className="h-3.5 w-3.5" /> Original
            </a>
          )}
        </span>
      </div>

      {signed && signedUrl ? (
        <PdfPages url={signedUrl} />
      ) : url ? (
        <PdfFieldEditor url={url} pages={doc.pdf_pages ?? 1} fields={fields} onChange={change} readOnly={!editable} senderAllowed={doc.sender_signature_enabled} />
      ) : (
        <div className="flex items-center gap-2 py-16 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading the PDF…</div>
      )}
    </div>
  );
}
