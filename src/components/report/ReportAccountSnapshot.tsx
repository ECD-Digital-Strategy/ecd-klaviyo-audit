import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Workflow,
  Zap,
  Smartphone,
  Megaphone,
  Users,
  UserCheck,
  UserX,
  Clock,
  MailX,
  ShieldAlert,
  TrendingUp,
  DollarSign,
  Store,
  PieChart,
  Send,
  Workflow as WorkflowIcon,
  Mail,
  MessageSquare,
} from 'lucide-react';
import type { FlowPerformance, KlaviyoCampaignSnapshot, KlaviyoFlowSnapshot } from '../../lib/types';
import { formatCurrency } from '../../lib/revenue-calculator';
import type { RevenueBreakdown } from '../../lib/revenue-breakdown';
import { formatRevenueBreakdownPct } from '../../lib/revenue-breakdown';
import {
  classifyDeliverabilityRate,
  classifyRate,
  formatDeliverabilityWarningRange,
  formatHealthyBenchmarkRange,
  formatHealthyBenchmarkUnder,
  formatPctDecimal,
} from '../../lib/benchmarks';
import { usePlatformSettings } from '../../contexts/PlatformSettingsContext';
import { BenchmarkMetricCard } from './BenchmarkMetricCard';

function normalizeReportingDiagnostic(raw?: string | null) {
  const msg = (raw ?? '').trim();
  if (!msg) return null;
  const lower = msg.toLowerCase();
  if (lower.includes('throttle') || lower.includes('"code":"throttled"') || lower.includes('status":429')) {
    const m = msg.match(/expected available in\s+(\d+)\s+seconds/i);
    const wait = m?.[1] ? ` (try again in ~${m[1]}s)` : '';
    return `Klaviyo rate-limited reporting requests${wait}. Re-run the audit shortly.`;
  }
  if (msg.length > 140) return `${msg.slice(0, 140)}…`;
  return msg;
}

function formatPct(n: number | null) {
  if (n == null || Number.isNaN(n)) return '—';
  return formatPctDecimal(n);
}

/** Spam/bounce rates can be tiny; show extra precision when above zero but under 0.01%. */
function formatRatePct(n: number | null) {
  if (n == null || Number.isNaN(n)) return '—';
  return formatPctDecimal(n, { extraPrecisionBelow: 0.01 });
}

function formatIntWithTruncFlag(n: number | null, truncated: boolean | null | undefined) {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  const s = new Intl.NumberFormat('en-US').format(Math.round(n));
  if (truncated) return `~${s}`;
  return s;
}

// Columns the snapshot rows can carry beyond the shared type.
type CampaignTimingFields = {
  fetched_at?: string | null;
  send_time?: string | null;
  _send_time?: string | null;
};

function toTime(value: string | null | undefined): number {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** Campaigns sent in the 30 days before the data was fetched (not before today,
 * so an old report keeps its numbers). Uses send_time when the row has it. */
function calcWeeklySendFrequency(campaigns: KlaviyoCampaignSnapshot[], computedAt?: string | null) {
  const rows = campaigns as (KlaviyoCampaignSnapshot & CampaignTimingFields)[];
  const fetchedAt = rows.reduce((max, c) => Math.max(max, toTime(c.fetched_at)), 0);
  const anchor = fetchedAt || toTime(computedAt) || Date.now();
  const days30 = 30 * 24 * 60 * 60 * 1000;
  const recentSent = rows.filter((c) => {
    const status = (c.status || '').toLowerCase();
    if (status !== 'sent') return false;
    const t = toTime(c.send_time ?? c._send_time) || toTime(c.updated_at_klaviyo);
    return t > 0 && t <= anchor && anchor - t <= days30;
  }).length;
  const perWeek = (recentSent / 30) * 7;
  return { recentSent, perWeek };
}

export const METRIC_ICON_CHIP_CLASS = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gray-100';
export const METRIC_ICON_CLASS = 'h-3.5 w-3.5 shrink-0 stroke-gray-500 text-gray-500';

function Card({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub: string;
  icon?: LucideIcon;
}) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white px-4 py-4 shadow-sm">
      <div className="mb-2 flex items-center gap-2">
        {Icon && (
          <div className={METRIC_ICON_CHIP_CLASS}>
            <Icon className={METRIC_ICON_CLASS} strokeWidth={2} />
          </div>
        )}
        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</p>
      </div>
      <p className="text-2xl font-bold tabular-nums tracking-tight text-gray-900">{value}</p>
      <p className="mt-1.5 text-xs leading-snug text-gray-500">{sub}</p>
    </div>
  );
}

function BenchmarkCallout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4 rounded-xl border border-gray-100 bg-[#f9f9f9] p-4">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500">{title}</p>
      <div className="text-sm leading-relaxed text-gray-700">{children}</div>
    </div>
  );
}

