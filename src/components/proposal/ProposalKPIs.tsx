import { useState } from 'react';
import { Eye, Hourglass, Trophy, XCircle, Percent } from 'lucide-react';
import KPICard from '../ui/KPICard';
import MonthlyBarChart from '../ui/MonthlyBarChart';
import { deriveProposalStatus, isProposalOpen } from '../../lib/proposal-status';
import { inYear, monthsForYear, type ProposalYear } from '../../lib/proposal-year';
import { proposalValue } from '../../lib/proposal-pricing';
import { formatCurrency } from '../../lib/revenue-calculator';
import type { Proposal } from '../../lib/types';

function monthOf(iso: string | null): string | null {
  return iso ? iso.slice(0, 7) : null;
}

export default function ProposalKPIs({ proposals, year }: { proposals: Proposal[]; year: ProposalYear }) {
  const [chartMode, setChartMode] = useState<'count' | 'value'>('count');
  const statuses = proposals.map(p => deriveProposalStatus(p));

  // Each bucket asks about its OWN date, so a deal signed in January counts as
  // a win this year even though it was written last December. An open proposal
  // has no closing date yet, so it answers for when it was created.
  const isOpenIn = (p: Proposal) => isProposalOpen(p) && inYear(p.created_at, year);
  const isWonIn = (_p: Proposal, i: number) => statuses[i] === 'won' && inYear(proposals[i].won_at, year);
  // Expired proposals are auto-marked lost by an hourly job; the derived
  // 'expired' state only exists in the gap before it runs, so it counts as
  // lost here rather than silently dropping out of every bucket. One that has
  // not been stamped lost_at yet answers for when it was created, which is the
  // only date it has.
  const isLostIn = (_p: Proposal, i: number) => {
    const st = statuses[i];
    if (st !== 'lost' && st !== 'expired') return false;
    const p = proposals[i];
    return inYear(p.lost_at ?? p.created_at, year);
  };

  const sumValue = (keep: (p: Proposal, i: number) => boolean) =>
    proposals.reduce((sum, p, i) => (keep(p, i) ? sum + proposalValue(p) : sum), 0);
  const countWhere = (keep: (p: Proposal, i: number) => boolean) =>
    proposals.reduce((n, p, i) => (keep(p, i) ? n + 1 : n), 0);

  const wonCount = countWhere(isWonIn);
  const lostCount = countWhere(isLostIn);
  const decided = wonCount + lostCount;
  const winRate = decided > 0 ? Math.round((wonCount / decided) * 100) : null;

  const openCount = countWhere(p => isOpenIn(p));
  const openValue = sumValue(p => isOpenIn(p));
  // The subset of the open pipeline the client has actually looked at: the
  // deals to chase, as opposed to ones still sitting unread in an inbox.
  const awaitingCount = countWhere(p => isOpenIn(p) && Boolean(p.first_viewed_at));
  const awaitingValue = sumValue(p => isOpenIn(p) && Boolean(p.first_viewed_at));
  const wonValue = sumValue(isWonIn);
  const lostValue = sumValue(isLostIn);
  const avgWonValue = wonCount > 0 ? wonValue / wonCount : null;
  const windowLabel = year === 'all' ? 'All time' : String(year);

  const months = monthsForYear(year, proposals);
  const chartData = months.map(month => {
    const sentProposals = proposals.filter(p => monthOf(p.sent_at) === month);
    const wonProposals = proposals.filter(p => p.status === 'won' && monthOf(p.won_at) === month);
    return {
      month,
      series: {
        sent: chartMode === 'value'
          ? sentProposals.reduce((sum, p) => sum + proposalValue(p), 0)
          : sentProposals.length,
        won: chartMode === 'value'
          ? wonProposals.reduce((sum, p) => sum + proposalValue(p), 0)
          : wonProposals.length,
      },
    };
  });

  return (
    <div className="mb-6 space-y-4">
      {/* Money first: the headline on every card is dollars (or a rate), with
          the count as context underneath. Counts alone hid the thing that
          matters about a pipeline, which is what it is worth. */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <KPICard
          label="Open pipeline"
          value={formatCurrency(openValue)}
          sub={`${openCount} open proposal${openCount === 1 ? '' : 's'}`}
          icon={Hourglass}
          accent="primary"
        />
        <KPICard
          label="Awaiting decision"
          value={formatCurrency(awaitingValue)}
          sub={`${awaitingCount} viewed, not signed`}
          icon={Eye}
          accent="warning"
        />
        <KPICard
          label="Won"
          value={formatCurrency(wonValue)}
          // Average deal size rides along here rather than taking a sixth card:
          // it only means anything next to the total it is an average of.
          sub={
            avgWonValue === null
              ? 'no wins yet'
              : `${wonCount} proposal${wonCount === 1 ? '' : 's'} · ${formatCurrency(avgWonValue)} avg`
          }
          icon={Trophy}
          accent="success"
        />
        <KPICard
          label="Lost"
          value={formatCurrency(lostValue)}
          sub={`${lostCount} incl. expired`}
          icon={XCircle}
          accent="warning"
        />
        <KPICard
          label="Win rate"
          value={winRate === null ? '—' : `${winRate}%`}
          sub={decided > 0 ? `won ${wonCount} of ${decided} decided` : 'no decisions yet'}
          icon={Percent}
          accent="secondary"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl bg-white p-5 card-shadow lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-gray-900">Sent vs won</h3>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">{windowLabel}</span>
              <div className="flex rounded-lg bg-gray-100 p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setChartMode('count')}
                  className={`rounded-md px-2.5 py-1 transition ${
                    chartMode === 'count' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                  }`}
                >
                  Count
                </button>
                <button
                  type="button"
                  onClick={() => setChartMode('value')}
                  className={`rounded-md px-2.5 py-1 transition ${
                    chartMode === 'value' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                  }`}
                >
                  Value ($)
                </button>
              </div>
            </div>
          </div>
          <MonthlyBarChart
            data={chartData}
            series={[
              { key: 'sent', label: 'Sent', color: '#c7c2ff' },
              { key: 'won', label: 'Won', color: '#4b3afe' },
            ]}
            formatValue={chartMode === 'value' ? formatCurrency : undefined}
          />
        </div>
        <div className="rounded-xl bg-white p-5 card-shadow">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">Pipeline by status</h3>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
              {windowLabel}
            </span>
          </div>
          <div className="mt-4 space-y-3">
            <PipelineRow label="Open" dotColor="bg-blue-400" value={openValue} />
            <PipelineRow label="Won" dotColor="bg-emerald-500" value={wonValue} />
            <PipelineRow label="Lost" dotColor="bg-red-400" value={lostValue} />
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3">
            <span className="text-xs font-semibold text-gray-500">Total</span>
            <span className="text-sm font-bold tabular-nums text-gray-900">
              {formatCurrency(openValue + wonValue + lostValue)}
            </span>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-gray-400">
            One-time totals plus 12 months of retainers.{' '}
            {year === 'all'
              ? 'Every proposal, whenever it was created.'
              : `Won and lost by the year they closed; open by the year they were created.`}
          </p>
        </div>
      </div>
    </div>
  );
}

function PipelineRow({ label, value, dotColor }: { label: string; value: number; dotColor: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-sm text-gray-600">
        <span className={`h-2 w-2 rounded-full ${dotColor}`} />
        {label}
      </span>
      <span className="text-sm font-semibold tabular-nums text-gray-900">{formatCurrency(value)}</span>
    </div>
  );
}
