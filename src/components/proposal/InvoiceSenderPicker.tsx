import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { listInvoiceSenders, type InvoiceSender } from '../../lib/invoice-sending';
import { getProposalSettings, updateProposal } from '../../lib/proposals-db';
import { useToast } from '../ui/Toast';
import type { Proposal } from '../../lib/types';

/**
 * "Invoice sent by" on a proposal (Emil, 2026-11-02): whose Gmail the client's
 * invoice comes from when they sign, so it is someone they know. Defaults to
 * whoever sent the proposal. Only shown while invoice emails are switched on in
 * Proposal settings, and until the invoice has gone out.
 */
export default function InvoiceSenderPicker({ proposal, onChanged }: { proposal: Proposal; onChanged: () => void }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(false);
  const [senders, setSenders] = useState<InvoiceSender[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getProposalSettings().then(s => setEnabled(s.invoicing.auto_send), () => setEnabled(false));
    listInvoiceSenders().then(setSenders, () => setSenders([]));
  }, []);

  const alreadyEmailed = (proposal.xero_invoices ?? []).some(i => i.kind === 'one_time' && i.emailed_at);
  if (!enabled || senders === null || alreadyEmailed) return null;

  const defaultId = proposal.sent_by ?? proposal.created_by;
  const effective = proposal.invoice_sender_id ?? defaultId;
  const connected = senders.some(s => s.user_id === effective);
  const defaultSender = senders.find(s => s.user_id === defaultId);

  const pick = async (value: string) => {
    setSaving(true);
    try {
      await updateProposal(proposal.id, { invoice_sender_id: value || null });
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
      <select
        value={proposal.invoice_sender_id ?? ''}
        disabled={saving}
        onChange={e => void pick(e.target.value)}
        className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-800"
      >
        <option value="">{defaultSender ? `${defaultSender.name} (sent the proposal)` : 'Whoever sent the proposal'}</option>
        {senders.filter(s => s.user_id !== defaultId).map(s => (
          <option key={s.user_id} value={s.user_id}>{s.name}</option>
        ))}
      </select>
      <p className={`mt-1.5 text-[11px] ${connected ? 'text-gray-400' : 'text-amber-700'}`}>
        {connected
          ? 'The client gets the invoice from this Gmail when they sign, with the usual people copied.'
          : "This person hasn't connected their Gmail, so the payment link will go to them to forward instead."}
      </p>
    </div>
  );
}
