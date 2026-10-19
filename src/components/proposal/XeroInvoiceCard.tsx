import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FileText, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { autoCodeXeroLines, createXeroDraftInvoice, listXeroServiceAccounts, xeroErrorMessage, xeroInvoiceUrl, type XeroServiceAccount } from '../../lib/xero';
import { updateProposalLineItem } from '../../lib/proposals-db';
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/select';
import XeroItemPicker, { useXeroItems } from './XeroItemPicker';
import { formatCurrency } from '../../lib/revenue-calculator';
import { useToast } from '../ui/Toast';
import type { Proposal, ProposalLineItem } from '../../lib/types';

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
  lineItems = [],
  onChanged,
}: {
  proposal: Proposal;
  lineItems?: ProposalLineItem[];
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
          {invoices.length === 0 && <UncodedLines proposalId={proposal.id} lineItems={lineItems} onChanged={onChanged} />}
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

const OLD_KEYS: Record<string, string> = { klaviyo: 'retention', sms: 'retention', ai_agents: 'retention', web_cro: 'website' };

/**
 * Priced lines with no revenue family yet, coded right here. Most proposals are
 * written freehand, so their lines reach signing uncoded; a signed proposal's
 * lines are locked except for this coding. The invoice also tries to code them
 * from their names first, so this is for the ones it could not place.
 */
function UncodedLines({
  proposalId,
  lineItems,
  onChanged,
}: {
  proposalId: string;
  lineItems: ProposalLineItem[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [families, setFamilies] = useState<XeroServiceAccount[]>([]);
  const { items } = useXeroItems();
  useEffect(() => {
    listXeroServiceAccounts().then(setFamilies).catch(() => setFamilies([]));
  }, []);
  const priced = (li: ProposalLineItem) => Number(li.one_time_price ?? 0) > 0 || Number(li.monthly_price ?? 0) > 0;
  const uncoded = lineItems.filter(li => priced(li) && !OLD_KEYS[li.xero_service_key ?? ''] && !families.some(f => f.service_key === li.xero_service_key));
  // What the automatic run found, shown on the card instead of a toast.
  const [autoNote, setAutoNote] = useState('');

  const autoPick = async (silent = false) => {
    setPicking(true);
    try {
      const r = await autoCodeXeroLines(proposalId);
      if (silent) {
        if (r.coded === 0) setAutoNote('Auto-pick could not place this with confidence. Pick it below.');
        else toast(`Picked the Xero account for ${r.coded === 1 ? 'the line' : `${r.coded} lines`}. Check it, then create the invoice.`);
        if (r.coded > 0) onChanged();
        return;
      }
      toast(
        r.coded === 0
          ? 'Could not place these with confidence. Pick them below.'
          : r.remaining > 0
            ? `Coded ${r.coded}. ${r.remaining} still need a pick.`
            : `Coded ${r.coded === 1 ? 'the line' : `all ${r.coded} lines`}. Check them, then create the invoice.`,
      );
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Auto-pick failed');
    } finally {
      setPicking(false);
    }
  };

  // Runs once by itself when the card opens with uncoded lines (Emil, Oct 19):
  // a person only steps in for what it cannot place.
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current || !families.length || !uncoded.length) return;
    tried.current = true;
    void autoPick(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [families.length, uncoded.length]);

  if (!families.length || !uncoded.length) return null;

  const save = async (li: ProposalLineItem, patch: Partial<ProposalLineItem>) => {
    try {
      await updateProposalLineItem(li.id, patch);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save that');
    }
  };

  return (
    <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50/60 p-2.5">
      <p className="text-[11px] font-semibold text-amber-800">
        {uncoded.length === 1 ? 'This line needs' : 'These lines need'} a Xero account before the invoice can be made
      </p>
      <button
        type="button"
        onClick={() => void autoPick()}
        disabled={picking}
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-50 disabled:opacity-50"
      >
        {picking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        {picking ? 'Picking...' : 'Auto-pick'}
      </button>
      {autoNote && <p className="mt-1.5 text-[11px] text-amber-700">{autoNote}</p>}
      <ul className="mt-2 space-y-2.5">
        {uncoded.map(li => (
          <li key={li.id}>
            <p className="text-xs font-medium text-gray-900">{li.name || 'Untitled line'}</p>
            <div className="mt-1 space-y-1.5">
              <Select value={li.xero_service_key ?? ''} onValueChange={key => void save(li, { xero_service_key: key })}>
                <SelectTrigger className="h-8 text-xs bg-white"><SelectValue placeholder="Revenue account" /></SelectTrigger>
                <SelectContent>
                  {families.map(f => (
                    <SelectItem key={f.service_key} value={f.service_key}>
                      <SelectItemText>{f.name}</SelectItemText>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {Number(li.one_time_price ?? 0) > 0 && (
                <XeroItemPicker size="sm" value={li.xero_item_one_time} items={items} placeholder="Xero Item, one-time" onChange={code => void save(li, { xero_item_one_time: code })} />
              )}
              {Number(li.monthly_price ?? 0) > 0 && (
                <XeroItemPicker size="sm" value={li.xero_item_monthly} items={items} placeholder="Xero Item, monthly" onChange={code => void save(li, { xero_item_monthly: code })} />
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
