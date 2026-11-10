import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, Check, Copy, ExternalLink, Eye, Loader2, Pencil, PenLine, Printer, RotateCcw, Send, Trash2 } from 'lucide-react';
import TopBar from '../components/layout/TopBar';
import { RichAuditContent } from '../components/ui/RichAuditText';
import SimpleRichEditor from '../components/ui/SimpleRichEditor';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useDocumentData } from '../hooks/useDocumentData';
import { markDocumentSent, updateDocument, voidDocument, reopenDocument, upsertSenderSignature, removeSenderSignature, getMySignature, setDocumentSenderSigner, type SavedSignature } from '../lib/documents-db';
import { listStaffSigners, pickDefaultSigner, type StaffSigner } from '../lib/staff-signers';
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../components/ui/select';
import { buildDocumentSnapshot, sanitizeCopy, type DocDraftPayload, type DocEditPayload } from '../lib/document-agent';
import { publicDocumentOrigin } from '../lib/public-origin';
import { cn } from '../lib/utils';
import { DocumentAgentProvider } from '../components/document/agent/DocumentAgentContext';
import { DocumentAgentLayout, DocAgentToggleButton } from '../components/document/agent/DocumentAgentLayout';
import DocumentActivityTimeline from '../components/document/DocumentActivityTimeline';
import DocumentSignatures from '../components/document/DocumentSignatures';
import SendDocumentModal from '../components/document/SendDocumentModal';
import HoverTooltip from '../components/ui/HoverTooltip';
import SignaturePad, { type SignaturePadHandle, type SignatureMeta } from '../components/proposal/SignaturePad';
import BrandedCheckbox from '../components/ui/BrandedCheckbox';
import Modal from '../components/ui/Modal';
import type { Document, DocumentDisplayStatus, DocumentEvent, DocumentSignature } from '../lib/types';
import { isPastValidUntil } from '../lib/valid-until';

const STATUS_LABELS: Record<DocumentDisplayStatus, { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'bg-gray-100 text-gray-600' },
  sent: { label: 'Sent', tone: 'bg-blue-50 text-blue-600' },
  viewed: { label: 'Viewed', tone: 'bg-purple-50 text-purple-600' },
  signed: { label: 'Signed', tone: 'bg-emerald-50 text-emerald-600' },
  void: { label: 'Void', tone: 'bg-red-50 text-red-600' },
  expired: { label: 'Expired', tone: 'bg-amber-50 text-amber-700' },
};

function displayStatus(doc: Document): DocumentDisplayStatus {
  // Same clock as the public link: the end of the valid_until day in New York.
  if ((doc.status === 'sent' || doc.status === 'viewed') && isPastValidUntil(doc.valid_until)) return 'expired';
  return doc.status;
}

function SenderSignatureModal({ open, defaultName, initialMeta, onClose, onSave }: { open: boolean; defaultName: string; initialMeta?: SavedSignature | null; onClose: () => void; onSave: (name: string, image: string, meta: SignatureMeta) => Promise<void> }) {
  const padRef = useRef<SignaturePadHandle>(null);
  const [name, setName] = useState(defaultName);
  const [empty, setEmpty] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setError('');
    if (!name.trim()) return setError('Please enter your name.');
    const image = padRef.current?.toDataURL();
    const meta = padRef.current?.getMeta() ?? { mode: 'draw' as const, typed_name: '', font: '' };
    if (!image) return setError('Please add your signature.');
    setSaving(true);
    try {
      await onSave(name.trim(), image, meta);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your signature.');
      setSaving(false);
    }
  };

  return (
    <Modal open={open} title="Add your signature" onClose={() => !saving && onClose()} className="max-w-md">
      <div className="space-y-3 p-5">
        <div>
          <label className="block text-xs font-medium text-gray-600">Your name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Full name" className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Signature</label>
          {/* A saved DRAWN signature reopens on the draw tab so redrawing matches
              what you used before; everything else, including a first signature,
              starts on type. */}
          <SignaturePad
            ref={padRef}
            onChange={setEmpty}
            typedName={name}
            initialMode={initialMeta?.signature_type === 'draw' ? 'draw' : 'type'}
          />
        </div>
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} disabled={saving} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
          <button onClick={save} disabled={saving || empty} className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:bg-brand-primary-dark disabled:opacity-50">{saving ? 'Saving…' : 'Save signature'}</button>
        </div>
      </div>
    </Modal>
  );
}

