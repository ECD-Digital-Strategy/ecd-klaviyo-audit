import type { Proposal, ProposalDisplayStatus, ProposalSignature } from './types';
import { businessDate, dateDiffDays, isPastValidUntil, validUntilCutoff } from './valid-until';

export const PROPOSAL_STATUS_LABELS: Record<ProposalDisplayStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  won: 'Won',
  lost: 'Lost',
  expired: 'Expired',
};

/**
 * Display status for a proposal. 'expired' is derived from valid_until and is
 * never written to the database, so extending validity un-expires a proposal.
 */
export function deriveProposalStatus(
  proposal: Pick<Proposal, 'status' | 'valid_until'>,
  now: Date = new Date(),
): ProposalDisplayStatus {
  // Same clock as the server: the end of the valid_until day in New York (valid-until.ts).
  if ((proposal.status === 'sent' || proposal.status === 'viewed') && isPastValidUntil(proposal.valid_until, now)) {
    return 'expired';
  }
  return proposal.status;
}

/** True once any client has signed, even when a second signer is still to sign. client_signed_at only lands
 * when every signer has signed, but the content, pricing and contracts freeze at the FIRST client signature
 * (the database enforces it too), so every edit gate keys off this. */
export function hasClientSignature(
  proposal: Pick<Proposal, 'client_signed_at'>,
  signatures: Pick<ProposalSignature, 'role'>[] | null | undefined,
): boolean {
  return Boolean(proposal.client_signed_at) || (signatures ?? []).some(s => s.role === 'client');
}

/** Open proposals count toward pipeline value. */
export function isProposalOpen(proposal: Pick<Proposal, 'status' | 'valid_until'>): boolean {
  const status = deriveProposalStatus(proposal);
  return status === 'sent' || status === 'viewed';
}

// ---------------------------------------------------------------------------
// Expiry
//
// One global window, set in Settings > Proposals ("Proposal valid for (days)").
// It is not per service line and not per template. The clock starts on the
// client's FIRST VIEW, so valid_until stays null until then, and a proposal that
// was never opened never expires.
//
// valid_until is a DATE, so the deadline is the END of that day in New York
// (ECD bills from there). There is no meaningful time-of-day to show, and the
// hourly job that marks expired proposals lost compares the same way.

export type ProposalExpiry =
  | { state: 'not_started' }
  | { state: 'no_expiry' }
  | { state: 'active'; daysLeft: number; endOfDay: Date; validUntil: string }
  | { state: 'expired'; daysAgo: number; endOfDay: Date; validUntil: string };

/** The actual cutoff: midnight in New York after the valid_until day. */
export function proposalExpiryMoment(validUntil: string | null | undefined): Date | null {
  return validUntilCutoff(validUntil);
}

export function describeProposalExpiry(
  proposal: Pick<Proposal, 'status' | 'valid_until'>,
  now: Date = new Date(),
): ProposalExpiry {
  // Closed proposals have no live countdown.
  if (proposal.status === 'won' || proposal.status === 'lost') return { state: 'no_expiry' };
  const endOfDay = proposalExpiryMoment(proposal.valid_until);
  // The client has not opened it, so the window has not begun.
  if (!endOfDay || !proposal.valid_until) return { state: 'not_started' };
  const validUntil = proposal.valid_until.slice(0, 10);
  // Whole calendar days, counted on New York dates. Counting to the cutoff
  // instead would make "valid until 31 Aug", seen on 1 Aug, read as "in 31 days"
  // when the promise was 30.
  const today = businessDate(now);
  // Expiry lands at the end of the day, so once lapsed it is always at least
  // the following calendar day.
  if (endOfDay.getTime() <= now.getTime()) {
    return { state: 'expired', daysAgo: Math.max(1, dateDiffDays(validUntil, today)), endOfDay, validUntil };
  }
  return { state: 'active', daysLeft: Math.max(0, dateDiffDays(today, validUntil)), endOfDay, validUntil };
}

/** Short label for the Expires column. */
export function proposalExpiryLabel(expiry: ProposalExpiry): string {
  switch (expiry.state) {
    case 'not_started':
      return 'Starts when opened';
    case 'no_expiry':
      return '—';
    case 'expired':
      return expiry.daysAgo === 1 ? 'Expired yesterday' : `Expired ${expiry.daysAgo} days ago`;
    case 'active':
      if (expiry.daysLeft === 0) return 'Today';
      if (expiry.daysLeft === 1) return 'Tomorrow';
      return `in ${expiry.daysLeft} days`;
  }
}

/** Full sentence for the tooltip. States end-of-day rather than a fake time. */
export function proposalExpiryTooltip(expiry: ProposalExpiry, validDays: number): string {
  // Formats the valid_until date itself, so a viewer outside New York still sees the right day.
  const fmt = (date: string) => {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  };
  switch (expiry.state) {
    case 'not_started':
      return `The ${validDays}-day window starts when the client first opens the proposal, so there is no expiry date yet.`;
    case 'no_expiry':
      return 'This proposal is closed, so it no longer expires.';
    case 'expired':
      return `Expired at the end of ${fmt(expiry.validUntil)} (New York time). Expired proposals are marked lost automatically.`;
    case 'active':
      return `Valid until the end of ${fmt(expiry.validUntil)}, New York time (${validDays} days from the client's first view).`;
  }
}
