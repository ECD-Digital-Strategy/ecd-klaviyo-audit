import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ClipboardCheck,
  TrendingUp,
  FileText,
  FileSignature,
  Plus,
  UserPlus,
  ArrowRight,
  Clock,
} from 'lucide-react';
import TopBar from '../components/layout/TopBar';
import KPICard from '../components/ui/KPICard';
import StatusBadge from '../components/ui/StatusBadge';
import { SkeletonKPICards, SkeletonListCard } from '../components/ui/Skeleton';
import SiteFavicon from '../components/ui/SiteFavicon';
import { formatCurrency } from '../lib/revenue-calculator';
import { listAudits, listClients } from '../lib/db';
import { listProposals } from '../lib/proposals-db';
import { deriveProposalStatus, isProposalOpen } from '../lib/proposal-status';
import { computeProposalTotals, proposalDiscountFromRow, proposalPipelineValue } from '../lib/proposal-pricing';
import { canAccessArea } from '../lib/access';
import { useAuth } from '../contexts/AuthContext';
import AuditStatusBadge from '../components/ui/AuditStatusBadge';
import type { Audit, Client, Proposal } from '../lib/types';

function proposalValue(proposal: Proposal): number {
  const totals = computeProposalTotals(proposal.line_items ?? [], proposalDiscountFromRow(proposal));
  return proposalPipelineValue(totals);
}

