import { useMemo, useRef, useState } from 'react';
import { ArrowDown, Check, PenLine } from 'lucide-react';
import PdfPages from './PdfPages';
import SignaturePad, { type SignaturePadHandle } from '../proposal/SignaturePad';
import Modal from '../ui/Modal';
import { FIELD_LABEL } from '../../lib/pdf-docs';
import { cn } from '../../lib/utils';
import type { PdfField } from '../../lib/types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const today = () => new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map(p => p[0]!.toUpperCase()).join('').slice(0, 3);

type Adopted = { name: string; email: string; signature: string; initials: string | null };

/**
 * The recipient's side of an uploaded PDF (2026-11-18): the pages with their fields, a "Next field" button that
 * walks them through every one (page 31, then 46...), their signature and initials set up once and placed with a
 * click, and "Finish" once every field is done. Fields for us show our signature, already in place.
 */
export default function PdfSigner({
  url,
  fields,
  recipientName,
  recipientEmail,
  sender,
  onSign,
}: {
  url: string;
  fields: PdfField[];
  recipientName: string;
  recipientEmail: string;
  sender: { name: string; signature_image: string; signed_at: string } | null;
  onSign: (a: Adopted) => Promise<void>;
}) {
  const mine = useMemo(() => fields.filter(f => f.role === 'recipient').sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x), [fields]);
  const needsInitials = mine.some(f => f.type === 'initials');
  const [adopted, setAdopted] = useState<Adopted | null>(null);
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [filled, setFilled] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<string | null>(null);

  const left = mine.filter(f => !filled.has(f.id));
  const fill = (id: string) => setFilled(s => new Set(s).add(id));

  const clickField = (f: PdfField) => {
    if (!adopted) {
      pending.current = f.id;
      setAdoptOpen(true);
      return;
    }
    if (filled.has(f.id)) {
      setFilled(s => {
        const n = new Set(s);
        n.delete(f.id);
        return n;
      });
    } else fill(f.id);
  };

  const next = () => {
    const f = left[0];
    if (!f) return;
    document.getElementById(`pdf-field-${f.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById(`pdf-field-${f.id}`)?.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 600, delay: 300 });
  };

  const finish = async () => {
    if (!adopted || left.length) return;
    setSubmitting(true);
    setError('');
    try {
      await onSign(adopted);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not submit your signature.');
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="sticky top-0 z-20 mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white/95 p-3 shadow-sm backdrop-blur">
        <p className="text-sm text-gray-700">
          {left.length ? (
            <>
              <span className="font-semibold">{mine.length - left.length} of {mine.length}</span> fields done
            </>
          ) : (
            <span className="font-semibold text-emerald-700">All {mine.length} fields done</span>
          )}
        </p>
        {!adopted && (
          <button type="button" onClick={() => setAdoptOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
            <PenLine className="h-4 w-4" /> Set up your signature
          </button>
        )}
        {left.length > 0 && (
          <button type="button" onClick={next} className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-600">
            <ArrowDown className="h-4 w-4" /> Next field (page {left[0].page})
          </button>
        )}
        <button type="button" onClick={() => void finish()} disabled={!adopted || left.length > 0 || submitting} className="ml-auto rounded-lg bg-brand-primary px-4 py-1.5 text-sm font-semibold text-white hover:bg-brand-primary-dark disabled:opacity-40">
          {submitting ? 'Signing…' : 'Finish and sign'}
        </button>
        {error && <p className="w-full rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
      </div>

      <PdfPages
        url={url}
        renderOverlay={page => (
          <div className="absolute inset-0">
            {fields.filter(f => f.page === page).map(f => {
              const style = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
              if (f.role === 'sender') return <Filled key={f.id} field={f} style={style} name={sender?.name ?? ''} signature={sender?.signature_image ?? null} date={sender ? new Date(sender.signed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''} />;
              const done = filled.has(f.id) && adopted;
              return done ? (
                <button key={f.id} id={`pdf-field-${f.id}`} type="button" onClick={() => clickField(f)} title="Click to clear" className="absolute" style={style}>
                  <Filled field={f} style={{ inset: 0 }} name={adopted.name} signature={f.type === 'initials' ? adopted.initials : adopted.signature} date={today()} />
                </button>
              ) : (
                <button
                  key={f.id}
                  id={`pdf-field-${f.id}`}
                  type="button"
                  onClick={() => clickField(f)}
                  className="absolute flex items-center justify-center rounded border-2 border-amber-500 bg-amber-100/80 text-[11px] font-semibold text-amber-900 hover:bg-amber-200/90"
                  style={style}
                >
                  {f.type === 'signature' || f.type === 'initials' ? `Click to ${f.type === 'signature' ? 'sign' : 'initial'}` : FIELD_LABEL[f.type]}
                </button>
              );
            })}
          </div>
        )}
      />

      <AdoptModal
        open={adoptOpen}
        needsInitials={needsInitials}
        defaultName={adopted?.name ?? recipientName}
        defaultEmail={adopted?.email ?? recipientEmail}
        onClose={() => setAdoptOpen(false)}
        onAdopt={a => {
          setAdopted(a);
          setAdoptOpen(false);
          if (pending.current) fill(pending.current);
          pending.current = null;
        }}
      />
    </div>
  );
}

function Filled({ field: f, style, name, signature, date }: { field: PdfField; style: React.CSSProperties; name: string; signature: string | null; date: string }) {
  const img = f.type === 'signature' || f.type === 'initials' ? signature : null;
  return (
    <div className="absolute flex items-center justify-center overflow-hidden" style={style}>
      {img ? (
        <img src={img} alt="" className="h-full w-full object-contain" />
      ) : (
        <span className={cn('w-full truncate px-0.5 text-gray-900', f.type === 'initials' && 'text-center italic')} style={{ fontSize: 'clamp(8px, 1.4vw, 14px)' }}>
          {f.type === 'date' ? date : f.type === 'initials' ? initialsOf(name) : name}
        </span>
      )}
    </div>
  );
}

function AdoptModal({
  open,
  needsInitials,
  defaultName,
  defaultEmail,
  onClose,
  onAdopt,
}: {
  open: boolean;
  needsInitials: boolean;
  defaultName: string;
  defaultEmail: string;
  onClose: () => void;
  onAdopt: (a: Adopted) => void;
}) {
  const sigRef = useRef<SignaturePadHandle>(null);
  const iniRef = useRef<SignaturePadHandle>(null);
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(defaultEmail);
  const [sigEmpty, setSigEmpty] = useState(true);
  const [iniEmpty, setIniEmpty] = useState(true);
  const [error, setError] = useState('');

  const adopt = () => {
    setError('');
    if (!name.trim()) return setError('Please enter your full name.');
    if (!EMAIL_RE.test(email.trim())) return setError('Please enter a valid email.');
    const signature = sigRef.current?.toDataURL();
    if (!signature) return setError('Please add your signature.');
    const initials = needsInitials ? iniRef.current?.toDataURL() ?? null : null;
    if (needsInitials && !initials) return setError('Please add your initials.');
    onAdopt({ name: name.trim(), email: email.trim(), signature, initials });
  };

  return (
    <Modal open={open} title="Your signature" onClose={onClose} className="max-w-lg">
      <div className="space-y-3 p-5">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Full name" className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none" />
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none" />
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-gray-600">Signature</p>
          <SignaturePad ref={sigRef} onChange={setSigEmpty} typedName={name} />
        </div>
        {needsInitials && (
          <div>
            <p className="mb-1 text-xs font-medium text-gray-600">Initials</p>
            <SignaturePad ref={iniRef} onChange={setIniEmpty} typedName={initialsOf(name)} height={110} />
          </div>
        )}
        <p className="text-[11px] text-gray-500">By clicking Use this signature, you agree it will be placed on every field marked for you, as your electronic signature.</p>
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
          <button type="button" onClick={adopt} disabled={sigEmpty || (needsInitials && iniEmpty)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:bg-brand-primary-dark disabled:opacity-50">
            <Check className="h-4 w-4" /> Use this signature
          </button>
        </div>
      </div>
    </Modal>
  );
}
