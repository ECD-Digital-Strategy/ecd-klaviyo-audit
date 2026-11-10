import { useEffect, useState } from 'react';
import { Check, Loader2, PenLine } from 'lucide-react';
import {
  countersignProposal,
  listStaffSigners,
  saveMySignature,
  DEFAULT_SIGNER_EMAIL,
  type StaffSigner,
} from '../../lib/proposals-db';
import { resolveSignatureImage } from '../../lib/signature-image';
import type { ProposalSignature } from '../../lib/types';
import SignaturePad, { type SignaturePadHandle } from './SignaturePad';
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/select';
import { useRef } from 'react';

/** Who signed for ECD, with the option to sign as someone else. Proposals are
 * signed automatically on creation, so this normally just reports the state and
 * offers a swap; it also covers the case where auto-signing failed. */
export default function AgencySignatureCard({
  proposalId,
  signature,
  clientHasSigned,
  currentUserId,
  canSignForOthers = false,
  onChanged,
}: {
  proposalId: string;
  signature: ProposalSignature | null;
  /** Once the client signs, the executed document stops changing. */
  clientHasSigned: boolean;
  currentUserId: string | null;
  /** Admins can sign as anyone. Others sign as themselves, or as the default
   * signer when ECD has not signed yet (proposal_countersign enforces the same). */
  canSignForOthers?: boolean;
  onChanged: () => void;
}) {
  const [signers, setSigners] = useState<StaffSigner[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drawing, setDrawing] = useState(false);
  const [padEmpty, setPadEmpty] = useState(true);
  const padRef = useRef<SignaturePadHandle>(null);

  const signedById = signature?.signer_user_id ?? null;
  const hasSignature = Boolean(signature);

  useEffect(() => {
    let cancelled = false;
    listStaffSigners()
      .then(all => {
        if (cancelled) return;
        const rows = canSignForOthers
          ? all
          : all.filter(r =>
              r.id === currentUserId ||
              r.id === signedById ||
              (!hasSignature && r.email.toLowerCase() === DEFAULT_SIGNER_EMAIL));
        setSigners(rows);
        const current =
          rows.find(r => r.id === signedById) ??
          rows.find(r => r.email.toLowerCase() === DEFAULT_SIGNER_EMAIL) ??
          rows[0];
        setSelectedId(current?.id ?? '');
      })
      .catch(() => { /* the card degrades to read-only */ });
    return () => { cancelled = true; };
  }, [signedById, hasSignature, canSignForOthers, currentUserId]);

  const selected = signers.find(s => s.id === selectedId) ?? null;
  const changed = Boolean(signature) && signature?.signer_user_id !== selectedId;
  const signingSelf = Boolean(currentUserId) && selectedId === currentUserId;

  const apply = async () => {
    if (!selected) return;
    setError('');
    setBusy(true);
    try {
      let image: string | null = null;
      if (drawing) {
        image = padRef.current?.toDataURL() ?? null;
        // A drawn signature is only ever saved to the drawer's own profile, so
        // nobody can store a signature under a colleague's name.
        if (image && signingSelf) await saveMySignature(image);
      }
      if (!image) image = resolveSignatureImage(selected);
      if (!image) throw new Error('Could not produce a signature image');
      await countersignProposal({
        proposal_id: proposalId,
        typed_name: selected.name,
        signature_image: image,
        signer_user_id: selected.id,
        replace: Boolean(signature),
      });
      setDrawing(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign the proposal');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-2">
        <PenLine className="h-3.5 w-3.5 text-gray-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Signed by ECD</h3>
      </div>

      {signature ? (
        <div className="mt-3">
          <img
            src={signature.signature_image}
            alt={`Signature of ${signature.signer_name}`}
            className="h-12 w-auto max-w-full object-contain"
          />
          <p className="mt-1 text-sm font-medium text-gray-900">{signature.signer_name}</p>
          <p className="text-[11px] text-gray-400">
            {new Date(signature.signed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-gray-500">Not signed yet. Sign before sending so the client gets an executed contract.</p>
      )}

      {clientHasSigned ? (
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-emerald-600">
          <Check className="h-3 w-3" /> The client has signed, so this is locked.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          <p className="text-[11px] font-medium text-gray-500">Sign as</p>
          <Select value={selectedId} onValueChange={setSelectedId} disabled={busy}>
            <SelectTrigger className="h-9 text-sm">
              <SelectValue placeholder="Choose a signer" />
            </SelectTrigger>
            <SelectContent>
              {signers.map(s => (
                <SelectItem key={s.id} value={s.id}>
                  <SelectItemText>{s.name || s.email}</SelectItemText>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {drawing && (
            <div>
              <SignaturePad
                ref={padRef}
                height={110}
                typedName={selected?.name ?? ''}
                onChange={empty => setPadEmpty(empty)}
              />
              <div className="mt-1 flex items-center justify-between text-[11px]">
                <button type="button" className="text-gray-500 hover:text-gray-800" onClick={() => padRef.current?.clear()}>
                  Clear
                </button>
                <button type="button" className="text-gray-500 hover:text-gray-800" onClick={() => { setDrawing(false); setPadEmpty(true); }}>
                  Cancel drawing
                </button>
              </div>
              {signingSelf && (
                <p className="mt-1 text-[11px] text-gray-400">Saved to your profile and reused on future proposals.</p>
              )}
            </div>
          )}

          {error && <p className="text-[11px] text-red-600">{error}</p>}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={apply}
              disabled={busy || !selected || (drawing && padEmpty) || (!changed && !drawing && Boolean(signature))}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg gradient-bg px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <PenLine className="h-3 w-3" />}
              {signature ? 'Update signature' : 'Sign now'}
            </button>
            {!drawing && (
              <button
                type="button"
                onClick={() => setDrawing(true)}
                disabled={busy}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                Draw
              </button>
            )}
          </div>
          <p className="text-[11px] text-gray-400">Signing here never emails anyone.</p>
        </div>
      )}
    </div>
  );
}