export default function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  // The dashboard shows only the areas this user can open: no audit KPIs for
  // someone without Audits, no pipeline card or Create Proposal for someone
  // without Proposals. Clients is always there, it is the one area everyone has.
  const showAudits = canAccessArea(user, 'audits');
  const showProposals = canAccessArea(user, 'proposals');

  const [clients, setClients] = useState<Client[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Blocked areas are not fetched at all rather than fetched and hidden.
        const [c, a, p] = await Promise.all([
          listClients(),
          showAudits ? listAudits() : Promise.resolve([] as Audit[]),
          showProposals ? listProposals() : Promise.resolve([] as Proposal[]),
        ]);
        if (cancelled) return;
        setClients(c);
        setAudits(a);
        setProposals(p);
      } catch {
        // dashboard should still render even if lists fail
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAudits, showProposals]);

  const clientById = useMemo(() => new Map(clients.map(c => [c.id, c])), [clients]);

  const totalAudits = audits.length;
  const inReview = audits.filter(a => a.status === 'in_review').length;
  const published = audits.filter(a => a.status === 'published').length;
  const totalRevOpp = audits.reduce((s, a) => s + a.total_revenue_opportunity, 0);
  const openPipelineValue = proposals.filter(isProposalOpen).reduce((sum, p) => sum + proposalValue(p), 0);

  return (
    <div>
      <TopBar title="Dashboard" subtitle="Welcome back" />

      <div className="p-4 md:p-8 space-y-8 animate-fade-in">
        {loading ? (
          <SkeletonKPICards />
        ) : (showAudits || showProposals) && (
          <div
            className={`grid grid-cols-1 sm:grid-cols-2 gap-4 ${
              showAudits && showProposals ? 'lg:grid-cols-5' : showAudits ? 'lg:grid-cols-4' : 'lg:grid-cols-1 sm:grid-cols-1 max-w-sm'
            }`}
          >
            {showAudits && (
              <>
                <KPICard icon={ClipboardCheck} label="Total Audits" value={totalAudits} accent="primary" />
                <KPICard icon={Clock} label="Audits in Review" value={inReview} accent="warning" />
                <KPICard icon={FileText} label="Audits Published" value={published} accent="success" />
                <KPICard icon={TrendingUp} label="Revenue Identified" value={formatCurrency(totalRevOpp)} accent="secondary" />
              </>
            )}
            {showProposals && (
              <KPICard
                icon={FileSignature}
                label="Open Proposal Pipeline"
                value={formatCurrency(openPipelineValue)}
                accent="primary"
              />
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          {showAudits && (
            <button
              onClick={() => navigate('/audits/new', { state: { backgroundLocation: location } })}
              className="flex items-center gap-2 px-5 py-2.5 bg-brand-primary text-white text-sm font-medium rounded-lg hover:bg-brand-primary-dark transition-colors"
            >
              <Plus className="w-4 h-4" />
              Start New Audit
            </button>
          )}
          <button
            onClick={() => navigate('/clients/new', { state: { backgroundLocation: location } })}
            className="flex items-center gap-2 px-5 py-2.5 bg-white border border-gray-200 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <UserPlus className="w-4 h-4" />
            Add Client
          </button>
          {showProposals && (
            <button
              onClick={() => navigate('/proposals/new', { state: { backgroundLocation: location } })}
              className="flex items-center gap-2 px-5 py-2.5 bg-white border border-gray-200 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <FileSignature className="w-4 h-4" />
              Create Proposal
            </button>
          )}
        </div>

        {loading ? (
          <div className="space-y-6">
            <SkeletonListCard />
            <SkeletonListCard rows={4} />
          </div>
        ) : (
        <div className="grid grid-cols-1 gap-6">
          <div className="space-y-6">
            {showAudits && (
            <div className="bg-white rounded-xl card-shadow">
              <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">Recent Audits</h2>
                <button
                  onClick={() => navigate('/audits')}
                  className="text-xs text-brand-primary font-medium hover:underline flex items-center gap-1"
                >
                  View All <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              <div className="divide-y divide-gray-50">
                {audits.slice(0, 5).map(audit => {
                  const client = clientById.get(audit.client_id);
                  return (
                    <button
                      key={audit.id}
                      onClick={() => navigate(`/audits/${audit.id}`)}
                      className="w-full flex items-center justify-between px-4 md:px-6 py-4 hover:bg-gray-50/50 transition-colors text-left"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <SiteFavicon url={client?.website_url} size="md" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{audit.title}</p>
                          <p className="text-xs text-gray-500 mt-0.5">{client?.company_name || 'Unknown'}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 shrink-0 ml-4">
                        {/* Web audits carry no revenue estimate, so this was always $0. */}
                        {audit.audit_type !== 'web' && (
                          <span className="text-sm font-semibold text-emerald-700">
                            {formatCurrency(audit.total_revenue_opportunity)}
                          </span>
                        )}
                        <div className="flex items-center gap-2">
                          <StatusBadge status={audit.status} />
                          <AuditStatusBadge audit={audit} />
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
            )}

            <div className="bg-white rounded-xl card-shadow">
              <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">Recent Clients</h2>
                <button
                  onClick={() => navigate('/clients')}
                  className="text-xs text-brand-primary font-medium hover:underline flex items-center gap-1"
                >
                  View All <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              <div className="divide-y divide-gray-50">
                {clients.slice(0, 5).map(client => {
                  const clientAudits = audits.filter(a => a.client_id === client.id);
                  return (
                    <button
                      key={client.id}
                      onClick={() => navigate(`/clients/${client.id}`)}
                      className="w-full flex items-center justify-between px-4 md:px-6 py-4 hover:bg-gray-50/50 transition-colors text-left"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <SiteFavicon url={client.website_url} size="md" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{client.company_name}</p>
                          <p className="text-xs text-gray-500">{client.website_url || '—'}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 ml-4">
                        <span className="text-xs text-gray-400">{clientAudits.length} audit{clientAudits.length !== 1 ? 's' : ''}</span>
                        <ArrowRight className="w-3.5 h-3.5 text-gray-300" />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {showProposals && (
              <div className="bg-white rounded-xl card-shadow">
                <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-gray-900">Recent Proposals</h2>
                  <button
                    onClick={() => navigate('/proposals')}
                    className="text-xs text-brand-primary font-medium hover:underline flex items-center gap-1"
                  >
                    View All <ArrowRight className="w-3 h-3" />
                  </button>
                </div>
                <div className="divide-y divide-gray-50">
                  {[...proposals]
                    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
                    .slice(0, 5)
                    .map(proposal => (
                    <button
                      key={proposal.id}
                      onClick={() => navigate(`/proposals/${proposal.id}`)}
                      className="w-full flex items-center justify-between px-4 md:px-6 py-4 hover:bg-gray-50/50 transition-colors text-left"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <SiteFavicon url={proposal.client?.website_url} size="md" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {proposal.title || 'Untitled proposal'}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {proposal.client?.company_name || 'Unknown'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 shrink-0 ml-4">
                        <span className="text-sm font-semibold text-gray-900">
                          {formatCurrency(proposalValue(proposal))}
                        </span>
                        <StatusBadge status={deriveProposalStatus(proposal)} />
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
