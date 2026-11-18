import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Check, Download, Loader2 } from 'lucide-react';
import PdfPages from '../components/document/PdfPages';
import PdfSigner from '../components/document/PdfSigner';
import { RichAuditContent } from '../components/ui/RichAuditText';
import SignaturePad, { type SignaturePadHandle } from '../components/proposal/SignaturePad';
import DocumentSignatures from '../components/document/DocumentSignatures';
import { fetchPublicDocument, signDocumentPublic, type PublicDocumentPayload } from '../lib/documents-db';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Shell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen bg-[#f4f4f8] py-8 px-4">
      <div className={wide ? 'mx-auto max-w-4xl' : 'mx-auto max-w-3xl'}>
        <div className="mb-5 flex items-center gap-2">
          <img src="/cropped-favicon-192x192.webp" alt="" className="h-7 w-7 rounded-md" width={28} height={28} />
          <span className="text-xs font-bold uppercase tracking-wider text-brand-primary">ECD Digital Strategy</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function SignForm({ recipientName, recipientEmail, onSign }: { recipientName: string; recipientEmail: string; onSign: (typedName: string, email: string, image: string) => Promise<void> }) {
  const padRef = useRef<SignaturePadHandle>(null);
  const [name, setName] = useState(recipientName);
  const [email, setEmail] = useState(recipientEmail);
  const [empty, setEmpty] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    if (!name.trim()) return setError('Please enter your full name.');
    if (!EMAIL_RE.test(email.trim())) return setError('Please enter a valid email.');
    const image = padRef.current?.toDataURL();
    if (!image) return setError('Please add your signature.');
    setSubmitting(true);
    try {
      await onSign(name.trim(), email.trim(), image);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not submit your signature.');
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-1.5">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Full name" className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none" />
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none" />
      </div>
      <div className="mt-2">
        <SignaturePad ref={padRef} onChange={setEmpty} typedName={name} />
      </div>
      {error && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
      <button onClick={submit} disabled={submitting || empty} className="mt-3 w-full rounded-lg bg-brand-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-primary-dark disabled:opacity-50">
        {submitting ? 'Submitting…' : 'Accept & sign'}
      </button>
    </div>
  );
}

export default function PublicDocument() {
  const { token } = useParams<{ token: string }>();
  const [payload, setPayload] = useState<PublicDocumentPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // A backend error is not a dead link: say so and offer a retry.
  const [loadFailed, setLoadFailed] = useState(false);

  const load = async () => {
    if (!token) return;
    try {
      const data = await fetchPublicDocument(token);
      setLoadFailed(false);
      if (!data) setNotFound(true);
      else setPayload(data);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const retry = () => {
    setLoading(true);
    void load();
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  if (loading) {
    return <Shell><div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div></Shell>;
  }
  if (loadFailed) {
    return (
      <Shell>
        <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-900">Couldn&apos;t load this right now</p>
          <p className="mt-1 text-sm text-gray-500">Please check your connection and try again.</p>
          <button onClick={retry} className="mt-4 rounded-lg bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:bg-brand-primary-dark">
            Retry
          </button>
        </div>
      </Shell>
    );
  }
  if (notFound || !payload) {
    return <Shell><div className="rounded-2xl border border-gray-100 bg-white p-8 text-center text-sm text-gray-500">This document link is invalid or is no longer available.</div></Shell>;
  }

  const { document, signature, sender_signature, signed, expired } = payload;
  const voided = document.status === 'void';
  // A document that does not ask the recipient to sign is a statement, not an
  // agreement: no pad, and no "awaiting signature" that will never arrive.
  const recipientSigns = document.recipient_signature_enabled !== false;
  const canSign = recipientSigns && !signed && !expired && !voided;

  // An uploaded PDF (2026-11-18): signed in place on its own pages.
  if (document.kind === 'pdf') {
    return (
      <Shell wide>
        <div className="mb-4 rounded-2xl border border-gray-100 bg-white px-6 py-4 shadow-sm">
          <h1 className="text-xl font-bold text-gray-900">{document.title || 'Document'}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {signed
              ? 'Signed. Thank you.'
              : expired
                ? 'This document has expired and can no longer be signed.'
                : voided
                  ? 'This document is no longer available for signing.'
                  : 'Please review the document. Your fields are highlighted in yellow: use Next field to go through them.'}
          </p>
          {signed && payload.signed_pdf_url && (
            <a href={payload.signed_pdf_url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:bg-brand-primary-dark">
              <Download className="h-4 w-4" /> Download the signed PDF
            </a>
          )}
        </div>
        {signed && payload.signed_pdf_url ? (
          <PdfPages url={payload.signed_pdf_url} />
        ) : canSign && payload.pdf_url ? (
          <PdfSigner
            url={payload.pdf_url}
            fields={document.pdf_fields ?? []}
            recipientName={document.recipient_name}
            recipientEmail={document.recipient_email}
            sender={sender_signature ? { name: sender_signature.typed_name || sender_signature.signer_name, signature_image: sender_signature.signature_image, signed_at: sender_signature.signed_at } : null}
            onSign={async a => {
              const res = await signDocumentPublic({ token: token!, typed_name: a.name, signer_email: a.email, signature_image: a.signature, initials_image: a.initials ?? undefined });
              if (!res.ok) throw new Error(res.message ?? 'Could not sign the document.');
              await load();
            }}
          />
        ) : payload.pdf_url ? (
          <PdfPages url={payload.pdf_url} />
        ) : null}
      </Shell>
    );
  }

  const recipientPending = canSign ? (
    <SignForm
      recipientName={document.recipient_name}
      recipientEmail={document.recipient_email}
      onSign={async (typedName, email, image) => {
        const res = await signDocumentPublic({ token: token!, typed_name: typedName, signer_email: email, signature_image: image });
        if (!res.ok) throw new Error(res.message ?? 'Could not sign the document.');
        await load();
      }}
    />
  ) : expired ? (
    <p className="mt-1.5 text-xs text-amber-700">This document has expired and can no longer be signed.</p>
  ) : voided ? (
    <p className="mt-1.5 text-xs text-gray-400">This document is no longer available for signing.</p>
  ) : undefined;

  return (
    <Shell>
      <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-bold text-gray-900">{document.title || 'Document'}</h1>
        <div className="mt-4 text-sm leading-relaxed text-gray-700 [&_ul]:list-disc [&_ul]:pl-5">
          <RichAuditContent text={document.content} autoTagEntities={false} />
        </div>
      </div>

      {signed && (
        <div className="mt-6 flex items-center gap-2 rounded-2xl border border-emerald-100 bg-emerald-50 px-5 py-3 text-sm font-medium text-emerald-700">
          <Check className="h-5 w-5" /> This document has been signed. Thank you.
        </div>
      )}

      <div className="mt-6 rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">
        <DocumentSignatures
          senderEnabled={document.sender_signature_enabled}
          recipientEnabled={recipientSigns}
          sender={sender_signature}
          recipient={signature}
          recipientName={document.recipient_name}
          recipientPending={recipientPending}
        />
      </div>
    </Shell>
  );
}