function RevenueSplitStat({
  label,
  amount,
  pctOfAttributed,
  icon: Icon,
}: {
  label: string;
  amount: number;
  pctOfAttributed: string;
  icon: LucideIcon;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 border-gray-100 px-4 first:pl-0 last:pr-0 sm:border-r sm:last:border-r-0">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0 text-gray-400" strokeWidth={2} />
        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</p>
      </div>
      <p className="text-lg font-bold tabular-nums tracking-tight text-gray-900">{formatCurrency(amount)}</p>
      <p className="text-xs tabular-nums text-gray-500">{pctOfAttributed} of attributed</p>
    </div>
  );
}

function RevenuePerformance({ breakdown }: { breakdown: RevenueBreakdown }) {
  const attributedPctOfTotal = formatRevenueBreakdownPct(
    breakdown.attributed_revenue,
    breakdown.total_store_revenue ?? 0,
  );
  const hasTotal = breakdown.total_store_revenue != null && Number.isFinite(breakdown.total_store_revenue);

  return (
    <div className="mb-6 overflow-hidden rounded-xl border border-gray-100 bg-[#f9f9f9]">
      <div className="border-b border-gray-100 px-5 py-3">
        <div className="flex items-center gap-2">
          <div className={METRIC_ICON_CHIP_CLASS}>
            <PieChart className={METRIC_ICON_CLASS} strokeWidth={2} />
          </div>
          <div>
            <p className="text-sm font-bold text-gray-900">Revenue Performance</p>
            <p className="text-xs text-gray-500">Last 30 days · Placed Order attribution</p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center gap-1.5">
            <Store className="h-3.5 w-3.5 text-gray-400" strokeWidth={2} />
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Total Store Revenue</p>
          </div>
          <p className="text-3xl font-bold tabular-nums tracking-tight text-gray-900">
            {hasTotal ? formatCurrency(breakdown.total_store_revenue!) : 'N/A'}
          </p>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-1.5">
            <DollarSign className="h-3.5 w-3.5 text-gray-400" strokeWidth={2} />
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
              Klaviyo-Attributed Revenue
            </p>
          </div>
          <p className="text-3xl font-bold tabular-nums tracking-tight text-gray-900">
            {formatCurrency(breakdown.attributed_revenue)}
          </p>
          {hasTotal && attributedPctOfTotal !== '—' && (
            <p className="mt-1 text-xs tabular-nums text-gray-500">
              ({attributedPctOfTotal} of total)
            </p>
          )}
        </div>
      </div>

      <div className="border-t border-gray-100 px-5 py-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-gray-500">Attributed revenue breakdown</p>
        <div className="flex flex-col gap-4 sm:flex-row sm:gap-0">
          <RevenueSplitStat
            label="Campaigns"
            amount={breakdown.campaign_revenue}
            pctOfAttributed={formatRevenueBreakdownPct(breakdown.campaign_revenue, breakdown.attributed_revenue)}
            icon={Send}
          />
          <RevenueSplitStat
            label="Flows"
            amount={breakdown.flow_revenue}
            pctOfAttributed={formatRevenueBreakdownPct(breakdown.flow_revenue, breakdown.attributed_revenue)}
            icon={WorkflowIcon}
          />
          <RevenueSplitStat
            label="Email"
            amount={breakdown.email_revenue}
            pctOfAttributed={formatRevenueBreakdownPct(breakdown.email_revenue, breakdown.attributed_revenue)}
            icon={Mail}
          />
          <RevenueSplitStat
            label="SMS"
            amount={breakdown.sms_revenue}
            pctOfAttributed={formatRevenueBreakdownPct(breakdown.sms_revenue, breakdown.attributed_revenue)}
            icon={MessageSquare}
          />
        </div>
      </div>
    </div>
  );
}

