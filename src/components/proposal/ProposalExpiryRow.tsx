import { useState } from 'react';
import { CalendarClock, Check, Loader2, X } from 'lucide-react';
import HoverTooltip from '../ui/HoverTooltip';
import DatePicker from '../ui/DatePicker';
import { useToast } from '../ui/Toast';
import { extendProposalValidity } from '../../lib/proposals-db';
import {
  describeProposalExpiry,
  proposalExpiryLabel,
  proposalExpiryTooltip,
} from '../../lib/proposal-status';
import type { Proposal } from '../../lib/types';
import { addDaysToDate, businessDate } from '../../lib/valid-until';

/** Add days to today in New York, as a YYYY-MM-DD date (valid_until is a DATE column on the New York clock). */
function datePlusDays(days: number): string {
  return addDaysToDate(businessDate(), days);
}

/**
 * The expiry countdown plus an inline way to move the date for THIS proposal.
 *
 * The global window (Settings > Proposals) decides the default; this only
 * overrides one proposal, which is also how a lapsed proposal gets revived,
 * since "expired" is derived from valid_until rather than stored.
 */
export default function ProposalExpiryRow({
  proposal,
  validDays,
  onExtended,
}: {
  proposal: Proposal;
  validDays: number;
  onExtended: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const expiry = describeProposalExpiry(proposal);
  const label = proposalExpiryLabel(expiry);
  const tone =
    expiry.state === 'expired'
      ? 'text-red-600'
      : expiry.state === 'active' && expiry.daysLeft <= 3
      ? 'text-amber-600'
      : expiry.state === 'not_started'
      ? 'text-gray-400'
      : 'text-gray-700';

  const startEditing = () => {
    // Default the picker to the current date, or a fresh window when the clock
    // has not started yet.
    setDraft(proposal.valid_until ?? datePlusDays(validDays));
    setEditing(true);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await extendProposalValidity(proposal.id, draft);
      toast('Expiry updated');
      setEditing(false);
      onExtended();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update the expiry');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="flex items-center justify-end gap-1.5">
        <DatePicker
          value={draft}
          onChange={setDraft}
          ariaLabel="Expiry date for this proposal"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving || !draft}
          title="Save expiry"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg gradient-bg text-white disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={saving}
          title="Cancel"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      <HoverTooltip align="end" label={label} description={proposalExpiryTooltip(expiry, validDays)}>
        <span className={`cursor-default text-sm font-medium ${tone}`}>{label}</span>
      </HoverTooltip>
      <button
        type="button"
        onClick={startEditing}
        title="Change the expiry for this proposal"
        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 text-gray-400 hover:bg-gray-50 hover:text-gray-600"
      >
        <CalendarClock className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
