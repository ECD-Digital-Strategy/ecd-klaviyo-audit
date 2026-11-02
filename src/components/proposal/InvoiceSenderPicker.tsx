import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Mail } from 'lucide-react';
import { listInvoiceSenders, type InvoiceSender } from '../../lib/invoice-sending';
import { getProposalSettings, updateProposal } from '../../lib/proposals-db';
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/select';
import { useToast } from '../ui/Toast';
import type { Proposal } from '../../lib/types';

/** Radix Select needs a non-empty value for "whoever created the proposal". */
const DEFAULT = '__sender__';

/**
 * "Invoice sent by" on a proposal (Emil, 2026-11-02): whose Gmail the client's
 * invoice comes from when they sign. Defaults to whoever created the proposal
 * (agreed with Isa); if their Gmail isn't connected it comes from the fallback
 * sender (Xiomara) with an intro email. Only shown while invoice emails are
 * switched on in Proposal settings, and until the invoice has gone out.
 */
export default function InvoiceSenderPicker({ proposal, onChanged }: { proposal: Proposal; onChanged: () => void }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(false);
  const [fallbackEmail, setFallbackEmail] = useState('');
  const [senders, setSenders] = useState<InvoiceSender[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getProposalSettings().then(s => {
      setEnabled(s.invoicing.auto_send);
      setFallbackEmail(s.invoicing.fallback_sender_email);
    }, () => setEnabled(false));
    listInvoiceSenders().then(setSenders, () => setSenders([]));
  }, []);

  const alreadyEmailed = (proposal.xero_invoices ?? []).some(i => i.kind === 'one_time' && i.emailed_at);
  if (!enabled || senders === null || alreadyEmailed) return null;

  const defaultId = proposal.created_by ?? proposal.sent_by;
  const effective = proposal.invoice_sender_id ?? defaultId;
  const chosen = senders.find(s => s.user_id === effective);
  const defaultSender = senders.find(s => s.user_id === defaultId);
  const fallback = senders.find(s => s.email.toLowerCase() === fallbackEmail.toLowerCase());

  const pick = async (value: string) => {
    setSaving(true);
    try {
      await updateProposal(proposal.id, { invoice_sender_id: value === DEFAULT ? null : value });
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-2">
        <Mail className="h-3.5 w-3.5 text-gray-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Invoice sent by</h3>
      </div>
      <Select value={proposal.invoice_sender_id ?? DEFAULT} onValueChange={v => void pick(v)} disabled={saving}>
        <SelectTrigger className="mt-2 h-9 w-full text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT}>
            <SelectItemText>{defaultSender ? `${defaultSender.name} (created the proposal)` : 'Whoever created the proposal'}</SelectItemText>
          </SelectItem>
          {senders.filter(s => s.user_id !== defaultId).map(s => (
            <SelectItem key={s.user_id} value={s.user_id}>
              <SelectItemText>{s.name}</SelectItemText>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {chosen ? (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-gray-500">
          <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-600" />
          The client gets the invoice from {chosen.email} when they sign, with the usual people copied.
        </p>
      ) : fallback ? (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-gray-500">
          <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-600" />
          This person hasn&apos;t connected their Gmail, so it comes from {fallback.name} ({fallback.email}) with the intro email.
        </p>
      ) : (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-700">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          Neither this person nor the fallback sender has connected their Gmail, so the payment link will go to the sender to forward.
        </p>
      )}
    </div>
  );
}
