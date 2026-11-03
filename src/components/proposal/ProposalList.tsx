import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { rowNavProps } from '../../lib/row-nav';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  FileSignature,
  Search,
  Filter,
  Trash2,
  MoreVertical,
  Send,
  Link2,
  Printer,
  Trophy,
  XCircle,
} from 'lucide-react';
import StatusBadge from '../ui/StatusBadge';
import SiteFavicon from '../ui/SiteFavicon';
import EmptyState from '../ui/EmptyState';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/select';
import { useAuth } from '../../contexts/AuthContext';
import SendProposalModal from './SendProposalModal';
import {
  deleteProposal,
  getProposal,
  getProposalSettings,
  markProposalLost,
  markProposalSent,
  markProposalWon,
} from '../../lib/proposals-db';
import {
  deriveProposalStatus,
  describeProposalExpiry,
  PROPOSAL_STATUS_LABELS,
  proposalExpiryLabel,
  proposalExpiryTooltip,
} from '../../lib/proposal-status';
import HoverTooltip from '../ui/HoverTooltip';
import { computeProposalTotals, formatProposalTotal, proposalDiscountFromRow } from '../../lib/proposal-pricing';
import { formatCurrency } from '../../lib/revenue-calculator';
import { publicProposalOrigin } from '../../lib/public-origin';
import type { Proposal, ProposalDisplayStatus } from '../../lib/types';

const FILTERABLE_STATUSES: ProposalDisplayStatus[] = ['draft', 'sent', 'viewed', 'won', 'lost', 'expired'];

function isClosedProposal(proposal: Proposal): boolean {
  return proposal.status === 'won' || proposal.status === 'lost';
}

/**
 * The Value cell: the one-time total on top and the monthly total under it, so
 * the column stays narrow (2026-11-03: "See line items + See items/mo" on one
 * line pushed the table wider than the card). Lines priced only by a label
 * ("from $X") read "See line items", once.
 */
function proposalValueSummary(proposal: Proposal): { main: string; sub: string | null } {
  const items = proposal.line_items ?? [];
  if (items.length === 0) return { main: '—', sub: null };
  const totals = computeProposalTotals(items, proposalDiscountFromRow(proposal));
  const oneTime = totals.oneTimeTotal > 0 || totals.oneTimeHasLabelOnly
    ? formatProposalTotal(totals.oneTimeTotal, totals.oneTimeHasLabelOnly)
    : null;
  const monthly = totals.monthlyTotal > 0
    ? `${formatCurrency(totals.monthlyTotal)}/mo`
    : totals.monthlyHasLabelOnly
      ? 'monthly, see line items'
      : null;
  if (oneTime === 'See line items' && monthly === 'monthly, see line items') return { main: 'See line items', sub: 'one-time and monthly' };
  if (oneTime && monthly) return { main: oneTime, sub: `+ ${monthly}` };
  if (oneTime) return { main: oneTime, sub: null };
  if (monthly) return { main: monthly === 'monthly, see line items' ? 'See line items' : monthly, sub: monthly === 'monthly, see line items' ? 'monthly' : null };
  return { main: '—', sub: null };
}

/** Countdown to expiry, with the exact end-of-day date in a branded tooltip.
 * valid_until is a DATE, so there is no time of day to show. */
function ProposalExpiryCell({ proposal, validDays }: { proposal: Proposal; validDays: number }) {
  const expiry = describeProposalExpiry(proposal);
  const label = proposalExpiryLabel(expiry);
  const tone =
    expiry.state === 'expired'
      ? 'text-red-600'
      : expiry.state === 'active' && expiry.daysLeft <= 3
      ? 'text-amber-600'
      : expiry.state === 'not_started'
      ? 'text-gray-400'
      : 'text-gray-600';
  return (
    <HoverTooltip
      align="start"
      label={label}
      description={proposalExpiryTooltip(expiry, validDays)}
    >
      <span className={`cursor-default whitespace-nowrap text-xs font-medium ${tone}`}>{label}</span>
    </HoverTooltip>
  );
}

type ProposalListProps = {
  proposals: Proposal[];
  onDeleted: (id: string) => void;
  onUpdated?: (proposal: Proposal) => void;
  emptyAction?: React.ReactNode;
};

