import { useState } from 'react';
import { ExternalLink, FileText, Loader2, RefreshCw } from 'lucide-react';
import { createXeroDraftInvoice, xeroErrorMessage, xeroInvoiceUrl } from '../../lib/xero';
import { formatCurrency } from '../../lib/revenue-calculator';
import { useToast } from '../ui/Toast';
import type { Proposal } from '../../lib/types';

const KIND_LABEL = { one_time: 'Implementation', monthly: 'First month of the retainer' } as const;

const day = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * The Xero draft invoices for a signed proposal: the implementation and the
 * first month of a retainer are separate drafts. Links each, and retries
 * whatever is missing after a failure.
 */
export default function XeroInvoiceCard({
  proposal,
  onChanged,
}: {
  proposal: Proposal;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await createXeroDraftInvoice(proposal.id);
      toast('Draft invoice created in Xero');
      onChanged();
    } catch (e) {
      toast(xeroErrorMessage(e instanceof Error ? e.message : null).message);
    } finally {
      setBusy(false);
    }
  };

  // One invoice made before invoices were split by kind shows as before.
  const invoices = proposal.xero_invoices?.length
    ? proposal.xero_invoices
    : proposal.xero_invoice_id
      ? [{ kind: 'one_time' as const, id: proposal.xero_invoice_id, number: proposal.xero_invoice_number ?? '', date: '', due_date: '', total: 0 }]
      : [];
  const failure = proposal.xero_invoice_error ? xeroErrorMessage(proposal.xero_invoice_error) : null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-gray-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Xero</h3>
      </div>

      {invoices.length > 0 && (
        <ul className="mt-3 space-y-3">
          {invoices.map(inv => (
            <li key={inv.id}>
              <p className="text-sm font-medium text-gray-900">
                {invoices.length > 1 || inv.kind === 'monthly' ? `${KIND_LABEL[inv.kind]}: ` : ''}
                draft {inv.number ? `#${inv.number}` : 'created'}
              </p>
              {inv.date && (
                <p className="text-[11px] text-gray-400">
                  {inv.total ? `${formatCurrency(inv.total)} · ` : ''}dated {day(inv.date)}
                  {inv.due_date && inv.due_date !== inv.date ? `, due ${day(inv.due_date)}` : ', due on receipt'}
                </p>
              )}
              <a
                href={xeroInvoiceUrl(inv.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
              >
                Open in Xero <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </li>
          ))}
          <li className="text-[11px] text-gray-400">
            Drafts, so nothing has been emailed to the client. Approve and send them from Xero.
            {invoices.some(i => i.kind === 'monthly') ? ' The retainer\'s repeating invoice is set up in Xero from the first month.' : ''}
          </li>
        </ul>
      )}

      {(invoices.length === 0 || failure) && (
        <div className="mt-2">
          {failure ? (
            <div className="rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
              <p>
                <span className="font-semibold">Last attempt failed.</span> {failure.message}
              </p>
              {/* Xero's raw reply, kept for whoever has to dig in. */}
              {failure.detail && (
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-amber-700/80 hover:text-amber-900">Technical details</summary>
                  <p className="mt-1 break-all font-mono text-[10px] text-amber-700/80">{failure.detail}</p>
                </details>
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-500">No draft invoice yet.</p>
          )}
          <button
            type="button"
            onClick={create}
            disabled={busy}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {proposal.xero_invoice_error ? 'Try again' : 'Create draft invoice'}
          </button>
        </div>
      )}
    </div>
  );
}