export default function ReportAccountSnapshot({
  flowSnapshots,
  flowPerformance,
  campaignSnapshots,
  reportingDiagnostic,
  accountSnapshot,
}: {
  flowSnapshots: KlaviyoFlowSnapshot[];
  flowPerformance: FlowPerformance[];
  campaignSnapshots: KlaviyoCampaignSnapshot[];
  reportingDiagnostic?: string | null;
  accountSnapshot?: {
    total_profiles_count?: number | null;
    email_subscribed_profiles_count: number | null;
    active_profiles_90d_count: number | null;
    suppressed_profiles_count: number | null;
    bounce_rate_90d: number | null;
    spam_rate_90d: number | null;
    sms_subscribed_profiles_count?: number | null;
    campaign_revenue_per_recipient_30d?: number | null;
    active_profiles_definition?: string | null;
    computed_at?: string | null;
    email_subscribed_profiles_truncated?: boolean | null;
    active_profiles_90d_truncated?: boolean | null;
    suppressed_profiles_truncated?: boolean | null;
    campaigns_truncated?: boolean | null;
    deliverability_campaign_timeframe?: 'last_30_days' | 'last_90_days' | null;
    /** 'partial': the scan hit an upstream block it could not get past, so the
     * counts are real but are lower bounds rather than account totals. */
    profile_scan_status?: 'pending' | 'complete' | 'partial' | 'failed' | 'skipped' | null;
    revenue_breakdown?: RevenueBreakdown | null;
  } | null;
}) {
  const { benchmarks } = usePlatformSettings();
  const totalFlows = flowSnapshots.length;
  const liveFlows = flowSnapshots.filter((f) => f.status?.toLowerCase() === 'live' || f.status?.toLowerCase() === 'manual').length;
  const campaignRevenuePerRecipient = accountSnapshot?.campaign_revenue_per_recipient_30d ?? null;
  const hasCampaignRpr = campaignRevenuePerRecipient != null && Number.isFinite(campaignRevenuePerRecipient);

  const hasPerf = flowPerformance.length > 0;
  const totalRecipients = hasPerf ? flowPerformance.reduce((s, f) => s + (f.recipients_per_month ?? 0), 0) : null;
  const weightedConv = hasPerf && totalRecipients && totalRecipients > 0
    ? flowPerformance.reduce((s, f) => s + (f.actual_conv_rate ?? 0) * (f.recipients_per_month ?? 0), 0) / totalRecipients
    : null;
  const revenuePerRecipient = hasPerf && totalRecipients && totalRecipients > 0
    ? (flowPerformance.reduce((s, f) => s + (f.monthly_revenue_current ?? 0), 0) / totalRecipients)
    : null;

  const perfUnavailableReason = normalizeReportingDiagnostic(reportingDiagnostic) || 'not enough reporting data available';
  const { recentSent, perWeek } = calcWeeklySendFrequency(campaignSnapshots, accountSnapshot?.computed_at);
  const deliverabilityWindow = accountSnapshot?.deliverability_campaign_timeframe === 'last_30_days' ? 'last 30 days' : 'last 90 days';
  const deliverabilityContext = `${deliverabilityWindow} · email campaigns (weighted by recipients)`;

  const bounceStatus = classifyDeliverabilityRate(
    accountSnapshot?.bounce_rate_90d ?? null,
    benchmarks.bounceHealthyMax,
    benchmarks.bounceWarningMax,
  );
  const spamStatus = classifyDeliverabilityRate(
    accountSnapshot?.spam_rate_90d ?? null,
    benchmarks.spamHealthyMax,
    benchmarks.spamWarningMax,
  );
  const convStatus = classifyRate(
    weightedConv,
    benchmarks.accountConvLow,
    benchmarks.accountConvHigh,
  );

  return (
    <div>
      {accountSnapshot?.revenue_breakdown && (
        <RevenuePerformance breakdown={accountSnapshot.revenue_breakdown} />
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Card icon={Workflow} label="Total Flows" value={String(totalFlows)} sub="in Klaviyo account" />
        <Card icon={Zap} label="Live Flows" value={String(liveFlows)} sub="actively sending" />
        <Card
          icon={Users}
          label="List Size"
          value={formatIntWithTruncFlag(
            accountSnapshot?.total_profiles_count ?? accountSnapshot?.email_subscribed_profiles_count ?? null,
            accountSnapshot?.email_subscribed_profiles_truncated,
          )}
          sub={
            accountSnapshot?.profile_scan_status === 'skipped'
              ? 'fast audit — full profile scan not run'
              : accountSnapshot?.profile_scan_status === 'pending' && accountSnapshot?.total_profiles_count == null && accountSnapshot?.email_subscribed_profiles_count == null
                ? 'full profile scan in progress'
                : (accountSnapshot?.total_profiles_count ?? accountSnapshot?.email_subscribed_profiles_count) == null
                  ? 'requires profiles:read scope'
                  : 'all profiles in Klaviyo account'
          }
        />
        <Card
          icon={Smartphone}
          label="Total SMS Profiles"
          value={formatIntWithTruncFlag(
            accountSnapshot?.sms_subscribed_profiles_count ?? null,
            accountSnapshot?.email_subscribed_profiles_truncated,
          )}
          sub={
            accountSnapshot?.profile_scan_status === 'skipped'
              ? 'fast audit — full profile scan not run'
              : accountSnapshot?.profile_scan_status === 'pending' && accountSnapshot?.sms_subscribed_profiles_count == null
                ? 'full profile scan in progress'
                : accountSnapshot?.sms_subscribed_profiles_count == null
                  ? 'requires full profile scan'
                  : 'SMS marketing subscribed'
          }
        />
        <Card
          icon={UserCheck}
          label="Active Profiles"
          value={formatIntWithTruncFlag(
            accountSnapshot?.email_subscribed_profiles_count ?? null,
            accountSnapshot?.email_subscribed_profiles_truncated,
          )}
          sub={
            accountSnapshot?.profile_scan_status === 'skipped'
              ? 'fast audit — full profile scan not run'
              : accountSnapshot?.profile_scan_status === 'pending' && accountSnapshot?.email_subscribed_profiles_count == null
                ? 'full profile scan in progress'
                : accountSnapshot?.email_subscribed_profiles_count == null
                  ? 'requires profiles:read scope'
                  : 'email-subscribed profiles'
          }
        />
        <Card
          icon={UserX}
          label="Suppressions"
          value={formatIntWithTruncFlag(
            accountSnapshot?.suppressed_profiles_count ?? null,
            accountSnapshot?.suppressed_profiles_truncated,
          )}
          sub={
            accountSnapshot?.profile_scan_status === 'skipped'
              ? 'fast audit — full profile scan not run'
              : accountSnapshot?.profile_scan_status === 'pending' && accountSnapshot?.suppressed_profiles_count == null
                ? 'full profile scan in progress'
                : accountSnapshot?.suppressed_profiles_count == null
                  ? 'requires profiles:read scope'
                  : 'email marketing suppression on profile'
          }
        />

        <Card
          icon={DollarSign}
          label="Revenue / Recipient"
          value={hasPerf && revenuePerRecipient != null ? `$${revenuePerRecipient.toFixed(2)}` : 'N/A'}
          sub={hasPerf ? 'across all flows' : perfUnavailableReason}
        />
        <Card
          icon={Megaphone}
          label="Campaign Rev / Recipient"
          value={hasCampaignRpr ? `$${campaignRevenuePerRecipient!.toFixed(2)}` : 'N/A'}
          sub={hasCampaignRpr ? 'last 30 days · email campaigns' : perfUnavailableReason}
        />

        {accountSnapshot?.bounce_rate_90d != null ? (
          <BenchmarkMetricCard
            icon={MailX}
            label="Bounce Rate"
            value={formatRatePct(accountSnapshot.bounce_rate_90d)}
            contextLine={deliverabilityContext}
            benchmarkLine={formatHealthyBenchmarkUnder(benchmarks.bounceHealthyMax)}
            status={bounceStatus}
            direction="lower"
          />
        ) : (
          <Card icon={MailX} label="Bounce Rate" value="N/A" sub="not enough campaign data available" />
        )}

        {accountSnapshot?.spam_rate_90d != null ? (
          <BenchmarkMetricCard
            icon={ShieldAlert}
            label="Spam Rate"
            value={formatRatePct(accountSnapshot.spam_rate_90d)}
            contextLine={deliverabilityContext}
            benchmarkLine={formatHealthyBenchmarkUnder(benchmarks.spamHealthyMax)}
            status={spamStatus}
            direction="lower"
          />
        ) : (
          <Card icon={ShieldAlert} label="Spam Rate" value="N/A" sub="not enough campaign data available" />
        )}

        {hasPerf && weightedConv != null ? (
          <BenchmarkMetricCard
            icon={TrendingUp}
            label="Flow Conv. Rate"
            value={formatPct(weightedConv)}
            contextLine="Weighted average across all flows"
            benchmarkLine={formatHealthyBenchmarkRange(benchmarks.accountConvLow, benchmarks.accountConvHigh)}
            status={convStatus}
            direction="higher"
          />
        ) : (
          <Card icon={TrendingUp} label="Flow Conv. Rate" value="N/A" sub={perfUnavailableReason} />
        )}

        <Card
          icon={Clock}
          label="Send Frequency"
          value={recentSent > 0 ? `${perWeek.toFixed(perWeek < 1 ? 1 : 0)}/wk` : '—'}
          sub={recentSent > 0 ? `${recentSent} campaigns sent (last 30 days)` : 'based on recent sent campaigns'}
        />
      </div>

      <BenchmarkCallout title="Benchmark: Healthy account hygiene">
        A healthy account typically has bounce rate {formatHealthyBenchmarkUnder(benchmarks.bounceHealthyMax)} (
        {formatDeliverabilityWarningRange(benchmarks.bounceHealthyMax, benchmarks.bounceWarningMax)}),
        spam/complaint rate {formatHealthyBenchmarkUnder(benchmarks.spamHealthyMax)} (
        {formatDeliverabilityWarningRange(benchmarks.spamHealthyMax, benchmarks.spamWarningMax)}),
        weighted flow conversion {formatHealthyBenchmarkRange(benchmarks.accountConvLow, benchmarks.accountConvHigh)},
        consistent sending cadence, a clear suppression strategy,
        and a clean engaged/unengaged segmentation framework.
      </BenchmarkCallout>
    </div>
  );
}