export default function ProposalList({ proposals, onDeleted, onUpdated, emptyAction }: ProposalListProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const { hasRole } = useAuth();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('__all__');
  const [deletingProposal, setDeletingProposal] = useState<Proposal | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ proposal: Proposal; buttonTop: number; buttonBottom: number; right: number } | null>(null);
  const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [sendProposal, setSendProposal] = useState<Proposal | null>(null);
  const [linkBusyId, setLinkBusyId] = useState<string | null>(null);
  const [actionTarget, setActionTarget] = useState<{ proposal: Proposal; action: 'won' | 'lost' } | null>(null);
  const [lostReason, setLostReason] = useState('');
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState('');
  const [validDays, setValidDays] = useState(30);

  useEffect(() => {
    let cancelled = false;
    getProposalSettings()
      .then(s => { if (!cancelled) setValidDays(s.defaults.valid_days || 30); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const patch = (updated: Proposal) => onUpdated?.(updated);

  useEffect(() => {
    if (!menuAnchor) return;
    const close = () => setMenuAnchor(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menuAnchor]);

  useLayoutEffect(() => {
    if (!menuAnchor) {
      setMenuPos(null);
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const height = el.getBoundingClientRect().height;
    const spaceBelow = window.innerHeight - menuAnchor.buttonBottom - 8;
    const spaceAbove = menuAnchor.buttonTop - 8;
    if (height > spaceBelow && spaceAbove > spaceBelow) {
      setMenuPos({ bottom: window.innerHeight - menuAnchor.buttonTop + 4, right: menuAnchor.right });
    } else {
      setMenuPos({ top: menuAnchor.buttonBottom + 4, right: menuAnchor.right });
    }
  }, [menuAnchor]);

  const copyLink = async (proposal: Proposal) => {
    setLinkBusyId(proposal.id);
    try {
      const updated = proposal.public_token ? proposal : await markProposalSent(proposal);
      const url = `${publicProposalOrigin()}/proposal/${updated.public_token}`;
      await navigator.clipboard.writeText(url);
      toast(
        proposal.public_token ? 'Link copied.' : 'Link copied. The countdown starts when the client opens it.',
      );
      if (!proposal.public_token) patch(updated);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to copy link');
    } finally {
      setLinkBusyId(null);
    }
  };

  const runAction = async () => {
    if (!actionTarget) return;
    setActing(true);
    setActionError('');
    try {
      const updated =
        actionTarget.action === 'won'
          ? await markProposalWon(actionTarget.proposal.id)
          : await markProposalLost(actionTarget.proposal.id, lostReason.trim() || null);
      patch(updated);
      setActionTarget(null);
      setLostReason('');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to update proposal');
    } finally {
      setActing(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return proposals.filter(p => {
      const displayStatus = deriveProposalStatus(p);
      const matchSearch =
        p.title.toLowerCase().includes(q) ||
        (p.client?.company_name || '').toLowerCase().includes(q) ||
        `ecd-${String(p.proposal_number).padStart(4, '0')}`.includes(q);
      const matchStatus = statusFilter === '__all__' || displayStatus === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [proposals, search, statusFilter]);

  return (
    <div>
      <Modal
        open={Boolean(deletingProposal)}
        title="Delete proposal?"
        onClose={() => {
          if (deleting) return;
          setDeletingProposal(null);
        }}
        className="max-w-lg"
      >
        <div className="p-5">
          <p className="text-sm text-gray-700">
            {deletingProposal
              ? `Delete “${deletingProposal.title || 'this proposal'}”? This action cannot be undone.`
              : ''}
          </p>
          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={deleting}
              onClick={() => setDeletingProposal(null)}
              className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleting || !deletingProposal}
              onClick={async () => {
                if (!deletingProposal) return;
                try {
                  setDeleting(true);
                  await deleteProposal(deletingProposal.id);
                  onDeleted(deletingProposal.id);
                  setDeletingProposal(null);
                } catch (err: unknown) {
                  alert(err instanceof Error ? err.message : 'Failed to delete proposal');
                } finally {
                  setDeleting(false);
                }
              }}
              className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {deleting ? 'Deleting…' : 'Delete proposal'}
            </button>
          </div>
        </div>
      </Modal>

      {sendProposal && (
        <SendProposalModal
          open={Boolean(sendProposal)}
          proposal={sendProposal}
          client={sendProposal.client}
          onClose={() => setSendProposal(null)}
          onSent={async emailStatus => {
            toast(
              emailStatus === 'sent'
                ? 'Proposal emailed to the client'
                : 'Proposal is live. Email sending isn’t configured yet, so copy the link and send it yourself.',
            );
            try {
              const updated = await getProposal(sendProposal.id);
              if (updated) patch(updated);
            } catch {
              // best effort refresh
            }
          }}
        />
      )}

      <Modal
        open={Boolean(actionTarget)}
        title={actionTarget?.action === 'won' ? 'Mark proposal as won?' : 'Mark proposal as lost?'}
        onClose={() => {
          if (acting) return;
          setActionTarget(null);
          setActionError('');
        }}
        className="max-w-lg"
      >
        <div className="p-5">
          {actionTarget?.action === 'won' && (
            <p className="text-sm text-gray-700">
              {actionTarget.proposal.client_signed_at
                ? 'Mark this signed proposal as won.'
                : 'This marks the proposal won without a client signature.'}
            </p>
          )}
          {actionTarget?.action === 'lost' && (
            <div>
              <p className="text-sm text-gray-700">Optionally note why this proposal was lost:</p>
              <input
                type="text"
                value={lostReason}
                onChange={e => setLostReason(e.target.value)}
                placeholder="e.g. Went with another agency, budget cut…"
                className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
              />
            </div>
          )}
          {actionError && <p className="mt-3 text-sm text-red-600">{actionError}</p>}
          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={acting}
              onClick={() => { setActionTarget(null); setActionError(''); }}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={acting}
              onClick={runAction}
              className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
                actionTarget?.action === 'lost' ? 'bg-red-600 hover:bg-red-700' : 'gradient-bg hover:opacity-90'
              }`}
            >
              {acting ? 'Working…' : actionTarget?.action === 'won' ? 'Mark won' : 'Mark lost'}
            </button>
          </div>
        </div>
      </Modal>

      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search proposals..."
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
          />
        </div>
        <div className="relative">
          <Filter className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 z-10" />
          <div className="min-w-[160px]">
            <Select value={statusFilter} onValueChange={v => setStatusFilter(v)}>
              <SelectTrigger className="pl-9">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__"><SelectItemText>All</SelectItemText></SelectItem>
                {FILTERABLE_STATUSES.map(status => (
                  <SelectItem key={status} value={status}>
                    <SelectItemText>{PROPOSAL_STATUS_LABELS[status]}</SelectItemText>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={FileSignature}
          title={proposals.length === 0 ? 'No proposals yet' : 'No proposals found'}
          description={
            proposals.length === 0
              ? 'Create a proposal from an audit or start one from scratch.'
              : 'Try a different search or status filter.'
          }
          action={proposals.length === 0 ? emptyAction : undefined}
        />
      ) : (
        <div className="bg-white rounded-xl card-shadow overflow-x-auto">
          <table className="w-full min-w-[880px]">
            <thead>
              <tr className="bg-gray-50">
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide px-5 py-3">Proposal</th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide px-5 py-3">Client</th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide px-5 py-3">Value</th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide px-5 py-3">Status</th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide px-5 py-3">Expires</th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide px-5 py-3">Updated</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.map(proposal => {
                const displayStatus = deriveProposalStatus(proposal);
                return (
                  <tr
                    key={proposal.id}
                    {...rowNavProps(`/proposals/${proposal.id}`, navigate)}
                    className="hover:bg-gray-50/50 cursor-pointer transition-colors"
                  >
                    {/* w-full + max-w-0: this column takes whatever width is left and truncates, so the table never outgrows the card. */}
                    <td className="w-full max-w-0 px-5 py-4">
                      <p className="truncate text-sm font-medium text-gray-900" title={proposal.title || undefined}>
                        {proposal.title || 'Untitled proposal'}
                      </p>
                      <p className="text-[11px] text-gray-400 mt-0.5 tabular-nums">
                        ECD-{String(proposal.proposal_number).padStart(4, '0')}
                      </p>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <SiteFavicon url={proposal.client?.website_url} />
                        <span className="max-w-[12rem] truncate text-sm text-gray-600" title={proposal.client?.company_name || undefined}>
                          {proposal.client?.company_name || 'Unknown'}
                        </span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4">
                      {(() => {
                        const value = proposalValueSummary(proposal);
                        return (
                          <>
                            <p className="whitespace-nowrap text-sm font-semibold text-gray-900">{value.main}</p>
                            {value.sub && <p className="mt-0.5 whitespace-nowrap text-[11px] text-gray-500">{value.sub}</p>}
                          </>
                        );
                      })()}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4">
                      <StatusBadge status={displayStatus} />
                    </td>
                    <td className="whitespace-nowrap px-5 py-4">
                      <ProposalExpiryCell proposal={proposal} validDays={validDays} />
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-xs text-gray-400">
                      {new Date(proposal.updated_at).toLocaleDateString()}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4">
                      <div className="flex items-center justify-end">
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            if (menuAnchor?.proposal.id === proposal.id) {
                              setMenuAnchor(null);
                            } else {
                              const rect = e.currentTarget.getBoundingClientRect();
                              const anchor = {
                                proposal,
                                buttonTop: rect.top,
                                buttonBottom: rect.bottom,
                                right: window.innerWidth - rect.right,
                              };
                              setMenuAnchor(anchor);
                              setMenuPos({ top: anchor.buttonBottom + 4, right: anchor.right });
                            }
                          }}
                          className="p-1.5 rounded hover:bg-gray-100 transition-colors"
                          title="More actions"
                        >
                          <MoreVertical className="w-4 h-4 text-gray-400" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {menuAnchor && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuAnchor(null)} />
          <div
            ref={menuRef}
            style={{ top: menuPos?.top, bottom: menuPos?.bottom, right: menuPos?.right ?? menuAnchor.right }}
            className="fixed z-50 w-52 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
          >
            {!isClosedProposal(menuAnchor.proposal) && (
              <button
                type="button"
                onClick={() => { const p = menuAnchor.proposal; setMenuAnchor(null); setSendProposal(p); }}
                className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
              >
                <Send className="h-3.5 w-3.5 text-gray-400" />
                {menuAnchor.proposal.status === 'draft' ? 'Send to client' : 'Resend'}
              </button>
            )}
            <button
              type="button"
              disabled={linkBusyId === menuAnchor.proposal.id}
              // No confirmation: copying a link is not a commitment any more,
              // because the validity window only starts when the client opens it.
              onClick={() => {
                const p = menuAnchor.proposal;
                setMenuAnchor(null);
                copyLink(p);
              }}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <Link2 className="h-3.5 w-3.5 text-gray-400" />
              Copy client link
            </button>
            <button
              type="button"
              onClick={() => {
                const p = menuAnchor.proposal;
                setMenuAnchor(null);
                navigate(`/proposals/${p.id}?print=1`);
              }}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
            >
              <Printer className="h-3.5 w-3.5 text-gray-400" />
              Download PDF
            </button>
            {!isClosedProposal(menuAnchor.proposal) && (
              <>
                <div className="my-1 border-t border-gray-100" />
                <button
                  type="button"
                  onClick={() => { const p = menuAnchor.proposal; setMenuAnchor(null); setActionTarget({ proposal: p, action: 'won' }); }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm text-emerald-700 hover:bg-emerald-50"
                >
                  <Trophy className="h-3.5 w-3.5" />
                  Mark won
                </button>
                <button
                  type="button"
                  onClick={() => { const p = menuAnchor.proposal; setMenuAnchor(null); setActionTarget({ proposal: p, action: 'lost' }); }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Mark lost
                </button>
              </>
            )}
            {hasRole('admin') && (
              <>
                <div className="my-1 border-t border-gray-100" />
                <button
                  type="button"
                  onClick={() => { const p = menuAnchor.proposal; setMenuAnchor(null); setDeletingProposal(p); }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove proposal
                </button>
              </>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