type SaveStatus = 'idle' | 'saving' | 'saved';

function WorkspaceInner({ doc, events, signature, senderSignature, reload, onDocChange }: { doc: Document; events: DocumentEvent[]; signature: DocumentSignature | null; senderSignature: DocumentSignature | null; reload: () => Promise<void>; onDocChange: (d: Document) => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();

  const status = displayStatus(doc);
  const locked = doc.status === 'signed' || doc.status === 'void';
  const editable = !locked;
  // The sender can add/replace their own signature at any time, including AFTER
  // the recipient has signed (a countersignature). Only a voided document blocks it.
  const senderSignDisabled = doc.status === 'void';
  const [togglingRecipient, setTogglingRecipient] = useState(false);
  // Once the recipient has signed, the question is settled: turning it off would
  // hide a signature they actually gave.
  const recipientToggleDisabled = doc.status === 'void' || doc.status === 'signed';

  // Inline editing (title + body) with debounced autosave.
  const [title, setTitle] = useState(doc.title);
  const [content, setContent] = useState(doc.content);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>(editable ? 'edit' : 'preview');
  const latest = useRef({ title: doc.title, content: doc.content, recipient_name: doc.recipient_name, recipient_email: doc.recipient_email });
  const timer = useRef<number | null>(null);

  const [sendOpen, setSendOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [name, setName] = useState(doc.recipient_name);
  const [email, setEmail] = useState(doc.recipient_email);
  const [togglingSender, setTogglingSender] = useState(false);
  const [savedSig, setSavedSig] = useState<SavedSignature | null>(null);
  const [signers, setSigners] = useState<StaffSigner[]>([]);
  const [selectedSignerId, setSelectedSignerId] = useState('');
  const [applyingSigner, setApplyingSigner] = useState(false);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  // Load the current user's reusable signature so it can pre-fill.
  useEffect(() => {
    let cancelled = false;
    getMySignature().then(sig => { if (!cancelled) setSavedSig(sig); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Who signs for ECD. Documents go out under a colleague's name often enough
  // that this is a picker, not "whoever is logged in", and it defaults to Zak.
  useEffect(() => {
    let cancelled = false;
    listStaffSigners()
      .then(rows => {
        if (cancelled) return;
        setSigners(rows);
        const current =
          rows.find(r => r.id === senderSignature?.signer_user_id) ??
          rows.find(r => r.email.toLowerCase() === (senderSignature?.signer_email ?? '').toLowerCase()) ??
          pickDefaultSigner(rows);
        setSelectedSignerId(current?.id ?? '');
      })
      .catch(() => { /* the picker degrades to the draw-your-own flow */ });
    return () => { cancelled = true; };
  }, [senderSignature?.signer_user_id, senderSignature?.signer_email]);

  const applySigner = async (signerId: string) => {
    const signer = signers.find(s => s.id === signerId);
    if (!signer) return;
    setSelectedSignerId(signerId);
    setApplyingSigner(true);
    try {
      await setDocumentSenderSigner({ document_id: doc.id, signer });
      if (!doc.sender_signature_enabled) {
        const updated = await updateDocument(doc.id, { sender_signature_enabled: true });
        onDocChange(updated);
      }
      await reload();
      toast(`Signed as ${signer.name || signer.email}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change the signature');
    } finally {
      setApplyingSigner(false);
    }
  };

  const scheduleSave = (next: Partial<typeof latest.current>) => {
    latest.current = { ...latest.current, ...next };
    setSaveStatus('saving');
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        const updated = await updateDocument(doc.id, {
          title: latest.current.title,
          content: latest.current.content,
          recipient_name: latest.current.recipient_name,
          recipient_email: latest.current.recipient_email,
        });
        onDocChange(updated);
        setSaveStatus('saved');
      } catch {
        setSaveStatus('idle');
      }
    }, 800);
  };

  const applySavedSignature = async () => {
    if (!savedSig) return;
    await upsertSenderSignature({ document_id: doc.id, signer_name: savedSig.signer_name, signature_image: savedSig.signature_image, saveAsDefault: false });
    await reload();
    toast('Your saved signature was added');
  };

  /** Ask the recipient to sign, or do not. Off makes the document a statement:
   *  the public page drops the pad and the signature block shows only ours. */
  const toggleRecipientSignature = async (enabled: boolean) => {
    setTogglingRecipient(true);
    try {
      const updated = await updateDocument(doc.id, { recipient_signature_enabled: enabled });
      onDocChange(updated);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change that');
    } finally {
      setTogglingRecipient(false);
    }
  };

  const toggleSenderSignature = async (enabled: boolean) => {
    setTogglingSender(true);
    try {
      const updated = await updateDocument(doc.id, { sender_signature_enabled: enabled });
      onDocChange(updated);
      // Turning it on signs as the selected team member, which defaults to Zak.
      // It used to reach for the signed-in user's own saved signature and prompt
      // them to draw one when they had none, which was the wrong default: most
      // documents go out under Zak's name, and any team member can be signed for
      // without a drawing (their name renders in a script face).
      if (enabled && !senderSignature) {
        const target = selectedSignerId || pickDefaultSigner(signers)?.id || '';
        if (target) await applySigner(target);
        else if (savedSig) await applySavedSignature();
        else setSignOpen(true);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update setting');
    } finally {
      setTogglingSender(false);
    }
  };

  const saveSenderSignature = async (signerName: string, image: string, meta: SignatureMeta) => {
    await upsertSenderSignature({
      document_id: doc.id,
      signer_name: signerName,
      signature_image: image,
      signature_type: meta.mode,
      signature_font: meta.font,
      typed_name: meta.typed_name || signerName,
    });
    setSavedSig({ signer_name: signerName, signature_image: image, signature_type: meta.mode, typed_name: meta.typed_name, signature_font: meta.font });
    setSignOpen(false);
    await reload();
    toast('Your signature was saved');
  };

  const clearSenderSignature = async () => {
    try {
      await removeSenderSignature(doc.id);
      await reload();
      toast('Your signature was removed');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove signature');
    }
  };

  const copyLink = async () => {
    try {
      const updated = doc.public_token ? doc : await markDocumentSent(doc);
      if (!doc.public_token) { onDocChange(updated); void reload(); }
      await navigator.clipboard.writeText(`${publicDocumentOrigin()}/document/${updated.public_token}`);
      toast('Signing link copied to clipboard');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not copy link');
    }
  };

  const openRecipientView = async () => {
    const updated = doc.public_token ? doc : await markDocumentSent(doc).catch(() => null);
    if (updated?.public_token) {
      if (!doc.public_token) { onDocChange(updated); void reload(); }
      window.open(`${publicDocumentOrigin()}/document/${updated.public_token}`, '_blank', 'noopener');
    }
  };

  const downloadPdf = () => {
    setViewMode('preview');
    window.setTimeout(() => window.print(), 120);
  };

  /** Apply a signer the assistant named ("send it with Zak's signature"), and
   * turn the sender signature on, since naming a signer is asking for one. Quiet
   * when the assistant named nobody, which is the normal case. */
  const applySignerHint = async (hint?: string) => {
    const wanted = (hint ?? '').trim();
    if (!wanted || senderSignDisabled) return;
    try {
      const result = await setDocumentSenderSigner({ document_id: doc.id, signer_hint: wanted });
      if (!result) return;
      if (!doc.sender_signature_enabled) {
        const updated = await updateDocument(doc.id, { sender_signature_enabled: true }).catch(() => null);
        if (updated) onDocChange(updated);
      }
      setSelectedSignerId(result.signer.id);
      await reload();
      // Say which name was used when the hint did not resolve, so nobody assumes
      // a document went out under a name it did not.
      toast(
        result.matched
          ? `Signed as ${result.signer.name || result.signer.email}`
          : `Could not match "${wanted}", so it is signed as ${result.signer.name || result.signer.email}`,
      );
    } catch {
      toast('Could not change the signature');
    }
  };

  return (
    <DocumentAgentProvider
      defaultOpen={typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches}
      config={{
        documentId: doc.id,
        getSnapshot: () => buildDocumentSnapshot({ ...doc, title: latest.current.title, content: latest.current.content }),
        onApplyEdits: async (edits: DocEditPayload) => {
          const clean = sanitizeCopy(edits.content);
          setContent(clean);
          setViewMode('edit');
          scheduleSave({ content: clean });
          // "Use Zak's signature instead" comes back as an edit naming a signer.
          await applySignerHint(edits.sender_signature_signer);
        },
        onApplyDraft: async (draft: DocDraftPayload) => {
          const cleanTitle = sanitizeCopy(draft.title);
          const cleanContent = sanitizeCopy(draft.content);
          setTitle(cleanTitle);
          setContent(cleanContent);
          setViewMode('edit');
          scheduleSave({ title: cleanTitle, content: cleanContent });
          if (draft.include_sender_signature && !doc.sender_signature_enabled) {
            const updated = await updateDocument(doc.id, { sender_signature_enabled: true }).catch(() => null);
            if (updated) onDocChange(updated);
          }
          await applySignerHint(draft.sender_signature_signer);
        },
      }}
    >
      <DocumentAgentLayout>
        <div>
          <TopBar
            title={title || 'Untitled document'}
            subtitle={`DOC-${String(doc.document_number).padStart(4, '0')}`}
            actions={
              <div className="flex items-center gap-2">
                <button onClick={() => navigate('/documents')} className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"><ArrowLeft className="h-4 w-4" /> Back</button>
                {!locked && (
                  <HoverTooltip label="Opens a preview first" description="You will see the exact email and signer before anything sends. Nothing goes out until you confirm."><button onClick={() => setSendOpen(true)} className="flex items-center gap-1.5 rounded-lg gradient-bg px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90"><Send className="h-4 w-4" /> {doc.status === 'draft' ? 'Send to sign' : 'Resend'}</button></HoverTooltip>
                )}
                <DocAgentToggleButton />
              </div>
            }
          />

          <div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-6 lg:flex-row print:block">
            {/* Document body: edit or preview */}
            <div className="min-w-0 flex-1 print:w-full">
              {/* Edit / Preview toolbar */}
              <div className="mb-3 flex items-center justify-between print:hidden">
                {editable ? (
                  <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 text-xs font-medium">
                    <button onClick={() => setViewMode('edit')} className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5', viewMode === 'edit' ? 'bg-brand-primary text-white' : 'text-gray-600 hover:text-gray-900')}><Pencil className="h-3.5 w-3.5" /> Edit</button>
                    <button onClick={() => setViewMode('preview')} className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5', viewMode === 'preview' ? 'bg-brand-primary text-white' : 'text-gray-600 hover:text-gray-900')}><Eye className="h-3.5 w-3.5" /> Preview</button>
                  </div>
                ) : (
                  <span className="text-xs font-medium text-gray-400">{doc.status === 'signed' ? 'Signed and locked, read only' : 'Read only'}</span>
                )}
                {editable && (
                  <span className="flex items-center gap-1.5 text-xs text-gray-400">
                    {saveStatus === 'saving' ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</> : saveStatus === 'saved' ? <><Check className="h-3.5 w-3.5 text-emerald-500" /> Saved</> : null}
                  </span>
                )}
              </div>

              {viewMode === 'edit' && editable ? (
                <div className="rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">
                  <input
                    value={title}
                    onChange={e => { setTitle(e.target.value); scheduleSave({ title: e.target.value }); }}
                    placeholder="Untitled document"
                    className="mb-3 w-full border-0 bg-transparent text-2xl font-bold text-gray-900 outline-none placeholder:text-gray-300"
                  />
                  <SimpleRichEditor
                    value={content}
                    onChange={v => { setContent(v); scheduleSave({ content: v }); }}
                    rows={22}
                    entityTags={false}
                    autoTagEntities={false}
                    richBlocks
                    placeholder="Write your document here, or use the AI assistant to draft it…"
                  />
                </div>
              ) : (
                <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-sm">
                  <h1 className="text-2xl font-bold text-gray-900">{title || 'Untitled document'}</h1>
                  <div className="mt-4 text-sm leading-relaxed text-gray-700 [&_ul]:list-disc [&_ul]:pl-5">
                    {content.trim() ? (
                      <RichAuditContent text={content} autoTagEntities={false} />
                    ) : (
                      <p className="italic text-gray-400">This document has no content yet. Switch to Edit or use the AI assistant.</p>
                    )}
                  </div>
                </div>
              )}

              {(doc.sender_signature_enabled || signature) && (
                <div className="mt-6 rounded-2xl border border-gray-100 bg-white p-6 shadow-sm print:border-0 print:shadow-none">
                  <DocumentSignatures
                    senderEnabled={doc.sender_signature_enabled}
                    sender={senderSignature}
                    recipient={signature}
                    senderName={senderSignature?.signer_name || user?.name || 'ECD Digital Strategy'}
                    recipientName={doc.recipient_name}
                  />
                </div>
              )}
            </div>

            {/* Sidebar */}
            <aside className="w-full shrink-0 space-y-4 lg:w-80 print:hidden">
              <div className="rounded-xl bg-white p-5 card-shadow">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900">Status</h3>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_LABELS[status].tone}`}>{STATUS_LABELS[status].label}</span>
                </div>
              </div>

              <div className="rounded-xl bg-white p-5 card-shadow">
                <h3 className="text-sm font-semibold text-gray-900">Recipient</h3>
                <input value={name} onChange={e => { setName(e.target.value); scheduleSave({ recipient_name: e.target.value }); }} disabled={locked} placeholder="Recipient name" className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50 focus:border-brand-primary focus:outline-none" />
                <input value={email} onChange={e => { setEmail(e.target.value); scheduleSave({ recipient_email: e.target.value }); }} disabled={locked} placeholder="recipient@example.com" className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50 focus:border-brand-primary focus:outline-none" />
              </div>

              <div className="rounded-xl bg-white p-5 card-shadow space-y-2">
                <h3 className="mb-1 text-sm font-semibold text-gray-900">Actions</h3>
                {!locked && (
                  <HoverTooltip label="Opens a preview first" description="You will see the exact email and signer before anything sends. Nothing goes out until you confirm." className="w-full"><button onClick={() => setSendOpen(true)} className="flex w-full items-center gap-2 rounded-lg gradient-bg px-3 py-2 text-sm font-semibold text-white hover:opacity-90"><Send className="h-4 w-4" /> {doc.status === 'draft' ? 'Send to sign' : 'Resend'}</button></HoverTooltip>
                )}
                {!locked && (
                  <button onClick={copyLink} className="flex w-full items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"><Copy className="h-4 w-4" /> Copy signing link</button>
                )}
                <button onClick={openRecipientView} className="flex w-full items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"><ExternalLink className="h-4 w-4" /> Open recipient view</button>
                <button onClick={downloadPdf} className="flex w-full items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"><Printer className="h-4 w-4" /> Download PDF</button>
                {doc.status !== 'signed' && doc.status !== 'void' && (
                  <button onClick={() => setVoidOpen(true)} className="flex w-full items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"><Ban className="h-4 w-4" /> Void</button>
                )}
                {doc.status === 'void' && (
                  <button onClick={async () => { const u = await reopenDocument(doc.id); onDocChange(u); void reload(); }} className="flex w-full items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"><RotateCcw className="h-4 w-4" /> Reopen</button>
                )}
              </div>

              <div className="rounded-xl bg-white p-5 card-shadow">
                <h3 className="text-sm font-semibold text-gray-900">Signatures</h3>
                <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm text-gray-700">
                  <BrandedCheckbox
                    className="mt-0.5"
                    checked={doc.sender_signature_enabled}
                    disabled={togglingSender || senderSignDisabled}
                    onChange={checked => toggleSenderSignature(checked)}
                    aria-label="Include a signature from us on this document"
                  />
                  <span>Include a signature from us</span>
                </label>
                {/* Its counterpart. An employment letter, a reference or any
                    statement we hand over has no second party to countersign,
                    and leaving the recipient column on made those documents
                    look permanently unfinished. */}
                <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-gray-700">
                  <BrandedCheckbox
                    className="mt-0.5"
                    checked={doc.recipient_signature_enabled !== false}
                    disabled={togglingRecipient || recipientToggleDisabled}
                    onChange={(checked: boolean) => toggleRecipientSignature(checked)}
                    aria-label="Ask the recipient to sign this document"
                  />
                  <span>
                    Ask the recipient to sign
                    {doc.recipient_signature_enabled === false && (
                      <span className="mt-0.5 block text-xs text-gray-400">
                        They will see the document without a signature box.
                      </span>
                    )}
                  </span>
                </label>
                {/* Who signs, so a document can go out under a colleague's name.
                    Changing it re-signs immediately: there is nothing to confirm,
                    and the preview beside it shows exactly what the recipient
                    will see. */}
                {doc.sender_signature_enabled && !senderSignDisabled && signers.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Signed by</p>
                    <Select value={selectedSignerId} onValueChange={applySigner} disabled={applyingSigner}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Choose who signs" />
                      </SelectTrigger>
                      <SelectContent>
                        {signers.map(s => (
                          <SelectItem key={s.id} value={s.id}>
                            <SelectItemText>{s.name || s.email}</SelectItemText>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {applyingSigner && (
                      <p className="mt-1.5 flex items-center gap-1 text-xs text-gray-400"><Loader2 className="h-3 w-3 animate-spin" /> Applying…</p>
                    )}
                  </div>
                )}
                {doc.status === 'signed' && !senderSignature && (
                  <p className="mt-2 text-xs text-gray-500">The recipient has signed. You can still add your countersignature below.</p>
                )}
                {doc.sender_signature_enabled && (
                  senderSignature ? (
                    <div className="mt-3">
                      <div className="rounded-lg border border-gray-200 bg-white p-2">
                        <img src={senderSignature.signature_image} alt="Signature" className="h-14 w-full object-contain" />
                      </div>
                      <p className="mt-1.5 text-xs text-gray-500">{senderSignature.signer_name}</p>
                      {!senderSignDisabled && (
                        <div className="mt-2 flex gap-2">
                          <button onClick={() => setSignOpen(true)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">Replace</button>
                          <button onClick={clearSenderSignature} className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" /> Remove</button>
                        </div>
                      )}
                    </div>
                  ) : !senderSignDisabled ? (
                    savedSig ? (
                      <div className="mt-3">
                        <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50/60 p-2">
                          <img src={savedSig.signature_image} alt="Your saved signature" className="h-12 w-full object-contain opacity-90" />
                        </div>
                        <button onClick={applySavedSignature} className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-brand-primary/30 bg-brand-primary/5 px-3 py-2 text-sm font-semibold text-brand-primary hover:bg-brand-primary/10"><PenLine className="h-4 w-4" /> Use my signature</button>
                        <button onClick={() => setSignOpen(true)} className="mt-1.5 w-full rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700">Draw a new one</button>
                      </div>
                    ) : (
                      <button onClick={() => setSignOpen(true)} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-brand-primary/30 bg-brand-primary/5 px-3 py-2 text-sm font-semibold text-brand-primary hover:bg-brand-primary/10"><PenLine className="h-4 w-4" /> Add your signature</button>
                    )
                  ) : (
                    <p className="mt-2 text-xs text-gray-400">Not signed.</p>
                  )
                )}
              </div>

              <div className="rounded-xl bg-white p-5 card-shadow">
                <h3 className="mb-3 text-sm font-semibold text-gray-900">Activity</h3>
                <DocumentActivityTimeline events={events} />
              </div>
            </aside>
          </div>

          {sendOpen && (
            <SendDocumentModal
              open={sendOpen}
              document={doc}
              onClose={() => setSendOpen(false)}
              onSent={result => { setSendOpen(false); toast(result.email_status === 'sent' ? 'Document emailed to the recipient' : 'Document is live. Email is not configured, copy the link and send it yourself.'); void reload(); }}
            />
          )}
          <SenderSignatureModal
            open={signOpen}
            defaultName={senderSignature?.signer_name || user?.name || ''}
            initialMeta={savedSig}
            onClose={() => setSignOpen(false)}
            onSave={saveSenderSignature}
          />
          <Modal open={voidOpen} title="Void this document?" onClose={() => setVoidOpen(false)} className="max-w-md">
            <div className="p-5">
              <p className="text-sm text-gray-700">Voiding stops the recipient from signing. You can reopen it later.</p>
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setVoidOpen(false)} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
                <button onClick={async () => { const u = await voidDocument(doc.id); onDocChange(u); setVoidOpen(false); void reload(); }} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700">Void document</button>
              </div>
            </div>
          </Modal>
        </div>
      </DocumentAgentLayout>
    </DocumentAgentProvider>
  );
}

export default function DocumentDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, loadError, reload, setData } = useDocumentData(id);

  if (loading) return <div className="p-8 text-sm text-gray-400">Loading…</div>;
  if (loadError || !data) return <div className="p-8 text-sm text-red-600">{loadError ?? 'Document not found'}</div>;

  return (
    <WorkspaceInner
      key={data.document.id}
      doc={data.document}
      events={data.events}
      signature={data.signature}
      senderSignature={data.senderSignature}
      reload={reload}
      onDocChange={d => setData(prev => (prev ? { ...prev, document: d } : prev))}
    />
  );
}
